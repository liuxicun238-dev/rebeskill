const { discoverDevelopmentBridges, fetchBridgeTargets, RemoteWebContents } = require('../electron/modules/development-runtime-bridge')

function parseArgs(argv = []) {
  const result = {
    prompt: '',
    timeoutMs: 180000,
    newSession: false,
    autoApprove: true,
    expectProject: 'D:\\页面测试',
    expectNoTools: false,
    expectTools: [],
    expectToolAnyGroups: [],
    expectFinalIncludes: '',
    expectThinking: false,
    expectModelId: 'gemini-web-chat',
    apiUrl: '',
    cancelRunning: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--prompt') result.prompt = String(argv[++index] || '')
    else if (item === '--timeout-ms') result.timeoutMs = Number(argv[++index]) || result.timeoutMs
    else if (item === '--new-session') result.newSession = true
    else if (item === '--no-auto-approve') result.autoApprove = false
    else if (item === '--project') result.expectProject = String(argv[++index] || result.expectProject)
    else if (item === '--expect-no-tools') result.expectNoTools = true
    else if (item === '--expect-tool') result.expectTools.push(String(argv[++index] || '').trim())
    else if (item === '--expect-tool-any') result.expectToolAnyGroups.push(String(argv[++index] || '').split(',').map(value => value.trim()).filter(Boolean))
    else if (item === '--expect-final-includes') result.expectFinalIncludes = String(argv[++index] || '')
    else if (item === '--expect-thinking') result.expectThinking = true
    else if (item === '--model-id') result.expectModelId = String(argv[++index] || result.expectModelId)
    else if (item === '--api-url') result.apiUrl = String(argv[++index] || '').trim()
    else if (item === '--cancel-running') result.cancelRunning = true
  }
  if (!result.prompt.trim() && !result.cancelRunning) throw new Error('--prompt is required')
  return result
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function javascript(value) {
  return `(${value.toString()})()`
}

async function connectRuntime() {
  const bridges = discoverDevelopmentBridges()
  if (bridges.length !== 1) throw new Error(`Expected one live Lingxi development bridge, found ${bridges.length}`)
  const targets = await fetchBridgeTargets(bridges[0])
  const target = targets.find(item => item.runtime_id === 'runtime-lingxi-main')
  if (!target) throw new Error('Lingxi main renderer target was not found')
  return new RemoteWebContents(bridges[0], target, target.web_contents_id)
}

async function readState(runtime) {
  return runtime.executeJavaScript(javascript(() => {
    const project = window.getActiveProject?.() || null
    const models = window.ModelStore?.getModels?.() || []
    const projectModel = project?.modelKey
      ? models.find(model => window.ModelStore?.getModelKey?.(model) === project.modelKey)
      : window.ModelStore?.getCurrentModel?.()
    const popup = document.getElementById('aiAskPopup')
    const chat = document.getElementById('chatMessages')
    const messages = Array.from(chat?.querySelectorAll?.('.message') || [])
    const aiMessages = messages.filter(node => node.classList.contains('ai'))
    const latestAi = aiMessages[aiMessages.length - 1] || null
    const toolNodes = aiMessages.flatMap(node => Array.from(node.querySelectorAll?.('[data-tool-name], .tool-call, .tool-card, .ai-tool-item') || []))
    const thinkingNodes = aiMessages.flatMap(node => Array.from(node.querySelectorAll?.('.ai-thinking-block, .ai-deep-reasoning-content, .thinking-block, .thinking-content, .ai-thinking, .thinking-section, .work-detail-content') || []))
    const mediaNodes = aiMessages.flatMap(node => Array.from(node.querySelectorAll?.('img, video, audio, [data-asset-path], [data-media-url]') || []))
    const history = Array.isArray(project?.messagesHistory) ? project.messagesHistory : []
    const historyToolCalls = history.flatMap(item => (
      Array.isArray(item?.tool_calls)
        ? item.tool_calls.map(call => ({
            id: String(call?.id || call?.call_id || ''),
            name: String(call?.function?.name || call?.name || '')
          })).filter(call => call.name)
        : []
    ))
    const historyThinking = history.map(item => String(item?.reasoning_content || item?.reasoning || '').trim()).filter(Boolean)
    const latestFinal = [...history].reverse().find(item => item?.role === 'assistant' && typeof item?.content === 'string' && item.content.trim())
    const latestAssistant = [...history].reverse().find(item => item?.role === 'assistant')
    const runtimeToolEvents = Array.isArray(window.__geminiDirectE2EToolEvents)
      ? window.__geminiDirectE2EToolEvents
      : []
    return {
      project: project ? {
        id: project.id,
        path: project.path,
        isRunning: project.isRunning === true,
        chatSessionId: project.chatSessionId || 'main',
        chatSessionTitle: project.chatSessionTitle || '',
        modelId: String(projectModel?.modelId || projectModel?.model || ''),
        modelName: String(projectModel?.modelName || projectModel?.modelId || ''),
        historyLength: Array.isArray(project.history) ? project.history.length : 0,
        messagesHistoryLength: Array.isArray(project.messagesHistory) ? project.messagesHistory.length : 0,
        progressPhase: String(project.progressPhase || ''),
        progressStepIndex: Number(project.progressStepIndex) || 0,
        progressStepCount: Array.isArray(project.progressSteps) ? project.progressSteps.length : 0,
        finalText: String(latestFinal?.content || '').slice(0, 12000),
        latestAssistantError: latestAssistant?.error
          ? String(latestAssistant?.content || latestAssistant?.message || 'assistant error').slice(0, 4000)
          : '',
        historyTail: Array.isArray(project.messagesHistory)
          ? project.messagesHistory.slice(-20).map(item => ({
              role: item?.role || '',
              content: String(item?.content || '').slice(0, 2000),
              toolCalls: Array.isArray(item?.tool_calls)
                ? item.tool_calls.map(call => call?.function?.name || call?.name || '').filter(Boolean)
                : []
            }))
          : []
      } : null,
      popup: {
        visible: popup?.classList?.contains('show') === true,
        text: String(popup?.innerText || '').trim().slice(0, 3000),
        options: Array.from(popup?.querySelectorAll?.('[data-ask-value]') || []).map(node => ({
          label: String(node.dataset.askLabel || node.innerText || '').trim(),
          value: String(node.dataset.askValue || '')
        }))
      },
      latestAi: latestAi ? {
        messageTime: String(latestAi.dataset?.messageTime || ''),
        text: String(latestAi.innerText || '').trim().slice(-12000),
        htmlPreview: String(latestAi.innerHTML || '').slice(-3000),
        tools: [...new Set(toolNodes.map(node => String(node.dataset.toolName || node.getAttribute('data-name') || node.innerText || '').trim().slice(0, 300)).filter(Boolean))],
        thinking: thinkingNodes.map(node => String(node.innerText || '').trim().slice(0, 2000)).filter(Boolean),
        media: mediaNodes.map(node => ({
          tag: String(node.tagName || '').toLowerCase(),
          src: String(node.getAttribute?.('src') || node.dataset?.assetPath || node.dataset?.mediaUrl || '').slice(0, 2000)
        }))
      } : null,
      observedToolCalls: [...runtimeToolEvents, ...historyToolCalls, ...toolNodes.map((node, index) => ({
        id: String(node.dataset.toolId || node.getAttribute('data-tool-id') || `${index}:${node.dataset.toolName || node.getAttribute('data-name') || ''}`),
        name: String(node.dataset.toolName || node.getAttribute('data-name') || node.innerText || '').trim().slice(0, 300)
      }))].filter(item => item.name),
      observedThinking: [...historyThinking, ...thinkingNodes.map(node => String(node.innerText || '').trim().slice(0, 2000)).filter(Boolean)],
      planText: String(document.getElementById('planProgressDock')?.innerText || '').trim().slice(0, 4000),
      sendButtonClass: String(document.getElementById('sendBtn')?.className || '')
    }
  }))
}

async function armToolObserver(runtime) {
  return runtime.executeJavaScript(javascript(() => {
    window.__geminiDirectE2EToolEvents = []
    if (window.__geminiDirectE2EToolHookInstalled) return { installed: true, reused: true }
    if (typeof window.api?.onToolStart !== 'function') return { installed: false, error: 'onToolStart unavailable' }
    window.api.onToolStart(data => {
      const item = {
        id: String(data?.toolCallId || `runtime:${Date.now()}:${data?.name || ''}`),
        name: String(data?.name || '').trim()
      }
      if (item.name) window.__geminiDirectE2EToolEvents.push(item)
    })
    window.__geminiDirectE2EToolHookInstalled = true
    return { installed: true, reused: false }
  }))
}

async function approvePopup(runtime) {
  return runtime.executeJavaScript(javascript(() => {
    const popup = document.getElementById('aiAskPopup')
    if (!popup?.classList?.contains('show')) return { approved: false }
    const option = popup.querySelector('[data-ask-value="confirmed"]')
      || popup.querySelector('[data-ask-value="approved"]')
      || popup.querySelector('[data-ask-value="allow_once"]')
      || popup.querySelector('[data-ask-value]')
    if (!option) return { approved: false, reason: 'no standard option' }
    const selected = { label: String(option.dataset.askLabel || option.innerText || '').trim(), value: String(option.dataset.askValue || '') }
    option.click()
    return { approved: true, selected }
  }))
}

async function prepare(runtime, options) {
  const status = await runtime.executeJavaScript(`window.api.getGeminiWebBridgeStatus()`)
  if (status?.transportMode !== 'direct') {
    const switched = await runtime.executeJavaScript(`window.api.setGeminiWebBridgeTransportMode('direct')`)
    if (!switched?.success) throw new Error(switched?.error || 'Failed to switch Gemini to direct transport')
  }
  let before = await readState(runtime)
  if (!before.project || String(before.project.path).toLowerCase() !== String(options.expectProject).toLowerCase()) {
    const activated = await runtime.executeJavaScript(`(async () => {
      const expectedPath = ${JSON.stringify(String(options.expectProject || ''))}
      const store = window.ProjectStore
      if (!store || typeof window.switchProject !== 'function') {
        return { success: false, error: 'project runtime APIs unavailable' }
      }
      let project = store.findProjectByPath?.(expectedPath) || null
      if (!project) {
        const current = window.getActiveProject?.() || null
        const created = await window.api.createProject(expectedPath)
        if (!created?.success || !created?.projectId) return { success: false, error: created?.error || 'createProject failed' }
        project = store.createProject(expectedPath, {
          id: created.projectId,
          storagePath: created.storagePath || '',
          modelIndex: Number.isInteger(current?.modelIndex) ? current.modelIndex : -1,
          modelKey: current?.modelKey || null
        })
      }
      await window.switchProject(project.id)
      return { success: true, id: project.id, path: project.path }
    })()`)
    if (!activated?.success) {
      throw new Error(`Failed to activate project ${options.expectProject}: ${JSON.stringify(activated)}`)
    }
    await wait(500)
    before = await readState(runtime)
    if (!before.project || String(before.project.path).toLowerCase() !== String(options.expectProject).toLowerCase()) {
      throw new Error(`Expected active project ${options.expectProject}, found ${before.project?.path || 'none'}`)
    }
  }
  if (before.project.isRunning) throw new Error('The active project already has a running AI task')
  if (options.expectModelId && before.project.modelId !== options.expectModelId) {
    const selected = await runtime.executeJavaScript(`(() => {
      const expected = ${JSON.stringify(String(options.expectModelId || ''))}
      const models = window.ModelStore?.getModels?.() || []
      const index = models.findIndex(model => String(model?.modelId || model?.model || '') === expected)
      if (index < 0) return { success: false, models: models.map(model => ({ modelId: model?.modelId, modelName: model?.modelName })) }
      if (typeof window.useModel !== 'function') return { success: false, error: 'window.useModel missing' }
      window.useModel(index)
      return { success: true, index, modelId: expected }
    })()`)
    if (!selected?.success) throw new Error(`Failed to select ${options.expectModelId}: ${JSON.stringify(selected)}`)
    await wait(300)
    const switched = await readState(runtime)
    if (switched.project?.modelId !== options.expectModelId) {
      throw new Error(`Expected active model ${options.expectModelId}, found ${switched.project?.modelId || 'none'}`)
    }
    before = switched
  }
  if (options.newSession) {
    const previousSession = before.project.chatSessionId
    await runtime.executeJavaScript(`window.handleCreateProjectChatSession(window.getActiveProject())`)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const state = await readState(runtime)
      if (state.project?.chatSessionId && state.project.chatSessionId !== previousSession) return state
      await wait(250)
    }
    throw new Error('Timed out while creating a clean project chat session')
  }
  return before
}

