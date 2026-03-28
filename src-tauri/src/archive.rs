// archive v1: zip/tar/gz only
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
