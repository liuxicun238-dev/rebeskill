/**
 * Grok 网页聊天本地桥接。
 *
 * 只在 127.0.0.1 提供 OpenAI Chat 兼容接口。网页登录与页面操作均在
 * 系统安装的 Chrome/Edge 中完成，不使用 Electron BrowserWindow，也不读取、
 * 导出或转发登录 Token/Cookie。
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFileSync } = require('child_process')
const net = require('net')
const { app } = require('electron')
const { chromium } = require('playwright-core')
const {
  assembleWebPagePrompt,
  assemblePassthroughPagePrompt,
  formatPassthroughWebChatTranscript,
  compactWebTranscriptContent,
  formatLingxiWebChatTranscript,
  getSavedConversationUrl,
  isWebThinkingPlaceholder,
  normalizeSavedConversations,
  rememberSavedConversation,
  resolveWebChatPromptPlan,
  canSendWebChatPromptMessages,
  hasWebBridgeSendableSourceMessage,
  buildWebToolProtocolRetryPrompt,
  getLatestWebUserText,
  shouldRetryWebBridgeToolProtocol,
  normalizeWebToolPathArgs,
  normalizeWebToolCallArgs,
  materializeWebBridgeToolCalls,
  tryExtractLingxiCallsLoose: extractLingxiCallsLooseShared,
  assertWebToolArguments,
  nextWebGenerationIdleTicks,
  noteWebGenerationStarted,
  shouldAcceptStoppedWebReply,
  throwIfWebChatAborted,
  takeUsableWebReplyIfAborted,
  harvestCapturedWebReply,
  extractWebBridgeReplyDelta,
  shouldSettleWebReply,
  attachWebChatAbort,
  didWebPromptLeaveComposer,
  WEB_BRIDGE_STAGE_EVERY,
  looksLikeWebBridgeToolProtocol,
  extractWebBridgeToolJsonSlice,
  canonicalizeWebBridgeToolJson,
  normalizeWebBridgeToolPayload,
  parseWebBridgeAskChoiceFallback,
  parsePassthroughWebToolCalls,
  isWebBridgePassthroughMode,
  resolveWebBridgeApiMode,
  looksLikeLingxiWebRequest,
  looksLikeLingxiWebToolset,
  getWebBridgeAgentLane,
  buildWebChatSessionKeyFromRequest,
  pickReusableWebChatPage,
  clickWebBridgeNewChatButton,
  WEB_BRIDGE_DIALECT_JSON_FENCE,
  stripWebBridgeToolCallMarkers,
  sanitizeWebBridgeCapturedReply
} = require('./web-bridge-coding-protocol')
const { extractWebAssistantState } = require('./web-bridge-dom-markdown')
const {
  getSharedWebBridgeProfileDir,
  listSharedWebBridgeDebugPorts,
  shouldUseWebBridgeHeadless,
  getWebBridgeAutomationLaunchFlags,
  syncWebBridgeAutomationProcess,
  applyWebBridgePageVisibility
} = require('./web-bridge-chrome-profile')
const storageConfig = require('./storage-config')
const { buildImagePreviewPayload, normalizeTimestampForFile } = require('./tool-handlers/screenshot')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3219
const GROK_URL = 'https://grok.com/'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const CHAT_TIMEOUT_MS = 10 * 60 * 1000
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000
const DEVTOOLS_CONNECT_TIMEOUT_MS = 45000
const AUTOMATION_DEBUG_PORT = 19329
const MAX_CHAT_SESSION_PAGES = 6
const MAX_WEB_TOOLS = 96
const MAX_WEB_TOOL_CALLS = WEB_BRIDGE_STAGE_EVERY
const MAX_WEB_TOOL_ARGUMENT_CHARS = 400000
const TOOL_CALL_OPEN = '<LINGXI_TOOL_CALLS>'
const TOOL_CALL_CLOSE = '</LINGXI_TOOL_CALLS>'

let server = null
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
let activeJobType = ''
let lastError = ''
let lastChatAt = 0
let lastGeneratedAt = 0
let loggedIn = null
let waitDiagnostics = null
const chatSessions = new Map()

function getConfigPath() {
  return path.join(app.getPath('userData'), 'grok-web-bridge.json')
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
  } catch (_) { /* first run or invalid legacy file */ }

  const environmentPort = Number(process.env.LINGXI_GROK_WEB_BRIDGE_PORT)
  const savedPort = Number(saved.port)
  const port = Number.isInteger(environmentPort) && environmentPort >= 1024 && environmentPort <= 65535
    ? environmentPort
    : savedPort
  bridgeConfig = {
    host: DEFAULT_HOST,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT,
    apiKey: typeof saved.apiKey === 'string' && saved.apiKey.length >= 24
      ? saved.apiKey
      : `lingxi-local-${crypto.randomBytes(24).toString('hex')}`,
    browserExecutable: typeof saved.browserExecutable === 'string' ? saved.browserExecutable.trim() : '',
    conversations: normalizeSavedConversations(saved.conversations)
  }
  writeConfig(bridgeConfig)
  return bridgeConfig
}

function getBaseUrl() {
  const config = loadConfig()
  return `http://${config.host}:${config.port}`
}

function getSuggestedModel() {
  const config = loadConfig()
  return {
    provider: 'grok-web-bridge',
    modelName: 'Grok 网页生图（本地 Chrome）',
    modelId: 'grok-web-image',
    imageModel: 'grok-web-image',
    apiUrl: `${getBaseUrl()}/v1`,
    apiKey: config.apiKey,
    useFullUrl: false,
    capabilities: {
      text: false,
      vision: false,
      imageGeneration: true,
      musicGeneration: false,
      videoGeneration: false,
      speechSynthesis: false,
      toolCalling: false
    }
  }
}

function getSuggestedChatModel() {
  const config = loadConfig()
  return {
    provider: 'grok-web-bridge',
    modelName: 'Grok 网页版（本地 Chrome）',
    modelId: 'grok-web-chat',
    apiUrl: `${getBaseUrl()}/v1`,
    apiKey: config.apiKey,
    useFullUrl: false,
    contextWindow: 128000,
    capabilities: {
      text: true,
      vision: false,
      imageGeneration: false,
      musicGeneration: false,
      videoGeneration: false,
      speechSynthesis: false,
      toolCalling: true
    }
  }
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '').toLowerCase()
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function sendError(res, statusCode, code, message) {
  sendJson(res, statusCode, {
    error: {
      type: 'grok_web_bridge_error',
      code,
      message
    }
  })
}

function sanitizeErrorMessage(error, fallback = '操作失败。') {
  let message = String(error?.message || error || fallback)
  message = message
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/^\s*-\s*(cookie|authorization):.*$/gim, '  - $1: [已隐藏]')
    .replace(/\b(__Secure-[^=\s;]+|__Host-[^=\s;]+|session-token(?:\.\d+)?|access[_-]?token|refresh[_-]?token)=([^;\s]+)/gi, '$1=[已隐藏]')
    .trim()
  return message.slice(0, 1200) || fallback
}

function isAuthorized(req) {
  const expected = loadConfig().apiKey
  const auth = String(req.headers.authorization || '')
  const supplied = auth.replace(/^Bearer\s+/i, '')
  if (!supplied || supplied.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  } catch (_) {
    return false
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', chunk => {
      if (rejected) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejected = true
        reject(Object.assign(new Error('请求内容过大。'), { code: 'BODY_TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (_) {
        reject(Object.assign(new Error('请求体不是有效 JSON。'), { code: 'INVALID_JSON' }))
      }
    })
    req.on('error', reject)
  })
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
    } catch (_) { /* try the next registry root */ }
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
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Bin', 'chrome.exe'),
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
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    )
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
  if (name.includes('chromium')) return 'Chromium'
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
    running: !!server,
    host: loadConfig().host,
    port: loadConfig().port,
    apiUrl: `${getBaseUrl()}/v1`,
    browserOpen: loginBrowserOpen || automationBrowserOpen,
    browserVisible: loginBrowserOpen || automationBrowserOpen,
    browserMode: loginBrowserOpen ? 'login' : automationBrowserOpen ? 'automation' : 'closed',
    loginBrowserOpen,
    browserName: getBrowserName(),
    browserExecutable: findBrowserExecutable(),
    loggedIn,
    queueDepth,
    activeJob,
    activeJobType,
    chatSessionCount: chatSessions.size,
    lastError,
    lastChatAt,
    lastGeneratedAt,
    waitDiagnostics
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

