/**
 * 能力调度里的搜索 API：把已勾选「搜索调用」的模型当成网页搜索后端。
 * 模型仍只调用 web_bridge_search；这里按调度优先级请求已接入的搜索接口。
 */

const config = require('./config')
const projects = require('./projects')
const storageConfig = require('./storage-config')
const { hasCapability, normalizeModel } = require('./model-capabilities')
const { hasApiKey, resolveApiKey } = require('./api-key')
const {
  createAskRequestId,
  waitForAskResponse,
  getResultLabel
} = require('./ask-permission')
const { sendThinkingEvent } = require('./thinking-event-sender')
const {
  getModelRoutingKey,
  getCapabilityPolicies
} = require('./tool-handlers/vision')
const modelBroker = require('./lingxi-harness/model-broker')

const SEARCH_TIMEOUT_MS = 30 * 1000

function toSearchModelConfig(model) {
  if (!model) return null
  const normalized = normalizeModel(model)
  if (!hasCapability(normalized, 'webSearch')) return null
  if (!normalized.apiUrl || !hasApiKey(normalized.apiKey)) return null
  return {
    ...normalized,
    modelId: normalized.modelId || normalized.modelName || 'web-search',
    modelName: normalized.modelName || normalized.modelId || '搜索 API'
  }
}

function listSearchModelsFromConfig() {
  const apiConfig = storageConfig.getApiConfig()
  const customModels = apiConfig?.success && Array.isArray(apiConfig.data?.models) ? apiConfig.data.models : []
  const routing = apiConfig?.success && apiConfig.data?.capabilityRouting && typeof apiConfig.data.capabilityRouting === 'object'
    ? apiConfig.data.capabilityRouting
    : {}
  const configuredOrder = Array.isArray(routing.webSearch)
    ? routing.webSearch.map(value => String(value || '').trim()).filter(Boolean)
    : []
  const normalizedModels = customModels.map(toSearchModelConfig).filter(Boolean)
  if (configuredOrder.length > 0) {
    const byKey = new Map(normalizedModels.map(model => [getModelRoutingKey(model), model]))
    const ordered = []
    const used = new Set()
    for (const modelKey of configuredOrder) {
      const model = byKey.get(modelKey)
      if (!model || used.has(modelKey)) continue
      ordered.push(model)
      used.add(modelKey)
    }
    normalizedModels.forEach(model => {
      const key = getModelRoutingKey(model)
      if (!used.has(key)) ordered.push(model)
    })
    return ordered
  }
  return normalizedModels
}

function findWebSearchModel(currentModelConfig, deps = {}) {
  if (typeof deps.findWebSearchModel === 'function') return deps.findWebSearchModel(currentModelConfig)
  const current = toSearchModelConfig(currentModelConfig)
  const configured = Array.isArray(deps.searchModels)
    ? deps.searchModels
    : modelBroker.getConfiguredModels()
  const apiConfig = storageConfig.getApiConfig()
  const routing = deps.capabilityRouting || (
    apiConfig?.success && apiConfig.data?.capabilityRouting &&
    typeof apiConfig.data.capabilityRouting === 'object'
      ? apiConfig.data.capabilityRouting
      : {}
  )
  const route = modelBroker.resolveCapabilityModel('webSearch', current, {
    availableModels: configured.map(toSearchModelConfig).filter(Boolean),
    capabilityRouting: routing,
    isUsableModel: model => !!model
  })
  return route?.model || null
}

function looksLikeTinyfish(endpoint = '', model = {}) {
  const text = `${endpoint} ${model.apiUrl || ''} ${model.modelId || ''} ${model.modelName || ''}`.toLowerCase()
  return /tinyfish/.test(text) || /api\.search\.tinyfish\.ai/.test(text)
}

function inferSearchLocale(query = '') {
  return /[\u4e00-\u9fff]/.test(String(query || ''))
    ? { location: 'CN', language: 'zh' }
    : { location: 'US', language: 'en' }
}

