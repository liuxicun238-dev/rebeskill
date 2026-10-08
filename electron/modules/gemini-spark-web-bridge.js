/**
 * Gemini Spark 远程 Agent 本地桥。
 *
 * 与 gemini-web-bridge（/app 聊天）隔离：打开 /spark，不注入灵犀工具协议，
 * 不解析 function_call。登录资料与其它网页桥共用同一份专用 Chrome。
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
  throwIfWebChatAborted,
  takeUsableWebReplyIfAborted,
  isStaleWebBridgeHarvest,
  extractWebBridgeReplyDelta,
  attachWebChatAbort,
  didWebPromptLeaveComposer,
  nextWebGenerationIdleTicks,
  noteWebGenerationStarted,
  shouldAcceptStoppedWebReply,
  isWebThinkingPlaceholder,
  normalizeSavedConversations,
  rememberSavedConversation,
  getSavedConversationUrl,
  pickReusableWebChatPage,
  buildWebChatSessionKey
} = require('./web-bridge-coding-protocol')
const {
  getSharedWebBridgeProfileDir,
  listSharedWebBridgeDebugPorts,
  shouldUseWebBridgeHeadless,
  getWebBridgeAutomationLaunchFlags,
  syncWebBridgeAutomationProcess,
  applyWebBridgePageVisibility
} = require('./web-bridge-chrome-profile')
const { extractGeminiAssistantState } = require('./gemini-web-bridge')
const {
  extractSparkUserTask,
  looksLikeGoogleAccountValidation,
  classifySparkPageAccess,
  isGoogleLoginUrl,
  buildSparkAgentPrompt,
  resolveSparkProjectPath
} = require('./gemini-spark-task')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3225
const SPARK_URL = 'https://gemini.google.com/u/1/spark?pli=1'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const CHAT_TIMEOUT_MS = 20 * 60 * 1000
const DEVTOOLS_CONNECT_TIMEOUT_MS = 45000
const AUTOMATION_DEBUG_PORT = 19335
const MAX_CHAT_SESSION_PAGES = 4

const COMPOSER_SELECTORS = [
  '[role="textbox"][contenteditable="true"][aria-label*="Spark"]',
  '[role="textbox"][contenteditable="true"][aria-label*="Gemini"]',
  '[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"][data-placeholder*="Spark"]',
  '[contenteditable="true"][data-placeholder*="Gemini"]',
  '[contenteditable="true"][aria-label*="Ask"]',
  '[contenteditable="true"][aria-label*="follow"]',
  '[contenteditable="true"][aria-label*="继续"]',
  '[contenteditable="true"][aria-label*="提问"]',
  'rich-textarea .ql-editor[contenteditable="true"]',
  '.text-input-field .ql-editor[contenteditable="true"]',
  '.ql-editor[contenteditable="true"]',
  '[contenteditable="true"]',
  'textarea'
]

const SUBMIT_SELECTORS = [
  'button.send-button',
  'button[data-test-id="send-button"]',
  'button[aria-label*="Send message"]',
  'button[aria-label*="发送消息"]',
  'button[aria-label="Send"]',
  'button[aria-label="发送"]',
  'button[aria-label*="Start"]',
  'button[aria-label*="开始"]',
  'button[aria-label*="Run"]',
  'button[aria-label*="Ask"]',
  '.text-input-field button[class*="send"]',
  'input-area-v2 button[class*="send"]',
  'button[type="submit"]'
]

const SPARK_REPLY_SELECTORS = [
  '[class*="spark"] [class*="markdown"]',
  '[class*="agent"] [class*="markdown"]',
  '[data-test-id*="agent-response"]',
  'model-response .model-response-text',
  '.model-response-text',
  'model-response .markdown-main-panel',
  'model-response',
  '.response-container',
  'article',
  '[role="article"]'
]

const SPARK_COMPOSER_REVEAL_NAMES = /follow.?up|ask a follow|continue|new task|keep going|继续(提问|任务)?|追问|新任务|再问/i

const SPARK_TURN_SELECTORS = [
  'model-response',
  '.model-response',
  '[data-test-id="model-response"]',
  '[class*="agent-turn"]',
  '[class*="spark-turn"]',
  '.response-container',
  'article'
]

let server = null
let bridgeConfig = null
let bridgeBrowser = null
let bridgeContext = null
let bridgePage = null
let launchedBrowserProcess = null
let loginBrowserProcess = null
let browserExecutable = ''
let queueTail = Promise.resolve()
let queueDepth = 0
let activeJob = false
let lastError = ''
let lastChatAt = 0
let loggedIn = null
let waitDiagnostics = null
const chatSessions = new Map()

function getConfigPath() {
  return path.join(app.getPath('userData'), 'gemini-spark-web-bridge.json')
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

  const environmentPort = Number(process.env.LINGXI_GEMINI_SPARK_WEB_BRIDGE_PORT)
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

function getSuggestedAgentModel() {
  const config = loadConfig()
  return {
    provider: 'gemini-spark-web-bridge',
    modelName: 'Gemini Spark Agent（本地 Chrome）',
    modelId: 'gemini-spark-agent',
    apiUrl: `${getBaseUrl()}/v1`,
    apiKey: config.apiKey,
    apiFormat: 'openai',
    useFullUrl: false,
    contextWindow: 1000000,
    capabilities: {
      text: true,
      vision: false,
      imageGeneration: false,
      musicGeneration: false,
      videoGeneration: false,
      speechSynthesis: false,
      toolCalling: false
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
      type: 'gemini_spark_web_bridge_error',
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
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge')
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
    activeJobType: activeJob ? 'spark-agent' : '',
    chatSessionCount: chatSessions.size,
    lastError,
    lastChatAt,
    waitDiagnostics,
    sparkUrl: SPARK_URL
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

function isSparkPageUrl(url = '') {
  try {
    const parsed = new URL(String(url || ''))
    if (!/(^|\.)gemini\.google\.com$/i.test(parsed.hostname)) return false
    return /(?:^|\/)spark(?:\/|$)/i.test(parsed.pathname)
  } catch (_) {
    return /gemini\.google\.com\/(?:u\/\d+\/)?spark/i.test(String(url || ''))
  }
}

async function connectToExternalBrowser(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 })
  bridgeBrowser = browser
  bridgeContext = browser.contexts()[0] || null
  if (!bridgeContext) throw new Error('无法取得外部浏览器上下文。')
  const pages = bridgeContext.pages().filter(page => !page.isClosed())
  bridgePage = pages.find(page => isSparkPageUrl(page.url()))
    || pages.find(page => /gemini\.google\.com/i.test(page.url()))
    || pages[0]
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
      throw Object.assign(new Error('专用 Chrome 已经打开，但软件连不上调试端口。请先关掉这个专用 Chrome 窗口，再重新发送一次。'), {
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
    } catch (_) { /* ignore */ }
  }

  const args = [
    ...getWebBridgeAutomationLaunchFlags(options),
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${AUTOMATION_DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    SPARK_URL
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
    throw Object.assign(new Error('当前正在 Spark 任务中，完成后才能重新打开登录浏览器。'), { code: 'BRIDGE_BUSY' })
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
  } catch (_) { /* ignore */ }

  const child = spawn(executablePath, [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--new-window',
    SPARK_URL
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

async function navigateToSpark(page) {
  if (!page || page.isClosed()) throw Object.assign(new Error('外部浏览器页面已关闭。'), { code: 'BROWSER_CLOSED' })
  if (isSparkPageUrl(page.url()) && !/accounts\.google\.com|\/signin/i.test(page.url())) return
  await page.goto(SPARK_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
}

async function showExternalPage(page, options = {}) {
  if (!page || page.isClosed()) return
  await applyWebBridgePageVisibility(page, bridgeContext, {
    forceVisible: options.forceVisible === true,
    withTimeout
  })
}

async function inspectPageState(page = bridgePage) {
  if (!page || page.isClosed()) {
    loggedIn = null
    return { loggedIn: null, composerFound: false, url: '', validationBlocked: false, loginVisible: false }
  }
  const url = page.url()
  try {
    const composer = await findComposer(page)
    const onLogin = isGoogleLoginUrl(url)
    let loginVisible = onLogin
    let bodyText = ''
    let title = ''
    try {
      const extra = await withTimeout(page.evaluate(() => ({
        bodyText: String(document.body?.innerText || '').slice(0, 4000),
        title: document.title
      })), 5000, '读取 Spark 页面状态超时。')
      bodyText = extra?.bodyText || ''
      title = extra?.title || ''
    } catch (_) { /* 输入框探测已经完成 */ }
    if (!composer && !onLogin) {
      const loginBtn = page.getByRole('button', { name: /^(log in|sign in|sign up|登录|注册|sign in with google)$/i })
      const loginLink = page.locator('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/signin"]')
      loginVisible = ((await loginBtn.count().catch(() => 0)) > 0 && await loginBtn.first().isVisible().catch(() => false))
        || ((await loginLink.count().catch(() => 0)) > 0 && await loginLink.first().isVisible().catch(() => false))
    }
    const validationBlocked = looksLikeGoogleAccountValidation(`${bodyText}\n${title}`)
    const composerFound = !!composer && !onLogin
    const access = classifySparkPageAccess({ url, composerFound, loginVisible, validationBlocked })
    loggedIn = access.loggedIn === true
    return {
      composerFound,
      loginVisible,
      bodyText,
      title,
      url,
      loggedIn,
      validationBlocked,
      accessCode: access.code
    }
  } catch (error) {
    loggedIn = null
    return { loggedIn: null, composerFound: false, url, error: error.message, validationBlocked: false, loginVisible: false }
  }
}

async function waitForComposer(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  let lastRevealAt = 0
  while (Date.now() < deadline) {
    state = await inspectPageState(page)
    if (state.validationBlocked || isGoogleLoginUrl(state.url)) return state
    if (state.composerFound) return state
    if (Date.now() - lastRevealAt > 4000) {
      lastRevealAt = Date.now()
      await tryRevealSparkComposer(page)
    }
    await new Promise(resolve => setTimeout(resolve, 800))
  }
  return state || { loggedIn: false, composerFound: false, validationBlocked: false, url: page?.url?.() || '' }
}

async function tryRevealSparkComposer(page) {
  if (!page || page.isClosed()) return false
  const labeled = page.getByRole('button', { name: SPARK_COMPOSER_REVEAL_NAMES })
  const count = await labeled.count().catch(() => 0)
  for (let index = 0; index < Math.min(count, 4); index += 1) {
    const button = labeled.nth(index)
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 2000 }).catch(() => {})
      return true
    }
  }
  return false
}

function throwIfSparkBlocked(state) {
  const access = classifySparkPageAccess(state)
  if (access.code === 'ACCOUNT_VALIDATION') {
    throw Object.assign(new Error('Google 无法验证当前账号信息。Spark 车道过不了这道门，请换稳定代理出口后重试，或改用其它模型。'), {
      code: 'ACCOUNT_VALIDATION'
    })
  }
  if (access.code === 'LOGIN_REQUIRED') {
    throw Object.assign(new Error('Gemini Spark 尚未登录。请先在设置中完成网页登录检查。'), { code: 'LOGIN_REQUIRED' })
  }
}

async function ensureSparkComposer(page, { initialized = false } = {}) {
  await showExternalPage(page)
  if (!initialized || !isSparkPageUrl(page.url()) || isGoogleLoginUrl(page.url())) {
    await navigateToSpark(page)
  }
  const firstWait = initialized ? 45000 : 20000
  let ready = await waitForComposer(page, firstWait)
  if (!ready.composerFound && !ready.validationBlocked && !isGoogleLoginUrl(ready.url)) {
    await tryRevealSparkComposer(page)
    ready = await waitForComposer(page, 15000)
  }
  throwIfSparkBlocked(ready)
  if (!ready.composerFound) {
    throw Object.assign(new Error('Spark 页面还没有出现输入框。上一轮任务可能仍在页面上运行。请打开「显示浏览器」查看 Spark，或等当前任务结束后再发。'), {
      code: 'COMPOSER_NOT_READY'
    })
  }
  return ready
}

async function openLoginWindow() {
  const status = await launchNormalLoginBrowser()
  return {
    success: true,
    ...status,
    instruction: '请在普通 Chrome 中打开 Gemini Spark 并完成 Google 登录。登录成功后关闭整个专用 Chrome 窗口，再点击“登录完成后检查”。'
  }
}

async function checkLoginStatus() {
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('请先完成登录并关闭整个专用 Chrome 窗口，然后再点击检查。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  const page = await launchExternalBrowser()
  await navigateToSpark(page)
  await showExternalPage(page)
  const state = await waitForComposer(page, 12000)
  if (state.validationBlocked) {
    loggedIn = false
    return {
      success: true,
      ...getStatus(),
      page: state,
      instruction: '页面提示无法验证账号信息。请保持 Clash 开着并锁定同一出口节点，完成 Google 验证后再检查。'
    }
  }
  if (!state.composerFound || state.loginVisible) {
    await closeExternalBrowser()
    loggedIn = false
    return {
      success: true,
      ...getStatus(),
      page: state,
      instruction: '没有检测到 Spark 输入框。请重新点击第一步，在普通 Chrome 中登录 Spark 并关闭窗口后再检查。'
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
      if (await locator.isVisible().catch(() => false)) return locator
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
    const texts = nodes.map(el => String(el.innerText || el.textContent || el.value || '').replace(/\u00a0/g, ' ').trim())
      .filter(text => text)
    texts.sort((a, b) => b.length - a.length)
    return texts[0] || ''
  }, COMPOSER_SELECTORS).catch(() => '')
}

async function fillSparkComposer(page, prompt) {
  return page.evaluate(text => {
    const composer = document.querySelector('[role="textbox"][contenteditable="true"]')
      || document.querySelector('.ql-editor[contenteditable="true"]')
      || document.querySelector('textarea')
    if (!composer) throw new Error('composer missing')
    composer.focus()
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const proto = composer.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && typeof desc.set === 'function') desc.set.call(composer, text)
      else composer.value = text
      composer.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      composer.innerHTML = ''
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      composer.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
      if (!String(composer.innerText || composer.textContent || '').trim()) {
        document.execCommand('selectAll', false, null)
        document.execCommand('insertText', false, text)
      }
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }
    return String(composer.value || composer.innerText || composer.textContent || '').trim().length
  }, prompt)
}

