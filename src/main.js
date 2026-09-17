'use strict'
/**
 * DSH Desktop — DeepSeek Harness Linux 桌面端主进程
 *
 * 功能：
 *  - 独立无边框窗口加载 DSH Web GUI（http://127.0.0.1:3080）
 *  - 托盘图标：显示/隐藏窗口、重启 Harness、退出
 *  - 开机自启（XDG autostart）
 *  - 服务未运行/失联时系统通知 + 引导
 *  - 安全：contextIsolation + sandbox + 窄 preload 桥
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, session } = require('electron')
const { execFile } = require('node:child_process')
const { createHash, createHmac } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')
const http = require('node:http')

const GUI_URL = process.env.DSH_DESKTOP_URL || 'http://127.0.0.1:3080'
const SERVICE = process.env.DSH_DESKTOP_SERVICE || 'dsh-web'
const AUTOSTART_DIR = join(os.homedir(), '.config', 'autostart')
const AUTOSTART_FILE = join(AUTOSTART_DIR, 'dsh-desktop.desktop')
const ICON_PATH = join(__dirname, '..', 'assets', 'icon.png')
const TRAY_ICON_PATH = join(__dirname, '..', 'assets', 'tray.png')

// ---------- 浏览器会话认证 ----------
// Web 服务每次启动会生成随机启动 token（http://127.0.0.1:3080/?token=…），
// 桌面端无法读取；但持久 cookie 用 ~/.dsh/.credentials.yaml 里的
// client-connection/browser-session 密钥做 HMAC-SHA256 签名，桌面端可自行
// 铸造同款 cookie 完成认证（与服务端算法一致：base64url 解码后的 32 字节
// 作为 HMAC 密钥，cookie 名为 dsh-auth-<sha256(authority)>）。
//
// 注意：`js-yaml` 必须作为本项目的运行时依赖安装，否则 credentials 文件
// 无法解析，installBrowserAuth 会静默失败（降级为仅依赖 system 服务探测）。
let load
try { ({ load } = require('js-yaml')) }
catch { load = undefined }
const CREDENTIALS_FILE = join(os.homedir(), '.dsh', '.credentials.yaml')
const AUTH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** 读取 browser-session 签名密钥（base64url 解码后的 32 字节）；失败返回 undefined。 */
function browserAuthSecret() {
  if (typeof load !== 'function') return undefined
  try {
    const doc = load(readFileSync(CREDENTIALS_FILE, 'utf8'))
    const record = doc?.records?.['client-connection/browser-session']
    if (record?.kind !== 'grant' || record?.payload?.version !== 1) return undefined
    const decoded = Buffer.from(String(record.payload.secret), 'base64url')
    return decoded.byteLength === 32 ? decoded : undefined
  } catch (e) {
    return undefined
  }
}

