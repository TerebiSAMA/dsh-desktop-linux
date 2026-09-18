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
const { createHash, createHmac, randomUUID } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const fs = require('node:fs')
const { dirname, join } = require('node:path')
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

// 托盘光条状态：askActive 表示“正有会话在等待用户”；pulseTimer 是运行中
// 的绿色呼吸动画（鲸鱼下方的绿条淡入淡出）。设计：常驻底部灯槽（base 灰条），
// 运行中绿条呼吸，完成绿闪，提问黄条常驻，失败红条常驻（failHeld）。
const TRAY_BLINK_MS = 350
const TRAY_BLINK_STEPS = 5 // on off on off on
const TRAY_PULSE_MS = 16 // 60fps：呼吸帧间隔（pulse1..60 循环 ≈ 1.0s 周期）
let trayFlashTimer = null
let trayPulseTimer = null
let askActive = false
let failHeld = false
let trayImages = null
let stopSessionPolling = null

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
  const states = ['base', 'done', 'ask', 'askFaint', 'fail', ].concat(Array.from({ length: 60 }, (_, i) => 'pulse' + (i + 1)))
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

// ---------- 运行中绿色呼吸 ----------
function startPulse() {
  if (trayPulseTimer !== null) return
  let i = 0
  const frames = Array.from({ length: 60 }, (_, i) => trayImages['pulse' + (i + 1)])
  const step = () => {
    if (!tray || trayPulseTimer === null) return
    tray.setImage(frames[i % frames.length])
    i++
  }
  step()
  trayPulseTimer = setInterval(step, TRAY_PULSE_MS)
}

function stopPulse() {
  if (trayPulseTimer !== null) {
    clearInterval(trayPulseTimer)
    trayPulseTimer = null
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
      failHeld = false
      blinkTray(trayImages.ask)
      break
    case 'clear':
      askActive = false
      failHeld = false
      clearFlashTimer()
      tray.setImage(trayImages.base)
      break
    case 'done':
      failHeld = false
      blinkTray(trayImages.done)
      break
    case 'fail':
      failHeld = true
      clearFlashTimer()
      tray.setImage(trayImages.fail) // 红条常驻
      break
    default:
      break
  }
}

// ---------- 会话状态轮询（驱动呼吸灯） ----------
// Web GUI 本身不通知桌面端（官方 DesktopSignal 只在部分构建里接线），
// 所以桌面端主动轮询 /api/session/list（RPC over POST + 自造认证 cookie），
// 检测：是否有会话在运行（绿条呼吸）、是否在等用户（黄条）、运行→结束（绿闪）。
const SESSION_POLL_MS = 2000

/** 发起一个 gateway RPC 调用；服务不可达/无密钥返回 null。
 *  opts.skipRequest=true 时不注入通用 _request 参数（部分端点不接受）。 */
function rpcCall(method, args, opts) {
  return new Promise((resolve) => {
    const secret = browserAuthSecret()
    if (secret === undefined || typeof load !== 'function') return resolve(null)
    const cookie = mintBrowserCookie(secret, new URL(GUI_URL).host)
    const merged = (opts && opts.skipRequest) ? (args || {}) : Object.assign({ _request: {} }, args || {})
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload: { args: merged },
    })
    const req = http.request(new URL(GUI_URL + '/api/' + method), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `${cookie.name}=${cookie.value}`,
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(4000, () => { req.destroy(); resolve(null) })
    req.write(body)
    req.end()
  })
}

/** 从会话列表提取驱动灯条的摘要：{byId, runningIds, ask, current}。失败返回 null。 */
async function fetchSessionState() {
  const resp = await rpcCall('session/list', {})
  if (resp === null || resp.result?.ok !== true) return null
  const items = resp.result.value?.items || []
  const runningIds = new Set()
  const byId = new Map()
  for (const i of items) {
    byId.set(i.sessionId, { asOfSeq: i.projections?.asOfSeq || 0 })
    if (i.running === true) runningIds.add(i.sessionId)
  }
  // 当前会话：运行中的优先，否则最近更新的那个
  let current = null
  for (const i of items) if (i.running === true) { current = i; break }
  if (current === null) {
    for (const i of items) if (current === null || i.updatedAt > current.updatedAt) current = i
  }
  const vals = current?.projections?.values || {}
  const cp = vals.contextPressure
  const ss = vals.sessionStats || {}
  const decodeMs = ss.decodeMs || 0
  const decodeTokens = ss.decodeTokens || 0
  return {
    byId,
    runningIds,
    running: runningIds.size,
    ask: items.some((i) => i.pendingInteraction !== undefined),
    current: {
      title: vals.title || '未命名会话',
      turns: ss.turns || 0,
      steps: ss.steps || 0,
      contextPct: cp && cp.contextWindow ? Math.round(((cp.projectedTokens || 0) * 100) / cp.contextWindow) : 0,
      outputTokens: vals.tokenUsage?.outputTokens || 0,
      speedTps: decodeMs > 0 ? Math.round((decodeTokens * 1000) / decodeMs) : 0,
    },
  }
}

