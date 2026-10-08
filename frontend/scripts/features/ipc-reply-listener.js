// IPC onReply 监听器模块
// 负责处理 AI 回复消息的监听与分发（流式内容记录、状态清理、DOM 更新等）。
// 通过 window.IpcReplyListener.bind(deps) 注入依赖后调用 register() 注册监听。

(function () {
  let deps = {}
  // Turn 完成事件和 message-reply(done) 都可能触发一次历史投影。
  // 用项目 + Turn ID 做去重，避免同一轮重复读取/重绘；如果完成事件先到但
  // journal 尚未能读到，则允许短暂重试，保证 renderer 丢失 done 回包时仍能自愈。
  const turnRecoveryState = new Map()
  // turn-completed 由主进程先于 message-reply(done) 发出。首个恢复故意
  // 延迟一小段时间，优先让正常回复完成当前 DOM 流程；只有 done 丢失时，
  // 这个兜底才会接管历史投影。
  const TURN_RECOVERY_RETRY_DELAYS = [260, 180, 320]
  const TURN_RECOVERY_STATE_TTL_MS = 15000

  function markTurnRecoveryApplied(key) {
    if (!key) return
    const state = { applied: true, at: Date.now() }
    turnRecoveryState.set(key, state)
    const timer = setTimeout(() => {
      if (turnRecoveryState.get(key) === state) turnRecoveryState.delete(key)
    }, TURN_RECOVERY_STATE_TTL_MS)
    timer.unref?.()
  }

  function normalizeSessionId(sessionId) {
    return String(sessionId || '').trim() || 'main'
  }

  function eventSessionId(project, data = {}) {
    return normalizeSessionId(data.chatSessionId || project?._runningSessionId || project?.chatSessionId)
  }

  function isEventForProjectSession(project, data = {}) {
    if (!project) return false
    const currentSessionId = window.RunningUiRestore?.currentSessionId?.(project)
      || normalizeSessionId(project.chatSessionId)
    return normalizeSessionId(currentSessionId) === eventSessionId(project, data)
  }

  function isEventForActiveSession(project, data = {}) {
    return project?.id === deps.getActiveProjectId?.() && isEventForProjectSession(project, data)
  }

  function visibleChatIdentity(project = null) {
    const container = deps.getChatMessages?.()
    return {
      projectId: String(container?.dataset?.projectId || deps.getActiveProjectId?.() || '').trim(),
      sessionId: normalizeSessionId(
        container?.dataset?.chatSessionId ||
        window.RunningUiRestore?.currentSessionId?.(project) ||
        project?.chatSessionId
      )
    }
  }

  function isVisibleChatTarget(project, data = {}) {
    if (!project?.id) return false
    if (String(project.id) !== String(deps.getActiveProjectId?.() || '')) return false
    const visible = visibleChatIdentity(project)
    if (visible.projectId && visible.projectId !== String(project.id)) return false
    const wantedSessionId = normalizeSessionId(
      data.chatSessionId ||
      data.sessionId ||
      project._runningSessionId ||
      project.chatSessionId
    )
    if (wantedSessionId && visible.sessionId && wantedSessionId !== visible.sessionId) return false
    return isEventForProjectSession(project, { ...data, chatSessionId: wantedSessionId })
  }

  function applyReplyModelMetadata(aiMsg, data = {}) {
    if (!aiMsg) return
    const modelName = String(data.modelName || data.modelId || '').trim()
    if (!modelName) return
    aiMsg.dataset.modelName = modelName
    aiMsg.dataset.modelId = String(data.modelId || '').trim()
    const header = aiMsg.querySelector?.('.ai-header')
    if (header) header.textContent = modelName
  }

  async function reconcileCompletedTurn(project, options = {}) {
    if (!project || typeof window.api?.getTaskTurn !== 'function') return false
    try {
      const runId = String(options.runId || project.latestCompletedRunId || '').trim()
      const result = await window.api.getTaskTurn(project.id, runId || null)
      // 没有稳定 runId 时才使用“当前没有运行任务”的旧保护。
      // 有稳定 runId 时，即使用户已经开始下一轮，也要把上一轮的
      // Turn/Item 投影补回；renderer 会按 Turn ID 定位旧轮次，不会
      // 覆盖新轮次。
      if (!runId && (project.isRunning || project._runningSessionId)) return false
      if (!result?.success || !result.turn) return false
      project.latestTurn = result.turn
      // getTaskTurn 是异步的：等它回来时用户可能已经切到别的项目/会话。
      // 后台项目只保留内存里的 Turn 事实，切回去时走完整历史加载，绝不能
      // 改当前可见 DOM。
      if (!isVisibleChatTarget(project, options)) return 'skipped'
      deps.getChatRenderer?.()?.reconcileHistoricalTurn?.(
        project.messagesHistory,
        result.turn,
        project.path || '',
        {
          projectId: project.id,
          sessionId: options.chatSessionId || options.sessionId || ''
        }
      )
      return true
    } catch (error) {
      console.warn('[IpcReplyListener] reconcile completed Turn failed:', error?.message || error)
      return false
    }
  }

  async function recoverTurnFromCompletionEvent(data = {}) {
    if (data?.type !== 'turn-completed') return
    const projectId = String(data.projectId || '').trim()
    const runId = String(data.runId || data.turnId || '').trim()
    if (!projectId || !runId) return

    const project = deps.getProjects?.()?.find(item => String(item?.id || '') === projectId)
    if (!project) return
    project.latestCompletedRunId = runId
    // 事件刚到时 _runningSessionId 通常还在；done 回包稍后会清掉它。
    // 必须在这里先记下发起这场回复的会话，延迟恢复时才能判断可见聊天是否还是它。
    const originatingSessionId = normalizeSessionId(
      data.chatSessionId || project._runningSessionId || project.chatSessionId
    )

    const key = `${projectId}::${runId}`
    const previous = turnRecoveryState.get(key)
    if (previous?.applied || previous?.promise) return

    const promise = (async () => {
      for (const delay of TURN_RECOVERY_RETRY_DELAYS) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay))
        if (turnRecoveryState.get(key)?.applied) return
        const applied = await reconcileCompletedTurn(project, {
          runId,
          chatSessionId: originatingSessionId
        })
        if (applied) {
          markTurnRecoveryApplied(key)
          return
        }
      }
      // 不把失败永久记成 applied；后续 message-reply(done) 或项目切换仍可继续恢复。
      turnRecoveryState.delete(key)
    })()
    turnRecoveryState.set(key, { promise, at: Date.now() })
    try {
      await promise
    } finally {
      const current = turnRecoveryState.get(key)
      if (current?.promise === promise) {
        if (current.applied) markTurnRecoveryApplied(key)
        else turnRecoveryState.delete(key)
      }
    }
  }

  function register() {
    if (!window.api || (!window.api.onReply && !window.api.onTurnEvent)) return
    if (window.api.onTurnEvent) {
      window.api.onTurnEvent(data => {
        // turn-completed 是持久化层的权威完成信号；即使 renderer 没收到
        // message-reply(done)，也能按 runId 把工具链补回正确的历史轮次。
        void recoverTurnFromCompletionEvent(data)
      })
    }
    if (!window.api.onReply) return
    window.api.onReply(data => {
      const activeProjectId = deps.getActiveProjectId()
      const projects = deps.getProjects()
      AppLogger.debug('[Frontend] 收到回复, projectId:', data.projectId, 'activeProjectId:', activeProjectId, 'done:', data.done)

      // 查找回复所属项目。没有 projectId 时绝不能落到“当时激活的项目”，
      // 否则后台完成的回复会写进眼前这个聊天。
      const replyProject = data.projectId ? projects.find(p => p.id === data.projectId) : null
      if (!replyProject) {
        AppLogger.debug('[Frontend] ignore reply without matching projectId:', data.projectId)
        return
      }
      const replySessionId = eventSessionId(replyProject, data)
      // done 回包里的 content 有时会是后端重新整理后的版本。界面已经收到的 final-delta
      // 才是用户实际看见的正文；先在清理运行态前保存下来，历史和最终 DOM 都复用它。
      const completedStreamContent = data.done
        ? String(replyProject?.streamingContent || '')
        : ''
      const resolvedReplyContent = data.done && completedStreamContent.trim()
        ? completedStreamContent
        : String(data.content || '')
      // 新建会话后屏蔽旧任务残留回复，避免写进新会话历史/界面
      if (replyProject?.ignoreIncomingAiEvents) {
        if (data.done) {
          replyProject.isRunning = false
          replyProject.awaitingFinalReply = false
          replyProject.aiRunCompletedAt = 0
          if (replyProject._aiState) replyProject._aiState.aiRunCompletedAt = 0
          deps.clearProjectAiRunState?.(replyProject, { sessionId: replySessionId })
          deps.setProjectActivity?.(replyProject, '', {
            sessionId: replySessionId
          })
          deps.updateSendBtnState?.()
        }
        return
      }

      // 流式完成标志
      if (data.done) {
        if (replyProject) replyProject.isRunning = false
        if (replyProject) replyProject.awaitingFinalReply = false
        if (replyProject && (data.runId || data.turnId)) {
          replyProject.latestCompletedRunId = String(data.runId || data.turnId)
        }
        if (replyProject) {
          replyProject.aiRunCompletedAt = 0
          if (replyProject._aiState) replyProject._aiState.aiRunCompletedAt = 0
        }
      }

      // 始终将回复内容记录到对应项目的历史中
      if (resolvedReplyContent && replyProject && isEventForProjectSession(replyProject, data)) {
        const historyEntry = { role: 'assistant', content: resolvedReplyContent }
        if (Number.isFinite(Number(data.startedAt))) historyEntry.startedAt = Number(data.startedAt)
        if (Number.isFinite(Number(data.completedAt))) historyEntry.completedAt = Number(data.completedAt)
        if (Number.isFinite(Number(data.durationMs))) historyEntry.durationMs = Number(data.durationMs)
        if (data.modelName) historyEntry.modelName = String(data.modelName)
        if (data.modelId) historyEntry.modelId = String(data.modelId)
        // 保留 reasoning_content（DeepSeek Reasoner 等思考模型要求原样传回API）
        if (data.reasoningContent) {
          historyEntry.reasoning_content = data.reasoningContent
        }
        if (data.changeSession) {
          historyEntry.changeSession = data.changeSession
        }
        // 持久化本轮操作量快照到该条消息：切项目后历史回显仍可恢复 +N -N
        const sessionSnapshot = (window.aiChangePill?.getOperationSnapshot?.() || window.AiChangePill?.getActiveSnapshot?.() || null)
        if (sessionSnapshot && Array.isArray(sessionSnapshot.files) && sessionSnapshot.files.length) {
          historyEntry.operationSnapshot = {
            files: sessionSnapshot.files.map(file => ({
              path: file.path,
              action: file.action || 'modify',
              added: Math.max(0, Number(file.added) || 0),
              removed: Math.max(0, Number(file.removed) || 0)
            })),
            summary: sessionSnapshot.summary || null,
            sessionId: sessionSnapshot.sessionId || data.changeSession?.id || data.changeSession?.sessionId || '',
            metric: sessionSnapshot.metric || 'operation'
          }
        }
        replyProject.history.push(historyEntry)
        if (!Array.isArray(replyProject.messagesHistory)) replyProject.messagesHistory = []
        replyProject.messagesHistory.push({ ...historyEntry })
        window.ChatRuntimeHistoryCache?.compactProject?.(replyProject)
      }

      // 是否为当前激活项目
      const isActiveProject = isEventForActiveSession(replyProject, data)

      if (replyProject && data.done) {
        // 会话级指示：完成→绿点，错误→红点（不再清掉当前激活项目，否则多会话无法分辨）
        const activitySessionId = replySessionId
        deps.setProjectActivity(replyProject, data.error ? 'error' : 'done', {
          sessionId: activitySessionId
        })
        if (activitySessionId && String(replyProject._runningSessionId || '') === String(activitySessionId)) {
          replyProject._runningSessionId = ''
        }
      }

      if (!isActiveProject) {
        // 非当前项目的回复：记录到历史即可，不操作DOM
        // AI已完成，清空aiOperations（下次切换到该项目时从history恢复显示）
        const state = deps.getProjectAiState(data.projectId)
        if (state) { state.currentAiMsg = null; state.currentToolCount = 0; state.currentOpCount = 0 }
        if (data.done) deps.clearProjectAiRunState(replyProject, { sessionId: replySessionId })
        if (replyProject) {
          replyProject.streamingContent = ''
          replyProject.aiRunStartedAt = 0
          replyProject.aiRunCompletedAt = 0
          if (replyProject._aiState) {
            replyProject._aiState.aiRunStartedAt = 0
            replyProject._aiState.aiRunCompletedAt = 0
          }
        }
        // 非激活项目也刷新 Git 状态
        if (replyProject && data.done) {
          deps.cleanupCollabReportsAfterSuccessfulReply(replyProject, data)
          deps.loadGitStatusForProject(replyProject)
          if (data.operationMemo) {
            window.AiOperationMemoUI?.handleMemoPayload?.({
              ...data.operationMemo,
              projectId: data.projectId || replyProject.id
            })
          }
        }
        deps.updateSendBtnState()
        return
      }

      // 当前激活项目的回复：更新DOM
      deps.ensureCurrentAiMessageForProject(replyProject, { create: false })
      let currentAiMsg = deps.getCurrentAiMsg()
      if (!currentAiMsg) {
        const chatMessages = deps.getChatMessages()
        const aiMessages = chatMessages.querySelectorAll('.message.ai')
        currentAiMsg = aiMessages[aiMessages.length - 1] || null
        if (currentAiMsg) deps.setCurrentAiMsg(currentAiMsg)
      }
      applyReplyModelMetadata(currentAiMsg, data)
      if (data.error) {
        deps.finalizeAiFailure(replyProject, data.error)
      } else if (data.done) {
        deps.setCurrentChangeSession(data.changeSession || null)
        // 优先保留用户已经看见的流式正文，避免 done 回包把正文替换成另一版。
        const streamedFinalContent = currentAiMsg?.dataset?.finalStreamContent || completedStreamContent
        const finalContent = streamedFinalContent || resolvedReplyContent
        const finalArtifacts = Array.isArray(data.artifacts) ? data.artifacts : []
        // 先结束运行态和红色停止按钮。后面的 Markdown/附件渲染即使异常，界面也不能继续假装在执行。
        deps.clearProjectAiRunState(replyProject, { sessionId: replySessionId })
        deps.updateSendBtnState()
        // 先停止所有正在计时的思考块
        const currentThinkingBlock = deps.getCurrentThinkingBlock()
        if (currentThinkingBlock && !currentThinkingBlock.classList.contains('stopped')) {
          deps.finishThinkingBlock(currentThinkingBlock, 'done')
        }
        deps.setCurrentThinkingBlock(null)
        const aiMessageUI = deps.getAiMessageUI()
        aiMessageUI?.setWorkDuration?.(currentAiMsg, data.durationMs)
        deps.updateWorkStatus('done')
        // 清理动态区域中的 current-round 类
        if (currentAiMsg) {
          const dynamicArea = currentAiMsg.querySelector('.ai-dynamic-area')
          if (dynamicArea) {
            const currentRoundBlock = dynamicArea.querySelector('.intermediate-content-block.current-round')
            if (currentRoundBlock) {
              currentRoundBlock.classList.remove('current-round')
            }
          }
        }
        if (!currentAiMsg) {
          // currentAiMsg 已丢失（如DOM被清除），用简单消息代替
          deps.addAiMessageToUI(finalContent, { artifacts: finalArtifacts })
          // AI完成，隐藏Agent面板
          if (typeof AgentUI !== 'undefined') {
            AgentUI.hidePanel()
          }
        } else {
          deps.finishAiStreaming(finalContent, finalArtifacts)
          currentAiMsg.classList.remove('thinking')
          const opsEl = currentAiMsg.querySelector('.ai-operations')
          // 回复完成后：保持操作列表收起状态（用户可手动点击展开）
          // 收起所有操作详情
          if (opsEl) {
            const opIcons = deps.getOpIcons()
            opsEl.querySelectorAll('.op-detail').forEach(d => d.classList.remove('show'))
            opsEl.querySelectorAll('.op-toggle').forEach(t => { t.innerHTML = opIcons.step; t.parentElement.classList.remove('expanded') })
          }
          // 不自动展开 ai-stats（保持收起状态）
        }
        // 清空暂存的流式内容
        if (replyProject) replyProject.streamingContent = ''
        if (currentAiMsg) currentAiMsg.dataset.finalStreamContent = ''
        // 当前项目不切换时也立即把后端已持久化的工具链补回最新轮次。
        // 项目切换之所以能显示工具，正是因为切换路径会重新走历史回放；
        // 这里把同一能力补到正常完成路径。
        const completedRunId = String(data.runId || data.turnId || '').trim()
        void reconcileCompletedTurn(replyProject, {
          runId: completedRunId,
          chatSessionId: replySessionId
        }).then(applied => {
          if (applied && completedRunId && replyProject?.id) {
            markTurnRecoveryApplied(`${replyProject.id}::${completedRunId}`)
          }
        })
      }
      // done: true 时清理状态
      if (data.done) {
        deps.cleanupCollabReportsAfterSuccessfulReply(replyProject, data)
        deps.cleanupTempFilesForProject?.(replyProject?.id || data.projectId)
        deps.setAutoFollowCurrentRun(false)
        deps.setCurrentAiMsg(null)
        deps.setCurrentToolCount(0)
        deps.setCurrentOpCount(0)
        // AI完成，清空该项目的aiOperations
        if (replyProject) {
          replyProject.aiOperations = []
          replyProject.aiRunStartedAt = 0
          if (replyProject._aiState) replyProject._aiState.aiRunStartedAt = 0
        }
        deps.syncAiStateToProject()
        deps.updateSendBtnState()
        // 更新上下文状态
        deps.pollContextStatus()        // 方案A：AI轮次完成后自动刷新历史压缩的「X轮」数字
        if (window.ContextCompressionStack?.refresh) {
          try { window.ContextCompressionStack.refresh({ retry: false }) } catch {}
        }
        // AI 完成后刷新 Git 状态（可能有文件修改）
        if (replyProject) {
          deps.loadGitStatusForProject(replyProject)
        }
        if (!data.projectId || data.projectId === activeProjectId) {
          const aiChangePill = deps.getAiChangePill()
          aiChangePill?.render?.(data.changeSession || null)
        }
        if (data.operationMemo) {
          window.AiOperationMemoUI?.handleMemoPayload?.({
            ...data.operationMemo,
            projectId: data.projectId || activeProjectId
          })
        }
      }
    })
  }

  function bind(depsObj = {}) {
    deps = depsObj
  }

  window.IpcReplyListener = {
    bind,
    register
  }
})()
