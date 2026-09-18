'use strict'
/**
 * 窄 preload 桥：只暴露白名单能力，网页侧拿不到 Node 权限。
 * 输入验证: 所有传给主进程的参数都做白名单校验,防止恶意网页注入
 */
const { contextBridge, ipcRenderer } = require('electron')

// 任务状态信号: 只允许这几个白名单值
const VALID_SIGNALS = new Set(['done', 'ask', 'fail', 'clear'])

// URL 校验: 只允许 http(s) 且必须是 GUI_URL 同源
const TRUSTED_HOSTS = new Set(['127.0.0.1', 'localhost'])
function sanitizeUrl(url) {
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!TRUSTED_HOSTS.has(u.hostname)) return null
    return u.toString()
  } catch { return null }
}

contextBridge.exposeInMainWorld('dshDesktop', {
  version: () => ipcRenderer.invoke('dsh:version'),
  openExternal: (url) => {
    const safe = sanitizeUrl(url)
    if (safe) ipcRenderer.invoke('dsh:open-external', safe)
  },
  // 任务状态信号(Web GUI → 托盘光条):'done' | 'ask' | 'fail' | 'clear'
  signal: (kind) => {
    if (VALID_SIGNALS.has(kind)) {
      ipcRenderer.send('dsh:signal', kind)
    }
  },
  // 错误页订阅：安装/启动阶段机状态
  getInstallState: () => ipcRenderer.invoke('dsh:install-state'),
  onInstallState: (cb) => {
    const listener = (_e, state) => { if (cb) cb(state) }
    ipcRenderer.on('dsh:install-state', listener)
    return () => ipcRenderer.removeListener('dsh:install-state', listener)
  },
  // 错误页"重试"
  retryStart: () => ipcRenderer.invoke('dsh:retry-start'),

  // ----- LAN 代理白名单（设置页"插件商店下方"分区用）-----
  // 读 / 写 ~/.dsh/profiles/web/dsh-lan-proxy-allow.txt
  // read 返回 { ok, content } 或 { ok:false, error }
  // write 接收 { content: string }，content 已在前端做 IP 校验；后端再做一道兜底
  lanAllowlist: {
    read: () => ipcRenderer.invoke('dsh:lan-allowlist-read'),
    write: (payload) => {
      // 兜底校验：必须是对象、content 是字符串、长度 ≤ 64 KB
      if (!payload || typeof payload !== 'object') return
      const content = String(payload.content || '')
      if (content.length > 64 * 1024) return
      ipcRenderer.invoke('dsh:lan-allowlist-write', { content })
    },
  },
  // 让 dsh-lan-proxy.service 重新读白名单（systemctl --user restart）
  restartLanProxy: () => ipcRenderer.invoke('dsh:lan-proxy-restart'),
})
