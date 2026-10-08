/**
 * Gemini /app 私有协议网关客户端。
 *
 * 灵犀始终对外暴露 3224 这一条 Gemini 模型；本模块只在该桥选择
 * “协议直连”时，确保通用 Agent API 网关已启动并把请求转发到 3410。
 * 网关只负责协议适配与模型输出校验；本地工具仍由灵犀执行。
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { spawn } = require('child_process')

const DIRECT_HOST = '127.0.0.1'
const DIRECT_PORT = 3410
const DIRECT_API_KEY = process.env.LINGXI_GEMINI_AGENT_GATEWAY_API_KEY || 'lingxi-gemini-agent-local-3410'
const SESSION_IMPORT_API_KEY = process.env.LINGXI_GEMINI_SESSION_IMPORT_API_KEY || DIRECT_API_KEY
const START_TIMEOUT_MS = 12000
let ownedProcess = null
let startPromise = null

/** 网页桥共用的 Chrome 登录资料目录：让网关侧的登录窗口也能复用已有的 Google 登录。 */
function sharedWebBridgeProfileDir() {
  try {
    return require('./web-bridge-chrome-profile').getSharedWebBridgeProfileDir()
  } catch (_) {
    return ''
  }
}

/** 灵犀自己的用户数据目录：网关据此找到本机所有网页桥登录资料。 */
function lingxiUserDataDir() {
  try {
    return require('electron').app.getPath('userData')
  } catch (_) {
    return ''
  }
}

function gatewayTarget() {
  const configured = String(process.env.LINGXI_GEMINI_AGENT_GATEWAY_URL || `http://${DIRECT_HOST}:${DIRECT_PORT}`).trim()
  const url = new URL(configured)
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    basePath: pathname,
    remote: !['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase())
  }
}

function requestModule(target = gatewayTarget()) {
  return target.protocol === 'https:' ? https : http
}

function targetPath(pathname = '/', target = gatewayTarget()) {
  return `${target.basePath}${pathname}`.replace(/\/{2,}/g, '/')
}

function gatewayRootCandidates() {
  const candidates = [
    process.env.LINGXI_GEMINI_AGENT_GATEWAY_ROOT,
    process.env.LINGXI_GEMINI_DIRECT_GATEWAY_ROOT,
    path.resolve(__dirname, '..', '..', 'services', 'gemini-agent-api-gateway'),
    process.resourcesPath && path.resolve(process.resourcesPath, 'services', 'gemini-agent-api-gateway'),
    path.resolve(__dirname, '..', '..', '..', '..', 'gemini-agent-api-gateway')
  ]
  return [...new Set(candidates.filter(Boolean).map(item => path.resolve(item)))]
}

function findGatewayRoot() {
  return gatewayRootCandidates().find(root => (
    fs.existsSync(path.join(root, 'package.json'))
    && (
      fs.existsSync(path.join(root, 'dist', 'gateway.cjs'))
      || fs.existsSync(path.join(root, 'src', 'index.js'))
    )
  )) || ''
}

function getGatewayEntry(root = '') {
  const bundled = path.join(root, 'dist', 'gateway.cjs')
  let entry = fs.existsSync(bundled) ? bundled : path.join(root, 'src', 'index.js')
  const asarSegment = `${path.sep}app.asar${path.sep}`
  if (entry.includes(asarSegment)) {
    const unpacked = entry.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    if (fs.existsSync(unpacked)) entry = unpacked
  }
  return entry
}

function getUserDataSessionFile() {
  try {
    const electron = require('electron')
    if (electron?.app?.getPath) {
      return path.join(electron.app.getPath('userData'), 'gemini-direct', 'session-app.json')
    }
  } catch (_) { /* plain Node or isolated test */ }
  return ''
}

function sessionFileCandidates(root = '') {
  const userDataFile = getUserDataSessionFile()
  const candidates = [
    process.env.LINGXI_GEMINI_SESSION_FILE,
    process.env.GEMINI_SESSION_FILE,
    userDataFile,
    root && path.join(root, 'data', 'session-app.json'),
    root && path.resolve(root, '..', 'universal-web-model-gateway', 'experiments', 'spark-direct', '.session-app.json'),
    root && path.resolve(root, '..', '..', '..', '..', 'universal-web-model-gateway', 'experiments', 'spark-direct', '.session-app.json')
  ]
  return [...new Set(candidates.filter(Boolean).map(item => path.resolve(item)))]
}

