/**
 * ChatGPT 网页聊天与生图本地桥接。
 *
 * 只在 127.0.0.1 提供 OpenAI Chat/Images 兼容接口。网页登录与页面操作均在
 * 系统安装的 Chrome/Edge 中完成，不使用 Electron BrowserWindow，也不读取、
 * 导出或转发登录 Token/Cookie。
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
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
  compactWebToolCallArgs,
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
  sanitizeWebBridgeCapturedReply,
  dropRepeatedWebBridgeSearchCalls
} = require('./web-bridge-coding-protocol')
const {
  normalizeChatGptPagePrefs,
  chatgptSuggestedModelName,
  applyChatGptPageModel,
  applyPagePrefsIfNeeded
} = require('./web-bridge-page-model')
const { extractWebAssistantState } = require('./web-bridge-dom-markdown')
const {
  getSharedWebBridgeProfileDir,
  listSharedWebBridgeDebugPorts,
  shouldUseWebBridgeHeadless,
  getWebBridgeAutomationLaunchFlags,
  syncWebBridgeAutomationProcess,
  applyWebBridgePageVisibility
} = require('./web-bridge-chrome-profile')

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3217
const CHATGPT_URL = 'https://chatgpt.com/'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000
const CHAT_TIMEOUT_MS = 10 * 60 * 1000
const DEVTOOLS_CONNECT_TIMEOUT_MS = 45000
const AUTOMATION_DEBUG_PORT = 19327
const MAX_CHAT_SESSION_PAGES = 6
const MAX_WEB_TOOLS = 96
const MAX_WEB_TOOL_CALLS = WEB_BRIDGE_STAGE_EVERY
const MAX_WEB_TOOL_ARGUMENT_CHARS = 400000
const MAX_WEB_CHAT_IMAGES = 4
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
let lastGeneratedAt = 0
let lastChatAt = 0
let loggedIn = null
const chatSessions = new Map()

function getConfigPath() {
  return path.join(app.getPath('userData'), 'chatgpt-image-bridge.json')
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

  const environmentPort = Number(process.env.LINGXI_CHATGPT_IMAGE_BRIDGE_PORT)
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
    conversations: normalizeSavedConversations(saved.conversations),
    pagePrefs: normalizeChatGptPagePrefs(saved.pagePrefs)
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
    provider: 'chatgpt-web-bridge',
    modelName: 'ChatGPT Pro 生图（本地 Chrome）',
    modelId: 'chatgpt-pro-web',
    imageModel: 'chatgpt-pro-web',
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
  const pagePrefs = normalizeChatGptPagePrefs(config.pagePrefs)
  return {
    provider: 'chatgpt-web-bridge',
    modelName: chatgptSuggestedModelName(pagePrefs),
    modelId: 'chatgpt-web-chat',
    apiUrl: `${getBaseUrl()}/v1`,
    apiKey: config.apiKey,
    useFullUrl: false,
    contextWindow: 128000,
    capabilities: {
      text: true,
      vision: true,
      imageGeneration: false,
      musicGeneration: false,
      videoGeneration: false,
      speechSynthesis: false,
      toolCalling: true
    }
  }
}

function setPagePrefs(raw = {}) {
  const config = loadConfig()
  config.pagePrefs = normalizeChatGptPagePrefs(raw)
  writeConfig(config)
  return getStatus()
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
      type: 'chatgpt_web_bridge_error',
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
    lastGeneratedAt,
    lastChatAt,
    pagePrefs: normalizeChatGptPagePrefs(loadConfig().pagePrefs)
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
  bridgePage = bridgeContext.pages().find(page => /chatgpt\.com|auth\.openai\.com/i.test(page.url()))
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
    CHATGPT_URL
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
    CHATGPT_URL
  ]
}

async function launchNormalLoginBrowser() {
  if (activeJob) {
    throw Object.assign(new Error('当前正在生图，完成后才能重新打开登录浏览器。'), { code: 'BRIDGE_BUSY' })
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

async function navigateToChatGpt(page) {
  if (!page || page.isClosed()) throw Object.assign(new Error('外部浏览器页面已关闭。'), { code: 'BROWSER_CLOSED' })
  if (/^https:\/\/(chatgpt\.com|auth\.openai\.com)\//i.test(page.url())) return
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
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
    return { loggedIn: null, composerFound: false, url: '' }
  }
  try {
    const result = await withTimeout(page.evaluate(() => {
      const selectors = [
        '#prompt-textarea',
        'textarea[data-testid="prompt-textarea"]',
        'main textarea',
        'main [contenteditable="true"]'
      ]
      const composer = selectors.map(selector => document.querySelector(selector)).find(Boolean)
      const bodyText = String(document.body?.innerText || '')
      const loginVisible = /Log in|Sign up|登录|注册/.test(bodyText.slice(0, 6000))
      return {
        composerFound: !!composer,
        loginVisible,
        title: document.title,
        url: location.href
      }
    }), 5000, '读取 ChatGPT 页面状态超时。')
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
  await navigateToChatGpt(page)
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

function buildPrompt(body = {}) {
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

async function listCandidateImages(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('main [data-message-author-role="assistant"] img, main img'))
    return nodes.map((img, index) => ({
      src: img.currentSrc || img.src || '',
      alt: img.alt || '',
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0,
      index
    })).filter(item => item.src && (
      item.width >= 384 || item.height >= 384 || /generated|image|图片|图像/i.test(item.alt)
    ))
  })
}

const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'div.ProseMirror[contenteditable="true"]',
  '[data-testid="prompt-textarea"]',
  'textarea[data-testid="prompt-textarea"]',
  'main [contenteditable="true"]',
  'main textarea'
]

async function findComposer(page) {
  for (const selector of COMPOSER_SELECTORS) {
    const locator = page.locator(selector).first()
    if (await locator.count()) return locator
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
    }).filter(text => text && !/^(有问题，尽管问|询问任何问题|Ask anything|Message ChatGPT|Ask ChatGPT)$/i.test(text))
    texts.sort((a, b) => b.length - a.length)
    return texts[0] || ''
  }, COMPOSER_SELECTORS).catch(() => '')
}

async function isComposerSendEnabled(page) {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="发送"]'
  ]
  for (const selector of selectors) {
    const button = page.locator(selector).first()
    if (await button.count() && await button.isEnabled().catch(() => false)) return true
  }
  return false
}

async function fillVisibleComposer(page, prompt) {
  return page.evaluate(({ selectors, text }) => {
    const nodes = []
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(node => {
        if (node && node.getClientRects && node.getClientRects().length) nodes.push(node)
      })
    }
    const el = nodes.find(node => node.getAttribute('contenteditable') === 'true')
      || nodes.find(node => node.tagName === 'TEXTAREA' || node.tagName === 'INPUT')
      || nodes[0]
    if (!el) throw new Error('composer missing')
    el.focus()
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.value = text
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return String(el.value || '').length
    }
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
    // 不要用 ClipboardEvent paste：ChatGPT 会把粘贴收成「文件卡片」，
    // 输入框看起来是空的，软件端就会报 COMPOSER_FILL_FAILED。
    document.execCommand('insertText', false, text)
    return String(el.innerText || el.textContent || '').trim().length
  }, { selectors: COMPOSER_SELECTORS, text: prompt })
}

async function expandComposerPasteChip(page) {
  const labels = [/在文本字段中显示/, /Show in text field/i, /Show in message/i]
  for (const label of labels) {
    const btn = page.getByText(label).first()
    if (await btn.count().catch(() => 0) && await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2500 }).catch(() => {})
      await page.waitForTimeout(250)
      return true
    }
  }
  return page.evaluate(() => {
    const target = Array.from(document.querySelectorAll('button, a, [role="button"], span, div')).find(el => (
      /在文本字段中显示|Show in text field|Show in message/i.test(String(el.textContent || '').trim())
      && el.getClientRects().length
    ))
    if (!target) return false
    target.click()
    return true
  }).catch(() => false)
}

async function composerHasPastedTextChip(page, prompt = '') {
  return page.evaluate(snippet => {
    const text = String(document.body?.innerText || '')
    if (!/在文本字段中显示|Show in text field|Show in message/i.test(text)) return false
    const needle = String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, 24)
    return !needle || text.includes(needle)
  }, String(prompt || '')).catch(() => false)
}

async function composerLooksFilled(page, prompt) {
  const target = String(prompt || '').trim()
  const current = String(await readPageComposerText(page) || '').trim()
  if (current && (current === target || current.includes(target.slice(0, Math.min(80, target.length))) || current.length >= Math.min(target.length, Math.floor(target.length * 0.5) || target.length))) {
    return true
  }
  if (await composerHasPastedTextChip(page, target)) return true
  if (await isComposerSendEnabled(page) && current.length > 0) return true
  if (await isComposerSendEnabled(page) && target.length > 0) return true
  return false
}

function looksLikeIncompleteToolCall(text) {
  const value = String(text || '')
  const open = value.includes(TOOL_CALL_OPEN) || /LINGXI_TOOL_CALLS>/i.test(value)
  const close = value.includes(TOOL_CALL_CLOSE)
  return open && !close
}

async function readAssistantState(page) {
  return page.evaluate(extractWebAssistantState, {
    replySelectors: [
      'main [data-message-author-role="assistant"]',
      '[data-message-author-role="assistant"]'
    ],
    markdownSelectors: ['.markdown', '.prose', '[class*="markdown"]'],
    stopSelectors: [
      'button[data-testid="stop-button"]',
      'button[data-testid="composer-stop-button"]'
    ],
    stopLabelPattern: 'Stop generating|Stop streaming|停止生成|停止响应',
    detectComposer: true,
    detectAlerts: true,
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
    if (!state.generating) return state
    await page.waitForTimeout(400)
  }
  return readAssistantState(page)
}

const PAGE_STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[data-testid="composer-stop-button"]',
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
  const labeled = page.getByRole('button', { name: /Stop generating|Stop streaming|停止生成|停止响应/i })
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

async function readSubmitProgress(page) {
  return page.evaluate(selectors => {
    const stop = document.querySelector(
      'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="停止生成"], button[aria-label="停止响应"]'
    )
    const generating = !!(stop && stop.getClientRects && stop.getClientRects().length)
    const replies = document.querySelectorAll('main [data-message-author-role="assistant"], [data-message-author-role="assistant"]')
    let composerText = ''
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(el => {
        if (el.getAttribute && el.getAttribute('data-placeholder') && el.classList && el.classList.contains('is-editor-empty')) return
        const text = String(el.innerText || el.textContent || el.value || '').replace(/\u00a0/g, ' ').trim()
        if (text && text.length > composerText.length && !/^(有问题，尽管问|询问任何问题|Ask anything|Message ChatGPT|Ask ChatGPT)$/i.test(text)) {
          composerText = text
        }
      })
    }
    return { generating, count: replies.length, composerText }
  }, COMPOSER_SELECTORS).catch(() => ({ generating: false, count: 0, composerText: '' }))
}

async function waitForPromptSubmitted(page, before = {}, timeoutMs = 8000, options = {}) {
  const deadline = Date.now() + timeoutMs
  const baselineCount = Number(before.count || 0)
  const hadComposerText = options.hadComposerText !== false
  while (Date.now() < deadline) {
    const state = await readSubmitProgress(page)
    if (didWebPromptLeaveComposer({
      generating: state.generating,
      messageCount: state.count,
      baselineCount,
      composerEmpty: !String(state.composerText || '').trim(),
      hadComposerText
    })) return true
    await page.waitForTimeout(300)
  }
  return false
}

async function fillComposerFast(page, composer, prompt) {
  await composer.click({ timeout: 8000 })
  await page.waitForTimeout(80)
  await fillVisibleComposer(page, prompt).catch(() => 0)
  await page.waitForTimeout(200)
  if (await composerHasPastedTextChip(page, prompt)) {
    await expandComposerPasteChip(page)
    await page.waitForTimeout(200)
  }
  if (await composerLooksFilled(page, prompt) && String(await readPageComposerText(page) || '').trim()) return

  const text = String(prompt || '')
  if (text.length <= 4000) {
    await composer.click({ timeout: 5000 }).catch(() => {})
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.insertText(text)
    await page.waitForTimeout(200)
    if (await composerHasPastedTextChip(page, prompt)) {
      await expandComposerPasteChip(page)
      await page.waitForTimeout(200)
    }
    if (await composerLooksFilled(page, prompt) && String(await readPageComposerText(page) || '').trim()) return
  }

  if (await composerHasPastedTextChip(page, prompt)) {
    await expandComposerPasteChip(page)
    await page.waitForTimeout(250)
    if (String(await readPageComposerText(page) || '').trim()) return
  }

  throw Object.assign(new Error('ChatGPT 输入框内容为空，填入失败。'), { code: 'COMPOSER_FILL_FAILED' })
}

function extractWebMessageImages(content) {
  if (!Array.isArray(content)) return []
  const images = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    let url = ''
    if (part.type === 'image_url') {
      url = typeof part.image_url === 'string' ? part.image_url : String(part.image_url?.url || '')
    } else if (part.type === 'input_image') {
      url = String(part.image_url?.url || part.image_url || part.image || part.url || '')
    }
    if (!url) continue
    images.push({
      url,
      name: String(part.name || part.filename || ''),
      path: String(part.path || '')
    })
    if (images.length >= MAX_WEB_CHAT_IMAGES) break
  }
  return images
}

function getLatestWebUserImages(messages = []) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role !== 'user') continue
    const images = Array.isArray(list[index].images) ? list[index].images : []
    if (images.length) return images.slice(0, MAX_WEB_CHAT_IMAGES)
  }
  return []
}

function mimeToImageExt(mime = '') {
  const value = String(mime || '').toLowerCase()
  if (value.includes('jpeg') || value.includes('jpg')) return 'jpg'
  if (value.includes('webp')) return 'webp'
  if (value.includes('gif')) return 'gif'
  return 'png'
}

function materializeWebChatImages(images = []) {
  const files = []
  for (const [index, image] of (Array.isArray(images) ? images : []).slice(0, MAX_WEB_CHAT_IMAGES).entries()) {
    const filePath = String(image?.path || '').trim()
    if (filePath && fs.existsSync(filePath)) {
      files.push({ path: filePath, cleanup: false })
      continue
    }
    const url = String(image?.url || '')
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(url)
    if (!match) continue
    const ext = mimeToImageExt(match[1])
    const name = String(image?.name || `image-${index + 1}`).replace(/[^\w.-]+/g, '_') || `image-${index + 1}`
    const tempPath = path.join(os.tmpdir(), `lingxi-gpt-vision-${Date.now()}-${index}-${name}.${ext}`)
    fs.writeFileSync(tempPath, Buffer.from(match[2], 'base64'))
    files.push({ path: tempPath, cleanup: true })
  }
  return files
}

async function waitForComposerAttachments(page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = await page.evaluate(() => {
      const composer = document.querySelector('[contenteditable="true"], textarea')
      const root = composer?.closest('form') || document.querySelector('main form') || document.body
      return root.querySelectorAll(
        'img[src], [data-testid*="thumbnail" i], button[aria-label*="Remove" i], button[aria-label*="移除"], button[aria-label*="删除附件"]'
      ).length
    }).catch(() => 0)
    if (count >= 1) return true
    await page.waitForTimeout(250)
  }
  return false
}

async function attachComposerImages(page, filePaths = []) {
  const files = (Array.isArray(filePaths) ? filePaths : []).filter(Boolean)
  if (!files.length) return false
  const fileInput = page.locator('form input[type="file"], input[type="file"]').last()
  if (await fileInput.count()) {
    await fileInput.setInputFiles(files)
    await waitForComposerAttachments(page)
    return true
  }
  const attachButton = page.locator([
    'button[aria-label*="Attach files" i]',
    'button[aria-label*="Add photos" i]',
    'button[aria-label*="Add files" i]',
    'button[aria-label="Open add files menu"]',
    'button[data-testid="composer-plus-btn"]',
    'button[aria-label*="上传"]',
    'button[aria-label*="添加文件"]',
    'button[aria-label*="添加照片"]'
  ].join(', ')).first()
  if (!(await attachButton.count())) {
    throw Object.assign(new Error('ChatGPT 输入框没有找到传图入口。'), { code: 'COMPOSER_IMAGE_ATTACH_FAILED' })
  }
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 })
  await attachButton.click()
  const menuItem = page.locator('[role="menuitem"]:has-text("Upload"), [role="menuitem"]:has-text("上传"), [role="menuitem"]:has-text("照片"), [role="menuitem"]:has-text("Photos")').first()
  if (await menuItem.count()) await menuItem.click()
  const chooser = await chooserPromise
  await chooser.setFiles(files)
  await waitForComposerAttachments(page)
  return true
}

async function fillAndSubmitPrompt(page, prompt, images = []) {
  await ensureComposerAcceptsInput(page)
  const composer = await findComposer(page)
  if (!composer) throw Object.assign(new Error('没有找到 ChatGPT 输入框，请重新登录。'), { code: 'COMPOSER_NOT_FOUND' })

  const files = materializeWebChatImages(images)
  try {
    if (files.length) await attachComposerImages(page, files.map(item => item.path))

    const text = String(prompt || '')
    if (text.trim()) {
      await fillComposerFast(page, composer, text)
      await page.waitForTimeout(250)
      if (await composerHasPastedTextChip(page, text)) {
        await expandComposerPasteChip(page)
        await page.waitForTimeout(250)
      }
      const filledText = String(await readPageComposerText(page) || '').trim()
      if (!filledText) {
        throw Object.assign(new Error('ChatGPT 输入框内容为空，填入失败。'), { code: 'COMPOSER_FILL_FAILED' })
      }
    } else if (!files.length) {
      throw Object.assign(new Error('ChatGPT 输入框内容为空，填入失败。'), { code: 'COMPOSER_FILL_FAILED' })
    } else if (!(await isComposerSendEnabled(page))) {
      throw Object.assign(new Error('图片已准备，但 ChatGPT 发送按钮仍不可用。'), { code: 'COMPOSER_IMAGE_ATTACH_FAILED' })
    }

    const before = await readAssistantState(page)
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="发送"]'
    ]
    let clicked = false
    for (const selector of selectors) {
      const button = page.locator(selector).first()
      if (await button.count() && await button.isEnabled().catch(() => false)) {
        await button.click()
        clicked = true
        break
      }
    }
    if (!clicked) await composer.press('Enter')

    const submitted = await waitForPromptSubmitted(page, before, 8000, { hadComposerText: true })
    if (!submitted) {
      await composer.press('Enter')
      const retried = await waitForPromptSubmitted(page, before, 5000, { hadComposerText: true })
      if (!retried) {
        throw Object.assign(new Error('ChatGPT 页面没有发出这条消息。请查看自动化 Chrome 里输入框是否填入、发送按钮是否可点。'), { code: 'PROMPT_NOT_SENT' })
      }
    }
  } finally {
    for (const file of files) {
      if (!file.cleanup) continue
      try { fs.unlinkSync(file.path) } catch (_) { /* ignore temp cleanup */ }
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
    if (part.type === 'image_url' || part.type === 'input_image') return '[已附加图片]'
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
    const images = role === 'user' ? extractWebMessageImages(message.content) : []
    const toolCalls = role === 'assistant' && Array.isArray(message.tool_calls)
      ? message.tool_calls.map(call => ({
          id: String(call?.id || ''),
          name: String(call?.function?.name || ''),
          arguments: typeof call?.function?.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call?.function?.arguments || {})
        })).filter(call => call.id && call.name)
      : []
    if (!content.trim() && !toolCalls.length && !images.length && role !== 'tool') return null
    const normalized = { role, content: content.trim() }
    if (images.length) normalized.images = images
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
  const labels = {
    system: '系统要求',
    developer: '开发者要求',
    user: '用户',
    assistant: '助手',
    tool: '灵犀工具结果'
  }
  return messages.map((message, index) => {
    const details = []
    const compacted = compactWebTranscriptContent(message.role, message.content)
    if (compacted) details.push(compacted)
    if (Array.isArray(message.images) && message.images.length) {
      details.push(`[已向 ChatGPT 附加 ${message.images.length} 张图片]`)
    }
    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        details.push(`[工具调用 call_id=${call.id} name=${call.name}]\n${compactWebToolCallArgs(call.name, call.arguments)}`)
      }
    }
    if (message.role === 'tool' && message.callId) {
      details.unshift(`[对应 call_id=${message.callId}${message.name ? ` name=${message.name}` : ''}]`)
    }
    if (!details.length) return ''
    return `--- ${labels[message.role] || message.role} ${index + 1} ---\n${details.join('\n')}`
  }).filter(Boolean).join('\n\n')
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

