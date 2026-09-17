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
const APP_CONFIG_DIR = join(os.homedir(), '.config', 'dsh-desktop')
const APP_CONFIG_FILE = join(APP_CONFIG_DIR, 'config.json')
const ICON_PATH = join(__dirname, '..', 'assets', 'icon.png')
const TRAY_ICON_PATH = join(__dirname, '..', 'assets', 'tray.png')

// 托盘皮肤：三套配色（蓝/黑/白），每套有独立的 base/done/ask/ask-faint/fail 帧。
// 蓝色为默认（文件名不带前缀，向后兼容）；其他皮肤命名 tray-<skin>-<state>.png。
// @2x 版本加 @2x 后缀。生成脚本见 tools/gen-tray-assets.py。
const VALID_SKINS = ['blue', 'black', 'white']
const DEFAULT_SKIN = 'blue'
let currentSkin = DEFAULT_SKIN

function loadSkinFromDisk() {
  try {
    const cfg = JSON.parse(readFileSync(APP_CONFIG_FILE, 'utf8'))
    if (cfg && typeof cfg.skin === 'string' && VALID_SKINS.includes(cfg.skin)) {
      currentSkin = cfg.skin
    }
  } catch (e) { /* 缺文件/格式错就用默认 */ }
}

function saveSkinToDisk() {
  try {
    mkdirSync(APP_CONFIG_DIR, { recursive: true })
    writeFileSync(APP_CONFIG_FILE, JSON.stringify({ skin: currentSkin }, null, 2))
  } catch (e) { /* 写失败不影响运行 */ }
}

/** 给定皮肤 + 状态 → 资源文件名。hiDpi=true 时返回 @2x 版本。
 *  state 名是驼峰（askFaint），文件名要转成 kebab-case（ask-faint）才能对得上素材。 */
function trayFrameName(skin, state, hiDpi) {
  const fileState = state.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
  const suf = hiDpi ? '@2x' : ''
  if (skin === 'blue' && state === 'base') return 'tray' + suf + '.png'
  if (skin === 'blue') return 'tray-' + fileState + suf + '.png'
  return 'tray-' + skin + '-' + fileState + suf + '.png'
}

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

/** 构造当前皮肤的全套托盘帧缓存（state → nativeImage）。 */
function buildTrayImages() {
  const states = ['base', 'done', 'ask', 'askFaint', 'fail']
  const out = {}
  for (const s of states) {
    // 主版本（@1x）：createFromPath 会按需自动选 @2x（macOS/某些 Linux 行为不一定；
    // 这里稳妥点两份都加载，由 Electron 自身做最终挑选）
    out[s] = loadTrayImage(trayFrameName(currentSkin, s, false))
  }
  return out
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

function probeOnce() {
  return new Promise((resolve) => {
    probe((ok) => resolve(ok))
  })
}

/** 查命令是否在 PATH。 */
function which(cmd) {
  return new Promise((resolve) => {
    execFile('which', [cmd], (err, stdout) => {
      resolve(!err && stdout.toString().trim().length > 0)
    })
  })
}

// ---------- 服务自启 / 安装阶段机 ----------
// 状态广播给错误页（src/error.html），让用户看到当前正在做什么。
// 阶段：idle → starting-systemd → starting-direct → checking-cli
//      → installing → installing-priv → waiting → ready / failed
let installState = { phase: 'idle', message: '', attempts: 0, lastError: '', manualSteps: [], startedAt: 0 }
const setInstallState = (patch) => {
  installState = { ...installState, ...patch, startedAt: installState.startedAt || Date.now() }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('dsh:install-state', installState)
  }
  notify('DSH Desktop', installState.message || installState.phase)
}

const MANUAL_INSTALL_STEPS = [
  '# 推荐：官方 npm 包',
  'npm install -g @deepseek-ai/dsh',
  '',
  '# 或 pnpm',
  'pnpm add -g @deepseek-ai/dsh',
  '',
  '# 或 yarn',
  'yarn global add @deepseek-ai/dsh',
  '',
  '# 装完手动起服务',
  'dsh web',
]

/** 阶段机入口：依次尝试 systemd → 直接启动 → 安装 → 提权安装。 */
function startOrInstall() {
  setInstallState({ phase: 'starting-systemd', message: `正在启动 ${SERVICE} 服务…` })
  execFile('systemctl', ['--user', 'start', SERVICE], (sysErr) => {
    if (!sysErr) {
      setInstallState({ phase: 'waiting', message: '等待服务就绪…' })
      return waitForServiceReady()
    }
    startOrInstall_direct()
  })
}