async function sendPrompt(runtime, prompt) {
  const payload = JSON.stringify(String(prompt || ''))
  return runtime.executeJavaScript(`(() => {
    const input = document.getElementById('inputBox')
    if (!input) throw new Error('inputBox missing')
    input.value = ${payload}
    input.dispatchEvent(new Event('input', { bubbles: true }))
    window.MessageSender.sendMessage()
    return { sent: true }
  })()`)
}

function assertResult(state, options) {
  const baselineToolIds = new Set(options.baselineToolIds || [])
  const tools = (state?.observedToolCalls || [])
    .filter(item => !baselineToolIds.has(item.id))
    .map(item => item.name)
  const finalText = String(state?.project?.finalText || '')
  const thinking = (state?.observedThinking || []).slice(Number(options.baselineThinkingCount || 0))
  if (options.expectNoTools && tools.length) {
    throw new Error(`Expected no tools, observed: ${tools.join(', ')}\nState: ${JSON.stringify(state)}`)
  }
  for (const expected of options.expectTools) {
    if (!tools.some(item => item === expected || item.startsWith(`${expected} `))) {
      throw new Error(`Expected tool ${expected}, observed: ${tools.join(', ') || 'none'}\nState: ${JSON.stringify(state)}`)
    }
  }
  for (const group of options.expectToolAnyGroups) {
    if (!group.some(expected => tools.some(item => item === expected || item.startsWith(`${expected} `)))) {
      throw new Error(`Expected one of tools ${group.join(', ')}, observed: ${tools.join(', ') || 'none'}\nState: ${JSON.stringify(state)}`)
    }
  }
  if (options.expectFinalIncludes && !finalText.includes(options.expectFinalIncludes)) {
    throw new Error(`Expected final text to include ${JSON.stringify(options.expectFinalIncludes)}, got: ${finalText.slice(0, 1000)}\nState: ${JSON.stringify(state)}`)
  }
  if (options.expectThinking && !thinking.some(Boolean)) {
    throw new Error(`Expected a visible thinking block, but none was found\nState: ${JSON.stringify(state)}`)
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2))
  const runtime = await connectRuntime()
  if (options.cancelRunning) {
    const cancelled = await runtime.executeJavaScript(javascript(() => {
      const project = window.getActiveProject?.()
      const button = document.getElementById('sendBtn')
      if (!project?.isRunning || !button) return { clicked: false, running: project?.isRunning === true, className: button?.className || '' }
      button.click()
      return { clicked: true, running: project.isRunning === true, className: button.className }
    }))
    console.log(JSON.stringify(cancelled, null, 2))
    return
  }
  let initial = await prepare(runtime, options)
  const observer = await armToolObserver(runtime)
  if (!observer?.installed) throw new Error(`Failed to observe runtime tools: ${JSON.stringify(observer)}`)
  if (options.apiUrl) {
    const overridden = await runtime.executeJavaScript(`(() => {
      const expected = ${JSON.stringify(String(options.expectModelId || ''))}
      const apiUrl = ${JSON.stringify(String(options.apiUrl || ''))}
      const models = window.ModelStore?.getModels?.() || []
      const model = models.find(item => String(item?.modelId || item?.model || '') === expected)
      if (!model) return { success: false, error: 'model not found', expected }
      model.apiUrl = apiUrl
      const project = window.getActiveProject?.()
      const projectModel = project?.modelKey
        ? models.find(item => window.ModelStore?.getModelKey?.(item) === project.modelKey)
        : window.ModelStore?.getCurrentModel?.()
      return {
        success: String(projectModel?.modelId || projectModel?.model || '') === expected
          && String(projectModel?.apiUrl || '') === apiUrl,
        modelId: String(projectModel?.modelId || projectModel?.model || ''),
        apiUrl: String(projectModel?.apiUrl || '')
      }
    })()`)
    if (!overridden?.success) {
      throw new Error(`Failed to apply runtime-only API URL override: ${JSON.stringify(overridden)}`)
    }
    initial = await readState(runtime)
  }
  options.baselineToolIds = (initial.observedToolCalls || []).map(item => item.id)
  options.baselineThinkingCount = (initial.observedThinking || []).length
  const startedAt = Date.now()
  await sendPrompt(runtime, options.prompt)
  const approvals = []
  let observedRunning = false
  let idleSince = 0
  let last = initial
  while (Date.now() - startedAt < options.timeoutMs) {
    await wait(500)
    last = await readState(runtime)
    if (last.project?.latestAssistantError) {
      throw new Error(`Lingxi assistant request failed: ${last.project.latestAssistantError}\nState: ${JSON.stringify(last)}`)
    }
    if (last.project?.isRunning) {
      observedRunning = true
      idleSince = 0
    } else if (observedRunning && !last.popup.visible) {
      idleSince ||= Date.now()
    }
    if (last.popup.visible && options.autoApprove) {
      const approval = await approvePopup(runtime)
      if (approval?.approved) approvals.push({ ...approval, atMs: Date.now() - startedAt })
      await wait(250)
      continue
    }
    const hasFinal = Boolean(String(last.project?.finalText || '').trim())
    const latestAiTime = Date.parse(String(last.latestAi?.messageTime || ''))
    const currentAssistantRendered = Number.isFinite(latestAiTime) && latestAiTime >= startedAt - 1000
    const settledForMs = idleSince ? Date.now() - idleSince : 0
    if (!last.project?.isRunning && !last.popup.visible && !hasFinal) {
      const idleWithoutFinalMs = observedRunning ? settledForMs : (Date.now() - startedAt)
      // 网页直连在 tool_result 与下一次 StreamGenerate 之间会短暂把前端项目标成
      // idle；页面端一次扩展思考也可能超过一分钟。短暂 idle 不能判成任务结束。
      if (idleWithoutFinalMs >= Math.min(240000, Math.max(30000, Math.floor(options.timeoutMs / 2)))) {
        throw new Error(`Lingxi task became idle without an assistant final response\nState: ${JSON.stringify(last)}`)
      }
    }
    if (observedRunning && !last.project?.isRunning && !last.popup.visible && hasFinal && currentAssistantRendered && settledForMs >= 2500) {
      assertResult(last, options)
      console.log(JSON.stringify({
        success: true,
        durationMs: Date.now() - startedAt,
        prompt: options.prompt,
        approvals,
        state: last
      }, null, 2))
      return
    }
  }
  throw new Error(`E2E prompt timed out after ${options.timeoutMs}ms: ${JSON.stringify({ approvals, state: last })}`)
}

run().catch(error => {
  console.error(error.stack || error.message || String(error))
  process.exit(1)
})
