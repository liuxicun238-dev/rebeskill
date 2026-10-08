const storageConfig = require('./storage-config')
const { ProxyAgent } = require('undici')
const { resolveApiKey } = require('./api-key')
const { applyPromptCacheBodyHints, applyPromptCacheHeaderHints } = require('./prompt-cache-capabilities')
const { stableJsonStringify } = require('./prompt-stability')
const cloudTokenUsage = require('./cloud-token-usage')
const {
  getApiFormat,
  buildApiEndpoint,
  buildApiHeaders,
  buildApiFetchOptions,
  buildModelRequestBody,
  extractModelResponseContent
} = require('./model-api-adapter')
const { isChatGptWebBridgeModel, isGeminiSparkAgentModel } = require('./capability-tiers')

const DEFAULT_TIMEOUT_MS = 90000
const proxyAgentCache = new Map()

function normalizeUrl(url = '') {
  return String(url || '').trim().replace(/\/+$/, '')
}

function getProxyDispatcher(config = {}) {
  const enabled = config.proxyEnabled === true || config.apiProxyEnabled === true || config.useProxy === true
  const proxyUrl = String(config.apiProxyUrl || config.proxyUrl || config.proxy || '').trim()
  if (!enabled || !/^https?:\/\//i.test(proxyUrl)) return null
  if (!proxyAgentCache.has(proxyUrl)) proxyAgentCache.set(proxyUrl, new ProxyAgent(proxyUrl))
  return proxyAgentCache.get(proxyUrl)
}

function isDeepSeekModelConfig(config = {}) {
  return /deepseek|api\.deepseek\.com/.test([
    config.apiUrl, config.provider, config.apiType, config.model, config.modelId, config.modelName
  ].filter(Boolean).join(' ').toLowerCase())
}

function shouldUseJsonResponseFormat(config = {}, options = {}) {
  if (options.jsonMode === false || options.responseFormat === false) return false
  if (config.jsonMode === false || config.responseFormat === false || config.response_format === false) return false
  if (options.jsonMode === true || options.responseFormat === true) return true
  return isDeepSeekModelConfig(config)
}

function parseJsonObject(text = '') {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch (_) {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()) } catch (_) {}
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)) } catch (_) {}
  }

  // 推理模型可能先输出 <think>，说明文字中也可能包含无关大括号。
  // 从后往前寻找字符串转义安全的完整 JSON 对象，优先采用最后一个有效对象。
  const sections = []
  const thinkEnd = raw.toLowerCase().lastIndexOf('</think>')
  if (thinkEnd >= 0) sections.push(raw.slice(thinkEnd + '</think>'.length))
  sections.push(raw)
  for (const section of sections) {
    const candidates = []
    for (let offset = 0; offset < section.length; offset += 1) {
      if (section[offset] !== '{') continue
      let depth = 0
      let inString = false
      let escaped = false
      for (let index = offset; index < section.length; index += 1) {
        const char = section[index]
        if (inString) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') inString = false
          continue
        }
        if (char === '"') {
          inString = true
          continue
        }
        if (char === '{') depth += 1
        else if (char === '}') depth -= 1
        if (depth !== 0) continue
        try {
          const parsed = JSON.parse(section.slice(offset, index + 1))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            candidates.push(parsed)
            offset = index
          }
        } catch (_) {}
        break
      }
    }
    if (candidates.length) return candidates[candidates.length - 1]
  }
  return null
}

function normalizeStringList(value, limit = 8, maxLength = 180) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  const seen = new Set()
  const result = []
  for (const item of list) {
    const text = String(item || '').replace(/\s+/g, ' ').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text.length > maxLength ? `${text.slice(0, maxLength - 3).trim()}...` : text)
    if (result.length >= limit) break
  }
  return result
}

function normalizeLedgerFacts(facts = {}) {
  return {
    completed: normalizeStringList(facts.completed),
    findings: normalizeStringList(facts.findings),
    decisions: normalizeStringList(facts.decisions),
    rejected: normalizeStringList(facts.rejected),
    constraints: normalizeStringList(facts.constraints),
    openQuestions: normalizeStringList(facts.openQuestions),
    unfinished: normalizeStringList(facts.unfinished)
  }
}

