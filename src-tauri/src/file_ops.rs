use crate::archive;
use crate::models::SearchResult;
use memmap2::Mmap;
use regex::Regex;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

/// 单个文件搜索硬上限：100 MB，避免超大文件或虚拟设备造成 OOM
pub const MAX_SEARCH_FILE_SIZE: u64 = 100 * 1024 * 1024;
/// 查看普通文件内容时的最大读取上限：50 MB
pub const MAX_VIEW_FILE_SIZE: u64 = 50 * 1024 * 1024;

/// 在单个文本文件中搜索
/// 
/// 检查文件大小上限后，使用内存映射直接在借用切片上按行搜索，避免不必要的堆分配大拷贝
pub fn search_in_file(
    file_path: &Path,
    patterns: &[Regex],
) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
    let file = File::open(file_path)?;
    let metadata = file.metadata()?;
    if metadata.len() > MAX_SEARCH_FILE_SIZE {
        eprintln!(
            "跳过超大文件 {}: {} 字节 (上限 {} 字节)",
            file_path.display(),
            metadata.len(),
            MAX_SEARCH_FILE_SIZE
        );
        return Ok(vec![]);
    }

    if metadata.len() == 0 {
        return Ok(vec![]);
    }

    let mmap = unsafe { Mmap::map(&file)? };
    let content = String::from_utf8_lossy(&mmap);
    let lines: Vec<&str> = content.lines().collect();

    let mut results = Vec::new();
    for (line_num, line) in lines.iter().enumerate() {
        let matched_positions = crate::search::matches_all_patterns(line, patterns);

        if !matched_positions.is_empty() {
            // 获取上下文（前后各10行）
            let start_ctx = if line_num > 10 { line_num - 10 } else { 0 };
            let end_ctx = std::cmp::min(line_num + 11, lines.len());
            let context: Vec<String> = lines[start_ctx..end_ctx]
                .iter()
                .map(|s| s.to_string())
                .collect();

            results.push(SearchResult {
                file_path: file_path.display().to_string(),
                line_number: line_num + 1,
                content: line.to_string(),
                context,
                matched_positions,
            });
        }
    }

    Ok(results)
}

/// 处理归档文件并在其中搜索
pub fn search_in_archive(
    archive_path: &Path,
    patterns: &[Regex],
) -> Result<Vec<SearchResult>, Box<dyn std::error::Error>> {
    let archive_type = match archive::detect_archive_type(archive_path) {
        Some(t) => t,
        None => return Ok(vec![]),
    };

    let archive_contents = match archive_type {
        "zip" => archive::extract_zip_content(archive_path)?,
        "tar" => archive::extract_tar_content(archive_path)?,
        "gz" => archive::extract_gz_content(archive_path)?,
        "7z" => archive::extract_7z_content(archive_path)?,
        _ => return Ok(vec![]),
    };

    let mut results = Vec::new();
    for (inner_path, content) in archive_contents {
        let virtual_file_path = format!("{} → {}", archive_path.display(), inner_path);
        let lines: Vec<&str> = content.lines().collect();

        for (line_num, line) in lines.iter().enumerate() {
            let matched_positions = crate::search::matches_all_patterns(line, patterns);

            if !matched_positions.is_empty() {
                let start_ctx = if line_num > 10 { line_num - 10 } else { 0 };
                let end_ctx = std::cmp::min(line_num + 11, lines.len());
                let context: Vec<String> = lines[start_ctx..end_ctx]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();

                results.push(SearchResult {
                    file_path: virtual_file_path.clone(),
                    line_number: line_num + 1,
                    content: line.to_string(),
                    context,
                    matched_positions,
                });
            }
        }
    }

    Ok(results)
}

/// 根据 glob 模式过滤文件
pub fn matches_patterns(file_path: &Path, includes: &[String], excludes: &[String]) -> bool {
    let path_str = file_path.display().to_string();

    // 首先检查排除模式
    for pattern in excludes {
        if !pattern.trim().is_empty() {
            if glob::Pattern::new(pattern).map_or(false, |p| p.matches(&path_str)) {
                return false;
            }
        }
    }

    // 若无包含模式，默认包含所有未被排除的文件
    let active_includes: Vec<&String> = includes.iter().filter(|s| !s.trim().is_empty()).collect();
    if active_includes.is_empty() {
        return true;
    }

    // 检查是否匹配任一包含模式
    for pattern in active_includes {
        if glob::Pattern::new(pattern).map_or(false, |p| p.matches(&path_str)) {
            return true;
        }
    }

    false
}

