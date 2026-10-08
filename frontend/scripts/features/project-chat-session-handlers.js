// 同项目多会话：新建 / 切换 / 删除。
// 冻结运行中 UI、destroy 虚拟滚动、切会话贴底的顺序必须与原先 app.js 一致。
(function () {
  'use strict'

  let deps = {}

  function getChatMessages() {
    return deps.getChatMessages?.() || document.getElementById('chatMessages')
  }

  function captureRunningAiSnapshot(project, aiMsg, options) {
    const fn = deps.captureRunningAiSnapshot || window.AiRuntimeCache?.captureRunningAiSnapshot
    return fn?.(project, aiMsg, options)
  }

  async function confirmDeleteChatSession(title, isCurrent) {
    if (window.BranchDangerDialog?.show) {
      return !!(await window.BranchDangerDialog.show({
        targetName: title || '该会话',
        title: isCurrent ? '删除当前会话' : '删除会话',
        subtitle: isCurrent
          ? '将删除这个会话的聊天记录和上下文，并自动切换到其他会话。'
          : '将删除这个会话的聊天记录和上下文，且无法恢复。',
        targetLabel: '目标会话',
        listTitle: '将一并删除',
        tags: ['聊天历史', '上下文', '会话草稿'],
        note: '不会影响项目源码、Git 分支、文件权限和安全快照。',
        confirmText: '确认删除'
      }))
    }
    deps.showToast?.('应用内删除确认弹窗暂不可用，请刷新界面后重试', 'error')
    return false
  }

  function resetLiveAiPointers() {
    deps.setCurrentAiMsg?.(null)
    deps.setCurrentToolCount?.(0)
    deps.setCurrentOpCount?.(0)
    deps.setCurrentThinkingBlock?.(null)
    deps.setCurrentThinkingStartTime?.(null)
    deps.setCurrentChangeSession?.(null)
  }

  async function handleCreateProjectChatSession(project) {
    try {
      if (!project?.path) {
        deps.showToast?.('请先选择项目', 'warning')
        return
      }
      if (!window.api?.createProjectChatSession) {
        deps.showToast?.('当前客户端不支持同项目多会话', 'error')
        return
      }
      try { deps.returnToChatArea?.() } catch (_) {}
      if (deps.getActiveProject?.()?.id !== project.id) {
        await deps.switchProject?.(project.id)
      } else {
        try { deps.returnToChatArea?.() } catch (_) {}
      }
      const active = deps.getActiveProject?.()
      if (!active || active.id !== project.id) {
        deps.showToast?.('切换项目失败，无法新建会话', 'error')
        return
      }
      const leavingSessionId = window.RunningUiRestore?.currentSessionId?.(active)
        || String(active.chatSessionId || '').trim()
        || 'main'
      const leavingSessionRunning = window.RunningUiRestore?.isCurrentSessionRunning?.(active) === true
      const chatMessages = getChatMessages()
      // 新建 B 会话只冻结 A 的运行界面，绝不能中断 A。后续流式事件继续记录到 A 的会话快照。
      if (leavingSessionRunning) {
        const currentAiMsg = deps.getCurrentAiMsg?.()
        if (currentAiMsg?.dataset) currentAiMsg.dataset.chatSessionId = leavingSessionId
        window.RunningUiRestore?.freezeLeavingProject?.(active, {
          container: chatMessages,
          aiMsg: currentAiMsg,
          toolCount: deps.getCurrentToolCount?.() || 0,
          opCount: deps.getCurrentOpCount?.() || 0,
          sessionId: leavingSessionId,
          force: true
        })
        captureRunningAiSnapshot(active, currentAiMsg, { force: true })
      }
      const result = await window.api.createProjectChatSession(project.id, { title: '新会话' })
      if (!result?.success) {
        deps.showToast?.(result?.error || '新建会话失败', 'error')
        return
      }
      const emptyHistory = Array.isArray(result.messages) ? result.messages : (Array.isArray(result.messagesHistory) ? result.messagesHistory : [])
      deps.syncProjectBranchSession?.(active, {
        ...result,
        messagesHistory: emptyHistory,
        preserveLocalTail: false
      })
      active.chatSessionId = result.chatSessionId
      active.chatSessionTitle = result.chatSessionTitle || '新会话'
      active.branchTitle = result.branchTitle || active.branchTitle || ''
      active.chatSessions = Array.isArray(result.chatSessions) ? result.chatSessions : (active.chatSessions || [])
      active.messagesHistory = emptyHistory
      active.history = []
      active.inputDraft = ''
      active.isRunning = leavingSessionRunning
      active.ignoreIncomingAiEvents = false
      active.ignoreIncomingAiEventsUntilSessionId = ''
      resetLiveAiPointers()
      deps.setAutoFollowCurrentRun?.(false)
      deps.updateSendBtnState?.()
      deps.unlockChatComposer?.({ clearValue: true, focus: true })

      if (chatMessages) {
        window.ChatVirtualScroller?.destroy?.(chatMessages)
        chatMessages.innerHTML = ''
      }
      deps.scheduleAfterInteraction?.(() => {
        deps.renderProjectList?.()
        deps.updateProjectDisplay?.()
        deps.unlockChatComposer?.({ clearValue: false, focus: true })
        window.ContextCompressionStack?.refresh?.({
          retry: false,
          projectId: active.id,
          __tag: 'chat-session-created'
        })
      })
      deps.showToast?.('已新开会话', 'success')
    } catch (error) {
      console.error('[Frontend] create project chat session failed:', error)
      deps.showToast?.(`新建会话失败：${error?.message || error}`, 'error')
    }
  }

  async function handleSwitchProjectChatSession(project, session) {
    try {
      if (!project?.id || !session?.sessionId) return
      if (!window.api?.switchProjectChatSession) {
        deps.showToast?.('当前客户端不支持同项目多会话', 'error')
        return
      }
      try { deps.returnToChatArea?.() } catch (_) {}
      if (deps.getActiveProject?.()?.id !== project.id) {
        await deps.switchProject?.(project.id)
      } else {
        try { deps.returnToChatArea?.() } catch (_) {}
      }
      const active = deps.getActiveProject?.()
      if (!active || active.id !== project.id) return
      const leavingSessionId = window.RunningUiRestore?.currentSessionId?.(active)
        || String(active.chatSessionId || '').trim()
        || 'main'
      const targetSessionId = String(session.sessionId || '').trim() || 'main'
      // 已经在这个会话：只关设置/Git 回到聊天。不要再打 API、清空历史、延迟贴底。
      if (
        leavingSessionId === targetSessionId &&
        window.ProjectSwitcher?.isVisibleChatAlreadyOnSession?.(active, targetSessionId)
      ) {
        deps.clearViewedProjectActivity?.(active, { sessionId: targetSessionId })
        deps.unlockChatComposer?.({ clearValue: false, focus: true })
        deps.scheduleAfterInteraction?.(() => {
          deps.renderProjectList?.()
          deps.updateProjectDisplay?.()
          deps.unlockChatComposer?.({ clearValue: false, focus: true })
        })
        return
      }
      const leavingSessionRunning = window.RunningUiRestore?.isCurrentSessionRunning?.(active) === true
      const chatMessages = getChatMessages()
      if (leavingSessionRunning) {
        const currentAiMsg = deps.getCurrentAiMsg?.()
        if (currentAiMsg?.dataset) currentAiMsg.dataset.chatSessionId = leavingSessionId
        window.RunningUiRestore?.freezeLeavingProject?.(active, {
          container: chatMessages,
          aiMsg: currentAiMsg,
          toolCount: deps.getCurrentToolCount?.() || 0,
          opCount: deps.getCurrentOpCount?.() || 0,
          sessionId: leavingSessionId,
          force: true
        })
        captureRunningAiSnapshot(active, currentAiMsg, { force: true })
      }
      const result = await window.api.switchProjectChatSession(project.id, session.sessionId)
      if (!result?.success) {
        deps.showToast?.(result?.error || '切换会话失败', 'error')
        return
      }
      const switchHistory = Array.isArray(result.messages) ? result.messages : (Array.isArray(result.messagesHistory) ? result.messagesHistory : [])
      deps.syncProjectBranchSession?.(active, {
        ...result,
        messagesHistory: switchHistory,
        preserveLocalTail: false
      })
      active.chatSessionId = result.chatSessionId
      window.RunningUiRestore?.disarmGuard?.(window.RunningUiRestore?.scopeKey?.(active, leavingSessionId))
      active.chatSessionTitle = result.chatSessionTitle || '新会话'
      deps.clearViewedProjectActivity?.(active, { sessionId: active.chatSessionId || session.sessionId })
      active.branchTitle = result.branchTitle || active.branchTitle || ''
      if (Array.isArray(result.chatSessions)) {
        active.chatSessions = result.chatSessions
      }
      active.messagesHistory = []
      active.history = []
      const targetSessionRunning = window.RunningUiRestore?.isCurrentSessionRunning?.(active) === true
      active.isRunning = targetSessionRunning
      resetLiveAiPointers()
      deps.setAutoFollowCurrentRun?.(targetSessionRunning)
      deps.unlockChatComposer?.({ clearValue: false, focus: true })

      if (targetSessionRunning) {
        await deps.reloadActiveBranchSession?.({ force: true, result })
      } else if (switchHistory.length > 0) {
        active.messagesHistory = switchHistory
        active.history = typeof deps.mapMessagesHistoryForProject === 'function'
          ? deps.mapMessagesHistoryForProject(switchHistory)
          : []
        deps.restoreRecentHistoryByRounds?.(switchHistory, active.path, result, active.id)
      } else {
        await deps.reloadActiveBranchSession?.({ force: true })
      }

      const liveTitle = window.ChatToolbarContext?.sessionTitle?.(active) || ''
      if (liveTitle) {
        active.chatSessionTitle = liveTitle
        const liveSessionId = String(active.chatSessionId || session.sessionId || '')
        if (Array.isArray(active.chatSessions) && liveSessionId) {
          active.chatSessions = active.chatSessions.map(item =>
            String(item?.sessionId || '') === liveSessionId
              ? { ...item, title: liveTitle, current: true }
              : item
          )
        }
        window.api?.updateProjectChatSessionTitle?.(active.id, liveSessionId, liveTitle)?.catch?.(() => {})
      }

      window.ChatSessionScrollRestorer?.schedule?.({
        container: chatMessages,
        projectId: active.id,
        sessionId: active.chatSessionId,
        getActiveProject: deps.getActiveProject,
        isProjectRunning: projectItem => projectItem.isRunning || deps.isProjectAiRunActive?.(projectItem)
      })
      window.ContextCompressionStack?.refresh?.({
        retry: false,
        projectId: active.id,
        __tag: 'chat-session-switched'
      })

      deps.scheduleAfterInteraction?.(() => {
        deps.renderProjectList?.()
        deps.updateProjectDisplay?.()
        deps.unlockChatComposer?.({ clearValue: false, focus: true })
      })
    } catch (error) {
      console.error('[Frontend] switch project chat session failed:', error)
      deps.showToast?.(`切换会话失败：${error?.message || error}`, 'error')
    }
  }

  async function handleDeleteProjectChatSession(project, session) {
    try {
      if (!project?.id || !session?.sessionId) return
      if (!window.api?.deleteProjectChatSession) {
        deps.showToast?.('当前客户端不支持删除会话', 'error')
        return
      }
      const title = project.chatSessions?.find(item => item.sessionId === session.sessionId)?.title || '该会话'
      const isCurrent = project.chatSessionId === session.sessionId || !!project.chatSessions?.find(item => item.sessionId === session.sessionId && item.current)
      const confirmed = await confirmDeleteChatSession(title, isCurrent)
      if (!confirmed) {
        deps.unlockChatComposer?.({ clearValue: false, focus: true })
        return
      }

      deps.unlockChatComposer?.({ clearValue: false, focus: true })
      try { deps.returnToChatArea?.() } catch (_) {}

      const result = await window.api.deleteProjectChatSession(project.id, session.sessionId)
      if (!result?.success) {
        deps.showToast?.(result?.error || '删除会话失败', 'error')
        deps.unlockChatComposer?.({ clearValue: false, focus: true })
        return
      }

      const active = deps.getActiveProject?.()
      const targetProject = (active && active.id === project.id) ? active : project
      if (Array.isArray(result.chatSessions)) {
        targetProject.chatSessions = result.chatSessions
        project.chatSessions = result.chatSessions
      }

      if (Array.isArray(targetProject.chatSessions)) {
        targetProject.chatSessions = targetProject.chatSessions.filter(item => item?.sessionId !== session.sessionId)
      }
      if (Array.isArray(project.chatSessions)) {
        project.chatSessions = project.chatSessions.filter(item => item?.sessionId !== session.sessionId)
      }
      deps.setProjectActivity?.(targetProject, '', { sessionId: session.sessionId })
      if (project !== targetProject) {
        deps.setProjectActivity?.(project, '', { sessionId: session.sessionId })
      }

      if (result.switched || isCurrent) {
        const fallbackHistory = Array.isArray(result.messages) ? result.messages : (Array.isArray(result.messagesHistory) ? result.messagesHistory : [])
        deps.syncProjectBranchSession?.(targetProject, {
          ...result,
          messagesHistory: fallbackHistory,
          preserveLocalTail: false
        })
        targetProject.chatSessionId = result.chatSessionId || ''
        targetProject.chatSessionTitle = result.chatSessionTitle || ''
        targetProject.branchTitle = targetProject.chatSessionTitle || targetProject.branchTitle || ''
        targetProject.chatSessions = Array.isArray(result.chatSessions)
          ? result.chatSessions.filter(item => item?.sessionId !== session.sessionId)
          : (targetProject.chatSessions || [])
        targetProject.inputDraft = ''
        deps.clearProjectAiRunState?.(targetProject)
        deps.unlockChatComposer?.({ clearValue: true, focus: true })

        targetProject.messagesHistory = fallbackHistory
        targetProject.history = typeof deps.mapMessagesHistoryForProject === 'function'
          ? deps.mapMessagesHistoryForProject(fallbackHistory)
          : []
        deps.scheduleAfterInteraction?.(() => {
          const chatMessagesEl = getChatMessages()
          if (!fallbackHistory.length) {
            if (chatMessagesEl) {
              window.ChatVirtualScroller?.destroy?.(chatMessagesEl)
              chatMessagesEl.innerHTML = ''
            }
          } else {
            deps.restoreRecentHistoryByRounds?.(fallbackHistory, targetProject.path, result, targetProject.id)
          }
          deps.unlockChatComposer?.({ clearValue: false, focus: true })
        })
      }

      deps.scheduleAfterInteraction?.(() => {
        deps.renderProjectList?.()
        deps.updateProjectDisplay?.()
        deps.unlockChatComposer?.({ clearValue: false, focus: true })
      })
      deps.showToast?.(
        result.switched || isCurrent
          ? `已删除会话「${title}」，并切换到其他会话`
          : `已删除会话「${title}」`,
        'success'
      )
    } catch (error) {
      console.error('[Frontend] delete project chat session failed:', error)
      deps.showToast?.(`删除会话失败：${error?.message || error}`, 'error')
    }
  }

  function bind(depsObj = {}) {
    deps = depsObj
    window.handleCreateProjectChatSession = handleCreateProjectChatSession
    window.handleSwitchProjectChatSession = handleSwitchProjectChatSession
    window.handleDeleteProjectChatSession = handleDeleteProjectChatSession
  }

  window.ProjectChatSessionHandlers = {
    bind,
    handleCreateProjectChatSession,
    handleSwitchProjectChatSession,
    handleDeleteProjectChatSession
  }
})()