async function composerLooksFilled(page, prompt) {
  const target = String(prompt || '').trim()
  const current = String(await readPageComposerText(page) || '').trim()
  if (current && (current === target || current.includes(target.slice(0, Math.min(80, target.length))))) return true
  return current.length >= Math.min(target.length, Math.floor(target.length * 0.4) || target.length)
}

async function readAssistantState(page) {
  return page.evaluate(extractGeminiAssistantState, {
    replySelectors: SPARK_REPLY_SELECTORS,
    turnSelectors: SPARK_TURN_SELECTORS,
    markdownSelectors: SPARK_REPLY_SELECTORS,
    stopSelectors: [
      'button.stop-button',
      'button[data-test-id*="stop"]',
      'button[aria-label="Stop"]',
      'button[aria-label="停止"]'
    ],
    stopLabelPattern: 'Stop|Stop generating|停止|停止生成',
    detectComposer: true,
    skipThinking: true
  }).catch(() => ({ count: 0, markdown: '', innerText: '', generating: false, composerReady: false, alerts: '', stale: true }))
}

function extractReplyDelta(state, baseline = {}) {
  return extractWebBridgeReplyDelta(state, baseline)
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

async function stopPageGeneration(page) {
  if (!page || page.isClosed()) return false
  const labeled = page.getByRole('button', { name: /^(Stop|Stop generating|停止|停止生成)$/i })
  if (await labeled.count().catch(() => 0) && await labeled.first().isVisible().catch(() => false)) {
    await labeled.first().click({ timeout: 2000 }).catch(() => {})
    return true
  }
  return false
}

async function waitForPromptSubmitted(page, before = {}, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  const baselineCount = Number(before.count || 0)
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
      hadComposerText: true
    })) return true
    await page.waitForTimeout(300)
  }
  return false
}