function readDevToolsEndpoint() {
  const port = readDevToolsPortFromFile()
  return port ? `http://127.0.0.1:${port}` : ''
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
  chatSessions.clear()
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
  bridgePage = bridgeContext.pages().find(page => /grok\.com/i.test(page.url()))
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

async function launchExternalBrowser(options = {}) {
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('请先在普通 Chrome 中完成登录，并关闭整个专用 Chrome 窗口，然后再检查登录状态。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
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
      throw Object.assign(new Error('专用 Chrome 已经打开，但软件连不上调试端口，所以没有往页面里发送内容。请先关掉这个专用 Chrome 窗口，再重新发送一次。'), {
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
    } catch (_) { /* stale marker may be locked briefly */ }
  }

  const args = [
    ...getWebBridgeAutomationLaunchFlags(options),
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${AUTOMATION_DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    GROK_URL
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

function buildNormalLoginArgs(profileDir) {
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--new-window',
    GROK_URL
  ]
}

async function launchNormalLoginBrowser() {
  if (activeJob) {
    throw Object.assign(new Error('当前正在网页聊天或生图，完成后才能重新打开登录浏览器。'), { code: 'BRIDGE_BUSY' })
  }
  if (isLoginBrowserRunning()) return getStatus()

  // 旧版本可能留下带远程调试参数的同一专用 Chrome。先连接并关闭它，
  // 确保 Google 登录只发生在完全普通、没有自动化参数的浏览器进程中。
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
  } catch (_) { /* stale marker may be locked briefly */ }

  const child = spawn(executablePath, buildNormalLoginArgs(profileDir), {
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

async function navigateToGrok(page) {
  if (!page || page.isClosed()) throw Object.assign(new Error('外部浏览器页面已关闭。'), { code: 'BROWSER_CLOSED' })
  if (/^https:\/\/(www\.)?grok\.com\//i.test(page.url())) return
  await page.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
}

async function showExternalPage(page, options = {}) {
  if (!page || page.isClosed()) return
  await applyWebBridgePageVisibility(page, bridgeContext, {
    forceVisible: options.forceVisible === true,
    withTimeout
  })
}

const COMPOSER_SELECTORS = [
  '.tiptap.ProseMirror[contenteditable="true"]',
  '.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][role="textbox"]',
  'textarea[aria-label*="Ask Grok"]',
  'textarea[placeholder*="Ask Grok"]',
  'textarea[placeholder*="Ask anything"]'
]

const SUBMIT_SELECTORS = [
  'button[data-testid="chat-submit"]',
  'button[aria-label="Submit"]',
  'button[aria-label="提交"]',
  'button[aria-label="送信"]',
  'button[aria-label="發送"]',
  'button[aria-label="发送"]'
]

async function inspectPageState(page = bridgePage) {
  if (!page || page.isClosed()) {
    loggedIn = null
    return { loggedIn: null, composerFound: false, url: '' }
  }
  try {
    const result = await withTimeout(page.evaluate(selectors => {
      const isVisible = node => {
        if (!(node instanceof Element)) return false
        const style = window.getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none') return false
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const composer = selectors.map(selector => document.querySelector(selector)).find(node => node && isVisible(node))
      const signInCta = Array.from(document.querySelectorAll('button, a'))
        .some(node => isVisible(node) && /^(sign in|log in|登录|登入)$/i.test(String(node.textContent || '').trim()))
      return {
        composerFound: !!composer && !signInCta,
        loginVisible: signInCta,
        title: document.title,
        url: location.href
      }
    }, COMPOSER_SELECTORS), 5000, '读取 Grok 页面状态超时。')
    loggedIn = !!result?.composerFound
    return { ...result, loggedIn }
  } catch (error) {
    loggedIn = null
    return { loggedIn: null, composerFound: false, url: page.url(), error: error.message }
  }
}

async function waitForComposer(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  while (Date.now() < deadline) {
    state = await inspectPageState(page)
    if (state.composerFound) return state
    await new Promise(resolve => setTimeout(resolve, 800))
  }
  return state || { loggedIn: false, composerFound: false }
}

async function openLoginWindow() {
  const status = await launchNormalLoginBrowser()
  return {
    success: true,
    ...status,
    instruction: '请在普通 Chrome 中完成登录。登录成功后关闭整个专用 Chrome 窗口，再点击“登录完成后检查”。'
  }
}

async function checkLoginStatus() {
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('请先完成登录并关闭整个专用 Chrome 窗口，然后再点击检查。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  const page = await launchExternalBrowser()
  await navigateToGrok(page)
  await showExternalPage(page)
  const state = await waitForComposer(page, 10000)
  if (!state.composerFound) {
    await closeExternalBrowser()
    loggedIn = false
    return {
      success: true,
      ...getStatus(),
      page: state,
      instruction: '没有检测到登录。请重新点击第一步，在普通 Chrome 中登录并关闭窗口后再检查。'
    }
  }
  return { success: true, ...getStatus(), page: state }
}

async function findComposer(page) {
  for (const selector of COMPOSER_SELECTORS) {
    const locators = page.locator(selector)
    const count = await locators.count().catch(() => 0)
    for (let i = 0; i < count; i += 1) {
      const locator = locators.nth(i)
      const visible = await locator.isVisible().catch(() => false)
      if (visible) return locator
    }
  }
  return null
}

async function readPageComposerText(page) {
  return page.evaluate(selectors => {
    const nodes = []
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(node => {
        if (node && node.getClientRects && node.getClientRects().length) nodes.push(node)
      })
    }
    const texts = nodes.map(el => {
      if (el.getAttribute('data-placeholder') && el.classList.contains('is-editor-empty')) return ''
      return String(el.innerText || el.textContent || el.value || '').replace(/\u00a0/g, ' ').trim()
    }).filter(text => text && !/^(Ask anything|Ask Grok|有问题.*问|询问任何问题)$/i.test(text))
    texts.sort((a, b) => b.length - a.length)
    return texts[0] || ''
  }, COMPOSER_SELECTORS).catch(() => '')
}

async function isComposerSendEnabled(page) {
  for (const selector of SUBMIT_SELECTORS) {
    const button = page.locator(selector).first()
    if (await button.count() && await button.isEnabled().catch(() => false)) return true
  }
  return false
}

async function fillGrokComposer(page, prompt) {
  return page.evaluate(text => {
    const composer = document.querySelector('.ProseMirror[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('textarea[placeholder*="Ask"]')
    if (!composer) throw new Error('composer missing')
    composer.focus()
    const editor = composer.editor
    if (editor?.commands?.insertContent) {
      if (typeof editor.commands.clearContent === 'function') editor.commands.clearContent()
      editor.commands.focus()
      editor.commands.insertContent(text)
    } else if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      composer.value = text
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(composer)
      selection.removeAllRanges()
      selection.addRange(range)
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      composer.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      }))
      if (!String(composer.innerText || composer.textContent || '').trim()) {
        document.execCommand('selectAll', false, null)
        document.execCommand('insertText', false, text)
      }
    }
    return String(composer.innerText || composer.textContent || composer.value || '').trim().length
  }, prompt)
}

async function composerLooksFilled(page, prompt) {
  const target = String(prompt || '').trim()
  const current = String(await readPageComposerText(page) || '').trim()
  if (current && (current === target || current.includes(target.slice(0, Math.min(80, target.length))) || current.length >= Math.min(target.length, Math.floor(target.length * 0.5) || target.length))) {
    return true
  }
  if (await isComposerSendEnabled(page) && (current.length > 0 || target.length > 0)) return true
  return false
}

async function fillAndSubmitPrompt(page, prompt) {
  await ensureComposerAcceptsInput(page)
  const composer = await findComposer(page)
  if (!composer) throw Object.assign(new Error('没有找到 Grok 输入框，请重新登录。'), { code: 'COMPOSER_NOT_FOUND' })

  await composer.click({ timeout: 8000 }).catch(() => {})
  await fillGrokComposer(page, prompt).catch(() => 0)
  await page.waitForTimeout(250)
  if (!(await composerLooksFilled(page, prompt))) {
    try {
      await composer.fill(prompt, { timeout: 8000 })
    } catch (_) { /* TipTap 经常拒绝 Playwright fill */ }
    await page.waitForTimeout(200)
  }
  if (!(await composerLooksFilled(page, prompt))) {
    throw Object.assign(new Error('Grok 输入框内容为空，填入失败。'), { code: 'COMPOSER_FILL_FAILED' })
  }

  const before = await readAssistantState(page)
  // Grok 的 Enter 是换行，必须点 Submit。不要用普通回车当发送。
  let clicked = false
  for (const selector of SUBMIT_SELECTORS) {
    const button = page.locator(selector).first()
    if (await button.count() && await button.isEnabled().catch(() => false) && await button.isVisible().catch(() => false)) {
      await button.click()
      clicked = true
      break
    }
  }
  if (!clicked) await composer.press('Control+Enter')

  const submitted = await waitForPromptSubmitted(page, before, 8000, { hadComposerText: true })
  if (!submitted) {
    for (const selector of SUBMIT_SELECTORS) {
      const button = page.locator(selector).first()
      if (await button.count() && await button.isEnabled().catch(() => false)) {
        await button.click().catch(() => {})
        break
      }
    }
    const retried = await waitForPromptSubmitted(page, before, 5000, { hadComposerText: true })
    if (!retried) {
      throw Object.assign(new Error('Grok 页面没有发出这条消息。请查看自动化 Chrome 里输入框是否填入、Submit 是否可点。'), { code: 'PROMPT_NOT_SENT' })
    }
  }
}

function extractWebMessageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content.map(part => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    if (['text', 'input_text', 'output_text'].includes(part.type)) return String(part.text || '')
    if (part.type === 'image_url' || part.type === 'input_image') return '[图片输入：网页版聊天桥接暂不支持转发图片]'
    return String(part.text || part.content || '')
  }).filter(Boolean).join('\n')
}

function normalizeWebChatMessages(body = {}) {
  const source = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : typeof body.input === 'string'
        ? [{ role: 'user', content: body.input }]
        : []
  return source.map(message => {
    if (!message || typeof message !== 'object') return null
    if (message.type === 'function_call_output') {
      return {
        role: 'tool',
        callId: String(message.call_id || ''),
        content: extractWebMessageText(message.output).trim()
      }
    }
    if (message.type === 'function_call') {
      return {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: String(message.call_id || message.id || ''),
          name: String(message.name || ''),
          arguments: String(message.arguments || '{}')
        }]
      }
    }
    const role = ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) ? message.role : 'user'
    const content = extractWebMessageText(message.content)
    const toolCalls = role === 'assistant' && Array.isArray(message.tool_calls)
      ? message.tool_calls.map(call => ({
          id: String(call?.id || ''),
          name: String(call?.function?.name || ''),
          arguments: typeof call?.function?.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call?.function?.arguments || {})
        })).filter(call => call.id && call.name)
      : []
    if (!content.trim() && !toolCalls.length && role !== 'tool') return null
    const normalized = { role, content: content.trim() }
    if (toolCalls.length) normalized.toolCalls = toolCalls
    if (role === 'tool') {
      normalized.callId = String(message.tool_call_id || message.call_id || '')
      if (message.name) normalized.name = String(message.name)
    }
    return normalized
  }).filter(Boolean)
}

