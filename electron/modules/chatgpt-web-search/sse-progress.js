/**
 * Incremental ChatGPT conversation SSE parser for web.run search stages.
 * Walks each event for search_queries / search_result_groups without keeping
 * the raw stream (no cookies, tokens, or signed URLs).
 */

const MAX_GROUPS = 12
const MAX_ENTRIES = 6
const MAX_SNIPPET = 240
const MAX_QUERY = 200
const MAX_TITLE = 160

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

function createSearchStreamState() {
  return {
    stage: 'connecting',
    queries: [],
    resultGroups: [],
    sources: [],
    assistantText: '',
    conversationId: '',
    error: '',
    done: false,
    webRunSeen: false,
    assistantStarted: false,
    eventCount: 0
  }
}

function addQuery(state, value) {
  const text = clip(value, MAX_QUERY)
  if (!text) return false
  const key = text.toLowerCase()
  if (state.queries.some(item => item.toLowerCase() === key)) return false
  state.queries.push(text)
  return true
}

function collectQueries(node, state) {
  if (!node || typeof node !== 'object') return
  const list = node.search_queries
  if (!Array.isArray(list)) return
  for (const item of list) {
    const text = typeof item === 'string'
      ? item
      : (item?.q || item?.query || item?.text || '')
    addQuery(state, text)
  }
}

function normalizeEntry(entry = {}) {
  const url = String(entry.url || entry.link || entry.href || '').trim()
  if (!/^https?:\/\//i.test(url)) return null
  if (/\/backend-api\//i.test(url) || /estuary|oaiusercontent/i.test(url)) return null
  return {
    title: clip(entry.title || entry.name || url, MAX_TITLE),
    url,
    snippet: clip(entry.snippet || entry.description || entry.attribution || entry.text || '', MAX_SNIPPET)
  }
}

function normalizeGroup(group = {}) {
  const entriesSource = Array.isArray(group.entries)
    ? group.entries
    : (Array.isArray(group.results) ? group.results : (Array.isArray(group) ? group : []))
  const entries = []
  const seen = new Set()
  for (const item of entriesSource) {
    const entry = normalizeEntry(item)
    if (!entry) continue
    const key = entry.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
    if (entries.length >= MAX_ENTRIES) break
  }
  if (!entries.length) return null
  const domain = clip(
    group.domain || group.type || (() => {
      try { return new URL(entries[0].url).hostname } catch (_) { return '' }
    })(),
    80
  )
  return { domain, entries }
}

function addGroup(state, group) {
  const next = normalizeGroup(group)
  if (!next) return false
  const key = `${next.domain}|${next.entries[0]?.url || ''}`
  if (state.resultGroups.some(item => `${item.domain}|${item.entries[0]?.url || ''}` === key)) return false
  if (state.resultGroups.length >= MAX_GROUPS) return false
  state.resultGroups.push(next)
  for (const entry of next.entries) {
    if (state.sources.some(item => item.url === entry.url)) continue
    state.sources.push({ title: entry.title, url: entry.url })
  }
  return true
}

function collectGroups(node, state) {
  if (!node || typeof node !== 'object') return
  const list = node.search_result_groups
  if (!Array.isArray(list)) return
  for (const group of list) addGroup(state, group)
}

function walk(value, visit, depth = 0) {
  if (value == null || depth > 10) return
  visit(value)
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1)
    return
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value)) walk(nested, visit, depth + 1)
  }
}

function unwrapPayload(payload) {
  if (
    payload
    && typeof payload === 'object'
    && payload.v
    && typeof payload.v === 'object'
    && !Array.isArray(payload.v)
    && (payload.v.message || payload.v.conversation_id || payload.v.error)
  ) {
    return payload.v
  }
  return payload
}

function inspectNode(state, node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  if (node.conversation_id) state.conversationId = String(node.conversation_id)
  const recipient = String(node.recipient || '')
  if (recipient === 'web.run' || node.author?.name === 'web.run') state.webRunSeen = true
  collectQueries(node, state)
  collectGroups(node, state)
  const role = String(node.author?.role || '')
  const parts = Array.isArray(node.content?.parts) ? node.content.parts : []
  const text = parts.map(part => {
    if (typeof part === 'string') return part
    return String(part?.text || part?.content || '')
  }).join('\n').trim()
  if (role === 'assistant' && recipient !== 'web.run' && text && !/^search\(/i.test(text)) {
    state.assistantStarted = true
    if (text.length > state.assistantText.length) {
      state.assistantText = clip(text, 1200)
    }
  }
  if (node.error || node.error_code) {
    const detail = typeof node.error === 'string'
      ? node.error
      : String(node.error?.message || node.error_code || '')
    if (detail && !state.error) state.error = clip(detail, 240)
  }
}

function consumeSseBlock(state, block) {
  const changed = {
    queries: false,
    groups: false,
    stage: false,
    error: false
  }
  const text = String(block || '')
  for (const line of text.split(/\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data) continue
    if (data === '[DONE]') {
      state.done = true
      continue
    }
    let payload
    try {
      payload = JSON.parse(data)
    } catch (_) {
      continue
    }
    state.eventCount += 1
    const beforeQueries = state.queries.length
    const beforeGroups = state.resultGroups.length
    const beforeError = state.error
    walk(unwrapPayload(payload), node => inspectNode(state, node))
    if (payload?.type === 'message_stream_complete') state.done = true
    if (payload?.type === 'error') {
      const detail = String(payload.error || payload.detail || payload.message || 'ChatGPT 搜索流出错')
      if (!state.error) state.error = clip(detail, 240)
    }
    if (state.queries.length !== beforeQueries) changed.queries = true
    if (state.resultGroups.length !== beforeGroups) changed.groups = true
    if (state.error !== beforeError) changed.error = true
  }
  const nextStage = inferStage(state)
  if (nextStage !== state.stage) {
    state.stage = nextStage
    changed.stage = true
  }
  changed.any = changed.queries || changed.groups || changed.stage || changed.error || state.done
  return changed
}

function inferStage(state) {
  if (state.error) return 'error'
  if (state.done && state.resultGroups.length) return 'done'
  if (state.assistantStarted && state.resultGroups.length) return 'results'
  if (state.resultGroups.length) return 'results'
  if (state.queries.length || state.webRunSeen) return 'searching'
  return state.stage === 'connecting' ? 'connecting' : 'searching'
}

function shouldFinishSearch(state) {
  if (state.error) return true
  if (state.done) return true
  if (state.resultGroups.length > 0 && state.assistantStarted) return true
  return false
}

function toProgressPayload(state) {
  return {
    kind: 'chatgpt-web-search',
    stage: state.stage,
    queries: state.queries.slice(),
    resultGroups: state.resultGroups.map(group => ({
      domain: group.domain,
      entries: group.entries.map(entry => ({
        title: entry.title,
        url: entry.url,
        snippet: entry.snippet
      }))
    })),
    sourceCount: state.sources.length,
    error: state.error || ''
  }
}

module.exports = {
  MAX_GROUPS,
  createSearchStreamState,
  consumeSseBlock,
  shouldFinishSearch,
  toProgressPayload,
  inferStage
}
