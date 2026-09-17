# Changelog

所有显著改动记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

### Added
- **托盘图标皮肤**：右键菜单 → "图标皮肤" 子菜单，三套配色（蓝/黑/白），
  选择持久化到 `~/.config/dsh-desktop/config.json`。三套都重画了完整的 5 状态帧
  （base / done / ask / ask-faint / fail），每套 22/44 两套尺寸，共 30 张图
- **重画托盘状态光条**：原 asar 里的状态帧全部是同一张图，导致"呼吸灯条"无视觉
  变化；现在不同皮肤+不同状态都有真实可辨的差异（绿/黄/红顶部色条）
- **傻瓜式自启 / 自动安装**：探测失败时依次尝试 systemd → 直接启动 → npm 安装 →
  pkexec 提权安装 → 等待就绪。错误页 (`error.html`) 改为动态显示当前阶段、重试按钮、
  手动安装命令一键复制
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