async function fillAndSubmitPrompt(page, prompt) {
  const idle = await waitForComposerIdle(page, 20000)
  throwIfSparkBlocked(await inspectPageState(page))
  const composer = await findComposer(page)
  if (!composer) throw Object.assign(new Error('没有找到 Spark 输入框，请重新登录。'), { code: 'COMPOSER_NOT_FOUND' })
  await composer.click({ timeout: 8000 }).catch(() => {})
  await fillSparkComposer(page, prompt).catch(() => 0)
  await page.waitForTimeout(250)
  if (!(await composerLooksFilled(page, prompt))) {
    try { await composer.fill(prompt, { timeout: 8000 }) } catch (_) { /* ignore */ }
  }
  if (!(await composerLooksFilled(page, prompt))) {
    throw Object.assign(new Error('Spark 输入框内容为空，填入失败。'), { code: 'COMPOSER_FILL_FAILED' })
  }
  const before = idle || await readAssistantState(page)
  let clicked = false
  for (const selector of SUBMIT_SELECTORS) {
    const button = page.locator(selector).first()
    if (await button.count() && await button.isEnabled().catch(() => false) && await button.isVisible().catch(() => false)) {
      await button.click()
      clicked = true
      break
    }
  }
  if (!clicked) await composer.press('Enter')
  const submitted = await waitForPromptSubmitted(page, before, 8000)
  if (!submitted) {
    await composer.press('Enter').catch(() => {})
    const retried = await waitForPromptSubmitted(page, before, 5000)
    if (!retried) {
      throw Object.assign(new Error('Spark 页面没有发出这条任务。请查看自动化 Chrome 里输入框和发送按钮。'), { code: 'PROMPT_NOT_SENT' })
    }
  }
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
    if (abortedReply) return abortedReply
    if (!page || page.isClosed() || !isBrowserConnected()) {
      throw Object.assign(new Error('任务过程中外部浏览器被关闭。'), { code: 'BROWSER_CLOSED' })
    }
    const pageState = await inspectPageState(page)
    if (pageState.validationBlocked) {
      throw Object.assign(new Error('Google 无法验证当前账号信息，Spark 任务被中断。'), { code: 'ACCOUNT_VALIDATION' })
    }
    const state = await readAssistantState(page)
    sawGenerating = noteWebGenerationStarted(state, sawGenerating)
    idleTicks = nextWebGenerationIdleTicks(state, idleTicks)
    const delta = extractReplyDelta(state, baseline)
    if (isStaleWebBridgeHarvest(delta, baseline)) {
      await page.waitForTimeout(1000)
      continue
    }
    waitDiagnostics = {
      textLen: String(delta.markdown || '').length,
      baselineCount: Number(baseline.count || 0),
      replyCount: Number(state.count || 0),
      generating: state.generating,
      stableCount,
      idleTicks
    }
    if (delta.markdown) {
      const signature = `${delta.markdown}||${delta.innerText}`
      const previous = `${latestDelta.markdown}||${latestDelta.innerText}`
      if (signature === previous) stableCount += 1
      else {
        latestDelta = delta
        stableCount = 0
      }
      const thinkingOnly = isWebThinkingPlaceholder(latestDelta.markdown)
        && isWebThinkingPlaceholder(latestDelta.innerText)
      if (!state.generating && !thinkingOnly && stableCount >= 4) {
        if (!isStaleWebBridgeHarvest(latestDelta, baseline)) {
          const composerDeadline = Math.min(Date.now() + 45000, deadline)
          while (Date.now() < composerDeadline) {
            const pageState = await inspectPageState(page)
            if (pageState.composerFound) {
              waitDiagnostics = null
              return latestDelta
            }
            if (pageState.validationBlocked) {
              throw Object.assign(new Error('Google 无法验证当前账号信息，Spark 任务被中断。'), { code: 'ACCOUNT_VALIDATION' })
            }
            await page.waitForTimeout(1000)
          }
          waitDiagnostics = null
          return latestDelta
        }
      }
    }
    if (shouldAcceptStoppedWebReply(idleTicks, 8, sawGenerating) && latestDelta.markdown) {
      if (!isStaleWebBridgeHarvest(latestDelta, baseline)) {
        const pageState = await inspectPageState(page)
        if (pageState.composerFound) {
          waitDiagnostics = null
          return latestDelta
        }
      }
    }
    await page.waitForTimeout(1200)
  }
  throw Object.assign(new Error('等待 Spark 任务完成超时。'), { code: 'CHAT_TIMEOUT' })
}

