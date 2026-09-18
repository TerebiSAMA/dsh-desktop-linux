# DSH Desktop (Linux)

> DeepSeek Harness 的 Linux 桌面客户端 — 独立窗口 · 托盘 · 开机自启 · 自动更新

[English version](./README.en.md)

## 它是什么

`dsh-desktop-linux` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
Web GUI 的 Electron 桌面壳。它把 DSH Web 服务 (`http://127.0.0.1:3080`) 装进一个独立的桌面窗口，
提供：

- 🪟 独立窗口 + 系统托盘
- 🎨 托盘图标三套皮肤（蓝/黑/白），右键菜单切换
- 🔔 任务状态信号 → 托盘光条（完成 / 提问 / 失败）
- 🚀 开机自启（XDG autostart）
- 🔐 自动认证：免 token 打开 DSH Web（自签名 cookie）
- 🔄 自动更新：检测 GitHub Releases 后台静默升级

## 一键安装（推荐）

一行命令装好所有依赖（DSH 后端 + GUI 客户端插件 + 可选 systemd 守护
+ 可选开机自启 + 首次启动落 credentials）：

```bash
curl -fsSL https://raw.githubusercontent.com/TerebiSAMA/dsh-desktop-linux/main/install.sh | bash -s -- --with-systemd
```

可选 flag：

| flag | 作用 |
|---|---|
| `--with-systemd` | 安装并启用 systemd 用户单元（DSH Web 后台守护 + 失败自动重启） |
| `--with-autostart` | 安装 XDG autostart（开机启动桌面端） |
| `--no-launch` | 不自动启动 dsh web（自己控制时机） |

跑完后用对应的方式启动桌面端（双击图标 / `./DSH-Desktop-*.AppImage`
/ `sudo dnf install ./...rpm` —— 见下文"安装"章节）。脚本可以重复跑，
每一步都做幂等检查，不会重复覆盖。

安装成功后**桌面会自动生成一个图标**（`~/Desktop/dsh-desktop-linux.desktop`，
Exec 字段会自动检测 `/opt/...`、`/usr/bin/...`、AppImage 等常见安装路径）——
headless 服务器（没有 `~/Desktop`）会跳过这步，其他平台图标都可正常启动。

## 启动流程（傻瓜式）

双击图标后，桌面端会按下面顺序自动把一切准备好：

1. 探测 `http://127.0.0.1:3080`，通了就直接进 GUI
2. 没通 → 试 `systemctl --user start dsh-web`（你装了用户单元的话）
3. 还起不来 → 在 PATH 里找 `dsh`
4. 没有 `dsh` → 跑 `npm install -g @deepseek-ai/dsh`（失败会试 `pkexec` 提权安装）
5. 装好后跑 `dsh web`，轮询等待端口就绪
6. 都失败 → 错误页显示手动安装步骤和最近错误日志，可以一键复制

**前提**：系统里有 `node` 和 `npm`（提权安装还需要 `pkexec`，多数发行版自带）。

## 可选：预先手动准备

桌面端本身是壳，**但会自动安装和启动后端**，所以通常**不需要**任何手工操作。
如果你想接管：

1. 从 npm 安装并跑 `dsh web`
   ```bash
   npm install -g @deepseek-ai/dsh
   dsh web
   ```
2. 或从源码树跑（参考上游 `deepseek-ai/deepseek-harness` 文档）
3. 或用 systemd 用户单元持续托管（见 `extra/systemd/dsh-web.service`）

**首次启动前**请确保 `dsh web` 至少启动过一次 —— 它会在 `~/.dsh/.credentials.yaml` 里写入
浏览器会话密钥，桌面端靠它免 token 认证。

## 安装

> **当前仓库未发布预编译包**，请从源码运行（CI 已就绪，会在未来出
> AppImage / deb / rpm 时自动发到 Releases 页面）。

### 从源码运行（推荐）

```bash
git clone https://github.com/TerebiSAMA/dsh-desktop-linux.git
cd dsh-desktop-linux
npm install
npm start
```

`npm start` 会启动 Electron 开发者模式；GUI 修改会热重载，但主进程
改动需手动重启。

### 自己打包（可选）

```bash
npm run pack        # 只解包运行，不出安装包
npm run dist        # 出 AppImage / deb / rpm 到 dist/
```

`npm run dist` 依赖 `electron-builder` 在本机工具链（rpm-build / fakeroot 等）。
想体验预编译包可以在自己的 fork 里跑 Actions 工作流 `.github/workflows/release.yml`，
产物会出现在 Release 页面。

## 局域网访问（把 dsh 从局域网内暴露给其他机器）

DSH 上游默认只绑 `127.0.0.1:3080`，且 npm 缓存版本硬编码拒绝绑定 `0.0.0.0`。
本仓库提供了一个**零依赖 Node 反向代理**（`tools/dsh-lan-proxy.js`），
监听 `0.0.0.0:<LAN_PORT>`（默认 `5080`），把请求转发到本机 `127.0.0.1:3080`，
并自己**重新种 cookie**——因为 dsh 的浏览器 cookie 是按 `Host` 头签的，
直接转发会被 `host fence` 挡掉。

