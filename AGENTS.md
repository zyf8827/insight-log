# AGENTS.md - 架构与开发速查笔记

本文档为 AI 助手及核心开发者提供本项目的核心架构与开发速查信息。

## 项目概述
`insight-log` 是一款跨平台日志检索桌面客户端，技术栈采用 **Tauri 2.0 + React 19 + TypeScript + Rust**。

## 核心设计与模块划分

### 前端 (`/src`)
- `App.tsx`：主界面，包含目录选择、搜索配置表单（关键词、正则开关、大小写敏感、glob 模式、结果数上限）以及搜索结果列表渲染。
- `FileTree.tsx`：左侧目录树视图。
- `FileViewerFull.tsx` / `FileViewer.tsx`：基于 CodeMirror 的内置日志文件查看器，支持按行加载与上下文查看。

### 后端 (`/src-tauri/src`)
- `lib.rs`：Tauri IPC 命令注册与应用入口，维护 `AppState` 安全会话根目录，对所有路径访问执行沙箱检查以防路径穿越。
- `search.rs`：管道式搜索（`pattern1 | pattern2` 链式 AND 过滤）、正则表达式编译（支持字面量/正则切换）、重叠上下文窗口合并算法。
- `file_ops.rs`：基于内存映射与按行扫描的文件检索，包含 glob 模式过滤及单文件最大大小限制（100MB）。
- `archive.rs`：通过文件头魔数识别压缩文件，支持 **ZIP / TAR / GZ** 的内容提取，配备单条目 20MB 及单包 100MB 解压硬上限防 Zip Bomb。

## 常用命令
```bash
# 启动开发
pnpm run dev:app

# 前端类型检查
pnpm run typecheck

# 后端单元测试
cargo test --manifest-path src-tauri/Cargo.toml

# 构建可执行文件
pnpm run build:app
```