function normalizeWebTools(tools = []) {
  if (!Array.isArray(tools)) return []
  const { getWebGptCoreTools } = require('./capability-tiers')
  const allowed = getWebGptCoreTools()
  return tools.slice(0, MAX_WEB_TOOLS).map(tool => {
    const fn = tool?.function || tool || {}
    const name = String(fn.name || '').trim()
    if (!name || !/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) return null
    if (!allowed.has(name)) return null
    return {
      name,
      description: String(fn.description || '').slice(0, 80),
      parameters: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} }
    }
  }).filter(Boolean)
}

function formatWebChatTranscript(messages = []) {
  return formatLingxiWebChatTranscript(messages)
}

function buildWebChatPrompt(body = {}, providedMessages = null, mode = 'initial', options = {}) {
  const messages = Array.isArray(providedMessages) ? providedMessages : normalizeWebChatMessages(body)
  if (!canSendWebChatPromptMessages(messages, mode)) {
    throw Object.assign(new Error('缺少可发送的用户消息。'), { code: 'MISSING_MESSAGES' })
  }
  if (options.passthrough && !looksLikeLingxiWebRequest(body, body.tools)) {
    return assemblePassthroughPagePrompt({
      transcript: formatPassthroughWebChatTranscript(messages, { tools: body.tools }),
      tools: body.tools,
      maxToolCalls: MAX_WEB_TOOL_CALLS
    })
  }
  return assembleWebPagePrompt({
    mode,
    transcript: formatWebChatTranscript(messages),
    tools: normalizeWebTools(body.tools),
    maxToolCalls: MAX_WEB_TOOL_CALLS
  })
}

function stripWebChatCopyChrome(text) {
  return String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/^[ \t]*(?:Copy code|复制代码|Copy|复制)\s*$/gim, '')
    .replace(/^[ \t]*(?:json|javascript|js|ts|typescript|xml|html|text)\s*$/gim, '')
}

function unwrapWebChatFences(text) {
  let next = String(text || '').trim()
  for (let i = 0; i < 3; i += 1) {
    const fenced = /^```(?:[A-Za-z0-9_-]+)?\s*([\s\S]*?)\s*```$/i.exec(next)
    if (!fenced) break
    next = fenced[1].trim()
  }
  return next
}

function escapeBareBackslashes(text) {
  return String(text || '').replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
}

// Grok 写 HTML/JS 文件时，经常把 contents 里的裸双引号、换行原样塞进 JSON。
// 这里按“字符串内部、后面不像 JSON 结束符的引号就转义”做一次修复。
function repairLooseJson(text) {
  const src = String(text || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        const next = src[i + 1]
        if (next && '"\\/bfnrtu'.includes(next)) {
          out += ch
          escaped = true
        } else {
          out += '\\\\'
        }
        continue
      }
      if (ch === '"') {
        let j = i + 1
        while (j < src.length && /[ \t\r\n]/.test(src[j])) j += 1
        const next = src[j] || ''
        if (!next || ',:}]}'.includes(next)) {
          inString = false
          out += ch
        } else {
          out += '\\"'
        }
        continue
      }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
      out += ch
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    out += ch
  }
  return out
}

function extractLingxiToolCallBlock(text) {
  const open = text.indexOf(TOOL_CALL_OPEN)
  const close = text.lastIndexOf(TOOL_CALL_CLOSE)
  if (open < 0 || close < 0 || close <= open) return null
  // Grok 网页模型常在工具调用前后加说明文字（如“好的，我来……”“以上是……”。
  // 这里放宽：只提取标记之间的内容，忽略前后的普通文字。
  // 安全底线仍由 parseLingxiToolCalls 里对工具白名单、参数校验保证。
  return text.slice(open + TOOL_CALL_OPEN.length, close)
}

// 结构修复（方案 2）：从含工具调用的回复里剥掉 <LINGXI_TOOL_CALLS>...</LINGXI_TOOL_CALLS>
// 标记本身，返回剩余的可读文本。runWebChat 用它在解析出 toolCalls 的同时仍然把
// 网页里的"前后说明文字 + 工具调用之间夹杂的补充"留给上层 content 字段。
function stripLingxiToolCallMarkers(text) {
  const original = String(text || '')
  const open = original.indexOf(TOOL_CALL_OPEN)
  if (open < 0) return original
  const close = original.lastIndexOf(TOOL_CALL_CLOSE)
  if (close < 0 || close < open) return original
  const before = original.slice(0, open)
  const after = original.slice(close + TOOL_CALL_CLOSE.length)
  return [before, after].map(part => part.trim()).filter(Boolean).join('\n')
}

function tryParseWebToolJson(raw) {
  const candidates = []
  const seen = new Set()
  const push = (value) => {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) return
    seen.add(text)
    candidates.push(text)
  }

  push(raw)
  push(unwrapWebChatFences(raw))
  push(stripWebChatCopyChrome(raw))
  push(unwrapWebChatFences(stripWebChatCopyChrome(raw)))

  const compact = stripWebChatCopyChrome(raw)
    .replace(/```(?:[A-Za-z0-9_-]+)?/g, '')
    .replace(/```/g, '')
    .replace(/^[ \t]*(?:Copy code|复制代码|Copy|复制)\s*$/gim, '')
    .replace(/^(?:json|javascript|js|ts|typescript|xml|html|text)\s*/i, '')
    .trim()
  push(compact)
  push(compact.replace(/\s+/g, ' ').trim())
  push(compact.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"))
  push(compact.replace(/,(\s*[}\]])/g, '$1'))
  if (!compact.includes('"') && compact.includes("'")) {
    push(compact.replace(/'/g, '"'))
  }

  for (const candidate of [...candidates]) {
    push(escapeBareBackslashes(candidate))
    push(repairLooseJson(candidate))
    push(repairLooseJson(escapeBareBackslashes(candidate)))
    push(canonicalizeWebBridgeToolJson(candidate))
    push(canonicalizeWebBridgeToolJson(repairLooseJson(candidate)))
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch (_) { /* try a more tolerant candidate */ }
  }

  const objectMatch = compact.match(/\{[\s\S]*\}/)
  if (objectMatch) {
    const repairedObject = repairLooseJson(objectMatch[0])
    try {
      return JSON.parse(objectMatch[0])
    } catch (_) { /* fall through */ }
    try {
      return JSON.parse(objectMatch[0].replace(/,(\s*[}\]])/g, '$1'))
    } catch (_) { /* fall through */ }
    try {
      return JSON.parse(repairedObject)
    } catch (_) { /* fall through */ }
    try {
      return JSON.parse(repairedObject.replace(/,(\s*[}\]])/g, '$1'))
    } catch (_) { /* fall through */ }
  }

  // CSS/HTML/JS 文件内容里经常有未转义双引号（font-family: "Inter"、content: ""）。
  // 常规 JSON.parse 和按逗号猜测字符串结尾都会失败，这里按工具调用结构捞参数。
  return extractLingxiCallsLooseShared(raw) || extractLingxiCallsLooseShared(compact) || tryExtractLingxiCallsLoose(raw) || tryExtractLingxiCallsLoose(compact)
}

