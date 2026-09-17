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
})
