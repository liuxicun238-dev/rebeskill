(function () {
  const SKIP_TOOL_NAMES = new Set([
    'inspect_image',
    'report_progress',
    'start_final_reply',
    'show_thinking_note',
    'complete_step',
    'create_inline_visual',
    'delegate_agents'
  ])

  function clonePlain(value) {
    if (Array.isArray(value)) return value.map(item => clonePlain(item))
    if (value && typeof value === 'object') {
      const next = {}
      for (const [key, item] of Object.entries(value)) {
        if (key === 'file' && item && typeof item === 'object') continue
        next[key] = item
      }
      return next
    }
    return value
  }

  function snapshotDraft(options = {}) {
    const text = String(options.text || '').trim()
    const attachments = clonePlain(options.attachments || [])
    const references = clonePlain(options.references || [])
    if (!text && attachments.length === 0 && references.length === 0) return null
    return {
      text,
      attachments,
      references,
      hidden: options.hidden === true
    }
  }

  function canRecallUnstartedTurn(project) {
    if (!project || project._pendingRecallDraft == null) return false
    if (project._pendingRecallDraft.hidden) return false
    if (project._turnHasStartedWork === true) return false
    return true
  }

  function markTurnStarted(project, reason = '') {
    if (!project) return false
    const name = String(reason || '')
    if (name && (SKIP_TOOL_NAMES.has(name) || window.ChatRenderer?.isInternalUiOnlyTool?.(name))) {
      return false
    }
    project._turnHasStartedWork = true
    return true
  }

  function shouldIgnoreStartReason(name = '') {
    const value = String(name || '')
    return !value || SKIP_TOOL_NAMES.has(value)
  }

  function beginSendEpoch(project, draft) {
    if (!project) return 0
    project._sendEpoch = Number(project._sendEpoch || 0) + 1
    project._pendingRecallDraft = draft || null
    project._turnHasStartedWork = false
    project._recallUnstarted = false
    return project._sendEpoch
  }

  function bumpSendEpoch(project) {
    if (!project) return 0
    project._sendEpoch = Number(project._sendEpoch || 0) + 1
    return project._sendEpoch
  }

  function isCurrentSendEpoch(project, epoch) {
    return !!project && Number(project._sendEpoch || 0) === Number(epoch)
  }

  function takePendingDraft(project) {
    if (!project) return null
    const draft = project._pendingRecallDraft || null
    project._pendingRecallDraft = null
    project._recallUnstarted = true
    return draft
  }

  function popLastVisibleUser(history) {
    const list = Array.isArray(history) ? history.slice() : []
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index]?.role === 'user' && !list[index]?.hidden) {
        list.splice(index, 1)
        return { popped: true, history: list, index }
      }
    }
    return { popped: false, history: list, index: -1 }
  }

  function mergeComposerText(existing, incoming) {
    const current = String(existing || '')
    const next = String(incoming || '')
    if (current.trim() && next.trim()) return `${next}\n${current}`
    return next || current
  }

  window.UserMessageDraft = {
    snapshotDraft,
    canRecallUnstartedTurn,
    markTurnStarted,
    shouldIgnoreStartReason,
    beginSendEpoch,
    bumpSendEpoch,
    isCurrentSendEpoch,
    takePendingDraft,
    popLastVisibleUser,
    mergeComposerText
  }
})()