function unescapeJsonStringish(value) {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function extractQuotedJsonField(chunk, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(chunk)
  if (!match) return null
  return match.index + match[0].length
}

function findLooseJsonStringEnd(rest) {
  const strict = [
    /"\s*\}\s*\}\s*,\s*\{\s*"name"/,
    /"\s*\}\s*\}\s*\]\s*\}/,
    /"\s*\}\s*\}\s*\]/,
    /"\s*,\s*"(?:path|content|contents|patch|name|arguments|cwd|action|edits|old_content|new_content|command|start_line|end_line)"/,
    /"\s*\}\s*,\s*"/
  ]
  let best = -1
  for (const pattern of strict) {
    const match = pattern.exec(rest)
    if (match && (best < 0 || match.index < best)) best = match.index
  }
  const fallback = /"\s*\}/.exec(rest)
  if (fallback && (best < 0 || fallback.index < best)) best = fallback.index
  return best
}

function extractArgumentsFromChunk(chunk) {
  const args = {}
  const pathStart = extractQuotedJsonField(chunk, 'path')
  if (pathStart != null) {
    const pathRest = chunk.slice(pathStart)
    const pathEnd = pathRest.search(/"\s*[,}]/)
    if (pathEnd >= 0) args.path = unescapeJsonStringish(pathRest.slice(0, pathEnd))
  }
  const contentKeys = ['content', 'contents', 'patch', 'new_content', 'old_content', 'command']
  for (const key of contentKeys) {
    const start = extractQuotedJsonField(chunk, key)
    if (start == null) continue
    const rest = chunk.slice(start)
    const end = findLooseJsonStringEnd(rest)
    if (end < 0) continue
    args[key === 'contents' ? 'content' : key] = unescapeJsonStringish(rest.slice(0, end))
    break
  }
  return Object.keys(args).length ? args : null
}

function tryExtractLingxiCallsLoose(raw) {
  const text = String(raw || '')
  if (!/"name"\s*:\s*"/.test(text) || !/"arguments"\s*:\s*\{/.test(text)) return null
  const starts = []
  const nameRe = /"name"\s*:\s*"([A-Za-z0-9_.:-]+)"/g
  let match
  while ((match = nameRe.exec(text))) {
    starts.push({ name: match[1], index: match.index })
  }
  if (!starts.length) return null
  const calls = []
  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i]
    const chunk = text.slice(current.index, i + 1 < starts.length ? starts[i + 1].index : text.length)
    if (!/"arguments"\s*:\s*\{/.test(chunk)) continue
    const args = extractArgumentsFromChunk(chunk)
    if (!args) continue
    calls.push({ name: current.name, arguments: args })
  }
  return calls.length ? { calls } : null
}

function parseLingxiToolCalls(answer, tools = [], options = {}) {
  if (options.passthrough && !looksLikeLingxiWebToolset(tools)) return parsePassthroughWebToolCalls(answer, tools, { maxCalls: MAX_WEB_TOOL_CALLS })
  const original = String(answer || '')
  let text = unwrapWebChatFences(stripWebChatCopyChrome(original).trim())
  const hasMarker = looksLikeWebBridgeToolProtocol(original) || looksLikeWebBridgeToolProtocol(text)
  const extracted = extractWebBridgeToolJsonSlice(text) || extractWebBridgeToolJsonSlice(original)
  if (!extracted) {
    if (hasMarker) {
      throw Object.assign(new Error('网页模型返回了不完整或混有额外文字的灵犀工具调用，已拒绝执行。'), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
    }
    return parseWebBridgeAskChoiceFallback(original, tools)
  }
  let payload = normalizeWebBridgeToolPayload(tryParseWebToolJson(extracted))
  if (Array.isArray(payload)) payload = { calls: payload }
  else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.tool_calls) && !Array.isArray(payload.calls)) {
      payload = {
        calls: payload.tool_calls.map(item => {
          const fn = item?.function || item || {}
          return {
            name: String(fn.name || item?.name || ''),
            arguments: fn.arguments != null ? fn.arguments : (item?.arguments != null ? item.arguments : {})
          }
        })
      }
    } else if (!Array.isArray(payload.calls) && payload.name) {
      payload = { calls: [payload] }
    }
  }
  if (!payload) {
    throw Object.assign(new Error('网页模型返回的灵犀工具调用不是有效 JSON，已拒绝执行。'), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
  }
  if (!payload || !Array.isArray(payload.calls) || payload.calls.length < 1 || payload.calls.length > MAX_WEB_TOOL_CALLS) {
    throw Object.assign(new Error(`网页模型返回的工具调用数量无效（允许 1-${MAX_WEB_TOOL_CALLS} 个），已拒绝执行。`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
  }
  const allowed = new Set(normalizeWebTools(tools).map(tool => tool.name))
  return materializeWebBridgeToolCalls(payload.calls, {
    allowedNames: allowed,
    parseJson: tryParseWebToolJson,
    maxArgumentChars: MAX_WEB_TOOL_ARGUMENT_CHARS
  })
}

function getChatSessionKey(req, body = {}, bridgeMode = '') {
  return buildWebChatSessionKeyFromRequest(req, body, bridgeMode)
}

function getWebChatRequestDigest(body = {}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    messages: normalizeWebChatMessages(body),
    tools: normalizeWebTools(body.tools)
  })).digest('hex')
}

function messagesHavePrefix(messages = [], prefix = []) {
  if (!prefix.length || messages.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (JSON.stringify(messages[index]) !== JSON.stringify(prefix[index])) return false
  }
  return true
}

function isPreviousBridgeReply(message, result = {}) {
  if (!message || message.role !== 'assistant') return false
  if (Array.isArray(result.toolCalls) && result.toolCalls.length) {
    const current = Array.isArray(message.toolCalls) ? message.toolCalls : []
    return current.length === result.toolCalls.length && current.every((call, index) => (
      call.id === result.toolCalls[index].id && call.name === result.toolCalls[index].function?.name
    ))
  }
  return String(message.content || '') === String(result.content || '')
}

function getContinuationMessages(messages = [], previousMessages = [], previousResult = null) {
  if (!messagesHavePrefix(messages, previousMessages)) return null
  const tail = messages.slice(previousMessages.length)
  if (tail.length && isPreviousBridgeReply(tail[0], previousResult || {})) tail.shift()
  return tail
}

async function pruneChatSessionPages(protectedKey = '') {
  const entries = [...chatSessions.entries()]
    .filter(([key]) => key !== protectedKey)
    .sort((a, b) => Number(a[1]?.lastUsed || 0) - Number(b[1]?.lastUsed || 0))
  while (chatSessions.size >= MAX_CHAT_SESSION_PAGES && entries.length) {
    const [key, session] = entries.shift()
    chatSessions.delete(key)
    await session?.page?.close().catch(() => {})
  }
}

function isGrokConversationUrl(url = '') {
  return /^https:\/\/(www\.)?grok\.com\/(c|chat)\//i.test(String(url || ''))
}

function readSavedConversationUrl(sessionKey, projectId = '', lane = '') {
  return getSavedConversationUrl(loadConfig().conversations, sessionKey, projectId, lane)
}

function persistConversationUrl(sessionKey, url, projectId = '', lane = '') {
  if (!sessionKey || !isGrokConversationUrl(url)) return
  const config = loadConfig()
  config.conversations = rememberSavedConversation(config.conversations, sessionKey, url, projectId, lane)
  writeConfig(config)
}

function findReusableGrokPage(savedUrl = '', sessionKey = '') {
  const pages = (bridgeContext?.pages() || []).filter(page => !page.isClosed() && /grok\.com/i.test(page.url()))
  return pickReusableWebChatPage(pages, { savedUrl, sessionKey, chatSessions })
}

async function getChatSessionPage(sessionKey, projectId = '', lane = '') {
  await launchExternalBrowser()
  const existing = chatSessions.get(sessionKey)
  if (existing?.page && !existing.page.isClosed()) {
    existing.lastUsed = Date.now()
    if (projectId) existing.projectId = projectId
    existing.lane = String(lane || existing.lane || 'lingxi')
    return existing
  }
  if (existing) chatSessions.delete(sessionKey)
  await pruneChatSessionPages(sessionKey)
  const savedUrl = readSavedConversationUrl(sessionKey, projectId, lane)
  const page = findReusableGrokPage(savedUrl, sessionKey) || await bridgeContext.newPage()
  const liveUrl = page.url()
  const session = {
    page,
    lastUsed: Date.now(),
    initialized: false,
    requestDigest: '',
    result: null,
    inputMessages: [],
    conversationUrl: (lane && lane !== 'lingxi')
      ? (savedUrl || '')
      : (isGrokConversationUrl(liveUrl) ? liveUrl : (savedUrl || '')),
    projectId: String(projectId || ''),
    lane: String(lane || 'lingxi')
  }
  chatSessions.set(sessionKey, session)
  page.once('close', () => {
    if (chatSessions.get(sessionKey)?.page === page) chatSessions.delete(sessionKey)
  })
  return session
}

async function prepareFreshWebChat(page, { forceNew = false, isConversationUrl = isGrokConversationUrl } = {}) {
  await page.goto(GROK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  if (forceNew && isConversationUrl(page.url())) {
    await clickWebBridgeNewChatButton(page)
    await page.waitForTimeout(600)
  }
  const state = await waitForComposer(page, 20000)
  if (!state.composerFound) {
    loggedIn = false
    throw Object.assign(new Error('Grok 尚未登录。请先在设置中完成网页登录检查。'), { code: 'LOGIN_REQUIRED' })
  }
  loggedIn = true
  return state
}

async function prepareSessionWebChat(page, savedUrl = '', { forceNew = false } = {}) {
  if (!forceNew && isGrokConversationUrl(page.url())) {
    const state = await waitForComposer(page, 20000)
    if (state.composerFound) {
      loggedIn = true
      return { resumed: true, state }
    }
  }
  if (!forceNew && isGrokConversationUrl(savedUrl)) {
    try {
      await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      if (isGrokConversationUrl(page.url())) {
        const state = await waitForComposer(page, 20000)
        if (state.composerFound) {
          loggedIn = true
          return { resumed: true, state }
        }
      }
    } catch (_) { /* deleted or expired thread, open a new chat */ }
  }
  const state = await prepareFreshWebChat(page, { forceNew, isConversationUrl: isGrokConversationUrl })
  return { resumed: false, state }
}

async function readAssistantState(page) {
  return page.evaluate(extractWebAssistantState, {
    replySelectors: [
      '[data-testid="assistant-message"]',
      '[id^="response-"] [data-testid="assistant-message"]',
      '[class*="assistant-message"]'
    ],
    markdownSelectors: [
      '[data-testid="assistant-message"] [class*="markdown"]',
      '[data-testid="assistant-message"] .prose',
      '[class*="markdown"]'
    ],
    stopSelectors: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop"]',
      'button[aria-label="停止生成"]'
    ],
    stopLabelPattern: 'Stop generating|Stop streaming|停止生成|停止响应',
    detectComposer: true,
    skipThinking: true
  }).catch(() => ({ count: 0, markdown: '', innerText: '', generating: false, composerReady: false, alerts: '', stale: true }))
}

async function readAssistantMarkdown(page) {
  const state = await readAssistantState(page)
  return state.markdown || ''
}

function extractReplyDelta(state, baseline = {}) {
  return extractWebBridgeReplyDelta(state, baseline)
}

function looksLikeIncompleteToolCall(text) {
  const value = String(text || '')
  const open = value.includes(TOOL_CALL_OPEN) || /LINGXI_TOOL_CALLS>/i.test(value)
  const close = value.includes(TOOL_CALL_CLOSE)
  return open && !close
}

async function waitForComposerIdle(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await readAssistantState(page)
    if (!state.generating && state.composerReady) return state
    await page.waitForTimeout(400)
  }
  return readAssistantState(page)
}

const PAGE_STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="停止生成"]',
  'button[aria-label="停止响应"]'
]

