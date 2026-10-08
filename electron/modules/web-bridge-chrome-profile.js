/**
 * 网页桥共用同一份专用 Chrome 资料，避免每新加一家就从空白无 Cookie 开始。
 * 不读取、不导出 Cookie；只决定 user-data-dir 和可复用的调试端口。
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { app } = require('electron')

const SHARED_PROFILE_NAME = 'lingxi-web-chrome-profile'
const SETTINGS_FILE_NAME = 'web-bridge-settings.json'
const LEGACY_PROFILE_NAMES = [
  'chatgpt-image-chrome-profile',
  'deepseek-web-chrome-profile',
  'grok-web-chrome-profile',
  'claude-web-chrome-profile'
]
const SHARED_DEBUG_PORTS = [19327, 19328, 19329, 19330, 19331, 19332, 19333, 19334, 19335, 19336]

const DEFAULT_SEARCH_PROVIDER_ORDER = Object.freeze(['chatgpt', 'lxweb', 'grok', 'deepseek', 'qwen', 'gemini', 'claude', 'arena'])

function defaultWebBridgeUiSettings() {
  return {
    browserVisible: false,
    pageSearchEnabled: true,
    searchProviderOrder: [...DEFAULT_SEARCH_PROVIDER_ORDER]
  }
}

function getUserDataDir() {
  try {
    return app.getPath('userData')
  } catch (_) {
    return process.cwd()
  }
}

function fileSize(filePath) {
  try {
    return Number(fs.statSync(filePath).size) || 0
  } catch (_) {
    return 0
  }
}

function profileCookieWeight(dir) {
  return fileSize(path.join(dir, 'Default', 'Network', 'Cookies'))
    + fileSize(path.join(dir, 'Default', 'Cookies'))
    + fileSize(path.join(dir, 'Cookies'))
}

function profileLooksUsed(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  return ['Local State', 'Default', 'Cookies'].some(name => fs.existsSync(path.join(dir, name)))
    || profileCookieWeight(dir) > 0
}

function getSharedWebBridgeProfileDir() {
  const userData = getUserDataDir()
  const shared = path.join(userData, SHARED_PROFILE_NAME)
  if (profileLooksUsed(shared)) return shared

  let best = ''
  let bestWeight = -1
  for (const name of LEGACY_PROFILE_NAMES) {
    const dir = path.join(userData, name)
    if (!profileLooksUsed(dir)) continue
    const weight = profileCookieWeight(dir)
    if (weight > bestWeight) {
      best = dir
      bestWeight = weight
    }
  }
  return best || shared
}

function listSharedWebBridgeDebugPorts(preferredPort = 0) {
  const ports = new Set()
  const preferred = Number(preferredPort)
  if (Number.isInteger(preferred) && preferred > 0) ports.add(preferred)
  for (const port of SHARED_DEBUG_PORTS) ports.add(port)
  return [...ports]
}

function getWebBridgeSettingsPath() {
  return path.join(getUserDataDir(), SETTINGS_FILE_NAME)
}

function normalizeSearchProviderOrder(order) {
  try {
    return require('./chatgpt-web-search/search-tool-order').normalizeSearchToolOrder(order)
  } catch (_) {
    const known = DEFAULT_SEARCH_PROVIDER_ORDER
    const seen = new Set()
    const next = []
    for (const item of Array.isArray(order) ? order : []) {
      const id = String(item || '').trim().toLowerCase()
      if (!known.includes(id) || seen.has(id)) continue
      seen.add(id)
      next.push(id)
    }
    for (const id of known) {
      if (!seen.has(id)) next.push(id)
    }
    return next
  }
}

function loadWebBridgeUiSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getWebBridgeSettingsPath(), 'utf8'))
    return {
      browserVisible: parsed?.browserVisible === true,
      pageSearchEnabled: parsed?.pageSearchEnabled !== false,
      searchProviderOrder: normalizeSearchProviderOrder(parsed?.searchProviderOrder)
    }
  } catch (_) {
    return defaultWebBridgeUiSettings()
  }
}

function saveWebBridgeUiSettings(patch = {}) {
  const current = loadWebBridgeUiSettings()
  const next = {
    browserVisible: patch.browserVisible != null ? !!patch.browserVisible : current.browserVisible,
    pageSearchEnabled: patch.pageSearchEnabled != null ? !!patch.pageSearchEnabled : current.pageSearchEnabled,
    searchProviderOrder: patch.searchProviderOrder
      ? normalizeSearchProviderOrder(patch.searchProviderOrder)
      : current.searchProviderOrder
  }
  const filePath = getWebBridgeSettingsPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

function isWebBridgeBrowserVisible() {
  return loadWebBridgeUiSettings().browserVisible === true
}

function setWebBridgeBrowserVisible(visible) {
  return saveWebBridgeUiSettings({ browserVisible: !!visible })
}

function isWebBridgePageSearchEnabled() {
  return loadWebBridgeUiSettings().pageSearchEnabled !== false
}

function getWebBridgeSearchProviderOrder() {
  return loadWebBridgeUiSettings().searchProviderOrder
}

function setWebBridgeSearchSettings(patch = {}) {
  return saveWebBridgeUiSettings({
    pageSearchEnabled: patch.pageSearchEnabled,
    searchProviderOrder: patch.searchProviderOrder
  })
}

function getLaunchModePath(profileDir) {
  return path.join(profileDir, 'lingxi-launch-mode.json')
}

function writeWebBridgeLaunchMode(profileDir, headless) {
  if (!profileDir) return
  try {
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(getLaunchModePath(profileDir), `${JSON.stringify({ headless: !!headless, at: Date.now() }, null, 2)}\n`, 'utf8')
  } catch (_) { /* profile dir may still be creating */ }
}

