#!/bin/bash
# Windows 平台构建脚本 (Git Bash / MSYS2)

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

echo "开始构建 Windows 平台..."

TARGET="x86_64-pc-windows-msvc"
echo "Windows 构建目标: $TARGET"
echo "打包模式: $([ -z "$BUNDLE_FLAG" ] && echo "MSI/NSIS (bundle)" || echo "单二进制 (--no-bundle)")"

if command -v rustup &> /dev/null; then
    rustup target add "$TARGET"
fi

pnpm exec tauri build --target "$TARGET" $BUNDLE_FLAG

echo "Windows 构建完成！"