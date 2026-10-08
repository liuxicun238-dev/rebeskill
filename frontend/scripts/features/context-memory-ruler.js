// Model-aware context budget indicator shown in the chat input footer.
(function () {
  'use strict'

  const HOST_SELECTOR = '.chat-input-footer'
  const NODE_ID = 'contextMemoryStack'
  const POP_ID = 'contextMemoryStackPop'
  const VISIBILITY_KEY = 'lingxiContextCompressionStackVisible'
  const LEGACY_VISIBILITY_KEYS = [
    'contextMemoryStackVisible',
    'contextCompressionStackVisible',
    'showContextMemoryStack',
    'showContextCompressionStack',
    'lingxiContextMemoryStackVisible'
  ]

  const EMPTY_STATE = Object.freeze({
    projectId: '',
    modelName: '当前模型',
    maxContextTokens: 0,
    inputBudgetTokens: 0,
    hardInputTokens: 0,
    outputReserveTokens: 0,
    safetyTokens: 0,
    estimatedInputTokens: 0,
    latestTurnTokens: 0,
    rawVisibleTokens: 0,
    modelProjectedTokens: 0,
    crossModelSavedTokens: 0,
    epochSavedTokens: 0,
    collapsedForeignTurns: 0,
    removedToolMessages: 0,
    removedReasoningChars: 0,
    latestRunId: '',
    latestTurnId: '',
    latestRunStatus: 'unknown',
    latestTurnItemCount: 0,
    latestTurnToolCount: 0,
    latestTurnEvidenceAvailable: false,
    latestTurnCompletedAt: '',
    followupExpansionIntent: false,
    pendingTokens: 0,
    triggerTokens: 0,
    retainTokens: 0,
    summaryCount: 0,
    compressionEpoch: 1,
    usageRatio: 0,
    compressionRatio: 0,
    status: 'safe',
    loading: false,
    compressionRunning: false,
    readFailed: false,
    readError: '',
    temporaryHidden: false,
    surgeTokens: 0
  })

  const state = { ...EMPTY_STATE }
  let getActiveProjectFn = null
  let getProjectModelFn = null
  let currentPop = null
  let currentNode = null
  let retryTimer = null
  let eventRefreshTimer = null
  let livePollTimer = null
  let refreshAfterFlight = false
  let lastRefreshStartedAt = 0
  let refreshToken = 0
  let lastSeenEstimatedTokens = 0

  function bind(deps = {}) {
    if (typeof deps.getActiveProject === 'function') getActiveProjectFn = deps.getActiveProject
    if (typeof deps.getProjectModel === 'function') getProjectModelFn = deps.getProjectModel
  }

  function resetState(projectId = '') {
    Object.assign(state, EMPTY_STATE, { projectId })
    lastSeenEstimatedTokens = 0
  }

  function parseVisibility(value) {
    if (value == null || value === '') return null
    if (typeof value === 'boolean') return value
    const text = String(value).trim().toLowerCase()
    if (['false', '0', 'off', 'no', 'hidden', 'hide', 'disabled'].includes(text)) return false
    if (['true', '1', 'on', 'yes', 'visible', 'show', 'enabled'].includes(text)) return true
    return null
  }

  function readSettingsVisibility() {
    try {
      const raw = localStorage.getItem('lingxi_settings')
      if (!raw) return null
      const data = JSON.parse(raw)
      if (!data || typeof data !== 'object') return null
      const candidates = [
        data.lingxiContextCompressionStackVisible,
        data.lingxiContextMemoryStackVisible,
        data.contextCompressionStackVisible,
        data.contextMemoryStackVisible,
        data.showContextCompressionStack,
        data.showContextMemoryStack,
        data.ui?.contextCompressionStackVisible,
        data.ui?.contextMemoryStackVisible,
        data.features?.contextCompressionStackVisible,
        data.features?.contextMemoryStackVisible
      ]
      for (const item of candidates) {
        const parsed = parseVisibility(item)
        if (parsed != null) return parsed
      }
    } catch {}
    return null
  }

  function isVisibleEnabled() {
    try {
      for (const key of [VISIBILITY_KEY, ...LEGACY_VISIBILITY_KEYS]) {
        const parsed = parseVisibility(localStorage.getItem(key))
        if (parsed != null) return parsed
      }
      const settingsVisibility = readSettingsVisibility()
      if (settingsVisibility != null) return settingsVisibility
    } catch {}
    return true
  }

  function isWelcomeViewActive() {
    const welcome = document.getElementById('welcomeScreen')
    return !!(welcome && !welcome.classList.contains('hidden') && welcome.offsetParent !== null)
  }

  function isWelcomeComposerPinned() {
    const composer = document.querySelector('.welcome-screen-composer')
    return !!(composer && !composer.classList.contains('hidden'))
  }

  function refreshTemporaryHiddenFromLayout() {
    const welcomeActive = isWelcomeViewActive()
    const composerPinned = isWelcomeComposerPinned()
    state.temporaryHidden = welcomeActive && !composerPinned
    return state.temporaryHidden
  }

  function shouldRender() {
    const activeProject = getActiveProject()
    if (!activeProject) return false
    const bodyClasses = document.body?.classList || { contains: () => false }
    if (bodyClasses.contains('welcome-visible')
      && !bodyClasses.contains('welcome-has-project')
      && !bodyClasses.contains('welcome-composer-pinned')
      && !bodyClasses.contains('welcome-composer-has-project')) {
      return false
    }
    return isVisibleEnabled() && !state.temporaryHidden
  }

  function getActiveProject() {
    try {
      if (getActiveProjectFn) return getActiveProjectFn() || null
      if (typeof window.getActiveProject === 'function') return window.getActiveProject() || null
      return window.LingxiApp?.getActiveProject?.() || null
    } catch {
      return null
    }
  }

  function getProjectId() {
    const project = getActiveProject()
    if (project?.id) return String(project.id)
    try {
      return String(window.LingxiProjectState?.getActiveProjectId?.() || '')
    } catch {
      return ''
    }
  }

  function normalizeSessionId(value) {
    return String(value || '').trim()
  }

  function eventBelongsToActiveScope(data = {}) {
    const project = getActiveProject()
    if (!project) return false
    if (data.projectId && String(data.projectId) !== String(project.id || '')) return false
    const eventSessionId = normalizeSessionId(data.chatSessionId || data.sessionId)
    const activeSessionId = normalizeSessionId(project.chatSessionId)
    return !eventSessionId || !activeSessionId || eventSessionId === activeSessionId
  }

  function isActiveSessionRunning() {
    const project = getActiveProject()
    if (!project || !project.isRunning) return false
    const runningSessionId = normalizeSessionId(project._runningSessionId)
    const activeSessionId = normalizeSessionId(project.chatSessionId)
    return !runningSessionId || !activeSessionId || runningSessionId === activeSessionId
  }

  function getModelDescriptor() {
    const project = getActiveProject()
    let model = null
    try {
      model = getProjectModelFn ? getProjectModelFn(project) : null
    } catch {}
    if (!model || typeof model !== 'object') {
      return { modelName: String(project?.currentModelName || '') }
    }
    return {
      modelName: model.modelName || model.displayName || model.modelId || '',
      displayName: model.displayName || '',
      modelId: model.modelId || model.model || '',
      modelKey: model.modelKey || '',
      provider: model.provider || model.platform || model.source || '',
      platform: model.platform || '',
      source: model.source || '',
      apiUrl: model.apiUrl || '',
      apiFormat: model.apiFormat || model.apiType || model.compatibility || '',
      useFullUrl: model.useFullUrl === true,
      fullUrl: model.fullUrl === true,
      apiUrlMode: model.apiUrlMode || '',
      contextWindow: model.contextWindow || model.contextLength || model.maxContextTokens || 0
    }
  }

  function formatTokens(value) {
    const count = Math.max(0, Number(value) || 0)
    if (count >= 1000000) {
      const scaled = count / 1000000
      return `${scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)}`.replace(/\.0+$|(?<=\.[0-9])0$/, '') + 'M'
    }
    if (count >= 1000) {
      const scaled = count / 1000
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}`.replace(/\.0$/, '') + 'K'
    }
    return String(Math.round(count))
  }

  function formatPercent(ratio) {
    return `${Math.max(0, Math.round((Number(ratio) || 0) * 100))}%`
  }

  function statusMeta() {
    if (state.readFailed) return { key: 'error', label: '读取失败', detail: state.readError || '暂时无法读取上下文状态' }
    if (state.compressionRunning) return { key: 'running', label: '正在整理', detail: '正在建立新的压缩纪元' }
    const map = {
      safe: { key: 'safe', label: state.summaryCount > 0 ? '稳定' : '安全', detail: '距离自动整理线还有充足余量' },
      watch: { key: 'watch', label: '接近整理线', detail: '继续执行时会自动准备压缩' },
      compressing: { key: 'compressing', label: '准备整理', detail: '即将建立新的压缩纪元' },
      urgent: { key: 'urgent', label: '空间紧张', detail: '下一次请求会优先压缩历史' }
    }
    return map[state.status] || map.safe
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]))
  }

  function computeBreakdown() {
    const budget = Math.max(1, state.inputBudgetTokens || 128000)
    const total = Math.max(0, state.estimatedInputTokens || 0)
    const latest = Math.min(total, Math.max(0, state.latestTurnTokens || 0))
    const remainder = Math.max(0, total - latest)

    // 估算拆分：系统提示约 2K~4K，其余归为工具/历史与对话
    const systemEst = Math.min(remainder, 3000)
    const historyRest = Math.max(0, remainder - systemEst)
    const toolsEst = Math.round(historyRest * 0.6)
    const chatEst = Math.max(0, historyRest - toolsEst)

    return {
      systemPct: ((systemEst / budget) * 100).toFixed(1),
      chatPct: ((chatEst / budget) * 100).toFixed(1),
      toolsPct: ((toolsEst / budget) * 100).toFixed(1),
      latestPct: ((latest / budget) * 100).toFixed(1),
      systemTokens: systemEst,
      chatTokens: chatEst,
      toolsTokens: toolsEst,
      latestTokens: latest
    }
  }

  function getNodeHtml() {
    const status = statusMeta()
    const ratio = Math.min(1, Math.max(0, Number(state.usageRatio) || 0))
    const pct = Math.round(ratio * 100)
    const circumference = 56.55
    const dashOffset = (circumference * (1 - ratio)).toFixed(2)

    return `
      <span class="cmring-wrap" aria-hidden="true">
        <svg class="cmring-svg" width="18" height="18" viewBox="0 0 24 24">
          <circle class="cmring-bg" cx="12" cy="12" r="9" fill="none" stroke-width="2.6"/>
          <circle class="cmring-bar" cx="12" cy="12" r="9" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}" transform="rotate(-90 12 12)"/>
        </svg>
      </span>
      <span class="cmring-pct">${pct}%</span>
    `
  }

  function buildNode() {
    const node = document.createElement('button')
    node.type = 'button'
    node.id = NODE_ID
    node.className = 'cmstack cmstack--ring'
    node.setAttribute('aria-haspopup', 'dialog')
    node.setAttribute('aria-expanded', 'false')
    node.innerHTML = getNodeHtml()
    return node
  }

  function metric(label, value, hint = '') {
    return `<div class="cmstack-pop__metric"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</div>`
  }

  function detailRow(label, value, tone = '') {
    return `<div class="cmstack-pop__row${tone ? ` cmstack-pop__row--${tone}` : ''}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`
  }

  function getPopupHtml() {
    const status = statusMeta()
    const compressionProgress = Math.min(100, Math.max(0, (Number(state.compressionRatio) || 0) * 100))
    const runStatusLabels = {
      running: '执行中',
      completed: '已完成',
      interrupted: '已中断',
      failed: '失败',
      recoverable: '待恢复',
      unknown: '暂无状态'
    }
    const latestRunStatus = runStatusLabels[state.latestRunStatus] || state.latestRunStatus || '暂无状态'
    const evidenceDetail = state.latestTurnEvidenceAvailable
      ? `${state.latestTurnToolCount} 个工具 · ${latestRunStatus}`
      : `暂无工具证据 · ${latestRunStatus}`
    const followupDetail = state.followupExpansionIntent
      ? '本轮详细追问将保留最近 Turn 的工具证据'
      : '普通请求按模型窗口和压缩纪元裁剪'
    const modelSavings = state.crossModelSavedTokens > 0
      ? detailRow(`跨模型交接 · 已精简 ${state.collapsedForeignTurns} 个完成任务`, `-${formatTokens(state.crossModelSavedTokens)}`, 'saved')
      : detailRow('同模型连续执行', '保留稳定前缀', 'stable')
    const summaryText = state.summaryCount > 0 ? `${state.summaryCount} 份摘要` : '尚未生成摘要'
    const readError = state.readFailed
      ? `<div class="cmstack-pop__error">${escapeHtml(state.readError || '上下文状态读取失败')}</div>`
      : ''

    const breakdown = computeBreakdown()
    const surgeHtml = state.surgeTokens >= 12000
      ? `<span class="cmstack-pop__surge-badge">单轮剧增 +${formatTokens(state.surgeTokens)}</span>`
      : ''

    return `
      <div class="cmstack-pop__head">
        <div class="cmstack-pop__model">
          <span class="cmstack-pop__model-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>
          </span>
          <span><small>当前模型</small><b title="${escapeHtml(state.modelName)}">${escapeHtml(state.modelName)}</b></span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          ${surgeHtml}
          <span class="cmstack-pop__status cmstack-pop__status--${status.key}"><i></i>${status.label}</span>
        </div>
      </div>

      <div class="cmstack-pop__metrics">
        ${metric('当前历史', formatTokens(state.estimatedInputTokens), formatPercent(state.usageRatio))}
        ${metric('可用输入预算', formatTokens(state.inputBudgetTokens), '自动整理按此预算')}
        ${metric('模型总窗口', formatTokens(state.maxContextTokens), '含输出与安全余量')}
      </div>

      <div class="cmstack-pop__usage">
        <div class="cmstack-pop__usage-title">
          <span>上下文占用构成</span>
          <b>${formatTokens(state.estimatedInputTokens)} / ${formatTokens(state.inputBudgetTokens)}</b>
        </div>
        <div class="cmstack-pop__track cmstack-pop__track--${status.key}">
          <i>
            <span class="cmstack-pop__seg cmstack-pop__seg--system" style="width:${breakdown.systemPct}%" title="系统: ${formatTokens(breakdown.systemTokens)}"></span>
            <span class="cmstack-pop__seg cmstack-pop__seg--chat" style="width:${breakdown.chatPct}%" title="对话: ${formatTokens(breakdown.chatTokens)}"></span>
            <span class="cmstack-pop__seg cmstack-pop__seg--tools" style="width:${breakdown.toolsPct}%" title="工具/文件: ${formatTokens(breakdown.toolsTokens)}"></span>
            <span class="cmstack-pop__seg cmstack-pop__seg--latest" style="width:${breakdown.latestPct}%" title="最新轮: ${formatTokens(breakdown.latestTokens)}"></span>
          </i>
          <span class="cmstack-pop__threshold" title="75% 自动整理线"></span>
        </div>
        <div class="cmstack-pop__usage-caption">
          <span>蓝:系统 · 绿:对话 · 橙:工具文件 · 紫:最新轮</span>
          <span>整理线 75%</span>
        </div>
      </div>

      <div class="cmstack-pop__section">
        <div class="cmstack-pop__section-title"><span>本次模型实际会接收什么</span><em>估算</em></div>
        ${detailRow('最近一轮内容', formatTokens(state.latestTurnTokens))}
        ${detailRow('最近一轮执行事实', evidenceDetail, state.latestTurnEvidenceAvailable ? 'saved' : '')}
        ${detailRow('上下文策略', followupDetail, state.followupExpansionIntent ? 'saved' : '')}
        ${modelSavings}
        ${detailRow('输出预留', formatTokens(state.outputReserveTokens))}
        ${detailRow('安全余量', formatTokens(state.safetyTokens))}
      </div>

      <div class="cmstack-pop__section">
        <div class="cmstack-pop__section-title"><span>压缩纪元</span><em>第 ${state.compressionEpoch} 纪元</em></div>
        <div class="cmstack-pop__epoch">
          <div><span>${summaryText}</span><b>${formatTokens(state.pendingTokens)} / ${formatTokens(state.triggerTokens)}</b></div>
          <div class="cmstack-pop__epoch-track"><i style="width:${compressionProgress}%"></i></div>
          <small>达到整理线后集中清理一次，之后围绕新前缀继续命中缓存。</small>
        </div>
      </div>

      ${readError}

      <div class="cmstack-pop__actions">
        <button type="button" class="cmstack-pop__action-btn" data-action="clear-context" title="重置当前会话的上下文与摘要缓存">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          重置上下文缓存
        </button>
        <button type="button" class="cmstack-pop__action-btn" data-action="refresh-now" title="立即重新计算并刷新 Token 统计">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>
          刷新计算
        </button>
      </div>

      <div class="cmstack-pop__foot">
        <span aria-hidden="true">ⓘ</span>
        <span>这里只调整发给模型的上下文。完整聊天记录仍保留；当前未完成的执行轮不会被压缩。</span>
      </div>
    `
  }

  function buildPopup() {
    const pop = document.createElement('div')
    pop.id = POP_ID
    pop.className = 'cmstack-pop'
    pop.setAttribute('role', 'dialog')
    pop.hidden = true
    pop.innerHTML = getPopupHtml()

    pop.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const action = btn.dataset.action
      const projectId = getProjectId()
      if (action === 'clear-context') {
        if (!projectId || !window.api?.clearContext) return
        btn.disabled = true
        btn.textContent = '正在清理...'
        try {
          await window.api.clearContext(projectId)
          window.showToast?.('已重置上下文缓存', 'success')
          await refreshData({ force: true })
        } catch (err) {
          window.showToast?.(err.message || '清理失败', 'error')
        } finally {
          btn.disabled = false
        }
      } else if (action === 'refresh-now') {
        btn.disabled = true
        await refreshData({ force: true })
        btn.disabled = false
      }
    })

    return pop
  }

  function render() {
    refreshTemporaryHiddenFromLayout()
    if (!shouldRender()) {
      removeStack()
      return
    }
    const node = document.getElementById(NODE_ID)
    if (node) {
      const status = statusMeta()
      const hasSurge = state.surgeTokens >= 12000
      node.className = `cmstack cmstack--ring cmstack--${status.key}${state.loading ? ' is-loading' : ''}${node.classList.contains('is-open') ? ' is-open' : ''}${hasSurge ? ' has-surge' : ''}`
      node.title = `上下文预算：${formatTokens(state.estimatedInputTokens)} / ${formatTokens(state.inputBudgetTokens)} (${formatPercent(state.usageRatio)})\n模型：${state.modelName}\n点击展开全景分析`
      node.innerHTML = getNodeHtml()
    }
    if (currentPop) currentPop.innerHTML = getPopupHtml()
  }

  function positionPopup(node, pop) {
    const rect = node.getBoundingClientRect()
    pop.style.visibility = 'hidden'
    pop.hidden = false
    const popRect = pop.getBoundingClientRect()
    let top = rect.top - popRect.height - 9
    let left = rect.left
    if (top < 8) top = rect.bottom + 9
    left = Math.min(Math.max(8, left), window.innerWidth - popRect.width - 8)
    pop.style.top = `${top}px`
    pop.style.left = `${left}px`
    pop.style.visibility = ''
  }

  function openPopup(node) {
    if (!currentPop) {
      currentPop = buildPopup()
      document.body.appendChild(currentPop)
    } else {
      currentPop.innerHTML = getPopupHtml()
    }
    positionPopup(node, currentPop)
    requestAnimationFrame(() => currentPop?.classList.add('is-visible'))
    node.classList.add('is-open')
    node.setAttribute('aria-expanded', 'true')
    currentNode = node
    document.addEventListener('mousedown', onDocDown, true)
    window.addEventListener('resize', onWinChange, true)
    window.addEventListener('scroll', onWinChange, true)
  }

  function closePopup() {
    if (!currentPop) return
    currentPop.classList.remove('is-visible')
    currentPop.hidden = true
    if (currentNode) {
      currentNode.classList.remove('is-open')
      currentNode.setAttribute('aria-expanded', 'false')
      currentNode = null
    }
    document.removeEventListener('mousedown', onDocDown, true)
    window.removeEventListener('resize', onWinChange, true)
    window.removeEventListener('scroll', onWinChange, true)
  }

  function onDocDown(event) {
    if (currentPop?.contains(event.target) || currentNode?.contains(event.target)) return
    closePopup()
  }

  function onWinChange() {
    if (currentNode && currentPop && !currentPop.hidden) positionPopup(currentNode, currentPop)
  }

  function removeStack() {
    closePopup()
    document.getElementById(NODE_ID)?.remove()
  }

  function mountStack() {
    refreshTemporaryHiddenFromLayout()
    if (!shouldRender()) {
      removeStack()
      return true
    }
    const host = document.querySelector(HOST_SELECTOR)
    if (!host) return false
    let node = document.getElementById(NODE_ID)
    if (node && node.parentElement === host) return true
    node?.remove()
    node = buildNode()
    const anchor = host.querySelector('#reasoningDropdown') || host.querySelector('#modelDropdown')
    if (anchor?.nextSibling) host.insertBefore(node, anchor.nextSibling)
    else host.appendChild(node)
    node.addEventListener('click', event => {
      event.stopPropagation()
      if (node.classList.contains('is-open')) closePopup()
      else openPopup(node)
    })
    render()
    return true
  }

  async function refreshData(options = {}) {
    refreshTemporaryHiddenFromLayout()
    const projectId = Object.prototype.hasOwnProperty.call(options, 'projectId')
      ? String(options.projectId || '')
      : getProjectId()
    if (!projectId) {
      resetState('')
      mountStack()
      render()
      return
    }
    if (state.projectId !== projectId) {
      resetState(projectId)
      mountStack()
      render()
    }
    if (!shouldRender()) {
      removeStack()
      return
    }
    if (typeof window.api?.getContextCompressionStack !== 'function') {
      if (options.retry !== false) scheduleRetry()
      return
    }
    if (state.loading && options.force !== true) {
      refreshAfterFlight = true
      return
    }

    const token = ++refreshToken
    lastRefreshStartedAt = Date.now()
    state.loading = true
    render()
    try {
      const result = await window.api.getContextCompressionStack(projectId, getModelDescriptor())
      if (token !== refreshToken || state.projectId !== projectId || getProjectId() !== projectId) return
      if (!result?.success) throw new Error(result?.error || '读取上下文状态失败')
      const numberKeys = [
        'maxContextTokens', 'inputBudgetTokens', 'hardInputTokens', 'outputReserveTokens', 'safetyTokens',
        'estimatedInputTokens', 'latestTurnTokens', 'rawVisibleTokens', 'modelProjectedTokens',
        'crossModelSavedTokens', 'epochSavedTokens', 'collapsedForeignTurns', 'removedToolMessages',
        'removedReasoningChars', 'latestTurnItemCount', 'latestTurnToolCount', 'pendingTokens',
        'triggerTokens', 'retainTokens', 'summaryCount',
        'compressionEpoch', 'usageRatio', 'compressionRatio'
      ]
      numberKeys.forEach(key => { state[key] = Math.max(0, Number(result[key]) || 0) })

      const currentEstimated = state.estimatedInputTokens || 0
      if (lastSeenEstimatedTokens > 0 && currentEstimated > lastSeenEstimatedTokens) {
        state.surgeTokens = currentEstimated - lastSeenEstimatedTokens
      } else {
        state.surgeTokens = 0
      }
      lastSeenEstimatedTokens = currentEstimated

      state.modelName = String(result.modelName || '当前模型')
      state.latestRunId = String(result.latestRunId || '')
      state.latestTurnId = String(result.latestTurnId || '')
      state.latestRunStatus = String(result.latestRunStatus || 'unknown')
      state.latestTurnEvidenceAvailable = result.latestTurnEvidenceAvailable === true
      state.latestTurnCompletedAt = String(result.latestTurnCompletedAt || '')
      state.followupExpansionIntent = result.followupExpansionIntent === true
      state.status = ['safe', 'watch', 'compressing', 'urgent'].includes(result.status) ? result.status : 'safe'
      state.readFailed = !!result.readFailed
      state.readError = String(result.readError || '')
    } catch (error) {
      if (token !== refreshToken || state.projectId !== projectId) return
      state.readFailed = true
      state.readError = error?.message || String(error)
    } finally {
      if (token === refreshToken && state.projectId === projectId) {
        state.loading = false
        render()
        if (currentNode && currentPop && !currentPop.hidden) positionPopup(currentNode, currentPop)
        if (refreshAfterFlight) {
          refreshAfterFlight = false
          scheduleLiveRefresh(120)
        }
      }
    }
  }

  function scheduleLiveRefresh(delay = 120) {
    if (!getProjectId() || !shouldRender()) return
    const elapsed = Date.now() - lastRefreshStartedAt
    const wait = Math.max(Number(delay) || 0, 750 - elapsed, 0)
    if (eventRefreshTimer) return
    eventRefreshTimer = setTimeout(() => {
      eventRefreshTimer = null
      refreshData({ retry: false })
    }, wait)
  }

  function startLivePolling() {
    if (livePollTimer) return
    livePollTimer = setInterval(() => {
      if (document.hidden || !getProjectId() || !shouldRender()) return
      const cadence = isActiveSessionRunning() ? 1500 : 10000
      if (Date.now() - lastRefreshStartedAt >= cadence) scheduleLiveRefresh(0)
    }, 750)
  }

  function scheduleRetry() {
    if (retryTimer || !getProjectId()) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      refreshData({ retry: false })
    }, 800)
  }

  function onActiveProjectChanged(event) {
    const nextId = event?.detail && Object.prototype.hasOwnProperty.call(event.detail, 'projectId')
      ? String(event.detail.projectId || '')
      : getProjectId()
    resetState(nextId)
    mountStack()
    if (nextId) refreshData({ retry: false, projectId: nextId } | {})
    else render()
  }

  function onModelChanged() {
    setTimeout(() => refreshData({ retry: false }), 0)
  }

  function init() {
    if (!mountStack()) {
      let tries = 0
      const timer = setInterval(() => {
        tries += 1
        if (mountStack() || tries > 60) clearInterval(timer)
      }, 250)
    }
    setTimeout(refreshData, 300)
    startLivePolling()
  }

  window.addEventListener('lingxi:active-project-changed', onActiveProjectChanged)
  window.addEventListener('lingxi:model-changed', onModelChanged)

  if (window.api && typeof window.api.onContextCompression === 'function') {
    window.api.onContextCompression(data => {
      const activeId = getProjectId()
      if (!data || !activeId || (data.projectId && data.projectId !== activeId)) return
      state.compressionRunning = data.status === 'running'
      render()
      if (data.status === 'done' || data.status === 'failed') refreshData({ retry: false, projectId: activeId })
    })
  }
  if (window.api && typeof window.api.onContextSplit === 'function') {
    window.api.onContextSplit(data => {
      const activeId = getProjectId()
      if (!data || !activeId || (data.projectId && data.projectId !== activeId)) return
      refreshData({ retry: false, projectId: activeId })
    })
  }
  if (window.api && typeof window.api.onAiStatus === 'function') {
    window.api.onAiStatus(data => {
      if (!eventBelongsToActiveScope(data)) return
      if (['thinking', 'streaming', 'using_tools', 'done', 'error', 'interrupted'].includes(data.status)) {
        scheduleLiveRefresh(data.status === 'using_tools' ? 80 : 180)
      }
    })
  }
  if (window.api && typeof window.api.onToolResult === 'function') {
    window.api.onToolResult(data => {
      if (eventBelongsToActiveScope(data)) scheduleLiveRefresh(100)
    })
  }
  if (window.api && typeof window.api.onTurnEvent === 'function') {
    window.api.onTurnEvent(data => {
      if (!eventBelongsToActiveScope(data)) return
      const delay = data?.type === 'turn-item-created' ? 60 : 120
      scheduleLiveRefresh(delay)
    })
  }
  if (window.api && typeof window.api.onAiCacheUsage === 'function') {
    window.api.onAiCacheUsage(data => {
      if (eventBelongsToActiveScope(data) && data?.phase !== 'request-start') scheduleLiveRefresh(220)
    })
  }
  if (window.api && typeof window.api.onReply === 'function') {
    window.api.onReply(data => {
      if (eventBelongsToActiveScope(data) && (data?.done || data?.error)) scheduleLiveRefresh(120)
    })
  }

  window.ContextCompressionStack = {
    bind,
    refresh: refreshData,
    clearForProjectSwitch: () => {
      resetState('')
      mountStack()
      render()
    },
    isVisible: isVisibleEnabled,
    isTemporaryHidden: () => !!state.temporaryHidden,
    setTemporaryHidden: hidden => {
      state.temporaryHidden = !!hidden
      if (state.temporaryHidden) removeStack()
      else if (isVisibleEnabled()) {
        mountStack()
        refreshData({ retry: false })
      }
    },
    setVisible: enabled => {
      try { localStorage.setItem(VISIBILITY_KEY, enabled ? 'true' : 'false') } catch {}
      if (enabled) {
        mountStack()
        refreshData()
      } else removeStack()
    },
    remount: () => {
      mountStack()
      refreshData()
    }
  }

  window.addEventListener('storage', event => {
    if (event.key === VISIBILITY_KEY || LEGACY_VISIBILITY_KEYS.includes(event.key || '')) {
      if (isVisibleEnabled()) window.ContextCompressionStack.remount()
      else removeStack()
    }
  })

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true })
  else init()
})()
