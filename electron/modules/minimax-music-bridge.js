/**
 * MiniMax 音乐网页桥。
 *
 * 聊天模型只调用 generate_music；由本模块打开 minimaxi.com/audio/music，
 * 填写歌词/风格/歌名/数量并点击生成、下载成品。不读取、不导出 Cookie。
 * 与网页聊天桥共用同一份专用 Chrome 资料。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFileSync } = require('child_process')
const net = require('net')
const { app } = require('electron')
const { chromium } = require('playwright-core')
const {
  getSharedWebBridgeProfileDir,
  listSharedWebBridgeDebugPorts,
  shouldUseWebBridgeHeadless,
  getWebBridgeAutomationLaunchFlags,
  syncWebBridgeAutomationProcess,
  applyWebBridgePageVisibility
} = require('./web-bridge-chrome-profile')
const {
  normalizeMusicGenerationInput,
  validateMusicGenerationInput
} = require('./music-generation-limits')

function stampForFile(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

const MUSIC_URL = 'https://www.minimaxi.com/audio/music'
const DEVTOOLS_CONNECT_TIMEOUT_MS = 45000
const AUTOMATION_DEBUG_PORT = 19333
const GENERATION_TIMEOUT_MS = 10 * 60 * 1000
const DUMMY_API_URL = 'http://127.0.0.1:3223/v1'

let bridgeConfig = null
let browserExecutable = ''
let bridgeBrowser = null
let bridgeContext = null
let bridgePage = null
let launchedBrowserProcess = null
let loginBrowserProcess = null
let queueTail = Promise.resolve()
let queueDepth = 0
let activeJob = false
let lastError = ''
let lastGeneratedAt = 0
let loggedIn = null

function getConfigPath() {
  return path.join(app.getPath('userData'), 'minimax-music-bridge.json')
}

function getBrowserProfileDir() {
  return getSharedWebBridgeProfileDir()
}

function getDevToolsActivePortPath() {
  return path.join(getBrowserProfileDir(), 'DevToolsActivePort')
}

function writeConfig(config) {
  const configPath = getConfigPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
}

function loadConfig() {
  if (bridgeConfig) return bridgeConfig
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'))
  } catch (_) { /* first run */ }
  bridgeConfig = {
    apiKey: typeof saved.apiKey === 'string' && saved.apiKey.length >= 24
      ? saved.apiKey
      : `lingxi-local-${crypto.randomBytes(24).toString('hex')}`,
    browserExecutable: typeof saved.browserExecutable === 'string' ? saved.browserExecutable.trim() : ''
  }
  writeConfig(bridgeConfig)
  return bridgeConfig
}

function getSuggestedModel() {
  const config = loadConfig()
  return {
    provider: 'minimax-music-web-bridge',
    modelName: 'MiniMax 音乐网页版（本地 Chrome）',
    modelId: 'minimax-music-web',
    musicModel: 'minimax-music-web',
    apiUrl: DUMMY_API_URL,
    apiKey: config.apiKey,
    useFullUrl: false,
    capabilities: {
      text: false,
      vision: false,
      imageGeneration: false,
      musicGeneration: true,
      videoGeneration: false,
      speechSynthesis: false,
      toolCalling: false
    }
  }
}

function sanitizeErrorMessage(error, fallback = '操作失败。') {
  const message = String(error?.message || error || fallback)
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .trim()
  return message.slice(0, 1200) || fallback
}

function readRegistryAppPath(executableName) {
  if (process.platform !== 'win32') return ''
  const roots = ['HKCU', 'HKLM']
  for (const root of roots) {
    try {
      const key = `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executableName}`
      const output = execFileSync('reg.exe', ['query', key, '/ve'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const match = output.match(/REG_SZ\s+(.+)$/im)
      const candidate = String(match?.[1] || '').trim().replace(/^"|"$/g, '')
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch (_) { /* next */ }
  }
  return ''
}

function getBrowserCandidates() {
  const candidates = []
  const configPath = loadConfig().browserExecutable
  if (configPath) candidates.push(configPath)
  if (process.platform === 'win32') {
    candidates.push(
      readRegistryAppPath('chrome.exe'),
      readRegistryAppPath('msedge.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    )
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium')
  }
  return [...new Set(candidates.filter(Boolean).map(candidate => path.normalize(candidate)))]
}

function findBrowserExecutable() {
  if (browserExecutable && fs.existsSync(browserExecutable)) return browserExecutable
  browserExecutable = getBrowserCandidates().find(candidate => fs.existsSync(candidate)) || ''
  return browserExecutable
}

function getBrowserName(executablePath = findBrowserExecutable()) {
  const name = path.basename(String(executablePath || '')).toLowerCase()
  if (name.includes('edge')) return 'Microsoft Edge'
  if (name.includes('chrome')) return 'Google Chrome'
  return executablePath ? path.basename(executablePath) : ''
}

function isBrowserConnected() {
  return !!bridgeBrowser && bridgeBrowser.isConnected()
}

function isChildProcessRunning(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return false
  try {
    process.kill(child.pid, 0)
    return true
  } catch (_) {
    return false
  }
}

function isLoginBrowserRunning() {
  return isChildProcessRunning(loginBrowserProcess)
}

function getStatus() {
  const loginBrowserOpen = isLoginBrowserRunning()
  const automationBrowserOpen = isBrowserConnected()
  return {
    success: true,
    running: true,
    host: '127.0.0.1',
    port: 3223,
    apiUrl: DUMMY_API_URL,
    browserOpen: loginBrowserOpen || automationBrowserOpen,
    browserVisible: loginBrowserOpen || automationBrowserOpen,
    browserMode: loginBrowserOpen ? 'login' : automationBrowserOpen ? 'automation' : 'closed',
    loginBrowserOpen,
    browserName: getBrowserName(),
    browserExecutable: findBrowserExecutable(),
    loggedIn,
    queueDepth,
    activeJob,
    activeJobType: activeJob ? 'music' : '',
    lastError,
    lastGeneratedAt
  }
}

function readDevToolsPortFromFile() {
  try {
    const lines = fs.readFileSync(getDevToolsActivePortPath(), 'utf8').trim().split(/\r?\n/)
    const port = Number(lines[0])
    return Number.isInteger(port) && port > 0 ? port : 0
  } catch (_) {
    return 0
  }
}

function isTcpPortOpen(port, timeoutMs = 400) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end()
      resolve(true)
    })
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(false))
  })
}

