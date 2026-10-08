const fs = require('fs')
const path = require('path')

const DEFAULT_ORDER = ['chatgpt', 'lxweb', 'grok', 'deepseek', 'qwen', 'gemini', 'claude', 'arena']

module.exports = {
  id: 'web-bridge-search.page-model',
  title: 'API models get ranked web search; Lingxi native search stays available',
  tags: ['web-bridge', 'search', 'tools'],
  changedFilePatterns: [
    /^electron\/modules\/web-bridge-search\.js$/i,
    /^electron\/modules\/chatgpt-web-search\//i,
    /^electron\/modules\/tool-handlers\/web-bridge-search\.js$/i,
    /^electron\/modules\/schemas\/browser-search\.js$/i,
    /^electron\/modules\/capability-tiers\.js$/i,
    /^electron\/modules\/tool-registry\.js$/i,
    /^electron\/modules\/agent-runtime\.js$/i,
    /^electron\/modules\/web-bridge-coding-protocol\.js$/i,
    /^electron\/modules\/web-bridge-chrome-profile\.js$/i,
    /^electron\/modules\/model-api-adapter\.js$/i,
    /^electron\/tools\/browser-tool-secure\.js$/i
  ],

  async run(ctx) {
    const search = require(path.join(ctx.root, 'electron/modules/web-bridge-search'))
    const chatgptSearch = require(path.join(ctx.root, 'electron/modules/chatgpt-web-search'))
    const capabilityTiers = require(path.join(ctx.root, 'electron/modules/capability-tiers'))
    const { MODEL_TOOLS_SCHEMA } = require(path.join(ctx.root, 'electron/modules/schemas'))
    const toolRegistry = require(path.join(ctx.root, 'electron/modules/tool-registry'))
    const profile = require(path.join(ctx.root, 'electron/modules/web-bridge-chrome-profile'))
    const originalPageSearchEnabled = profile.isWebBridgePageSearchEnabled
    const originalSearchOrder = profile.getWebBridgeSearchProviderOrder
    profile.isWebBridgePageSearchEnabled = () => true
    profile.getWebBridgeSearchProviderOrder = () => DEFAULT_ORDER.slice()
    const compactPrompt = require(path.join(ctx.root, 'electron/modules/agent-runtime')).buildCompactAgentRuntimePrompt()

    try {
      const schema = MODEL_TOOLS_SCHEMA.find(item => item.function?.name === 'web_bridge_search')
      ctx.assert.ok(schema, 'web_bridge_search must be a model-visible tool')
      ctx.assert.ok(schema.function.parameters.required.includes('query'), 'search tool requires a query')
      ctx.assert.ok(/协议直连/.test(schema.function.description), 'search tool should say protocol-direct, not page chat')

      const searchIndexText = fs.readFileSync(path.join(ctx.root, 'electron/modules/chatgpt-web-search/index.js'), 'utf8')
      const runnerText = fs.readFileSync(path.join(ctx.root, 'electron/modules/chatgpt-web-search/node-runner.js'), 'utf8')
      ctx.assert.ok(searchIndexText.includes('runNodeWebRunSearch'), 'ChatGPT search must use the Node protocol runner')
      ctx.assert.equal(/spawnSync|execFileSync/.test(runnerText), false, 'protocol search must not block the Electron main process')
      ctx.assert.equal(/acquireLoggedInPage|launchExternalBrowser/.test(searchIndexText), false, 'ChatGPT web.run must not open Chrome')
      const nodeRunner = require(path.join(ctx.root, 'electron/modules/chatgpt-web-search/node-runner'))
      ctx.assert.ok(nodeRunner.resolveSentinelRoot(), 'protocol runtime should resolve next to this project')

      ctx.assert.equal(
        capabilityTiers.WEB_GPT_CORE_TOOLS.includes('web_bridge_search'),
        false,
        'page models already have native search and must not recurse into web_bridge_search'
      )
      ctx.assert.ok(
        capabilityTiers.TOOL_PACKS.always.has('web_bridge_search'),
        'API models should always see ChatGPT web search'
      )
      ctx.assert.ok(toolRegistry.hasToolHandler('web_bridge_search'), 'search handler must be registered')
      const validation = toolRegistry.validateToolRegistry()
      ctx.assert.equal(validation.success, true, validation.errors.join('\n') || 'tool registry should stay valid after adding ChatGPT search')

      const adapter = require(path.join(ctx.root, 'electron/modules/model-api-adapter'))
      const pageModelTools = adapter.filterModelToolsForRequest([], {
        modelConfig: { provider: 'chatgpt-web-bridge', modelId: 'chatgpt-web-chat' },
        modelId: 'chatgpt-web-chat'
      }).map(item => item.function?.name)
      ctx.assert.equal(pageModelTools.includes('web_bridge_search'), false, 'ChatGPT web as the chat model must not see search tool')
      const apiTools = adapter.filterModelToolsForRequest([], {
        modelConfig: { provider: 'openai', modelId: 'gpt-4.1' },
        modelId: 'gpt-4.1'
      }).map(item => item.function?.name)
      ctx.assert.ok(apiTools.includes('web_bridge_search'), 'API models must see webpage search')
      ctx.assert.ok(apiTools.includes('lxweb'), 'API models must still see Lingxi native search')
      ctx.assert.ok(compactPrompt.includes('web_bridge_search'), 'compact runtime should prefer the webpage search tool by default')
      ctx.assert.ok(/ChatGPT web\.run/.test(compactPrompt), 'default rank 1 must be ChatGPT web.run, not page-chat passthrough')
      ctx.assert.ok(/lxweb action=search/.test(compactPrompt), 'compact runtime must keep lxweb search as fallback')

      const fullPrompt = require(path.join(ctx.root, 'electron/modules/agent-runtime')).buildAgentRuntimePrompt()
      ctx.assert.ok(fullPrompt.includes('web_bridge_search'), 'full runtime should also prefer ChatGPT web search by default')
      ctx.assert.ok(/lxweb action=search/.test(fullPrompt), 'full runtime must keep lxweb search as fallback')

      const hiddenFromPageModel = capabilityTiers.filterWebGptCoreTools(MODEL_TOOLS_SCHEMA)
      ctx.assert.equal(
        hiddenFromPageModel.some(item => item.function?.name === 'web_bridge_search'),
        false,
        'web-bridge primary models must not receive web_bridge_search in the tool list'
      )

      const protocol = require(path.join(ctx.root, 'electron/modules/web-bridge-coding-protocol'))
      const pagePrompt = protocol.assemblePassthroughPagePrompt({
        transcript: '--- user 1 ---\n请查询并回答：\nNode 22 发布日期',
        tools: []
      })
      ctx.assert.equal(pagePrompt, '请查询并回答：\nNode 22 发布日期')
      ctx.assert.equal(/可用工具|lxweb|联网|LINGXI/.test(pagePrompt), false, 'empty-tool passthrough must not mention tools or search bans')
      ctx.assert.ok(search.DEFAULT_TIMEOUT_MS >= 60 * 1000, 'page search should wait at least a minute')

      const longAnswer = protocol.pickUsableCapturedWebReply({
        markdown: [
          '1. 2026 年 8 月 GLM 最新动态',
          'GLM-5.3 是最新基座，Terminal-Bench 3.0 从 4.6 提到 28.3。',
          '公开权重预计在安全评估后放出，API 页面仍显示 soon。'
        ].join('\n')
      })
      ctx.assert.ok(longAnswer?.markdown.includes('GLM-5.3'), 'already-visible page answers must count as usable replies')
      ctx.assert.equal(protocol.pickUsableCapturedWebReply({ markdown: '正在思考' }), null)
      ctx.assert.equal(protocol.shouldSettleWebReply({
        incomplete: false,
        thinkingOnly: false,
        stableCount: 2,
        generating: true,
        textLength: 400
      }), true, 'long page-search answers should settle even if the stop button is still visible')
      ctx.assert.equal(protocol.shouldSettleWebReply({
        incomplete: false,
        thinkingOnly: true,
        stableCount: 4,
        generating: false,
        textLength: 12
      }), false)

      const harvestedAbort = await protocol.takeUsableWebReplyIfAborted({
        signal: { aborted: true },
        latestDelta: longAnswer,
        stopPage: async () => { throw new Error('should not stop after a usable reply') }
      })
      ctx.assert.ok(harvestedAbort?.markdown.includes('GLM-5.3'), 'abort must keep an already-written page answer')

      const skipped = await search.searchWithWebBridge(
        { query: 'hello' },
        { modelConfig: { provider: 'chatgpt-web-bridge', modelId: 'chatgpt-web-chat' } },
        { skipCapabilitySearch: true }
      )
      ctx.assert.equal(skipped.skipped, true, 'a ChatGPT page-model primary session must not call itself')

      const grokAllowed = await search.searchWithWebBridge(
        { query: 'hello' },
        { modelConfig: { provider: 'grok-web-bridge', modelId: 'grok-web-chat' } },
        {
          skipCapabilitySearch: true,
          runSearch: async () => ({
            success: true,
            engine: 'chatgpt-web.run',
            provider: 'chatgpt',
            query: 'hello',
            sources: [{ title: 'Example', url: 'https://example.com' }]
          })
        }
      )
      ctx.assert.equal(grokAllowed.success, true, 'non-ChatGPT page models may still call ChatGPT web.run search')

      const mocked = await search.searchWithWebBridge(
        { query: 'Node 22 发布日期' },
        { projectId: 'p1' },
        {
          skipCapabilitySearch: true,
          runSearch: async (args) => ({
            success: true,
            engine: 'chatgpt-web.run',
            provider: 'chatgpt',
            providerLabel: 'ChatGPT web.run',
            query: args.query,
            queries: args.queries,
            sources: [{ title: 'Node.js', url: 'https://nodejs.org/blog/release/v22.0.0' }],
            result_groups: [{
              domain: 'nodejs.org',
              entries: [{ title: 'Node.js', url: 'https://nodejs.org/blog/release/v22.0.0', snippet: 'Node.js 22' }]
            }]
          })
        }
      )
      ctx.assert.equal(mocked.success, true)
    ctx.assert.equal(mocked.engine, 'chatgpt-web.run')
    ctx.assert.equal(mocked.sources[0].url, 'https://nodejs.org/blog/release/v22.0.0')

    let openedChrome = false
    const protocolOnly = await chatgptSearch.searchWithChatGptWeb(
      { query: 'protocol only' },
      {},
      {
        runProtocolSearch: async () => ({
          success: true,
          engine: 'chatgpt-web.run',
          provider: 'chatgpt',
          query: 'protocol only',
          sources: [{ title: 'Protocol', url: 'https://example.com/protocol' }]
        }),
        acquirePage: async () => {
          openedChrome = true
          throw new Error('must not open Chrome')
        }
      }
    )
    ctx.assert.equal(protocolOnly.engine, 'chatgpt-web.run')
    ctx.assert.equal(openedChrome, false, 'web.run must not launch a ChatGPT page')

      ctx.assert.ok(!schema.function.parameters.properties.provider, 'search tool must not let the API model pick a provider')

      const grokFirst = await search.searchWithWebBridge(
        { query: 'hello from grok' },
        {},
        {
          skipCapabilitySearch: true,
          searchProviderOrder: ['grok', 'chatgpt', 'lxweb'],
          listProviders: () => [{
            id: 'grok',
            label: 'Grok 网页版',
            available: true,
            loggedIn: true,
            running: true,
            loginBrowserOpen: false,
            suggested: { apiUrl: 'http://127.0.0.1:3999', apiKey: 'k', modelId: 'grok-web-chat' }
          }],
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              choices: [{ message: { content: 'Grok says [Example](https://example.com/grok)' } }]
            })
          })
        }
      )
      ctx.assert.equal(grokFirst.success, true)
      ctx.assert.equal(grokFirst.provider, 'grok', 'rank-1 page provider should be tried first inside web_bridge_search')

      let usedFetch = false
      let usedWebRun = false
      const chatgptIgnoresPassthrough = await search.searchWithWebBridge(
        { query: 'must use web.run' },
        {},
        {
          skipCapabilitySearch: true,
          searchProviderOrder: ['chatgpt', 'grok'],
          fetchImpl: async () => {
            usedFetch = true
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                choices: [{ message: { content: 'passthrough should not run [Example](https://example.com/skip)' } }]
              })
            }
          },
          runSearch: async () => {
            usedWebRun = true
            return {
              success: true,
              engine: 'chatgpt-web.run',
              provider: 'chatgpt',
              providerLabel: 'ChatGPT web.run',
              query: 'must use web.run',
              sources: [{ title: 'Web.run', url: 'https://example.com/webrun' }]
            }
          }
        }
      )
      ctx.assert.equal(chatgptIgnoresPassthrough.engine, 'chatgpt-web.run')
      ctx.assert.equal(usedWebRun, true, 'ChatGPT schedule item must call web.run')
      ctx.assert.equal(usedFetch, false, 'ChatGPT schedule item must not fall back to page-chat passthrough')

      const disabled = await search.searchWithWebBridge(
        { query: '关闭后改走灵犀搜索' },
        {},
        { pageSearchEnabled: false, skipCapabilitySearch: true, hasCapabilitySearchModel: false }
      )
      ctx.assert.equal(disabled.skipped, true)
      ctx.assert.ok(/lxweb 进行公开检索/.test(disabled.error), 'disabled webpage search without a search model should point back to lxweb search')
      ctx.assert.equal(disabled.next_action, 'use_lxweb_search')

      const keepSearchModel = await search.searchWithWebBridge(
        { query: '关闭网页桥后仍走搜索模型' },
        {},
        { pageSearchEnabled: false, skipCapabilitySearch: true, hasCapabilitySearchModel: true }
      )
      ctx.assert.equal(keepSearchModel.next_action, 'use_web_search')
      ctx.assert.ok(/web_search/.test(keepSearchModel.error), 'configured search models must stay preferred when webpage search is off')
      ctx.assert.equal(/请使用 lxweb 进行公开检索，或在设置中重新开启/.test(keepSearchModel.error), false)

      const failedSearchModel = await search.searchWithWebBridge(
        { query: '搜索模型失败' },
        {},
        {
          pageSearchEnabled: false,
          searchWithCapabilityApi: async () => ({
            success: false,
            skipped: false,
            error: 'timeout',
            providerLabel: 'GPTsearch'
          })
        }
      )
      ctx.assert.equal(failedSearchModel.next_action, 'fix_search_model_or_use_lxweb')
      ctx.assert.ok(/GPTsearch/.test(failedSearchModel.error), 'search-model failures must keep the model name')
      ctx.assert.ok(/timeout/.test(failedSearchModel.error))
      ctx.assert.equal(failedSearchModel.skipped, false)

      profile.isWebBridgePageSearchEnabled = () => false
      try {
        const hiddenTools = adapter.filterModelToolsForRequest([], {
          modelConfig: { provider: 'openai', modelId: 'gpt-4.1' },
          modelId: 'gpt-4.1'
        }).map(item => item.function?.name)
        ctx.assert.equal(hiddenTools.includes('web_bridge_search'), false, 'turning the switch off must hide webpage search')
        ctx.assert.ok(hiddenTools.includes('lxweb'), 'lxweb search/fetch/open must remain available')
        const lxweb = adapter.filterModelToolsForRequest([], {
          modelConfig: { provider: 'openai', modelId: 'gpt-4.1' },
          modelId: 'gpt-4.1'
        }).find(item => item.function?.name === 'lxweb')
        ctx.assert.equal(/web_bridge_search/.test(lxweb.function.description), false, 'lxweb must not tell the model to prefer a hidden tool')
        ctx.assert.ok(
          /公开网页搜索/.test(lxweb.function.description) || /优先 web_search/.test(lxweb.function.description),
          'lxweb should advertise native search or defer to a configured search model when webpage search is off'
        )
      } finally {
        profile.isWebBridgePageSearchEnabled = () => true
      }

      profile.getWebBridgeSearchProviderOrder = () => ['lxweb', 'chatgpt', 'grok', 'deepseek', 'qwen', 'gemini', 'claude', 'arena']
      const lxwebFirstTools = adapter.filterModelToolsForRequest([], {
        modelConfig: { provider: 'openai', modelId: 'gpt-4.1' },
        modelId: 'gpt-4.1'
      })
      const lxwebFirst = lxwebFirstTools.find(item => item.function?.name === 'lxweb')
      const webFirst = lxwebFirstTools.find(item => item.function?.name === 'web_bridge_search')
      ctx.assert.ok(
        /优先本工具 action=search/.test(lxwebFirst.function.description) || /优先 web_search/.test(lxwebFirst.function.description),
        'lxweb-first ranking should prefer native search or a configured search model'
      )
      ctx.assert.ok(/灵犀内置搜索排在前面/.test(webFirst.function.description), 'lxweb-first ranking should keep webpage search as fallback')
      profile.getWebBridgeSearchProviderOrder = () => DEFAULT_ORDER.slice()

      const schemaText = fs.readFileSync(path.join(ctx.root, 'electron/modules/schemas/browser-search.js'), 'utf8')
      ctx.assert.ok(
        /公开网页搜索|公开搜索页/.test(schemaText) && schemaText.includes('action'),
        'lxweb schema should retain its public-search compatibility contract'
      )
      const lxwebSchemaBlock = schemaText.split('name": "lxweb"')[1].split('name": "discover_code"')[0]
      ctx.assert.ok(/"search"/.test(lxwebSchemaBlock), 'lxweb schema must keep action=search')

      const { BrowserToolSecure } = require(path.join(ctx.root, 'electron/tools/browser-tool-secure'))
      const tool = new BrowserToolSecure()
      const originalSearch = tool.search.bind(tool)
      tool.search = async (query) => ({ success: true, query, engine: 'auto', results: [] })
      const searched = await tool.lxweb({ action: 'search', query: 'should still search' })
      tool.search = originalSearch
      ctx.assert.equal(searched.disabled, undefined, 'lxweb search must stay enabled')
      ctx.assert.equal(searched.action, 'search')
      ctx.assert.equal(searched.success, true)

      ctx.assert.ok(chatgptSearch.isChatGptWebChatPrimary({ provider: 'chatgpt-web-bridge' }, 'chatgpt-web-chat'))
      ctx.assert.equal(chatgptSearch.isChatGptWebChatPrimary({ provider: 'grok-web-bridge' }, 'grok-web-chat'), false)
    } finally {
      profile.isWebBridgePageSearchEnabled = originalPageSearchEnabled
      profile.getWebBridgeSearchProviderOrder = originalSearchOrder
    }
  }
}