function findSessionFile(root = '') {
  return sessionFileCandidates(root).find(file => fs.existsSync(file)) || ''
}

function resolveSessionFile(root = '') {
  const existing = findSessionFile(root)
  const userDataFile = getUserDataSessionFile()
  if (existing && userDataFile && path.resolve(existing) !== path.resolve(userDataFile)) {
    try {
      if (!fs.existsSync(userDataFile)) {
        fs.mkdirSync(path.dirname(userDataFile), { recursive: true })
        fs.copyFileSync(existing, userDataFile)
      }
      if (fs.existsSync(userDataFile)) return userDataFile
    } catch (_) { /* keep using the readable legacy session */ }
  }
  return existing || userDataFile || path.join(root, 'data', 'session-app.json')
}

function healthCheck(timeoutMs = 900) {
  return new Promise(resolve => {
    const target = gatewayTarget()
    const req = requestModule(target).get({
      hostname: target.hostname,
      port: target.port,
      path: targetPath('/health', target),
      timeout: timeoutMs
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.once('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(res.statusCode === 200 && ['gemini-agent-api-gateway', 'web-model-api-gateway'].includes(payload?.service))
        } catch (_) {
          resolve(false)
        }
      })
    })
    req.once('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.once('error', () => resolve(false))
  })
}

async function waitForHealth(timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await healthCheck()) return true
    await new Promise(resolve => setTimeout(resolve, 180))
  }
  return false
}

async function ensureRunning() {
  if (await healthCheck()) return { running: true, owned: false, root: '' }
  if (startPromise) return startPromise

  startPromise = (async () => {
    const target = gatewayTarget()
    if (target.remote) {
      throw Object.assign(new Error(`远程 Gemini 通用网关不可用：${target.protocol}//${target.hostname}:${target.port}`), {
        code: 'GEMINI_DIRECT_REMOTE_UNAVAILABLE'
      })
    }
    const root = findGatewayRoot()
    if (!root) {
      throw Object.assign(new Error(
        'Gemini 通用协议网关未安装，无法启动 127.0.0.1:3410。请切回“显示浏览器”，或安装随应用打包的直连组件。'
      ), { code: 'GEMINI_DIRECT_COMPONENT_MISSING' })
    }

    const entry = getGatewayEntry(root)
    const sessionFile = resolveSessionFile(root)
    const child = spawn(process.execPath, [entry], {
      cwd: path.dirname(entry),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        GEMINI_AGENT_GATEWAY_HOST: DIRECT_HOST,
        GEMINI_AGENT_GATEWAY_PORT: String(DIRECT_PORT),
        GEMINI_AGENT_GATEWAY_API_KEYS: DIRECT_API_KEY,
        GEMINI_SESSION_FILE: sessionFile,
        LINGXI_USER_DATA_DIR: lingxiUserDataDir(),
        LINGXI_WEB_BRIDGE_PROFILE_DIR: sharedWebBridgeProfileDir()
      },
      windowsHide: true,
      stdio: 'ignore'
    })
    ownedProcess = child
    child.once('exit', () => {
      if (ownedProcess === child) ownedProcess = null
    })
    child.once('error', () => {
      if (ownedProcess === child) ownedProcess = null
    })

    if (!(await waitForHealth())) {
      try { child.kill() } catch (_) { /* already stopped */ }
      throw Object.assign(new Error(
        'Gemini 通用协议网关启动失败，127.0.0.1:3410 未就绪。请检查直连会话和网关配置。'
      ), { code: 'GEMINI_DIRECT_START_FAILED' })
    }
    return { running: true, owned: true, root }
  })().finally(() => {
    startPromise = null
  })
  return startPromise
}

function importBrowserSession(session = {}) {
  return ensureRunning().then(() => new Promise((resolve, reject) => {
    const target = gatewayTarget()
    const encoded = Buffer.from(JSON.stringify({ session }), 'utf8')
    const request = requestModule(target).request({
      hostname: target.hostname,
      port: target.port,
      method: 'POST',
      path: targetPath('/v1/gemini/session/import', target),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': encoded.length,
        Authorization: `Bearer ${SESSION_IMPORT_API_KEY}`,
        'X-Client-Type': 'lingxi-session-uploader'
      },
      timeout: 120000
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('end', () => {
        let payload = null
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (_) { /* invalid gateway response */ }
        if ((response.statusCode || 500) >= 400 || !payload?.ok) {
          const message = payload?.error?.message || `Gemini 会话鉴权返回 HTTP ${response.statusCode || 500}。`
          reject(Object.assign(new Error(message), {
            code: payload?.error?.code || 'GEMINI_DIRECT_SESSION_IMPORT_FAILED',
            statusCode: response.statusCode,
            details: payload?.error?.details
          }))
          return
        }
        resolve(payload)
      })
    })
    request.once('timeout', () => request.destroy(new Error('Gemini 会话鉴权超时。')))
    request.once('error', reject)
    request.end(encoded)
  }))
}

