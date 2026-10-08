/**
 * Gemini-style ChatGPT web.run: Node protocol, no Chrome window.
 * Cookies come from the already-logged-in web-bridge profile on disk.
 * Sentinel PoW/VM and Chrome TLS impersonation come from chatgpt-sentinel-node.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const {
  createPrepareBody,
  createWebRunConversationBody,
  createTextConversationBody,
  createImageConversationBody,
  buildUserSearchText
} = require('./conversation-body')
const { createSearchStreamState, consumeSseBlock, toProgressPayload } = require('./sse-progress')
const { buildModelSearchResult } = require('./model-result')
const { loadProtocolCookies } = require('./protocol-cookies')

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
const CLIENT_VERSION = 'prod-35e7446206039fbaa61eae866fcdd9d574a402d8'
const CLIENT_BUILD = '9599329'

function resolveSentinelRoot(explicit = '') {
  const candidates = [
    explicit,
    process.env.WEB_MODEL_GATEWAY_CHATGPT_SENTINEL_ROOT,
    process.env.GEMINI_AGENT_GATEWAY_CHATGPT_SENTINEL_ROOT,
    process.env.LINGXI_CHATGPT_SENTINEL_ROOT,
    path.resolve(__dirname, '..', '..', '..', '..', 'chatgpt-sentinel-node'),
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'chatgpt-sentinel-node')
  ]
  return candidates.find(dir => dir && fs.existsSync(path.join(dir, 'src', 'cf_http.py'))) || ''
}

function resolvePython(sentinelRoot, explicit = '') {
  const candidates = [
    explicit,
    sentinelRoot && path.join(sentinelRoot, '.venv', 'Scripts', 'python.exe'),
    sentinelRoot && path.join(sentinelRoot, '.venv', 'bin', 'python'),
    process.env.LINGXI_CHATGPT_CF_PYTHON,
    'python'
  ].filter(Boolean)
  const file = candidates.find(item => item === 'python' || fs.existsSync(item))
  return file || ''
}

function loadSentinel(sentinelRoot) {
  const src = path.join(sentinelRoot, 'src')
  return {
    generateRequirementsToken: require(path.join(src, 'pow')).generateRequirementsToken,
    solveProof: require(path.join(src, 'pow')).solveProof,
    requirementsFromVm: require(path.join(src, 'sdk-vm')).requirementsFromVm,
    solveFromVm: require(path.join(src, 'sdk-vm')).solveFromVm,
    loadRoute: require(path.join(src, 'net')).loadRoute,
    cfScript: path.join(src, 'cf_http.py')
  }
}

function cfRequest(python, script, { method = 'GET', url, headers = {}, body = null, proxy = '', timeout = 25, signal = null, save = '' } = {}) {
  const reqPath = path.join(os.tmpdir(), `lx-cws-cf-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`)
  fs.writeFileSync(reqPath, JSON.stringify({
    method,
    url,
    headers,
    body,
    proxy,
    impersonate: 'chrome146',
    timeout,
    save
  }))
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      try { fs.unlinkSync(reqPath) } catch (_) { /* ignore */ }
      reject(Object.assign(new Error('ChatGPT 网页搜索已取消。'), { code: 'ABORTED' }))
      return
    }
    let settled = false
    let timer = null
    const onAbort = () => child?.kill()
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      try { fs.unlinkSync(reqPath) } catch (_) { /* ignore */ }
      fn(value)
    }
    const child = spawn(python, [script, reqPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    })
    const chunks = []
    const errorChunks = []
    let bytes = 0
    timer = setTimeout(() => {
      child.kill()
      finish(reject, Object.assign(new Error('ChatGPT 协议请求超时。'), { code: 'CHAT_TIMEOUT' }))
    }, (timeout + 15) * 1000)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 20 * 1024 * 1024) {
        child.kill()
        finish(reject, Object.assign(new Error('ChatGPT 协议响应过大。'), { code: 'CHAT_FAILED' }))
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', chunk => {
      if (errorChunks.reduce((total, item) => total + item.length, 0) < 8192) errorChunks.push(chunk)
    })
    child.once('error', error => finish(reject, error))
    child.once('close', code => {
      if (signal?.aborted) {
        finish(reject, Object.assign(new Error('ChatGPT 网页搜索已取消。'), { code: 'ABORTED' }))
        return
      }
      if (code !== 0) {
        const detail = Buffer.concat(errorChunks).toString('utf8').trim().slice(0, 1200)
        finish(reject, Object.assign(new Error(detail ? `ChatGPT 协议请求失败：${detail}` : 'ChatGPT 协议请求失败。'), {
          code: 'CHAT_FAILED', exitCode: code
        }))
        return
      }
      try {
        finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        finish(reject, Object.assign(new Error('ChatGPT 协议响应无法解析。'), { code: 'CHAT_FAILED', cause: error }))
      }
    })
  })
}

