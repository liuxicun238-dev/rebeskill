const fs = require('fs')
const path = require('path')
const vm = require('vm')

module.exports = {
  id: 'model-context.user-configured-window',
  title: 'A user-configured model context window overrides the unknown-model default',
  tags: ['context', 'models', 'settings', 'context-compression'],
  changedFilePatterns: [
    /^electron\/modules\/model-context-policy\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/preload\.js$/i,
    /^frontend\/index\.html$/i,
    /^frontend\/scripts\/app\.js$/i,
    /^frontend\/scripts\/features\/(?:models|settings-main|quick-model-settings|context-status-poller|project-switcher)\.js$/i
  ],

  async run(ctx) {
    const policy = require(path.join(ctx.root, 'electron/modules/model-context-policy'))
    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const modelsSource = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/models.js'), 'utf8')
    const settingsSource = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/settings-main.js'), 'utf8')
    const quickSource = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/quick-model-settings.js'), 'utf8')
    const appSource = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/app.js'), 'utf8')
    const pollerSource = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/context-status-poller.js'), 'utf8')
    const switcherSource = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/project-switcher.js'), 'utf8')
    const preloadSource = fs.readFileSync(path.join(ctx.root, 'electron/preload.js'), 'utf8')
    const chatSource = fs.readFileSync(path.join(ctx.root, 'electron/modules/ai-chat.js'), 'utf8')

    const sandbox = {
      window: {},
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      console
    }
    vm.createContext(sandbox)
    vm.runInContext(modelsSource, sandbox)
    const normalizedModel = sandbox.window.ModelStore.normalizeModel({
      modelId: 'brand-new-unknown-model',
      contextWindow: '750000'
    })
    ctx.assert.equal(normalizedModel.contextWindow, 750000, 'the configured window must survive model normalization')
    sandbox.window.ModelStore.addModel(normalizedModel)
    const liveModelList = sandbox.window.ModelStore.getModels()
    await sandbox.window.ModelStore.save()
    ctx.assert.equal(
      sandbox.window.ModelStore.getModels(),
      liveModelList,
      'saving must not leave project model lookups holding a stale model-list object'
    )
    ctx.assert.equal(liveModelList[0].contextWindow, 750000)

    ctx.assert.equal(policy.resolveModelContextLimit('brand-new-unknown-model'), 128000)
    ctx.assert.equal(policy.resolveModelContextLimit('brand-new-unknown-model', 750000), 750000)
    ctx.assert.equal(policy.resolveConfiguredModelContextLimit(
      { modelName: 'grok-4.6' },
      [{ modelKey: 'grok-key', modelName: 'grok-4.6', modelId: 'grok-4.6', contextWindow: 500000 }],
      { modelKey: 'grok-key' }
    ), 500000, 'the persisted model window must repair a stale status descriptor')
    const budget = policy.buildContextBudget('brand-new-unknown-model', 750000)
    ctx.assert.equal(budget.maxContextTokens, 750000)
    ctx.assert.ok(budget.inputBudgetTokens > 128000, 'the configured limit must change the compression budget')

    const primaryDetails = html.match(/<details[^>]*id="settingsModelAdvanced"[^>]*>/i)?.[0] || ''
    const quickDetails = html.match(/<details[^>]*id="modelAdvanced"[^>]*>/i)?.[0] || ''
    ctx.assert.ok(primaryDetails, 'the primary model editor must expose advanced settings')
    ctx.assert.ok(quickDetails, 'the quick model editor must expose advanced settings')
    ctx.assert.equal(/\sopen(?:\s|=|>)/i.test(primaryDetails), false, 'primary advanced settings must be collapsed by default')
    ctx.assert.equal(/\sopen(?:\s|=|>)/i.test(quickDetails), false, 'quick advanced settings must be collapsed by default')
    ctx.assert.match(html, /id="settingsContextWindow"[\s\S]*min="16000"[\s\S]*max="100000000"/)
    ctx.assert.match(modelsSource, /nextModel\.contextWindow\s*=\s*Math\.floor\(contextWindow\)/)
    ctx.assert.match(settingsSource, /modelPatch\s*=\s*\{[^}]*contextWindow/)
    ctx.assert.match(quickSource, /const model\s*=\s*\{[^}]*contextWindow/)
    ctx.assert.match(chatSource, /buildContextBudget\([\s\S]*modelConfig\.contextWindow\s*\|\|\s*modelConfig\.contextLength\s*\|\|\s*modelConfig\.maxContextTokens/)
    ctx.assert.match(appSource, /function getProjectContextDescriptor\([\s\S]*contextWindow:/)
    ctx.assert.match(settingsSource, /lingxi:model-changed/)
    ctx.assert.match(modelsSource, /models\.splice\(0, models\.length, \.\.\.normalizedModels\)/)
    ctx.assert.match(pollerSource, /getContextStatus\(project\.id, modelDescriptor\)/)
    ctx.assert.match(switcherSource, /getContextStatus\(project\.id, modelDescriptor\)/)
    ctx.assert.match(preloadSource, /getContextStatus:\s*\(projectId, modelDescriptor = null\)/)
    ctx.assert.match(chatSource, /resolveModelContextLimit\(modelName, configuredLimit\)/)
  }
}
