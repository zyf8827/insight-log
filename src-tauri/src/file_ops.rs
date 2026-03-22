// file ops v1
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