function browserHeaders(cookieHeader, deviceId, extra = {}) {
  return {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
    Cookie: cookieHeader,
    'oai-device-id': deviceId,
    'oai-language': 'zh-CN',
    'oai-client-version': CLIENT_VERSION,
    'oai-client-build-number': CLIENT_BUILD,
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...extra
  }
}

function pickAccount(body) {
  const accounts = body?.accounts
  if (!accounts || typeof accounts !== 'object') return ''
  const ordering = Array.isArray(body.account_ordering) ? body.account_ordering : []
  const id = ordering[0] || Object.keys(accounts).find(key => key !== 'default') || ''
  const rec = (id && accounts[id]) || accounts.default || {}
  const nestedId = rec?.account?.account_id || rec?.id || ''
  const uuidKeys = Object.keys(accounts).filter(key => /^[0-9a-f-]{36}$/i.test(key))
  const mapId = id !== 'default' ? id : (uuidKeys[0] || '')
  return nestedId && nestedId !== 'default' ? nestedId : mapId
}

function fail(message, code) {
  throw Object.assign(new Error(message), { code })
}

function failParsedResult(parsed = {}, fallback = '', defaultCode = 'INVALID_MODEL_OUTPUT') {
  const message = String(parsed.error || parsed.assistantText || fallback || 'ChatGPT 没有返回可用结果。').trim()
  if (/达到限额|已达.*限额|quota|usage limit|rate limit/i.test(message)) fail(message, 'QUOTA_EXCEEDED')
  if (/temporar(?:y|ily) unavailable|暂时不可用|稍后重试|try again later/i.test(message)) fail(message, 'UPSTREAM_TRANSIENT')
  fail(message, defaultCode)
}