/** 友好 token 单位：326335 → "326K"，1200000 → "1.2M"。 */
function fmtTokens(n) {
  if (!n) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'K'
  return String(n)
}

/** 更新托盘悬停提示：两行（状态行 + 指标行）。 */
function updateTrayTooltip(st, mode) {
  if (!tray) return
  const c = st.current
  let line1, line2
  if (mode === 'running') {
    line1 = `▶ 运行中 · 回合 ${c.turns} · 步骤 ${c.steps}`
    line2 = `输出速度 ${c.speedTps}/s · 上下文 ${c.contextPct}% · 输出 ${fmtTokens(c.outputTokens)}`
  } else if (mode === 'ask') {
    line1 = `⏸ 等待你的输入`
    line2 = `回合 ${c.turns} · 上下文 ${c.contextPct}% · 输出 ${fmtTokens(c.outputTokens)}`
  } else if (mode === 'fail') {
    line1 = `✕ 最近一次任务失败`
    line2 = `回合 ${c.turns} · 上下文 ${c.contextPct}% · 输出 ${fmtTokens(c.outputTokens)}`
  } else {
    line1 = `○ 空闲`
    line2 = `最近会话 · 回合 ${c.turns} · 输出 ${fmtTokens(c.outputTokens)}`
  }
  tray.setToolTip(`${c.title}\n${line1}\n${line2}`)
}

/** 查一个刚结束的会话：最后一个 turn 的结束原因（'error' | 'completed' | 'aborted' | 'unknown'）。 */
async function fetchLastTurnReason(sessionId, asOfSeq) {
  const resp = await rpcCall('session/page', {
    request: {
      address: { kind: 'session', sessionId },
      throughSeq: asOfSeq || 0,
      maxMessages: 120,
    },
  }, { skipRequest: true })
  if (resp === null || resp.result?.ok !== true) return 'unknown'
  const records = resp.result.value?.records || []
  // 从新到旧找最后一个 turn/end，取结束原因
  for (let i = records.length - 1; i >= 0; i--) {
    const ev = records[i]?.event
    if (ev?.type !== 'turn/end') continue
    const reason = ev.data?.reason
    if (reason && typeof reason.kind === 'string') return reason.kind
    return 'unknown'
  }
  return 'unknown'
}

// 轮询状态机的历史值
const sessionPoll = { init: false, runningIds: new Set(), asOfSeqOf: new Map(), ask: false }

/**
 * 每轮轮询根据边沿驱动托盘：
 *  - 新出现等待用户的会话 → 黄条闪烁后常驻弱黄
 *  - 从无运行到有运行 → 绿条呼吸
 *  - 从运行到结束 → 失败：红条常驻（直到下次任务/输入）；否则绿闪后回落
 *  - 空闲 → 灰条常驻
 */
async function sessionPollTick() {
  if (!tray || trayImages === null) return
  const st = await fetchSessionState()
  if (st === null) return // 服务不可达：保持当前显示，等下轮

  const nowAsk = st.ask
  const nowRunning = st.running > 0

  if (!sessionPoll.init) {
    sessionPoll.init = true
    sessionPoll.runningIds = new Set(st.runningIds)
    sessionPoll.ask = nowAsk
    if (nowAsk) { askActive = true; failHeld = false; tray.setImage(trayImages.askFaint); updateTrayTooltip(st, 'ask') }
    else if (nowRunning) { failHeld = false; startPulse(); updateTrayTooltip(st, 'running') }
    else { tray.setImage(trayImages.base); updateTrayTooltip(st, 'idle') }
    return
  }

  const wasAsk = sessionPoll.ask
  const wasRunning = sessionPoll.runningIds.size > 0

  // 提问边沿（黄条优先：任何活动都会清除失败常驻）
  if (nowAsk && !wasAsk) {
    askActive = true
    failHeld = false
    stopPulse()
    blinkTray(trayImages.ask)
  } else if (!nowAsk && wasAsk) {
    askActive = false
    clearFlashTimer()
    stopPulse()
    if (nowRunning) startPulse()
    else if (failHeld) tray.setImage(trayImages.fail)
    else tray.setImage(trayImages.base)
  }

  // 运行边沿
  if (!nowAsk) {
    if (nowRunning && !wasRunning) {
      failHeld = false
      startPulse()
    } else if (!nowRunning && wasRunning) {
      stopPulse()
      // 有会话刚结束：查最后一个 turn 是否失败 → 红条常驻，否则绿闪
      let reason = 'completed'
      for (const id of sessionPoll.runningIds) {
        if (!st.runningIds.has(id)) {
          const seq = st.byId.get(id)?.asOfSeq ?? sessionPoll.asOfSeqOf.get(id) ?? 0
          const r = await fetchLastTurnReason(id, seq)
          if (r === 'error') reason = 'error'
          break // 只需判一个刚结束的会话
        }
      }
      if (reason === 'error') {
        failHeld = true
        tray.setImage(trayImages.fail) // 红条常驻，直到下次活动
      } else {
        blinkTray(trayImages.done)
      }
    } else if (!nowRunning && !wasRunning) {
      // 空闲：保持失败红条，否则灰条
      if (!failHeld) tray.setImage(trayImages.base)
    }
  }

  sessionPoll.runningIds = new Set(st.runningIds)
  sessionPoll.asOfSeqOf = new Map(st.byId)
  sessionPoll.ask = nowAsk

  // 更新悬停提示（黄 > 红 > 绿呼吸 > 灰）
  if (nowAsk) updateTrayTooltip(st, 'ask')
  else if (failHeld) updateTrayTooltip(st, 'fail')
  else if (st.runningIds.size > 0) updateTrayTooltip(st, 'running')
  else updateTrayTooltip(st, 'idle')
}