function extractLingxiToolCallBlock(text) {
  const open = text.indexOf(TOOL_CALL_OPEN)
  const close = text.lastIndexOf(TOOL_CALL_CLOSE)
  if (open < 0 || close < 0 || close <= open) return null
  // 网页模型常在工具调用前后加说明文字。只提取标记之间的内容。
  return text.slice(open + TOOL_CALL_OPEN.length, close)
}

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
    /"\s*\}\s*,\s*"/,
    /"\s*\}/
  ]
  let best = -1
  for (const pattern of strict) {
    const match = pattern.exec(rest)
    if (match && (best < 0 || match.index < best)) best = match.index
  }
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
  return extractLingxiCallsLooseShared(raw) || extractLingxiCallsLooseShared(compact) || tryExtractLingxiCallsLoose(raw) || tryExtractLingxiCallsLoose(compact)
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

function isChatGptConversationUrl(url = '') {
  return /^https:\/\/chatgpt\.com\/(c|g)\//i.test(String(url || ''))
}

function readSavedConversationUrl(sessionKey, projectId = '', lane = '') {
  return getSavedConversationUrl(loadConfig().conversations, sessionKey, projectId, lane)
}

function persistConversationUrl(sessionKey, url, projectId = '', lane = '') {
  if (!sessionKey || !isChatGptConversationUrl(url)) return
  const config = loadConfig()
  config.conversations = rememberSavedConversation(config.conversations, sessionKey, url, projectId, lane)
  writeConfig(config)
}