async function stopPageGeneration(page) {
  if (!page || page.isClosed()) return false
  for (const selector of PAGE_STOP_SELECTORS) {
    const button = page.locator(selector).first()
    if (await button.count().catch(() => 0) && await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 2000 }).catch(() => {})
      await page.waitForTimeout(300)
      return true
    }
  }
  const labeled = page.getByRole('button', { name: /Stop generating|Stop streaming|停止生成|停止响应|^Stop$/i })
  if (await labeled.count().catch(() => 0) && await labeled.first().isVisible().catch(() => false)) {
    await labeled.first().click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(300)
    return true
  }
  return false
}

async function abortIfCanceled(signal, page) {
  if (!signal?.aborted) return
  await stopPageGeneration(page).catch(() => {})
  throwIfWebChatAborted(signal)
}

async function ensureComposerAcceptsInput(page) {
  const state = await readAssistantState(page)
  if (state.generating) await stopPageGeneration(page)
  return waitForComposerIdle(page, 20000)
}

async function waitForPromptSubmitted(page, before = {}, timeoutMs = 8000, options = {}) {
  const deadline = Date.now() + timeoutMs
  const baselineCount = Number(before.count || 0)
  const hadComposerText = options.hadComposerText !== false
  while (Date.now() < deadline) {
    const state = await readAssistantState(page)
    const composer = await findComposer(page)
    const value = composer
      ? await composer.evaluate(el => String(el.value || el.textContent || '')).catch(() => '')
      : ''
    if (didWebPromptLeaveComposer({
      generating: state.generating,
      messageCount: state.count,
      baselineCount,
      composerEmpty: !String(value || '').trim(),
      hadComposerText
    })) return true
    await page.waitForTimeout(300)
  }
  return false
}

function looksLikeGeneratedImageReply(text = '') {
  return /生成.{0,16}(图|image|picture)|画一[张幅]|画张|来张图|出一张图|文生图|插画|封面图|海报|imagine\b|an image of|a picture of/i.test(String(text || ''))
}

async function listCandidateImages(page) {
  return page.evaluate(() => {
    const messages = Array.from(document.querySelectorAll('[data-testid="assistant-message"]'))
    const latest = messages.at(-1)
    const scope = latest || document.querySelector('main') || document.body
    return Array.from(scope.querySelectorAll('img')).map((img, index) => ({
      src: img.currentSrc || img.src || img.getAttribute('src') || '',
      alt: img.alt || '',
      className: String(img.className || ''),
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0,
      index
    })).filter(item => {
      if (!item.src || item.src.startsWith('data:image/svg')) return false
      if (/avatar|icon|emoji|logo|spinner|favicon|loading/i.test(`${item.src} ${item.alt} ${item.className}`)) return false
      return item.width >= 256 || item.height >= 256 || /generated|image|图片|图像/i.test(item.alt)
    })
  }).catch(() => [])
}

async function hasUnfinishedAssistantImages(page) {
  return page.evaluate(() => {
    const messages = document.querySelectorAll('[data-testid="assistant-message"]')
    const latest = messages[messages.length - 1]
    if (!latest) return false
    return Array.from(latest.querySelectorAll('img')).some(img => {
      const src = String(img.currentSrc || img.src || '')
      const alt = String(img.alt || '')
      const className = String(img.className || '')
      if (!src || /avatar|icon|emoji|logo|spinner|favicon|loading/i.test(`${src} ${alt} ${className}`)) return false
      const rect = img.getBoundingClientRect()
      if (rect.width < 80 && rect.height < 80) return false
      return !img.complete || img.naturalWidth < 32
    })
  }).catch(() => false)
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
  if (!match) return null
  return match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
}

async function readImageBuffer(page, source) {
  if (source.startsWith('data:')) {
    const buffer = parseDataUrl(source)
    if (buffer?.length) return buffer
  }

  const failures = []
  try {
    const renderedBase64 = await page.evaluate(imageSource => {
      const image = Array.from(document.images).find(node => (node.currentSrc || node.src || '') === imageSource)
      if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return ''
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) return ''
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png').split(',')[1] || ''
    }, source)
    if (renderedBase64) return Buffer.from(renderedBase64, 'base64')
  } catch (error) {
    failures.push(error)
  }

  try {
    const base64 = await page.evaluate(async imageSource => {
      const response = await fetch(imageSource, { credentials: 'include', cache: 'force-cache' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = await response.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
      }
      return btoa(binary)
    }, source)
    if (base64) return Buffer.from(base64, 'base64')
  } catch (error) {
    failures.push(error)
  }

  let downloadPage = null
  try {
    downloadPage = await bridgeContext.newPage()
    const response = await downloadPage.goto(source, { waitUntil: 'commit', timeout: 60000 })
    if (response?.ok()) {
      const buffer = await response.body()
      if (buffer?.length) return buffer
    }
    failures.push(new Error(`HTTP ${response?.status() || 'unknown'}`))
  } catch (error) {
    failures.push(error)
  } finally {
    await downloadPage?.close().catch(() => {})
  }

  try {
    const images = page.locator('img')
    const imageIndex = await images.evaluateAll((nodes, imageSource) => (
      nodes.findIndex(node => (node.currentSrc || node.src || '') === imageSource)
    ), source)
    if (imageIndex >= 0) {
      const buffer = await images.nth(imageIndex).screenshot({ type: 'png', timeout: 15000 })
      if (buffer?.length) return buffer
    }
  } catch (error) {
    failures.push(error)
  }

  const error = Object.assign(new Error('图片已经生成，但灵犀未能从浏览器读取图片数据。请保持自动化 Chrome 开启后重试。'), {
    code: 'IMAGE_READ_FAILED'
  })
  error.internalFailures = failures
  throw error
}

async function waitForGeneratedImages(page, baselineSources, timeoutMs = GENERATION_TIMEOUT_MS, signal = null) {
  const deadline = Date.now() + timeoutMs
  let latest = []
  let stableCount = 0
  let idleTicks = 0
  let sawGenerating = false
  while (Date.now() < deadline) {
    await abortIfCanceled(signal, page)
    if (!page || page.isClosed() || !isBrowserConnected()) {
      throw Object.assign(new Error('生图过程中外部浏览器被关闭。'), { code: 'BROWSER_CLOSED' })
    }
    const state = await readAssistantState(page)
    sawGenerating = noteWebGenerationStarted(state, sawGenerating)
    idleTicks = nextWebGenerationIdleTicks(state, idleTicks)
    const candidates = (await listCandidateImages(page)).filter(item => !baselineSources.has(item.src))
    if (candidates.length && candidates.every(item => item.width >= 256 || item.height >= 256)) {
      const signature = candidates.map(item => item.src).join('|')
      const previous = latest.map(item => item.src).join('|')
      if (signature === previous) stableCount += 1
      else {
        latest = candidates
        stableCount = 1
      }
      if (stableCount >= 2) return latest
    }
    const pageError = await page.evaluate(() => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"]'))
      return alerts.map(node => String(node.innerText || '')).filter(Boolean).join(' ').slice(0, 500)
    }).catch(() => '')
    if (pageError && /error|failed|错误|失败|稍后/i.test(pageError)) {
      throw Object.assign(new Error(`Grok 页面提示：${pageError}`), { code: 'PAGE_ERROR' })
    }
    if (shouldAcceptStoppedWebReply(idleTicks, 3, sawGenerating)) {
      if (latest.length) return latest
      throw Object.assign(new Error('等待 Grok 生成图片超时。请查看自动化 Chrome 中的页面状态。'), { code: 'GENERATION_TIMEOUT' })
    }
    await page.waitForTimeout(1500)
  }
  if (latest.length) return latest
  throw Object.assign(new Error('等待 Grok 生成图片超时。请查看自动化 Chrome 中的页面状态。'), { code: 'GENERATION_TIMEOUT' })
}

function ensureGrokGeneratedImageDir() {
  const imageDir = path.join(storageConfig.getCacheDir(), 'generated-images')
  fs.mkdirSync(imageDir, { recursive: true })
  return imageDir
}

async function saveCapturedImages(page, images = []) {
  const saved = []
  for (const image of images.slice(0, 4)) {
    try {
      const buffer = await readImageBuffer(page, image.src)
      if (!buffer?.length) continue
      const filePath = path.join(ensureGrokGeneratedImageDir(), `generated-image-${normalizeTimestampForFile()}-${Math.random().toString(36).slice(2, 8)}.png`)
      fs.writeFileSync(filePath, buffer)
      const preview = await buildImagePreviewPayload(filePath, { thumbWidth: 420 }).catch(() => ({}))
      saved.push({
        path: filePath,
        thumbnailDataUrl: preview.thumbnailDataUrl || `data:image/png;base64,${buffer.toString('base64')}`,
        width: preview.width || image.width,
        height: preview.height || image.height
      })
    } catch (_) { /* keep text reply even if one image fails */ }
  }
  return saved
}

function appendCapturedImagesToAnswer(answer, saved = []) {
  if (!saved.length) return String(answer || '').trim()
  const blocks = saved.map(item => {
    const thumb = item.thumbnailDataUrl
      ? `<img src="${item.thumbnailDataUrl}" alt="Grok 生成图" style="max-width:min(420px,100%);border-radius:12px;">`
      : ''
    return [thumb, item.path ? `已保存：${item.path}` : ''].filter(Boolean).join('\n')
  })
  return [String(answer || '').trim(), ...blocks].filter(Boolean).join('\n\n')
}

async function captureReplyImages(page, baselineSources, answerText) {
  const hint = looksLikeGeneratedImageReply(answerText)
  const existing = (await listCandidateImages(page)).filter(item => !baselineSources.has(item.src) && (item.width >= 256 || item.height >= 256))
  if (existing.length && !hint && !(await hasUnfinishedAssistantImages(page))) return existing
  if (!hint && !existing.length && !(await hasUnfinishedAssistantImages(page))) return []
  try {
    return await waitForGeneratedImages(page, baselineSources, hint ? GENERATION_TIMEOUT_MS : 20000)
  } catch (error) {
    if (error?.code === 'GENERATION_TIMEOUT') return existing
    throw error
  }
}