function persistConversationUrl(sessionKey, url, projectId = '') {
  if (!sessionKey || !isSparkPageUrl(url)) return
  const config = loadConfig()
  config.conversations = rememberSavedConversation(config.conversations, sessionKey, url, projectId, 'spark-agent')
  writeConfig(config)
}

async function pruneChatSessionPages(keepKey = '') {
  if (chatSessions.size < MAX_CHAT_SESSION_PAGES) return
  const entries = [...chatSessions.entries()]
    .filter(([key]) => key !== keepKey)
    .sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0))
  while (chatSessions.size >= MAX_CHAT_SESSION_PAGES && entries.length) {
    const [key] = entries.shift()
    chatSessions.delete(key)
  }
}

async function getChatSessionPage(sessionKey, projectId = '') {
  await launchExternalBrowser()
  const existing = chatSessions.get(sessionKey)
  if (existing?.page && !existing.page.isClosed()) {
    existing.lastUsed = Date.now()
    return existing
  }
  if (existing) chatSessions.delete(sessionKey)
  await pruneChatSessionPages(sessionKey)
  const savedUrl = getSavedConversationUrl(loadConfig().conversations, sessionKey, projectId, 'spark-agent')
  const pages = (bridgeContext?.pages() || []).filter(page => !page.isClosed() && /gemini\.google\.com/i.test(page.url()))
  const page = pickReusableWebChatPage(pages, { savedUrl, sessionKey, chatSessions }) || await bridgeContext.newPage()
  const session = {
    page,
    lastUsed: Date.now(),
    initialized: false,
    requestDigest: '',
    result: null,
    conversationUrl: savedUrl || '',
    projectId: String(projectId || '')
  }
  chatSessions.set(sessionKey, session)
  page.once('close', () => {
    if (chatSessions.get(sessionKey)?.page === page) chatSessions.delete(sessionKey)
  })
  return session
}