function readWebBridgeLaunchMode(profileDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getLaunchModePath(profileDir), 'utf8'))
    return { headless: parsed?.headless === true }
  } catch (_) {
    return null
  }
}

function isWebBridgeProfileLocked(profileDir) {
  if (!profileDir) return false
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

function getWebBridgeProfileProcessRows(profileDir) {
  const needle = path.basename(profileDir || '')
  if (!needle || process.platform !== 'win32') return []
  try {
    const output = execFileSync('wmic.exe', [
      'process',
      'where',
      `CommandLine like '%${needle}%'`,
      'get',
      'ProcessId,CommandLine',
      '/format:csv'
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return String(output || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && line.includes(needle) && !/^Node,ProcessId,/i.test(line) && !/^Node,CommandLine,/i.test(line))
  } catch (_) {
    return []
  }
}

function isWebBridgeProfileRunningHeadless(profileDir) {
  const rows = getWebBridgeProfileProcessRows(profileDir)
  if (!rows.length) return null
  return rows.some(line => /--headless(=|$|\s)/i.test(line))
}

function webBridgeAutomationModeMatches(profileDir, wantHeadless) {
  const fromProcess = isWebBridgeProfileRunningHeadless(profileDir)
  if (fromProcess != null) return fromProcess === !!wantHeadless
  const fromFile = readWebBridgeLaunchMode(profileDir)
  if (fromFile) return fromFile.headless === !!wantHeadless
  return !wantHeadless
}

function killWebBridgeProfileProcesses(profileDir) {
  const rows = getWebBridgeProfileProcessRows(profileDir)
  const pids = new Set()
  for (const row of rows) {
    const parts = row.split(',')
    const pid = Number(parts[parts.length - 1])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(pid, 'SIGKILL')
      }
    } catch (_) { /* process already gone */ }
  }
  return pids.size
}

async function waitForWebBridgeProfileFree(profileDir, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isWebBridgeProfileLocked(profileDir)) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return !isWebBridgeProfileLocked(profileDir)
}

