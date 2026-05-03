# 贡献指南 (Contributing)

感谢关注 `insight-log`！这是一个轻量级的个人开源项目，欢迎提交 Issue 汇报 Bug 或提出功能建议，也欢迎提 PR 帮助改进。

## 本地开发环境要求

- **Node.js**: 20+
- **pnpm**: 10+
- **Rust**: 稳定版 (推荐通过 `rustup` 安装)
- **系统依赖**:
  - Linux: `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`
  - Windows: WebView2 (Windows 10/11 通常已自带)
  - macOS: Xcode 命令行工具 (`xcode-select --install`)

## 快速上手

1. 克隆仓库并安装依赖：
   ```bash
   git clone https://github.com/zyf8827/insight-log.git
   cd insight-log
   pnpm install
   ```

2. 启动开发模式：
   ```bash
   pnpm run dev:app
   # 或者运行脚本: ./scripts/dev.sh
   ```

3. 本地测试与校验：
   ```bash
   # 前端类型检查
   pnpm run typecheck

   # Rust 单元测试
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

## 提交 Pull Request

1. Fork 本仓库并新建特性分支。
2. 保持代码整洁，尽量保证 `pnpm run typecheck` 和 `cargo test` 通过。
3. 提交 PR 并简要说明改动意图与测试方式。
