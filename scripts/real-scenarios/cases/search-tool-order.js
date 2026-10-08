const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'search-tool-order.schedule',
  title: 'Search tools stay available and follow capability-style ranking',
  tags: ['web-bridge', 'search', 'tools'],
  changedFilePatterns: [
    /^electron\/modules\/chatgpt-web-search\/search-tool-order\.js$/i,
    /^electron\/modules\/web-bridge-chrome-profile\.js$/i,
    /^electron\/modules\/web-bridge-search\.js$/i,
    /^electron\/modules\/agent-runtime\.js$/i,
    /^electron\/modules\/model-api-adapter\.js$/i,
    /^electron\/modules\/schemas\/browser-search\.js$/i,
    /^frontend\/scripts\/features\/web-bridge-search-settings\.js$/i,
    /^frontend\/scripts\/features\/settings-main\.js$/i,
    /^frontend\/index\.html$/i
  ],

  async run(ctx) {
    const order = require(path.join(ctx.root, 'electron/modules/chatgpt-web-search/search-tool-order'))
    const profile = require(path.join(ctx.root, 'electron/modules/web-bridge-chrome-profile'))

    ctx.assert.deepEqual(order.DEFAULT_SEARCH_TOOL_ORDER.slice(0, 3), ['chatgpt', 'lxweb', 'grok'])
    ctx.assert.ok(order.SEARCH_TOOL_IDS.includes('lxweb'), 'Lingxi native search must stay in the schedule')
    ctx.assert.equal(order.SEARCH_TOOL_IDS.includes('gemini-spark'), false, 'Spark must not be a search tool')
    ctx.assert.ok(profile.DEFAULT_SEARCH_PROVIDER_ORDER.includes('lxweb'))
    ctx.assert.equal(profile.DEFAULT_SEARCH_PROVIDER_ORDER[0], 'chatgpt')

    ctx.assert.deepEqual(
      order.normalizeSearchToolOrder(['chatgpt', 'grok']),
      ['chatgpt', 'lxweb', 'grok', 'deepseek', 'qwen', 'gemini', 'claude', 'arena'],
      'legacy orders without lxweb should insert native search after ChatGPT'
    )
    ctx.assert.deepEqual(
      order.normalizeSearchToolOrder(['lxweb', 'chatgpt']),
      ['lxweb', 'chatgpt', 'grok', 'deepseek', 'qwen', 'gemini', 'claude', 'arena']
    )
    ctx.assert.deepEqual(
      order.getPageProviderOrder(['lxweb', 'grok', 'chatgpt']),
      ['grok', 'chatgpt', 'deepseek', 'qwen', 'gemini', 'claude', 'arena']
    )

    const chatgptPreferred = order.getPreferredSearchTool({
      pageSearchEnabled: true,
      searchToolOrder: ['chatgpt', 'lxweb']
    })
    ctx.assert.equal(chatgptPreferred.preferredId, 'chatgpt')
    ctx.assert.ok(chatgptPreferred.fallbacks.some(item => item.id === 'lxweb'))

    const lxwebPreferred = order.getPreferredSearchTool({
      pageSearchEnabled: true,
      searchToolOrder: ['lxweb', 'chatgpt']
    })
    ctx.assert.equal(lxwebPreferred.preferredId, 'lxweb')
    ctx.assert.equal(lxwebPreferred.preferred.tool, 'lxweb')

    const chatgptHint = order.buildSearchPreferenceHint(true, {
      pageSearchEnabled: true,
      searchToolOrder: ['chatgpt', 'lxweb'],
      hasCapabilitySearchModel: false
    })
    ctx.assert.ok(/优先 web_bridge_search（内部走 ChatGPT web\.run）/.test(chatgptHint))
    ctx.assert.ok(/lxweb action=search/.test(chatgptHint), 'ChatGPT-first ranking must keep lxweb as fallback')
    ctx.assert.equal(order.getSearchToolDef('chatgpt').kind, 'chatgpt-web-run')
    ctx.assert.equal(order.SEARCH_TOOL_DEFS.find(item => item.id === 'chatgpt').label, 'ChatGPT web.run')

    const lxwebHint = order.buildSearchPreferenceHint(true, {
      pageSearchEnabled: true,
      searchToolOrder: ['lxweb', 'chatgpt'],
      hasCapabilitySearchModel: false
    })
    ctx.assert.ok(/优先 lxweb action=search/.test(lxwebHint))
    ctx.assert.ok(/web_bridge_search/.test(lxwebHint), 'lxweb-first ranking must keep webpage search as fallback')

    const disabledHint = order.buildSearchPreferenceHint(true, {
      pageSearchEnabled: false,
      hasCapabilitySearchModel: false
    })
    ctx.assert.ok(/lxweb 搜索/.test(disabledHint))
    ctx.assert.equal(/优先 web_bridge_search/.test(disabledHint), false)
    ctx.assert.equal(/优先 web_search/.test(disabledHint), false)

    const disabledWithModel = order.buildSearchPreferenceHint(true, {
      pageSearchEnabled: false,
      hasCapabilitySearchModel: true
    })
    ctx.assert.ok(/优先 web_search/.test(disabledWithModel), 'configured search models stay first when webpage search is off')
    ctx.assert.ok(/不要调用 web_bridge_search/.test(disabledWithModel))
    ctx.assert.ok(/lxweb 搜索/.test(disabledWithModel), 'lxweb remains the fallback after the search model')

    const enabledWithModel = order.buildSearchPreferenceHint(true, {
      pageSearchEnabled: true,
      searchToolOrder: ['chatgpt', 'lxweb'],
      hasCapabilitySearchModel: true
    })
    ctx.assert.ok(/优先 web_search/.test(enabledWithModel))
    ctx.assert.ok(/ChatGPT web\.run/.test(enabledWithModel))

    const tools = [
      { type: 'function', function: { name: 'web_bridge_search', description: 'old' } },
      { type: 'function', function: { name: 'lxweb', description: 'old' } }
    ]
    const rewritten = order.applySearchToolDescriptions(tools, {
      pageSearchEnabled: true,
      searchToolOrder: ['lxweb', 'chatgpt'],
      hasCapabilitySearchModel: false
    })
    ctx.assert.ok(/灵犀内置搜索排在前面/.test(rewritten[0].function.description))
    ctx.assert.ok(/优先本工具 action=search/.test(rewritten[1].function.description))

    const rewrittenWithModel = order.applySearchToolDescriptions(
      [...tools, { type: 'function', function: { name: 'web_search', description: 'old' } }],
      { pageSearchEnabled: false, hasCapabilitySearchModel: true }
    )
    ctx.assert.ok(/优先 web_search/.test(rewrittenWithModel[1].function.description))
    ctx.assert.equal(/web_bridge_search/.test(rewrittenWithModel[1].function.description), false)
    ctx.assert.ok(/已配置的搜索模型/.test(rewrittenWithModel[2].function.description))

    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const settings = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/web-bridge-search-settings.js'), 'utf8')
    ctx.assert.ok(html.includes('搜索工具调度'))
    ctx.assert.ok(html.includes('协议直连'))
    ctx.assert.ok(html.includes('不会再弹出 Chrome'))
    ctx.assert.ok(html.includes('不影响能力调度里配置的搜索模型'))
    ctx.assert.ok(html.includes('web_search 仍会路由到已配置的搜索模型'))
    ctx.assert.ok(html.includes('webBridgeSearchOrderList'))
    ctx.assert.ok(settings.includes("chatgpt: 'ChatGPT web.run'"))
    ctx.assert.ok(settings.includes("lxweb: '灵犀内置搜索'"))
    ctx.assert.ok(settings.includes('is-primary'))
    ctx.assert.ok(settings.includes('优先'))
  }
}