function findReusableChatGptPage(savedUrl = '', sessionKey = '') {
  const pages = (bridgeContext?.pages() || []).filter(page => !page.isClosed() && /chatgpt\.com/i.test(page.url()))
  return pickReusableWebChatPage(pages, { savedUrl, sessionKey, chatSessions })
}

async function acquireLoggedInPage(options = {}) {
  const sessionKey = String(options.sessionKey || 'chatgpt-web-search')
  const projectId = String(options.projectId || '')
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('登录浏览器仍在打开。请完成登录并关闭整个专用 Chrome 窗口后再搜索。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  if (!server) await startServer()
  const session = await getChatSessionPage(sessionKey, projectId, 'search')
  if (!session.initialized) {
    await navigateToChatGpt(session.page)
    const state = await waitForComposer(session.page, 20000)
    if (!state.composerFound) {
      loggedIn = false
      throw Object.assign(new Error('ChatGPT 尚未登录。请先在设置中完成网页登录检查。'), { code: 'LOGIN_REQUIRED' })
    }
    loggedIn = true
    session.initialized = true
  } else if (!session.page || session.page.isClosed()) {
    throw Object.assign(new Error('ChatGPT 登录页面不可用。'), { code: 'CHATGPT_DIRECT_PAGE_UNAVAILABLE' })
  }
  return session.page
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
  const page = findReusableChatGptPage(savedUrl, sessionKey) || await bridgeContext.newPage()
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
      : (isChatGptConversationUrl(liveUrl) ? liveUrl : (savedUrl || '')),
    projectId: String(projectId || ''),
    lane: String(lane || 'lingxi')
  }
  chatSessions.set(sessionKey, session)
  page.once('close', () => {
    if (chatSessions.get(sessionKey)?.page === page) chatSessions.delete(sessionKey)
  })
  return session
}