async function handshake({ python, sentinel, cookieHeader, deviceId, proxy, signal }) {
  const { generateRequirementsToken, solveProof, requirementsFromVm, solveFromVm } = sentinel
  const headers = browserHeaders(cookieHeader, deviceId, {
    'Content-Type': 'application/json',
    'X-OpenAI-Target-Path': '/backend-api/sentinel/chat-requirements/prepare',
    'X-OpenAI-Target-Route': '/backend-api/sentinel/chat-requirements/prepare'
  })

  const authSession = await cfRequest(python, sentinel.cfScript, {
    url: 'https://chatgpt.com/api/auth/session',
    headers: {
      ...headers,
      Accept: 'application/json',
      'X-OpenAI-Target-Path': '/api/auth/session',
      'X-OpenAI-Target-Route': '/api/auth/session'
    },
    proxy,
    signal
  })
  const accessToken = authSession.json?.accessToken || ''
  if (authSession.status === 403 || authSession.html) {
    fail('ChatGPT 登录已失效。请在设置里重新登录网页桥，然后关掉浏览器窗口再搜索。', 'LOGIN_REQUIRED')
  }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`

  const accounts = await cfRequest(python, sentinel.cfScript, {
    url: 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27',
    headers,
    proxy,
    signal
  })
  const accountId = pickAccount(accounts.json)
  if (accountId) headers['chatgpt-account-id'] = accountId

  let requirementsToken = ''
  try {
    const vm = await requirementsFromVm(deviceId)
    requirementsToken = vm?.token || ''
  } catch (_) {
    requirementsToken = ''
  }
  const p = requirementsToken || generateRequirementsToken()
  const prepare = await cfRequest(python, sentinel.cfScript, {
    method: 'POST',
    url: 'https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare',
    headers,
    body: JSON.stringify({ p }),
    proxy,
    signal
  })
  const challenge = prepare.json?.proofofwork?.seed ? prepare.json : null
  if (!challenge) fail('ChatGPT Sentinel 握手失败。', 'CHAT_FAILED')

  const portable = solveProof({
    seed: challenge.proofofwork.seed,
    difficulty: challenge.proofofwork.difficulty || '0'
  })
  let vmSolve = { turnstile: '', proof: '', soToken: '' }
  try {
    vmSolve = await solveFromVm(challenge, p, deviceId)
  } catch (_) { /* portable proof is enough for some sessions */ }

  const finalizeHeaders = {
    ...headers,
    'X-OpenAI-Target-Path': '/backend-api/sentinel/chat-requirements/finalize',
    'X-OpenAI-Target-Route': '/backend-api/sentinel/chat-requirements/finalize'
  }
  const variants = [
    {
      prepare_token: challenge.prepare_token,
      proofofwork: portable.token,
      turnstile: vmSolve.turnstile || ''
    },
    {
      prepare_token: challenge.prepare_token,
      proofofwork: vmSolve.proof || portable.token,
      turnstile: vmSolve.turnstile || ''
    },
    {
      prepare_token: challenge.prepare_token,
      proofofwork: portable.token
    }
  ]
  let finalize = null
  for (const body of variants) {
    const result = await cfRequest(python, sentinel.cfScript, {
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/sentinel/chat-requirements/finalize',
      headers: finalizeHeaders,
      body: JSON.stringify(body),
      proxy,
      signal
    })
    if (result.status === 200 && result.json?.token) {
      finalize = result
      break
    }
    if (result.json?.force_login === true) {
      fail('ChatGPT 登录已失效。请在设置里重新登录网页桥，然后关掉浏览器窗口再搜索。', 'LOGIN_REQUIRED')
    }
  }
  if (!finalize?.json?.token) fail('ChatGPT Sentinel 校验失败。', 'CHAT_FAILED')
  return { headers, challenge, portable, vmSolve, finalize }
}

async function postWebRun({ python, sentinel, handshakeState, proxy, queries, focus, model = 'auto', timeoutSec, signal }) {
  const { headers, challenge, portable, vmSolve, finalize } = handshakeState
  const parentMessageId = crypto.randomUUID()
  const prepareBody = createPrepareBody({ parentMessageId, model })
  const body = createWebRunConversationBody({
    queries,
    focus,
    model,
    userText: buildUserSearchText(queries, focus),
    parentMessageId,
    userMessageId: crypto.randomUUID()
  })
  const prepareHeaders = {
    ...headers,
    'X-OpenAI-Target-Path': '/backend-api/f/conversation/prepare',
    'X-OpenAI-Target-Route': '/backend-api/f/conversation/prepare',
    'openai-sentinel-chat-requirements-token': finalize.json.token,
    'openai-sentinel-chat-requirements-prepare-token': challenge.prepare_token || '',
    'openai-sentinel-proof-token': portable.token
  }
  if (vmSolve.turnstile) prepareHeaders['openai-sentinel-turnstile-token'] = vmSolve.turnstile
  if (vmSolve.soToken) prepareHeaders['openai-sentinel-so-token'] = vmSolve.soToken

  const prepared = await cfRequest(python, sentinel.cfScript, {
    method: 'POST',
    url: 'https://chatgpt.com/backend-api/f/conversation/prepare',
    headers: prepareHeaders,
    body: JSON.stringify(prepareBody),
    proxy,
    timeout: 30,
    signal
  })
  const conduit = prepared.json?.conduit_token
  if (!conduit) fail('ChatGPT 会话准备失败。', 'CHAT_FAILED')

  const convHeaders = {
    ...headers,
    Accept: 'text/event-stream',
    'X-OpenAI-Target-Path': '/backend-api/f/conversation',
    'X-OpenAI-Target-Route': '/backend-api/f/conversation',
    'x-conduit-token': conduit,
    'openai-sentinel-chat-requirements-token': finalize.json.token,
    'openai-sentinel-chat-requirements-prepare-token': challenge.prepare_token || '',
    'openai-sentinel-proof-token': portable.token,
    'OAI-Telemetry': '[1,null]'
  }
  if (vmSolve.turnstile) convHeaders['openai-sentinel-turnstile-token'] = vmSolve.turnstile
  if (vmSolve.soToken) convHeaders['openai-sentinel-so-token'] = vmSolve.soToken

  return cfRequest(python, sentinel.cfScript, {
    method: 'POST',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    headers: convHeaders,
    body: JSON.stringify(body),
    proxy,
    timeout: timeoutSec,
    signal
  })
}

function walkSse(value, visit, depth = 0) {
  if (value == null || depth > 14) return
  visit(value)
  if (Array.isArray(value)) {
    for (const item of value) walkSse(item, visit, depth + 1)
  } else if (typeof value === 'object') {
    for (const nested of Object.values(value)) walkSse(nested, visit, depth + 1)
  }
}

function parseConversationSse(text = '') {
  const snapshots = []
  const fileIds = new Set()
  const urls = new Set()
  let conversationId = ''
  let upstreamModel = ''
  let error = ''
  let patchedText = ''
  let finalSeed = ''
  let finalChannelActive = false
  let activeTextDelta = false
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let payload
    try { payload = JSON.parse(data) } catch (_) { continue }
    if (payload?.type === 'message_marker' && payload.marker === 'final_channel_token') finalChannelActive = true
    if (payload?.p === '/message/content/parts/0' && typeof payload.v === 'string') {
      if (payload.o === 'replace') patchedText = payload.v
      else if (payload.o === 'append' && finalChannelActive) patchedText += payload.v
      activeTextDelta = true
    } else if (typeof payload?.v === 'string' && Object.keys(payload).length === 1 && activeTextDelta && finalChannelActive) {
      // The current ChatGPT SSE codec emits one path-bearing delta followed by
      // pathless {v:"..."} continuations before the final patch frame.
      patchedText += payload.v
    } else if (payload?.p != null || payload?.o != null) {
      activeTextDelta = false
    }
    if (payload?.o === 'patch' && Array.isArray(payload.v)) {
      for (const operation of payload.v) {
        if (!operation || operation.p !== '/message/content/parts/0' || typeof operation.v !== 'string') continue
        if (operation.o === 'replace') patchedText = operation.v
        else if (operation.o === 'append' && finalChannelActive) patchedText += operation.v
      }
    }
    walkSse(payload, node => {
      if (typeof node === 'string') {
        for (const match of node.match(/file_[A-Za-z0-9]+/g) || []) fileIds.add(match)
        if (/^https?:\/\//i.test(node) && /oaiusercontent|estuary|files\/download/i.test(node)) urls.add(node)
        return
      }
      if (!node || typeof node !== 'object' || Array.isArray(node)) return
      if (node.conversation_id) conversationId = String(node.conversation_id)
      if (node.error && !error) error = String(node.error?.message || node.error)
      const model = node.metadata?.model_slug || node.message?.metadata?.model_slug
      if (model) upstreamModel = String(model)
      const message = node.message && typeof node.message === 'object' ? node.message : node
      const role = String(message.author?.role || '')
      const recipient = String(message.recipient || node.recipient || '')
      const parts = Array.isArray(message.content?.parts) ? message.content.parts : []
      const content = parts.map(part => typeof part === 'string' ? part : String(part?.text || part?.content || '')).join('\n').trim()
      if (role === 'assistant' && (!recipient || recipient === 'all') && content) {
        snapshots.push(content)
        if (message.channel === 'final' || message.content?.content_type === 'text') finalSeed = content
      }
      if (typeof node.download_url === 'string') urls.add(node.download_url)
      if (typeof node.url === 'string' && /oaiusercontent|estuary|files\/download/i.test(node.url)) urls.add(node.url)
    })
  }
  const patchedFinal = `${finalSeed}${patchedText}`.trim()
  const assistantText = patchedFinal || snapshots.sort((a, b) => b.length - a.length)[0] || ''
  return { assistantText, conversationId, upstreamModel, error, fileIds: [...fileIds], urls: [...urls] }
}

function parseChatGptModelCatalog(body = {}) {
  const records = Array.isArray(body?.models) ? body.models : []
  const bySlug = new Map(records
    .filter(model => model && typeof model.slug === 'string' && model.slug.trim())
    .map(model => [model.slug.trim().toLowerCase(), model]))
  const toEntry = slug => {
    const model = bySlug.get(slug)
    return {
      id: slug === 'auto' ? 'chatgpt-web-auto' : slug,
      upstreamModel: slug,
      label: String(model.title || slug),
      description: String(model.description || ''),
      maxTokens: Number(model.max_tokens) || null,
      reasoningType: String(model.reasoning_type || ''),
      configurableThinking: model.configurable_thinking_effort === true,
      thinkingEfforts: Array.isArray(model.thinking_efforts) ? model.thinking_efforts : [],
      enabledTools: Array.isArray(model.enabled_tools) ? model.enabled_tools : [],
      historyDisabledApproved: Array.isArray(model.tags) && model.tags.includes('history_off_approved')
    }
  }
  const visible = new Set()
  for (const version of Array.isArray(body?.versions) ? body.versions : []) {
    if (!version || version.enabled === false) continue
    for (const slug of Array.isArray(version.slugs) ? version.slugs : []) {
      if (bySlug.has(String(slug).toLowerCase())) visible.add(String(slug).toLowerCase())
    }
  }
  if (!visible.size) {
    for (const category of Array.isArray(body?.categories) ? body.categories : []) {
      if (!category) continue
      for (const slug of Array.isArray(category.supported_models) ? category.supported_models : []) {
        if (bySlug.has(String(slug).toLowerCase())) visible.add(String(slug).toLowerCase())
      }
      const fallback = String(category.default_model || '').toLowerCase()
      if (bySlug.has(fallback)) visible.add(fallback)
    }
  }
  const defaultModel = String(body?.default_model_slug || 'auto').trim().toLowerCase()
  if (bySlug.has(defaultModel)) visible.add(defaultModel)
  const models = [...visible].map(toEntry)
  return {
    defaultModel: defaultModel === 'auto' ? 'chatgpt-web-auto' : defaultModel,
    pickerVersion: Number(body?.model_picker_version) || null,
    models,
    allModels: [...bySlug.keys()].map(toEntry)
  }
}

async function prepareNodeRuntime(options = {}) {
  const session = await loadProtocolCookies({
    credentialsFile: options.credentialsFile,
    profileDir: options.profileDir,
    allowProfileFallback: options.allowProfileFallback === true
  })
  if (!session.ok) fail('还没有可用的 ChatGPT 登录 Cookie。请先在设置里登录网页桥并关闭浏览器窗口。', 'LOGIN_REQUIRED')
  const sentinelRoot = resolveSentinelRoot(options.sentinelRoot)
  if (!sentinelRoot) fail('找不到 ChatGPT 协议直连运行时（chatgpt-sentinel-node）。', 'NOT_CONFIGURED')
  const python = resolvePython(sentinelRoot, options.python)
  if (!python) fail('找不到 ChatGPT 协议直连的 TLS 伪装运行时。', 'NOT_CONFIGURED')
  const sentinel = loadSentinel(sentinelRoot)
  const route = sentinel.loadRoute?.() || {}
  const proxy = route.loopback && route.port ? `http://127.0.0.1:${route.port}` : ''
  const handshakeState = await handshake({
    python,
    sentinel,
    cookieHeader: session.cookieHeader,
    deviceId: session.deviceId || crypto.randomUUID(),
    proxy,
    signal: options.signal || null
  })
  return { python, sentinel, proxy, handshakeState }
}

