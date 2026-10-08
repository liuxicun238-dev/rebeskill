const search = require('../web-bridge-search')

const handlers = {
  web_bridge_search: async (args, ctx) => search.searchWithWebBridge(args || {}, {
    ...(ctx || {}),
    toolName: 'web_bridge_search',
    toolCallId: ctx?.toolCallId || ctx?.options?.toolCallId || ''
  })
}

module.exports = { handlers }
