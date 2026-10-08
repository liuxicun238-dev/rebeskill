const path = require('path')

module.exports = {
  id: 'tools.pack-on-demand',
  title: 'Common tools stay resident; cold packs load through search_tools',
  tags: ['tools', 'capability', 'search-tools'],
  changedFilePatterns: [
    /^electron\/modules\/capability-tiers\.js$/i,
    /^electron\/modules\/model-api-adapter\.js$/i,
    /^electron\/modules\/schemas\/command\.js$/i,
    /^electron\/modules\/tool-handlers\/tool-system\.js$/i,
    /^electron\/modules\/lingxi-harness\/capability-catalog\.js$/i,
    /^electron\/modules\/lingxi-harness\/index\.js$/i
  ],

  async run(ctx) {
    const capabilityTiers = require(path.join(ctx.root, 'electron/modules/capability-tiers'))
    const adapter = require(path.join(ctx.root, 'electron/modules/model-api-adapter'))
    const capabilityState = require(path.join(ctx.root, 'electron/modules/capability-state'))
    const { handlers } = require(path.join(ctx.root, 'electron/modules/tool-handlers/tool-system'))
    const { MODEL_TOOLS_SCHEMA } = require(path.join(ctx.root, 'electron/modules/schemas'))

    ctx.assert.ok(
      MODEL_TOOLS_SCHEMA.some(tool => tool.function?.name === 'search_tools'),
      'search_tools must be in the model-visible schema'
    )

    const ordinary = adapter.filterModelToolsForRequest(
      [{ role: 'user', content: '把这段函数重命名一下' }],
      { adaptiveToolVisibility: true }
    ).map(tool => tool.function?.name)

    ctx.assert.ok(ordinary.includes('file_read'), 'read should stay resident')
    ctx.assert.ok(ordinary.includes('text_edit') || ordinary.includes('apply_patch'), 'edit should stay resident')
    ctx.assert.ok(ordinary.includes('shell_run'), 'commands should stay resident')
    ctx.assert.ok(ordinary.includes('ask_user_choice'), 'ask should stay resident')
    ctx.assert.ok(ordinary.includes('search_tools'), 'cold packs need a loader')
    ctx.assert.ok(ordinary.includes('parallel_research'), 'parallel research is same-process read-only, not a sub-agent pack')
    ctx.assert.ok(ordinary.includes('delegate_agents'), 'standard-mode team dispatch stays in the always-on core')
    ctx.assert.equal(ordinary.includes('generate_image'), false, 'image generation should not preload on a rename')
    ctx.assert.equal(ordinary.includes('office_from_template'), false, 'office templates should not preload on a rename')
    ctx.assert.equal(ordinary.includes('create_inline_visual'), false, 'visuals should not preload on a rename')

    const cached = adapter.filterModelToolsForRequest(
      [{ role: 'user', content: '检查前端 UI 截图并生成一张海报' }],
      {
        modelConfig: { apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', provider: 'qwen' },
        modelId: 'qwen3-coder-plus',
        promptCache: true
      }
    ).map(tool => tool.function?.name)
    ctx.assert.equal(cached.includes('generate_image'), false, 'cache-stable core must not dump media tools just because the prompt mentioned them')
    ctx.assert.ok(cached.includes('search_tools'), 'cache-stable core still exposes the loader')

    const loaded = []
    const harnessEvents = []
    const search = await handlers.search_tools({ query: '出图' }, {})
    ctx.assert.equal(search.success, true)
    ctx.assert.ok(search.packs.some(pack => pack.id === 'media'), 'search should find the media pack')
    ctx.assert.equal(search.harness_catalog.catalog, 'lingxi-capability-catalog-v1')
    ctx.assert.ok(
      search.harness_catalog.stable_capabilities.some(item => item.id === 'image_generation'),
      'search should return stable capabilities alongside cold packs'
    )

    const load = await handlers.search_tools({ action: 'load', pack: 'media' }, {
      options: {
        enableToolPack: id => loaded.push(id),
        recordHarnessEvent: (type, payload) => harnessEvents.push({ type, payload })
      }
    })
    ctx.assert.equal(load.success, true)
    ctx.assert.equal(load.loaded, 'media')
    ctx.assert.deepEqual(loaded, ['media'])
    ctx.assert.ok(load.tools.includes('generate_image'))
    ctx.assert.equal(load.harness_catalog.catalog, 'lingxi-capability-catalog-v1')
    ctx.assert.equal(load.harness_catalog.loaded, 'media')
    ctx.assert.equal(load.harness_catalog.persistent, true)
    ctx.assert.ok(load.tool_specs.some(tool => tool.name === 'generate_image'))
    ctx.assert.deepEqual(harnessEvents.map(event => event.type), ['capability_pack_loaded'])
    ctx.assert.equal(harnessEvents[0].payload.packId, 'media')

    const afterLoad = adapter.filterModelToolsForRequest(
      [{ role: 'user', content: '把这段函数重命名一下' }],
      { adaptiveToolVisibility: true, enabledPacks: loaded }
    ).map(tool => tool.function?.name)
    ctx.assert.ok(afterLoad.includes('generate_image'), 'loading media should expose image generation for the rest of the turn')

    const packs = capabilityTiers.searchToolPacks('')
    ctx.assert.ok(packs.every(pack => pack.id !== 'always'), 'the loader must not treat the core pack as optional')

    const workspace = ctx.createWorkspace('capability-state')
    try {
      const firstInstance = { storagePath: workspace.storagePath }
      capabilityState.enableToolPack(firstInstance, 'media')
      const nextInstance = { storagePath: workspace.storagePath }
      ctx.assert.deepEqual(
        capabilityState.getLoadedPacks(nextInstance),
        ['media'],
        'loaded tool packs must survive a new project instance/request'
      )
      ctx.assert.ok(
        MODEL_TOOLS_SCHEMA.some(tool => tool.function?.name === 'capability_discover'),
        'capability_discover must be a stable model-visible entry'
      )
      const discovered = await handlers.capability_discover(
        { query: '生成一张产品主视觉' },
        { modelConfig: { capabilities: { text: true, toolCalling: true } } }
      )
      ctx.assert.ok(
        discovered.capabilities.some(item => item.id === 'image_generation'),
        'capability discovery should understand natural-language image-generation intent'
      )
      ctx.assert.equal(discovered.harness_catalog.catalog, 'lingxi-capability-catalog-v1')
      ctx.assert.ok(
        discovered.harness_catalog.stable_capabilities.some(item => item.id === 'image_generation'),
        'capability discovery should expose the same stable catalog'
      )
    } finally {
      workspace.cleanup()
    }
  }
}