/** 铸造与服务端浏览器会话同构的认证 cookie（cookie 名 + v1 载荷 + HMAC 签名）。 */
function mintBrowserCookie(secret, authority) {
  const b64 = (b) => Buffer.from(b).toString('base64url')
  const payload = {
    version: 1,
    authority,
    issuedAt: Date.now(),
    expiresAt: Date.now() + AUTH_COOKIE_MAX_AGE_MS,
  }
  const body = b64(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = b64(createHmac('sha256', secret).update(body).digest())
  return {
    name: 'dsh-auth-' + b64(createHash('sha256').update(authority).digest()),
    value: `v1.${body}.${signature}`,
  }
}

/** 在目标 session 里写入认证 cookie；读取不到密钥时静默跳过（维持旧行为）。 */
async function installBrowserAuth(ses) {
  const secret = browserAuthSecret()
  if (secret === undefined) return
  try {
    const authority = new URL(GUI_URL).host
    const cookie = mintBrowserCookie(secret, authority)
    await ses.cookies.set({
      url: GUI_URL,
      name: cookie.name,
      value: cookie.value,
      httpOnly: true,
      path: '/',
    })
  } catch (e) { /* 保持可启动，认证失败时回落旧流程 */ }
}

// 托盘“信号光条”帧：Web GUI 通过 dsh:signal 驱动（完成=绿 / 提问=黄 / 失败=红）。
const TRAY_FRAMES = {
  base: 'tray.png',
  done: 'tray-done.png',
  ask: 'tray-ask.png',
  askFaint: 'tray-ask-faint.png',
  fail: 'tray-fail.png',
}

let mainWindow = null
let tray = null
let isQuitting = false

// 托盘光条动画状态：askActive 表示“正有会话在等待用户”，暂态闪烁结束后据此
// 落到常驻的弱黄条（提问）或原图标（其他）。设计克制：短促闪烁 3 下后停。
const TRAY_BLINK_MS = 320
const TRAY_BLINK_STEPS = 5 // on off on off on
let trayFlashTimer = null
let askActive = false
let trayImages = null

/** 加载一个托盘帧；缺文件时回退到基础图标（坏安装不崩）。 */
function loadTrayImage(name) {
  const path = join(__dirname, '..', 'assets', name)
  try {
    const img = nativeImage.createFromPath(path)
    if (!img.isEmpty()) return img
  } catch (e) { /* fall through */ }
  return nativeImage.createFromPath(TRAY_ICON_PATH)
}

/** 闪烁结束后应停留的帧：提问常驻弱黄条，否则基础图标。 */
function settleTrayImage() {
  return askActive ? trayImages.askFaint : trayImages.base
}

/** 短促闪烁：亮/灭交替 TRAY_BLINK_STEPS 次，结束后落到 settle 帧。 */
function blinkTray(onImage) {
  if (flashTimerActive()) clearFlashTimer()
  let step = 0
  tray.setImage(onImage)
  trayFlashTimer = setInterval(() => {
    step++
    if (step >= TRAY_BLINK_STEPS) {
      clearFlashTimer()
      tray.setImage(settleTrayImage())
      return
    }
    tray.setImage(step % 2 === 0 ? onImage : trayImages.base)
  }, TRAY_BLINK_MS)
}

function flashTimerActive() {
  return trayFlashTimer !== null
}

function clearFlashTimer() {
  if (trayFlashTimer !== null) {
    clearInterval(trayFlashTimer)
    trayFlashTimer = null
  }
}

/**
 * Web GUI 任务状态信号 → 托盘光条。
 * @param {string} kind - 'done' | 'ask' | 'fail' | 'clear'
 */
function traySignal(kind) {
  if (!tray || trayImages === null) return
  switch (kind) {
    case 'ask':
      askActive = true
      blinkTray(trayImages.ask)
      break
    case 'clear':
      askActive = false
      clearFlashTimer()
      tray.setImage(trayImages.base)
      break
    case 'done':
      blinkTray(trayImages.done)
      break
    case 'fail':
      blinkTray(trayImages.fail)
      break
    default:
      break
  }
}

// ---------- 工具 ----------
function probe(cb) {
  const req = http.get(GUI_URL, { timeout: 1500 }, (res) => {
    res.resume()
    cb(res.statusCode >= 200 && res.statusCode < 500)
  })
  req.on('error', () => cb(false))
  req.on('timeout', () => { req.destroy(); cb(false) })
}

function startService() {
  // 1) 优先复用 systemd 用户单元（推荐：随登录自启 + 失败重启）
  execFile('systemctl', ['--user', 'start', SERVICE], (err) => {
    if (!err) return
    // 2) 兜底：直接在 PATH 里找 `dsh` 起一个 detached 进程。
    //    单元缺失或 systemctl 不可用时（例如非 systemd 发行版）的备用方案。
    try {
      const child = execFile('dsh', ['web'], { detached: true, stdio: 'ignore' })
      child.unref()
    } catch (e) {
      notify('DSH Desktop', `未能启动 ${SERVICE} 服务：${err.message || err}`)
    }
  })
}

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: ICON_PATH }).show()
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    icon: ICON_PATH,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  mainWindow.once('ready-to-show', () => { mainWindow.show() })
  mainWindow.on('close', (e) => {
    // 关窗 = 最小化到托盘，除非正在退出
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(GUI_URL)) return
    e.preventDefault()
    if (url.startsWith('http')) shell.openExternal(url)
  })

  // 加载失败（服务没起）→ 加载本地错误页
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return // ERR_ABORTED 忽略
    if (!mainWindow) return
    mainWindow.loadFile(join(__dirname, 'error.html'))
  })

  // 先铸造认证 cookie（读取失败则跳过，回落旧行为），再探测/加载 GUI。
  installBrowserAuth(mainWindow.webContents.session)

  probe((ok) => {
    if (ok) {
      mainWindow.loadURL(GUI_URL)
    } else {
      startService()
      // 等就绪，最多 25 秒
      let tries = 0
      const timer = setInterval(() => {
        tries++
        probe((ok2) => {
          if (ok2) {
            clearInterval(timer)
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(GUI_URL)
          } else if (tries >= 25) {
            clearInterval(timer)
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadFile(join(__dirname, 'error.html'))
            }
          }
        })
      }, 1000)
    }
  })
}

