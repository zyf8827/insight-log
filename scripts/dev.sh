#!/bin/bash
# 启动开发模式的跨平台脚本

# 检测操作系统
OS_NAME=$(uname -s | tr '[:upper:]' '[:lower:]')

echo "检测到操作系统: $OS_NAME"
echo "启动开发模式..."

# 根据操作系统设置环境变量
case "$OS_NAME" in
    linux*)
        export PLATFORM=linux
        ;;
    darwin*)
        export PLATFORM=macos
        ;;
    mingw*|cygwin*|msys*)
        export PLATFORM=windows
        if ! command -v cargo &> /dev/null && [ -d "$USERPROFILE/.cargo/bin" ]; then
            export PATH="$USERPROFILE/.cargo/bin:$PATH"
        fi
        ;;
    *)
        echo "不支持的操作系统: $OS_NAME"
        exit 1
        ;;
esac

echo "平台: $PLATFORM"

# 启动 Tauri 开发模式
if command -v pnpm &> /dev/null; then
    echo "使用 pnpm 启动开发模式"
    pnpm tauri dev
elif command -v npm &> /dev/null; then
    echo "使用 npm 启动开发模式"
    npm run tauri dev
else
    echo "错误: 未找到 pnpm 或 npm"
    exit 1
fi