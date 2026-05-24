mod models;
mod search;
mod archive;
mod file_ops;

use ignore::Walk;
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use crate::models::{SearchResult, SearchParams, SearchResponse, SkippedFileInfo};

/// 应用程序全局状态，用于控制安全根目录范围，防止任意路径读取与路径穿越
pub struct AppState {
    pub allowed_root: Mutex<Option<PathBuf>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            allowed_root: Mutex::new(None),
        }
    }

    pub fn set_root(&self, path: &Path) {
        if let Ok(canon) = path.canonicalize() {
            if let Ok(mut root) = self.allowed_root.lock() {
                *root = Some(canon);
            }
        }
    }

    pub fn check_path_allowed(&self, path: &Path) -> Result<PathBuf, String> {
        let canon = path.canonicalize().map_err(|e| format!("路径不存在或无法解析: {}", e))?;
        let root_lock = self.allowed_root.lock().map_err(|e| e.to_string())?;
        match &*root_lock {
            Some(root) => {
                if canon.starts_with(root) {
                    Ok(canon)
                } else {
                    Err(format!(
                        "访问被拒绝：路径 '{}' 不在当前允许的搜索根目录 '{}' 内",
                        canon.display(),
                        root.display()
                    ))
                }
            }
            None => {
                // 若尚未设置根目录，先拒绝访问，要求用户选择目录
                Err("访问被拒绝：请先选择搜索根目录".to_string())
            }
        }
    }
}

/// 获取目录结构的函数
#[tauri::command]
async fn get_directory_structure(
    directory: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TreeNode>, String> {
    use std::fs;
    
    let path = Path::new(&directory);
    if !path.exists() || !path.is_dir() {
        return Err("目录不存在".to_string());
    }

    // 设置并允许该目录
    state.set_root(path);

    fn build_tree_node(entry_path: &std::path::Path) -> Result<TreeNode, std::io::Error> {
        let file_name = entry_path.file_name()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "Invalid file name"))?
            .to_string_lossy()
            .to_string();
        
        if entry_path.is_dir() {
            let mut children = Vec::new();
            let entries = fs::read_dir(entry_path)?;
            
            for entry in entries {
                let entry = entry?;
                let child_path = entry.path();
                if let Ok(child_node) = build_tree_node(&child_path) {
                    children.push(child_node);
                }
            }
            
            // 按类型和名称排序：先目录后文件，按字母顺序
            children.sort_by(|a, b| {
                match (a.r#type.as_str(), b.r#type.as_str()) {
                    ("directory", "file") => std::cmp::Ordering::Less,
                    ("file", "directory") => std::cmp::Ordering::Greater,
                    _ => a.title.cmp(&b.title),
                }
            });
            
            Ok(TreeNode {
                key: entry_path.to_string_lossy().to_string(),
                title: file_name,
                is_leaf: false,
                children: Some(children),
                r#type: "directory".to_string(),
            })
        } else {
            Ok(TreeNode {
                key: entry_path.to_string_lossy().to_string(),
                title: file_name,
                is_leaf: true,
                children: None,
                r#type: "file".to_string(),
            })
        }
    }

    let mut result = Vec::new();
    let entries = fs::read_dir(path)
        .map_err(|e| format!("读取目录失败: {}", e))?;
    
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let entry_path = entry.path();
        
        if let Ok(node) = build_tree_node(&entry_path) {
            result.push(node);
        }
    }
    
    result.sort_by(|a, b| {
        match (a.r#type.as_str(), b.r#type.as_str()) {
            ("directory", "file") => std::cmp::Ordering::Less,
            ("file", "directory") => std::cmp::Ordering::Greater,
            _ => a.title.cmp(&b.title),
        }
    });

    Ok(result)
}

// 定义树节点结构
#[derive(serde::Serialize)]
struct TreeNode {
    key: String,
    title: String,
    #[serde(rename = "isLeaf")]
    is_leaf: bool,
    children: Option<Vec<TreeNode>>,
    #[serde(rename = "type")]
    r#type: String,
}

