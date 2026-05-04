# Windows 平台构建脚本 (PowerShell)

Write-Host "开始构建 Windows 平台..." -ForegroundColor Green

# 检查必要的构建依赖
if (!(Get-Command rustc -ErrorAction SilentlyContinue)) {
    Write-Host "错误: Rust 未安装" -ForegroundColor Red
    exit 1
}

if (!(Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "错误: Cargo 未安装" -ForegroundColor Red
    exit 1
}

if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "错误: pnpm 未安装" -ForegroundColor Red
    exit 1
}

# 安装 Windows 构建目标
Write-Host "安装 Windows 构建目标..." -ForegroundColor Yellow
rustup target add x86_64-pc-windows-msvc

# 检查 Windows 构建目标是否可用
$targets = rustc --print target-list | Out-String
if ($targets -notmatch "x86_64-pc-windows-msvc") {
    Write-Host "错误: Windows MSVC 目标不可用，可能需要安装 Visual Studio Build Tools" -ForegroundColor Red
    exit 1
}

# 设置 Windows 构建环境变量
$env:CRT_STATIC = "1"

# 执行构建
Write-Host "开始构建 Windows 版本..." -ForegroundColor Yellow
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    $buildResult = pnpm tauri build --target x86_64-pc-windows-msvc --no-bundle
    if ($LASTEXITCODE -ne 0) {
        Write-Host "构建失败，退出码: $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "错误: 未找到 pnpm" -ForegroundColor Red
    exit 1
}

Write-Host "Windows 构建完成！" -ForegroundColor Green
Read-Host "按任意键继续..."