async function fetchNodeModelCatalog(options = {}) {
  const runtime = options.runtime || await prepareNodeRuntime(options)
  const response = await cfRequest(runtime.python, runtime.sentinel.cfScript, {
    url: `https://chatgpt.com/backend-api/models?history_and_training_disabled=${options.historyDisabled !== false ? 'true' : 'false'}`,
    headers: {
      ...runtime.handshakeState.headers,
      Accept: 'application/json',
      'X-OpenAI-Target-Path': '/backend-api/models',
      'X-OpenAI-Target-Route': '/backend-api/models'
    },
    proxy: runtime.proxy,
    timeout: Math.ceil(Math.max(10000, Number(options.timeoutMs) || 30000) / 1000),
    signal: options.signal || null
  })
  if (response.status !== 200) {
    fail(`ChatGPT 模型发现失败（HTTP ${response.status || 0}）。`, response.status === 401 || response.status === 403 ? 'LOGIN_REQUIRED' : 'CHAT_FAILED')
  }
  const catalog = parseChatGptModelCatalog(response.json)
  if (!catalog.models.length) fail('ChatGPT 模型发现没有返回页面可选模型。', 'CHAT_FAILED')
  return catalog
}

async function postConversation({ runtime, body, prepareBody, timeoutSec = 180, signal = null }) {
  const { python, sentinel, proxy, handshakeState } = runtime
  const { headers, challenge, portable, vmSolve, finalize } = handshakeState
  const shared = {
    'openai-sentinel-chat-requirements-token': finalize.json.token,
    'openai-sentinel-chat-requirements-prepare-token': challenge.prepare_token || '',
    'openai-sentinel-proof-token': portable.token,
    ...(vmSolve.turnstile ? { 'openai-sentinel-turnstile-token': vmSolve.turnstile } : {}),
    ...(vmSolve.soToken ? { 'openai-sentinel-so-token': vmSolve.soToken } : {})
  }
  const prepared = await cfRequest(python, sentinel.cfScript, {
    method: 'POST',
    url: 'https://chatgpt.com/backend-api/f/conversation/prepare',
    headers: {
      ...headers,
      ...shared,
      'X-OpenAI-Target-Path': '/backend-api/f/conversation/prepare',
      'X-OpenAI-Target-Route': '/backend-api/f/conversation/prepare'
    },
    body: JSON.stringify(prepareBody),
    proxy,
    timeout: 30,
    signal
  })
  const conduit = prepared.json?.conduit_token
  if (!conduit) fail(`ChatGPT 会话准备失败${prepared.status ? `（HTTP ${prepared.status}）` : ''}。`, prepared.status === 401 || prepared.status === 403 ? 'LOGIN_REQUIRED' : 'CHAT_FAILED')
  return cfRequest(python, sentinel.cfScript, {
    method: 'POST',
    url: 'https://chatgpt.com/backend-api/f/conversation',
    headers: {
      ...headers,
      ...shared,
      Accept: 'text/event-stream',
      'X-OpenAI-Target-Path': '/backend-api/f/conversation',
      'X-OpenAI-Target-Route': '/backend-api/f/conversation',
      'x-conduit-token': conduit,
      'OAI-Telemetry': '[1,null]'
    },
    body: JSON.stringify(body),
    proxy,
    timeout: timeoutSec,
    signal
  })
}