function directModelForPrefs(prefs = {}) {
  return ({
    'flash-lite': 'gemini-3.5-flash-lite',
    'flash-3.6': 'gemini-3.6-flash',
    'flash-3.7': 'gemini-3.7-flash',
    flash: 'gemini-3.7-flash',
    pro: 'gemini-3.1-pro'
  })[String(prefs.pageModel || '').trim().toLowerCase()] || 'gemini-3.7-flash'
}

function directBody(body = {}, prefs = {}) {
  const requested = String(body.model || '').trim().toLowerCase()
  const explicit = /^(?:gemini-)?3[._ -](?:1[._ -]?pro|5[._ -]?flash[._ -]?lite|6[._ -]?flash|7[._ -]?flash)$/i.test(requested)
  return {
    ...body,
    model: explicit ? body.model : directModelForPrefs(prefs),
    reasoning_effort: prefs.thinkingEnabled === true ? 'adaptive' : 'default'
  }
}

async function proxyChat({ req, res, pathname, body, apiKey, pagePrefs = {} }) {
  await ensureRunning()
  const target = gatewayTarget()
  const encoded = Buffer.from(JSON.stringify(directBody(body, pagePrefs)), 'utf8')
  const sessionId = String(req.headers['x-lingxi-session-id'] || '').trim()
  const projectId = String(req.headers['x-lingxi-project-id'] || '').trim()
  const isolatedSessionId = sessionId ? [projectId, sessionId].filter(Boolean).join(':') : ''

  return new Promise((resolve, reject) => {
    const upstream = requestModule(target).request({
      hostname: target.hostname,
      port: target.port,
      method: 'POST',
      path: targetPath(pathname, target),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': encoded.length,
        Authorization: `Bearer ${DIRECT_API_KEY}`,
        'X-Client-Type': 'lingxi',
        'X-Gemini-Account': 'lingxi-gemini-web',
        ...(isolatedSessionId ? { 'X-Session-Id': isolatedSessionId } : {})
      }
    }, upstreamRes => {
      const contentType = upstreamRes.headers['content-type'] || 'application/json; charset=utf-8'
      res.writeHead(upstreamRes.statusCode || 502, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        ...(body.stream === true ? { Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } : {})
      })
      upstreamRes.pipe(res)
      upstreamRes.once('end', resolve)
      upstreamRes.once('error', reject)
    })
    upstream.setTimeout(11 * 60 * 1000, () => {
      upstream.destroy(Object.assign(new Error('Gemini 协议直连请求超时。'), { code: 'GEMINI_DIRECT_TIMEOUT' }))
    })
    upstream.once('error', error => {
      if (error?.code === 'ECONNREFUSED') {
        reject(Object.assign(new Error(
          'Gemini 通用协议网关没有运行（127.0.0.1:3410）。灵犀已尝试自动启动但连接仍被拒绝。'
        ), { code: 'GEMINI_DIRECT_REFUSED', cause: error }))
        return
      }
      reject(error)
    })
    req.once('aborted', () => upstream.destroy())
    upstream.end(encoded)
  })
}

function stopOwnedProcess() {
  const child = ownedProcess
  ownedProcess = null
  if (!child?.pid) return
  try { child.kill() } catch (_) { /* already stopped */ }
}

module.exports = {
  DIRECT_HOST,
  DIRECT_PORT,
  DIRECT_API_KEY,
  SESSION_IMPORT_API_KEY,
  gatewayTarget,
  gatewayRootCandidates,
  findGatewayRoot,
  getGatewayEntry,
  sessionFileCandidates,
  findSessionFile,
  resolveSessionFile,
  healthCheck,
  ensureRunning,
  importBrowserSession,
  directModelForPrefs,
  directBody,
  proxyChat,
  stopOwnedProcess
}