function buildSearchEndpoint(model = {}, apiUrl = '') {
  const raw = String(apiUrl || model.apiUrl || '').trim()
  if (!raw) return ''
  if (looksLikeTinyfish(raw, model)) {
    try {
      const parsed = new URL(raw)
      if (/search\.tinyfish\.ai$/i.test(parsed.hostname)) {
        return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '') || '/'}`
      }
    } catch {
      return 'https://api.search.tinyfish.ai'
    }
    return 'https://api.search.tinyfish.ai'
  }
  if (model.useFullUrl === true || model.fullUrl === true || model.apiUrlMode === 'full') return raw
  const lower = raw.toLowerCase()
  if (/tavily\.com/i.test(raw)) {
    return /\/search\/?$/i.test(raw) ? raw : raw.replace(/\/+$/, '') + '/search'
  }
  if (/serper\.dev/i.test(raw)) {
    return /\/search\/?$/i.test(raw) ? raw : raw.replace(/\/+$/, '') + '/search'
  }
  if (/bochaai\.com/i.test(raw)) {
    if (/\/web-search\/?$/i.test(raw)) return raw
    if (/\/v1\/?$/i.test(raw)) return raw.replace(/\/+$/, '') + '/web-search'
    return raw.replace(/\/+$/, '') + '/v1/web-search'
  }
  if (/search\.brave\.com/i.test(raw)) {
    return /\/web\/search/i.test(raw) ? raw : 'https://api.search.brave.com/res/v1/web/search'
  }
  if (/bing\.microsoft\.com/i.test(raw)) {
    return /\/search\/?$/i.test(raw) ? raw : 'https://api.bing.microsoft.com/v7.0/search'
  }
  if (/\/(search|web-search|serp)(\/|$|\?)/i.test(raw)) return raw
  if (/\/(chat\/completions|messages|responses)\/?$/i.test(raw)) return raw
  if (/\/v1\/?$/i.test(raw) && /openai|anthropic|openrouter|together|fireworks|deepseek|dashscope|bigmodel/i.test(lower)) {
    return raw.replace(/\/+$/, '') + '/chat/completions'
  }
  return raw.replace(/\/+$/, '')
}

function getSearchProviderKind(endpoint = '', model = {}) {
  const text = `${endpoint} ${model.modelId || ''} ${model.modelName || ''}`.toLowerCase()
  if (/tinyfish/.test(text) || /api\.search\.tinyfish\.ai/.test(endpoint)) return 'tinyfish'
  if (/tavily/.test(text)) return 'tavily'
  if (/serper/.test(text)) return 'serper'
  if (/brave/.test(text)) return 'brave'
  if (/bing\.microsoft/.test(text)) return 'bing'
  if (/bocha/.test(text)) return 'bocha'
  if (/\/(chat\/completions|messages|responses)/.test(endpoint)) return 'chat'
  return 'generic'
}

function asSource(title, url, snippet) {
  const href = String(url || '').trim().replace(/[.,;:!?)]+$/, '')
  if (!/^https?:\/\//i.test(href)) return null
  return {
    title: String(title || href).trim().slice(0, 160) || href,
    url: href,
    snippet: String(snippet || '').trim().slice(0, 400)
  }
}

function collectSources(items, mapFn) {
  const sources = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const source = mapFn(item)
    if (!source) continue
    const key = source.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    sources.push(source)
  }
  return sources.slice(0, 12)
}

function formatSourcesAnswer(sources = [], answer = '') {
  const lines = sources.map((item, index) => {
    const snippet = item.snippet ? `\n   ${item.snippet}` : ''
    return `${index + 1}. ${item.title}${snippet}\n   ${item.url}`
  })
  return [String(answer || '').trim(), lines.join('\n')].filter(Boolean).join('\n\n')
}

function parseSearchPayload(payload) {
  const { extractSources, parseChatCompletion } = require('./web-bridge-search')
  if (payload == null) return { answer: '', sources: [] }
  if (typeof payload === 'string') {
    const answer = payload.trim()
    return { answer, sources: extractSources(answer) }
  }

  const tavily = collectSources(payload.results, item => asSource(item?.title, item?.url || item?.link, item?.content || item?.snippet || item?.body))
  if (tavily.length) {
    return { answer: formatSourcesAnswer(tavily, payload.answer), sources: tavily }
  }

  const serper = collectSources(payload.organic, item => asSource(item?.title, item?.link || item?.url, item?.snippet))
  if (serper.length) {
    return { answer: formatSourcesAnswer(serper), sources: serper }
  }

  const bing = collectSources(payload.webPages?.value, item => asSource(item?.name || item?.title, item?.url, item?.snippet))
  if (bing.length) {
    return { answer: formatSourcesAnswer(bing), sources: bing }
  }

  const brave = collectSources(payload.web?.results, item => asSource(item?.title, item?.url, item?.description || item?.snippet))
  if (brave.length) {
    return { answer: formatSourcesAnswer(brave), sources: brave }
  }

  const bocha = collectSources(payload.data?.webPages?.value || payload.data?.webPages, item => asSource(item?.name || item?.title, item?.url, item?.snippet || item?.summary))
  if (bocha.length) {
    return { answer: formatSourcesAnswer(bocha), sources: bocha }
  }

  const generic = collectSources(payload.data || payload.items || payload.sources || payload.documents, item => asSource(item?.title || item?.name, item?.url || item?.link || item?.href, item?.snippet || item?.content || item?.text))
  if (generic.length) {
    return { answer: formatSourcesAnswer(generic, payload.answer), sources: generic }
  }

  const chat = parseChatCompletion(payload)
  if (chat) return { answer: chat, sources: extractSources(chat) }
  return { answer: '', sources: [] }
}

function buildSearchRequest(model, queries, focus = '') {
  const endpoint = buildSearchEndpoint(model)
  const key = resolveApiKey(model.apiKey)
  const kind = getSearchProviderKind(endpoint, model)
  const query = queries[0] || ''
  const extra = String(focus || '').trim()
  const headers = { 'Content-Type': 'application/json' }
  let method = 'POST'
  let url = endpoint
  let body = null

  if (kind === 'tinyfish') {
    const locale = inferSearchLocale(query)
    const params = new URLSearchParams({
      query,
      location: locale.location,
      language: locale.language
    })
    if (extra) params.set('purpose', extra.slice(0, 2000))
    method = 'GET'
    url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`
    headers['X-API-Key'] = key
    delete headers['Content-Type']
  } else if (kind === 'tavily') {
    headers.Authorization = `Bearer ${key}`
    body = {
      api_key: key,
      query,
      max_results: 8,
      search_depth: 'basic',
      include_answer: true
    }
  } else if (kind === 'serper') {
    headers['X-API-KEY'] = key
    body = { q: query }
  } else if (kind === 'brave') {
    method = 'GET'
    url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}&count=8`
    headers['X-Subscription-Token'] = key
    delete headers['Content-Type']
  } else if (kind === 'bing') {
    method = 'GET'
    url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}&count=8`
    headers['Ocp-Apim-Subscription-Key'] = key
    delete headers['Content-Type']
  } else if (kind === 'bocha') {
    headers.Authorization = `Bearer ${key}`
    body = { query, count: 8, summary: true }
  } else if (kind === 'chat') {
    const { buildSearchPrompt } = require('./web-bridge-search')
    headers.Authorization = `Bearer ${key}`
    body = {
      model: model.modelId || model.modelName || 'search',
      stream: false,
      messages: [{ role: 'user', content: buildSearchPrompt(queries, extra) }]
    }
  } else {
    headers.Authorization = `Bearer ${key}`
    body = {
      query,
      q: query,
      queries,
      ...(extra ? { focus: extra } : {}),
      ...(model.modelId ? { model: model.modelId } : {})
    }
  }

  return { url, method, headers, body, kind }
}

