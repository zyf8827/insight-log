// commands wiring v1
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
            