async function prepareFreshWebChat(page, { forceNew = false, isConversationUrl = isChatGptConversationUrl } = {}) {
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  if (forceNew && isConversationUrl(page.url())) {
    await clickWebBridgeNewChatButton(page)
    await page.waitForTimeout(600)
  }
  const state = await waitForComposer(page, 20000)
  if (!state.composerFound) {
    loggedIn = false
    throw Object.assign(new Error('ChatGPT 尚未登录。请先在设置中完成网页登录检查。'), { code: 'LOGIN_REQUIRED' })
  }
  loggedIn = true
  return state
}

async function prepareSessionWebChat(page, savedUrl = '', { forceNew = false } = {}) {
  if (!forceNew && isChatGptConversationUrl(page.url())) {
    const state = await waitForComposer(page, 20000)
    if (state.composerFound) {
      loggedIn = true
      return { resumed: true, state }
    }
  }
  if (!forceNew && isChatGptConversationUrl(savedUrl)) {
    try {
      await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      if (isChatGptConversationUrl(page.url())) {
        const state = await waitForComposer(page, 20000)
        if (state.composerFound) {
          loggedIn = true
          return { resumed: true, state }
        }
      }
    } catch (_) { /* deleted or expired thread, open a new chat */ }
  }
  const state = await prepareFreshWebChat(page, { forceNew, isConversationUrl: isChatGptConversationUrl })
  return { resumed: false, state }
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
      throw Object.assign(new Error('聊天过程中外部浏览器被关闭。'), { code: 'BROWSER_CLOSED' })
    }
    const state = await readAssistantState(page)
    sawGenerating = noteWebGenerationStarted(state, sawGenerating)
    idleTicks = nextWebGenerationIdleTicks(state, idleTicks)
    if (state.alerts && /error|failed|错误|失败|稍后/i.test(state.alerts)) {
      throw Object.assign(new Error(`ChatGPT 页面提示：${state.alerts}`), { code: 'PAGE_ERROR' })
    }

    const delta = extractReplyDelta(state, baseline)
    const hasToolDraft = looksLikeIncompleteToolCall(delta.innerText)
      || looksLikeIncompleteToolCall(delta.markdown)
      || String(delta.innerText || '').includes(TOOL_CALL_OPEN)
    if (delta.markdown || delta.innerText || hasToolDraft) {
      const signature = `${delta.markdown}||${delta.innerText}`
      const previous = `${latestDelta.markdown}||${latestDelta.innerText}`
      if (signature === previous) stableCount += 1
      else {
        latestDelta = delta
        stableCount = 0
      }
      const incomplete = looksLikeIncompleteToolCall(latestDelta.markdown)
        || looksLikeIncompleteToolCall(latestDelta.innerText)
      const thinkingOnly = isWebThinkingPlaceholder(latestDelta.markdown)
        && isWebThinkingPlaceholder(latestDelta.innerText)
      // generating 用精确的“停止生成”按钮判断。旧版 aria-label*="Stop" 会误匹配语音停止键，
      // 页面已经出完工具 JSON，软件却一直以为还在生成。
      // 若停止键误判卡住，文本稳定 4 秒且工具标记已闭合也收尾。
      // 「正在思考」只是页面占位，不能当最终回复提前收尾。
      const settled = shouldSettleWebReply({
        incomplete,
        thinkingOnly,
        stableCount,
        generating: state.generating,
        textLength: String(latestDelta.markdown || latestDelta.innerText || '').trim().length
      })
      if (settled) return latestDelta
    }
    if (shouldAcceptStoppedWebReply(idleTicks, 3, sawGenerating)) return latestDelta
    await page.waitForTimeout(1000)
  }
  const harvested = await harvestCapturedWebReply({
    latestDelta,
    page,
    baseline,
    readAssistantState,
    extractReplyDelta
  })
  if (harvested) return harvested
  throw Object.assign(new Error('等待 ChatGPT 网页回复超时。请查看自动化 Chrome 中的页面状态。'), { code: 'CHAT_TIMEOUT' })
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
      if (isChatGptConversationUrl(session.page.url())) {
        session.conversationUrl = session.page.url()
      }
    } else {
      if (session.conversationUrl && session.page.url() !== session.conversationUrl && isChatGptConversationUrl(session.conversationUrl)) {
        await session.page.goto(session.conversationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      }
      const state = await waitForComposer(session.page, 20000)
      if (!state.composerFound) {
        const currentUrl = session.conversationUrl || session.page.url()
        if (isChatGptConversationUrl(currentUrl)) {
          await session.page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        }
        const recovered = await waitForComposer(session.page, 20000)
        if (!recovered.composerFound) {
          throw Object.assign(new Error('当前 ChatGPT 对话页无法继续输入。请检查网页状态后重试；灵犀没有新建其他对话。'), { code: 'CHAT_PAGE_NOT_READY' })
        }
      }
      resumedThread = true
    }
    const plan = resolveWebChatPromptPlan({ resumedThread, inputMessages, continuation })
    await showExternalPage(session.page)
    throwIfWebChatAborted(signal)
    const prompt = buildWebChatPrompt(body, plan.promptMessages, plan.promptMode, { passthrough })
    await applyPagePrefsIfNeeded(session.page, session, loadConfig().pagePrefs, applyChatGptPageModel)
    const baseline = await readAssistantState(session.page)
    const attachImages = (plan.promptMode === 'initial' || plan.promptMode === 'resync')
      ? getLatestWebUserImages(inputMessages)
      : []
    await fillAndSubmitPrompt(session.page, prompt, attachImages)
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
    if (toolCalls.length) {
      toolCalls = dropRepeatedWebBridgeSearchCalls(toolCalls, inputMessages)
    }
    if (!toolCalls.length && parseError) throw parseError
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
    if (isChatGptConversationUrl(session.page.url())) {
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

async function waitForGeneratedImage(page, baselineSources, timeoutMs = GENERATION_TIMEOUT_MS, signal = null) {
  const deadline = Date.now() + timeoutMs
  let stableSource = ''
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
    const candidates = await listCandidateImages(page)
    const latest = candidates.filter(item => !baselineSources.has(item.src)).at(-1)
    if (latest?.src) {
      if (stableSource === latest.src) stableCount += 1
      else {
        stableSource = latest.src
        stableCount = 1
      }
      if (stableCount >= 2 && (latest.width >= 512 || latest.height >= 512)) return latest
    }

    const pageError = await page.evaluate(() => {
      const alerts = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"]'))
      return alerts.map(node => String(node.innerText || '')).filter(Boolean).join(' ').slice(0, 500)
    }).catch(() => '')
    if (pageError && /error|failed|错误|失败|稍后/i.test(pageError)) {
      throw Object.assign(new Error(`ChatGPT 页面提示：${pageError}`), { code: 'PAGE_ERROR' })
    }
    if (shouldAcceptStoppedWebReply(idleTicks, 3, sawGenerating) && !stableSource) {
      throw Object.assign(new Error('等待 ChatGPT 生成图片超时。请查看外部浏览器中的页面状态后重试。'), { code: 'GENERATION_TIMEOUT' })
    }
    await page.waitForTimeout(1500)
  }
  throw Object.assign(new Error('等待 ChatGPT 生成图片超时。请查看外部浏览器中的页面状态后重试。'), { code: 'GENERATION_TIMEOUT' })
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

  // 图片已经在页面显示时，先直接读取浏览器中已解码的原图像素，完全避免二次联网。
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

  // 必须复用当前 Chrome 页面的网络环境。Playwright APIRequestContext 使用独立网络栈，
  // 在代理环境下可能出现“网页已显示图片，但后台重新下载超时”的假失败。
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

  // 页面 fetch 若被 CORS 限制，则在同一个已登录浏览器上下文中新开临时页读取响应。
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

  // 最后退化为截取页面上已经成功渲染的图片，至少把成功结果交回软件端。
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

async function generateImage(body = {}) {
  const n = Math.max(1, Number(body.n || 1))
  if (n !== 1) {
    throw Object.assign(new Error('ChatGPT 网页桥接当前一次只支持生成 1 张图片，请设置 n=1。'), { code: 'UNSUPPORTED_N' })
  }
  if (isLoginBrowserRunning()) {
    throw Object.assign(new Error('登录浏览器仍在打开。请完成登录并关闭整个专用 Chrome 窗口后再生图。'), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  const prompt = buildPrompt(body)
  const page = await launchExternalBrowser()
  activeJob = true
  activeJobType = 'image'
  try {
    await navigateToChatGpt(page)
    await showExternalPage(page)
    const state = await waitForComposer(page, 25000)
    if (!state.composerFound) {
      await closeExternalBrowser()
      loggedIn = false
      throw Object.assign(new Error('ChatGPT 尚未登录。请在设置中点击第一步，用普通 Chrome 登录并关闭窗口后再重试。'), { code: 'LOGIN_REQUIRED' })
    }

    loggedIn = true
    const baseline = new Set((await listCandidateImages(page)).map(item => item.src))
    await fillAndSubmitPrompt(page, prompt)
    const image = await waitForGeneratedImage(page, baseline)
    const buffer = await readImageBuffer(page, image.src)
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

function enqueueGeneration(body) {
  return enqueueBridgeJob(() => generateImage(body))
}

function enqueueWebChat(body, sessionKey, projectId, signal, bridgeMode = '') {
  return enqueueBridgeJob(() => runWebChat(body, sessionKey, projectId, signal, bridgeMode))
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
    sendError(res, 401, 'UNAUTHORIZED', '本地 ChatGPT 网关密钥无效。请在设置中重新添加网页模型。')
    return
  }

  if (req.method === 'GET' && pathname === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: [
        { id: 'chatgpt-web-chat', object: 'model', owned_by: 'local' },
        { id: 'chatgpt-pro-web', object: 'model', owned_by: 'local' }
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
        writeSse(res, { error: { type: 'chatgpt_web_bridge_error', code, message: lastError } })
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
      lastError = sanitizeErrorMessage(error, '图片生成失败。')
      const code = error?.code || 'GENERATION_FAILED'
      const status = ['LOGIN_REQUIRED', 'LOGIN_BROWSER_STILL_OPEN', 'BRIDGE_BUSY'].includes(code) ? 409
        : ['INVALID_JSON', 'MISSING_PROMPT', 'UNSUPPORTED_N', 'BODY_TOO_LARGE'].includes(code) ? 400
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
      lastError = sanitizeErrorMessage(error, '本地 ChatGPT 网关发生错误。')
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
  console.log(`[ChatGPTWebBridge] listening on ${getBaseUrl()}`)
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
  ipcMain.handle('chatgpt-image-bridge:status', async () => {
    if (!server) await startServer()
    return getStatus()
  })
  ipcMain.handle('chatgpt-image-bridge:open-login', async () => {
    if (!server) await startServer()
    return openLoginWindow()
  })
  ipcMain.handle('chatgpt-image-bridge:check-login', async () => {
    if (!server) await startServer()
    return checkLoginStatus()
  })
  ipcMain.handle('chatgpt-image-bridge:suggested-model', async () => {
    if (!server) await startServer()
    return { success: true, model: getSuggestedModel(), status: getStatus() }
  })
  ipcMain.handle('chatgpt-image-bridge:suggested-chat-model', async () => {
    if (!server) await startServer()
    return { success: true, model: getSuggestedChatModel(), status: getStatus() }
  })
  ipcMain.handle('chatgpt-image-bridge:set-page-prefs', async (_event, prefs = {}) => {
    if (!server) await startServer()
    return { success: true, status: setPagePrefs(prefs) }
  })

  startServer().catch(error => {
    lastError = error?.code === 'EADDRINUSE'
      ? `本地端口 ${loadConfig().port} 已被其他程序占用。`
      : sanitizeErrorMessage(error, '本地 ChatGPT 网关启动失败。')
    console.warn('[ChatGPTWebBridge] start failed:', lastError)
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
  getSuggestedModel,
  getSuggestedChatModel,
  setPagePrefs,
  buildPrompt,
  buildWebChatPrompt,
  normalizeWebChatMessages,
  extractWebMessageImages,
  getLatestWebUserImages,
  materializeWebChatImages,
  normalizeWebTools,
  parseLingxiToolCalls,
  tryExtractLingxiCallsLoose,
  getContinuationMessages,
  getWebChatRequestDigest,
  sendWebChatResult,
  parseDataUrl,
  isLoopbackRequest,
  getBrowserCandidates,
  findBrowserExecutable,
  getBrowserProfileDir,
  openLoginWindow,
  closeExternalBrowser,
  closeLoginBrowser,
  acquireLoggedInPage
}