function startOrInstall_direct() {
  setInstallState({ phase: 'checking-cli', message: '查找 dsh 命令…' })
  which('dsh').then((found) => {
    if (found) {
      setInstallState({ phase: 'starting-direct', message: '直接启动 dsh web…' })
      const child = execFile('dsh', ['web'], { detached: true, stdio: 'ignore' })
      child.on('error', (err) => {
        setInstallState({
          phase: 'failed',
          message: 'dsh 命令已存在但启动失败',
          lastError: String(err && err.message || err),
          manualSteps: MANUAL_INSTALL_STEPS,
        })
      })
      child.unref()
      setInstallState({ phase: 'waiting', message: '等待服务就绪…' })
      return waitForServiceReady()
    }
    startOrInstall_install(false)
  })
}

function startOrInstall_install(usePriv) {
  const phase = usePriv ? 'installing-priv' : 'installing'
  const cmd = usePriv ? 'pkexec' : 'npm'
  const args = usePriv
    ? ['npm', 'install', '-g', '@deepseek-ai/dsh']
    : ['install', '-g', '@deepseek-ai/dsh']
  setInstallState({
    phase,
    message: usePriv ? '需要管理员权限，正在安装 dsh…' : '正在通过 npm 安装 dsh…',
  })

  const child = execFile(cmd, args, { env: { ...process.env, NPM_CONFIG_FUND: 'false' } })
  let stderrBuf = ''
  child.stderr.on('data', (b) => { stderrBuf += b.toString() })
  child.on('error', (err) => {
    // pkexec 不存在 / 取消授权等
    if (!usePriv) {
      // 试一次提权安装
      return startOrInstall_install(true)
    }
    setInstallState({
      phase: 'failed',
      message: '自动安装失败',
      lastError: String(err && err.message || err),
      manualSteps: MANUAL_INSTALL_STEPS,
    })
  })
  child.on('close', (code) => {
    if (code === 0) {
      setInstallState({ phase: 'starting-direct', message: '安装完成，启动服务…' })
      const web = execFile('dsh', ['web'], { detached: true, stdio: 'ignore' })
      web.unref()
      setInstallState({ phase: 'waiting', message: '等待服务就绪…' })
      return waitForServiceReady()
    }
    // npm 失败（通常是 EACCES / 权限不足）
    if (!usePriv) {
      return startOrInstall_install(true)
    }
    setInstallState({
      phase: 'failed',
      message: '自动安装失败（提权安装仍失败）',
      lastError: stderrBuf.split('\n').filter(Boolean).slice(-3).join('\n'),
      manualSteps: MANUAL_INSTALL_STEPS,
    })
  })
}

/** 周期性探测，直到服务通或超过 WAIT_TIMEOUT_MS。 */
const WAIT_TIMEOUT_MS = 60_000
const WAIT_INTERVAL_MS = 1500
function waitForServiceReady() {
  const start = Date.now()
  const tick = () => {
    probeOnce().then((ok) => {
      if (ok) {
        setInstallState({ phase: 'ready', message: '服务已就绪' })
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(GUI_URL)
        return
      }
      if (Date.now() - start >= WAIT_TIMEOUT_MS) {
        setInstallState({
          phase: 'failed',
          message: '服务启动超时',
          lastError: `${WAIT_TIMEOUT_MS / 1000}s 内未收到响应`,
          manualSteps: MANUAL_INSTALL_STEPS,
        })
        return
      }
      setTimeout(tick, WAIT_INTERVAL_MS)
    })
  }
  setTimeout(tick, WAIT_INTERVAL_MS)
}

/** 服务正在启动 / 重启 / 安装中：页面加载失败不应切到错误页，
 *  交给 waitForServiceReady 轮询恢复（避免重启瞬间误显示错误页）。 */
