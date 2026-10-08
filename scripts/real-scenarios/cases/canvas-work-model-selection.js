const fs = require('fs')
const path = require('path')
const vm = require('vm')

function loadCanvasWorkflows(root, models) {
  function CustomEvent(type, init) {
    this.type = type
    this.detail = init && init.detail
  }
  const sandbox = {
    window: {
      ModelStore: {
        getModels: () => models,
        getCurrentModel: () => models[0],
        getModelKey: model => String(model?.modelKey || '').trim()
          || [model?.provider, model?.apiUrl, model?.modelId || model?.modelName, model?.modelName].filter(Boolean).join('::'),
        findModelIndexByKey: key => models.findIndex(model => String(model.modelKey || '') === String(key || '')),
        getModelAt: index => models[index] || null
      },
      ProjectStore: { getActiveProjectId: () => 'project-1' },
      CanvasWorkflowSaveQueue: {
        create: () => ({
          reset() {},
          markChanged() {},
          schedule() {},
          flush: async () => null
        })
      },
      api: {},
      ToastUI: { show() {} },
      CustomEvent,
      dispatchEvent() {},
      addEventListener() {}
    },
    document: { readyState: 'complete', addEventListener() {} },
    console,
    setTimeout,
    clearTimeout,
    CustomEvent
  }
  sandbox.window.CustomEvent = CustomEvent
  vm.createContext(sandbox)
  vm.runInContext(
    fs.readFileSync(path.join(root, 'frontend/scripts/features/canvas-workflows.js'), 'utf8'),
    sandbox
  )
  return sandbox.window.CanvasWorkflows
}

module.exports = {
  id: 'canvas-work.model-selection',
  title: 'Canvas work nodes keep an explicitly selected model instead of snapping back to follow-current',
  tags: ['canvas', 'workflow', 'models'],
  changedFilePatterns: [
    /^frontend\/scripts\/(?:canvas-view|features\/canvas-workflows|features\/canvas-inspector)\.js$/i,
    /^electron\/modules\/agent-workflow(?:s|-policy)\.js$/i
  ],

  async run(ctx) {
    const current = {
      modelKey: 'current-model',
      displayName: '当前模型',
      modelName: 'current',
      modelId: 'current',
      provider: 'openai',
      apiUrl: 'http://127.0.0.1:3000/v1'
    }
    const grok = {
      modelKey: 'grok-web-key',
      displayName: 'Grok',
      modelName: 'grok-web-chat',
      modelId: 'grok-web-chat',
      provider: 'grok-web-bridge',
      apiUrl: 'http://127.0.0.1:3219/v1'
    }
    const deepseek = {
      modelKey: 'deepseek-web-key',
      displayName: 'DeepSeek',
      modelName: 'deepseek-web-chat',
      modelId: 'deepseek-web-chat',
      id: 'legacy-deepseek-id',
      provider: 'deepseek-web-bridge',
      apiUrl: 'http://127.0.0.1:3218/v1'
    }
    const models = [current, grok, deepseek]
    const workflows = loadCanvasWorkflows(ctx.root, models)

    ctx.assert.equal(
      workflows.resolveModel({ modelKey: '' }, models, current)?.modelKey,
      'current-model',
      'empty modelKey should still follow the current model'
    )
    ctx.assert.equal(
      workflows.resolveModel({ modelKey: 'grok-web-key' }, models, current)?.modelKey,
      'grok-web-key',
      'an explicit official key must resolve to that model, not the current one'
    )
    ctx.assert.equal(
      workflows.resolveModel({ modelKey: 'legacy-deepseek-id' }, models, current)?.modelKey,
      'deepseek-web-key',
      'legacy id/name keys must still resolve instead of snapping back to follow-current'
    )
    ctx.assert.equal(
      workflows.resolveModel({ modelKey: 'deepseek-web-chat', modelName: 'DeepSeek' }, models, current)?.modelKey,
      'deepseek-web-key',
      'stored modelId should match the selected work-node model'
    )
    ctx.assert.equal(
      workflows.getNodeModelLabel({ modelKey: 'grok-web-key' }, models),
      'Grok',
      'canvas cards should show the selected model name rather than 跟随当前模型'
    )
    ctx.assert.equal(
      workflows.getNodeModelLabel({ modelKey: '', modelName: '' }, models),
      '',
      'follow-current nodes should not invent a model label'
    )

    const inspectorSource = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/canvas-inspector.js'), 'utf8')
    ctx.assert.ok(
      /data-field="modelKey"[\s\S]*addEventListener\('change'/.test(inspectorSource),
      'changing the work-node model dropdown should persist immediately'
    )
    ctx.assert.ok(
      /readWorkModelPatch/.test(inspectorSource),
      'saving a work node must keep the selected model key/name instead of clearing them'
    )

    const policy = require(path.join(ctx.root, 'electron/modules/agent-workflow-policy'))
    const longKey = `grok-web-bridge::http://127.0.0.1:3219/v1/${'x'.repeat(200)}::grok-web-chat::grok-web-chat`
    ctx.assert.ok(longKey.length > 180, 'composite model keys can exceed the old 180-character cap')
    ctx.assert.ok(
      policy.validateWorkflowPayload({ nodes: [{ id: 'work-1', modelKey: longKey }] }).valid,
      'workflow save should accept composite model keys instead of dropping them back to follow-current'
    )
  }
}