function getSparkRequestDigest(prompt) {
  return crypto.createHash('sha256').update(String(prompt || '')).digest('hex').slice(0, 24)
}

async function runSparkTask(body = {}, sessionKey = 'default', projectId = '', signal = null, projectPath = '') {
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('登录浏览器仍在打开。请完成登录并关闭整个专用 Chrome 窗口后再发送任务。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  const userText = extractSparkUserTask(body)
  if (!userText) {
    throw Object.assign(new Error('缺少可发送的用户任务。'), { code: 'MISSING_MESSAGES' })
  }
  const prompt = buildSparkAgentPrompt({ userText, projectPath })
  const requestDigest = getSparkRequestDigest(prompt)
  activeJob = true
  try {
    const session = await getChatSessionPage(sessionKey, projectId)
    if (session.requestDigest === requestDigest && session.result) return session.result
    await ensureSparkComposer(session.page, { initialized: session.initialized })
    session.initialized = true
    throwIfWebChatAborted(signal)
    const baseline = await readAssistantState(session.page)
    await fillAndSubmitPrompt(session.page, prompt)
    const answerState = await waitForAssistantReply(session.page, baseline, CHAT_TIMEOUT_MS, signal)
    const answer = String(answerState.markdown || answerState.innerText || '').trim()
    if (!answer) throw Object.assign(new Error('Spark 没有返回可读结果。'), { code: 'EMPTY_REPLY' })
    const result = { content: answer, toolCalls: [], rawAnswer: answer }
    session.requestDigest = requestDigest
    session.result = result
    if (isSparkPageUrl(session.page.url())) {
      session.conversationUrl = session.page.url()
      persistConversationUrl(sessionKey, session.conversationUrl, projectId)
    }
    lastChatAt = Date.now()
    lastError = ''
    waitDiagnostics = null
    return result
  } finally {
    activeJob = false
  }
}

function writeSse(res, payload) {
  if (payload === '[DONE]') {
    res.write('data: [DONE]\n\n')
    return
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function beginWebChatStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  })
  res.write(': connected\n\n')
}

