#!/bin/bash
# macOS 平台构建脚本

set -e

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

echo "开始构建 macOS 版本..."

if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "警告: 当前不在 macOS 环境中"
fi

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    TARGET="aarch64-apple-darwin"
else
    TARGET="x86_64-apple-darwin"
fi

echo "macOS 构建目标架构: $TARGET"
echo "打包模式: $([ -z "$BUNDLE_FLAG" ] && echo "DMG/App Bundle" || echo "单二进制 (--no-bundle)")"

if command -v rustup &> /dev/null; then
    rustup target add "$TARGET"
fi

pnpm exec tauri build --target "$TARGET" $BUNDLE_FLAG

echo "macOS 构建完成！"