function buildLedgerPrompt(options = {}) {
  return [
    '你是项目账本整理员，只负责把一轮对话整理成可续接的结构化记录。',
    '只输出 JSON，不要 Markdown。',
    '字段固定为：completed, findings, decisions, rejected, constraints, openQuestions, unfinished。',
    `用户原话：${String(options.userRequest || '').slice(0, 4000)}`,
    `AI最终回复：${String(options.finalSummary || '').slice(0, 6000)}`,
    `已有证据：${JSON.stringify(options.evidence || {})}`
  ].join('\n')
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function callOllamaChat(config, messages, options = {}) {
  const apiUrl = normalizeUrl(config.apiUrl || 'http://127.0.0.1:11434')
  const model = String(config.model || 'gemma4:e4b').trim()
  const response = await fetchWithTimeout(`${apiUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      keep_alive: config.keepAlive || options.keepAlive || '30s',
      options: { temperature: options.temperature ?? 0.2, num_ctx: options.num_ctx || 8192 }
    })
  }, options.timeoutMs || DEFAULT_TIMEOUT_MS)
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text().catch(() => response.statusText)}`)
  const data = await response.json()
  return data?.message?.content || data?.response || ''
}

async function callOpenAiCompatible(config, messages, options = {}) {
  const apiUrl = normalizeUrl(config.apiUrl || '')
  const apiKey = resolveApiKey(config.apiKey)
  const model = String(config.model || config.modelId || config.modelName || '').trim()
  if (!apiUrl || !apiKey || !model) throw new Error('云端整理模型配置不完整')
  const endpoint = apiUrl.endsWith('/chat/completions') ? apiUrl : `${apiUrl}/chat/completions`
  const body = { model, messages, stream: false, temperature: options.temperature ?? 0.2 }
  if (options.jsonMode) body.response_format = { type: 'json_object' }
  applyPromptCacheBodyHints(body, config, endpoint, model, { ...options, projectId: options.projectId || 'worker-json' })
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
  applyPromptCacheHeaderHints(headers, config, endpoint, model, { ...options, projectId: options.projectId || 'worker-json' })
  const dispatcher = getProxyDispatcher(config)
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST', headers, body: stableJsonStringify(body), ...(dispatcher ? { dispatcher } : {})
  }, options.timeoutMs || DEFAULT_TIMEOUT_MS)
  if (!response.ok) throw new Error(`Cloud worker ${response.status}: ${await response.text().catch(() => response.statusText)}`)
  const data = await response.json()
  if (data?.usage) {
    try {
      cloudTokenUsage.recordUsage({
        usage: data.usage,
        modelConfig: config,
        modelId: model,
        projectId: options.projectId || '',
        taskType: options.taskType || options.task || 'worker_json',
        source: 'worker-model'
      })
    } catch (error) {
      console.warn('[WorkerModel] cloud token usage record failed:', error.message)
    }
  }
  return data?.choices?.[0]?.message?.content || ''
}

async function callOpenAiCompatibleJson(config, messages, options = {}) {
  const jsonMode = shouldUseJsonResponseFormat(config, options)
  try {
    return await callOpenAiCompatible(config, messages, { ...options, jsonMode })
  } catch (error) {
    if (!jsonMode) throw error
    return callOpenAiCompatible(config, messages, { ...options, jsonMode: false })
  }
}

function getModelId(config = {}) {
  return String(config.modelId || config.model || config.modelName || '').trim()
}

function isSameModelConfig(first = {}, second = {}) {
  if (!first || !second) return false
  const firstKey = String(first.modelKey || '').trim()
  const secondKey = String(second.modelKey || '').trim()
  if (firstKey && secondKey) return firstKey === secondKey
  const firstEndpoint = normalizeUrl(buildApiEndpoint(first)).toLowerCase()
  const secondEndpoint = normalizeUrl(buildApiEndpoint(second)).toLowerCase()
  return Boolean(
    firstEndpoint &&
    firstEndpoint === secondEndpoint &&
    getModelId(first).toLowerCase() === getModelId(second).toLowerCase()
  )
}

