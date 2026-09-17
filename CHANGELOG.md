# Changelog

所有显著改动记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

### Added
- README 双语（中/英）
- 贡献指南与安全策略
- systemd 用户单元模板（`extra/systemd/`）

## [0.2.1-alpha.1] - 2026-09-17

### Added
- 首次以独立仓库形式发布（`TerebiSAMA/dsh-desktop-linux`）
- 自认证 cookie：免 token 加载 DSH Web GUI
- systemd 用户单元启动 + PATH 兜底

### Changed
- `startService` 不再硬编码 `~/.local/bin/dsh`，先试 systemd、再 PATH

## [0.2.0] - 之前内部分发

### Added
- Electron 桌面端 + 系统托盘 + 开机自启
- 任务状态信号 → 托盘光条动画
- 服务失联兜底页

[Unreleased]: https://github.com/TerebiSAMA/dsh-desktop-linux/compare/v0.2.1-alpha.1...HEAD
[0.2.1-alpha.1]: https://github.com/TerebiSAMA/dsh-desktop-linux/releases/tag/v0.2.1-alpha.1
[0.2.0]: https://github.com/TerebiSAMA/dsh-desktop-linux/releases/tag/v0.2.0