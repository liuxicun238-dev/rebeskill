// 发送按钮：空闲发送 / 执行中中断 / 有字进队列。不碰运行中冻结与虚拟滚动。
(function () {
  'use strict'

  let deps = {}

  function getInputBox() {
    return deps.getInputBox?.()
  }

  function getQuotedArtifacts() {
    return deps.getQuotedArtifacts?.() || []
  }

  function getCurrentAiMsg() {
    return deps.getCurrentAiMsg?.()
  }

  function setLivePointersEmpty() {
    deps.setCurrentAiMsg?.(null)
    deps.setCurrentToolCount?.(0)
    deps.setCurrentOpCount?.(0)
    deps.setCurrentThinkingBlock?.(null)
  }

  function rememberInterruptedTurn(project, sessionId) {
    if (!project || !Array.isArray(project.messagesHistory)) return
    const history = project.messagesHistory
    let latestUserIndex = -1
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.role === 'user' && !history[index]?.hidden) {
        latestUserIndex = index
        break
      }
    }
    if (latestUserIndex < 0) return
    const alreadyInterrupted = history.slice(latestUserIndex + 1).some(item =>
      item?.role === 'assistant' && (
        item.interrupted === true || String(item.content || '').trim() === '[已中断]'
      )
    )
    if (alreadyInterrupted) return

    const completedAt = Date.now()
    const startedAt = Number(project.aiRunStartedAt || project._aiState?.aiRunStartedAt || completedAt)
    const currentAiMsg = getCurrentAiMsg()
    const visibleReasoning = currentAiMsg && document.contains(currentAiMsg)
      ? Array.from(currentAiMsg.querySelectorAll('.ai-deep-reasoning-content'))
        .map(element => String(element.dataset?.rawReasoning || element.textContent || '').trim())
        .filter(Boolean)
        .join('\n\n')
      : ''
    const interruptedMarker = {
      role: 'assistant',
      content: '[已中断]',
      interrupted: true,
      modelName: deps.getProjectModelName?.(project) || '',
      chatSessionId: sessionId || project.chatSessionId || '',
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      time: new Date(completedAt).toISOString(),
      localRecoveryMarker: true
    }
    if (visibleReasoning) interruptedMarker.reasoning_content = visibleReasoning
    history.push(interruptedMarker)
    project.history = deps.mapMessagesHistoryForProject?.(history) || project.history
  }

  async function applyComposerDraft(draft) {
    if (!draft) return
    const inputBox = getInputBox()
    const existingText = String(inputBox?.value || '')
    const merged = window.UserMessageDraft?.mergeComposerText?.(existingText, draft.text) ?? (draft.text || existingText)
    if (inputBox) inputBox.value = merged
    try { deps.getTextInputUI?.()?.autoResize?.() } catch (_) {}
    if (Array.isArray(draft.attachments) && draft.attachments.length) {
      try {
        await deps.getAttachmentStore?.()?.restoreFiles?.(draft.attachments, window.api)
        deps.syncUploadedFiles?.()
        deps.renderUploadedFiles?.()
      } catch (error) {
        console.warn('[Frontend] restore recalled attachments failed:', error)
      }
    }
    if (Array.isArray(draft.references) && draft.references.length) {
      const existing = getQuotedArtifacts()
      for (const ref of draft.references) {
        const key = ref._key || (ref.type === 'summary'
          ? `summary:${ref.summaryId}`
          : `message:${ref.part}:${ref.turnId}`)
        if (existing.some(item => item._key === key)) continue
        existing.push({ ...ref, _key: key })
      }
      try { deps.renderArtifactRefs?.() } catch (_) {}
    }
    try { deps.updateSendBtnState?.() } catch (_) {}
    try { inputBox?.focus?.() } catch (_) {}
  }

  function removeUnstartedTurnDom() {
    const currentAiMsg = getCurrentAiMsg()
    if (currentAiMsg && document.contains(currentAiMsg)) {
      currentAiMsg.remove()
    }
    const chatMessages = deps.getChatMessages?.()
    const nodes = chatMessages?.querySelectorAll?.('.message.user')
    const lastUser = nodes?.[nodes.length - 1]
    if (lastUser && !lastUser.classList.contains('message-user-interject')) {
      lastUser.remove()
    }
  }

  function popUnstartedUserFromProject(project) {
    const popped = window.UserMessageDraft?.popLastVisibleUser?.(project.messagesHistory)
    if (popped?.popped) {
      project.messagesHistory = popped.history
      project.history = deps.mapMessagesHistoryForProject?.(popped.history) || project.history
    } else if (Array.isArray(project.history)) {
      const fallback = window.UserMessageDraft?.popLastVisibleUser?.(project.history)
      if (fallback?.popped) project.history = fallback.history
    }
  }

  async function recallUnstartedTurn(project) {
    window.UserMessageDraft?.bumpSendEpoch?.(project)
    const draft = window.UserMessageDraft?.takePendingDraft?.(project)
    project.ignoreIncomingAiEvents = true
    const interruptedSessionId = project._runningSessionId || project.chatSessionId || ''
    popUnstartedUserFromProject(project)
    removeUnstartedTurnDom()
    project.isRunning = false
    deps.setProjectActivity?.(project, '', { sessionId: interruptedSessionId })
    project._runningSessionId = ''
    project.aiOperations = []
    deps.clearAiRuntimeForProject?.(project)
    deps.updateSendBtnState?.()
    if (window.api) window.api.interruptAi?.(project.id, { recallUnstarted: true })
    deps.setAutoFollowCurrentRun?.(false)
    setLivePointersEmpty()
    project.savedAiMsg = null
    project.aiRunningState = null
    project.aiRunStartedAt = 0
    if (project._aiState) {
      project._aiState.aiRunStartedAt = 0
      project._aiState.currentAiMsg = null
      project._aiState.currentToolCount = 0
      project._aiState.currentOpCount = 0
    }
    deps.syncAiStateToProject?.()
    deps.getAiAskPopup?.()?.classList.remove('show')
    await applyComposerDraft(draft)
    return true
  }

  function interruptAi() {
    const project = deps.getActiveProject?.()
    if (!project || !project.isRunning) return false
    if (deps.getContextCompressionInFlight?.()) {
      deps.showToast?.('正在整理上下文，稍等一下再中断。', 'info')
      return false
    }
    if (window.UserMessageDraft?.canRecallUnstartedTurn?.(project)) {
      void recallUnstartedTurn(project)
      return true
    }
    const interruptedSessionId = project._runningSessionId || project.chatSessionId || ''
    rememberInterruptedTurn(project, interruptedSessionId)
    project.isRunning = false
    deps.setProjectActivity?.(project, '', {
      sessionId: interruptedSessionId
    })
    project._runningSessionId = ''
    project.aiOperations = []
    deps.clearAiRuntimeForProject?.(project)
    deps.updateSendBtnState?.()
    if (window.api) window.api.interruptAi?.(project.id)
    deps.setAutoFollowCurrentRun?.(false)
    const currentAiMsg = getCurrentAiMsg()
    if (currentAiMsg && document.contains(currentAiMsg)) {
      deps.finishStreamingOnInterrupt?.()
      deps.updateWorkStatus?.('interrupted')
    }
    setLivePointersEmpty()
    project.savedAiMsg = null
    project.aiRunningState = null
    project.aiRunStartedAt = 0
    if (project._aiState) {
      project._aiState.aiRunStartedAt = 0
      project._aiState.currentAiMsg = null
      project._aiState.currentToolCount = 0
      project._aiState.currentOpCount = 0
    }
    deps.syncAiStateToProject?.()
    deps.getAiAskPopup?.()?.classList.remove('show')
    return true
  }

  function isActiveSessionTheRunningSession() {
    const project = deps.getActiveProject?.()
    if (!project || !project.isRunning) return false
    const runningId = String(project._runningSessionId || '')
    if (!runningId) return true
    const activeId = String(project.chatSessionId || '')
    return runningId === activeId
  }

  function enqueueCurrentInputToQueue() {
    const project = deps.getActiveProject?.()
    const inputBox = getInputBox()
    if (!project || !project.isRunning) return false
    if (!window.MessageQueue) return false
    const rawText = String(inputBox?.value || '').trim()
    const files = deps.getAttachmentStore?.()?.getFiles?.() || []
    const quotedArtifacts = getQuotedArtifacts()
    const refs = quotedArtifacts.slice()
    const hasContent = !!rawText || files.length > 0 || refs.length > 0
    if (!hasContent) return false

    const item = window.MessageQueue.enqueue(rawText, {
      attachments: files,
      references: refs
    })
    if (!item) return false

    if (inputBox) inputBox.value = ''
    try {
      deps.getAttachmentStore?.()?.clearFiles?.()
      deps.renderUploadedFiles?.()
    } catch (_) {}
    quotedArtifacts.length = 0
    try { deps.renderArtifactRefs?.() } catch (_) {}

    deps.updateSendBtnState?.()
    const stats = window.MessageQueue.getStats()
    deps.showToast?.(`已加入排队队列（共 ${stats.normal + stats.interject} 条）`, 'info')
    try { inputBox?.focus() } catch (_) {}
    return true
  }

  async function sendOrInterruptWithLatestInput() {
    const project = deps.getActiveProject?.()
    const inputBox = getInputBox()
    const quotedArtifacts = getQuotedArtifacts()
    if (!project) {
      deps.sendMessage?.()
      return
    }
    const hasLatestInput = !!String(inputBox?.value || '').trim() ||
      (deps.getAttachmentStore?.()?.getFiles?.() || []).length > 0 ||
      quotedArtifacts.length > 0
    if (project.isRunning && isActiveSessionTheRunningSession()) {
      if (!hasLatestInput) {
        interruptAi()
        return
      }
      enqueueCurrentInputToQueue()
      return
    }
    if (project.isRunning) {
      deps.showToast?.('这个项目的另一个会话正在执行，等它完成后再从当前会话发送，避免把原任务顶掉。', 'info')
      return
    }
    deps.sendMessage?.()
  }

  function drainQueueAfterAiFinish() {
    if (!window.MessageQueue) return
    const next = window.MessageQueue.drainNextNormal()
    if (!next) return
    const project = deps.getActiveProject?.()
    if (!project || project.isRunning) return
    try {
      deps.sendMessage?.({
        displayMessage: next.content,
        aiMessage: next.content,
        references: next.references || [],
        hidden: !!next.hidden,
        fromQueue: true
      })
    } catch (err) {
      console.warn('[MessageQueue] drain send failed:', err)
    }
  }

  function bindMessageQueue() {
    if (!window.MessageQueue || window.MessageQueue.__bound) return
    window.MessageQueue.__bound = true
    window.MessageQueue.bind({
      getProjects: () => deps.getProjects?.() || [],
      getActiveProjectId: () => deps.getActiveProjectId?.(),
      getInputBox,
      clearInputBox: () => {
        const inputBox = getInputBox()
        if (inputBox) inputBox.value = ''
      },
      sendMessageDirect: (options = {}) => {
        deps.sendMessage?.(Object.assign({ allowWhileRunning: true, fromQueue: true }, options))
      },
      addUserMessageToChat: (content, options = {}) => {
        try {
          return deps.getChatRenderer?.()?.addUserMessage?.(content, options) || null
        } catch (err) {
          console.warn('[MessageQueue] addUserMessageToChat failed:', err)
          return null
        }
      },
      promoteInterjectToBackend: (item) => {
        try {
          if (typeof window.api?.notifyInterjectMessage !== 'function') {
            console.error('[MessageQueue] notifyInterjectMessage NOT available on window.api, keys:', Object.keys(window.api || {}).join(', ').slice(0, 200))
            return
          }
          window.api.notifyInterjectMessage({
            projectId: deps.getActiveProjectId?.(),
            itemId: item.id,
            content: item.content,
            createdAt: item.createdAt
          })
          window.AppLogger?.debug?.('[MessageQueue] notifyInterjectMessage OK for', item.id)
        } catch (err) {
          console.warn('[MessageQueue] notifyInterjectMessage failed:', err)
        }
      },
      showToast: (msg, type) => { try { deps.showToast?.(msg, type) } catch (_) {} }
    })
    window.MessageQueue.render()
  }

  function bindReplyDrain() {
    if (window.api && typeof window.api.onReply === 'function') {
      try {
        window.api.onReply((data) => {
          if (data && data.done) drainQueueAfterAiFinish()
        })
      } catch (_) {}
    }
  }

  function bind(depsObj = {}) {
    deps = depsObj
    bindMessageQueue()
    bindReplyDrain()
    window.interruptAi = interruptAi
    window.sendOrInterruptWithLatestInput = sendOrInterruptWithLatestInput
  }

  window.SendInterruptQueue = {
    bind,
    interruptAi,
    sendOrInterruptWithLatestInput,
    isActiveSessionTheRunningSession,
    drainQueueAfterAiFinish,
    enqueueCurrentInputToQueue
  }
})()