// ---------- 托盘 ----------
function createTray() {
  // 预载全部光条帧（@2x 由 nativeImage 按 DPI 自动选择），坏帧回退基础图标。
  trayImages = {
    base: loadTrayImage(TRAY_FRAMES.base),
    done: loadTrayImage(TRAY_FRAMES.done),
    ask: loadTrayImage(TRAY_FRAMES.ask),
    askFaint: loadTrayImage(TRAY_FRAMES.askFaint),
    fail: loadTrayImage(TRAY_FRAMES.fail),
  }
  tray = new Tray(trayImages.base)
  tray.setToolTip('DSH Desktop — DeepSeek Harness')
  const menu = Menu.buildFromTemplate([
    { label: '打开 DSH Desktop', click: showWindow },
    { label: '重启 Harness 服务', click: () => {
        execFile('systemctl', ['--user', 'restart', SERVICE], () => {
          notify('DSH Desktop', '正在重启 Harness 服务…')
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              installBrowserAuth(mainWindow.webContents.session)
              mainWindow.loadURL(GUI_URL)
            }
          }, 1500)
        })
      } },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: isAutostartEnabled(), click: (item) => setAutostart(item.checked) },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.on('click', showWindow)
}

// ---------- 开机自启 ----------
function isAutostartEnabled() {
  return existsSync(AUTOSTART_FILE)
}

function setAutostart(enabled) {
  try {
    if (enabled) {
      mkdirSync(AUTOSTART_DIR, { recursive: true })
      const desktop = process.argv[1] || app.getPath('exe')
      writeFileSync(AUTOSTART_FILE, `[Desktop Entry]
Type=Application
Name=DSH Desktop
Comment=DeepSeek Harness Desktop
Exec=${desktop} --hidden
X-GNOME-Autostart-enabled=true
X-KDE-autostart-after=panel
X-KDE-autostart-phase=1
`)
    } else if (existsSync(AUTOSTART_FILE)) {
      writeFileSync(AUTOSTART_FILE, '')
    }
  } catch (e) {
    notify('DSH Desktop', `开机自启设置失败: ${e.message}`)
  }
}

// ---------- IPC ----------
ipcMain.handle('dsh:version', () => app.getVersion())
ipcMain.handle('dsh:open-external', (_e, url) => {
  if (typeof url === 'string' && url.startsWith('http')) shell.openExternal(url)
})
// 任务状态信号：Web GUI 检测到完成/提问/失败时驱动托盘光条。
ipcMain.on('dsh:signal', (_e, kind) => {
  if (typeof kind === 'string') traySignal(kind)
})

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(() => {
    createTray()
    createWindow()
    app.on('activate', () => showWindow())
  })
  app.on('window-all-closed', () => { /* 保持托盘常驻，不退出 */ })
  app.on('before-quit', () => { isQuitting = true })
}