/// 获取文件信息（带路径沙箱校验）
#[tauri::command]
async fn get_file_info(
    file_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<FileInfo, String> {
    use std::fs;
    
    let path_to_check = if let Some((archive_path, _)) = file_ops::parse_virtual_archive_path(&file_path) {
        archive_path
    } else {
        PathBuf::from(&file_path)
    };

    let verified_path = state.check_path_allowed(&path_to_check)?;
    if verified_path.is_dir() {
        return Err("路径是一个目录，不是文件".to_string());
    }

    let metadata = fs::metadata(&verified_path)
        .map_err(|e| format!("获取文件元数据失败: {}", e))?;
    let size = metadata.len();

    Ok(FileInfo {
        size,
        is_archive: archive::detect_archive_type(&verified_path).is_some(),
    })
}

/// 获取压缩文件内容列表（带路径沙箱校验）
#[tauri::command]
async fn get_archive_contents(
    archive_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let verified_path = state.check_path_allowed(Path::new(&archive_path))?;

    let archive_type = archive::detect_archive_type(&verified_path)
        .ok_or_else(|| "不是有效的压缩文件或格式不受支持".to_string())?;

    match archive_type {
        "zip" => {
            use std::fs::File;
            use zip::read::ZipArchive;

            let file = File::open(&verified_path).map_err(|e| format!("打开 ZIP 文件失败: {}", e))?;
            let mut archive = ZipArchive::new(file).map_err(|e| format!("读取 ZIP 文件失败: {}", e))?;

            let mut contents = Vec::new();
            for i in 0..archive.len() {
                let entry = archive.by_index(i).map_err(|e| format!("读取 ZIP 条目失败: {}", e))?;
                if entry.is_file() && archive::is_text_file(&entry.name().to_lowercase()) {
                    contents.push(entry.name().to_string());
                }
            }

            Ok(contents)
        }
        "tar" => {
            use std::fs::File;
            use tar::Archive;

            let file = File::open(&verified_path).map_err(|e| format!("打开 TAR 文件失败: {}", e))?;
            let mut archive = Archive::new(file);

            let mut contents = Vec::new();
            for entry in archive.entries().map_err(|e| format!("解析 TAR 条目失败: {}", e))? {
                let entry = entry.map_err(|e| format!("读取 TAR 条目失败: {}", e))?;
                if entry.header().entry_type().is_file() {
                    let path_str = entry.path()
                        .map_err(|e| format!("解析 TAR 条目路径失败: {}", e))?
                        .to_string_lossy()
                        .to_string();
                    
                    if archive::is_text_file(&path_str.to_lowercase()) {
                        contents.push(path_str);
                    }
                }
            }

            Ok(contents)
        }
        "gz" => {
            Ok(vec![verified_path.file_name().unwrap_or_default().to_string_lossy().to_string()])
        }
        "7z" => {
            let archive = sevenz_rust::Archive::open(&verified_path)
                .map_err(|e| format!("读取 7z 归档结构失败: {}", e))?;
            let mut contents = Vec::new();
            for entry in &archive.files {
                if !entry.is_directory() && archive::is_text_file(&entry.name().to_lowercase()) {
                    contents.push(entry.name().to_string());
                }
            }
            Ok(contents)
        }
        _ => Err("不支持的压缩文件格式".to_string()),
    }
}

/// 读取压缩文件内特定文件内容（带路径沙箱校验）
#[tauri::command]
async fn read_archive_file_content(
    archive_path: String,
    inner_path: String,
    start_line: usize,
    end_line: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let verified_path = state.check_path_allowed(Path::new(&archive_path))?;
    let safe_inner = file_ops::validate_inner_path(&inner_path)?;

    let lines = file_ops::read_archive_entry_lines(&verified_path, &safe_inner)?;
    let total_lines = lines.len();
    let start_index = std::cmp::min(start_line, total_lines);
    let end_index = match end_line {
        Some(end) => std::cmp::min(end, total_lines),
        None => std::cmp::min(start_index + 1000, total_lines),
    };

    let selected_lines = if start_index < total_lines {
        lines[start_index..end_index].to_vec()
    } else {
        vec![]
    };

    let content = selected_lines.join("\n");

    Ok(serde_json::json!({
        "content": content,
        "startLine": start_index,
        "endLine": end_index,
        "totalLines": total_lines
    }))
}

#[derive(serde::Serialize)]
struct FileInfo {
    size: u64,
    is_archive: bool,
}

/// 搜索日志文件的主函数（贯通正则开关，并设置安全根目录）
#[tauri::command]
async fn search_logs(
    search_params: SearchParams,
    state: tauri::State<'_, AppState>,
) -> Result<SearchResponse, String> {
    let start_time = std::time::Instant::now();
    let directory = Path::new(&search_params.directory);
    if !directory.exists() {
        return Err("目录不存在".to_string());
    }

    // 设置当前合法搜索根目录
    state.set_root(directory);

    let pattern_strings = search::parse_query(&search_params.query);
    if pattern_strings.is_empty() {
        return Err("查询不能为空".to_string());
    }

    let compiled_patterns = Arc::new(search::compile_patterns(
        &pattern_strings,
        search_params.case_sensitive,
        search_params.is_regex,
    )?);
    let include_patterns = Arc::new(search_params.include_patterns.clone());
    let exclude_patterns = Arc::new(search_params.exclude_patterns.clone());

    let (mut all_results, mut skipped_files): (Vec<SearchResult>, Vec<SkippedFileInfo>) = Walk::new(directory)
        .par_bridge()
        .filter_map({
            let compiled_patterns = Arc::clone(&compiled_patterns);
            let include_patterns = Arc::clone(&include_patterns);
            let exclude_patterns = Arc::clone(&exclude_patterns);
            move |entry| {
                let mut local_skipped = Vec::new();
                let entry = match entry {
                    Ok(e) => e,
                    Err(err) => {
                        local_skipped.push(SkippedFileInfo {
                            path: "未知路径".to_string(),
                            reason: format!("遍历文件时出错: {}", err),
                        });
                        return Some((Vec::new(), local_skipped));
                    }
                };

                let file_path = entry.path();
                if !file_path.is_file() {
                    return None;
                }

                if is_useless_file(file_path) {
                    return None;
                }

                if !file_ops::matches_patterns(
                    file_path,
                    include_patterns.as_slice(),
                    exclude_patterns.as_slice(),
                ) {
                    return None;
                }

                let results = if archive::detect_archive_type(file_path).is_some() {
                    match file_ops::search_in_archive_with_skipped(file_path, compiled_patterns.as_slice(), &mut local_skipped) {
                        Ok(res) => res,
                        Err(err) => {
                            local_skipped.push(SkippedFileInfo {
                                path: file_path.display().to_string(),
                                reason: format!("在归档文件中搜索出错: {}", err),
                            });
                            Vec::new()
                        }
                    }
                } else {
                    match file_ops::search_in_file_with_skipped(file_path, compiled_patterns.as_slice(), &mut local_skipped) {
                        Ok(res) => res,
                        Err(err) => {
                            local_skipped.push(SkippedFileInfo {
                                path: file_path.display().to_string(),
                                reason: format!("在文件中搜索出错: {}", err),
                            });
                            Vec::new()
                        }
                    }
                };

                if results.is_empty() && local_skipped.is_empty() {
                    None
                } else {
                    Some((results, local_skipped))
                }
            }
        })
        .reduce(
            || (Vec::new(), Vec::new()),
            |mut acc, mut item| {
                acc.0.append(&mut item.0);
                acc.1.append(&mut item.1);
                acc
            },
        );

    all_results.sort_by(|a, b| {
        a.file_path
            .cmp(&b.file_path)
            .then(a.line_number.cmp(&b.line_number))
    });

    let total_matches = all_results.len();
    let is_truncated = total_matches > search_params.max_results;
    all_results.truncate(search_params.max_results);
    let merged_results = search::merge_search_results(all_results, 10);
    let elapsed_ms = start_time.elapsed().as_millis() as u64;

    Ok(SearchResponse {
        results: merged_results,
        total_count: total_matches,
        elapsed_ms,
        is_truncated,
        skipped_files,
    })
}

/// 选择目录的函数
#[tauri::command]
async fn select_directory(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (sender, receiver) = oneshot::channel();

    app_handle.dialog().file().pick_folder(move |result| {
        let selected = result.map(|path| path.to_string());
        let _ = sender.send(selected);
    });

    let selected = receiver.await.map_err(|e| format!("选择目录失败: {}", e))?;
    if let Some(ref dir) = selected {
        state.set_root(Path::new(dir));
    }

    Ok(selected)
}

/// 读取文件内容的函数（带路径沙箱校验）
#[tauri::command]
async fn read_file_content(
    file_path: String,
    start_line: usize,
    end_line: Option<usize>,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let lines = if let Some((archive_path, inner_path)) = file_ops::parse_virtual_archive_path(&file_path) {
        let verified_archive = state.check_path_allowed(&archive_path)?;
        file_ops::validate_inner_path(&inner_path)?;
        file_ops::read_archive_entry_lines(&verified_archive, &inner_path)?
    } else {
        let verified_path = state.check_path_allowed(Path::new(&file_path))?;
        file_ops::read_plain_file_lines(&verified_path)?
    };

    let total_lines = lines.len();
    let start_index = std::cmp::min(start_line, total_lines);
    let end_index = match end_line {
        Some(end) => std::cmp::min(end, total_lines),
        None => std::cmp::min(start_index + 1000, total_lines),
    };

    let selected_lines = if start_index < total_lines {
        lines[start_index..end_index].to_vec()
    } else {
        vec![]
    };

    let content = selected_lines.join("\n");

    Ok(serde_json::json!({
        "content": content,
        "startLine": start_index,
        "endLine": end_index,
        "totalLines": total_lines
    }))
}

/// 检查文件是否为明确不需要搜索的无用文件类型
fn is_useless_file(file_path: &Path) -> bool {
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
        "dat", "bin", "hex", "elf",
    ];

    if let Some(ext) = file_path.extension() {
        if let Some(ext_str) = ext.to_str() {
            return extensions.iter().any(|&e| e.eq_ignore_ascii_case(ext_str));
        }
    }
    
    false
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            search_logs,
            select_directory,
            read_file_content,
            get_directory_structure,
            get_file_info,
            get_archive_contents,
            read_archive_file_content
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用时出错");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_app_state_path_scope_check() {
        let temp_dir = std::env::temp_dir().join("insight_test_root");
        let sub_dir = temp_dir.join("sub");
        let _ = fs::create_dir_all(&sub_dir);
        let allowed_file = sub_dir.join("allowed.log");
        let _ = fs::write(&allowed_file, "log line");

        let outside_dir = std::env::temp_dir().join("insight_test_outside");
        let _ = fs::create_dir_all(&outside_dir);
        let outside_file = outside_dir.join("secret.txt");
        let _ = fs::write(&outside_file, "secret");

        let state = AppState::new();
        // 尚未设置根目录时，拒绝访问
        assert!(state.check_path_allowed(&allowed_file).is_err());

        // 设置根目录为 temp_dir
        state.set_root(&temp_dir);

        // 根目录内文件允许访问
        assert!(state.check_path_allowed(&allowed_file).is_ok());

        // 外部文件拒绝访问
        assert!(state.check_path_allowed(&outside_file).is_err());

        // 路径穿越 (例如 temp_dir/sub/../../insight_test_outside/secret.txt) 也会被 canonicalize 还原并拒绝
        let traversal_path = sub_dir.join("../../../insight_test_outside/secret.txt");
        assert!(state.check_path_allowed(&traversal_path).is_err());

        let _ = fs::remove_dir_all(temp_dir);
        let _ = fs::remove_dir_all(outside_dir);
    }
}
