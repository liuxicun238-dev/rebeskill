/**
 * ChatGPT web.run search for Lingxi API models.
 * Protocol-direct: cookies from the logged-in web-bridge profile, Node
 * Sentinel + /backend-api/f/conversation. Does not open Chrome.
 */

const { normalizeQueryList, buildUserSearchText } = require('./conversation-body')
const { createThrottledEmitter } = require('./progress-ipc')
const { DEFAULT_TIMEOUT_MS, runNodeWebRunSearch } = require('./node-runner')

function isChatGptWebChatPrimary(modelConfig = {}, modelId = '') {
  const provider = String(modelConfig.provider || '').toLowerCase()
  const text = String(modelId || modelConfig.modelId || modelConfig.model || '').toLowerCase()
  return provider === 'chatgpt-web-bridge' || /chatgpt-web-chat/.test(text)
}

function getSearchSettings(deps = {}) {
  if (deps.searchSettings && typeof deps.searchSettings === 'object') {
    return { pageSearchEnabled: deps.searchSettings.pageSearchEnabled !== false }
  }
  if (typeof deps.pageSearchEnabled === 'boolean') {
    return { pageSearchEnabled: deps.pageSearchEnabled !== false }
  }
  try {
    return {
      pageSearchEnabled: require('../web-bridge-chrome-profile').isWebBridgePageSearchEnabled() !== false
    }
  } catch (_) {
    return { pageSearchEnabled: true }
  }
}

async function searchWithChatGptWeb(args = {}, ctx = {}, deps = {}) {
  const modelConfig = ctx.modelConfig || {}
  if (isChatGptWebChatPrimary(modelConfig, modelConfig.modelId || modelConfig.model || '')) {
    return {
      success: false,
      skipped: true,
      error: '当前已经是 ChatGPT 网页模型，请直接用页面自带搜索回答，不要再调用 web_bridge_search。'
    }
  }

  const settings = getSearchSettings(deps)
  if (!settings.pageSearchEnabled) {
    return {
      success: false,
      skipped: true,
      error: '已关闭网页桥搜索。若已配置搜索模型，请调用 web_search；否则使用 lxweb 进行公开检索。',
      next_action: 'use_web_search_or_lxweb'
    }
  }

  const queries = normalizeQueryList(args)
  if (!queries.length) return { success: false, error: '请提供 query 或 queries。' }

  const emit = createThrottledEmitter(ctx)
  emit({
    kind: 'chatgpt-web-search',
    stage: 'connecting',
    queries,
    resultGroups: [],
    sourceCount: 0,
    error: ''
  }, true)

  if (typeof deps.runSearch === 'function') {
    const result = await deps.runSearch({ ...args, queries }, ctx, { emit })
    emit({
      kind: 'chatgpt-web-search',
      stage: result?.success === false ? 'error' : 'done',
      queries: result?.queries || queries,
      resultGroups: result?.result_groups || result?.resultGroups || [],
      sourceCount: Array.isArray(result?.sources) ? result.sources.length : 0,
      error: result?.error || ''
    }, true)
    return result
  }

  try {
    const runProtocol = deps.runProtocolSearch || runNodeWebRunSearch
    const result = await runProtocol({
      queries,
      focus: args.focus,
      userText: buildUserSearchText(queries, args.focus),
      signal: ctx.signal,
      timeoutMs: args.timeout_ms || DEFAULT_TIMEOUT_MS,
      onProgress: (progress, changed) => emit(progress, !!(changed && changed.stage))
    })
    emit({
      kind: 'chatgpt-web-search',
      stage: result.success === false ? 'error' : 'done',
      queries: result.queries || queries,
      resultGroups: result.result_groups || [],
      sourceCount: result.sourceCount || 0,
      error: result.error || ''
    }, true)
    return result
  } catch (error) {
    const abortLike = error?.name === 'AbortError' || error?.code === 'ABORTED' || ctx.signal?.aborted
    const result = {
      success: false,
      engine: 'chatgpt-web.run',
      provider: 'chatgpt',
      providerLabel: 'ChatGPT web.run',
      query: queries[0],
      queries,
      error: error.message || String(error),
      code: abortLike ? 'ABORTED' : (error.code || 'CHAT_FAILED')
    }
    emit({
      kind: 'chatgpt-web-search',
      stage: 'error',
      queries,
      resultGroups: [],
      sourceCount: 0,
      error: result.error
    }, true)
    return result
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  isChatGptWebChatPrimary,
  normalizeQueryList,
  searchWithChatGptWeb
}
