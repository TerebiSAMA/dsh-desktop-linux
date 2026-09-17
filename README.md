# DSH Desktop (Linux)

> DeepSeek Harness 的 Linux 桌面客户端 — 独立窗口 · 托盘 · 开机自启 · 自动更新

[English version](./README.en.md)

## 它是什么

`dsh-desktop-linux` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
Web GUI 的 Electron 桌面壳。它把 DSH Web 服务 (`http://127.0.0.1:3080`) 装进一个独立的桌面窗口，
提供：

- 🪟 独立窗口 + 系统托盘
- 🔔 任务状态信号 → 托盘光条（完成 / 提问 / 失败）
- 🚀 开机自启（XDG autostart）
- 🔐 自动认证：免 token 打开 DSH Web（自签名 cookie）
- 🔄 自动更新：检测 GitHub Releases 后台静默升级

## 前置条件

桌面端只是壳，**必须有一个能跑的 DSH 后端**。三种方式：

1. **推荐**：从 npm 安装并跑 `dsh web`
   ```bash
   npm install -g @deepseek-ai/dsh
   dsh web
   ```
2. **或**：从源码树跑 `dsh web`（参考上游 `deepseek-ai/deepseek-harness` 文档）
3. **或**：用 systemd 用户单元持续托管（见 `extra/systemd/dsh-web.service`）

**首次启动前**请确保 `dsh web` 至少启动过一次 —— 它会在 `~/.dsh/.credentials.yaml` 里写入
浏览器会话密钥，桌面端靠它免 token 认证。

## 安装

前往 [Releases](https://github.com/TerebiSAMA/dsh-desktop-linux/releases) 下载
最新版（`DSH-Desktop-*.AppImage` / `.deb` / `.rpm`）。

### AppImage（最便携）

```bash
chmod +x DSH-Desktop-*.AppImage
./DSH-Desktop-*.AppImage
```

如果想注册成桌面图标：把 AppImage 移到 `~/Applications/`，再 `appimaged` 守护一次。

### Debian / Ubuntu

```bash
sudo dpkg -i dsh-desktop-linux_*.deb
sudo apt -f install   # 补依赖（如果有）
```

### Fedora / RHEL

```bash
sudo dnf install ./dsh-desktop-linux-*.rpm
```

## 自动更新

桌面端启动后会定期检查 GitHub Releases，发现新版本会在托盘弹通知，
并在下次重启时自动升级（`electron-updater`）。

若想关闭自动更新：托盘菜单没有提供开关，**当前版本需要在退出前断网**。
后续版本会加 UI 开关。

## 开发

```bash
git clone https://github.com/TerebiSAMA/dsh-desktop-linux.git
cd dsh-desktop-linux
npm install
npm start
```

构建本地包：

```bash
npm run pack        # 不打包成安装包，只解包运行
npm run dist        # 出 AppImage + deb + rpm 到 dist/
```

## 项目结构

```
src/
  main.js          # 主进程（窗口、托盘、自启、自认证 cookie）
  preload.js       # 渲染进程桥（白名单 IPC）
  error.html       # 服务失联时的兜底页
assets/
  *.png           # 应用图标 + 托盘各状态帧
.github/workflows/
  release.yml     # 出 AppImage / deb / rpm
extra/
  systemd/        # 用户级 systemd 单元模板（可选）
  autostart/      # XDG autostart 模板（可选）
```

## 常见问题

### 双击图标弹出"systemctl --user status dsh-web"

意味着 DSH Web 服务没在运行。检查：

```bash
systemctl --user status dsh-web   # 如果装了单元
curl http://127.0.0.1:3080/        # 直接探活
```

如果服务未启动但 npm 装了 `@deepseek-ai/dsh`，直接跑 `dsh web` 即可。
桌面端也会在探测失败时自动尝试拉起服务（systemd 单元 → PATH 兜底）。

### 自认证 cookie 没生效

打开桌面前需要先手动跑过至少一次 `dsh web`，让浏览器会话密钥落地到
`~/.dsh/.credentials.yaml`。如果密钥丢了，删这个文件后重启 `dsh web` 即可。

### 服务启动时把默认浏览器也打开了

如果是用上游 npm 包直接 `dsh web` 起的，可以在服务文件里加 `--no-open`，
桌面端就不会跟你的 Firefox 抢焦点了。`extra/systemd/dsh-web.service`
已经默认带上了 `--no-open`。

## 协议

MIT — see [LICENSE](./LICENSE).

## 上游

- DSH 项目：<https://github.com/deepseek-ai/deepseek-harness>
- 桌面端仓库：<https://github.com/TerebiSAMA/dsh-desktop-linux>