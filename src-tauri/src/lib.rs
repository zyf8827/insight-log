mod models;
mod search;
mod archive;
mod file_ops;

use ignore::Walk;
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use crate::models::{SearchResult, SearchParams, SearchResponse};

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
