use std::path::Path;

/// 单个归档条目解压硬上限：20 MB，防 Zip Bomb 与 OOM
pub const MAX_ARCHIVE_ENTRY_SIZE: u64 = 20 * 1024 * 1024;
/// 单个压缩文件累计解压硬上限：100 MB
pub const MAX_ARCHIVE_TOTAL_SIZE: u64 = 100 * 1024 * 1024;

/// 使用魔数检测归档类型
/// 
/// 通过读取文件的魔数（文件头的特定字节序列）来识别归档文件的类型
/// 支持检测 ZIP、GZ 和 TAR 格式
pub fn detect_archive_type(file_path: &Path) -> Option<&'static str> {
    use std::fs::File;
    use std::io::Read;

    let mut file = File::open(file_path).ok()?;
    let mut buffer = [0; 16];
    let bytes_read = file.read(&mut buffer).ok()?;
    if bytes_read < 2 {
        return None;
    }

    // ZIP魔数: 50 4B
    if buffer[0] == 0x50 && buffer[1] == 0x4B {
        return Some("zip");
    }

    // GZ魔数: 1F 8B
    if buffer[0] == 0x1F && buffer[1] == 0x8B {
        return Some("gz");
    }

    // 7z魔数: 37 7A BC AF 27 1C
    if bytes_read >= 6
        && buffer[0] == 0x37
        && buffer[1] == 0x7A
        && buffer[2] == 0xBC
        && buffer[3] == 0xAF
        && buffer[4] == 0x27
        && buffer[5] == 0x1C
    {
        return Some("7z");
    }

    // TAR魔数: 75 73 74 61 72 位于偏移量0x101处
    let mut extended_buffer = [0; 262]; // 0x101 + 5
    use std::io::Seek;
    if file.seek(std::io::SeekFrom::Start(0)).is_ok()
        && file.read_exact(&mut extended_buffer).is_ok()
    {
        let tar_magic = &extended_buffer[0x101..0x101 + 5];
        if tar_magic == b"ustar" {
            return Some("tar");
        }
    }

    None
}

/// 从 7z 文件中提取文本文件内容（带解压大小限制与防炸弹机制）
pub fn extract_7z_content(
    file_path: &Path,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    use std::io::Read;

    let mut sz = sevenz_rust::SevenZReader::open(file_path, sevenz_rust::Password::empty())?;
    let mut results = Vec::new();
    let mut total_extracted: u64 = 0;

    sz.for_each_entries(|entry, reader| {
        if total_extracted >= MAX_ARCHIVE_TOTAL_SIZE {
            eprintln!(
                "7z 压缩包 {} 解压总量已达上限 {} 字节，停止解压后续条目",
                file_path.display(),
                MAX_ARCHIVE_TOTAL_SIZE
            );
            return Ok(false);
        }

        if !entry.is_directory() && is_text_file(&entry.name().to_lowercase()) {
            if entry.size() > MAX_ARCHIVE_ENTRY_SIZE {
                eprintln!(
                    "7z 条目 {} 大小超过单文件解压上限，已跳过",
                    entry.name()
                );
                return Ok(true);
            }

            let mut buffer = Vec::new();
            let mut limited = reader.take(MAX_ARCHIVE_ENTRY_SIZE);
            let read_bytes = limited.read_to_end(&mut buffer).map_err(sevenz_rust::Error::io)? as u64;
            total_extracted += read_bytes;

            let content = String::from_utf8_lossy(&buffer).to_string();
            results.push((entry.name().to_string(), content));
        }

        Ok(true)
    })?;

    Ok(results)
}

/// 从 ZIP 文件中提取文本文件内容（带解压大小限制与防炸弹机制）
pub fn extract_zip_content(
    file_path: &Path,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    use std::io::Read;
    use zip::read::ZipArchive;

    let file = std::fs::File::open(file_path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut results = Vec::new();
    let mut total_extracted: u64 = 0;

    for i in 0..archive.len() {
        if total_extracted >= MAX_ARCHIVE_TOTAL_SIZE {
            eprintln!("压缩包 {} 解压总量已达上限 {} 字节，停止解压后续条目", file_path.display(), MAX_ARCHIVE_TOTAL_SIZE);
            break;
        }

        let mut entry = archive.by_index(i)?;
        if entry.is_file() && is_text_file(&entry.name().to_lowercase()) {
            // 防 zip bomb：若条目声明的大小超过上限，跳过
            if entry.size() > MAX_ARCHIVE_ENTRY_SIZE {
                eprintln!("条目 {} 大小超过单文件解压上限，已跳过", entry.name());
                continue;
            }

            let mut buffer = Vec::new();
            let mut limited = (&mut entry).take(MAX_ARCHIVE_ENTRY_SIZE);
            let read_bytes = limited.read_to_end(&mut buffer)? as u64;
            total_extracted += read_bytes;

            let content = String::from_utf8_lossy(&buffer).to_string();
            results.push((entry.name().to_string(), content));
        }
    }

    Ok(results)
}

/// 从 TAR 文件中提取文本文件内容（带解压大小限制）
pub fn extract_tar_content(
    file_path: &Path,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    use std::io::Read;
    use tar::Archive;

    let file = std::fs::File::open(file_path)?;
    let mut archive = Archive::new(file);
    let mut results = Vec::new();
    let mut total_extracted: u64 = 0;

    for entry in archive.entries()? {
        if total_extracted >= MAX_ARCHIVE_TOTAL_SIZE {
            eprintln!("TAR 归档 {} 解压总量已达上限，停止解压后续条目", file_path.display());
            break;
        }

        let mut entry = entry?;
        if entry.header().entry_type().is_file() {
            let size = entry.header().size()?;
            if size > MAX_ARCHIVE_ENTRY_SIZE {
                eprintln!("TAR 条目大小超过上限，已跳过");
                continue;
            }

            let path = entry.path()?.to_string_lossy().to_string();
            if is_text_file(&path.to_lowercase()) {
                let mut buffer = Vec::new();
                let mut limited = (&mut entry).take(MAX_ARCHIVE_ENTRY_SIZE);
                let read_bytes = limited.read_to_end(&mut buffer)? as u64;
                total_extracted += read_bytes;

                let content = String::from_utf8_lossy(&buffer).to_string();
                results.push((path, content));
            }
        }
    }

    Ok(results)
}

/// 从 GZ 文件中提取内容（带解压大小限制）
pub fn extract_gz_content(
    file_path: &Path,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    use flate2::read::GzDecoder;
    use std::io::Read;

    let file = std::fs::File::open(file_path)?;
    let decoder = GzDecoder::new(file);
    let mut limited = decoder.take(MAX_ARCHIVE_ENTRY_SIZE);
    let mut buffer = Vec::new();
    limited.read_to_end(&mut buffer)?;
    let content = String::from_utf8_lossy(&buffer).to_string();

    let file_name = file_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "uncompressed".to_string());

    Ok(vec![(file_name, content)])
}