function serviceBusy() {
  return ['starting-systemd', 'starting-direct', 'checking-cli', 'installing', 'installing-priv', 'waiting', 'restarting'].includes(installState.phase)
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

  // 加载失败（服务没起）→ 加载本地错误页；但服务正在启动/重启中时
  // 不切错误页（交给 waitForServiceReady 轮询恢复，避免误显示）。
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return // ERR_ABORTED 忽略
    if (!mainWindow) return
    if (serviceBusy()) return
    if (installState.phase === 'idle') {
      // GUI URL 直接崩了（不是启动场景）。给错误页一个明确状态。
      setInstallState({
        phase: 'failed',
        message: '服务连接失败',
        lastError: `did-fail-load: ${desc || code}`,
        manualSteps: MANUAL_INSTALL_STEPS,
      })
    }
    mainWindow.loadFile(join(__dirname, 'error.html'))
  })

  // 先铸造认证 cookie（读取失败则跳过，回落旧行为），再探测/加载 GUI。
  installBrowserAuth(mainWindow.webContents.session)

  probe((ok) => {
    if (ok) {
      mainWindow.loadURL(GUI_URL)
    } else {
      // 阶段机：systemd → 直接启动 → 安装（必要时提权）→ 等待就绪。
      // 失败时错误页会显示手动安装步骤与失败摘要。
      startOrInstall()
      // 先把状态缓存到 mainWindow.webContents，错误页加载后即可读取
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dsh:install-state', installState)
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile(join(__dirname, 'error.html'))
      }
    }
  })
}

// ---------- 托盘 ----------
function createTray() {
  // 预载当前皮肤的全套光条帧。
  trayImages = buildTrayImages()
  tray = new Tray(trayImages.base)
  tray.setToolTip('DSH Desktop — DeepSeek Harness')

  // 切换皮肤：写盘 + 重载帧缓存 + 立刻刷新托盘图。
  function switchSkin(name) {
    if (name === currentSkin) return
    if (!VALID_SKINS.includes(name)) return
    currentSkin = name
    saveSkinToDisk()
    trayImages = buildTrayImages()
    if (tray && !tray.isDestroyed()) {
      tray.setImage(askActive ? trayImages.askFaint : trayImages.base)
    }
    rebuildTrayMenu() // 单选状态变化，重建菜单
  }

  // 菜单模板（皮肤子菜单用闭包，radio 用 type:'radio'）。
  let menu = null
  function buildMenuTemplate() {
    return [
      { label: '打开 DSH Desktop', click: showWindow },
      { label: '重启 Harness 服务', click: () => {
          notify('DSH Desktop', '正在重启 Harness 服务…')
          // 置为 restarting：did-fail-load 期间不会切错误页，交给轮询恢复。
          installState = { phase: 'restarting', message: '正在重启服务…', attempts: 0, lastError: '', manualSteps: [], startedAt: 0 }
          execFile('systemctl', ['--user', 'restart', SERVICE], () => {
            setInstallState({ phase: 'waiting', message: '等待服务就绪…' })
            waitForServiceReady()
            installBrowserAuth(mainWindow && mainWindow.webContents.session)
          })
        } },
      { type: 'separator' },
      { label: '图标皮肤', submenu: VALID_SKINS.map((skin) => ({
        label: skinLabel(skin),
        type: 'radio',
        checked: currentSkin === skin,
        click: () => switchSkin(skin),
      })) },
      { type: 'separator' },
      { label: '开机自启', type: 'checkbox', checked: isAutostartEnabled(), click: (item) => setAutostart(item.checked) },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit() } },
    ]
  }
  function rebuildTrayMenu() {
    if (!tray || tray.isDestroyed()) return
    menu = Menu.buildFromTemplate(buildMenuTemplate())
    tray.setContextMenu(menu)
  }
  rebuildTrayMenu()
  tray.on('click', showWindow)
}

/** 皮肤显示名（中英混排避免纯中文菜单的 IME 切换问题）。 */
function skinLabel(skin) {
  return ({ blue: '蓝色（默认）', black: '黑色', white: '白色' })[skin] || skin
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
// 错误页订阅安装/启动阶段；state 是 main 当前快照
ipcMain.handle('dsh:install-state', () => installState)
// 错误页"重试"按钮：先探测；服务其实已通就直接加载 GUI，
// 否则走一遍完整阶段机（systemd → 直接启动 → 安装 → 提权）。
ipcMain.handle('dsh:retry-start', () => {
  installState = { phase: 'idle', message: '', attempts: 0, lastError: '', manualSteps: [], startedAt: 0 }
  probeOnce().then((ok) => {
    if (ok) {
      setInstallState({ phase: 'ready', message: '服务已就绪' })
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(GUI_URL)
    } else {
      startOrInstall()
    }
  })
  return true
})
// 任务状态信号：Web GUI 检测到完成/提问/失败时驱动托盘光条。
ipcMain.on('dsh:signal', (_e, kind) => {
  if (typeof kind === 'string') traySignal(kind)
})

// ---------- 生命周期 ----------
// 启动前先读用户配置（皮肤等），让 createTray() 直接用对的资源。
loadSkinFromDisk()

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
