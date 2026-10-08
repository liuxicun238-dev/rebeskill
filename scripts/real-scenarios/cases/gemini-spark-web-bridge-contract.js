const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'gemini-spark-web-bridge.contract',
  title: 'Gemini Spark Agent is a separate remote-agent lane, not the Gemini chat web bridge',
  tags: ['web-bridge', 'gemini', 'spark', 'models'],
  changedFilePatterns: [
    new RegExp('^electron/modules/gemini-spark-web-bridge\\.js$', 'i'),
    new RegExp('^electron/modules/gemini-spark-task\\.js$', 'i'),
    new RegExp('^electron/modules/(ipc|model-api-adapter|capability-tiers|web-bridge-search|web-bridge-chrome-profile|ai-chat|worker-model)\\.js$', 'i'),
    new RegExp('^electron/preload\\.js$', 'i'),
    new RegExp('^frontend/index\\.html$', 'i'),
    new RegExp('^frontend/scripts/features/gemini-spark-web-bridge-settings\\.js$', 'i')
  ],

  async run(ctx) {
    const root = ctx.root
    const sparkPath = path.join(root, 'electron/modules/gemini-spark-web-bridge.js')
    const sparkText = fs.readFileSync(sparkPath, 'utf8')
    const spark = require(sparkPath)
    const task = require(path.join(root, 'electron/modules/gemini-spark-task'))

    ctx.assert.ok(sparkText.includes("const SPARK_URL = 'https://gemini.google.com/u/1/spark?pli=1'"))
    ctx.assert.ok(sparkText.includes('const DEFAULT_PORT = 3225'), 'Spark must own a unique local port')
    ctx.assert.ok(sparkText.includes('const AUTOMATION_DEBUG_PORT = 19335'), 'Spark automation must own a unique debug port')
    ctx.assert.ok(sparkText.includes("provider: 'gemini-spark-web-bridge'"))
    ctx.assert.ok(sparkText.includes("modelId: 'gemini-spark-agent'"))
    ctx.assert.ok(sparkText.includes("apiFormat: 'openai'"))
    ctx.assert.ok(sparkText.includes('toolCalling: false'))
    ctx.assert.ok(sparkText.includes("lane: 'spark-agent'"))
    ctx.assert.ok(sparkText.includes('ACCOUNT_VALIDATION'))
    ctx.assert.ok(sparkText.includes('COMPOSER_NOT_READY'))
    ctx.assert.ok(sparkText.includes('ensureSparkComposer'))
    ctx.assert.ok(!sparkText.includes('WEB_BRIDGE_DIALECT_JSON_FENCE'), 'Spark must not reuse the chat JSON-fence protocol')
    ctx.assert.ok(!sparkText.includes('<LINGXI_TOOL_CALLS>'), 'Spark must not inject Lingxi tool XML')
    ctx.assert.equal(spark.SPARK_URL, 'https://gemini.google.com/u/1/spark?pli=1')
    ctx.assert.equal(spark.DEFAULT_PORT, 3225)
    ctx.assert.equal(spark.AUTOMATION_DEBUG_PORT, 19335)
    ctx.assert.equal(spark.isSparkPageUrl('https://gemini.google.com/u/1/spark?pli=1'), true)
    ctx.assert.equal(spark.isSparkPageUrl('https://gemini.google.com/u/1/app?pli=1'), false)
    ctx.assert.equal(spark.isSparkPageUrl('https://gemini.google.com/app'), false)

    ctx.assert.equal(
      task.extractSparkUserTask({
        messages: [
          { role: 'system', content: '【内部工作流指令】不要告诉用户' },
          { role: 'user', content: '请给 README 加一行说明' },
          { role: 'assistant', content: '<LINGXI_TOOL_CALLS>[{"name":"write_file"}]</LINGXI_TOOL_CALLS>' },
          { role: 'user', content: '改成中文摘要' }
        ]
      }),
      '改成中文摘要'
    )
    ctx.assert.equal(
      task.stripLingxiProtocol('任务\n<LINGXI_TOOL_CALLS>{"calls":[]}</LINGXI_TOOL_CALLS>\n【内部工作流指令】隐藏'),
      '任务'
    )
    ctx.assert.equal(task.looksLikeGoogleAccountValidation('无法验证我的信息'), true)
    ctx.assert.equal(task.looksLikeGoogleAccountValidation('Verify your account to continue'), true)
    ctx.assert.equal(task.classifySparkPageAccess({
      url: 'https://gemini.google.com/u/1/spark',
      composerFound: false
    }).code, 'COMPOSER_NOT_READY')
    ctx.assert.equal(task.classifySparkPageAccess({
      url: 'https://accounts.google.com/signin',
      composerFound: false,
      loginVisible: true
    }).code, 'LOGIN_REQUIRED')
    ctx.assert.equal(task.classifySparkPageAccess({
      url: 'https://gemini.google.com/u/1/spark',
      composerFound: true,
      loginVisible: true
    }).code, '')
    ctx.assert.equal(task.isGoogleLoginUrl('https://accounts.google.com/signin/continue'), true)
    ctx.assert.equal(task.isGoogleLoginUrl('https://gemini.google.com/u/1/spark'), false)
    ctx.assert.ok(task.buildSparkAgentPrompt({ userText: '修 lint', projectPath: 'E:/proj' }).includes('修 lint'))
    ctx.assert.ok(task.buildSparkAgentPrompt({ userText: '修 lint', projectPath: 'E:/proj' }).includes('E:/proj'))
    ctx.assert.ok(!task.buildSparkAgentPrompt({ userText: '<LINGXI_FINAL>x</LINGXI_FINAL>修 lint' }).includes('<LINGXI_FINAL>'))

    const chatBridgeText = fs.readFileSync(path.join(root, 'electron/modules/gemini-web-bridge.js'), 'utf8')
    ctx.assert.ok(chatBridgeText.includes("const GEMINI_URL = 'https://gemini.google.com/u/1/app?pli=1'"))
    ctx.assert.ok(chatBridgeText.includes('const DEFAULT_PORT = 3224'))
    ctx.assert.ok(chatBridgeText.includes('const AUTOMATION_DEBUG_PORT = 19334'))

    const capability = require(path.join(root, 'electron/modules/capability-tiers'))
    ctx.assert.equal(
      capability.isChatGptWebBridgeModel({ provider: 'gemini-spark-web-bridge', modelId: 'gemini-spark-agent' }),
      false,
      'Spark must not enter the webpage Lingxi tool loop'
    )
    ctx.assert.equal(
      capability.isGeminiSparkAgentModel({ provider: 'gemini-spark-web-bridge', modelId: 'gemini-spark-agent' }),
      true
    )
    ctx.assert.equal(
      capability.isGeminiSparkAgentModel({ provider: 'gemini-web-bridge', modelId: 'gemini-web-chat' }),
      false
    )
    ctx.assert.equal(
      capability.isChatGptWebBridgeModel({ provider: 'gemini-web-bridge', modelId: 'gemini-web-chat' }),
      true,
      'Gemini chat webpage model must keep the restricted webpage tool tier'
    )

    const adapterText = fs.readFileSync(path.join(root, 'electron/modules/model-api-adapter.js'), 'utf8')
    ctx.assert.ok(adapterText.includes("provider === 'gemini-spark-web-bridge'"))
    ctx.assert.ok(adapterText.includes("require('./gemini-spark-web-bridge').getSuggestedAgentModel()"))
    ctx.assert.ok(adapterText.includes('127\\.0\\.0\\.1:3225') || adapterText.includes(':3225(?:\\/|$)') || adapterText.includes('/:3225(?:\\/|$)/'))
    ctx.assert.ok(adapterText.includes("headers['x-lingxi-bridge-mode'] = 'spark-agent'"))
    ctx.assert.ok(adapterText.includes('encodeSparkProjectPathHeader'))
    ctx.assert.ok(adapterText.includes('attachSparkAgentMetadata'))
    ctx.assert.ok(adapterText.includes('isGeminiSparkAgentModel(options.modelConfig'))

    const chinesePath = 'E:\\灵犀-11\\测试'
    const encodedPath = task.encodeSparkProjectPathHeader(chinesePath)
    ctx.assert.equal(task.isHttpHeaderByteString(chinesePath), false)
    ctx.assert.equal(task.isHttpHeaderByteString(encodedPath), true)
    ctx.assert.equal(task.decodeSparkProjectPathHeader(encodedPath), chinesePath)
    ctx.assert.equal(task.resolveSparkProjectPath({ headerValue: encodedPath, metadataPath: '' }), chinesePath)
    ctx.assert.equal(task.resolveSparkProjectPath({ headerValue: encodedPath, metadataPath: 'E:\\from-body' }), 'E:\\from-body')
    const { Headers } = require('undici')
    try {
      new Headers({ 'x-lingxi-project-path': chinesePath })
      ctx.assert.ok(false, 'raw Chinese project path must be rejected by HTTP Headers')
    } catch (error) {
      ctx.assert.ok(/ByteString|greater than 255/i.test(String(error?.message || error)))
    }
    new Headers({ 'x-lingxi-project-path': encodedPath })

    const aiChatText = fs.readFileSync(path.join(root, 'electron/modules/ai-chat.js'), 'utf8')
    ctx.assert.ok(aiChatText.includes('isGeminiSparkAgentModel'))
    ctx.assert.ok(aiChatText.includes('includeTools: !isGeminiSparkAgentModel'))
    ctx.assert.ok(aiChatText.includes('projectPath,'))

    const ipcText = fs.readFileSync(path.join(root, 'electron/modules/ipc.js'), 'utf8')
    const preloadText = fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8')
    ctx.assert.ok(ipcText.includes("require('./gemini-spark-web-bridge')"))
    ctx.assert.ok(ipcText.includes('geminiSparkWebBridge.registerIPC(observedIpcMain)'))
    ctx.assert.ok(preloadText.includes("ipcRenderer.invoke('gemini-spark-web-bridge:status')"))
    ctx.assert.ok(preloadText.includes("ipcRenderer.invoke('gemini-spark-web-bridge:open-login')"))
    ctx.assert.ok(preloadText.includes("ipcRenderer.invoke('gemini-spark-web-bridge:suggested-agent-model')"))

    const profile = require(path.join(root, 'electron/modules/web-bridge-chrome-profile'))
    ctx.assert.ok(profile.listSharedWebBridgeDebugPorts().includes(19335))
    ctx.assert.ok(profile.listSharedWebBridgeDebugPorts().includes(19334))

    const searchText = fs.readFileSync(path.join(root, 'electron/modules/web-bridge-search.js'), 'utf8')
    ctx.assert.equal(/gemini-spark/.test(searchText), false, 'Spark must not be added to webpage search providers')

    const workerText = fs.readFileSync(path.join(root, 'electron/modules/worker-model.js'), 'utf8')
    ctx.assert.ok(workerText.includes('isGeminiSparkAgentModel'))

    const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8')
    const settings = fs.readFileSync(path.join(root, 'frontend/scripts/features/gemini-spark-web-bridge-settings.js'), 'utf8')
    ctx.assert.ok(html.includes('id="geminiSparkWebBridgeCard"'))
    ctx.assert.ok(html.includes('http://127.0.0.1:3225/v1'))
    ctx.assert.ok(html.includes('http://127.0.0.1:3224/v1'))
    ctx.assert.ok(html.includes('gemini-spark-web-bridge-settings.js'))
    ctx.assert.ok(settings.includes('getGeminiSparkWebBridgeSuggestedAgentModel'))
    ctx.assert.ok(settings.includes('gemini.google.com/spark'))
    ctx.assert.equal(/gemini-web-chat|添加网页版聊天模型/.test(settings), false, 'Spark settings must add the agent model, not the chat model')
  }
}