### 安装（systemd 用户单元）

把代理脚本和 token watcher 装到系统：

```bash
# 把代理和 token watcher 放到标准位置
sudo install -m755 tools/dsh-lan-proxy.js /usr/local/lib/dsh-desktop-linux/dsh-lan-proxy.js
sudo install -m755 tools/dsh-lan-proxy-env.sh /usr/local/bin/dsh-lan-proxy-env
sudo mkdir -p /usr/local/lib/dsh-desktop-linux

# 把 systemd 单元装到用户目录
mkdir -p ~/.config/systemd/user
cp extra/systemd/dsh-lan-proxy.service ~/.config/systemd/user/
cp extra/systemd/dsh-lan-proxy-env.service ~/.config/systemd/user/

# 改两个占位符：DSH_LAN_HOST、DSH_ALLOWED_REMOTE
$EDITOR ~/.config/systemd/user/dsh-lan-proxy.service
#   Environment=DSH_LAN_HOST=192.168.x.y          ← 这台机器的 LAN IP
#   Environment=DSH_ALLOWED_REMOTE=192.168.x.z     ← 允许访问的客户端 IP（逗号分隔）

# 让 dsh 信任 LAN 端的来源（drop-in）
mkdir -p ~/.config/systemd/user/dsh-web.service.d
cp extra/systemd/dsh-web.service.d/public-bind.conf.example \
   ~/.config/systemd/user/dsh-web.service.d/public-bind.conf
$EDITOR ~/.config/systemd/user/dsh-web.service.d/public-bind.conf
#   把 <LAN_IP> 替换成这台机器的 LAN IP（必须和 DSH_LAN_HOST 一致）

systemctl --user daemon-reload
systemctl --user enable --now dsh-lan-proxy-env.service
systemctl --user enable --now dsh-lan-proxy.service
systemctl --user enable --now dsh-web.service   # 已装过的就 restart
```

### firewalld 限制访问源 IP（强烈推荐）

只允许上面 `DSH_ALLOWED_REMOTE` 里的客户端访问 5080：

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.x.z" port port="5080" protocol="tcp" accept'
sudo firewall-cmd --reload
```

不放心可以再加一条拒绝规则兜底（先接受后拒绝 → 默认拒绝）：

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" port port="5080" protocol="tcp" reject'
sudo firewall-cmd --reload
```

### 工作原理（一句话）

代理监听 `0.0.0.0:5080` → 第一次接到请求时，代理内部用 `Host: <LAN_IP>:5080`
头去 `127.0.0.1:3080/?token=<token>` 让 dsh 自己签一个 cookie → 缓存它，
后续请求都注入这个 cookie 并把 `Host`/`Origin`/`Referer` 重写到 LAN authority
→ dsh 看到的就像"同一台机器的同一浏览器会话"。`/api/remote.mux` 的 WebSocket
升级 101 响应完整透传。`dsh-web` 重启换 token 时，`dsh-lan-proxy-env.service`
从 systemd journal 抓新 token 写到 `/run/user/<uid>/dsh-lan-proxy.env`，
代理下次请求会自动重新种 cookie，无需人工介入。

### 配置参数

代理通过环境变量配置（systemd 单元的 `Environment=` 行）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_LAN_HOST` | `127.0.0.1` | LAN 端看到的 IP（**必填**为你机器的 LAN IP） |
| `DSH_LAN_PORT` | `5080` | LAN 端口 |
| `DSH_UPSTREAM` | `http://127.0.0.1:3080` | dsh 上游 |
| `DSH_TOKEN_FILE` | `/run/user/%U/dsh-lan-proxy.env` | token 文件（由 watcher 维护） |
| `DSH_COOKIE_TTL_MS` | `600000` | cookie 复用窗口（10 分钟） |
| `DSH_ALLOWED_REMOTE` | `""` | 逗号分隔允许的客户端 IP；空 = 全允许（**务必配置**） |

### 安全提醒

- 这个代理**不处理 HTTPS**——公网/不受信任的网段使用前请套一层 TLS 终结
  （caddy / nginx / stunnel），否则 cookie 和会话内容明文传输。
- `DSH_ALLOWED_REMOTE` **必须配置**——空字符串等于放行所有 IP。
- firewalld 是第二道防线，**强烈推荐**配合 IP 白名单一起用。
- 代理不会修改 dsh 数据，只是转发；如果局域网里有人滥用，删除其
  `DSH_ALLOWED_REMOTE` 条目即可立即断供。

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
  *.png            # 应用图标 + 托盘各状态帧
tools/
  gen-tray-assets.py  # 托盘图标生成脚本（蓝/黑/白 × 状态 × DPI）
plugins/           # DSH GUI 客户端插件备份（非桌面端代码，仅作参考/重装）
install.sh         # 一键安装脚本（后端 + 插件 + systemd + autostart）
.github/workflows/
  release.yml      # 出 AppImage / deb / rpm
extra/
  systemd/         # 用户级 systemd 单元模板（可选）
  autostart/       # XDG autostart 模板（可选）
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