pub fn parse_virtual_archive_path(file_path: &str) -> Option<(PathBuf, String)> {
    const DELIMITER: &str = "→";
    if !file_path.contains(DELIMITER) {
        return None;
    }

    let mut parts = file_path.splitn(2, DELIMITER);
    let archive_part = parts.next()?.trim().to_string();
    let inner_part = parts.next()?.trim().to_string();

    if archive_part.is_empty() || inner_part.is_empty() {
        return None;
    }

    Some((PathBuf::from(archive_part), inner_part))
}

pub fn normalize_inner_path(path: &str) -> String {
    let replaced = path.replace('\\', "/");
    let trimmed = replaced.trim_start_matches("./");
    trimmed.trim_start_matches('/').to_string()
}

/// 校验归档内部路径，拒绝绝对路径或尝试 `..` 越界的恶意条目
pub fn validate_inner_path(inner_path: &str) -> Result<String, String> {
    let normalized = normalize_inner_path(inner_path);
    if normalized.contains("../") || normalized.contains("/..") || normalized == ".." {
        return Err("非法内部路径：禁止包含路径穿越片段 '..'".to_string());
    }
    if normalized.starts_with('/') || normalized.starts_with('\\') {
        return Err("非法内部路径：禁止使用根绝对路径".to_string());
    }
    Ok(normalized)
}

pub fn read_plain_file_lines(path: &Path) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let metadata = file.metadata().map_err(|e| format!("读取元数据失败: {}", e))?;
    if metadata.len() > MAX_VIEW_FILE_SIZE {
        return Err(format!(
            "文件大小 ({} 字节) 超过单文件读取上限 ({} 字节)",
            metadata.len(),
            MAX_VIEW_FILE_SIZE
        ));
    }

    let mut limited = file.take(MAX_VIEW_FILE_SIZE);
    let mut bytes = Vec::new();
    limited.read_to_end(&mut bytes).map_err(|e| format!("读取文件失败: {}", e))?;
    let content = String::from_utf8_lossy(&bytes);
    Ok(content.lines().map(|line| line.to_string()).collect())
}

pub fn read_archive_entry_lines(archive_path: &Path, inner_path: &str) -> Result<Vec<String>, String> {
    let safe_inner = validate_inner_path(inner_path)?;
    let archive_type = archive::detect_archive_type(archive_path)
        .ok_or_else(|| "不支持的归档类型或无法识别的归档文件".to_string())?;

    match archive_type {
        "zip" => {
            use zip::read::ZipArchive;

            let file = std::fs::File::open(archive_path).map_err(|e| format!("打开归档文件失败: {}", e))?;
            let mut archive =
                ZipArchive::new(file).map_err(|e| format!("读取 ZIP 文件失败: {}", e))?;

            for i in 0..archive.len() {
                let mut entry = archive
                    .by_index(i)
                    .map_err(|e| format!("读取 ZIP 条目失败: {}", e))?;
                let entry_name = normalize_inner_path(entry.name());
                if entry_name == safe_inner {
                    let mut buffer = Vec::new();
                    let mut limited = (&mut entry).take(archive::MAX_ARCHIVE_ENTRY_SIZE);
                    limited
                        .read_to_end(&mut buffer)
                        .map_err(|e| format!("读取 ZIP 条目内容失败: {}", e))?;
                    let content = String::from_utf8_lossy(&buffer);
                    return Ok(content.lines().map(|line| line.to_string()).collect());
                }
            }

            Err(format!("未在 ZIP 归档中找到文件: {}", inner_path))
        }
        "tar" => {
            use tar::Archive;

            let file = std::fs::File::open(archive_path).map_err(|e| format!("打开归档文件失败: {}", e))?;
            let mut archive = Archive::new(file);

            for entry in archive
                .entries()
                .map_err(|e| format!("解析 TAR 条目失败: {}", e))?
            {
                let mut entry = entry.map_err(|e| format!("读取 TAR 条目失败: {}", e))?;
                let path = entry
                    .path()
                    .map_err(|e| format!("解析 TAR 条目路径失败: {}", e))?
                    .to_string_lossy()
                    .to_string();
                if normalize_inner_path(&path) == safe_inner {
                    let mut buffer = Vec::new();
                    let mut limited = (&mut entry).take(archive::MAX_ARCHIVE_ENTRY_SIZE);
                    limited
                        .read_to_end(&mut buffer)
                        .map_err(|e| format!("读取 TAR 条目内容失败: {}", e))?;
                    let content = String::from_utf8_lossy(&buffer);
                    return Ok(content.lines().map(|line| line.to_string()).collect());
                }
            }

            Err(format!("未在 TAR 归档中找到文件: {}", inner_path))
        }
        "gz" => {
            use flate2::read::GzDecoder;

            let file = std::fs::File::open(archive_path).map_err(|e| format!("打开归档文件失败: {}", e))?;