function shouldUseWebBridgeHeadless(options = {}) {
  if (options.forceVisible === true) return false
  return !isWebBridgeBrowserVisible()
}

function getWebBridgeAutomationLaunchFlags(options = {}) {
  if (!shouldUseWebBridgeHeadless(options)) return []
  return [
    '--headless=new',
    '--disable-gpu',
    '--window-size=1920,1080'
  ]
}

async function syncWebBridgeAutomationProcess(profileDir, options = {}) {
  const wantHeadless = shouldUseWebBridgeHeadless(options)
  if (options.existingPage && webBridgeAutomationModeMatches(profileDir, wantHeadless)) {
    return { action: 'reuse', wantHeadless }
  }
  if (options.existingPage && typeof options.closeExisting === 'function') {
    await options.closeExisting()
  }
  if (!webBridgeAutomationModeMatches(profileDir, wantHeadless)) {
    killWebBridgeProfileProcesses(profileDir)
    await waitForWebBridgeProfileFree(profileDir)
  }
  writeWebBridgeLaunchMode(profileDir, wantHeadless)
  return { action: 'launch', wantHeadless }
}

async function applyWebBridgePageVisibility(page, context, options = {}) {
  if (!page || page.isClosed() || !context) return
  const visible = options.forceVisible === true || isWebBridgeBrowserVisible()
  if (!visible) return
  const wrap = typeof options.withTimeout === 'function'
    ? (promise, ms, message) => options.withTimeout(promise, ms, message)
    : (promise) => promise
  try {
    const cdp = await wrap(context.newCDPSession(page), 3000, '连接浏览器窗口超时。')
    const { windowId } = await wrap(cdp.send('Browser.getWindowForTarget'), 3000, '读取浏览器窗口超时。')
    await wrap(cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal' }
    }), 3000, '恢复浏览器窗口超时。')
    await cdp.detach().catch(() => {})
  } catch (_) { /* bringToFront still works when window bounds API is unavailable */ }
  await wrap(page.bringToFront(), 5000, '激活外部浏览器页面超时。')
}

function registerIPC(ipcMain) {
  ipcMain.handle('web-bridge:get-browser-visible', async () => ({
    success: true,
    visible: isWebBridgeBrowserVisible()
  }))
  ipcMain.handle('web-bridge:set-browser-visible', async (_event, visible) => {
    const settings = setWebBridgeBrowserVisible(!!visible)
    return { success: true, visible: settings.browserVisible }
  })
  ipcMain.handle('web-bridge:get-search-settings', async () => {
    const settings = loadWebBridgeUiSettings()
    return {
      success: true,
      pageSearchEnabled: settings.pageSearchEnabled !== false,
      searchProviderOrder: settings.searchProviderOrder
    }
  })
  ipcMain.handle('web-bridge:set-search-settings', async (_event, patch = {}) => {
    const settings = setWebBridgeSearchSettings(patch || {})
    return {
      success: true,
      pageSearchEnabled: settings.pageSearchEnabled !== false,
      searchProviderOrder: settings.searchProviderOrder
    }
  })
}

module.exports = {
  SHARED_PROFILE_NAME,
  SHARED_DEBUG_PORTS,
  DEFAULT_SEARCH_PROVIDER_ORDER,
  getSharedWebBridgeProfileDir,
  listSharedWebBridgeDebugPorts,
  profileLooksUsed,
  normalizeSearchProviderOrder,
  loadWebBridgeUiSettings,
  saveWebBridgeUiSettings,
  isWebBridgeBrowserVisible,
  setWebBridgeBrowserVisible,
  isWebBridgePageSearchEnabled,
  getWebBridgeSearchProviderOrder,
  setWebBridgeSearchSettings,
  shouldUseWebBridgeHeadless,
  getWebBridgeAutomationLaunchFlags,
  syncWebBridgeAutomationProcess,
  applyWebBridgePageVisibility,
  registerIPC
}