/// 检查文件扩展名是否为常见文本格式
pub fn is_text_file(file_name: &str) -> bool {
    let text_extensions = [
        ".log", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".tsv", ".sql", ".html", ".htm",
        ".js", ".ts", ".css", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
    ];
    
    if is_useless_file_by_name(file_name) {
        return false;
    }
    
    text_extensions.iter().any(|ext| file_name.ends_with(ext))
}

/// 检查文件名是否对应应当跳过的无用二进制格式
pub fn is_useless_file_by_name(file_name: &str) -> bool {
    let extensions = [
        "swp", "swo", "swn", "swm", "swl", "swx",
        "dmp", "dump",
        "exe", "msi", "dll", "so", "dylib", "app", "bin", "out",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
        "db", "sqlite", "sqlite3", "mdb", "accdb", "db3", "mdf", "ldf",
        "jpg", "jpeg", "png", "gif", "bmp", "tiff", "tif", "webp", "svg", "ico", "psd", "ai", "eps",
        "mp3", "wav", "flac", "aac", "ogg", "wma", "mp4", "avi", "mov", "wmv", "mkv", "flv", "webm",
        "tmp", "temp", "bak", "backup", "old", "orig", "save", "autosave",
        "o", "obj", "lib", "a", "class", "pyc", "pyo",
        "sys", "drv", "inf",
        "iso", "img", "vmdk", "vdi", "vhd", "vhdx", "ova", "ovf", "qcow", "qcow2", "raw",
        "dat", "hex", "elf",
    ];

    for ext in extensions.iter() {
        if file_name.to_lowercase().ends_with(&format!(".{}", ext)) {
            return true;
        }
    }
    
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_is_text_file() {
        assert!(is_text_file("server.log"));
        assert!(is_text_file("app.json"));
        assert!(!is_text_file("image.png"));
        assert!(!is_text_file("binary.exe"));
    }

    #[test]
    fn test_detect_archive_type_zip() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_detect.zip");
        let mut f = std::fs::File::create(&test_file).unwrap();
        // PK magic header
        f.write_all(&[0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]).unwrap();
        drop(f);

        assert_eq!(detect_archive_type(&test_file), Some("zip"));
        let _ = std::fs::remove_file(test_file);
    }

    #[test]
    fn test_detect_archive_type_gz() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_detect.gz");
        let mut f = std::fs::File::create(&test_file).unwrap();
        // GZ magic header
        f.write_all(&[0x1F, 0x8B, 0x08, 0x00]).unwrap();
        drop(f);

        assert_eq!(detect_archive_type(&test_file), Some("gz"));
        let _ = std::fs::remove_file(test_file);
    }

    #[test]
    fn test_detect_archive_type_7z() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_detect.7z");
        let mut f = std::fs::File::create(&test_file).unwrap();
        // 7z magic header: 37 7A BC AF 27 1C
        f.write_all(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C, 0x00, 0x04]).unwrap();
        drop(f);

        assert_eq!(detect_archive_type(&test_file), Some("7z"));
        let _ = std::fs::remove_file(test_file);
    }

    #[test]
    fn test_extract_7z_content() {
        let temp_dir = std::env::temp_dir().join(format!("insight_7z_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let src_file = temp_dir.join("sample.log");
        std::fs::write(&src_file, "2026-09-23 INFO 7z decompression works!").unwrap();

        let archive_file = temp_dir.join("test_archive.7z");
        // Compress src_file into archive_file
        sevenz_rust::compress_to_path(&src_file, &archive_file).unwrap();

        // Check magic detection
        assert_eq!(detect_archive_type(&archive_file), Some("7z"));

        // Extract content
        let contents = extract_7z_content(&archive_file).unwrap();
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0].0, "sample.log");
        assert!(contents[0].1.contains("7z decompression works!"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_detect_archive_type_unknown() {
        let temp_dir = std::env::temp_dir();
        let test_file = temp_dir.join("test_detect.unknown");
        let mut f = std::fs::File::create(&test_file).unwrap();
        f.write_all(b"regular plain text file content").unwrap();
        drop(f);

        assert_eq!(detect_archive_type(&test_file), None);
        let _ = std::fs::remove_file(test_file);
    }
}