function isProfileInUse(profileDir) {
  const names = ['lockfile', 'Lockfile', 'SingletonLock', 'SingletonSocket']
  return names.some(name => {
    const lockPath = path.join(profileDir, name)
    if (!fs.existsSync(lockPath)) return false
    try {
      const fd = fs.openSync(lockPath, 'r+')
      fs.closeSync(fd)
      return false
    } catch (error) {
      return ['EBUSY', 'EPERM', 'EACCES', 'EAGAIN'].includes(error.code)
    }
  })
}

function listDebugEndpoints() {
  const ports = new Set(listSharedWebBridgeDebugPorts(AUTOMATION_DEBUG_PORT))
  const filePort = readDevToolsPortFromFile()
  if (filePort) ports.add(filePort)
  return [...ports].map(port => `http://127.0.0.1:${port}`)
}

function clearBrowserReferences() {
  bridgeBrowser = null
  bridgeContext = null
  bridgePage = null
  loggedIn = null
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

async function connectToExternalBrowser(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 })
  bridgeBrowser = browser
  bridgeContext = browser.contexts()[0] || null
  if (!bridgeContext) throw new Error('无法取得外部浏览器上下文。')
  bridgePage = bridgeContext.pages().find(page => /minimaxi\.com|minimax\.io/i.test(page.url()))
    || bridgeContext.pages()[0]
    || await bridgeContext.newPage()
  browser.once('disconnected', clearBrowserReferences)
  return bridgePage
}

async function tryConnectExistingBrowser() {
  if (isBrowserConnected() && bridgePage && !bridgePage.isClosed()) return bridgePage
  for (const endpoint of listDebugEndpoints()) {
    const port = Number(String(endpoint).replace(/.*:/, ''))
    if (port && !(await isTcpPortOpen(port))) continue
    try {
      return await connectToExternalBrowser(endpoint)
    } catch (_) {
      clearBrowserReferences()
    }
  }
  return null
}

