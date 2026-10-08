const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'capability.web-search',
  title: 'Search capability can be labeled, routed, and called via web_bridge_search',
  tags: ['models', 'routing', 'search', 'tools'],
  changedFilePatterns: [
    /^electron\/modules\/model-capabilities\.js$/i,
    /^electron\/modules\/capability-web-search\.js$/i,
    /^electron\/modules\/web-bridge-search\.js$/i,
    /^electron\/modules\/lingxi-harness\/model-broker\.js$/i,
    /^electron\/modules\/chat\/model-capability-prompt\.js$/i,
    /^electron\/modules\/tool-handlers\/vision\.js$/i,
    /^electron\/modules\/chatgpt-web-search\/search-tool-order\.js$/i,
    /^frontend\/index\.html$/i,
    /^frontend\/scripts\/features\/models\.js$/i,
    /^frontend\/scripts\/features\/settings-main\.js$/i,
    /^frontend\/scripts\/features\/quick-model-settings\.js$/i
  ],

  async run(ctx) {
    const caps = require(path.join(ctx.root, 'electron/modules/model-capabilities'))
    const searchApi = require(path.join(ctx.root, 'electron/modules/capability-web-search'))
    const search = require(path.join(ctx.root, 'electron/modules/web-bridge-search'))
    const prompt = require(path.join(ctx.root, 'electron/modules/chat/model-capability-prompt'))

    ctx.assert.ok(caps.capabilityDefinitions.some(item => item.key === 'webSearch'), 'capability list must include search')
    ctx.assert.equal(caps.defaultCapabilities.webSearch, false)

    const fromAlias = caps.normalizeCapabilities({ text: true, searchCalling: true })
    ctx.assert.equal(fromAlias.webSearch, true, 'searchCalling alias must map to webSearch')
    ctx.assert.equal(caps.hasCapability({ capabilities: { search: true, text: true } }, 'webSearch'), true)

    ctx.assert.equal(
      searchApi.buildSearchEndpoint({ apiUrl: 'https://api.tavily.com' }),
      'https://api.tavily.com/search'
    )
    ctx.assert.equal(
      searchApi.buildSearchEndpoint({ apiUrl: 'https://example.com/v1/search', useFullUrl: true }),
      'https://example.com/v1/search'
    )
    ctx.assert.equal(searchApi.getSearchProviderKind('https://api.tavily.com/search'), 'tavily')
    ctx.assert.equal(searchApi.getSearchProviderKind('https://api.search.tinyfish.ai'), 'tinyfish')
    ctx.assert.equal(searchApi.getSearchProviderKind('https://api.openai.com/v1/chat/completions'), 'chat')
    ctx.assert.equal(
      searchApi.buildSearchEndpoint({
        apiUrl: 'https://api.search.tinyfish.ai?query=latest+FIFA+World+Cup+news+today&location=US&language=en',
        useFullUrl: true
      }),
      'https://api.search.tinyfish.ai/'
    )

    const tavily = searchApi.parseSearchPayload({
      answer: 'Node 22 已发布',
      results: [{ title: 'Node.js 22', url: 'https://nodejs.org/blog', content: 'Node.js 22 release' }]
    })
    ctx.assert.ok(tavily.sources[0].url.includes('nodejs.org'))
    ctx.assert.ok(/Node 22/.test(tavily.answer))

    const serper = searchApi.parseSearchPayload({
      organic: [{ title: 'Example', link: 'https://example.com/a', snippet: 'hello' }]
    })
    ctx.assert.equal(serper.sources[0].url, 'https://example.com/a')

    const bing = searchApi.parseSearchPayload({
      webPages: { value: [{ name: 'Bing', url: 'https://example.com/bing', snippet: 'bing hit' }] }
    })
    ctx.assert.equal(bing.sources[0].title, 'Bing')

    const searchModel = {
      modelName: 'Tavily Search',
      modelId: 'tavily',
      apiUrl: 'https://api.tavily.com',
      apiKey: 'tvly-test',
      capabilities: { webSearch: true, text: false, toolCalling: false }
    }
    let requestedUrl = ''
    let requestedBody = null
    const apiHit = await searchApi.searchWithCapabilityApi(
      { query: 'Node 22 发布日期', skipPermission: true },
      {},
      {
        searchModels: [searchModel],
        getCapabilityPolicies: () => ({ webSearchConfirm: 'never' }),
        fetchImpl: async (url, options) => {
          requestedUrl = url
          requestedBody = JSON.parse(options.body)
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              answer: '2024-04-24',
              results: [{ title: 'Node.js 22', url: 'https://nodejs.org/blog/release/v22.0.0', content: 'released' }]
            })
          }
        }
      }
    )
    ctx.assert.equal(apiHit.success, true)
    ctx.assert.equal(apiHit.engine, 'capability-api')
    ctx.assert.equal(requestedUrl, 'https://api.tavily.com/search')
    ctx.assert.equal(requestedBody.query, 'Node 22 发布日期')
    ctx.assert.equal(apiHit.sources[0].url, 'https://nodejs.org/blog/release/v22.0.0')

    const tinyfishModel = {
      modelName: 'TinyFish',
      modelId: 'tinyfish',
      apiUrl: 'https://api.search.tinyfish.ai',
      apiKey: 'tf-test',
      useFullUrl: true,
      capabilities: { webSearch: true, text: false, toolCalling: false }
    }
    let tinyfishUrl = ''
    let tinyfishOptions = null
    const tinyfishHit = await searchApi.searchWithCapabilityApi(
      { query: 'latest FIFA World Cup news today', skipPermission: true },
      {},
      {
        searchModels: [tinyfishModel],
        getCapabilityPolicies: () => ({ webSearchConfirm: 'never' }),
        fetchImpl: async (url, options) => {
          tinyfishUrl = url
          tinyfishOptions = options
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              query: 'latest FIFA World Cup news today',
              results: [{
                position: 1,
                title: 'FIFA World Cup',
                snippet: 'Latest match news',
                url: 'https://www.fifa.com/news'
              }],
              total_results: 1,
              page: 0
            })
          }
        }
      }
    )
    ctx.assert.equal(tinyfishHit.success, true)
    ctx.assert.equal(tinyfishOptions.method, 'GET')
    ctx.assert.equal(tinyfishOptions.body, undefined)
    ctx.assert.equal(tinyfishOptions.headers['X-API-Key'], 'tf-test')
    ctx.assert.ok(tinyfishUrl.startsWith('https://api.search.tinyfish.ai'))
    ctx.assert.ok(/FIFA/.test(tinyfishUrl))
    ctx.assert.ok(/location=US/.test(tinyfishUrl))
    ctx.assert.ok(/language=en/.test(tinyfishUrl))
    ctx.assert.equal('X-TF-Request-Origin' in tinyfishOptions.headers, false)
    ctx.assert.equal(tinyfishHit.sources[0].url, 'https://www.fifa.com/news')

    const zhTinyfish = searchApi.buildSearchRequest(tinyfishModel, ['灵犀 安装包'])
    ctx.assert.equal(zhTinyfish.method, 'GET')
    ctx.assert.ok(/location=CN/.test(zhTinyfish.url))
    ctx.assert.ok(/language=zh/.test(zhTinyfish.url))

    const routedFirst = await search.searchWithWebBridge(
      { query: '优先走搜索 API' },
      {},
      {
        pageSearchEnabled: false,
        searchWithCapabilityApi: async () => ({
          success: true,
          engine: 'capability-api',
          provider: 'capability-api',
          providerLabel: 'Tavily Search',
          query: '优先走搜索 API',
          sources: [{ title: 'API', url: 'https://example.com/api' }]
        })
      }
    )
    ctx.assert.equal(routedFirst.engine, 'capability-api', 'labeled search API must run even when page search is off')

    const noModel = await searchApi.searchWithCapabilityApi({ query: 'x' }, {}, { searchModels: [] })
    ctx.assert.equal(noModel.skipped, true)

    const promptText = prompt.buildCurrentModelCapabilityPrompt({
      modelName: 'demo',
      capabilities: { text: true, webSearch: true, toolCalling: true }
    })
    ctx.assert.ok(/搜索调用/.test(promptText))

    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const modelsJs = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/models.js'), 'utf8')
    const settingsJs = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/settings-main.js'), 'utf8')
    ctx.assert.ok(html.includes('id="capabilityWebSearch"'), 'quick add model form must have search checkbox')
    ctx.assert.ok(html.includes('id="settingsCapabilityWebSearch"'), 'settings editor must have search checkbox')
    ctx.assert.ok(html.includes('id="settingsWebSearchConfirm"'), 'routing page must keep search confirm policy')
    ctx.assert.ok(html.includes('搜索调用'), 'capability grid must show 搜索调用')
    ctx.assert.ok(
      html.indexOf('id="settingsCapabilityText"') < html.indexOf('id="settingsCapabilityToolCalling"')
        && html.indexOf('id="settingsCapabilityToolCalling"') < html.indexOf('id="settingsCapabilityVision"'),
      'settings capability grid must place 工具调用 immediately after 文本'
    )
    ctx.assert.ok(
      html.indexOf('id="capabilityText"') < html.indexOf('id="capabilityToolCalling"')
        && html.indexOf('id="capabilityToolCalling"') < html.indexOf('id="capabilityVision"'),
      'quick add capability grid must place 工具调用 immediately after 文本'
    )
    ctx.assert.ok(modelsJs.includes("'webSearch'"), 'frontend store must route webSearch')
    ctx.assert.ok(settingsJs.includes("key: 'webSearch'"), 'routing nav must include search')
    ctx.assert.ok(settingsJs.includes("policyKey: 'webSearchConfirm'"))
    ctx.assert.ok(settingsJs.includes('与网页桥开关无关'), 'search routing copy must stay independent from webpage-bridge toggle')
  }
}
