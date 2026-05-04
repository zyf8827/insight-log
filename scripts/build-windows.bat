@echo off
REM Windows 平台构建脚本 (.bat)

echo 开始构建 Windows 平台...

REM 检查必要的构建依赖
where rustc >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: Rust 未安装
    exit /b 1
)

where cargo >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: Cargo 未安装
    exit /b 1
)

where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: pnpm 未安装
    exit /b 1
)

REM 安装 Windows 构建目标
echo 安装 Windows 构建目标...
rustup target add x86_64-pc-windows-msvc

REM 检查 Windows 构建目标是否可用
rustc --print target-list | findstr "x86_64-pc-windows-msvc" >nul
if %errorlevel% neq 0 (
    echo 错误: Windows MSVC 目标不可用，可能需要安装 Visual Studio Build Tools
    exit /b 1
)

REM 设置 Windows 构建环境变量
set CRT_STATIC=1

REM 执行构建
echo 开始构建 Windows 版本...
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo 错误: 未找到 pnpm
    exit /b 1
) else (
    pnpm tauri build --target x86_64-pc-windows-msvc --no-bundle
)

echo Windows 构建完成！
pause