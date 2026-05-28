use std::path::Path;
use crate::models::SkippedFileInfo;

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

/// 从 7z 文件中提取文本文件内容（带解压大小限制与防炸弹机制，并记录跳过的文件）
pub fn extract_7z_content_with_skipped(
    file_path: &Path,
    skipped: &mut Vec<SkippedFileInfo>,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    use std::io::Read;

    let mut sz = sevenz_rust::SevenZReader::open(file_path, sevenz_rust::Password::empty())?;
    let mut results = Vec::new();
    let mut total_extracted: u64 = 0;

    sz.for_each_entries(|entry, reader| {
        if total_extracted >= MAX_ARCHIVE_TOTAL_SIZE {
            skipped.push(SkippedFileInfo {
                path: file_path.display().to_string(),
                reason: format!("7z 压缩包解压总量已达上限 100MB，停止解压后续条目"),
            });
            return Ok(false);
        }

        let entry_name = entry.name().to_string();
        if !entry.is_directory() && is_text_file(&entry_name) {
            if entry.size() > MAX_ARCHIVE_ENTRY_SIZE {
                skipped.push(SkippedFileInfo {
                    path: format!("{} → {}", file_path.display(), entry_name),
                    reason: format!("7z 条目大小超过单文件解压上限 20MB (实际: {:.1}MB)", entry.size() as f64 / (1024.0 * 1024.0)),
                });
                return Ok(true);
            }

            let mut buffer = Vec::new();
            let mut limited = reader.take(MAX_ARCHIVE_ENTRY_SIZE);
            let read_bytes = limited.read_to_end(&mut buffer).map_err(sevenz_rust::Error::io)? as u64;
            total_extracted += read_bytes;

            // 无后缀条目：读前 512 字节，若含 \0 则视为二进制跳过
            if !has_file_extension(&entry_name) {
                let probe_len = buffer.len().min(512);
                if buffer[..probe_len].contains(&0) {
                    return Ok(true);
                }
            }

            let content = String::from_utf8_lossy(&buffer).to_string();
            results.push((entry_name, content));
        }

        Ok(true)
    })?;

    Ok(results)
}

pub fn extract_7z_content(
    file_path: &Path,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    extract_7z_content_with_skipped(file_path, &mut Vec::new())
}

/// 从 ZIP 文件中提取文本文件内容（带解压大小限制与防炸弹机制，并记录跳过的文件）
pub fn extract_zip_content_with_skipped(
    file_path: &Path,
    skipped: &mut Vec<SkippedFileInfo>,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    use std::io::Read;
    use zip::read::ZipArchive;

    let file = std::fs::File::open(file_path)?;
    let mut archive = ZipArchive::new(file)?;
    let mut results = Vec::new();
    let mut total_extracted: u64 = 0;

    for i in 0..archive.len() {
        if total_extracted >= MAX_ARCHIVE_TOTAL_SIZE {
            skipped.push(SkippedFileInfo {
                path: file_path.display().to_string(),
                reason: format!("ZIP 压缩包解压总量已达上限 100MB，停止解压后续条目"),
            });
            break;
        }

        let mut entry = archive.by_index(i)?;
        let entry_name = entry.name().to_string();
        if entry.is_file() && is_text_file(&entry_name) {
            // 防 zip bomb：若条目声明的大小超过上限，跳过
            if entry.size() > MAX_ARCHIVE_ENTRY_SIZE {
                skipped.push(SkippedFileInfo {
                    path: format!("{} → {}", file_path.display(), entry_name),
                    reason: format!("ZIP 条目大小超过单文件解压上限 20MB (实际: {:.1}MB)", entry.size() as f64 / (1024.0 * 1024.0)),
                });
                continue;
            }

            let mut buffer = Vec::new();
            let mut limited = (&mut entry).take(MAX_ARCHIVE_ENTRY_SIZE);
            let read_bytes = limited.read_to_end(&mut buffer)? as u64;
            total_extracted += read_bytes;

            // 无后缀条目：读前 512 字节，若含 \0 则视为二进制跳过
            if !has_file_extension(&entry_name) {
                let probe_len = buffer.len().min(512);
                if buffer[..probe_len].contains(&0) {
                    continue;
                }
            }

            let content = String::from_utf8_lossy(&buffer).to_string();
            results.push((entry_name, content));
        }
    }

    Ok(results)
}

