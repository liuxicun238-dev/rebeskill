const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'gemini-web-bridge.contract',
  title: 'Gemini web bridge is wired as an isolated OpenAI-compatible local page model',
  tags: ['web-bridge', 'gemini', 'models'],
  changedFilePatterns: [
    new RegExp('^electron/modules/gemini-web-bridge\\.js$', 'i'),
    new RegExp('^electron/modules/gemini-direct-gateway\\.js$', 'i'),
    new RegExp('^electron/modules/(ipc|model-api-adapter|capability-tiers|web-bridge-search|web-bridge-chrome-profile|web-bridge-coding-protocol|web-bridge-page-model|ai-chat)\\.js$', 'i'),
    new RegExp('^electron/preload\\.js$', 'i'),
    new RegExp('^frontend/index\\.html$', 'i'),
    new RegExp('^frontend/scripts/features/(gemini-web-bridge-settings|web-bridge-search-settings|web-bridge-page-prefs)\\.js$', 'i')
  ],

  async run(ctx) {
    const bridgePath = path.join(ctx.root, 'electron/modules/gemini-web-bridge.js')
    const bridgeText = fs.readFileSync(bridgePath, 'utf8')
    const bridge = require(bridgePath)
    ctx.assert.equal(bridge.authUserFromPageUrl('https://gemini.google.com/u/3/app/abc'), '3')

    ctx.assert.ok(bridgeText.includes("const GEMINI_URL = 'https://gemini.google.com/u/1/app?pli=1'"))
    ctx.assert.ok(bridgeText.includes("const DEFAULT_PORT = 3224"), 'Gemini bridge must own a unique local port')
    ctx.assert.ok(bridgeText.includes("const AUTOMATION_DEBUG_PORT = 19334"), 'Gemini automation must own a unique debug port')
    ctx.assert.ok(bridgeText.includes("provider: 'gemini-web-bridge'"))
    ctx.assert.ok(bridgeText.includes('const modelId = geminiDirectGateway.directModelForPrefs(pagePrefs)'))
    ctx.assert.ok(bridgeText.includes("transportMode: saved.transportMode === 'direct' ? 'direct' : 'browser'"))
    ctx.assert.ok(bridgeText.includes('geminiDirectGateway.proxyChat'), '3224 must internally route direct mode without a second model entry')
    ctx.assert.ok(bridgeText.includes("apiFormat: 'openai'"), 'local webpage gateway must not be mistaken for the native Gemini API')
    ctx.assert.ok(bridgeText.includes('[role="textbox"][contenteditable="true"][aria-label*="Gemini"]'))
    ctx.assert.ok(bridgeText.includes("'model-response'"), 'reply harvesting must target Gemini response turns')
    ctx.assert.ok(bridgeText.includes('gemini.google.com'), 'only the Gemini web origin should be reused')
    ctx.assert.ok(bridgeText.includes('WEB_BRIDGE_DIALECT_JSON_FENCE'), 'Gemini lingxi mode must use JSON fence protocol')
    ctx.assert.ok(
      /assembleWebPagePrompt\(\{[\s\S]*dialect:\s*WEB_BRIDGE_DIALECT_JSON_FENCE/.test(bridgeText),
      'Gemini page prompts must always pass json-fence dialect'
    )
    ctx.assert.ok(bridgeText.includes('pageLooksLikeMissingWebConversation'), 'deleted Gemini chats must be detected')
    ctx.assert.ok(bridgeText.includes('openFreshGeminiConversation') || bridgeText.includes('clearPersistedConversation'), 'deleted chats must open a fresh conversation')
    ctx.assert.ok(!/灵犀没有新建其他对话/.test(bridgeText), 'must not refuse to open a new chat after a deleted thread')

    const protocol = require(path.join(ctx.root, 'electron/modules/web-bridge-coding-protocol'))
    ctx.assert.equal(protocol.looksLikeMissingWebConversation('无法加载此对话。对话不存在或已被删除。'), true)
    ctx.assert.equal(protocol.looksLikeMissingWebConversation('普通回复内容'), false)
    const forgotten = protocol.forgetSavedConversation({
      s1: { url: 'https://gemini.google.com/app/abc', projectId: 'p1', lane: 'lingxi', updatedAt: 1 }
    }, { url: 'https://gemini.google.com/app/abc' })
    ctx.assert.equal(Object.keys(forgotten).length, 0)
    const directGlob = protocol.normalizeWebToolCallArgs('file_search', {
      action: 'glob',
      path: '**/*playerMotion*'
    }, { projectPath: 'D:/页面测试', direct: true })
    ctx.assert.equal(directGlob.path, 'D:/页面测试')
    ctx.assert.equal(directGlob.pattern, '**/*playerMotion*')
    const directRead = protocol.normalizeWebToolCallArgs('file_read', {
      action: 'one',
      path: '页面测试/src/game/scenes/PlayScene.ts'
    }, { projectPath: 'D:/页面测试', direct: true })
    ctx.assert.equal(directRead.path, 'src/game/scenes/PlayScene.ts')

    const delta = bridge.extractReplyDelta(
      { count: 2, markdown: 'Gemini answer', innerText: 'Gemini answer' },
      { count: 1, markdown: 'old answer', innerText: 'old answer' }
    )
    ctx.assert.equal(delta.markdown, 'Gemini answer')

    const capability = require(path.join(ctx.root, 'electron/modules/capability-tiers'))
    ctx.assert.equal(
      capability.isChatGptWebBridgeModel({ provider: 'gemini-web-bridge', modelId: 'gemini-web-chat' }),
      true,
      'Gemini webpage model must use the restricted webpage tool tier'
    )

    const adapterText = fs.readFileSync(path.join(ctx.root, 'electron/modules/model-api-adapter.js'), 'utf8')
    ctx.assert.ok(adapterText.includes("provider === 'gemini-web-bridge'"))
    ctx.assert.ok(adapterText.includes("require('./gemini-web-bridge').getSuggestedChatModel()"))
    ctx.assert.ok(adapterText.includes('127\\.0\\.0\\.1:3224'), 'port-only imported configs must still receive bridge session headers')

    const ipcText = fs.readFileSync(path.join(ctx.root, 'electron/modules/ipc.js'), 'utf8')
    const preloadText = fs.readFileSync(path.join(ctx.root, 'electron/preload.js'), 'utf8')
    ctx.assert.ok(ipcText.includes("require('./gemini-web-bridge')"))
    ctx.assert.ok(ipcText.includes('geminiWebBridge.registerIPC(observedIpcMain)'))
    ctx.assert.ok(preloadText.includes("ipcRenderer.invoke('gemini-web-bridge:status')"))
    ctx.assert.ok(preloadText.includes("ipcRenderer.invoke('gemini-web-bridge:open-login')"))
    ctx.assert.ok(preloadText.includes("ipcRenderer.invoke('gemini-web-bridge:set-transport-mode'"))

    const direct = require(path.join(ctx.root, 'electron/modules/gemini-direct-gateway'))
    ctx.assert.equal(direct.directModelForPrefs({ pageModel: 'flash-lite', thinkingEnabled: false }), 'gemini-3.5-flash-lite')
    ctx.assert.equal(direct.directModelForPrefs({ pageModel: 'flash-3.6', thinkingEnabled: true }), 'gemini-3.6-flash')
    ctx.assert.equal(direct.directModelForPrefs({ pageModel: 'flash-3.7', thinkingEnabled: true }), 'gemini-3.7-flash')
    ctx.assert.equal(direct.directModelForPrefs({ pageModel: 'pro', thinkingEnabled: true }), 'gemini-3.1-pro')
    ctx.assert.equal(direct.directBody({}, { pageModel: 'pro', thinkingEnabled: true }).reasoning_effort, 'adaptive')
    ctx.assert.equal(direct.DIRECT_PORT, 3410)
    ctx.assert.ok(direct.gatewayRootCandidates().some(root => /gemini-agent-api-gateway$/i.test(root)))
    const packagedGatewayRoot = path.join(ctx.root, 'services', 'gemini-agent-api-gateway')
    ctx.assert.ok(fs.existsSync(path.join(packagedGatewayRoot, 'src', 'index.js')), 'the installable app must carry the generic gateway source')
    ctx.assert.ok(fs.existsSync(path.join(packagedGatewayRoot, 'src', 'admin', 'index.html')), 'the generic gateway must ship an admin UI')
    ctx.assert.ok(fs.existsSync(direct.getGatewayEntry(packagedGatewayRoot)), 'the bundled or source gateway entry must be resolvable')

    const profile = require(path.join(ctx.root, 'electron/modules/web-bridge-chrome-profile'))
    ctx.assert.ok(profile.DEFAULT_SEARCH_PROVIDER_ORDER.includes('gemini'))
    ctx.assert.ok(profile.listSharedWebBridgeDebugPorts().includes(19334))

    const searchText = fs.readFileSync(path.join(ctx.root, 'electron/modules/web-bridge-search.js'), 'utf8')
    ctx.assert.ok(searchText.includes("{ id: 'gemini', label: 'Gemini 网页版'"))

    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const settings = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/gemini-web-bridge-settings.js'), 'utf8')
    ctx.assert.ok(html.includes('id="geminiWebBridgeCard"'))
    ctx.assert.ok(html.includes('http://127.0.0.1:3224/v1'))
    ctx.assert.ok(html.includes('gemini-web-bridge-settings.js'))
    ctx.assert.ok(settings.includes('getGeminiWebBridgeSuggestedChatModel'))
    ctx.assert.ok(settings.includes('setGeminiWebBridgePagePrefs'))
    ctx.assert.ok(html.includes('id="geminiWebBridgePageModel"'))
    ctx.assert.ok(html.includes('id="geminiWebBridgeThinkingEnabled"'))
    ctx.assert.ok(html.includes('id="geminiWebBridgeBrowserModeToggle"'))
    ctx.assert.ok(html.includes('id="geminiWebBridgeTransportNote"'))
    ctx.assert.ok(html.includes('3.7 Flash'))
    ctx.assert.ok(html.includes('扩展思考'))
    ctx.assert.ok(html.includes('web-bridge-picker-menu'))
    ctx.assert.ok(html.includes('擅长解决复杂问题'))
    ctx.assert.ok(!/<select[^>]*id="geminiWebBridgePageModel"/.test(html), 'Gemini model picker must not be a native select')
    const protocolText = fs.readFileSync(path.join(ctx.root, 'electron/modules/web-bridge-coding-protocol.js'), 'utf8')
    ctx.assert.ok(protocolText.includes('buildWebBridgeInspectKeepGoingPrompt'), 'Gemini json-fence must keep reading source after config files')
    ctx.assert.ok(protocolText.includes('package.json、README'), 'inspect continuation must not treat package.json as enough evidence')
    ctx.assert.ok(html.includes('web-bridge-page-prefs.js'))
    ctx.assert.ok(!html.includes('<select class="settings-input web-bridge-page-pref-select" id="geminiWebBridgePageModel"'))
    ctx.assert.ok(bridgeText.includes('applyGeminiPageModel'), 'Gemini must apply the selected page model before sending')
    ctx.assert.ok(bridgeText.includes('dropRepeatedWebBridgeSearchCalls'), 'Gemini must drop repeated file_search loops')
    const aiChatText = fs.readFileSync(path.join(ctx.root, 'electron/modules/ai-chat.js'), 'utf8')
    ctx.assert.ok(aiChatText.includes('const stageProgressToolCount = geminiDirectTransport'), 'Gemini direct stages must count successful progress instead of repeated failures')
    ctx.assert.ok(aiChatText.includes("getStatus().transportMode === 'direct'"), 'Gemini direct stage accounting must stay scoped to direct transport')
    ctx.assert.ok(
      aiChatText.includes('!geminiDirectTransport && (toolFailureRecovery.isStopRequested()'),
      'Gemini direct must use advisory recovery instead of inheriting the API-model hard tool-loop stop'
    )
    ctx.assert.ok(
      aiChatText.includes("error_type: 'gemini_direct_shell_write_blocked'"),
      'Gemini direct must keep source writes in tracked edit tools instead of shell redirection or scripts'
    )
    ctx.assert.ok(
      aiChatText.includes('buildGeminiDirectCompletionGatePrompt'),
      'Gemini direct edit tasks must not finalize before a successful tracked write and verification'
    )
    ctx.assert.ok(
      aiChatText.includes('looksLikeGeminiDirectMutationTask'),
      'Gemini direct mutation intent must cover fixes and refactors, not only legacy page creation tasks'
    )
    ctx.assert.ok(
      aiChatText.includes('geminiDirectTransport && geminiDirectCompletionGateAttempts < 8'),
      'the completion evidence gate must stay isolated from browser bridges and ordinary API models'
    )
    ctx.assert.ok(
      aiChatText.includes('skipWebBridgeToolFilter: geminiDirectTransport'),
      'Gemini direct must send the same adaptive request-time tools as API models'
    )
    ctx.assert.ok(
      aiChatText.includes('isChatGptWebBridgeModel(modelConfig, effectiveModelId) && !geminiDirectTransport'),
      'Gemini direct must not inherit browser prompt assembly or browser-only stage routing'
    )
    ctx.assert.ok(preloadText.includes('gemini-web-bridge:set-page-prefs'))
    ctx.assert.ok(settings.includes('gemini.google.com'))
    ctx.assert.ok(settings.includes('setGeminiWebBridgeTransportMode'))
    ctx.assert.ok(settings.includes('isLegacyDirectModel'), 'legacy 3310 duplicate model entries must be merged')
    ctx.assert.ok(settings.includes('currentApiUrl !== expectedApiUrl'), 'the unified Gemini model must follow the bridge runtime URL when its development or saved port changes')
    ctx.assert.equal(/chat\.gemini\.ai|通义千问/.test(settings), false, 'Gemini settings must not retain Qwen copy text')
  }
}