async function callCurrentTaskModel(config, messages, options = {}) {
  const modelId = getModelId(config)
  let endpoint = buildApiEndpoint(config)
  if (!endpoint || !modelId) throw new Error('当前任务模型配置不完整')

  const apiFormat = getApiFormat(config, endpoint)
  if (apiFormat === 'gemini') endpoint = endpoint.replace(/:streamGenerateContent$/i, ':generateContent')
  const requestOptions = {
    stream: false,
    includeTools: options.includeTools === true,
    includeUsage: true,
    promptCache: options.promptCache === true,
    disableReasoningOptions: true,
    endpoint,
    projectId: options.projectId || 'worker-current-model',
    sessionId: options.sessionId || '',
    disabledTools: options.disabledTools,
    userMessage: options.toolGateUserMessage || options.userMessage || '',
    enableWorkbenchToolGate: options.enableWorkbenchToolGate
  }
  const body = buildModelRequestBody({ ...config, temperature: options.temperature ?? 0.2 }, modelId, messages, requestOptions)
  if (options.jsonMode === true && apiFormat === 'openai') {
    body.response_format = { type: 'json_object' }
  }
  const headers = buildApiHeaders(config, endpoint, {
    stream: false,
    modelId,
    promptCache: options.promptCache === true,
    projectId: options.projectId || '',
    sessionId: options.sessionId || ''
  })
  const response = await fetchWithTimeout(endpoint, buildApiFetchOptions(config, endpoint, {
    method: 'POST',
    headers,
    body: stableJsonStringify(body),
    modelId,
    promptCache: options.promptCache === true
  }), options.timeoutMs || DEFAULT_TIMEOUT_MS)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`当前任务模型 ${response.status}: ${text || response.statusText}`)
  }
  const data = await response.json()
  const usage = data?.usage || data?.usageMetadata || data?.data?.usage
  if (usage) {
    try {
      cloudTokenUsage.recordUsage({
        usage,
        modelConfig: config,
        modelId,
        projectId: options.projectId || '',
        taskType: options.taskType || options.task || 'worker_current_model',
        source: 'worker-model-current'
      })
    } catch (error) {
      console.warn('[WorkerModel] current model token usage record failed:', error.message)
    }
  }
  return extractModelResponseContent(data, apiFormat)
}

async function tryCurrentModelFallback(options, messages, selectedModels, errors) {
  const currentModel = options.currentModel || options.fallbackModel
  if (!currentModel || typeof currentModel !== 'object') return null
  // 网页桥模型（ChatGPT / DeepSeek / Grok 网页版）不是 API，没有结构化 JSON 输出能力，
  // 也不该被拿来跑后台整理任务。直接跳过，让调用方降级为规则提取。
  const currentModelId = String(currentModel.modelId || currentModel.model || '')
  if (isChatGptWebBridgeModel(currentModel, currentModelId) || isGeminiSparkAgentModel(currentModel, currentModelId)) {
    errors.push('当前任务模型是网页桥模型，不支持后台整理，已跳过')
    return null
  }
  if (selectedModels.some(selected => isSameModelConfig(selected, currentModel))) {
    errors.push('当前任务模型与已失败的整理模型相同，已跳过重复请求')
    return null
  }

  const attempt = async (jsonMode) => {
    const content = await callCurrentTaskModel(currentModel, messages, {
      timeoutMs: options.timeoutMs,
      projectId: options.projectId,
      sessionId: options.sessionId,
      taskType: options.taskType || options.task,
      jsonMode,
      promptCache: options.promptCache === true,
      includeTools: options.includeTools === true,
      disabledTools: options.disabledTools,
      toolGateUserMessage: options.toolGateUserMessage || options.userMessage,
      enableWorkbenchToolGate: options.enableWorkbenchToolGate
    })
    const data = parseJsonObject(content)
    return data ? { data, raw: content } : null
  }

  try {
    const structured = await attempt(true)
    if (structured) {
      return {
        provider: 'current-model',
        ...structured,
        fallback: true,
        fallbackReason: errors.join('; ')
      }
    }
  } catch (error) {
    errors.push(`当前任务模型结构化请求：${error.message}`)
  }

  try {
    const plain = await attempt(false)
    if (plain) {
      return {
        provider: 'current-model',
        ...plain,
        fallback: true,
        fallbackReason: errors.join('; ')
      }
    }
    errors.push('当前任务模型返回不是有效 JSON')
  } catch (error) {
    errors.push(`当前任务模型：${error.message}`)
  }
  return null
}

