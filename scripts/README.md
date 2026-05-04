# 构建与开发脚本说明

本目录包含 `insight-log` 在各平台下的辅助构建与开发脚本。

## 脚本清单

| 脚本 | 用途 | 说明 |
| :--- | :--- | :--- |
| `dev.sh` | 本地开发启动 | 跨平台自动检测操作系统并启动 `pnpm tauri dev` |
| `build.sh` | 通用构建脚本 | 跨平台自动检测 OS 及 CPU 架构（如 macOS arm64/x86_64 自动判断） |
| `build-linux.sh` | Linux 构建 | 针对 `x86_64-unknown-linux-gnu` 构建 |
| `build-macos.sh` | macOS 构建 | 自动识别 Apple Silicon (`aarch64`) 与 Intel (`x86_64`) 架构 |
| `build-windows.sh` | Windows 构建 | 适用于 Git Bash / MSYS2 环境 |
| `build-windows.bat` / `.ps1` | Windows 原生构建 | 适用于 CMD / PowerShell 环境 |

## 二进制构建 vs 安装包构建

- **默认模式（快速开发构建）**：
  直接执行脚本默认附带 `--no-bundle`，仅在 `src-tauri/target/<target>/release/` 下输出可执行二进制，跳过打包以节省开发编译时间。
  ```bash
  ./scripts/build.sh
  ```

- **安装包模式（发布打包）**：
  传入 `--bundle` 参数，将生成对应系统的原生安装包（如 Windows `.msi` / `.exe`，macOS `.dmg`，Linux `.AppImage` / `.deb`）：
  ```bash
  ./scripts/build.sh --bundle
  ```