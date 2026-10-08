/**
 * Public web-search tool scheduler.
 * Same idea as model capability routing: every search tool stays available;
 * the item at rank 1 is preferred, the rest are fallbacks.
 */

const PAGE_PROVIDER_IDS = Object.freeze(['chatgpt', 'grok', 'deepseek', 'qwen', 'gemini', 'claude', 'arena'])

const SEARCH_TOOL_DEFS = Object.freeze([
  { id: 'chatgpt', label: 'ChatGPT web.run', tool: 'web_bridge_search', kind: 'chatgpt-web-run' },
  { id: 'lxweb', label: '灵犀内置搜索', tool: 'lxweb', kind: 'native' },
  { id: 'grok', label: 'Grok 网页版', tool: 'web_bridge_search', kind: 'page-model' },
  { id: 'deepseek', label: 'DeepSeek 网页版', tool: 'web_bridge_search', kind: 'page-model' },
  { id: 'qwen', label: '通义网页版', tool: 'web_bridge_search', kind: 'page-model' },
  { id: 'gemini', label: 'Gemini 网页版', tool: 'web_bridge_search', kind: 'page-model' },
  { id: 'claude', label: 'Claude 网页版', tool: 'web_bridge_search', kind: 'page-model' },
  { id: 'arena', label: 'Arena 网页版', tool: 'web_bridge_search', kind: 'page-model' }
])

const SEARCH_TOOL_IDS = Object.freeze(SEARCH_TOOL_DEFS.map(item => item.id))
const SEARCH_TOOL_BY_ID = Object.freeze(Object.fromEntries(SEARCH_TOOL_DEFS.map(item => [item.id, item])))
const DEFAULT_SEARCH_TOOL_ORDER = Object.freeze(['chatgpt', 'lxweb', ...PAGE_PROVIDER_IDS.filter(id => id !== 'chatgpt')])

function getSearchToolDef(id = '') {
  return SEARCH_TOOL_BY_ID[String(id || '').trim().toLowerCase()] || null
}