async function waitForExternalBrowser(timeoutMs = DEVTOOLS_CONNECT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastConnectError = null
  while (Date.now() < deadline) {
    const page = await tryConnectExistingBrowser()
    if (page) return page
    for (const endpoint of listDebugEndpoints()) {
      try {
        return await connectToExternalBrowser(endpoint)
      } catch (error) {
        lastConnectError = error
        clearBrowserReferences()
      }
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw Object.assign(new Error(lastConnectError?.message || '启动系统浏览器超时。'), { code: 'BROWSER_START_TIMEOUT' })
}

async function closeExternalBrowser() {
  const browser = bridgeBrowser
  const child = launchedBrowserProcess
  launchedBrowserProcess = null
  clearBrowserReferences()
  if (browser?.isConnected()) {
    await withTimeout(browser.close(), 3000, '关闭浏览器超时。').catch(() => {})
  }
  if (child?.pid) {
    try { process.kill(child.pid, 'SIGKILL') } catch (_) { /* already closed */ }
  }
}

async function launchExternalBrowser(options = {}) {
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('请先在普通 Chrome 中完成 MiniMax 登录，并关闭整个专用 Chrome 窗口，然后再检查登录状态。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  const wantHeadless = shouldUseWebBridgeHeadless(options)
  const profileDir = getBrowserProfileDir()
  fs.mkdirSync(profileDir, { recursive: true })
  const existing = await tryConnectExistingBrowser()
  const sync = await syncWebBridgeAutomationProcess(profileDir, {
    ...options,
    existingPage: existing,
    closeExisting: closeExternalBrowser
  })
  if (sync.action === 'reuse') return existing

  const filePort = readDevToolsPortFromFile()
  const debugPorts = listSharedWebBridgeDebugPorts(AUTOMATION_DEBUG_PORT)
  let debugPortAlive = filePort > 0 && await isTcpPortOpen(filePort)
  for (const port of debugPorts) {
    if (debugPortAlive) break
    debugPortAlive = await isTcpPortOpen(port)
  }
  if (debugPortAlive || isProfileInUse(profileDir)) {
    try {
      return await waitForExternalBrowser(DEVTOOLS_CONNECT_TIMEOUT_MS)
    } catch (error) {
      throw Object.assign(new Error('专用 Chrome 已经打开，但软件连不上调试端口。请先关掉这个专用 Chrome 窗口，再重试。'), {
        code: 'BROWSER_START_TIMEOUT',
        cause: error
      })
    }
  }

  const executablePath = findBrowserExecutable()
  if (!executablePath) {
    throw Object.assign(new Error('没有找到系统安装的 Google Chrome 或 Microsoft Edge。'), { code: 'BROWSER_NOT_FOUND' })
  }

  const activePortPath = getDevToolsActivePortPath()
  if (filePort && !(await isTcpPortOpen(filePort))) {
    try {
      if (fs.existsSync(activePortPath)) fs.unlinkSync(activePortPath)
    } catch (_) { /* stale */ }
  }

  const args = [
    ...getWebBridgeAutomationLaunchFlags(options),
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${AUTOMATION_DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    MUSIC_URL
  ]
  const child = spawn(executablePath, args, {
    detached: true,
    windowsHide: wantHeadless,
    stdio: 'ignore'
  })
  launchedBrowserProcess = child
  child.unref()
  return waitForExternalBrowser(DEVTOOLS_CONNECT_TIMEOUT_MS)
}

async function launchNormalLoginBrowser() {
  if (activeJob) {
    throw Object.assign(new Error('当前正在生成音乐，完成后才能重新打开登录浏览器。'), { code: 'BRIDGE_BUSY' })
  }
  if (isLoginBrowserRunning()) return getStatus()
  await tryConnectExistingBrowser()
  await closeExternalBrowser()

  const executablePath = findBrowserExecutable()
  if (!executablePath) {
    throw Object.assign(new Error('没有找到系统安装的 Google Chrome 或 Microsoft Edge。'), { code: 'BROWSER_NOT_FOUND' })
  }
  const profileDir = getBrowserProfileDir()
  fs.mkdirSync(profileDir, { recursive: true })
  try {
    const activePortPath = getDevToolsActivePortPath()
    if (fs.existsSync(activePortPath)) fs.unlinkSync(activePortPath)
  } catch (_) { /* stale */ }

  const child = spawn(executablePath, [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--new-window',
    MUSIC_URL
  ], {
    detached: true,
    windowsHide: false,
    stdio: 'ignore'
  })
  loginBrowserProcess = child
  loggedIn = null
  child.once('exit', () => {
    if (loginBrowserProcess === child) loginBrowserProcess = null
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
  return getStatus()
}

async function navigateToMusic(page) {
  if (!page || page.isClosed()) throw Object.assign(new Error('外部浏览器页面已关闭。'), { code: 'BROWSER_CLOSED' })
  if (/minimaxi\.com\/audio\/music/i.test(page.url())) return
  await page.goto(MUSIC_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
}

async function showExternalPage(page, options = {}) {
  if (!page || page.isClosed()) return
  await applyWebBridgePageVisibility(page, bridgeContext, {
    forceVisible: options.forceVisible === true,
    withTimeout
  })
}

function runMiniMaxMusicPage(args = {}) {
  const action = args.action || 'inspect'
  const payload = args.payload || {}

  function compact(text) {
    return String(text || '').replace(/\s+/g, '')
  }

  function isCreatingButtonText(text) {
    return /创作中/.test(compact(text))
  }

  function isGenerateButtonText(text) {
    const value = compact(text)
    if (!value) return false
    if (/创作中/.test(value)) return false
    if (/开始创作|升级以获得|新手教程|参考音乐|生成专属翻唱/.test(value)) return false
    if (/限时免费/.test(value)) return true
    if (value === '生成') return true
    if (/生成/.test(value) && !/生成中|重新生成/.test(value) && value.length <= 16) return true
    return false
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = el.getBoundingClientRect()
    return rect.width > 2 && rect.height > 2
  }

  function clickables() {
    return [...document.querySelectorAll('button, a, div[role="button"]')].filter(visible)
  }

  function findStyleEl() {
    return [...document.querySelectorAll('textarea')].find(el => (
      /音乐风格|制作要求|曲风|情绪|速度|乐器/.test(el.getAttribute('placeholder') || '')
    )) || null
  }

  function findTitleEl() {
    return [...document.querySelectorAll('input')].find(el => (
      /歌曲名称/.test(el.getAttribute('placeholder') || '')
    )) || null
  }

  function findLyricsEl(styleEl) {
    const hinted = [...document.querySelectorAll('[contenteditable="true"], textarea')].find(el => {
      if (el === styleEl) return false
      const hint = [
        el.getAttribute('placeholder'),
        el.getAttribute('data-placeholder'),
        el.getAttribute('aria-placeholder'),
        el.getAttribute('aria-label')
      ].join(' ')
      return /歌词|歌词结构|在此添加/.test(hint)
    })
    if (hinted) return hinted
    return [...document.querySelectorAll('[contenteditable="true"]')].find(el => el !== styleEl && visible(el)) || null
  }

  function findSubmitEl() {
    const items = clickables()
    return items.find((el) => isCreatingButtonText(el.textContent || el.getAttribute('aria-label') || ''))
      || items.find((el) => isGenerateButtonText(el.textContent || el.getAttribute('aria-label') || ''))
      || null
  }

  function findGenerateEl() {
    return clickables().find(el => isGenerateButtonText(el.textContent || el.getAttribute('aria-label') || '')) || null
  }

  function findStartCreateEl() {
    return clickables().find(el => compact(el.textContent) === '开始创作') || null
  }

  function setValue(el, value) {
    if (!el) return false
    el.focus()
    if (el.isContentEditable) {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      selection.removeAllRanges()
      selection.addRange(range)
      const inserted = document.execCommand('insertText', false, value)
      if (!inserted) {
        el.textContent = value
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  function inspect() {
    const styleEl = findStyleEl()
    const lyricsEl = findLyricsEl(styleEl)
    const titleEl = findTitleEl()
    const generateEl = findSubmitEl()
    const startCreateEl = findStartCreateEl()
    const bodyText = String(document.body?.innerText || '')
    const hasLyricsLabel = /歌词/.test(bodyText) && /0\s*\/\s*3,?500/.test(bodyText)
    const generateText = generateEl ? compact(generateEl.textContent) : ''
    return {
      ready: !!(styleEl && findGenerateEl() && (lyricsEl || hasLyricsLabel)),
      hasStyleField: !!styleEl,
      hasLyricsField: !!lyricsEl,
      hasLyricsLabel,
      hasTitleField: !!titleEl,
      hasGenerate: !!findGenerateEl(),
      creating: isCreatingButtonText(generateText),
      generateText,
      hasStartCreate: !!startCreateEl,
      loginVisible: /登录|注册|Sign in|Log in/.test(bodyText.slice(0, 4000)) && !styleEl,
      captchaVisible: /滑动验证|人机验证|验证码|unusual traffic/i.test(bodyText.slice(0, 4000)),
      title: document.title,
      url: location.href
    }
  }

  if (action === 'inspect') return inspect()

  if (action === 'clickStartCreate') {
    const button = findStartCreateEl()
    if (!button) return { clicked: false }
    button.click()
    return { clicked: true }
  }

  if (action === 'clickGenerate') {
    const creating = findSubmitEl()
    if (creating && isCreatingButtonText(creating.textContent || '')) {
      return { clicked: false, creating: true, inspect: inspect() }
    }
    const button = findGenerateEl()
    if (!button) return { clicked: false, inspect: inspect() }
    button.click()
    return { clicked: true, generateText: compact(button.textContent) }
  }

  if (action !== 'fill') return inspect()

  const styleEl = findStyleEl()
  const lyricsEl = findLyricsEl(styleEl)
  const titleEl = findTitleEl()
  const result = {
    lyrics: false,
    style: false,
    title: false,
    quantity: false,
    instrumental: false
  }

  if (!payload.instrumental && payload.lyrics) result.lyrics = setValue(lyricsEl, payload.lyrics)
  if (payload.prompt) result.style = setValue(styleEl, payload.prompt)
  if (payload.title) result.title = setValue(titleEl, payload.title)

  const quantityHost = [...document.querySelectorAll('div, span, p, label')].find((el) => {
    const text = String(el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
    return /^数量/.test(text) && text.length < 24
  })
  if (quantityHost) {
    let root = quantityHost
    for (let depth = 0; depth < 6 && root; depth += 1) {
      const buttons = [...root.querySelectorAll('button')].filter((button) => {
        const text = compact(button.textContent || button.getAttribute('aria-label') || '')
        return !/限时免费|生成|升级/.test(text)
      })
      const numberEl = [...root.querySelectorAll('input, span, div')].find((el) => {
        const text = String(el.value || el.textContent || '').replace(/\u00a0/g, ' ').trim()
        return /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 8
      })
      if (buttons.length >= 2 || numberEl) {
        const minus = buttons[0]
        const plus = buttons[buttons.length - 1]
        const read = () => Number(String(numberEl?.value || numberEl?.textContent || '0').replace(/\s+/g, '').trim())
        let guard = 0
        while (read() < payload.n && plus && guard < 8) {
          plus.click()
          guard += 1
        }
        guard = 0
        while (read() > payload.n && minus && minus !== plus && guard < 8) {
          minus.click()
          guard += 1
        }
        result.quantity = true
        result.quantityValue = read()
        break
      }
      root = root.parentElement
    }
  }

  if (payload.instrumental) {
    const switchNode = [...document.querySelectorAll('button, [role="switch"], input[type="checkbox"], span, div')]
      .find(el => compact(el.textContent || el.getAttribute('aria-label') || '') === '纯音乐')
    if (switchNode) {
      const control = switchNode.closest('button, [role="switch"]') || switchNode.querySelector('button, [role="switch"], input') || switchNode
      const pressed = control.getAttribute?.('aria-checked') === 'true' || control.getAttribute?.('aria-pressed') === 'true' || control.checked === true
      if (!pressed) control.click()
      result.instrumental = true
    }
  }

  return { ...result, inspect: inspect() }
}

async function inspectPageState(page = bridgePage) {
  if (!page || page.isClosed()) {
    loggedIn = null
    return { loggedIn: null, ready: false, url: '' }
  }
  try {
    const result = await withTimeout(
      page.evaluate(runMiniMaxMusicPage, { action: 'inspect' }),
      5000,
      '读取 MiniMax 音乐页状态超时。'
    )
    loggedIn = !!result?.ready
    return { ...result, loggedIn }
  } catch (error) {
    loggedIn = null
    return { loggedIn: null, ready: false, url: page.url(), error: error.message }
  }
}

async function waitForMusicForm(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  while (Date.now() < deadline) {
    state = await inspectPageState(page)
    if (state.ready) return state
    if (state.hasStartCreate && !state.hasStyleField) {
      await page.evaluate(runMiniMaxMusicPage, { action: 'clickStartCreate' }).catch(() => {})
    }
    await new Promise(resolve => setTimeout(resolve, 800))
  }
  return state || { loggedIn: false, ready: false }
}

async function openLoginWindow() {
  const status = await launchNormalLoginBrowser()
  return {
    success: true,
    ...status,
    instruction: '请在普通 Chrome 中用 MiniMax 账号登录 https://www.minimaxi.com/audio/music 。登录成功后关闭整个专用 Chrome 窗口，再点击“登录完成后检查”。'
  }
}

async function checkLoginStatus() {
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('请先完成登录并关闭整个专用 Chrome 窗口，然后再点击检查。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  const page = await launchExternalBrowser()
  await navigateToMusic(page)
  await showExternalPage(page)
  const state = await waitForMusicForm(page, 12000)
  if (!state.ready) {
    loggedIn = false
    return {
      success: true,
      ...getStatus(),
      page: state,
      instruction: '没有检测到 MiniMax 音乐创作表单（风格输入框、歌词区和提交按钮）。当前页提交按钮文案是「限时免费」，不是「生成」。请确认浏览器停在 https://www.minimaxi.com/audio/music 且已登录。'
    }
  }
  return { success: true, ...getStatus(), page: state }
}

async function dumpMusicPageDom() {
  const page = await launchExternalBrowser()
  await navigateToMusic(page)
  await showExternalPage(page)
  const inspect = await page.evaluate(runMiniMaxMusicPage, { action: 'inspect' })
  const works = await page.evaluate(runMiniMaxWorksPage, { action: 'snapshot' })
  const dom = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, a, div[role="button"]')]
      .map(el => String(el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 40)
    const fields = [...document.querySelectorAll('textarea, input, [contenteditable="true"]')]
      .map(el => ({
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
        maxLength: el.getAttribute('maxlength') || '',
        name: el.getAttribute('name') || el.getAttribute('aria-label') || '',
        contentEditable: el.getAttribute('contenteditable') || ''
      }))
      .slice(0, 30)
    return {
      url: location.href,
      title: document.title,
      buttons,
      fields,
      bodyPreview: String(document.body?.innerText || '').slice(0, 800)
    }
  })
  return { success: true, inspect, works, dom, status: getStatus() }
}

function enqueueBridgeJob(job) {
  queueDepth += 1
  const run = queueTail.catch(() => {}).then(job)
  queueTail = run.then(() => undefined, () => undefined).finally(() => {
    queueDepth = Math.max(0, queueDepth - 1)
  })
  return run
}

async function fillMusicForm(page, prepared) {
  const filled = await page.evaluate(runMiniMaxMusicPage, {
    action: 'fill',
    payload: {
      lyrics: prepared.lyrics,
      prompt: prepared.prompt,
      title: prepared.title,
      n: prepared.n,
      instrumental: prepared.instrumental
    }
  })

  if (!filled.style) {
    throw Object.assign(new Error('没有找到 MiniMax「风格」输入框。请确认已打开 https://www.minimaxi.com/audio/music 并已登录。'), { code: 'FORM_NOT_FOUND' })
  }
  if (!prepared.instrumental && prepared.lyrics && !filled.lyrics) {
    throw Object.assign(new Error('没有找到 MiniMax「歌词」输入框。'), { code: 'FORM_NOT_FOUND' })
  }
  return filled
}

function runMiniMaxWorksPage(args = {}) {
  const action = args.action || 'snapshot'
  const wanted = Math.max(1, Number(args.wanted || 1))

  function parseRgb(value) {
    const match = String(value || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
    if (!match) return null
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
  }

  function brightness(value) {
    const rgb = parseRgb(value)
    if (!rgb) return null
    return (rgb.r + rgb.g + rgb.b) / 3
  }

  function isVisuallyDisabled(el) {
    if (!el) return true
    if (el.disabled || el.getAttribute('disabled') != null) return true
    if (el.getAttribute('aria-disabled') === 'true') return true
    if (/disabled|is-disabled|btn-disabled/i.test(String(el.className || ''))) return true
    const style = window.getComputedStyle(el)
    if (style.pointerEvents === 'none') return true
    if (Number(style.opacity) < 0.5) return true
    const nodes = [el, el.querySelector('svg'), el.querySelector('path')]
    for (const node of nodes) {
      if (!node) continue
      const nodeStyle = window.getComputedStyle(node)
      if (Number(nodeStyle.opacity) < 0.5) return true
      for (const color of [nodeStyle.color, nodeStyle.fill, nodeStyle.stroke]) {
        if (!color || color === 'none' || color === 'transparent') continue
        const level = brightness(color)
        if (level != null && level > 168) return true
      }
    }
    return false
  }

  function compact(text) {
    return String(text || '').replace(/\s+/g, '')
  }

  function isDownloadControl(el) {
    if (!el) return false
    const label = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('download'),
      el.getAttribute('href'),
      el.textContent
    ].map(value => String(value || '')).join(' ')
    if (/收藏|喜欢|播放|暂停|升级|开始创作|参考音乐|无水印|有水印/.test(label)) return false
    if (/下载|download/i.test(label)) return true
    if (el.hasAttribute('download')) return true
    if (/\.(mp3|wav|m4a|aac)(\?|$)/i.test(el.getAttribute('href') || '')) return true
    return false
  }

  function findNoWatermarkEl() {
    const nodes = [...document.querySelectorAll('button, a, li, [role="button"], [role="menuitem"], div, span')]
    const hits = nodes.filter((el) => {
      const text = compact(el.textContent || el.getAttribute('aria-label') || '')
      if (!/MP3[（(]?无水印/.test(text) && text !== '无水印') return false
      if (/有水印/.test(text)) return false
      if (text.length > 24) return false
      const rect = el.getBoundingClientRect()
      return rect.width >= 8 && rect.height >= 8
    })
    if (!hits.length) return null
    hits.sort((a, b) => compact(a.textContent).length - compact(b.textContent).length)
    const el = hits[0]
    const clickable = el.closest('button, a, li, [role="button"], [role="menuitem"]') || el
    if (/有水印/.test(compact(clickable.textContent))) return el
    return clickable
  }

  function iconButtons(card) {
    return [...card.querySelectorAll('button, a, [role="button"]')].filter((el) => {
      const rect = el.getBoundingClientRect()
      return rect.width >= 8 && rect.width <= 48 && rect.height >= 8 && rect.height <= 48
    })
  }

  function findDownloadInCard(card) {
    const labeled = [...card.querySelectorAll('button, a, [role="button"], [aria-label], [title], [download]')]
      .find(isDownloadControl)
    if (labeled) return labeled.closest('button, a, [role="button"]') || labeled
    const actions = iconButtons(card)
    if (actions.length >= 4) return actions[1]
    return null
  }

  function inspectCard(card) {
    const downloadEl = findDownloadInCard(card.el)
    const downloadReady = !!(downloadEl && !isVisuallyDisabled(downloadEl))
    return {
      ...card,
      downloadReady,
      ready: !!(card.duration && downloadReady)
    }
  }

  function listWorkCards() {
    const leaves = [...document.querySelectorAll('span, div, p, time, strong, h3, h4')].filter(el => (
      el.childElementCount === 0 && /^\d{1,2}:\d{2}$/.test(String(el.textContent || '').trim())
    ))
    const cards = []
    const seen = new Set()
    for (const leaf of leaves) {
      let node = leaf
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const lines = String(node.innerText || '').split('\n').map(line => line.trim()).filter(Boolean)
        const duration = lines.find(line => /^\d{1,2}:\d{2}$/.test(line))
        const title = lines.find(line => (
          line.length >= 1
          && line.length <= 80
          && !/^\d{1,2}:\d{2}$/.test(line)
          && !/^(作品|收藏|歌词|风格|纯音乐|数量|限时免费|开始创作|模型)$/.test(line)
          && !/整体风格|风格建议|编曲结构|人声要求|混音建议/.test(line)
        ))
        if (duration && title && node.offsetHeight > 36) {
          if (!seen.has(node)) {
            seen.add(node)
            cards.push(inspectCard({ el: node, title, duration }))
          }
          break
        }
        node = node.parentElement
      }
    }
    return cards
  }

  function snapshot() {
    const durationLeaves = [...document.querySelectorAll('span, div, p, time, strong, h3, h4')].filter(el => (
      el.childElementCount === 0 && /^\d{1,2}:\d{2}$/.test(String(el.textContent || '').trim())
    ))
    const cards = listWorkCards()
    const downloads = [...document.querySelectorAll('button, a, [role="button"], [aria-label], [title], [download]')].filter(isDownloadControl)
    const readyDownloads = downloads.filter(el => !isVisuallyDisabled(el.closest('button, a, [role="button"]') || el))
    const audios = [...document.querySelectorAll('audio, source, a[href]')]
      .map(el => el.currentSrc || el.src || el.href || '')
      .filter(src => /\.(mp3|wav|m4a|aac)(\?|$)/i.test(src) || /blob:|audio|music/i.test(src))
    const bodyText = String(document.body?.innerText || '')
    return {
      workCount: cards.length,
      readyCount: cards.filter(card => card.ready).length,
      durationCount: durationLeaves.length,
      titles: cards.map(card => card.title),
      durations: cards.map(card => card.duration),
      downloadCount: downloads.length,
      readyDownloadCount: readyDownloads.length,
      downloadLabels: downloads.map(el => String(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12),
      audioCount: audios.length,
      audios,
      generating: /生成中|正在生成|排队|合成中/.test(bodyText.slice(0, 5000)),
      captchaVisible: /滑动验证|人机验证|验证码|unusual traffic/i.test(bodyText.slice(0, 4000))
    }
  }

  if (action === 'markNewest') {
    const previous = new Set((args.previousTitles || []).filter(Boolean))
    const all = listWorkCards()
    const fresh = all.filter(card => card.title && !previous.has(card.title))
    const cards = (fresh.length ? fresh : all).slice(0, wanted)
    cards.forEach((card, index) => {
      card.el.setAttribute('data-lingxi-music-work', String(index))
    })
    return cards.map(card => ({ title: card.title, duration: card.duration }))
  }

  if (action === 'clickDownload') {
    const card = document.querySelector(`[data-lingxi-music-work="${args.index || 0}"]`)
    if (!card) return { clicked: false }
    const downloadEl = findDownloadInCard(card)
    if (!downloadEl) return { clicked: false }
    downloadEl.click()
    return { clicked: true }
  }

  if (action === 'clickNoWatermark') {
    const option = findNoWatermarkEl()
    if (!option) return { clicked: false, visible: false }
    option.click()
    return { clicked: true, visible: true, text: compact(option.textContent) }
  }

  return snapshot()
}

async function snapshotWorks(page) {
  return page.evaluate(runMiniMaxWorksPage, { action: 'snapshot' })
}

async function clickGenerate(page) {
  const clicked = await page.evaluate(runMiniMaxMusicPage, { action: 'clickGenerate' })
  if (clicked?.creating) {
    throw Object.assign(new Error('MiniMax 正在创作中，请等按钮变回「限时免费」后再试。'), { code: 'BRIDGE_BUSY' })
  }
  if (!clicked?.clicked) {
    throw Object.assign(new Error(`没有找到 MiniMax 提交按钮。当前页空闲时应显示「限时免费」。${clicked?.inspect?.generateText ? `检测到：${clicked.inspect.generateText}` : ''}`), { code: 'GENERATE_BUTTON_NOT_FOUND' })
  }
}

function onceProgress(onProgress) {
  let last = ''
  return (message) => {
    const text = String(message || '').trim()
    if (!text || text === last) return
    last = text
    if (typeof onProgress === 'function') onProgress(text)
  }
}

async function waitForCreationIdle(page, signal, onProgress) {
  const deadline = Date.now() + GENERATION_TIMEOUT_MS
  const creatingDeadline = Date.now() + 20000
  const report = onceProgress(onProgress)
  let sawCreating = false
  while (Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error('音乐生成已取消。'), { code: 'ABORTED' })
    const state = await page.evaluate(runMiniMaxMusicPage, { action: 'inspect' })
    if (state.captchaVisible) {
      throw Object.assign(new Error('MiniMax 弹出了人机验证。请打开设置里的「显示浏览器」，完成验证后重新生成。软件不会自动点击验证码。'), { code: 'CAPTCHA_REQUIRED' })
    }
    if (state.creating) {
      if (!sawCreating) report('正在创作')
      sawCreating = true
    } else if (sawCreating && state.hasGenerate) {
      report('创作完成')
      return state
    } else if (!sawCreating && Date.now() > creatingDeadline) {
      throw Object.assign(new Error('已点击提交，但没有出现「创作中」。请打开「显示浏览器」确认是否点上了限时免费按钮。'), { code: 'CREATE_NOT_STARTED' })
    }
    await new Promise(resolve => setTimeout(resolve, 800))
  }
  throw Object.assign(new Error('等待 MiniMax 创作超时（10 分钟）。按钮应从「创作中」变回「限时免费」后才会下载。'), { code: 'GENERATION_TIMEOUT' })
}

function audioExtension(nameOrUrl = '') {
  const match = String(nameOrUrl || '').match(/\.(mp3|wav|m4a|aac)(\?|$)/i)
  return match ? match[1].toLowerCase() : 'mp3'
}

async function saveDownloadEvent(download, outputDir) {
  const suggested = download.suggestedFilename() || 'music.mp3'
  const ext = audioExtension(suggested)
  const filePath = path.join(outputDir, `generated-music-${stampForFile()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  await download.saveAs(filePath)
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return filePath
  return ''
}

async function clickNoWatermarkOption(page) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const clicked = await page.evaluate(runMiniMaxWorksPage, { action: 'clickNoWatermark' })
    if (clicked?.clicked) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const option = page.getByText(/MP3\s*[（(]无水印[)）]/).first()
  if (await option.count().catch(() => 0)) {
    await option.click({ timeout: 3000 }).catch(() => {})
    return true
  }
  return false
}

async function awaitDownloadAfter(page, start) {
  const downloadWait = page.waitForEvent('download', { timeout: 20000 })
  await start()
  await new Promise(resolve => setTimeout(resolve, 250))
  await clickNoWatermarkOption(page)
  try {
    return await downloadWait
  } catch (_) {
    return ''
  }
}

async function clickCardDownload(page, index) {
  const card = page.locator(`[data-lingxi-music-work="${index}"]`).first()
  if (!(await card.count())) return ''
  await card.scrollIntoViewIfNeeded().catch(() => {})
  await card.hover({ timeout: 3000 }).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 400))
  const existing = await page.evaluate(runMiniMaxWorksPage, { action: 'clickNoWatermark' })
  if (existing?.clicked) {
    try {
      return await page.waitForEvent('download', { timeout: 20000 })
    } catch (_) { /* menu click did not start a download; open it again */ }
  }
  const fromIcon = await awaitDownloadAfter(page, () => page.evaluate(runMiniMaxWorksPage, { action: 'clickDownload', index }))
  if (fromIcon) return fromIcon
  const buttons = card.locator('button, a, [role="button"]')
  const total = await buttons.count()
  const iconIndexes = []
  for (let i = 0; i < total; i += 1) {
    const box = await buttons.nth(i).boundingBox().catch(() => null)
    if (box && box.width <= 48 && box.height <= 48) iconIndexes.push(i)
  }
  const downloadIndex = iconIndexes.length >= 4 ? iconIndexes[1] : iconIndexes[0]
  if (downloadIndex == null) return ''
  return awaitDownloadAfter(page, () => buttons.nth(downloadIndex).click({ timeout: 5000 }))
}

async function downloadGeneratedFiles(page, baseline, wanted, outputDir, capturedAudio = []) {
  fs.mkdirSync(outputDir, { recursive: true })
  const saved = []
  const previousTitles = baseline.titles || []
  await page.evaluate(runMiniMaxWorksPage, { action: 'markNewest', wanted, previousTitles })
  for (let index = 0; index < wanted; index += 1) {
    try {
      const download = await clickCardDownload(page, index)
      if (download) {
        const filePath = await saveDownloadEvent(download, outputDir)
        if (filePath) saved.push(filePath)
      }
    } catch (_) { /* fall through */ }
  }

  if (saved.length >= wanted) return saved

  const labeled = page.locator('[aria-label*="下载"], [title*="下载"], [aria-label*="Download" i], a[download]')
  const labeledCount = await labeled.count().catch(() => 0)
  for (let index = 0; index < labeledCount && saved.length < wanted; index += 1) {
    try {
      const download = await awaitDownloadAfter(page, () => labeled.nth(index).click({ timeout: 5000 }))
      if (!download) continue
      const filePath = await saveDownloadEvent(download, outputDir)
      if (filePath) saved.push(filePath)
    } catch (_) { /* next */ }
  }

  if (saved.length >= wanted) return saved

  const snapshot = await snapshotWorks(page)
  const newAudios = (snapshot.audios || []).filter(src => !(baseline.audios || []).includes(src))
  for (const src of newAudios) {
    if (saved.length >= wanted) break
    if (!/^https?:|^blob:/i.test(src)) continue
    try {
      const response = await fetch(src)
      if (!response.ok) continue
      const ext = audioExtension(src)
      const filePath = path.join(outputDir, `generated-music-${stampForFile()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
      fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer()))
      if (fs.statSync(filePath).size > 0) saved.push(filePath)
    } catch (_) { /* next url */ }
  }

  for (const item of capturedAudio) {
    if (saved.length >= wanted) break
    if (!item?.body || item.body.length < 8000) continue
    const ext = audioExtension(item.url || item.ct) || 'mp3'
    const filePath = path.join(outputDir, `generated-music-${stampForFile()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
    fs.writeFileSync(filePath, Buffer.from(item.body))
    if (fs.statSync(filePath).size > 0) saved.push(filePath)
  }
  return saved
}

async function generateMusicOnPage(prepared, options = {}) {
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('登录浏览器仍在打开。请完成 MiniMax 登录并关闭整个专用 Chrome 窗口后再生成。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  const outputDir = options.outputDir || path.join(os.tmpdir(), 'lingxi-minimax-music')
  const page = await launchExternalBrowser()
  const report = onceProgress(options.onProgress)
  const capturedAudio = []
  const onResponse = async (response) => {
    try {
      const url = response.url()
      const ct = String(response.headers()['content-type'] || '')
      if (!/audio\//i.test(ct) && !/\.(mp3|wav|m4a|aac)(\?|$)/i.test(url)) return
      const body = await response.body()
      if (body && body.length > 8000) capturedAudio.push({ url, ct, body })
    } catch (_) { /* ignore failed bodies */ }
  }
  activeJob = true
  page.on('response', onResponse)
  try {
    await navigateToMusic(page)
    await showExternalPage(page)
    const state = await waitForMusicForm(page, 20000)
    if (!state.ready) {
      loggedIn = false
      throw Object.assign(new Error('MiniMax 音乐页尚未登录。请在设置中点击第一步，用普通 Chrome 登录并关闭窗口后再重试。'), { code: 'LOGIN_REQUIRED' })
    }
    loggedIn = true
    report('正在填写歌词和风格')
    await fillMusicForm(page, prepared)
    const baseline = await snapshotWorks(page)
    await clickGenerate(page)
    report('已提交')
    await waitForCreationIdle(page, options.signal, report)
    report('正在下载成品（无水印）')
    const files = await downloadGeneratedFiles(page, baseline, prepared.n, outputDir, capturedAudio)
    if (!files.length) {
      throw Object.assign(new Error('歌曲已经生成完成，但没能点到「MP3(无水印)」下载。不要再次生成。请打开「显示浏览器」，点下载后选择无水印。'), { code: 'DOWNLOAD_FAILED' })
    }
    lastGeneratedAt = Date.now()
    lastError = ''
    return {
      success: true,
      path: files[0],
      files,
      format: audioExtension(files[0]),
      message: files.length > 1 ? `已生成 ${files.length} 首音乐` : `已生成音乐: ${files[0]}`
    }
  } finally {
    page.off('response', onResponse)
    activeJob = false
  }
}

function generateMusic(args = {}, options = {}) {
  const prepared = normalizeMusicGenerationInput(args)
  const error = validateMusicGenerationInput(prepared)
  if (error) {
    return Promise.resolve({ success: false, error })
  }
  return enqueueBridgeJob(async () => {
    try {
      return await generateMusicOnPage(prepared, options)
    } catch (caught) {
      lastError = sanitizeErrorMessage(caught, 'MiniMax 网页生成音乐失败。')
      return {
        success: false,
        error: lastError,
        code: caught?.code || 'GENERATION_FAILED',
        retry_policy: caught?.code === 'DOWNLOAD_FAILED' ? 'do_not_repeat_same_call' : undefined
      }
    }
  })
}

function registerIPC(ipcMain) {
  loadConfig()
  ipcMain.handle('minimax-music-bridge:status', async () => getStatus())
  ipcMain.handle('minimax-music-bridge:open-login', async () => openLoginWindow())
  ipcMain.handle('minimax-music-bridge:check-login', async () => checkLoginStatus())
  ipcMain.handle('minimax-music-bridge:suggested-model', async () => ({
    success: true,
    model: getSuggestedModel(),
    status: getStatus()
  }))
  ipcMain.handle('minimax-music-bridge:dump-dom', async () => dumpMusicPageDom())
}

if (app && typeof app.on === 'function') {
  app.on('before-quit', () => {
    clearBrowserReferences()
  })
}

module.exports = {
  registerIPC,
  getStatus,
  getSuggestedModel,
  generateMusic,
  openLoginWindow,
  checkLoginStatus
}