function sendSparkResult(res, pathname, body, result) {
  const answer = String(result?.content || '')
  const id = pathname.endsWith('/responses') ? `resp_${Date.now()}` : `chatcmpl_${Date.now()}`
  const usage = { prompt_tokens: 0, completion_tokens: Math.ceil(answer.length / 4), total_tokens: Math.ceil(answer.length / 4) }
  if (body.stream === true) {
    if (!res.headersSent) beginWebChatStream(res)
    if (pathname.endsWith('/responses')) {
      writeSse(res, { type: 'response.created', response: { id, object: 'response', status: 'in_progress' } })
      for (let offset = 0; offset < answer.length; offset += 120) {
        writeSse(res, { type: 'response.output_text.delta', delta: answer.slice(offset, offset + 120) })
      }
      writeSse(res, { type: 'response.output_text.done', text: answer })
      writeSse(res, { type: 'response.completed', response: { id, object: 'response', status: 'completed', output_text: answer, usage } })
    } else {
      writeSse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      for (let offset = 0; offset < answer.length; offset += 120) {
        writeSse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: answer.slice(offset, offset + 120) }, finish_reason: null }] })
      }
      writeSse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
    }
    writeSse(res, '[DONE]')
    res.end()
    return
  }
  if (pathname.endsWith('/responses')) {
    sendJson(res, 200, {
      id,
      object: 'response',
      status: 'completed',
      output_text: answer,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }],
      usage
    })
    return
  }
  sendJson(res, 200, {
    id,
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
    usage
  })
}

