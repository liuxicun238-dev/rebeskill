const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'harness.kernel-contract',
  title: 'LingXi Harness owns the durable Turn lifecycle without replacing product adapters',
  tags: ['harness', 'turn', 'runtime', 'kernel'],
  changedFilePatterns: [
    /^electron\/modules\/lingxi-harness\/index\.js$/i,
    /^electron\/modules\/lingxi-harness\/capability-catalog\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i
  ],

  async run(ctx) {
    const harness = require(path.join(ctx.root, 'electron/modules/lingxi-harness'))
    const turnStore = require(path.join(ctx.root, 'electron/modules/chat/turn-item-store'))
    const config = require(path.join(ctx.root, 'electron/modules/config'))
    const workspace = ctx.createWorkspace('harness-kernel-contract')
    const projectId = `harness-${Date.now()}`

    config.setProjectInstance(projectId, { storagePath: workspace.storagePath })
    try {
      const runtime = harness.startTurn({
        projectId,
        requestId: 'request-harness-1',
        message: '创建一个测试页面并验证',
        modelConfig: { modelName: 'text-model', modelId: 'text-model' },
        effectiveModelId: 'text-model',
        executionMode: 'auto',
        projectMode: 'standard',
        imageDataList: []
      })

      ctx.assert.equal(runtime.runtime, harness.RUNTIME_VERSION)
      ctx.assert.ok(runtime.runRef.runId, 'harness should allocate a durable run id')
      ctx.assert.equal(runtime.metadata.userMessage, '创建一个测试页面并验证')
      ctx.assert.equal(runtime.capabilityPlan.primaryIntent, 'workspace_coding')
      ctx.assert.ok(runtime.capabilityPlan.stableTools.includes('file_read'))
      ctx.assert.ok(Array.isArray(runtime.modelRoute.routes))
      const capabilityPrompt = harness.buildCapabilityCatalogPrompt({
        query: '生成一张海报',
        modelConfig: { modelId: 'text-model', capabilities: { text: true, toolCalling: true } },
        enabledPacks: ['media']
      })
      ctx.assert.match(capabilityPrompt, /LingXi Harness/)
      ctx.assert.match(capabilityPrompt, /image_generation/)
      ctx.assert.match(capabilityPrompt, /image_generate/)
      ctx.assert.match(capabilityPrompt, /已加载工具包.*media/)
      const prepared = []
      const musicResolution = harness.resolveCapabilitiesForTurn({
        message: '生成一段产品宣传背景音乐',
        modelConfig: { modelId: 'text-model', capabilities: { text: true, toolCalling: true } },
        enabledPacks: [],
        enableToolPack: packId => {
          prepared.push(packId)
          return true
        }
      })
      ctx.assert.deepEqual(prepared, ['media'])
      ctx.assert.ok(
        musicResolution.prepared_packs.some(item => item.packId === 'media'),
        'music intent should auto-prepare the media pack'
      )
      ctx.assert.ok(
        musicResolution.tools_to_expose.includes('generate_music'),
        'auto-prepared media tools should be exposed in the same turn'
      )
      const imageOnlyResolution = harness.resolveCapabilitiesForTurn({
        message: '生成一张产品海报',
        enabledPacks: [],
        enableToolPack: packId => {
          throw new Error(`image generation should use the stable entrypoint, not auto-load ${packId}`)
        }
      })
      ctx.assert.deepEqual(imageOnlyResolution.prepared_packs, [])
      ctx.assert.ok(imageOnlyResolution.stable_tools.includes('image_generate'))
      const imagePlan = require(path.join(
        ctx.root,
        'electron/modules/lingxi-harness/capability-planner'
      )).planCapabilities({
        message: '生成一张产品海报',
        modelConfig: { modelName: 'text-model', capabilities: { imageGeneration: false } }
      })
      const imageRoute = harness.planModelRoutes(imagePlan, {
        currentModel: { modelName: 'text-model', capabilities: { imageGeneration: false } },
        availableModels: [{
          modelName: 'image-model',
          capabilities: { imageGeneration: true }
        }]
      })
      ctx.assert.equal(imageRoute.routes[0].mode, 'routed-model')
      ctx.assert.equal(imageRoute.routes[0].model, 'image-model')
      const preferredImageRoute = harness.resolveCapabilityModel(
        'imageGeneration',
        { modelId: 'current-image', apiUrl: 'https://current.example/v1', apiKey: 'key', capabilities: { imageGeneration: true } },
        {
          availableModels: [
            { modelId: 'current-image', apiUrl: 'https://current.example/v1', apiKey: 'key', capabilities: { imageGeneration: true } },
            { modelId: 'preferred-image', apiUrl: 'https://preferred.example/v1', apiKey: 'key', capabilities: { imageGeneration: true } }
          ],
          capabilityRouting: {
            imageGeneration: ['preferred-image']
          }
        }
      )
      ctx.assert.equal(preferredImageRoute.model.modelId, 'preferred-image')
      ctx.assert.equal(preferredImageRoute.reason, 'capability_routing_preference')

      harness.createItem(runtime, {
        id: 'harness-tool-1',
        type: 'tool_call',
        toolName: 'file_read',
        arguments: { path: 'index.html' }
      })
      harness.completeItem(runtime, 'harness-tool-1', {
        success: true,
        content: '<html></html>'
      })
      harness.addAgentMessage(runtime, '已读取并完成验证。', {
        id: 'harness-agent-1'
      })

      const completed = harness.finishTurn(runtime, 'completed', {
        toolCallCount: 1,
        source: 'harness-kernel-contract'
      })
      ctx.assert.equal(completed.turn.status, 'completed')
      ctx.assert.equal(completed.run.status, 'completed')

      const persisted = turnStore.readTurnFromJournal(
        workspace.storagePath,
        runtime.runRef.runId
      )
      ctx.assert.equal(persisted.status, 'completed')
      ctx.assert.equal(persisted.items.length, 2)
      ctx.assert.ok(
        fs.readFileSync(
          path.join(workspace.storagePath, 'runs', `${runtime.runRef.runId}.jsonl`),
          'utf8'
        ).includes('"capability_plan_created"'),
        'the harness should persist its capability plan as a Turn fact'
      )
      ctx.assert.equal(
        persisted.items.find(item => item.toolName === 'file_read')?.status,
        'completed'
      )

      const aiChatSource = fs.readFileSync(
        path.join(ctx.root, 'electron/modules/ai-chat.js'),
        'utf8'
      )
      ctx.assert.match(
        aiChatSource,
        /const lingxiHarness = require\('\.\/lingxi-harness'\)/
      )
      ctx.assert.match(
        aiChatSource,
        /const turnRuntime = lingxiHarness\.startTurn\(\{/
      )
      ctx.assert.match(
        aiChatSource,
        /lingxiHarness\.finishTurn\(turnRuntime, 'completed'/
      )
      ctx.assert.match(
        aiChatSource,
        /lingxiHarness\.event\(turnRuntime, 'tool_started'/
      )
      ctx.assert.match(
        aiChatSource,
        /lingxiHarness\.event\(turnRuntime, 'tool_finished'/
      )
      ctx.assert.match(
        aiChatSource,
        /lingxiHarness\.buildCapabilityPlanPrompt\(\s*turnRuntime\.capabilityPlan,\s*turnRuntime\.modelRoute\s*\)/
      )
      ctx.assert.match(
        aiChatSource,
        /lingxiHarness\.buildCapabilityCatalogPrompt\(\{/
      )
      ctx.assert.match(
        aiChatSource,
        /capabilityResolution: turnRuntime\.capabilityResolution/
      )
      ctx.assert.match(
        aiChatSource,
        /lingxiHarness\.event\(turnRuntime, 'capability_route_observed'/
      )
      ctx.assert.match(
        aiChatSource,
        /routeMode: result\.route_mode \|\| ''/
      )
    } finally {
      config.deleteProjectInstance(projectId)
      await new Promise(resolve => setTimeout(resolve, 120))
      workspace.cleanup()
    }
  }
}