pub fn extract_zip_content(
    file_path: &Path,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    extract_zip_content_with_skipped(file_path, &mut Vec::new())
}

/// 从 TAR 文件中提取文本文件内容（带解压大小限制，并记录跳过的文件）
pub fn extract_tar_content_with_skipped(
    file_path: &Path,
    skipped: &mut Vec<SkippedFileInfo>,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    use std::io::Read;
    use tar::Archive;

    let file = std::fs::File::open(file_path)?;
    let mut archive = Archive::new(file);
    let mut results = Vec::new();
    let mut total_extracted: u64 = 0;

    for entry in archive.entries()? {
        if total_extracted >= MAX_ARCHIVE_TOTAL_SIZE {
            skipped.push(SkippedFileInfo {
                path: file_path.display().to_string(),
                reason: format!("TAR 归档解压总量已达上限 100MB，停止解压后续条目"),
            });
            break;
        }

        let mut entry = entry?;
        if entry.header().entry_type().is_file() {
            let size = entry.header().size()?;
            if size > MAX_ARCHIVE_ENTRY_SIZE {
                let entry_path = entry.path().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| "unknown".to_string());
                skipped.push(SkippedFileInfo {
                    path: format!("{} → {}", file_path.display(), entry_path),
                    reason: format!("TAR 条目大小超过单文件解压上限 20MB (实际: {:.1}MB)", size as f64 / (1024.0 * 1024.0)),
                });
                continue;
            }

            let path = entry.path()?.to_string_lossy().to_string();
            if is_text_file(&path) {
                let mut buffer = Vec::new();
                let mut limited = (&mut entry).take(MAX_ARCHIVE_ENTRY_SIZE);
                let read_bytes = limited.read_to_end(&mut buffer)? as u64;
                total_extracted += read_bytes;

                // 无后缀条目：读前 512 字节，若含 \0 则视为二进制跳过
                if !has_file_extension(&path) {
                    let probe_len = buffer.len().min(512);
                    if buffer[..probe_len].contains(&0) {
                        continue;
                    }
                }

                let content = String::from_utf8_lossy(&buffer).to_string();
                results.push((path, content));
            }
        }
    }

    Ok(results)
}

pub fn extract_tar_content(
    file_path: &Path,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    extract_tar_content_with_skipped(file_path, &mut Vec::new())
}

/// 从 GZ 文件中提取内容（带解压大小限制，并记录跳过的文件）
pub fn extract_gz_content_with_skipped(
    file_path: &Path,
    skipped: &mut Vec<SkippedFileInfo>,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    use flate2::read::GzDecoder;
    use std::io::Read;

    let file = std::fs::File::open(file_path)?;
    let mut decoder = GzDecoder::new(file);
    let mut buffer = Vec::new();
    let mut limited = (&mut decoder).take(MAX_ARCHIVE_ENTRY_SIZE);
    limited.read_to_end(&mut buffer)?;

    let mut extra = [0u8; 1];
    if decoder.read(&mut extra).unwrap_or(0) > 0 {
        skipped.push(SkippedFileInfo {
            path: file_path.display().to_string(),
            reason: format!("GZ 解压内容超过单文件解压上限 20MB，后续内容已截断"),
        });
    }

    let content = String::from_utf8_lossy(&buffer).to_string();
    let file_name = file_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "uncompressed".to_string());

    Ok(vec![(file_name, content)])
}

pub fn extract_gz_content(
    file_path: &Path,
) -> Result<Vec<(String, String)>, Box<dyn std::error::Error>> {
    extract_gz_content_with_skipped(file_path, &mut Vec::new())
}

/// 检查文件名是否有扩展名
pub fn has_file_extension(file_name: &str) -> bool {
    let base_name = file_name.rsplit('/').next().unwrap_or(file_name);
    let base_name = base_name.rsplit('\\').next().unwrap_or(base_name);
    base_name.contains('.')
}