function enqueueBridgeJob(job) {
  queueDepth += 1
  const run = queueTail.catch(() => {}).then(job)
  queueTail = run.then(() => undefined, () => undefined).finally(() => {
    queueDepth = Math.max(0, queueDepth - 1)
  })
  return run
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
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Lingxi-Project-Id, X-Lingxi-Session-Id, X-Lingxi-Bridge-Mode, X-Lingxi-Project-Path')
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
    sendError(res, 401, 'UNAUTHORIZED', '本地 Spark 网关密钥无效。请在设置中重新添加 Spark Agent 模型。')
    return
  }
  if (req.method === 'GET' && pathname === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: 'gemini-spark-agent', object: 'model', owned_by: 'local' }]
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
      const sessionId = String(req.headers['x-lingxi-session-id'] || body.metadata?.session_id || 'default').trim()
      const projectPath = resolveSparkProjectPath({
        headerValue: req.headers['x-lingxi-project-path'],
        metadataPath: body.metadata?.project_path
      })
      const sessionKey = buildWebChatSessionKey({ projectId, sessionId, lane: 'spark-agent' })
      const answer = await enqueueBridgeJob(() => runSparkTask(body, sessionKey, projectId, abortController.signal, projectPath))
      if (heartbeat) clearInterval(heartbeat)
      sendSparkResult(res, pathname, body, answer)
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat)
      if (error?.code === 'CHAT_ABORTED') {
        if (res.headersSent && !res.writableEnded) {
          writeSse(res, '[DONE]')
          res.end()
        }
        return
      }
      lastError = sanitizeErrorMessage(error, 'Spark 任务失败。')
      const code = error?.code || 'CHAT_FAILED'
      const status = ['LOGIN_REQUIRED', 'LOGIN_BROWSER_STILL_OPEN', 'BRIDGE_BUSY', 'ACCOUNT_VALIDATION', 'COMPOSER_NOT_READY'].includes(code) ? 409
        : ['INVALID_JSON', 'MISSING_MESSAGES', 'BODY_TOO_LARGE'].includes(code) ? 400
          : code === 'CHAT_TIMEOUT' ? 504 : 502
      if (res.headersSent) {
        writeSse(res, { error: { type: 'gemini_spark_web_bridge_error', code, message: lastError } })
        writeSse(res, '[DONE]')
        res.end()
      } else {
        sendError(res, status, code, lastError)
      }
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
      lastError = sanitizeErrorMessage(error, '本地 Spark 网关发生错误。')
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
  console.log(`[GeminiSparkWebBridge] listening on ${getBaseUrl()}`)
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
    try { process.kill(child.pid, 'SIGKILL') } catch (_) { /* ignore */ }
  }
}

async function closeLoginBrowser() {
  const child = loginBrowserProcess
  loginBrowserProcess = null
  if (child?.pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else process.kill(child.pid, 'SIGKILL')
    } catch (_) { /* ignore */ }
  }
}

function registerIPC(ipcMain) {
  ipcMain.handle('gemini-spark-web-bridge:status', async () => {
    if (!server) await startServer()
    return getStatus()
  })
  ipcMain.handle('gemini-spark-web-bridge:open-login', async () => {
    if (!server) await startServer()
    return openLoginWindow()
  })
  ipcMain.handle('gemini-spark-web-bridge:check-login', async () => {
    if (!server) await startServer()
    return checkLoginStatus()
  })
  ipcMain.handle('gemini-spark-web-bridge:suggested-agent-model', async () => {
    if (!server) await startServer()
    return { success: true, model: getSuggestedAgentModel(), status: getStatus() }
  })

  startServer().catch(error => {
    lastError = error?.code === 'EADDRINUSE'
      ? `本地端口 ${loadConfig().port} 已被其他程序占用。`
      : sanitizeErrorMessage(error, '本地 Spark 网关启动失败。')
    console.warn('[GeminiSparkWebBridge] start failed:', lastError)
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
  getSuggestedAgentModel,
  extractSparkUserTask,
  buildSparkAgentPrompt,
  looksLikeGoogleAccountValidation,
  isSparkPageUrl,
  SPARK_URL,
  DEFAULT_PORT,
  AUTOMATION_DEBUG_PORT
}
