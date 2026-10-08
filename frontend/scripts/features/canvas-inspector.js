(function () {
  'use strict'

  const state = {
    container: null,
    payload: null,
    interactionDepth: 0,
    pendingSession: null,
    refreshTimer: null,
    teamCtxExpanded: true,
    teamCtxOpenIds: new Set(),
    teamNodeId: '',
    pointerHold: 0
  }

  const RUNNING_STATUSES = new Set(['waiting', 'queued', 'running', 'thinking', 'using_tools', 'streaming', 'active', 'working', 'running_with_errors'])

  function escapeHtml(value = '') {
    if (window.HtmlUtils?.escapeHtml) return window.HtmlUtils.escapeHtml(value)
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function showToast(message, type = 'info') {
    window.ToastUI?.show?.(message, type)
  }

  async function openReportFile(filePath = '') {
    const targetPath = String(filePath || '').trim()
    if (!targetPath) return
    try {
      let result = await window.api?.openProjectFolder?.(targetPath)
      if (!result?.success && window.api?.showItemInFolder) {
        result = await window.api.showItemInFolder(targetPath)
      }
      if (!result?.success) showToast(result?.error || '交付文件打开失败', 'error')
    } catch (error) {
      showToast(error?.message || '交付文件打开失败', 'error')
    }
  }

  function getModels() {
    return window.ModelStore?.getModels?.() || []
  }

  function getModelKey(model = {}) {
    if (window.CanvasWorkflows?.getCanonicalModelKey) {
      return window.CanvasWorkflows.getCanonicalModelKey(model)
    }
    if (window.ModelStore?.getModelKey) {
      const official = String(window.ModelStore.getModelKey(model) || '').trim()
      if (official) return official
    }
    return String(model.modelKey || model.id || model.key || model.modelId || model.modelName || model.name || model.model || '').trim()
  }

  function getModelName(model = {}) {
    return String(model.displayName || model.modelName || model.modelId || model.name || '未命名模型')
  }

  function findModelByKey(key = '') {
    if (window.CanvasWorkflows?.findModelByStoredKey) {
      return window.CanvasWorkflows.findModelByStoredKey(key, getModels())
    }
    const target = String(key || '').trim()
    if (!target) return null
    return getModels().find(model => getModelKey(model) === target) || null
  }

  function resolveSelectedModel(node = {}) {
    if (window.CanvasWorkflows?.resolveSelectedModel) {
      return window.CanvasWorkflows.resolveSelectedModel(node, getModels())
    }
    return findModelByKey(node.modelKey)
  }

  function readWorkModelPatch(container, node = {}) {
    const modelSelect = container.querySelector('[data-field="modelKey"]')
    const rawKey = String(modelSelect?.value || '').trim()
    if (!rawKey) return { modelKey: '', modelName: '' }
    const selectedModel = findModelByKey(rawKey)
    const optionLabel = String(modelSelect?.selectedOptions?.[0]?.textContent || '').trim()
    return {
      modelKey: selectedModel ? getModelKey(selectedModel) : rawKey,
      modelName: selectedModel ? getModelName(selectedModel) : (optionLabel || node.modelName || rawKey)
    }
  }

  function getAgent(session, nodeId) {
    if (nodeId === 'task') {
      return {
        id: 'task',
        name: '你的任务',
        role: '用户',
        status: 'done',
        task: session?.task || session?.teamBrief || '',
        thinking: [],
        tools: [],
        startedAt: session?.startedAt || 0,
        finishedAt: session?.startedAt || 0
      }
    }
    if (nodeId === 'ceo') {
      return {
        id: 'ceo',
        name: 'CEO 汇总',
        role: 'CEO',
        status: session?.captain?.status || session?.status || 'waiting',
        task: session?.captain?.preview || session?.notes?.consensus || '队员交卷后由主会话汇总',
        thinking: [],
        tools: [],
        output: session?.captain?.preview || session?.notes?.consensus || '',
        startedAt: session?.startedAt || 0,
        finishedAt: session?.finishedAt || 0
      }
    }
    return Array.isArray(session?.agents)
      ? session.agents.find(agent => agent.nodeId === nodeId || agent.id === nodeId) || null
      : null
  }

  function getStatusLabel(status = '') {
    const labels = {
      waiting: '等待上游',
      queued: '排队中',
      running: '执行中',
      thinking: '思考中',
      using_tools: '调用工具',
      done: '已完成',
      completed: '已完成',
      error: '失败',
      failed: '失败',
      timeout: '超时',
      interrupted: '已停止',
      pending: '待汇总',
      cancelled: '已停止'
    }
    return labels[status] || status || '未运行'
  }

  function isAgentRunning(agent = null) {
    return !!agent && RUNNING_STATUSES.has(String(agent.status || ''))
  }

  function isAgentRetryable(agent = null) {
    return !!agent && ['error', 'failed', 'timeout', 'interrupted'].includes(String(agent.status || ''))
  }

  function isEditingElement(element) {
    const tagName = String(element?.tagName || '').toLowerCase()
    return tagName === 'select' || tagName === 'input' || tagName === 'textarea'
  }

  function normalizeEvents(events = []) {
    return (Array.isArray(events) ? events : []).map((event, index) => {
      if (typeof event === 'string') {
        return { id: `event-${index + 1}`, content: event, createdAt: index }
      }
      return {
        id: event?.id || event?.toolCallId || event?.tool_call_id || `event-${index + 1}`,
        type: event?.type || 'status',
        title: event?.title || event?.name || event?.status || '',
        name: event?.name || event?.toolName || event?.title || '',
        content: event?.content || event?.text || event?.message || event?.detail || '',
        args: event?.args && typeof event.args === 'object' ? event.args : {},
        result: event?.result && typeof event.result === 'object' ? event.result : null,
        toolCallId: event?.toolCallId || event?.tool_call_id || event?.id || '',
        status: event?.status || '',
        createdAt: event?.createdAt || event?.time || index
      }
    })
  }

  function getEventTime(event = {}) {
    const numeric = Number(event.createdAt || 0)
    if (Number.isFinite(numeric) && numeric > 0) return numeric
    const parsed = Date.parse(event.createdAt || event.time || '')
    return Number.isFinite(parsed) ? parsed : 0
  }

  function isToolRunning(event = {}) {
    const status = String(event.status || '').toLowerCase()
    return ['queued', 'running', 'active', 'working', 'pending'].includes(status)
  }

  function isToolError(event = {}) {
    const status = String(event.status || '').toLowerCase()
    return ['error', 'failed', 'timeout'].includes(status) || event.result?.success === false || !!event.result?.error
  }

  function compactText(value = '', limit = 800) {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    return text.length > limit ? `${text.slice(0, limit)}...` : text
  }

  function stripThinkForDisplay(value = '') {
    return String(value || '')
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think\b[^>]*>/gi, '')
      .replace(/```(?:think|thinking|reasoning)[\s\S]*?```/gi, '')
      .trim()
  }

  function formatConclusionHtml(value = '') {
    const cleaned = stripThinkForDisplay(readableText(value))
    if (!cleaned) return ''
    const html = window.AiMessageUI?.renderAiContent?.(cleaned)
      || window.AiMessageUI?.sanitizeAiContent?.(cleaned)
      || escapeHtml(cleaned)
    const plain = String(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    return plain ? html : ''
  }

  function readableText(value = '') {
    return String(value == null ? '' : value).replace(/\\n/g, '\n').replace(/\r\n/g, '\n')
  }

  function countChars(value = '') {
    return Array.from(readableText(value).replace(/\s+/g, '')).length
  }

  function formatRunDuration(agent = {}) {
    const started = Number(agent.startedAt || 0)
    if (!started) return ''
    const ended = Number(agent.finishedAt || 0) || (isAgentRunning(agent) ? Date.now() : started)
    const sec = Math.max(0, (ended - started) / 1000)
    return `${sec.toFixed(1)}s`
  }

  const CONTEXT_CHANNELS = {
    request: { title: '原始请求', hint: '老板交给整个团队的目标' },
    team_brief: { title: '团队共识', hint: '本回合主协调为全员设定的共识' },
    team_position: { title: '团队位置', hint: '队友与产出去向' },
    dependency: { title: '前置结果', hint: '上游队友交付的产物' },
    workspace: { title: '工作区', hint: '共享工作区可读文件' },
    deliverable: { title: '交付物规格', hint: '期望交付的形态与硬约束' }
  }

  const CTX_CHEVRON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>'

  function firstLine(value = '') {
    return readableText(value).split('\n').map(line => line.trim()).find(Boolean) || ''
  }

  function formatCompactChars(count) {
    const n = Math.max(0, Number(count) || 0)
    if (n < 1000) return String(n)
    if (n < 10000) return `${String(Math.round(n / 100) / 10).replace(/\.0$/, '')}k`
    return `${Math.round(n / 1000)}k`
  }

  function contextHeading(block = {}, meta = {}) {
    if (block.heading) return block.heading
    if (block.channel === 'team_position') return '你在团队中的位置'
    if (block.channel === 'workspace') return '工作区路径'
    if (block.channel === 'deliverable') return meta.title || '交付物规格'
    return firstLine(block.body) || meta.hint || meta.title || ''
  }

  function contextContentKey(session, agent) {
    return JSON.stringify(buildTeamContextBlocks(session, agent).map(block => [block.id, block.channel, block.body]))
  }

  function buildTeamContextBlocks(session = {}, agent = {}) {
    const blocks = []
    const request = readableText(session.task || '')
    if (request) {
      blocks.push({ id: 'request', channel: 'request', heading: firstLine(request), body: request })
    }
    const brief = readableText(session.teamBrief || session.notes?.coordination || session.notes?.consensus || '')
    if (brief && brief !== request) {
      blocks.push({
        id: 'team_brief',
        channel: 'team_brief',
        heading: firstLine(brief) || '团队共识（主协调为本回合设定）',
        body: brief
      })
    }
    const roster = (Array.isArray(session.agents) ? session.agents : []).map(item => {
      const name = item.name || item.role || '队员'
      const role = item.role || '队员'
      const lane = Array.isArray(item.dependsOn) && item.dependsOn.length ? '串行依赖' : '并行队友'
      return `${name}（${role}）· ${lane}`
    }).filter(Boolean)
    if (roster.length) {
      blocks.push({
        id: 'team_position',
        channel: 'team_position',
        heading: '你在团队中的位置',
        body: `你在团队中的位置\n${roster.join('\n')}`
      })
    }
    const deps = (Array.isArray(agent.dependsOn) ? agent.dependsOn : [])
      .map(id => (session.agents || []).find(item => item.id === id || item.nodeId === id))
      .filter(Boolean)
    if (deps.length) {
      const body = deps.map(item => {
        const result = readableText(stripThinkForDisplay(item.output || item.error?.message || '') || '（尚无正文）')
        return `${item.name || item.role}\n${result}`
      }).join('\n\n')
      blocks.push({
        id: 'dependency',
        channel: 'dependency',
        heading: deps.map(item => item.name || item.role).join('、') || '前置结果',
        body
      })
    }
    const workspace = String(session.projectPath || session.projectId || '').trim()
    if (workspace) {
      blocks.push({ id: 'workspace', channel: 'workspace', heading: '工作区路径', body: workspace })
    }
    const deliverable = readableText(session.notes?.convention || session.deliverable || '')
    if (deliverable && deliverable !== brief && deliverable !== request) {
      blocks.push({ id: 'deliverable', channel: 'deliverable', heading: '交付物规格', body: deliverable })
    }
    return blocks
  }

  function teamTaskText(session = {}, agent = {}) {
    if (agent?.id === 'task') return readableText(session.task || session.teamBrief || '')
    if (agent?.id === 'ceo') return readableText(session.captain?.preview || session.notes?.consensus || agent.task || '队员交卷后由主会话汇总')
    return readableText(agent.task || '')
  }

  function getThinkingDisplayText(event = {}, agent = {}) {
    const raw = event.content || event.title || agent.statusText || '正在处理'
    const summarized = window.AiMessageUI?.summarizeThinkingStatus?.(raw) || compactText(raw, 180)
    return window.AiMessageUI?.clipAtSentence?.(summarized, 180) || summarized
  }

  function renderThinkingEvents(agent = {}) {
    const events = normalizeEvents(agent.thinking || agent.thoughts || [])
      .map(event => ({ ...event, content: getThinkingDisplayText(event, agent) }))
      .filter(event => event.content && (window.AiMessageUI?.shouldDisplayThinkingStatus?.(event.content) ?? event.content.length > 4))
    if (!events.length) return ''
    const active = isAgentRunning(agent)
    return `
      <div class="ai-work-segment">
        <div class="ai-thinking-block ${active ? 'active' : 'stopped'}">
          <span class="ai-thinking-pulse-icon">
            <span class="pulse-ring"></span>
            <svg class="pulse-core" viewBox="0 0 16 16" width="14" height="14"><path d="M8 0 L9.2 6.8 L16 8 L9.2 9.2 L8 16 L6.8 9.2 L0 8 L6.8 6.8 Z" fill="currentColor"/></svg>
          </span>
          <div class="ai-thinking-header-row ${active ? '' : 'stopped'}">
            <div class="ai-thinking-timeline">
              ${events.map((event, index) => `
                <div class="ai-thinking-line ${active && index === events.length - 1 ? 'active' : ''}">
                  <span class="ai-thinking-status">${escapeHtml(event.content)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `
  }

  function createToolResult(event = {}) {
    if (event.result) return event.result
    if (isToolError(event)) return { success: false, error: event.content || event.title || '工具调用失败' }
    return { success: true, message: event.content || event.title || '工具调用完成' }
  }

  function renderToolsWithChatUi(agent = {}, session = {}, onlyTools) {
    const tools = (Array.isArray(onlyTools) ? onlyTools : normalizeEvents(agent.tools || agent.toolCalls || []))
      .filter(event => event.name || event.title)
      .sort((a, b) => getEventTime(a) - getEventTime(b))
    if (!tools.length || !window.AiToolRenderer?.bind) return ''

    const proxyMsg = document.createElement('div')
    proxyMsg.className = 'message ai'
    proxyMsg.innerHTML = '<div class="ai-dynamic-area"></div>'
    const stats = { modified: [], created: [], read: [], commands: [] }
    const renderer = window.AiToolRenderer.bind({
      getCurrentAiMsg: () => proxyMsg,
      getCurrentProjectPath: () => session?.projectPath || '',
      getOpIcons: () => window.AiMessageUI?.opIcons || {},
      getOpTypes: () => window.AiMessageUI?.opTypes || {},
      getFileName: path => window.AiMessageUI?.getFileName?.(path) || String(path || '').split(/[\\/]/).slice(-2).join('/'),
      calculateEditLines: (...args) => window.AiMessageUI?.calculateEditLines?.(...args) || { add: 0, remove: 0, modified: false },
      sanitizeContent: content => window.AiMessageUI?.sanitizeAiContent?.(content) || escapeHtml(content)
    })

    tools.forEach(event => {
      const name = event.name || event.title || 'tool'
      const meta = { toolCallId: event.toolCallId || event.id || '', agentRole: agent.role || agent.name || '' }
      if (isToolRunning(event)) {
        renderer.preShowOperation?.(name, event.args || {}, meta)
      } else {
        renderer.addOperation?.(name, event.args || {}, createToolResult(event), stats, meta)
      }
    })

    const keepActive = isAgentRunning(agent)
    proxyMsg.querySelectorAll('.tool-call-group').forEach(group => {
      group.dataset.active = keepActive ? (group.dataset.active || 'true') : 'false'
    })
    return proxyMsg.querySelector('.ai-dynamic-area')?.innerHTML || ''
  }

  function mergeTimeline(agent = {}) {
    const thinks = normalizeEvents(agent.thinking || agent.thoughts || []).map((event, index) => ({
      lane: 'think',
      index,
      t: getEventTime(event),
      event: { ...event, content: getThinkingDisplayText(event, agent) }
    })).filter(item => item.event.content && (window.AiMessageUI?.shouldDisplayThinkingStatus?.(item.event.content) ?? item.event.content.length > 4))
    const tools = normalizeEvents(agent.tools || agent.toolCalls || [])
      .filter(event => event.name || event.title)
      .map((event, index) => ({
        lane: 'tool',
        index,
        t: getEventTime(event),
        event
      }))
    return [...thinks, ...tools].sort((a, b) => {
      const dt = (a.t || 0) - (b.t || 0)
      if (dt) return dt
      if (a.lane === b.lane) return a.index - b.index
      return a.lane === 'think' ? -1 : 1
    })
  }

  function renderConclusion(agent = {}) {
    if (isAgentRunning(agent)) return ''
    const html = formatConclusionHtml(agent.output || '')
    if (html) {
      return `
      <section class="team-run-section team-run-conclusion-section">
        <h3>结论</h3>
        <div class="message ai team-run-conclusion">
          <div class="ai-content">${html}</div>
        </div>
      </section>`
    }
    if (['done', 'completed', 'completed_with_errors'].includes(String(agent.status || ''))) {
      return `
      <section class="team-run-section team-run-conclusion-section">
        <h3>结论</h3>
        <div class="canvas-inspector-muted">队员没有留下可见正文，过程记录在上方。</div>
      </section>`
    }
    return ''
  }

  function renderInterleavedTimeline(session, agent) {
    const items = mergeTimeline(agent)
    if (!items.length) {
      return !isAgentRunning(agent)
        ? renderConclusion(agent)
        : '<div class="canvas-inspector-muted">还没有思考或工具记录</div>'
    }
    const groups = []
    items.forEach(item => {
      const last = groups[groups.length - 1]
      if (last && last.lane === item.lane) last.events.push(item.event)
      else groups.push({ lane: item.lane, events: [item.event] })
    })
    const parts = groups.map((group, index) => {
      const last = index === groups.length - 1
      const liveAgent = last && isAgentRunning(agent) ? agent : { ...agent, status: 'done' }
      if (group.lane === 'think') {
        return renderThinkingEvents({ ...liveAgent, thinking: group.events })
      }
      return renderToolsWithChatUi(liveAgent, session, group.events)
    }).filter(Boolean)
    const conclusion = !isAgentRunning(agent) ? renderConclusion(agent) : ''
    return `
      <div class="canvas-inspector-runtime-message">
        <div class="ai-dynamic-area">${parts.join('') || '<div class="canvas-inspector-muted">还没有思考或工具记录</div>'}</div>
      </div>
      ${conclusion}
    `
  }

  function renderRuntimeDynamicArea(session, agent) {
    return renderInterleavedTimeline(session, agent)
  }

  function renderTeamContext(session, agent) {
    const blocks = buildTeamContextBlocks(session, agent)
    if (!blocks.length) return ''
    const expanded = state.teamCtxExpanded !== false
    const cards = blocks.map(block => {
      const meta = CONTEXT_CHANNELS[block.channel] || { title: block.channel, hint: '' }
      const open = state.teamCtxOpenIds.has(block.id)
      const body = readableText(block.body)
      const heading = contextHeading(block, meta)
      const snippet = compactText(body, 140)
      const chars = countChars(body)
      return `
        <article class="team-run-ctx-card${open ? ' is-open' : ''}" data-ctx-item="${escapeHtml(block.id)}" role="button" tabindex="0" title="${escapeHtml(meta.hint || meta.title)}">
          <div class="team-run-ctx-row">
            <span class="team-run-ctx-chevron" aria-hidden="true">${CTX_CHEVRON}</span>
            <span class="team-run-ctx-main">
              <span class="team-run-ctx-line">
                <span class="team-run-ctx-pill">${escapeHtml(meta.title)}</span>
                <span class="team-run-ctx-heading">${escapeHtml(heading)}</span>
                <span class="team-run-ctx-count">${escapeHtml(formatCompactChars(chars))} 字</span>
              </span>
              <span class="team-run-ctx-snippet"${open ? ' hidden' : ''}>${escapeHtml(snippet)}</span>
            </span>
          </div>
          <pre class="team-run-ctx-body"${open ? '' : ' hidden'}>${escapeHtml(body)}</pre>
        </article>
      `
    }).join('')
    return `
      <section class="team-run-section team-run-context${expanded ? '' : ' is-folded'}">
        <button type="button" class="team-run-ctx-fold" data-ctx-fold aria-expanded="${expanded ? 'true' : 'false'}">
          <span class="team-run-ctx-fold-mark" aria-hidden="true">${CTX_CHEVRON}</span>
          <strong>收到的上下文</strong>
          <b>${blocks.length} 段</b>
        </button>
        <div class="team-run-ctx-list" data-ctx-list ${expanded ? '' : 'hidden'}>${cards}</div>
      </section>
    `
  }

  function toggleCtxCard(card) {
    if (!card) return
    const id = card.dataset.ctxItem
    const open = !card.classList.contains('is-open')
    card.classList.toggle('is-open', open)
    if (open) state.teamCtxOpenIds.add(id)
    else state.teamCtxOpenIds.delete(id)
    const snippet = card.querySelector('.team-run-ctx-snippet')
    const body = card.querySelector('.team-run-ctx-body')
    if (snippet) snippet.toggleAttribute('hidden', open)
    if (body) body.toggleAttribute('hidden', !open)
  }

  function applyCtxSectionFold(root, expanded) {
    state.teamCtxExpanded = expanded
    const section = root.querySelector('.team-run-context')
    const list = root.querySelector('[data-ctx-list]')
    const btn = root.querySelector('[data-ctx-fold]')
    if (section) section.classList.toggle('is-folded', !expanded)
    if (list) {
      if (expanded) list.removeAttribute('hidden')
      else list.setAttribute('hidden', '')
    }
    if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  }

  function bindTeamRun(container) {
    const root = container.querySelector('[data-team-run]')
    if (!root || root.dataset.ctxBound === 'true') return
    root.dataset.ctxBound = 'true'
    root.addEventListener('click', event => {
      const fold = event.target.closest('[data-ctx-fold]')
      if (fold && root.contains(fold)) {
        event.preventDefault()
        event.stopPropagation()
        applyCtxSectionFold(root, state.teamCtxExpanded === false)
        return
      }
      const card = event.target.closest('[data-ctx-item]')
      if (card && root.contains(card)) toggleCtxCard(card)
    }, true)
    root.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const fold = event.target.closest('[data-ctx-fold]')
      if (fold && root.contains(fold)) {
        event.preventDefault()
        applyCtxSectionFold(root, state.teamCtxExpanded === false)
        return
      }
      const card = event.target.closest('[data-ctx-item]')
      if (!card || !root.contains(card)) return
      event.preventDefault()
      toggleCtxCard(card)
    })
  }

  function renderTeamRun(session, agent) {
    const status = agent.status || ''
    const duration = formatRunDuration(agent)
    const task = teamTaskText(session, agent) || '未提供任务说明'
    const title = agent.name || agent.role || '队员'
    return `
      <div class="canvas-inspector team-run-detail" data-team-run>
        <div class="team-run-workspace">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path></svg>
          <span>工作区</span>
          <strong>${escapeHtml(title)}</strong>
        </div>
        <header class="team-run-head">
          <h2>${escapeHtml(title)}</h2>
          <span class="canvas-inspector-status" data-status="${escapeHtml(status)}">${escapeHtml(getStatusLabel(status))}</span>
          ${duration ? `<span class="team-run-duration">${escapeHtml(duration)}</span>` : ''}
        </header>
        ${agent.error?.message ? `<section class="team-run-section"><h3>错误</h3><p class="team-run-error">${escapeHtml(agent.error.message)}</p></section>` : ''}
        <section class="team-run-section">
          <h3>任务</h3>
          <div class="team-run-task">${escapeHtml(task)}</div>
        </section>
        <div data-team-context>${renderTeamContext(session, agent)}</div>
        <div data-inspector-timeline>${renderInterleavedTimeline(session, agent)}</div>
      </div>
    `
  }

  function getVisibleWorkflow(session) {
    if (session?.executionKind === 'team' && session?.workflow) return session.workflow
    if (session?.workflowExecution && session?.workflow) return session.workflow
    return window.CanvasWorkflows?.getWorkflow?.() || session?.workflow || null
  }

  function scheduleDeferredRefresh() {
    clearTimeout(state.refreshTimer)
    state.refreshTimer = setTimeout(() => {
      if (!state.container || !state.payload || state.interactionDepth > 0) return
      const session = state.pendingSession || state.payload.session
      state.pendingSession = null
      if (updateRuntimeAreas(session)) {
        state.payload = { ...state.payload, session }
        return
      }
      render(state.container, { ...state.payload, session })
    }, 140)
  }

  function renderRuntime(session, agent) {
    if (!session || !agent) return ''
    const reportPath = agent.reportFilePath || ''
    return `
      <section class="canvas-inspector-section canvas-inspector-runtime">
        <div class="canvas-inspector-section-head">
          <h3>运行状态</h3>
          <span class="canvas-inspector-status" data-status="${escapeHtml(agent.status || '')}">${escapeHtml(getStatusLabel(agent.status))}</span>
        </div>
        <div class="canvas-inspector-progress">${escapeHtml(agent.statusText || '等待执行信息')}</div>
        ${renderRuntimeDynamicArea(session, agent)}
        ${reportPath ? `<button type="button" class="canvas-inspector-link" data-open-report="${escapeHtml(reportPath)}">打开交付文件</button>` : ''}
      </section>
    `
  }

  function renderRuntimeShell(session, agent) {
    return `<div data-inspector-runtime>${renderRuntime(session, agent)}</div>`
  }

  function renderTopActions(agent, session) {
    if (session?.executionKind === 'team') return ''
    if (isAgentRunning(agent)) {
      return '<button type="button" class="canvas-inspector-danger canvas-inspector-top-stop" data-stop-node>停止此节点</button>'
    }
    if (isAgentRetryable(agent)) {
      return '<button type="button" class="canvas-inspector-retry canvas-inspector-top-retry" data-retry-node>重试此节点</button>'
    }
    return ''
  }

  function renderWorkflowFields(workflow, node) {
    if (node.type === 'input') {
      return `
        <label class="canvas-inspector-field">
          <span>工作流名称</span>
          <input type="text" data-field="workflowName" value="${escapeHtml(workflow.name || '')}" maxlength="160">
        </label>
        <label class="canvas-inspector-field">
          <span>工作流说明</span>
          <textarea data-field="workflowDescription" rows="5" placeholder="说明输入、目标和交付边界">${escapeHtml(workflow.description || '')}</textarea>
        </label>
      `
    }

    const incomingIds = new Set((workflow.edges || []).filter(edge => edge.target === node.id).map(edge => edge.source))
    const possibleSources = workflow.nodes.filter(item => item.id !== node.id && item.type !== 'output')

    if (node.type === 'output') {
      return `
        <label class="canvas-inspector-field">
          <span>节点名称</span>
          <input type="text" data-field="name" value="${escapeHtml(node.name || '')}" maxlength="120">
        </label>
        <label class="canvas-inspector-field">
          <span>交付规则</span>
          <textarea data-field="outputRule" rows="7" placeholder="说明最终结果应如何整理或写入">${escapeHtml(node.outputRule || '')}</textarea>
        </label>
        <fieldset class="canvas-inspector-upstream">
          <legend>上游输入</legend>
          ${possibleSources.map(source => `
            <label>
              <input type="checkbox" data-upstream="${escapeHtml(source.id)}" ${incomingIds.has(source.id) ? 'checked' : ''}>
              <span>${escapeHtml(source.name)}</span>
            </label>
          `).join('') || '<div class="canvas-inspector-muted">没有可连接的上游节点</div>'}
        </fieldset>
      `
    }

    const models = getModels()
    return `
      <div class="canvas-inspector-field-grid">
        <label class="canvas-inspector-field">
          <span>Work 名称</span>
          <input type="text" data-field="name" value="${escapeHtml(node.name || '')}" maxlength="120">
        </label>
        <label class="canvas-inspector-field">
          <span>执行模型</span>
          <select data-field="modelKey">
            <option value="">跟随当前模型</option>
            ${(() => {
              const selectedModel = resolveSelectedModel(node)
              const selectedKey = selectedModel ? getModelKey(selectedModel) : String(node.modelKey || '').trim()
              const knownKeys = new Set(models.map(model => getModelKey(model)).filter(Boolean))
              const orphanOption = selectedKey && !knownKeys.has(selectedKey)
                ? `<option value="${escapeHtml(selectedKey)}" selected>${escapeHtml(node.modelName || selectedKey)}</option>`
                : ''
              const options = models.map(model => {
                const key = getModelKey(model)
                return `<option value="${escapeHtml(key)}" ${key && key === selectedKey ? 'selected' : ''}>${escapeHtml(getModelName(model))}</option>`
              }).join('')
              return orphanOption + options
            })()}
          </select>
        </label>
      </div>
      <label class="canvas-inspector-field">
        <span>节点任务</span>
        <textarea data-field="task" rows="8" placeholder="明确这个 Agent 要完成什么">${escapeHtml(node.task || '')}</textarea>
      </label>
      <label class="canvas-inspector-field">
        <span>输出要求</span>
        <textarea data-field="outputRule" rows="4" placeholder="例如：输出 JSONL，并列出质量指标">${escapeHtml(node.outputRule || '')}</textarea>
      </label>
      <fieldset class="canvas-inspector-upstream">
        <legend>上游输入</legend>
        ${possibleSources.map(source => `
          <label>
            <input type="checkbox" data-upstream="${escapeHtml(source.id)}" ${incomingIds.has(source.id) ? 'checked' : ''}>
            <span>${escapeHtml(source.name)}</span>
          </label>
        `).join('') || '<div class="canvas-inspector-muted">没有可连接的上游节点</div>'}
      </fieldset>
    `
  }

  function renderRuntimeTask(agent = {}) {
    return `
      <div class="canvas-inspector-readonly">
        <span>负责模型</span>
        <strong>${escapeHtml(agent.modelName || '跟随主模型')}</strong>
      </div>
      <div class="canvas-inspector-readonly">
        <span>节点任务</span>
        <p>${escapeHtml(agent.task || '未提供任务说明')}</p>
      </div>
    `
  }

  function bind(container, workflow, node, session, agent) {
    bindCommonActions(container, session, agent)

    container.querySelector('[data-save-node]')?.addEventListener('click', async () => {
      try {
        if (node.type === 'input') {
          window.CanvasWorkflows.updateWorkflow({
            name: container.querySelector('[data-field="workflowName"]')?.value.trim() || '未命名工作流',
            description: container.querySelector('[data-field="workflowDescription"]')?.value.trim() || ''
          })
        } else {
          const patch = {
            name: container.querySelector('[data-field="name"]')?.value.trim() || node.name,
            outputRule: container.querySelector('[data-field="outputRule"]')?.value.trim() || ''
          }
          if (node.type === 'work') {
            Object.assign(patch, readWorkModelPatch(container, node))
            patch.task = container.querySelector('[data-field="task"]')?.value.trim() || ''
          }
          if (node.type === 'work' || node.type === 'output') {
            const upstream = [...container.querySelectorAll('[data-upstream]:checked')].map(input => input.dataset.upstream)
            window.CanvasWorkflows.setIncoming(node.id, upstream)
          }
          window.CanvasWorkflows.updateNode(node.id, patch)
        }
        await window.CanvasWorkflows.flushPendingSave?.()
        showToast(node.type === 'input' ? '工作流配置已应用' : '节点配置已应用', 'success')
        window.CanvasView?.refreshWorkflow?.()
      } catch (error) {
        showToast(error?.message || (node.type === 'input' ? '工作流配置应用失败' : '节点配置应用失败'), 'error')
      }
    })

    container.querySelector('[data-field="modelKey"]')?.addEventListener('change', () => {
      if (node.type !== 'work') return
      window.CanvasWorkflows.updateNode(node.id, readWorkModelPatch(container, node))
      window.CanvasView?.refreshWorkflow?.()
    })

    container.querySelector('[data-delete-node]')?.addEventListener('click', async () => {
      if (!window.CanvasWorkflows.removeNode(node.id)) return
      window.closeCanvasInspector?.()
      window.CanvasView?.refreshWorkflow?.()
    })

  }

  function bindCommonActions(container, session, agent) {
    container.querySelectorAll('[data-stop-node]').forEach(button => button.addEventListener('click', async () => {
      showToast('多 AI 协作已移除，画布不再派发子代理。', 'info')
    }))

    container.querySelectorAll('[data-retry-node]').forEach(button => button.addEventListener('click', async () => {
      showToast('多 AI 协作已移除，画布不再派发子代理。', 'info')
    }))

    container.querySelector('[data-open-report]')?.addEventListener('click', event => {
      const filePath = event.currentTarget.dataset.openReport
      openReportFile(filePath)
    })
  }

  function snapshotTimelineFolds(root) {
    const folds = { cards: {}, groups: {} }
    if (!root) return folds
    root.querySelectorAll('.tool-call-card[data-tool-call-id]').forEach(card => {
      const detail = card.querySelector('.tool-card-detail')
      if (detail) folds.cards[card.dataset.toolCallId] = detail.classList.contains('collapsed')
    })
    root.querySelectorAll('.tool-call-group').forEach((group, index) => {
      const list = group.querySelector('.tool-group-list')
      if (list) folds.groups[index] = list.classList.contains('collapsed')
    })
    return folds
  }

  function restoreTimelineFolds(root, folds) {
    if (!root || !folds) return
    root.querySelectorAll('.tool-call-card[data-tool-call-id]').forEach(card => {
      const id = card.dataset.toolCallId
      const detail = card.querySelector('.tool-card-detail')
      if (!detail || folds.cards[id] == null) return
      detail.classList.toggle('collapsed', folds.cards[id] === true)
    })
    root.querySelectorAll('.tool-call-group').forEach((group, index) => {
      const list = group.querySelector('.tool-group-list')
      if (!list || folds.groups[index] == null) return
      list.classList.toggle('collapsed', folds.groups[index] === true)
    })
  }

  function patchTeamContext(teamRoot, session, agent) {
    const ctx = teamRoot.querySelector('[data-team-context]')
    if (!ctx) return
    const key = contextContentKey(session, agent)
    if (ctx.dataset.ctxKey === key) return
    ctx.dataset.ctxKey = key
    ctx.innerHTML = renderTeamContext(session, agent)
  }

  function updateRuntimeAreas(session) {
    if (!state.container || !state.payload) return false
    if (session?.executionKind === 'team') {
      const agent = getAgent(session, state.payload.nodeId)
      const teamRoot = state.container.querySelector('[data-team-run]')
      if (!agent || !teamRoot) return false
      const statusEl = teamRoot.querySelector('.team-run-head .canvas-inspector-status')
      if (statusEl) {
        statusEl.dataset.status = agent.status || ''
        statusEl.textContent = getStatusLabel(agent.status)
      }
      const durationEl = teamRoot.querySelector('.team-run-duration')
      const duration = formatRunDuration(agent)
      if (durationEl && duration) durationEl.textContent = duration
      const timeline = teamRoot.querySelector('[data-inspector-timeline]')
      if (timeline) {
        const folds = snapshotTimelineFolds(timeline)
        const html = renderInterleavedTimeline(session, agent)
        if (timeline.dataset.timelineKey !== html) {
          timeline.dataset.timelineKey = html
          timeline.innerHTML = html
          restoreTimelineFolds(timeline, folds)
        }
      }
      patchTeamContext(teamRoot, session, agent)
      return true
    }
    const workflow = getVisibleWorkflow(session)
    const savedNode = workflow?.nodes?.find(item => item.id === state.payload.nodeId)
    const runtimeAgent = getAgent(session, state.payload.nodeId)
    const nodeId = savedNode?.id || runtimeAgent?.id || state.payload.nodeId
    const agent = getAgent(session, nodeId)
    if (!agent) return false
    const runtimeEl = state.container.querySelector('[data-inspector-runtime]')
    const topActions = state.container.querySelector('[data-inspector-top-actions]')
    if (!runtimeEl || !topActions) return false
    runtimeEl.innerHTML = renderRuntime(session, agent)
    topActions.innerHTML = renderTopActions(agent, session)
    bindCommonActions(state.container, session, agent)
    return true
  }

  function bindInteractionGuard(container) {
    if (container.dataset.inspectorInteractionGuard === 'true') return
    container.dataset.inspectorInteractionGuard = 'true'
    container.addEventListener('focusin', event => {
      if (!isEditingElement(event.target)) return
      state.interactionDepth += 1
    })
    container.addEventListener('focusout', event => {
      if (!isEditingElement(event.target)) return
      state.interactionDepth = Math.max(0, state.interactionDepth - 1)
      scheduleDeferredRefresh()
    })
    container.addEventListener('pointerdown', event => {
      if (isEditingElement(event.target)) state.interactionDepth += 1
      else state.pointerHold += 1
      clearTimeout(state.refreshTimer)
    }, true)
    container.addEventListener('pointerup', event => {
      if (!isEditingElement(event.target)) return
      state.interactionDepth = Math.max(0, state.interactionDepth - 1)
      scheduleDeferredRefresh()
    }, true)
  }

  function render(container, payload = {}) {
    if (!container) return
    const previousScroller = container.querySelector('.canvas-inspector')
    const previousScrollTop = previousScroller ? previousScroller.scrollTop : 0
    state.container = container
    state.payload = payload
    const session = payload.session || window.CanvasView?.getSession?.() || null
    const workflow = getVisibleWorkflow(session)
    const runtimeAgent = getAgent(session, payload.nodeId)
    const savedNode = workflow?.nodes?.find(item => item.id === payload.nodeId)
    const teamRuntime = session?.executionKind === 'team'
    if (state.teamNodeId !== payload.nodeId) {
      state.teamNodeId = payload.nodeId || ''
      state.teamCtxOpenIds = new Set()
    }
    const runtimeOnly = teamRuntime || (!savedNode && !!runtimeAgent)
    const node = savedNode || (runtimeAgent ? {
      id: runtimeAgent.id,
      type: 'work',
      name: runtimeAgent.name || runtimeAgent.role || '协作节点'
    } : null)
    if (!node) {
      container.innerHTML = '<div class="canvas-inspector-empty">请选择一个画布节点</div>'
      return
    }
    const agent = getAgent(session, node.id)
    if (teamRuntime && agent) {
      container.innerHTML = renderTeamRun(session, agent)
      const ctx = container.querySelector('[data-team-context]')
      if (ctx) ctx.dataset.ctxKey = contextContentKey(session, agent)
      const timeline = container.querySelector('[data-inspector-timeline]')
      if (timeline) timeline.dataset.timelineKey = timeline.innerHTML
      bindTeamRun(container)
      bindCommonActions(container, session, agent)
      bindInteractionGuard(container)
      const nextScroller = container.querySelector('.canvas-inspector')
      if (nextScroller && previousScrollTop > 0) {
        requestAnimationFrame(() => {
          nextScroller.scrollTop = Math.min(previousScrollTop, nextScroller.scrollHeight - nextScroller.clientHeight)
        })
      }
      return
    }
    container.innerHTML = `
      <div class="canvas-inspector">
        <header class="canvas-inspector-header">
          <div class="canvas-inspector-heading">
            <span class="canvas-inspector-eyebrow">${teamRuntime ? (node.id === 'task' ? '你的任务' : node.id === 'ceo' ? 'CEO 汇总' : '队员') : (node.type === 'work' ? 'WORK 节点' : node.type === 'input' ? '工作流' : '交付节点')}</span>
            <h2>${escapeHtml(node.name)}</h2>
            ${agent?.retryCount ? `<small>已重试 ${Number(agent.retryCount)} 次</small>` : ''}
          </div>
          <div class="canvas-inspector-header-actions">
            <span class="canvas-inspector-kind">${teamRuntime ? escapeHtml(node.id === 'task' || node.id === 'ceo' ? node.name : (agent?.role || node.name)) : escapeHtml(node.type)}</span>
            <div class="canvas-inspector-top-actions" data-inspector-top-actions>${renderTopActions(agent, session)}</div>
          </div>
        </header>
        ${renderRuntimeShell(session, agent)}
        <section class="canvas-inspector-section canvas-inspector-config-section">
          <div class="canvas-inspector-section-head"><h3>${runtimeOnly ? '节点任务' : '节点配置'}</h3><span>属性</span></div>
        ${runtimeOnly || teamRuntime ? renderRuntimeTask(runtimeAgent || { task: node.task, modelName: '跟随主模型' }) : renderWorkflowFields(workflow, node)}
        </section>
        ${runtimeOnly || teamRuntime ? '' : `<footer class="canvas-inspector-actions">
          ${node.type === 'work' ? '<button type="button" class="canvas-inspector-delete" data-delete-node>删除节点</button>' : '<span></span>'}
          <button type="button" class="canvas-inspector-save" data-save-node>保存配置</button>
        </footer>`}
      </div>
    `
    if (!runtimeOnly && !teamRuntime) bind(container, workflow, node, session, agent)
    else {
      bindCommonActions(container, session, runtimeAgent)
    }
    bindInteractionGuard(container)
    const nextScroller = container.querySelector('.canvas-inspector')
    if (nextScroller && previousScrollTop > 0) {
      requestAnimationFrame(() => {
        nextScroller.scrollTop = Math.min(previousScrollTop, nextScroller.scrollHeight - nextScroller.clientHeight)
      })
    }
  }

  function refresh(session = null) {
    if (!state.container || !state.payload) return
    const nextSession = session || state.payload.session
    state.pendingSession = nextSession
    if (state.interactionDepth > 0 || state.pointerHold > 0) return
    state.pendingSession = null
    if (updateRuntimeAreas(nextSession)) {
      state.payload = { ...state.payload, session: nextSession }
      return
    }
    render(state.container, { ...state.payload, session: nextSession })
  }

  function destroy() {
    clearTimeout(state.refreshTimer)
    state.container = null
    state.payload = null
    state.pendingSession = null
    state.interactionDepth = 0
    state.pointerHold = 0
    state.refreshTimer = null
  }

  window.addEventListener('pointerup', () => {
    if (!state.container || state.pointerHold <= 0) return
    state.pointerHold = 0
    scheduleDeferredRefresh()
  }, true)
  window.addEventListener('pointercancel', () => {
    if (!state.container || state.pointerHold <= 0) return
    state.pointerHold = 0
    scheduleDeferredRefresh()
  }, true)

  window.CanvasInspector = { render, refresh, destroy }
})()
