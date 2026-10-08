/**
 * Compact tool result for the API model. Prefer result groups / sources over
 * any leftover ChatGPT assistant prose.
 */

function clipText(value = '', maxChars = 4000) {
  const text = String(value || '')
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`
}

function buildModelSearchResult(state = {}, args = {}) {
  const queries = Array.isArray(state.queries) && state.queries.length
    ? state.queries
    : (Array.isArray(args.queries) ? args.queries : [args.query]).filter(Boolean)
  const groups = Array.isArray(state.resultGroups) ? state.resultGroups : []
  const sources = Array.isArray(state.sources) ? state.sources.slice(0, 16) : []
  if (state.error && !groups.length) {
    return {
      success: false,
      engine: 'chatgpt-web.run',
      provider: 'chatgpt',
      providerLabel: 'ChatGPT web.run',
      query: queries[0] || '',
      queries,
      error: state.error
    }
  }
  return {
    success: true,
    engine: 'chatgpt-web.run',
    provider: 'chatgpt',
      providerLabel: 'ChatGPT web.run',
    query: queries[0] || '',
    queries,
    search_queries: queries,
    result_groups: groups,
    sources,
    answer: clipText(state.assistantText || '', 2500),
    sourceCount: sources.length
  }
}

module.exports = {
  clipText,
  buildModelSearchResult
}