function buildImagePrompt(body = {}) {
  const rawPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!rawPrompt) throw Object.assign(new Error('缺少 prompt。'), { code: 'MISSING_PROMPT' })
  const size = String(body.size || '').trim()
  const orientation = size === '1024x1536'
    ? '竖版 2:3'
    : size === '1536x1024'
      ? '横版 3:2'
      : size ? `尺寸比例参考 ${size}` : '正方形 1:1'
  return `请直接生成一张图片，不要只回复文字。画面要求：${rawPrompt}\n构图比例：${orientation}。`
}

async function waitForAssistantReply(page, baseline = {}, timeoutMs = CHAT_TIMEOUT_MS, signal = null) {
  const deadline = Date.now() + timeoutMs
  let latestDelta = { markdown: '', innerText: '' }
  let stableCount = 0
  let idleTicks = 0
  let sawGenerating = false
  while (Date.now() < deadline) {
    const abortedReply = await takeUsableWebReplyIfAborted({
      signal,
      page,
      latestDelta,
      baseline,
      readAssistantState,
      extractReplyDelta,
      stopPage: stopPageGeneration
    })
    if (abortedReply) {
      waitDiagnostics = null
      return abortedReply
    }
    if (!page || page.isClosed() || !isBrowserConnected()) {
      throw Object.assign(new Error('聊天过程中外部浏览器被关闭。'), { code: 'BROWSER_CLOSED' })
    }
    const state = await readAssistantState(page)
    sawGenerating = noteWebGenerationStarted(state, sawGenerating)
    idleTicks = nextWebGenerationIdleTicks(state, idleTicks)
    const alerts = await page.evaluate(() => Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"]'))
      .map(node => String(node.innerText || '')).filter(Boolean).join(' ').slice(0, 500)).catch(() => '')

    if (alerts && /error|failed|错误|失败|稍后/i.test(alerts)) {
      throw Object.assign(new Error(`Grok 页面提示：${alerts}`), { code: 'PAGE_ERROR' })
    }

    const delta = extractReplyDelta(state, baseline)
    waitDiagnostics = {
      textLen: String(delta.markdown || '').length,
      baselineLen: String(baseline.markdown || '').length,
      baselineCount: Number(baseline.count || 0),
      replyCount: Number(state.count || 0),
      textHead: String(delta.markdown || '').slice(0, 80),
      generating: state.generating,
      composerReady: state.composerReady,
      stableCount,
      idleTicks,
      sawGenerating,
      latestTextLen: String(latestDelta.markdown || '').length
    }

    // 新气泡用条数判断，同一气泡追加用增量判断。不能再用
    // “当前气泡全文必须比上一轮更长”，否则新回复比上一轮短时会永远抓不到。
    // 网页还在生成时不要收尾：Grok 常在思考结束、工具暗号写完后停一两秒再写正文。
    // 只有思考区、没有正文时继续等，避免把思考过程当成最终回复。
    const hasToolDraft = looksLikeIncompleteToolCall(delta.innerText) || String(delta.innerText || '').includes(TOOL_CALL_OPEN)
    if (delta.markdown || hasToolDraft) {
      const signature = `${delta.markdown}||${delta.innerText}`
      const previous = `${latestDelta.markdown}||${latestDelta.innerText}`
      if (signature === previous) stableCount += 1
      else {
        latestDelta = delta
        stableCount = 0
      }
      const incomplete = looksLikeIncompleteToolCall(latestDelta.markdown) || looksLikeIncompleteToolCall(latestDelta.innerText)
      const thinkingOnly = isWebThinkingPlaceholder(latestDelta.markdown)
        && isWebThinkingPlaceholder(latestDelta.innerText)
      const unfinishedImage = await hasUnfinishedAssistantImages(page)
      if (!unfinishedImage && shouldSettleWebReply({
        incomplete,
        thinkingOnly,
        stableCount,
        generating: state.generating,
        textLength: String(latestDelta.markdown || latestDelta.innerText || '').trim().length
      })) {
        waitDiagnostics = null
        return latestDelta
      }
    }
    if (shouldAcceptStoppedWebReply(idleTicks, 3, sawGenerating)) {
      waitDiagnostics = null
      return latestDelta
    }
    await page.waitForTimeout(1000)
  }

  // 超时：附带页面诊断，方便定位真实 DOM
  let diagnostic = ''
  try {
    diagnostic = await page.evaluate(() => {
      const info = { url: location.href, title: document.title }
      info.bodyHasMarkdown = !!document.querySelector('[data-testid="assistant-message"], [class*="markdown"]')
      const markdownClasses = new Set()
      document.querySelectorAll('[class*="markdown" i]').forEach(node => {
        String(node.className || '').split(/\s+/).forEach(cls => { if (/markdown/i.test(cls)) markdownClasses.add(cls) })
      })
      info.markdownClasses = Array.from(markdownClasses).slice(0, 10)
      info.markdownCount = document.querySelectorAll('[class*="markdown" i]').length
      const composers = []
      document.querySelectorAll('textarea, [contenteditable="true"]').forEach(node => {
        const rect = node.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          composers.push({
            tag: node.tagName.toLowerCase(),
            placeholder: String(node.getAttribute('placeholder') || '').slice(0, 40),
            hasText: !!String(node.value || node.textContent || '').trim(),
            textLen: String(node.value || node.textContent || '').trim().length
          })
        }
      })
      info.composers = composers.slice(0, 5)
      info.buttonLabels = Array.from(document.querySelectorAll('button')).map(b => b.getAttribute('aria-label')).filter(Boolean).slice(0, 10)
      return info
    }).catch(() => null)
  } catch (_) { /* ignore */ }
  const harvested = await harvestCapturedWebReply({
    latestDelta,
    page,
    baseline,
    readAssistantState,
    extractReplyDelta
  })
  if (harvested) {
    waitDiagnostics = null
    return harvested
  }
  const detail = diagnostic ? `（页面诊断：${JSON.stringify(diagnostic)}）` : ''
  throw Object.assign(new Error(`等待 Grok 网页回复超时。${detail}`), { code: 'CHAT_TIMEOUT' })
}

