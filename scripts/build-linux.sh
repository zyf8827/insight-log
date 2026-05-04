#!/bin/bash
# Linux 平台构建脚本

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

echo "开始构建 Linux 平台..."

if [[ "$OSTYPE" != "linux"* ]]; then
    echo "警告: 当前不在 Linux 环境中"
fi

TARGET="x86_64-unknown-linux-gnu"
echo "Linux 构建目标: $TARGET"
echo "打包模式: $([ -z "$BUNDLE_FLAG" ] && echo "AppImage/deb (bundle)" || echo "单二进制 (--no-bundle)")"

if command -v rustup &> /dev/null; then
    rustup target add "$TARGET"
fi

pnpm exec tauri build --target "$TARGET" $BUNDLE_FLAG

echo "Linux 构建完成！"