function normalizeSearchToolOrder(order) {
  const seen = new Set()
  const next = []
  for (const item of Array.isArray(order) ? order : []) {
    const id = String(item || '').trim().toLowerCase()
    if (!SEARCH_TOOL_BY_ID[id] || seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  if (!seen.has('lxweb')) {
    const chatgptIndex = next.indexOf('chatgpt')
    if (chatgptIndex >= 0) next.splice(chatgptIndex + 1, 0, 'lxweb')
    else next.unshift('lxweb')
    seen.add('lxweb')
  }
  for (const id of DEFAULT_SEARCH_TOOL_ORDER) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

function getPageProviderOrder(order) {
  return normalizeSearchToolOrder(order).filter(id => PAGE_PROVIDER_IDS.includes(id))
}

function readSearchSchedule(deps = {}) {
  if (deps.searchSettings && typeof deps.searchSettings === 'object') {
    return {
      pageSearchEnabled: deps.searchSettings.pageSearchEnabled !== false,
      searchToolOrder: normalizeSearchToolOrder(deps.searchSettings.searchProviderOrder || deps.searchSettings.searchToolOrder)
    }
  }
  if (
    typeof deps.pageSearchEnabled === 'boolean'
    || deps.searchProviderOrder
    || deps.searchToolOrder
    || typeof deps.listProviders === 'function'
    || typeof deps.fetchImpl === 'function'
    || typeof deps.runSearch === 'function'
  ) {
    return {
      pageSearchEnabled: deps.pageSearchEnabled !== false,
      searchToolOrder: normalizeSearchToolOrder(deps.searchProviderOrder || deps.searchToolOrder)
    }
  }
  try {
    const profile = require('../web-bridge-chrome-profile')
    return {
      pageSearchEnabled: profile.isWebBridgePageSearchEnabled() !== false,
      searchToolOrder: normalizeSearchToolOrder(profile.getWebBridgeSearchProviderOrder())
    }
  } catch (_) {
    return {
      pageSearchEnabled: true,
      searchToolOrder: [...DEFAULT_SEARCH_TOOL_ORDER]
    }
  }
}

function getPreferredSearchTool(deps = {}) {
  const schedule = readSearchSchedule(deps)
  const order = schedule.searchToolOrder
  const preferredId = order[0] || 'chatgpt'
  return {
    ...schedule,
    preferredId,
    preferred: getSearchToolDef(preferredId) || SEARCH_TOOL_BY_ID.chatgpt,
    fallbacks: order.slice(1).map(getSearchToolDef).filter(Boolean)
  }
}

function hasConfiguredSearchModel(deps = {}) {
  if (typeof deps.hasCapabilitySearchModel === 'boolean') return deps.hasCapabilitySearchModel
  try {
    const models = require('../capability-web-search').listSearchModelsFromConfig()
    return Array.isArray(models) && models.length > 0
  } catch (_) {
    return false
  }
}

function buildSearchPreferenceHint(compact = false, deps = {}) {
  const { pageSearchEnabled, preferred, fallbacks } = getPreferredSearchTool(deps)
  const hasSearchModel = hasConfiguredSearchModel(deps)
  if (!pageSearchEnabled) {
    if (hasSearchModel) {
      return compact
        ? '- 公开网页事实优先 web_search（走已配置的搜索模型）；网页桥已关闭，不要调用 web_bridge_search。失败再用 lxweb 搜索或抓取。已知网址用 lxweb 打开或抓取。'
        : '- 公开网页事实优先 web_search（走能力调度里已配置的搜索模型）。网页桥搜索已关闭，不要调用 web_bridge_search。仅当搜索模型失败后再用 lxweb 搜索或抓取。已知网址用 lxweb 打开或抓取，不要编造网页事实。'
    }
    return compact
      ? '- 公开网页事实用 lxweb 搜索或抓取。网页桥已关闭且当前没有搜索模型。已知网址用 lxweb 打开或抓取。'
      : '- 公开网页事实用 lxweb 搜索或抓取。网页桥搜索已关闭，且能力调度里没有可调用的搜索模型。已知网址用 lxweb 打开或抓取，不要编造网页事实。'
  }
  if (hasSearchModel) {
    const bridgeFallback = preferred?.id === 'lxweb'
      ? 'lxweb action=search'
      : preferred?.id === 'chatgpt'
        ? 'web_bridge_search（ChatGPT web.run）'
        : `web_bridge_search（${preferred?.label || '网页桥'}）`
    return compact
      ? `- 公开网页事实优先 web_search（走已配置的搜索模型）；失败再用 ${bridgeFallback}。已知网址用 lxweb 打开或抓取。`
      : `- 公开网页事实优先 web_search（走能力调度里已配置的搜索模型）；失败再 ${bridgeFallback}。已知网址用 lxweb 打开或抓取，不要编造网页事实。`
  }
  const primary = preferred?.id === 'lxweb'
    ? 'lxweb action=search（灵犀内置搜索）'
    : preferred?.id === 'chatgpt'
      ? 'web_bridge_search（内部走 ChatGPT web.run）'
      : `web_bridge_search（当前首选：${preferred?.label || 'ChatGPT web.run'}）`
  const fallback = preferred?.id === 'lxweb'
    ? 'web_bridge_search'
    : (fallbacks.some(item => item.id === 'lxweb') ? 'lxweb action=search' : 'lxweb 打开或抓取已知网址')
  return compact
    ? `- 公开网页事实优先 ${primary}；失败再用 ${fallback}。已知网址用 lxweb 打开或抓取。`
    : `- 公开网页事实优先 ${primary}；失败或未登录再用 ${fallback}。已知网址用 lxweb 打开或抓取，不要编造网页事实。`
}

function describeWebBridgeSearch(schedule = getPreferredSearchTool()) {
  const preferred = schedule.preferred || SEARCH_TOOL_BY_ID.chatgpt
  const preferredNote = preferred.id === 'lxweb'
    ? '当前调度把灵犀内置搜索排在前面，本工具作为失败后备。'
    : preferred.id === 'chatgpt'
      ? '当前首选是 ChatGPT 官方 web.run：调用本工具走协议直连，不打开 ChatGPT 聊天页，也不是网页聊天透传。'
      : `当前调度首选：${preferred.label}。ChatGPT 在队列中时仍走 web.run，其他网页桥走已登录页面模型。`
  return `灵犀网页搜索入口。模型只调用本工具名 web_bridge_search。ChatGPT 后端是协议直连的官方 web.run（由当前模型给出查询词，不打开浏览器聊天页）；Grok/DeepSeek 等后端才是页面模型问答。${preferredNote}适合时效新闻、产品资料、文档和需要核对来源的问题。不要用它改项目文件。已知具体网址请改用 lxweb 打开或抓取。当前对话本身已是 ChatGPT 网页模型时不要调用本工具。`
}

function describeLxweb(schedule = getPreferredSearchTool(), deps = {}) {
  const hasSearchModel = hasConfiguredSearchModel(deps)
  if (!schedule.pageSearchEnabled) {
    return hasSearchModel
      ? '灵犀内置浏览器工具。公开事实检索请优先 web_search（已配置搜索模型）。本工具仅作搜索模型失败后的后备公开网页搜索，并用于打开/抓取已知网址、右侧预览。传 url 且不传 action 时自动抓取；传 query 且不传 action 时搜索公开搜索页。用户要求右侧窗口打开网页时使用 action=open_right。'
      : '灵犀内置浏览器工具。网页桥已关闭且没有可调用的搜索模型。用于公开网页搜索、打开/抓取已知网址、右侧预览、页内查找和网站设计调研。传 url 且不传 action 时自动抓取；传 query 且不传 action 时搜索公开搜索页。用户要求右侧窗口打开网页时使用 action=open_right。'
  }
  const preferred = schedule.preferred || SEARCH_TOOL_BY_ID.chatgpt
  const searchNote = hasSearchModel
    ? '公开事实检索请优先 web_search（已配置搜索模型）；失败后再用本工具或网页桥。'
    : preferred.id === 'lxweb'
      ? '公开事实检索请优先本工具 action=search；失败再用 web_bridge_search。'
      : preferred.id === 'chatgpt'
        ? '公开事实检索请优先 web_bridge_search（内部走 ChatGPT web.run）；未登录或失败时再用本工具 action=search。'
        : `公开事实检索请优先 web_bridge_search（当前首选：${preferred.label}）；未登录或失败时再用本工具 action=search。`
  return `灵犀内置浏览器工具。${searchNote}优先用于打开/抓取已知网址、右侧预览、页内查找和网站设计调研。传 url 且不传 action 时自动抓取；传 query 且不传 action 时才搜索公开搜索页。用户要求右侧窗口打开网页时使用 action=open_right。`
}

function describeWebSearch(schedule = getPreferredSearchTool(), deps = {}) {
  const hasSearchModel = hasConfiguredSearchModel(deps)
  if (!schedule.pageSearchEnabled) {
    return hasSearchModel
      ? '稳定的网页搜索入口。网页桥搜索已关闭，本工具会路由到能力调度里已配置的搜索模型。公开检索请调用本工具，不要先改用 lxweb。仅当本工具失败后再用 lxweb 搜索或抓取。'
      : '稳定的网页搜索入口。网页桥搜索已关闭，且当前没有可调用的搜索模型；公开检索请改用 lxweb。已知网址用 lxweb 打开或抓取。'
  }
  return hasSearchModel
    ? '稳定的网页搜索入口。优先走能力调度里已配置的搜索模型，失败再回退网页桥或灵犀内置搜索。当前对话模型不具备搜索能力也不影响。需要核对来源时优先调用本工具。'
    : '稳定的网页搜索入口。模型可根据任务主动搜索公开网页、最新资料或官方文档，不需要知道底层是搜索 API、ChatGPT web.run 还是其他网页桥。需要核对来源时优先调用本工具；返回答案、日期和来源链接。当前对话模型不具备搜索能力也不影响，系统会自动选择已配置的搜索后端。'
}

function applySearchToolDescriptions(tools = [], deps = {}) {
  const schedule = getPreferredSearchTool(deps)
  return tools.map(tool => {
    const name = tool?.function?.name
    if (name !== 'lxweb' && name !== 'web_bridge_search' && name !== 'web_search') return tool
    const next = JSON.parse(JSON.stringify(tool))
    if (!next.function) return next
    if (name === 'web_bridge_search') next.function.description = describeWebBridgeSearch(schedule)
    if (name === 'lxweb') next.function.description = describeLxweb(schedule, deps)
    if (name === 'web_search') next.function.description = describeWebSearch(schedule, deps)
    return next
  })
}

module.exports = {
  PAGE_PROVIDER_IDS,
  SEARCH_TOOL_DEFS,
  SEARCH_TOOL_IDS,
  DEFAULT_SEARCH_TOOL_ORDER,
  getSearchToolDef,
  normalizeSearchToolOrder,
  getPageProviderOrder,
  readSearchSchedule,
  getPreferredSearchTool,
  hasConfiguredSearchModel,
  buildSearchPreferenceHint,
  describeWebBridgeSearch,
  describeLxweb,
  describeWebSearch,
  applySearchToolDescriptions
}