/** 启动轮询；返回停止函数。 */
function startSessionPolling() {
  const timer = setInterval(() => { sessionPollTick() }, SESSION_POLL_MS)
  sessionPollTick() // 立即跑第一轮（含首次 sync）
  return () => clearInterval(timer)
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
    stopPulse()
    clearFlashTimer()
    trayImages = buildTrayImages()
    if (tray && !tray.isDestroyed()) {
      tray.setImage(askActive ? trayImages.askFaint : failHeld ? trayImages.fail : trayImages.base)
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
  // 单击托盘：显示窗口并切到运行中的会话（GUI 用内存路由，无法用 URL 跳转，
  // 只能通过 DOM 点击会话行——运行中会话行带 [data-state="ongoing"] 标记）
  tray.on('click', () => {
    showWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`
        (() => {
          const rows = Array.from(document.querySelectorAll('[class*="sessionRow"]'));
          const running = rows.find(r => r.querySelector('[data-state="ongoing"]'));
          const target = running || rows[0];
          if (target) target.click();
          return !!target;
        })()
      `).catch(() => {})
    }
  })
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

// ---------- LAN 代理白名单读写 ----------
// 文件路径：~/.dsh/profiles/web/dsh-lan-proxy-allow.txt（用户/插件可写位置）
// 格式：每行一个 IP，# 开头为注释，空行忽略
const LAN_ALLOW_FILE = join(os.homedir(), '.dsh', 'profiles', 'web', 'dsh-lan-proxy-allow.txt')

// IP 兜底校验：每行清洗后必须是合法 IPv4 / IPv6，否则整体拒绝写入。
// 前端已经做过校验，这里是最后一道防线（避免恶意 GUI 写入任意内容）。
function sanitizeAllowlist(raw) {
  const lines = String(raw || '').split('\n')
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/
  const ipv6 = /^[0-9a-fA-F:]+$/
  const out = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) { out.push(trimmed); continue }
    // IPv4（可选 CIDR）
    const m4 = trimmed.match(ipv4)
    if (m4) {
      const octets = [m4[1], m4[2], m4[3], m4[4]].map(Number)
      if (octets.every((n) => n >= 0 && n <= 255)) { out.push(trimmed); continue }
    }
    // IPv6（粗略）
    if (trimmed.includes(':') && ipv6.test(trimmed) && trimmed.length <= 64) {
      out.push(trimmed); continue
    }
    // 不合法：直接拒绝
    throw new Error(`非法条目: ${trimmed}`)
  }
  return out.join('\n')
}

ipcMain.handle('dsh:lan-allowlist-read', async () => {
  try {
    const content = await fs.promises.readFile(LAN_ALLOW_FILE, 'utf8')
    return { ok: true, content, path: LAN_ALLOW_FILE }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, content: '', path: LAN_ALLOW_FILE }
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('dsh:lan-allowlist-write', async (_e, payload) => {
  try {
    const content = sanitizeAllowlist(payload?.content)
    await fs.promises.mkdir(dirname(LAN_ALLOW_FILE), { recursive: true })
    await fs.promises.writeFile(LAN_ALLOW_FILE, content, { mode: 0o644 })
    return { ok: true, path: LAN_ALLOW_FILE }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('dsh:lan-proxy-restart', async () => {
  // 通过 systemd --user 重启代理；代理每 2s 也会自己 watch 文件，
  // 即便用户跳过这一步，最终也会生效（最多 2s 延迟）。
  return new Promise((resolve) => {
    execFile('systemctl', ['--user', 'restart', 'dsh-lan-proxy.service'], (err, _stdout, stderr) => {
      if (err) resolve({ ok: false, error: stderr || err.message })
      else resolve({ ok: true })
    })
  })
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
    // 轮询会话状态驱动托盘呼吸灯（服务不可达时自动静默，等 ready 后再恢复）
    stopSessionPolling = startSessionPolling()
    app.on('activate', () => showWindow())
  })
  app.on('window-all-closed', () => { /* 保持托盘常驻，不退出 */ })
  app.on('before-quit', () => { isQuitting = true })
}
