/**
 * API 模型走已登录页面模型做公开检索。
 * 使用网页桥 passthrough 会话，不注入编码协议，也不占用灵犀主对话页。
 */

const SEARCH_SESSION_ID = 'web-bridge-search'
const SEARCH_AGENT_ID = 'web-bridge-search'
const PAGE_CHAT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = PAGE_CHAT_TIMEOUT_MS + 30 * 1000
const ANSWER_KEEP = 12000

const PROVIDER_DEFS = [
  { id: 'chatgpt', label: 'ChatGPT 网页版', load: () => require('./chatgpt-image-bridge') },
  { id: 'grok', label: 'Grok 网页版', load: () => require('./grok-web-bridge') },
  { id: 'deepseek', label: 'DeepSeek 网页版', load: () => require('./deepseek-web-bridge') },
  { id: 'qwen', label: '通义网页版', load: () => require('./qwen-web-bridge') },
  { id: 'gemini', label: 'Gemini 网页版', load: () => require('./gemini-web-bridge') },
  { id: 'claude', label: 'Claude 网页版', load: () => require('./claude-web-bridge') },
  { id: 'arena', label: 'Arena 网页版', load: () => require('./arena-web-bridge') }
]

function clipText(value = '', maxChars = ANSWER_KEEP) {
  const text = String(value || '')
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`
}

function normalizeQueryList(args = {}) {
  const items = []
  const push = value => {
    const text = String(value || '').trim()
    if (text && !items.includes(text)) items.push(text)
  }
  push(args.query)
  const extra = args.queries || args.query_list || args.queryList || args.keywords
  if (Array.isArray(extra)) extra.forEach(push)
  else push(extra)
  return items
}

function buildSearchPrompt(queries = [], focus = '') {
  const list = (Array.isArray(queries) ? queries : [queries]).map(item => String(item || '').trim()).filter(Boolean)
  const question = list.length <= 1
    ? (list[0] || '')
    : list.map((item, index) => `${index + 1}. ${item}`).join('\n')
  const extra = String(focus || '').trim()
  return [
    '请查询并回答：',
    question,
    extra,
    '请给出简明结论、带日期的关键事实，以及来源标题和网址。不确定就标明不确定。'
  ].filter(Boolean).join('\n\n')
}

function extractSources(text = '') {
  const sources = []
  const seen = new Set()
  const add = (title, url) => {
    const href = String(url || '').trim().replace(/[.,;:!?)]+$/, '')
    if (!/^https?:\/\//i.test(href)) return
    const key = href.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    sources.push({
      title: String(title || href).trim().slice(0, 160) || href,
      url: href
    })
  }
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
  let match
  while ((match = markdown.exec(String(text || '')))) add(match[1], match[2])
  const bare = /https?:\/\/[^\s)\]>'"]+/g
  while ((match = bare.exec(String(text || '')))) add('', match[0])
  return sources.slice(0, 12)
}

function parseChatCompletion(payload) {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload.trim()
  const choice = payload?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.map(part => String(part?.text || part?.content || '')).join('\n').trim()
  }
  return String(payload?.output_text || payload?.content || '').trim()
}

function inspectProvider(def) {
  let moduleRef = null
  try {
    moduleRef = def.load()
  } catch (error) {
    return {
      id: def.id,
      label: def.label,
      available: false,
      error: error.message || String(error)
    }
  }
  let status = {}
  try {
    status = moduleRef.getStatus?.() || {}
  } catch (error) {
    status = { lastError: error.message || String(error) }
  }
  let suggested = null
  try {
    suggested = moduleRef.getSuggestedChatModel?.() || null
  } catch (_) {
    suggested = null
  }
  return {
    id: def.id,
    label: def.label,
    module: moduleRef,
    status,
    suggested,
    available: true,
    running: !!status.running,
    loggedIn: !!status.loggedIn,
    loginBrowserOpen: !!status.loginBrowserOpen,
    busy: !!status.activeJob,
    lastError: String(status.lastError || '')
  }
}

function getSearchSettings(deps = {}) {
  const schedule = require('./chatgpt-web-search/search-tool-order').readSearchSchedule(deps)
  return {
    pageSearchEnabled: schedule.pageSearchEnabled,
    searchProviderOrder: schedule.searchToolOrder
  }
}

function normalizeProviderOrder(order) {
  try {
    return require('./chatgpt-web-search/search-tool-order').normalizeSearchToolOrder(order)
  } catch (_) {
    return require('./web-bridge-chrome-profile').normalizeSearchProviderOrder(order)
  }
}

function listProviders() {
  return PROVIDER_DEFS.map(inspectProvider)
}

function rankProviders(providers = [], orderOrOptions = '') {
  const options = typeof orderOrOptions === 'string' || orderOrOptions == null
    ? { preferredId: orderOrOptions || '' }
    : orderOrOptions
  const preferred = String(options.preferredId || '').trim().toLowerCase()
  const order = normalizeProviderOrder(options.order)
  const ready = providers.filter(item => item.available && item.suggested?.apiUrl && item.suggested?.apiKey)
  const orderIndex = id => {
    const index = order.indexOf(id)
    return index < 0 ? order.length + 1 : index
  }
  const readiness = item => {
    if (preferred && item.id === preferred) return 400
    if (item.loggedIn && item.running && !item.loginBrowserOpen) return 300
    if (item.loggedIn && !item.loginBrowserOpen) return 250
    if (item.running && !item.loginBrowserOpen) return 200
    if (item.loggedIn) return 150
    return 50
  }
  return ready.slice().sort((left, right) => {
    const leftOrder = orderIndex(left.id)
    const rightOrder = orderIndex(right.id)
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return readiness(right) - readiness(left) || left.id.localeCompare(right.id)
  })
}

function mergeAbortSignal(signal, timeoutMs) {
  const timeout = Math.max(15000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function') {
    const timer = AbortSignal.timeout(timeout)
    return signal ? AbortSignal.any([signal, timer]) : timer
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('页面搜索超时'), { code: 'CHAT_TIMEOUT' })), timeout)
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      controller.abort(signal.reason)
    } else {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        controller.abort(signal.reason)
      }, { once: true })
    }
  }
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

async function postPassthroughChat(provider, { prompt, projectId, signal, timeoutMs, fetchImpl }) {
  const suggested = provider.suggested
  if (!suggested?.apiUrl || !suggested?.apiKey) {
    throw Object.assign(new Error(`${provider.label} 尚未配置本地网关。`), { code: 'NOT_CONFIGURED' })
  }
  if (provider.loginBrowserOpen) {
    throw Object.assign(new Error(`${provider.label} 正在登录。请先完成登录并关闭专用 Chrome 窗口。`), { code: 'LOGIN_BROWSER_STILL_OPEN' })
  }
  if (!provider.running && typeof provider.module.startServer === 'function') {
    await provider.module.startServer()
  }
  const endpoint = String(suggested.apiUrl).replace(/\/+$/, '') + '/chat/completions'
  const requestSignal = mergeAbortSignal(signal, timeoutMs)
  const response = await (fetchImpl || fetch)(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${suggested.apiKey}`,
      'X-Lingxi-Bridge-Mode': 'passthrough',
      'X-Lingxi-Session-Id': SEARCH_SESSION_ID,
      'X-Lingxi-Agent-Id': SEARCH_AGENT_ID,
      'X-Lingxi-Project-Id': String(projectId || '')
    },
    body: JSON.stringify({
      model: suggested.modelId || provider.id,
      stream: false,
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: requestSignal
  })
  const raw = await response.text()
  let payload = null
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    payload = { error: { message: raw } }
  }
  if (!response.ok) {
    const message = payload?.error?.message || `${provider.label} 搜索失败（HTTP ${response.status}）`
    throw Object.assign(new Error(message), {
      code: payload?.error?.code || 'CHAT_FAILED',
      status: response.status
    })
  }
  const answer = parseChatCompletion(payload)
  if (!answer) {
    throw Object.assign(new Error(`${provider.label} 没有返回可用来源。`), { code: 'EMPTY_ANSWER' })
  }
  return {
    success: true,
    provider: provider.id,
    providerLabel: provider.label,
    modelId: suggested.modelId || '',
    answer: clipText(answer),
    sources: extractSources(answer)
  }
}