function pickCloudWorkerConfig(workerConfig = {}) {
  const cloud = workerConfig.cloud || {}
  if (cloud.enabled === false || !cloud.modelKey) return null
  const apiConfig = storageConfig.getApiConfig()
  const models = apiConfig?.success && Array.isArray(apiConfig.data?.models) ? apiConfig.data.models : []
  const model = models.find(item => String(item?.modelKey || '').trim() === String(cloud.modelKey).trim())
  const modelId = String(model?.modelId || model?.modelName || model?.model || '').trim()
  if (!model?.apiUrl || !modelId || !resolveApiKey(model.apiKey)) return null
  return model
}

async function tryJsonProvider(provider, messages, options = {}) {
  const content = provider === 'ollama'
    ? await callOllamaChat(options.config, messages, options)
    : await callOpenAiCompatibleJson(options.config, messages, options)
  const data = parseJsonObject(content)
  if (!data) throw new Error(`${provider === 'ollama' ? '本地' : '云端'}整理模型返回不是有效 JSON`)
  return { data, raw: content }
}

async function summarizeLedger(options = {}) {
  const workerConfig = storageConfig.getWorkerModelConfig()
  const messages = [
    { role: 'system', content: '你是严谨的项目账本整理员。只输出 JSON。' },
    { role: 'user', content: buildLedgerPrompt(options) }
  ]
  const errors = []
  const selectedModels = []
  const local = workerConfig.local || {}
  if (workerConfig.enabled !== false && local.enabled !== false) {
    selectedModels.push({ ...local, provider: 'ollama', modelId: local.model || local.modelId })
    try {
      const result = await tryJsonProvider('ollama', messages, { config: local, timeoutMs: workerConfig.timeoutMs })
      return { success: true, provider: 'ollama', facts: normalizeLedgerFacts(result.data), raw: result.raw }
    } catch (error) { errors.push(error.message) }
  }
  const cloud = pickCloudWorkerConfig(workerConfig)
  if (workerConfig.enabled !== false && cloud) {
    selectedModels.push(cloud)
    try {
      const result = await tryJsonProvider('cloud', messages, { config: cloud, timeoutMs: workerConfig.timeoutMs, taskType: 'project_ledger', projectId: options.projectId || 'task-ledger' })
      return { success: true, provider: 'cloud', facts: normalizeLedgerFacts(result.data), raw: result.raw }
    } catch (error) { errors.push(error.message) }
  }
  if (workerConfig.enabled !== false) {
    const fallback = await tryCurrentModelFallback({
      ...options,
      timeoutMs: options.timeoutMs || workerConfig.timeoutMs,
      taskType: 'project_ledger'
    }, messages, selectedModels, errors)
    if (fallback) {
      return {
        success: true,
        provider: fallback.provider,
        facts: normalizeLedgerFacts(fallback.data),
        raw: fallback.raw,
        fallback: true,
        fallbackReason: fallback.fallbackReason
      }
    }
  }
  return { success: false, error: errors.join('; ') || '未配置可用整理模型' }
}

function resolveSummarizeJsonRequest(options = {}) {
  const workerMessages = [
    { role: 'system', content: options.system || '只输出 JSON。' },
    { role: 'user', content: options.prompt || '' }
  ]
  const prefixMessages = Array.isArray(options.prefixMessages) && options.prefixMessages.length
    ? options.prefixMessages
    : null
  return {
    workerMessages,
    currentModelMessages: prefixMessages || workerMessages,
    reuseConversationPrefix: Boolean(prefixMessages),
    promptCache: Boolean(prefixMessages),
    includeTools: Boolean(prefixMessages)
  }
}

