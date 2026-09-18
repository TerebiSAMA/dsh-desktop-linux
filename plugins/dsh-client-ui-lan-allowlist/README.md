# dsh-client-ui-lan-allowlist

DSH GUI 设置页"插件商店下方"加一个 **LAN 访问 IP 白名单编辑器**，让用户
直接在 GUI 里管理 `dsh-lan-proxy` 的 IP 白名单（无需手改文件 / 重启服务）。

## 它做什么

打开 DSH GUI 的设置对话框 → 在右侧内容区**最末尾**会出现一个 "LAN 访问 —
IP 白名单" 分区（用 `MutationObserver` 注入，不依赖设置页内部结构）。

分区包含：

- **文本框**：每行一个 IP（IPv4 / IPv6 / CIDR 都行），`#` 开头是注释
- **保存按钮**：写入 `~/.dsh/profiles/web/dsh-lan-proxy-allow.txt`
- **重新加载按钮**：从磁盘重读白名单
- **重启代理按钮**：调 `systemctl --user restart dsh-lan-proxy.service` 立即生效
- **状态行**：显示当前条目数 / 错误
- **路径提示**：显示白名单文件实际位置

**保存后不需要重启**：代理（`tools/dsh-lan-proxy.js`）用 `fs.watchFile`
每 2 秒检测这个文件，自动 reload 白名单。

## 工作原理

```
GUI textarea
   ↓ dshDesktop.lanAllowlist.write({ content })
Electron preload IPC
   ↓ ipcRenderer.invoke('dsh:lan-allowlist-write')
Electron main process
   ↓ fs.writeFile('~/.dsh/profiles/web/dsh-lan-proxy-allow.txt')
dsh-lan-proxy.js (每 2s fs.watchFile 检测)
   ↓ 重读 ALLOWED_REMOTE_FILE
   ↓ remoteIpAllowed(ip) 包含新条目
```

## 安装

**前提**：桌面端 v0.2.1+ 暴露了 `dshDesktop.lanAllowlist` / `restartLanProxy`
这两个 IPC（src/preload.js）。如果桌面端版本老，IPC 调用会失败。

```bash
# 1. 复制到 DSH profile
mkdir -p ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-lan-allowlist/lib
cp package.json ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-lan-allowlist/
cp lib/*.js ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-lan-allowlist/lib/

# 2. 在 cordis.patch.yml 挂载
cat >> ~/.dsh/profiles/web/cordis.patch.yml << 'EOF'

# GUI 设置页的 LAN 访问 IP 白名单编辑器
- insert:
    - id: ui-lan-allowlist
      name: '@deepseek-ai/dsh-client-ui-lan-allowlist'
EOF
```

**3. 确认代理的 systemd unit 启用了 `DSH_ALLOW_FILE`**（默认指向
`~/.dsh/profiles/web/dsh-lan-proxy-allow.txt`，参见
`extra/systemd/dsh-lan-proxy.service`）。重启桌面端 + 代理服务。

## IP 格式

每行一条，支持：

| 类型 | 示例 |
|---|---|
| IPv4 | `192.168.x.y` |
| IPv4 CIDR | `192.168.x.0/24` |
| IPv6 | `fe80::1` |
| 注释 | `# 这是注释` |
| 空行 | （忽略） |

后端 `main.js` 的 `sanitizeAllowlist()` 做兜底校验（IPv4 0-255、IPv6 字符集），
非法条目会让保存失败并提示。

## 安全提醒

- 这个插件写的是 `~/.dsh/profiles/web/dsh-lan-proxy-allow.txt` —— **不是**
  dsh 主配置。改动后**代理**会立即重读，但 dsh 自身不受影响。
- 代理收到非法 IP（不在白名单 + 不在 loopback）会直接返回 403，且不
  转发到上游，**不会消耗 dsh 的 cookie 配额**。
- 跨字段校验（IP 格式 / CIDR 范围）由桌面端 `main.js` 的
  `sanitizeAllowlist()` 兜底，前端只做 UI 提示。