function unavailableResult(attempts = []) {
  const detail = attempts.map(item => `${item.label}: ${item.error}`).join('；')
  return {
    success: false,
    status: 'capability_unavailable',
    code: 'NO_SEARCH_BACKEND',
    error: detail
      ? `页面模型搜索不可用。${detail} 可改用 lxweb action=search，或打开/抓取已知网址。`
      : '当前没有已登录的页面模型。请先在设置中登录 ChatGPT / Grok / DeepSeek 等网页桥；也可改用 lxweb action=search。已知网址可用 lxweb 打开或抓取。',
    next_action: 'login_web_bridge_or_use_lxweb_search',
    attempts
  }
}

async function searchWithWebBridge(args = {}, ctx = {}, deps = {}) {
  const { isChatGptWebChatPrimary, searchWithChatGptWeb } = require('./chatgpt-web-search')
  const { getPageProviderOrder } = require('./chatgpt-web-search/search-tool-order')
  const modelConfig = ctx.modelConfig || {}
  if (isChatGptWebChatPrimary(modelConfig, modelConfig.modelId || modelConfig.model || '')) {
    return {
      success: false,
      skipped: true,
      error: '当前已经是 ChatGPT 网页模型，请直接用页面自带搜索回答，不要再调用 web_bridge_search。'
    }
  }

  const queries = normalizeQueryList(args)
  if (!queries.length) {
    return { success: false, error: '请提供 query 或 queries。' }
  }

  const attempts = []
  if (deps.skipCapabilitySearch !== true) {
    const { searchWithCapabilityApi } = require('./capability-web-search')
    const capabilitySearch = deps.searchWithCapabilityApi || searchWithCapabilityApi
    const capabilityResult = await capabilitySearch(args, ctx, deps)
    if (capabilityResult?.success) return capabilityResult
    if (capabilityResult?.status === 'user_rejected') return capabilityResult
    if (capabilityResult && capabilityResult.skipped !== true) {
      attempts.push({
        id: 'capability-api',
        label: capabilityResult.providerLabel || '搜索 API',
        error: capabilityResult.error || '搜索 API 调用失败',
        code: capabilityResult.code || ''
      })
    }
  }

  const settings = getSearchSettings(deps)
  if (!settings.pageSearchEnabled) {
    const { hasConfiguredSearchModel } = require('./chatgpt-web-search/search-tool-order')
    const hasSearchModel = hasConfiguredSearchModel(deps) || attempts.some(item => item.id === 'capability-api')
    if (attempts.length) {
      const first = attempts[0]
      return {
        success: false,
        skipped: false,
        error: `搜索模型「${first.label}」未能完成检索：${first.error} 网页桥搜索已关闭，不会改走 ChatGPT web.run。可检查该搜索模型，或改用 lxweb action=search。`,
        next_action: 'fix_search_model_or_use_lxweb',
        attempts
      }
    }
    if (hasSearchModel) {
      return {
        success: false,
        skipped: true,
        error: '网页桥搜索已关闭。请继续使用 web_search 调用已配置的搜索模型；不要调用 web_bridge_search。仅当搜索模型也失败时再用 lxweb 搜索。',
        next_action: 'use_web_search',
        attempts
      }
    }
    return {
      success: false,
      skipped: true,
      error: '已关闭网页桥搜索，且当前没有可调用的搜索模型。请使用 lxweb 进行公开检索，或在能力调度中配置搜索模型。',
      next_action: 'use_lxweb_search',
      attempts
    }
  }

  const pageOrder = getPageProviderOrder(settings.searchProviderOrder)
  const fetchImpl = deps.fetchImpl
  const providers = (deps.listProviders || listProviders)()

  for (const providerId of pageOrder) {
    if (providerId === 'chatgpt') {
      const chatgptResult = await searchWithChatGptWeb(args, ctx, {
        ...deps,
        pageSearchEnabled: true
      })
      if (chatgptResult?.success) return chatgptResult
      attempts.push({
        id: 'chatgpt',
        label: 'ChatGPT web.run',
        error: chatgptResult?.error || 'ChatGPT web.run 搜索失败',
        code: chatgptResult?.code || ''
      })
      const code = chatgptResult?.code || ''
      if (code === 'LOGIN_REQUIRED' || code === 'LOGIN_BROWSER_STILL_OPEN' || code === 'NOT_CONFIGURED') continue
      if (chatgptResult?.skipped) return chatgptResult
      continue
    }

    const ranked = rankProviders(providers, { order: [providerId, ...pageOrder], preferredId: providerId })
    const provider = ranked.find(item => item.id === providerId)
    if (!provider) continue
    try {
      const result = await postPassthroughChat(provider, {
        prompt: buildSearchPrompt(queries, args.focus),
        projectId: ctx.projectId || '',
        signal: ctx.signal,
        timeoutMs: args.timeout_ms,
        fetchImpl
      })
      return {
        ...result,
        query: queries[0],
        queries,
        engine: 'web-bridge'
      }
    } catch (error) {
      const abortLike = error?.name === 'AbortError' || error?.name === 'TimeoutError'
      const code = error?.code || (abortLike ? 'CHAT_TIMEOUT' : '')
      attempts.push({
        id: provider.id,
        label: provider.label,
        error: error.message || String(error),
        code
      })
      if (code === 'LOGIN_REQUIRED' || code === 'LOGIN_BROWSER_STILL_OPEN' || code === 'NOT_CONFIGURED') continue
      if (code === 'CHAT_TIMEOUT') {
        return {
          success: false,
          error: error.message || String(error),
          code,
          provider: provider.id,
          providerLabel: provider.label,
          attempts
        }
      }
    }
  }
  return unavailableResult(attempts)
}

module.exports = {
  SEARCH_SESSION_ID,
  PAGE_CHAT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  PROVIDER_DEFS,
  clipText,
  normalizeQueryList,
  buildSearchPrompt,
  extractSources,
  parseChatCompletion,
  listProviders,
  rankProviders,
  searchWithWebBridge
}