async function summarizeJson(options = {}) {
  const workerConfig = storageConfig.getWorkerModelConfig()
  const request = resolveSummarizeJsonRequest(options)
  const errors = []
  const selectedModels = []
  if (options.currentModelOnly === true) {
    const currentOnly = await tryCurrentModelFallback({
      ...options,
      timeoutMs: options.timeoutMs || workerConfig.timeoutMs,
      taskType: options.task || 'worker_json',
      promptCache: false,
      includeTools: false
    }, request.workerMessages, selectedModels, errors)
    if (currentOnly) return { success: true, ...currentOnly }
    return { success: false, error: errors.join('; ') || '当前任务模型无法完成隔离分析' }
  }
  const local = options.local || workerConfig.local || {}
  if (workerConfig.enabled !== false && local.enabled !== false) {
    selectedModels.push({ ...local, provider: 'ollama', modelId: local.model || local.modelId })
    try {
      const result = await tryJsonProvider('ollama', request.workerMessages, { config: local, timeoutMs: options.timeoutMs || workerConfig.timeoutMs })
      return { success: true, provider: 'ollama', data: result.data, raw: result.raw }
    } catch (error) { errors.push(error.message) }
  }
  const cloud = pickCloudWorkerConfig({ ...workerConfig, cloud: options.cloud || workerConfig.cloud })
  if (workerConfig.enabled !== false && cloud) {
    selectedModels.push(cloud)
    try {
      const result = await tryJsonProvider('cloud', request.workerMessages, { config: cloud, timeoutMs: options.timeoutMs || workerConfig.timeoutMs, taskType: options.task || 'worker_json', projectId: options.projectId || 'worker-json' })
      return { success: true, provider: 'cloud', data: result.data, raw: result.raw }
    } catch (error) { errors.push(error.message) }
  }
  if (workerConfig.enabled !== false) {
    const fallback = await tryCurrentModelFallback({
      ...options,
      timeoutMs: options.timeoutMs || workerConfig.timeoutMs,
      taskType: options.task || 'worker_json',
      promptCache: request.promptCache,
      includeTools: request.includeTools
    }, request.currentModelMessages, selectedModels, errors)
    if (fallback) return { success: true, ...fallback }
  }
  return { success: false, error: errors.join('; ') || '未配置可用整理模型' }
}

async function testConfig(config = {}, options = {}) {
  const normalized = storageConfig.normalizeWorkerModelConfig(config)
  const target = String(options.target || '').trim().toLowerCase() || (normalized.local?.enabled !== false ? 'local' : 'cloud')
  if (target === 'cloud') {
    const cloud = pickCloudWorkerConfig(normalized)
    if (!cloud) return { success: false, provider: 'cloud', error: '未启用或未选择可用的云端整理模型。' }
    try {
      const result = await tryJsonProvider('cloud', [{ role: 'system', content: '只回复 JSON。' }, { role: 'user', content: '输出 {"ok":true}' }], { config: cloud, timeoutMs: 30000 })
      return { success: true, provider: 'cloud', model: cloud.modelName || cloud.modelId || cloud.model, content: result.raw.slice(0, 500) }
    } catch (error) { return { success: false, provider: 'cloud', error: error.message } }
  }
  if (normalized.local?.enabled === false) return { success: false, provider: 'ollama', error: '本地整理模型未启用。' }
  try {
    const content = await callOllamaChat(normalized.local, [{ role: 'system', content: '只回复 JSON。' }, { role: 'user', content: '输出 {"ok":true}' }], { timeoutMs: 30000 })
    return { success: true, provider: 'ollama', model: normalized.local.model, content: String(content || '').slice(0, 500) }
  } catch (error) { return { success: false, provider: 'ollama', error: error.message } }
}

module.exports = {
  summarizeLedger,
  summarizeJson,
  resolveSummarizeJsonRequest,
  testConfig,
  normalizeLedgerFacts,
  isDeepSeekModelConfig,
  shouldUseJsonResponseFormat
}
