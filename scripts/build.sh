#!/bin/bash
# 跨平台通用构建脚本 (insight-log)

set -e

# 参数解析：默认 --no-bundle 生成单二进制，传入 --bundle 则生成原生安装包
BUNDLE_FLAG="--no-bundle"
for arg in "$@"; do
    case "$arg" in
        --bundle)
            BUNDLE_FLAG=""
            ;;
        --no-bundle)
            BUNDLE_FLAG="--no-bundle"
            ;;
    esac
done

OS_NAME=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
echo "检测到操作系统: $OS_NAME, 架构: $ARCH"

case "$OS_NAME" in
    linux*)
        PLATFORM="linux"
        BUILD_TARGET="x86_64-unknown-linux-gnu"
        ;;
    darwin*)
        PLATFORM="macos"
        if [ "$ARCH" = "arm64" ]; then
            BUILD_TARGET="aarch64-apple-darwin"
        else
            BUILD_TARGET="x86_64-apple-darwin"
        fi
        ;;
    mingw*|cygwin*|msys*)
        PLATFORM="windows"
        BUILD_TARGET="x86_64-pc-windows-msvc"
        ;;
    *)
        echo "不支持的操作系统: $OS_NAME"
        exit 1
        ;;
esac

echo "平台: $PLATFORM, 目标架构: $BUILD_TARGET"
echo "打包模式: $([ -z "$BUNDLE_FLAG" ] && echo "完整安装包 (bundle)" || echo "单二进制文件 (no-bundle)")"

if command -v rustup &> /dev/null; then
    if ! rustup target list --installed | grep -q "$BUILD_TARGET"; then
        echo "安装 Rust 目标: $BUILD_TARGET"
        rustup target add "$BUILD_TARGET"
    fi
fi

if command -v pnpm &> /dev/null; then
    echo "使用 pnpm 执行构建"
    pnpm exec tauri build --target "$BUILD_TARGET" $BUNDLE_FLAG
else
    echo "错误: 未找到 pnpm，请先安装 pnpm"
    exit 1
fi

echo "构建完成！"