/// 检查文件名是否对应应当跳过的无用二进制格式
pub fn is_useless_file_by_name(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    let base_name = lower.rsplit('/').next().unwrap_or(&lower);
    let base_name = base_name.rsplit('\\').next().unwrap_or(base_name);

    // 针对 catalina.out, nohup.out 等常见日志输出文件，不作为 .out 二进制文件过滤
    if base_name == "catalina.out"
        || base_name == "nohup.out"
        || base_name.starts_with("catalina")
        || base_name.starts_with("nohup")
        || base_name.ends_with(".log.out")
    {
        return false;
    }

    let extensions = [
        "swp", "swo", "swn", "swm", "swl", "swx",
        "dmp", "dump",
        "exe", "msi", "dll", "so", "dylib", "app", "bin", "out",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
        "db", "sqlite", "sqlite3", "mdb", "accdb", "db3", "mdf", "ldf",
        "jpg", "jpeg", "png", "gif", "bmp", "tiff", "tif", "webp", "svg", "ico", "psd", "ai", "eps",
        "mp3", "wav", "flac", "aac", "ogg", "wma", "mp4", "avi", "mov", "wmv", "mkv", "flv", "webm",
        "tmp", "temp", "bak", "backup", "old", "orig", "save", "autosave",
        "o", "obj", "lib", "a", "class", "jar", "war", "pyc", "pyo",
        "sys", "drv", "inf",
        "iso", "img", "vmdk", "vdi", "vhd", "vhdx", "ova", "ovf", "qcow", "qcow2", "raw",
        "dat", "hex", "elf",
    ];

    for ext in extensions.iter() {
        if base_name.ends_with(&format!(".{}", ext)) {
            return true;
        }
    }
    
    false
}

/// 检查文件扩展名或文件名是否为常见文本/日志格式
pub fn is_text_file(file_name: &str) -> bool {
    let lower = file_name.to_lowercase();
    let base_name = lower.rsplit('/').next().unwrap_or(&lower);
    let base_name = base_name.rsplit('\\').next().unwrap_or(base_name);

    if is_useless_file_by_name(base_name) {
        return false;
    }

    // 1. 常见系统日志文件名或前缀（包含无后缀与特殊后缀）
    if base_name == "catalina.out"
        || base_name == "nohup.out"
        || base_name == "syslog"
        || base_name == "messages"
        || base_name == "dmesg"
        || base_name == "boot.log"
        || base_name == "kern.log"
        || base_name == "auth.log"
        || base_name.starts_with("syslog")
        || base_name.starts_with("messages")
        || base_name.starts_with("catalina")
        || base_name.starts_with("nohup")
    {
        return true;
    }

    // 2. 常见文本/配置扩展名
    let text_extensions = [
        ".log", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".tsv", ".sql", ".html", ".htm",
        ".js", ".ts", ".css", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
        ".sh", ".bash", ".zsh", ".conf", ".ini", ".properties", ".env", ".toml", ".md",
    ];

    if text_extensions.iter().any(|ext| base_name.ends_with(ext)) {
        return true;
    }

    // 3. 常见轮转日志格式：*.log.N, *.log.YYYY-MM-DD, *.log.YYYYMMDD, *.txt.N
    if let Some(pos) = base_name.find(".log.") {
        let suffix = &base_name[pos + 5..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '_' || c == '.') {
            return true;
        }
    }
    if let Some(pos) = base_name.find(".txt.") {
        let suffix = &base_name[pos + 5..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '_' || c == '.') {
            return true;
        }
    }

    // 4. 无后缀条目：放宽当做候选文本，解压时读前 512 字节探测无 \0 判定为文本
    if !base_name.contains('.') {
        return true;
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
        assert!(!is_text_file("program.out"));
    }

    #[test]
    fn test_rotated_logs_and_catalina() {
        // Rotated logs
        assert!(is_text_file("app.log.1"));
        assert!(is_text_file("server.log.2"));
        assert!(is_text_file("access.log.2026-05-28"));
        assert!(is_text_file("error.log.20260528"));
        assert!(is_text_file("syslog.1"));
        assert!(is_text_file("syslog.2026-05-28"));
        assert!(is_text_file("messages.1"));

        // Catalina / Nohup out
        assert!(is_text_file("catalina.out"));
        assert!(is_text_file("catalina.2026-05-28.out"));
        assert!(is_text_file("nohup.out"));
        assert!(!is_useless_file_by_name("catalina.out"));
        assert!(!is_useless_file_by_name("nohup.out"));
        assert!(!is_useless_file_by_name("catalina.2026-05-28.out"));

        // System logs without extensions
        assert!(is_text_file("syslog"));
        assert!(is_text_file("messages"));
        assert!(is_text_file("dmesg"));
        assert!(is_text_file("unnamed_log"));
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