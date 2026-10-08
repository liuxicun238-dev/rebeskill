const path = require('path')

module.exports = {
  id: 'capability.stable-entrypoints',
  title: 'Stable capability tools route without exposing provider/tool-pack names',
  tags: ['capability', 'routing', 'tools', 'harness'],
  changedFilePatterns: [
    /^electron\/modules\/tool-handlers\/capability-tools\.js$/i,
    /^electron\/modules\/schemas\/capability-tools\.js$/i,
    /^electron\/modules\/schemas\/index\.js$/i,
    /^electron\/modules\/tool-registry\.js$/i,
    /^electron\/modules\/capability-tiers\.js$/i,
    /^electron\/modules\/tool-handlers\/tool-system\.js$/i,
    /^electron\/modules\/chat\/model-capability-prompt\.js$/i,
    /^electron\/modules\/lingxi-harness\/capability-catalog\.js$/i,
    /^electron\/modules\/lingxi-harness\/model-broker\.js$/i,
    /^electron\/modules\/tools\.js$/i
  ],

  async run(ctx) {
    const schemas = require(path.join(ctx.root, 'electron/modules/schemas'))
    const registry = require(path.join(ctx.root, 'electron/modules/tool-registry'))
    const capabilityTools = require(path.join(ctx.root, 'electron/modules/tool-handlers/capability-tools'))
    const webBridgeSearch = require(path.join(ctx.root, 'electron/modules/web-bridge-search'))
    const browserTool = require(path.join(ctx.root, 'electron/tools/browser-tool-secure'))
    const vision = require(path.join(ctx.root, 'electron/modules/tool-handlers/vision'))
    const imageGeneration = require(path.join(ctx.root, 'electron/modules/tool-handlers/image-gen'))
    const toolSystem = require(path.join(ctx.root, 'electron/modules/tool-handlers/tool-system'))
    const tiers = require(path.join(ctx.root, 'electron/modules/capability-tiers'))
    const modelAdapter = require(path.join(ctx.root, 'electron/modules/model-api-adapter'))

    const stableNames = ['web_search', 'web_open', 'vision_analyze', 'image_generate']
    const schemaNames = new Set(schemas.MODEL_TOOLS_SCHEMA.map(item => item.function?.name))
    stableNames.forEach(name => {
      ctx.assert.ok(schemaNames.has(name), `${name} must be model-visible`)
      ctx.assert.ok(registry.hasToolHandler(name), `${name} must have an executable handler`)
      ctx.assert.ok(tiers.TOOL_PACKS.always.has(name), `${name} must be always-on`)
    })
    const modelVisibleNames = modelAdapter.filterModelToolsForRequest([], {
      modelConfig: { provider: 'openai', modelId: 'gpt-4.1' },
      modelId: 'gpt-4.1',
      latestUserText: '普通聊天'
    }).map(item => item.function?.name)
    stableNames.forEach(name => {
      ctx.assert.ok(modelVisibleNames.includes(name), `${name} must remain visible in a normal new turn`)
    })

    const originalSearch = webBridgeSearch.searchWithWebBridge
    const originalLxweb = browserTool.lxweb
    const originalVision = vision.inspectImageWithPermission
    const originalImage = imageGeneration.generateImageWithModel
    try {
      let searchArgs = null
      let searchContext = null
      webBridgeSearch.searchWithWebBridge = async (args, context) => {
        searchArgs = args
        searchContext = context
        return {
          success: true,
          engine: 'test',
          answer: '官方结果',
          sources: [{ title: 'Official', url: 'https://example.com/official' }]
        }
      }
      const searchResult = await capabilityTools.handlers.web_search({
        query: 'Lingxi API',
        source_preference: 'official',
        time_sensitive: true
      }, {})
      ctx.assert.equal(searchResult.success, true)
      ctx.assert.equal(searchResult.capability, 'web_search')
      ctx.assert.equal(searchResult.routed_tool, 'web_bridge_search')
      ctx.assert.ok(/官方/.test(searchArgs.focus))
      ctx.assert.ok(/时效/.test(searchArgs.focus))
      ctx.assert.equal(searchContext.modelConfig?.modelId || '', '')

      let openArgs = null
      browserTool.lxweb = async args => {
        openArgs = args
        return { success: true, action: 'fetch', url: args.url, text: 'doc body' }
      }
      const openResult = await capabilityTools.handlers.web_open({ url: 'https://example.com/docs' }, {
        webContents: null,
        projectId: 'stable-entrypoint-test'
      })
      ctx.assert.equal(openResult.success, true)
      ctx.assert.equal(openResult.capability, 'web_open')
      ctx.assert.equal(openResult.routed_tool, 'lxweb:fetch')
      ctx.assert.equal(openArgs.action, 'fetch')

      vision.inspectImageWithPermission = async (projectId, args, resolvePath, modelConfig) => ({
        success: true,
        path: resolvePath(args.path),
        model: modelConfig?.modelId || 'vision-route'
      })
      const visionResult = await capabilityTools.handlers.vision_analyze(
        { path: 'assets/ui.png', question: '检查布局' },
        {
          projectId: 'p1',
          resolvePath: value => path.join('C:\\workspace', value),
          modelConfig: { modelId: 'chat' },
          availableModels: [{
            modelId: 'vision-model',
            apiUrl: 'https://vision.example/v1',
            apiKey: 'test-key',
            capabilities: { vision: true }
          }]
        }
      )
      ctx.assert.equal(visionResult.success, true)
      ctx.assert.equal(visionResult.capability, 'vision_analyze')
      ctx.assert.equal(visionResult.routed_tool, 'inspect_image')
      ctx.assert.equal(visionResult.route_mode, 'routed-model')

      imageGeneration.generateImageWithModel = async (projectId, args, modelConfig) => ({
        success: true,
        path: 'generated/image.png',
        prompt: args.prompt,
        model: modelConfig?.modelId || 'image-route'
      })
      const imageResult = await capabilityTools.handlers.image_generate(
        { prompt: '产品主视觉' },
        {
          projectId: 'p1',
          modelConfig: { modelId: 'chat' },
          availableModels: [{
            modelId: 'image-model',
            apiUrl: 'https://image.example/v1',
            apiKey: 'test-key',
            capabilities: { imageGeneration: true }
          }]
        }
      )
      ctx.assert.equal(imageResult.success, true)
      ctx.assert.equal(imageResult.capability, 'image_generate')
      ctx.assert.equal(imageResult.routed_tool, 'generate_image')
      ctx.assert.equal(imageResult.route_mode, 'routed-model')

      const discover = await toolSystem.handlers.capability_discover({ query: '生成一张图片' }, {
        modelConfig: { modelId: 'chat', capabilities: { text: true, toolCalling: true } },
        options: { enabledPacks: [] }
      })
      const imageCapability = discover.capabilities.find(item => item.id === 'image_generation')
      ctx.assert.ok(imageCapability)
      ctx.assert.equal(imageCapability.available, true)
      ctx.assert.equal(imageCapability.stable_tools[0], 'image_generate')
    } finally {
      webBridgeSearch.searchWithWebBridge = originalSearch
      browserTool.lxweb = originalLxweb
      vision.inspectImageWithPermission = originalVision
      imageGeneration.generateImageWithModel = originalImage
    }
  }
}