async function runNodeChatText(options = {}) {
  const prompt = String(options.prompt || '').trim()
  if (!prompt) fail('ChatGPT prompt is required.', 'INVALID_REQUEST')
  const runtime = await prepareNodeRuntime(options)
  const parentMessageId = crypto.randomUUID()
  const model = String(options.model || 'auto')
  const prepareBody = createPrepareBody({ parentMessageId, model, historyDisabled: true })
  const body = createTextConversationBody({ prompt, parentMessageId, model, historyDisabled: true })
  const response = await postConversation({
    runtime, body, prepareBody,
    timeoutSec: Math.ceil(Math.max(15000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS) / 1000),
    signal: options.signal || null
  })
  if (response.status !== 200) fail(`ChatGPT 直连请求失败（HTTP ${response.status}）。`, response.status === 401 || response.status === 403 ? 'LOGIN_REQUIRED' : 'CHAT_FAILED')
  const parsed = parseConversationSse(response.text || '')
  if (!parsed.assistantText) failParsedResult(parsed, 'ChatGPT 没有返回可用文本。')
  return { text: parsed.assistantText, conversation: null, upstreamModel: parsed.upstreamModel || model, historyDisabled: true }
}

function allowedMediaUrl(value = '') {
  try {
    const url = new URL(String(value).startsWith('http') ? String(value) : `https://chatgpt.com${value}`)
    if (url.protocol !== 'https:') return ''
    if (url.hostname === 'chatgpt.com' && url.pathname.startsWith('/backend-api/')) return url.toString()
    if (/(^|\.)oaiusercontent\.com$/i.test(url.hostname)) return url.toString()
    return ''
  } catch (_) { return '' }
}