async function askWebSearchPermission(projectId, query, searchModel) {
  const webContents = projectId ? projects.getWebContentsForProject(projectId) : config.getMainWindow()?.webContents
  if (!webContents) {
    return { success: false, status: 'user_rejected', message: '无法显示搜索授权弹窗' }
  }

  const requestId = createAskRequestId(projectId, 'web_search')
  const modelName = searchModel.modelName || searchModel.modelId || '搜索 API'
  sendThinkingEvent(webContents, projectId, {
    kind: 'progress',
    content: `需要调用搜索 API「${modelName}」检索网页，等待你确认。`
  })
  webContents.send('show-ask-popup', {
    requestId,
    type: 'plan',
    projectId,
    question: `是否允许调用搜索 API「${modelName}」检索网页？`,
    options: [
      {
        label: '允许搜索',
        value: 'approved',
        desc: query ? `查询：${String(query).slice(0, 80)}` : '按当前问题检索公开网页'
      },
      {
        label: '不搜索',
        value: 'rejected',
        desc: '跳过本次搜索 API 调用'
      }
    ],
    recommended: 'approved'
  })
  return waitForAskResponse(projectId, requestId)
}

async function searchWithCapabilityApi(args = {}, ctx = {}, deps = {}) {
  const { normalizeQueryList } = require('./web-bridge-search')
  const queries = typeof deps.normalizeQueryList === 'function'
    ? deps.normalizeQueryList(args)
    : normalizeQueryList(args)
  if (!queries.length) {
    return { skipped: true, reason: 'empty_query' }
  }

  const searchModel = findWebSearchModel(ctx.modelConfig, deps)
  if (!searchModel) {
    return { skipped: true, reason: 'no_search_model' }
  }

  const policies = typeof deps.getCapabilityPolicies === 'function'
    ? deps.getCapabilityPolicies()
    : getCapabilityPolicies()
  if (policies.webSearchConfirm === 'always' && args.skipPermission !== true) {
    const permission = await askWebSearchPermission(ctx.projectId || '', queries[0], searchModel)
    const permissionValue = getResultLabel(permission)
    if (!permission.success || permissionValue === 'rejected') {
      return {
        success: false,
        status: 'user_rejected',
        error: '用户取消了本次搜索 API 调用。',
        provider: 'capability-api',
        providerLabel: searchModel.modelName
      }
    }
  }

  const request = buildSearchRequest(searchModel, queries, args.focus)
  if (!request.url) {
    return {
      success: false,
      skipped: false,
      error: '搜索 API 缺少有效地址。',
      provider: 'capability-api',
      providerLabel: searchModel.modelName,
      code: 'NOT_CONFIGURED'
    }
  }

  const timeoutMs = Math.max(8000, Number(args.timeout_ms) || SEARCH_TIMEOUT_MS)
  const fetchImpl = deps.fetchImpl || fetch
  let response
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: ctx.signal || (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined)
    })
  } catch (error) {
    return {
      success: false,
      skipped: false,
      error: error.message || String(error),
      provider: 'capability-api',
      providerLabel: searchModel.modelName,
      code: error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'SEARCH_TIMEOUT' : 'SEARCH_FAILED'
    }
  }

  const raw = await response.text()
  let payload = null
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    payload = raw
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `${searchModel.modelName} 搜索失败（HTTP ${response.status}）`
    return {
      success: false,
      skipped: false,
      error: message,
      provider: 'capability-api',
      providerLabel: searchModel.modelName,
      code: payload?.error?.code || 'SEARCH_FAILED',
      status: response.status
    }
  }

  const parsed = parseSearchPayload(payload)
  if (!parsed.answer && !parsed.sources.length) {
    return {
      success: false,
      skipped: false,
      error: `${searchModel.modelName} 没有返回可用来源。`,
      provider: 'capability-api',
      providerLabel: searchModel.modelName,
      code: 'EMPTY_ANSWER'
    }
  }

  const { clipText } = require('./web-bridge-search')
  return {
    success: true,
    engine: 'capability-api',
    provider: 'capability-api',
    providerLabel: searchModel.modelName,
    modelId: searchModel.modelId || '',
    query: queries[0],
    queries,
    answer: clipText(parsed.answer || formatSourcesAnswer(parsed.sources)),
    sources: parsed.sources
  }
}

module.exports = {
  SEARCH_TIMEOUT_MS,
  toSearchModelConfig,
  findWebSearchModel,
  listSearchModelsFromConfig,
  looksLikeTinyfish,
  inferSearchLocale,
  buildSearchEndpoint,
  getSearchProviderKind,
  parseSearchPayload,
  buildSearchRequest,
  searchWithCapabilityApi
}