async function runWebChat(body = {}, sessionKey = 'default', projectId = '', signal = null, bridgeMode = '') {
  const passthrough = isWebBridgePassthroughMode(bridgeMode)
  const lane = getWebBridgeAgentLane({ body, tools: body.tools, bridgeMode })
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('登录浏览器仍在打开。请完成登录并关闭整个专用 Chrome 窗口后再聊天。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  const inputMessages = normalizeWebChatMessages(body)
  if (!hasWebBridgeSendableSourceMessage(inputMessages)) {
    throw Object.assign(new Error('缺少可发送的用户消息。'), { code: 'MISSING_MESSAGES' })
  }
  const requestDigest = getWebChatRequestDigest(body)
  activeJob = true
  activeJobType = 'chat'
  try {
    const session = await getChatSessionPage(sessionKey, projectId, lane)
    if (session.requestDigest === requestDigest && session.result) return session.result
    const continuation = getContinuationMessages(inputMessages, session.inputMessages, session.result)
    let resumedThread = !!session.initialized
    if (!session.initialized) {
      const savedUrl = session.conversationUrl || readSavedConversationUrl(sessionKey, projectId, lane)
      const prepared = await prepareSessionWebChat(session.page, savedUrl, { forceNew: lane !== 'lingxi' && !savedUrl })
      session.initialized = true
      resumedThread = prepared.resumed
      if (isGrokConversationUrl(session.page.url())) {
        session.conversationUrl = session.page.url()
      }
    } else {
      if (session.conversationUrl && session.page.url() !== session.conversationUrl && isGrokConversationUrl(session.conversationUrl)) {
        await session.page.goto(session.conversationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      }
      const state = await waitForComposer(session.page, 20000)
      if (!state.composerFound) {
        const currentUrl = session.conversationUrl || session.page.url()
        if (isGrokConversationUrl(currentUrl)) {
          await session.page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        }
        const recovered = await waitForComposer(session.page, 20000)
        if (!recovered.composerFound) {
          throw Object.assign(new Error('当前 Grok 对话页无法继续输入。请检查网页状态后重试；灵犀没有新建其他对话。'), { code: 'CHAT_PAGE_NOT_READY' })
        }
      }
      resumedThread = true
    }
    const plan = resolveWebChatPromptPlan({ resumedThread, inputMessages, continuation })
    await showExternalPage(session.page)
    throwIfWebChatAborted(signal)
    const prompt = buildWebChatPrompt(body, plan.promptMessages, plan.promptMode, { passthrough })
    const baseline = await readAssistantState(session.page)
    const imageBaseline = new Set((await listCandidateImages(session.page)).map(item => item.src))
    await fillAndSubmitPrompt(session.page, prompt)
    const answerState = await waitForAssistantReply(session.page, baseline, CHAT_TIMEOUT_MS, signal)
    const rawAnswer = String(answerState.markdown || answerState.innerText || '').trim()
    let answer = sanitizeWebBridgeCapturedReply(rawAnswer)
    let toolCalls = []
    let parseError = null
    const toolSources = [...new Set([rawAnswer, answerState.innerText, answer].filter(Boolean))]
    for (const source of toolSources) {
      try {
        const parsed = parseLingxiToolCalls(source, body.tools, { passthrough })
        toolCalls = parsed
        if (parsed.length) break
      } catch (error) {
        parseError = error
      }
    }
    const stoppedIncomplete = looksLikeIncompleteToolCall(answer) || looksLikeIncompleteToolCall(answerState.innerText)
    if (!toolCalls.length && looksLikeWebBridgeToolProtocol(answer || answerState.innerText) && !parseError) {
      parseError = Object.assign(new Error('网页模型返回了不完整的灵犀工具调用，已拒绝执行。'), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
    }
    if (!toolCalls.length && parseError?.code === 'INVALID_TOOL_CALL_PROTOCOL' && stoppedIncomplete && !looksLikeWebBridgeToolProtocol(answer || answerState.innerText)) {
      parseError = null
    }
    if (!toolCalls.length && parseError?.code === 'INVALID_TOOL_CALL_PROTOCOL') {
      if (!shouldRetryWebBridgeToolProtocol({
        userText: getLatestWebUserText(inputMessages),
        answer: answer || answerState.innerText,
        dialect: passthrough ? WEB_BRIDGE_DIALECT_JSON_FENCE : ''
      })) {
        parseError = null
      } else {
        throwIfWebChatAborted(signal)
        const retryBaseline = await readAssistantState(session.page)
        await fillAndSubmitPrompt(session.page, buildWebToolProtocolRetryPrompt(parseError.message, { passthrough, tools: body.tools }))
        const retryState = await waitForAssistantReply(session.page, retryBaseline, CHAT_TIMEOUT_MS, signal)
        const retryAnswer = String(retryState.markdown || retryState.innerText || '').trim()
        answer = retryAnswer
        parseError = null
        toolCalls = []
        const retrySources = [...new Set([retryState.innerText, retryAnswer].filter(Boolean))]
        for (const source of retrySources) {
          try {
            const parsed = parseLingxiToolCalls(source, body.tools, { passthrough })
            toolCalls = parsed
            if (parsed.length) break
          } catch (error) {
            parseError = error
          }
        }
      }
    }
    if (!toolCalls.length && parseError) throw parseError
    if (!toolCalls.length) {
      const captured = await captureReplyImages(session.page, imageBaseline, answer)
      const saved = await saveCapturedImages(session.page, captured)
      if (saved.length) answer = appendCapturedImagesToAnswer(answer, saved)
    }
    // 结构修复（方案 2）：当回复里同时包含普通文本与工具调用时，把工具标记之外的
    // 文本也作为 content 返回，让上层既能拿到这一轮的"中间答复"，又能在工具结果
    // 回灌后继续推进。否则旧版会在 toolCalls.length > 0 时把 content 强制清空，
    // 网页那一长段文字被丢弃，软件也只能停在"等下一次工具结果"这一步。
    const visibleText = toolCalls.length
      ? stripWebBridgeToolCallMarkers(stripLingxiToolCallMarkers(answer))
      : (looksLikeWebBridgeToolProtocol(answer) ? '' : answer)
    const result = {
      content: String(visibleText || '').trim(),
      toolCalls,
      rawAnswer: answer
    }
    session.requestDigest = requestDigest
    session.result = result
    session.inputMessages = inputMessages
    if (isGrokConversationUrl(session.page.url())) {
      session.conversationUrl = session.page.url()
      persistConversationUrl(sessionKey, session.conversationUrl, projectId || session.projectId, lane)
    }
    session.lastUsed = Date.now()
    lastChatAt = Date.now()
    lastError = ''
    return result
  } finally {
    activeJob = false
    activeJobType = ''
  }
}

function estimateUsage(messages, answer) {
  const inputChars = normalizeWebChatMessages({ messages }).reduce((sum, message) => {
    return sum + compactWebTranscriptContent(message.role, message.content).length
  }, 0)
  const outputChars = String(answer || '').length
  const promptTokens = Math.ceil(inputChars / 4)
  const completionTokens = Math.ceil(outputChars / 4)
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
}

function writeSse(res, payload) {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

function beginWebChatStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive'
  })
  res.write(': connected\n\n')
}

function sendWebChatResult(res, pathname, body, result) {
  const normalizedResult = typeof result === 'string'
    ? { content: result, toolCalls: [], rawAnswer: result }
    : { content: String(result?.content || ''), toolCalls: Array.isArray(result?.toolCalls) ? result.toolCalls : [], rawAnswer: String(result?.rawAnswer || result?.content || '') }
  const answer = normalizedResult.content
  const toolCalls = normalizedResult.toolCalls
  const id = pathname.endsWith('/responses') ? `resp_${Date.now()}` : `chatcmpl_${Date.now()}`
  const usage = estimateUsage(normalizeWebChatMessages(body), normalizedResult.rawAnswer)
  if (body.stream === true) {
    if (!res.headersSent) beginWebChatStream(res)
    if (pathname.endsWith('/responses')) {
      writeSse(res, { type: 'response.created', response: { id, object: 'response', status: 'in_progress' } })
      if (toolCalls.length) {
        toolCalls.forEach((call, index) => {
          const item = { id: `fc_${call.id}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.function.name, arguments: call.function.arguments }
          writeSse(res, { type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '' } })
          writeSse(res, { type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: call.function.arguments })
          writeSse(res, { type: 'response.output_item.done', output_index: index, item })
        })
      } else {
        for (let offset = 0; offset < answer.length; offset += 120) {
          writeSse(res, { type: 'response.output_text.delta', delta: answer.slice(offset, offset + 120) })
        }
        writeSse(res, { type: 'response.output_text.done', text: answer })
      }
      writeSse(res, { type: 'response.completed', response: { id, object: 'response', status: 'completed', output_text: answer, usage } })
    } else {
      writeSse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      if (toolCalls.length) {
        toolCalls.forEach((call, index) => {
          writeSse(res, {
            id,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }] }, finish_reason: null }]
          })
        })
      } else {
        for (let offset = 0; offset < answer.length; offset += 120) {
          writeSse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: answer.slice(offset, offset + 120) }, finish_reason: null }] })
        }
      }
      writeSse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage })
    }
    writeSse(res, '[DONE]')
    res.end()
    return
  }

  if (pathname.endsWith('/responses')) {
    const output = toolCalls.length
      ? toolCalls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' }))
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }]
    sendJson(res, 200, {
      id,
      object: 'response',
      status: 'completed',
      output_text: answer,
      output,
      usage
    })
    return
  }
  sendJson(res, 200, {
    id,
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: toolCalls.length
        ? { role: 'assistant', content: null, tool_calls: toolCalls.map(({ index, ...call }) => call) }
        : { role: 'assistant', content: answer },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop'
    }],
    usage
  })
}

async function generateImage(body = {}) {
  const n = Math.max(1, Number(body.n || 1))
  if (n !== 1) {
    throw Object.assign(new Error('Grok 网页桥接当前一次只支持生成 1 张图片，请设置 n=1。'), { code: 'UNSUPPORTED_N' })
  }
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('登录浏览器仍在打开。请完成登录并关闭整个专用 Chrome 窗口后再生图。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  const prompt = buildImagePrompt(body)
  const page = await launchExternalBrowser()
  activeJob = true
  activeJobType = 'image'
  try {
    await navigateToGrok(page)
    await showExternalPage(page)
    const state = await waitForComposer(page, 25000)
    if (!state.composerFound) {
      await closeExternalBrowser()
      loggedIn = false
      throw Object.assign(new Error('Grok 尚未登录。请在设置中点击第一步，用普通 Chrome 登录 grok.com 并关闭窗口后再重试。'), { code: 'LOGIN_REQUIRED' })
    }
    loggedIn = true
    const baseline = new Set((await listCandidateImages(page)).map(item => item.src))
    await fillAndSubmitPrompt(page, prompt)
    const images = await waitForGeneratedImages(page, baseline)
    const buffer = await readImageBuffer(page, images[0].src)
    lastGeneratedAt = Date.now()
    lastError = ''
    return {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: buffer.toString('base64') }]
    }
  } finally {
    activeJob = false
    activeJobType = ''
  }
}

function enqueueBridgeJob(job) {
  queueDepth += 1
  const run = queueTail.catch(() => {}).then(job)
  queueTail = run.then(() => undefined, () => undefined).finally(() => {
    queueDepth = Math.max(0, queueDepth - 1)
  })
  return run
}

function enqueueWebChat(body, sessionKey, projectId, signal, bridgeMode = '') {
  return enqueueBridgeJob(() => runWebChat(body, sessionKey, projectId, signal, bridgeMode))
}

function enqueueGeneration(body) {
  return enqueueBridgeJob(() => generateImage(body))
}

async function handleRequest(req, res) {
  if (!isLoopbackRequest(req)) {
    sendError(res, 403, 'LOOPBACK_ONLY', '该服务仅允许本机访问。')
    return
  }

  const origin = String(req.headers.origin || '')
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) || origin === 'null') {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Lingxi-Project-Id, X-Lingxi-Session-Id, X-Lingxi-Bridge-Mode')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const requestUrl = new URL(req.url || '/', getBaseUrl())
  const pathname = requestUrl.pathname.replace(/\/+$/, '') || '/'
  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, getStatus())
    return
  }

  if (!isAuthorized(req)) {
    sendError(res, 401, 'UNAUTHORIZED', '本地 Grok 网关密钥无效。请在设置中重新添加网页模型。')
    return
  }

  if (req.method === 'GET' && pathname === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: [
        { id: 'grok-web-chat', object: 'model', owned_by: 'local' },
        { id: 'grok-web-image', object: 'model', owned_by: 'local' }
      ]
    })
    return
  }
  if (req.method === 'POST' && pathname === '/session/open') {
    sendJson(res, 200, await openLoginWindow())
    return
  }
  if (req.method === 'POST' && pathname === '/session/check') {
    sendJson(res, 200, await checkLoginStatus())
    return
  }
  if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/v1/responses')) {
    let heartbeat = null
    const abortController = new AbortController()
    attachWebChatAbort(req, res, abortController)
    try {
      const body = await readJsonBody(req)
      if (body.stream === true) {
        beginWebChatStream(res)
        heartbeat = setInterval(() => {
          if (!res.writableEnded) res.write(': heartbeat\n\n')
        }, 15000)
      }
      const projectId = String(req.headers['x-lingxi-project-id'] || body.metadata?.project_id || '').trim()
      const bridgeMode = resolveWebBridgeApiMode({
        headers: req.headers,
        body,
        queryMode: requestUrl.searchParams.get('mode')
      })
      const sessionKey = getChatSessionKey(req, body, bridgeMode)
      const answer = await enqueueWebChat(body, sessionKey, projectId, abortController.signal, bridgeMode)
      if (heartbeat) clearInterval(heartbeat)
      sendWebChatResult(res, pathname, body, answer)
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat)
      if (error?.code === 'CHAT_ABORTED') {
        if (!res.writableEnded) {
          if (res.headersSent) {
            writeSse(res, '[DONE]')
            res.end()
          }
        }
        return
      }
      lastError = sanitizeErrorMessage(error, '网页聊天失败。')
      const code = error?.code || 'CHAT_FAILED'
      const status = ['LOGIN_REQUIRED', 'LOGIN_BROWSER_STILL_OPEN', 'BRIDGE_BUSY'].includes(code) ? 409
        : ['INVALID_JSON', 'MISSING_MESSAGES', 'BODY_TOO_LARGE'].includes(code) ? 400
          : code === 'CHAT_TIMEOUT' ? 504 : 502
      if (res.headersSent) {
        writeSse(res, { error: { type: 'grok_web_bridge_error', code, message: lastError } })
        writeSse(res, '[DONE]')
        res.end()
      } else {
        sendError(res, status, code, lastError)
      }
    }
    return
  }

  if (req.method === 'POST' && pathname === '/v1/images/generations') {
    try {
      const body = await readJsonBody(req)
      const result = await enqueueGeneration(body)
      sendJson(res, 200, result)
    } catch (error) {
      lastError = sanitizeErrorMessage(error, '网页生图失败。')
      const code = error?.code || 'GENERATION_FAILED'
      const status = ['LOGIN_REQUIRED', 'LOGIN_BROWSER_STILL_OPEN', 'BRIDGE_BUSY', 'UNSUPPORTED_N'].includes(code) ? 409
        : ['INVALID_JSON', 'MISSING_PROMPT', 'BODY_TOO_LARGE'].includes(code) ? 400
          : code === 'GENERATION_TIMEOUT' ? 504 : 502
      sendError(res, status, code, lastError)
    }
    return
  }

  sendError(res, 404, 'NOT_FOUND', '接口不存在。')
}

async function startServer() {
  if (server) return getStatus()
  const config = loadConfig()
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      lastError = sanitizeErrorMessage(error, '本地 Grok 网关发生错误。')
      if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', lastError)
      else res.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  console.log(`[GrokWebBridge] listening on ${getBaseUrl()}`)
  return getStatus()
}

async function stopServer() {
  if (!server) return
  const closingServer = server
  server = null
  await new Promise(resolve => closingServer.close(() => resolve()))
}

async function closeExternalBrowser() {
  const browser = bridgeBrowser
  const child = launchedBrowserProcess
  launchedBrowserProcess = null
  clearBrowserReferences()
  if (browser?.isConnected()) {
    await withTimeout(browser.close(), 3000, '关闭测试浏览器超时。').catch(() => {})
  }
  if (child?.pid) {
    try { process.kill(child.pid, 'SIGKILL') } catch (_) { /* browser already closed */ }
  }
}

async function closeLoginBrowser() {
  const child = loginBrowserProcess
  loginBrowserProcess = null
  if (child?.pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else process.kill(child.pid, 'SIGKILL')
    } catch (_) { /* browser already closed */ }
  }
}

function registerIPC(ipcMain) {
  ipcMain.handle('grok-web-bridge:status', async () => {
    if (!server) await startServer()
    return getStatus()
  })
  ipcMain.handle('grok-web-bridge:open-login', async () => {
    if (!server) await startServer()
    return openLoginWindow()
  })
  ipcMain.handle('grok-web-bridge:check-login', async () => {
    if (!server) await startServer()
    return checkLoginStatus()
  })
  ipcMain.handle('grok-web-bridge:suggested-chat-model', async () => {
    if (!server) await startServer()
    return { success: true, model: getSuggestedChatModel(), status: getStatus() }
  })
  ipcMain.handle('grok-web-bridge:suggested-model', async () => {
    if (!server) await startServer()
    return { success: true, model: getSuggestedModel(), status: getStatus() }
  })
  ipcMain.handle('grok-web-bridge:dump-reply-dom', async () => {
    if (!server) await startServer()
    if (!isBrowserConnected() || !bridgePage || bridgePage.isClosed()) {
      return { success: false, error: '自动化浏览器未连接。请先完成登录检查。' }
    }
    try {
      const dom = await bridgePage.evaluate(() => {
        const selectors = ['[data-testid="assistant-message"]', '.markdown', '[class*="markdown"]', '.prose']
        const all = selectors.reduce((acc, sel) => {
          if (acc.length) return acc
          return Array.from(document.querySelectorAll(sel))
        }, [])
        const latest = all.at(-1)
        function describe(node, depth = 0) {
          if (depth > 12) return []
          const out = []
          for (const child of node.childNodes || []) {
            if (child.nodeType === 3) {
              const t = String(child.textContent || '').trim()
              if (t) out.push({ depth, type: 'text', text: t.slice(0, 60) })
            } else if (child.nodeType === 1) {
              const cls = typeof child.className === 'string' ? child.className : ''
              out.push({ depth, type: child.tagName.toLowerCase(), cls: cls.slice(0, 80) })
              out.push(...describe(child, depth + 1))
            }
          }
          return out
        }
        // 抓输入框容器内所有可点击元素的完整信息（发送/停止按钮）
        const buttons = []
        const composerEl = document.querySelector('textarea, [contenteditable="true"]')
        let scope = composerEl
        for (let i = 0; i < 4 && scope && scope.parentElement; i += 1) {
          const parent = scope.parentElement
          const cls = typeof parent.className === 'string' ? parent.className : ''
          if (cls && /send|composer|chat-input|input|editor|footer|toolbar/i.test(cls)) { scope = parent; break }
          scope = parent
        }
        if (!scope) scope = document.body
        const candidates = Array.from(scope.querySelectorAll('[role="button"], button, [tabindex], [contenteditable="false"][class*="button"]'))
        for (const node of candidates) {
          const rect = node.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          const cls = typeof node.className === 'string' ? node.className : ''
          if (!/button|btn|send|stop|submit/i.test(cls + ' ' + (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('role') || ''))) continue
          const svg = node.querySelector('svg')
          const svgHtml = svg ? svg.outerHTML.slice(0, 300) : ''
          buttons.push({
            tag: node.tagName.toLowerCase(),
            role: String(node.getAttribute('role') || ''),
            cls: cls.slice(0, 120),
            ariaLabel: String(node.getAttribute('aria-label') || '').slice(0, 60),
            title: String(node.getAttribute('title') || '').slice(0, 60),
            svgShape: svgHtml
          })
        }
        // 扫描页面上所有可能的回复/思考/代码容器，统计数量和 class
        const containerClasses = new Map()
        document.querySelectorAll('[class*="message"], [class*="assistant"], [class*="thinking"], [class*="reasoning"], [class*="markdown"], [class*="code-block"], [class*="md-code"]').forEach(node => {
          const cls = String(node.className || '')
          if (!cls) return
          const key = cls.split(/\s+/).slice(0, 3).join(' ')
          containerClasses.set(key, (containerClasses.get(key) || 0) + 1)
        })
        const allContainers = Array.from(containerClasses.entries())
          .map(([cls, count]) => ({ cls: cls.slice(0, 100), count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 30)
        return {
          found: !!latest,
          containerTag: latest ? latest.tagName.toLowerCase() : '',
          containerClass: latest ? String(latest.className || '').slice(0, 120) : '',
          composerTag: composerEl ? composerEl.tagName.toLowerCase() : '',
          composerClass: composerEl ? String(composerEl.className || '').slice(0, 120) : '',
          allContainers,
          tree: latest ? describe(latest).slice(0, 40) : [],
          buttons: buttons.slice(0, 15)
        }
      })
      return { success: true, dom }
    } catch (error) {
      return { success: false, error: sanitizeErrorMessage(error, '抓取 DOM 失败。') }
    }
  })

  startServer().catch(error => {
    lastError = error?.code === 'EADDRINUSE'
      ? `本地端口 ${loadConfig().port} 已被其他程序占用。`
      : sanitizeErrorMessage(error, '本地 Grok 网关启动失败。')
    console.warn('[GrokWebBridge] start failed:', lastError)
    server = null
  })
}

if (app && typeof app.on === 'function') {
  app.on('before-quit', () => {
    if (server) server.close()
    server = null
    clearBrowserReferences()
  })
}

module.exports = {
  registerIPC,
  startServer,
  stopServer,
  getStatus,
  getSuggestedChatModel,
  getSuggestedModel,
  buildWebChatPrompt,
  normalizeWebChatMessages,
  normalizeWebTools,
  parseLingxiToolCalls,
  extractReplyDelta,
  repairLooseJson,
  tryExtractLingxiCallsLoose,
  getContinuationMessages,
  getWebChatRequestDigest,
  sendWebChatResult,
  isLoopbackRequest,
  getBrowserCandidates,
  findBrowserExecutable,
  getBrowserProfileDir,
  openLoginWindow,
  closeExternalBrowser,
  closeLoginBrowser
}