function collectMediaUrls(value, found = []) {
  walkSse(value, node => {
    if (typeof node === 'string' && (/^https?:\/\//i.test(node) || node.startsWith('/backend-api/'))) found.push(node)
  })
  return found
}

async function downloadGeneratedFile(runtime, fileId, signal = null) {
  const { python, sentinel, proxy, handshakeState } = runtime
  const headers = handshakeState.headers
  const downloadUrl = `https://chatgpt.com/backend-api/files/download/${encodeURIComponent(fileId)}`
  const firstPath = path.join(os.tmpdir(), `lx-cws-image-${process.pid}-${crypto.randomBytes(5).toString('hex')}.bin`)
  try {
    const first = await cfRequest(python, sentinel.cfScript, {
      url: downloadUrl,
      headers: { ...headers, Accept: 'application/json,image/*,*/*;q=0.8', 'X-OpenAI-Target-Path': `/backend-api/files/download/${fileId}`, 'X-OpenAI-Target-Route': '/backend-api/files/download/{file_id}' },
      proxy, timeout: 90, signal, save: firstPath
    })
    if (first.png && fs.existsSync(firstPath)) return { buffer: fs.readFileSync(firstPath), mimeType: first.contentType || 'image/png' }
    const signed = collectMediaUrls(first.json).map(allowedMediaUrl).find(url => /estuary\/content/i.test(url) && /[?&]sig=/i.test(url))
      || collectMediaUrls(first.json).map(allowedMediaUrl).find(Boolean)
    if (!signed) fail('ChatGPT 图片下载接口没有返回可用地址。', 'MEDIA_DOWNLOAD_FAILED')
    const secondPath = path.join(os.tmpdir(), `lx-cws-image-signed-${process.pid}-${crypto.randomBytes(5).toString('hex')}.bin`)
    try {
      const signedUrl = new URL(signed)
      const second = await cfRequest(python, sentinel.cfScript, {
        url: signed,
        headers: { ...headers, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', 'X-OpenAI-Target-Path': signedUrl.pathname, 'X-OpenAI-Target-Route': signedUrl.pathname },
        proxy, timeout: 120, signal, save: secondPath
      })
      if (!second.saved || !fs.existsSync(secondPath)) fail(`ChatGPT 图片下载失败（HTTP ${second.status || 0}）。`, 'MEDIA_DOWNLOAD_FAILED')
      return { buffer: fs.readFileSync(secondPath), mimeType: second.contentType || 'image/png' }
    } finally {
      try { fs.unlinkSync(secondPath) } catch (_) { /* ignore */ }
    }
  } finally {
    try { fs.unlinkSync(firstPath) } catch (_) { /* ignore */ }
  }
}

async function hideNodeConversation(runtime, conversationId, signal = null) {
  const id = String(conversationId || '').trim()
  if (!id) fail('ChatGPT 普通会话缺少 ID，无法在生图后隐藏。', 'CONVERSATION_ID_MISSING')
  const pathName = `/backend-api/conversation/${encodeURIComponent(id)}`
  const response = await cfRequest(runtime.python, runtime.sentinel.cfScript, {
    method: 'PATCH',
    url: `https://chatgpt.com${pathName}`,
    headers: {
      ...runtime.handshakeState.headers,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-OpenAI-Target-Path': pathName,
      'X-OpenAI-Target-Route': '/backend-api/conversation/{conversation_id}'
    },
    body: JSON.stringify({ is_visible: false }),
    proxy: runtime.proxy,
    timeout: 30,
    signal
  })
  if (response.status !== 200) fail(`ChatGPT 生图会话隐藏失败（HTTP ${response.status || 0}）。`, 'CONVERSATION_CLEANUP_FAILED')
  return { conversationId: id, hidden: true }
}

async function runNodeImageGeneration(options = {}) {
  const prompt = String(options.prompt || '').trim()
  if (!prompt) fail('ChatGPT image prompt is required.', 'INVALID_REQUEST')
  const runtime = options.runtime || await prepareNodeRuntime(options)
  const parentMessageId = crypto.randomUUID()
  const model = String(options.model || 'auto')
  const historyDisabled = options.historyDisabled !== false
  const prepareBody = createPrepareBody({ parentMessageId, model, historyDisabled })
  prepareBody.system_hints = ['picture_v2']
  prepareBody.model_response_contracts = [{ id: 'image_gen_tool', protocol_version: 1, presets: ['cap:image'] }]
  const body = createImageConversationBody({ prompt, parentMessageId, model, historyDisabled })
  const response = await postConversation({ runtime, body, prepareBody, timeoutSec: Math.ceil(Math.max(60000, Number(options.timeoutMs) || 300000) / 1000), signal: options.signal || null })
  if (response.status !== 200) fail(`ChatGPT 生图请求失败（HTTP ${response.status}）。`, response.status === 401 || response.status === 403 ? 'LOGIN_REQUIRED' : 'CHAT_FAILED')
  const parsed = parseConversationSse(response.text || '')
  let cleanup = null
  let operationError = null
  try {
    if (!parsed.fileIds.length) failParsedResult(parsed, 'ChatGPT 生图完成但没有返回图片文件。', 'MEDIA_MISSING')
    const images = []
    for (const fileId of parsed.fileIds.slice(0, Math.max(1, Number(options.count) || 1))) {
      images.push({ fileId, ...(await downloadGeneratedFile(runtime, fileId, options.signal || null)) })
    }
    return {
      images, conversationId: parsed.conversationId, upstreamModel: parsed.upstreamModel || model,
      historyDisabled, historyMode: historyDisabled ? 'temporary' : 'regular_hidden_after_generation'
    }
  } catch (error) {
    operationError = error
    throw error
  } finally {
    if (!historyDisabled && options.hideAfter === true) {
      try {
        cleanup = await hideNodeConversation(runtime, parsed.conversationId, options.signal || null)
      } catch (cleanupError) {
        if (!operationError) throw cleanupError
        operationError.cleanupError = cleanupError
      }
    }
  }
}

function ingestSse(text, onProgress) {
  const state = createSearchStreamState()
  const changed = consumeSseBlock(state, text)
  if (onProgress) onProgress(toProgressPayload(state), changed)
  return state
}

async function runNodeWebRunSearch(options = {}) {
  const queries = Array.isArray(options.queries) ? options.queries : []
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const timeoutMs = Math.max(15000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)

  const session = await loadProtocolCookies({
    credentialsFile: options.credentialsFile,
    profileDir: options.profileDir,
    allowProfileFallback: options.allowProfileFallback === true
  })
  if (!session.ok) {
    fail('还没有可用的 ChatGPT 登录 Cookie。请先在设置里登录网页桥并关闭浏览器窗口，搜索不会再打开 Chrome。', 'LOGIN_REQUIRED')
  }

  const sentinelRoot = resolveSentinelRoot(options.sentinelRoot)
  if (!sentinelRoot) {
    fail('找不到 ChatGPT 协议直连运行时（chatgpt-sentinel-node）。', 'NOT_CONFIGURED')
  }
  const python = resolvePython(sentinelRoot, options.python)
  if (!python) {
    fail('找不到 ChatGPT 协议直连的 TLS 伪装运行时。', 'NOT_CONFIGURED')
  }
  const sentinel = loadSentinel(sentinelRoot)
  const route = sentinel.loadRoute?.() || {}
  const proxy = route.loopback && route.port ? `http://127.0.0.1:${route.port}` : ''
  const deviceId = crypto.randomUUID()
  const signal = options.signal || null

  const handshakeState = await handshake({
    python,
    sentinel,
    cookieHeader: session.cookieHeader,
    deviceId,
    proxy,
    signal
  })
  if (onProgress) {
    onProgress({
      kind: 'chatgpt-web-search',
      stage: 'searching',
      queries,
      resultGroups: [],
      sourceCount: 0,
      error: ''
    }, { stage: true, any: true })
  }

  const conv = await postWebRun({
    python,
    sentinel,
    handshakeState,
    proxy,
    queries,
    focus: options.focus,
    model: String(options.model || 'auto'),
    timeoutSec: Math.ceil(timeoutMs / 1000),
    signal
  })
  if (conv.status && conv.status !== 200) {
    const detail = typeof conv.json?.detail === 'string' ? conv.json.detail.slice(0, 180) : ''
    fail(detail || `ChatGPT web.run 失败（HTTP ${conv.status}）。`, conv.status === 401 || conv.status === 403 ? 'LOGIN_REQUIRED' : 'CHAT_FAILED')
  }
  const state = ingestSse(conv.text || '', onProgress)
  if (!state.resultGroups.length && !state.webRunSeen && conv.json?.detail) {
    state.error = String(conv.json.detail).slice(0, 240)
  }
  const result = buildModelSearchResult(state, {
    query: queries[0],
    queries
  })
  const parsed = parseConversationSse(conv.text || '')
  result.upstreamModel = parsed.upstreamModel || String(options.model || 'auto')
  return result
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  resolveSentinelRoot,
  runNodeWebRunSearch,
  runNodeChatText,
  runNodeImageGeneration,
  parseConversationSse,
  parseChatGptModelCatalog,
  prepareNodeRuntime,
  fetchNodeModelCatalog,
  hideNodeConversation,
  postConversation,
  cfRequest
}
