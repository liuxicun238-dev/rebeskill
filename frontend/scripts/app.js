    const monacoEditors = window.MonacoService.editors
    const initMonaco = window.MonacoService.init
    const getMonacoLanguage = window.MonacoService.getLanguage
    const escapeHtml = HtmlUtils.escapeHtml

    if (!window.__lingxiResourceErrorLoggerInstalled) {
      window.__lingxiResourceErrorLoggerInstalled = true
      window.addEventListener('error', event => {
        const target = event.target
        if (!target || target === window) return
        const tag = String(target.tagName || '').toLowerCase()
        const url = target.currentSrc || target.src || target.href || target.getAttribute?.('src') || target.getAttribute?.('href') || ''
        if (!url) return
        console.warn('[ResourceLoadError]', {
          tag,
          url,
          id: target.id || '',
          className: typeof target.className === 'string' ? target.className : ''
        })
      }, true)
    }

    const inputBox = document.getElementById('inputBox')

    const sendBtn = document.getElementById('sendBtn')
    const sendIcon = document.getElementById('sendIcon')
    const modelDropdown = document.getElementById('modelDropdown')
    const modelTrigger = document.getElementById('modelTrigger')
    const modelCurrent = document.getElementById('modelCurrent')
    const modelMenu = document.getElementById('modelMenu')
    const chatMessages = document.getElementById('chatMessages')
    const scrollToBottomBtn = document.getElementById('scrollToBottomBtn')
    const chatHistoryBtn = document.getElementById('chatHistoryBtn')
    const chatHistoryModal = document.getElementById('chatHistoryModal')
    const chatHistoryClose = document.getElementById('chatHistoryClose')
    const chatHistoryList = document.getElementById('chatHistoryList')
    const chatHistorySearchInput = document.getElementById('chatHistorySearchInput')
    const chatHistoryUI = window.ChatHistoryUI

    window.ChatScroll?.bind({
      container: chatMessages,
      scrollButton: scrollToBottomBtn,
      setScrolledUp: value => { userHasScrolledUp = value },
      getLastScrollTop: () => lastScrollTop,
      setLastScrollTop: value => { lastScrollTop = value }
    })

    chatHistoryUI.bind({
      button: chatHistoryBtn,
      modal: chatHistoryModal,
      closeButton: chatHistoryClose,
      list: chatHistoryList,
      searchInput: chatHistorySearchInput,
      getProject: () => getActiveProject(),
      onJumpToTurn: (turnId, historyIndex) => jumpToTurnByUserIndex(turnId, historyIndex),
      onJumpToHistoryEntry: entry => jumpToHistoryEntry(entry)
    })

    // 渲染历史聊天列表（仅用户消息，优先使用 messagesHistory 以便点击项携带真实下标）
    async function renderChatHistory(filter = '') {
      chatHistoryUI.renderList({
        modal: chatHistoryModal,
        list: chatHistoryList,
        getProject: () => getActiveProject(),
        onJumpToTurn: (turnId, historyIndex) => jumpToTurnByUserIndex(turnId, historyIndex),
        onJumpToHistoryEntry: entry => jumpToHistoryEntry(entry)
      }, filter)
    }

    // 通过 Turn ID 跳转到指定消息（兼容旧调用）
    function scrollToMessageByTurnId(turnId) {
      return chatRenderer?.scrollToTurn(turnId)
    }

    // 精准跳转：右上角历史消息面板点击某条 → 由虚拟滚动器挂载并定位目标轮次
    function jumpToTurnByUserIndex(turnId, historyIndex = null) {
      if (!turnId && historyIndex == null) return
      window.ChatStickyBottom?.markEscaped?.(chatMessages)
      const scroller = window.ChatVirtualScroller
      if (!scroller) {
        // 虚拟滚动器未加载则降级为旧逻辑
        return scrollToMessageByTurnId(turnId)
      }
      const activeProject = getActiveProject()
      const messagesHistory = activeProject?.messagesHistory || []
      if (!Array.isArray(messagesHistory) || messagesHistory.length === 0) {
        return scrollToMessageByTurnId(turnId)
      }
      const total = messagesHistory.length
      const directIndex = historyIndex === null || historyIndex === undefined || historyIndex === ''
        ? null
        : Number(historyIndex)
      // 优先使用历史面板点击项携带的真实 messagesHistory 下标；旧入口没有下标时再按 turnId 兼容查找。
      const targetIdx = Number.isInteger(directIndex) && directIndex >= 0 && directIndex < total
        ? directIndex
        : scroller.findHistoryIndexByTurnId(messagesHistory, turnId)
      if (targetIdx < 0) return
      const range = scroller.calcJumpRange(messagesHistory, targetIdx)
      const projectPath = activeProject?.path || ''
      scroller.reset({
        container: chatMessages,
        renderer: chatRenderer,
        messagesHistory,
        start: range.start,
        end: range.end,
        total,
        startRound: range.startRound,
        endRound: range.endRound,
        roundCount: range.roundCount,
        source: 'jump',
        projectPath,
        targetTurnId: turnId,
        targetHistoryIndex: targetIdx,
        scrollTo: 'target'
      })
    }

    async function jumpToHistoryEntry(entry) {
      const project = getActiveProject()
      if (!project || !entry || !Number.isInteger(entry.chunkIndex)) return
      window.ChatStickyBottom?.markEscaped?.(chatMessages)
      const result = await window.api?.getChatHistoryPage?.(project.id, {
        cursor: entry.chunkIndex,
        direction: 'newer',
        pageChunks: 1,
        includeMetadata: false
      })
      if (!result?.success || project.id !== getActiveProject()?.id) return
      const messagesHistory = result.messages || []
      let targetIndex = entry.messageId
        ? messagesHistory.findIndex(message => message?.messageId === entry.messageId)
        : -1
      if (targetIndex < 0 && Number.isInteger(entry.historyIndex)) targetIndex = entry.historyIndex
      if (targetIndex < 0) return
      project.messagesHistory = messagesHistory
      project.history = mapMessagesHistoryForProject(messagesHistory)
      const paginator = window.ChatHistoryPaginator
      if (paginator && result.range) {
        paginator.reset({
          container: chatMessages,
          renderer: chatRenderer,
          messagesHistory,
          projectId: project.id,
          projectPath: project.path,
          range: result.range,
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          afterRender: () => jumpToTurnByUserIndex(0, targetIndex)
        })
      } else {
        jumpToTurnByUserIndex(0, targetIndex)
      }
    }

    window.jumpToTurnByUserIndex = jumpToTurnByUserIndex
    window.jumpToChatHistoryEntry = jumpToHistoryEntry

    function restoreRecentHistoryByRounds(messagesHistory, projectPath = '', pageData = null, projectId = '', extra = {}) {
      const history = Array.isArray(messagesHistory) ? messagesHistory : []
      const onReady = typeof extra.onReady === 'function' ? extra.onReady : null
      if (!history.length) {
        if (onReady) onReady({ empty: true })
        return
      }
      const paginator = window.ChatHistoryPaginator
      if (paginator && pageData?.range) {
        paginator.reset({
          container: chatMessages,
          renderer: chatRenderer,
          messagesHistory: history,
          projectId,
          projectPath,
          range: pageData.range,
          nextCursor: pageData.nextCursor,
          hasMore: pageData.hasMore,
          scrollTo: 'bottom',
          afterRender: onReady
        })
        return
      }
      const scroller = window.ChatVirtualScroller
      if (!scroller || !chatMessages || !chatRenderer) {
        restoreChatHistory(history, { projectPath })
        if (onReady) onReady({ fallback: true })
        return
      }
      const range = scroller.calcSwitchRange(history)
      scroller.reset({
        container: chatMessages,
        renderer: chatRenderer,
        messagesHistory: history,
        start: range.start,
        end: range.end,
        total: history.length,
        startRound: range.startRound,
        endRound: range.endRound,
        roundCount: range.roundCount,
        source: 'switch',
        projectPath,
        scrollTo: 'bottom',
        onReady
      })
    }

    const webviewPanel = document.getElementById('webviewPanel'), center = document.getElementById('center')
    const webviewPanelExpand = document.getElementById('webviewPanelExpand')
    const rightViewToggle = document.getElementById('rightViewToggle')
    const divider1 = document.getElementById('divider1')
    const webviewEmpty = document.getElementById('webviewEmpty'), webviewContainer = document.getElementById('webviewContainer')
    const webviewTabs = document.getElementById('webviewTabs'), tabCountEl = document.getElementById('tabCount')
    const sidebar = document.getElementById('sidebar'), sidebarToggle = document.getElementById('sidebarToggle'), collapseBtn = document.getElementById('collapseBtn')
    let rightPanelWidthFrame = 0
    function updateRightPanelWidthVar() {
      if (rightPanelWidthFrame) return
      rightPanelWidthFrame = requestAnimationFrame(() => {
        rightPanelWidthFrame = 0
        updateRightPanelWidthVarNow()
      })
    }
    function updateRightPanelWidthVarNow() {
      const visible = webviewPanel?.classList.contains('show') || webviewPanel?.classList.contains('expand-left')
      if (!visible) {
        if (updateRightPanelWidthVar._lastWidth !== 0) {
          document.documentElement.style.setProperty('--right-panel-width', '0px')
          updateRightPanelWidthVar._lastWidth = 0
        }
        return
      }
      // 使用 offsetWidth 而不是 getBoundingClientRect（同样触发 layout 但更轻），
      // 并做缓存去重，避免在 rAF 内反复写 CSS 变量触发额外重绘
      const width = Math.max(0, Math.round(webviewPanel?.offsetWidth || 0))
      if (width !== updateRightPanelWidthVar._lastWidth) {
        document.documentElement.style.setProperty('--right-panel-width', `${width}px`)
        updateRightPanelWidthVar._lastWidth = width
      }
    }
    updateRightPanelWidthVar.flush = updateRightPanelWidthVarNow
    updateRightPanelWidthVar._lastWidth = -1
    // 用 ResizeObserver 异步捕获宽度变化，避免在过渡动画的每一帧同步读 getBoundingClientRect
    if (webviewPanel && typeof ResizeObserver !== 'undefined') {
      try {
        const _rightPanelRO = new ResizeObserver(updateRightPanelWidthVar)
        _rightPanelRO.observe(webviewPanel)
      } catch (_) {}
    }
    window.addEventListener('resize', updateRightPanelWidthVar)
    // 项目路径选择器
    const projectSelector = document.getElementById('projectSelector')
    const projectNameEl = document.getElementById('projectName')
    // 上下文状态面板
    const contextPanel = document.getElementById('contextPanel')
    const contextPanelClose = document.getElementById('contextPanelClose')
    const contextTokenValue = document.getElementById('contextTokenValue')
    const contextTokenFill = document.getElementById('contextTokenFill')
    const contextTurnCount = document.getElementById('contextTurnCount')
    const contextSummaryCount = document.getElementById('contextSummaryCount')
    const contextIndexSize = document.getElementById('contextIndexSize')
    const contextStrategy = document.getElementById('contextStrategy')
    const contextBtnSummary = document.getElementById('contextBtnSummary')
    const contextBtnClear = document.getElementById('contextBtnClear')
    // 文件上传
    const fileUploadBtn = document.getElementById('fileUploadBtn')
    const fileInput = document.getElementById('fileInput')
    const uploadedFilesArea = document.getElementById('uploadedFilesArea')
    const inputWrapper = document.getElementById('inputWrapper')
    const chatInputArea = document.querySelector('.chat-input-area')
    const terminalPanelEl = document.getElementById('terminalPanel')
    const NO_PROJECT_CHAT_PROMPT = '请点击新建项目开始让AI进行工作并与之交互。'
    const NO_PROJECT_SEND_PROMPT = '请先新建或选择工作目录，再开始聊天。'

    // 浮标元素是稳定 DOM，懒查询 + cache；元素被移除/重建时自动重查
    let _floatingElsCache = null
    function getFloatingEls() {
      if (_floatingElsCache && document.body.contains(_floatingElsCache.btn) && document.body.contains(_floatingElsCache.popup)) {
        return _floatingElsCache
      }
      const btn = document.getElementById('scrollToBottomBtn')
      const popup = document.getElementById('aiAskPopup')
      _floatingElsCache = { btn, popup }
      return _floatingElsCache
    }

    function syncChatBottomInset() {
      if (!chatMessages) return
      const wasNearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80
      const inputHeight = chatInputArea?.offsetHeight || 0
      const terminalHeight = terminalPanelEl?.offsetHeight || 0
      // chat-messages / terminal-panel / chat-input-area 都是 flex 列布局，上下排列，互不重叠。
      // --chat-bottom-safe 只需要给最后一行文字留一点呼吸空间，不需要预留输入框高度。
      // 仅在 chatMessages 自身上写变量，避免污染 :root 触发整棵样式树失效
      if (chatMessages.style.getPropertyValue('--chat-bottom-safe') !== '8px') {
        chatMessages.style.setProperty('--chat-bottom-safe', '8px')
      }
      // --chat-floating-bottom 用于“一键到底”浮标和 AI 询问弹窗，需要避开终端 + 输入区的高度。
      // 只写到两个绝对定位浮标元素自身，触发最小范围的样式重算，不写 :root
      const floatingBottom = Math.max(16, inputHeight + terminalHeight + 16)
      const floatingBottomPx = `${floatingBottom}px`
      const { btn: scrollBtn, popup: askPopup } = getFloatingEls()
      if (scrollBtn && scrollBtn.style.getPropertyValue('--chat-floating-bottom') !== floatingBottomPx) {
        scrollBtn.style.setProperty('--chat-floating-bottom', floatingBottomPx)
      }
      if (askPopup && askPopup.style.getPropertyValue('--chat-floating-bottom') !== floatingBottomPx) {
        askPopup.style.setProperty('--chat-floating-bottom', floatingBottomPx)
      }
      if (wasNearBottom) {
        requestAnimationFrame(() => {
          if (!chatMessages) return
          chatMessages.scrollTop = chatMessages.scrollHeight
        })
      }
    }

    // 防抖版：同帧内多次调用合并为一次，减少 layout recalc
    let _syncChatBottomRafId = null
    function syncChatBottomInsetDebounced() {
      if (_syncChatBottomRafId) return
      _syncChatBottomRafId = requestAnimationFrame(() => {
        _syncChatBottomRafId = null
        syncChatBottomInset()
      })
    }

    const textInputUI = window.TextInputUI?.bind(inputBox, {
      onResize: () => {
        syncChatBottomInsetDebounced()
      },
      isLongTextAttachmentEnabled: () =>
        window.FeatureSettingsUI?.isEnabled?.('long_text_paste_attachment', true) ?? true,
      onLongTextPaste: async ({ text, characterCount, lineCount }) => {
        const added = await window.AttachmentStore?.addPastedText?.(text, window.api)
        if (!added) {
          showToast('长文本附件保存失败，已按普通文字粘贴', 'warning')
          return false
        }
        syncUploadedFiles()
        renderUploadedFiles()
        showToast(`粘贴内容较长，已转为 TXT 附件（${characterCount} 字符 · ${lineCount} 行）`, 'success')
        return true
      }
    })
    syncChatBottomInset()
    if (window.ResizeObserver && chatInputArea) {
      const inputResizeObserver = new ResizeObserver(syncChatBottomInsetDebounced)
      inputResizeObserver.observe(chatInputArea)
      if (inputWrapper) inputResizeObserver.observe(inputWrapper)
      if (uploadedFilesArea) inputResizeObserver.observe(uploadedFilesArea)
      if (terminalPanelEl) inputResizeObserver.observe(terminalPanelEl)
    }
    window.addEventListener('resize', syncChatBottomInsetDebounced)
    // 执行模式和询问弹窗
    const execModeDropdown = document.getElementById('execModeDropdown')
    const execModeTrigger = document.getElementById('execModeTrigger')
    const execModeMenu = document.getElementById('execModeMenu')
    const execModeIcon = document.getElementById('execModeIcon')
    const execModeCurrent = document.getElementById('execModeCurrent')
    const aiAskPopup = document.getElementById('aiAskPopup')
    const askContent = document.getElementById('askContent')
    const askOptions = document.getElementById('askOptions')
    const askCustomInputBox = document.getElementById('askCustomInputBox')
    const customAnswerInput = document.getElementById('customAnswerInput')
    const customSubmitBtn = document.getElementById('customSubmitBtn')
    let currentProjectPath = ''
    let currentStoragePath = ''
    const projectStore = window.ProjectStore
    let projects = projectStore?.getProjects() || []  // 项目列表: [{id, name, path, history, modelIndex, isRunning, contextStatus}]
    let activeProjectId = projectStore?.getActiveProjectId() || null  // 当前激活项目ID
    const attachmentStore = window.AttachmentStore
    const askPopup = window.AskPopup
    const contextUI = window.ContextUI
    const executionProgressUI = window.ExecutionProgressUI || {
      clear() {},
      render() {},
      renderDetails() {},
      setExpanded() {}
    }
    const settingsPanelUI = window.SettingsPanelUI
    const contextMenuUI = window.ContextMenuUI
    const layoutUI = window.LayoutUI
    const titlebarUI = window.TitlebarUI
    // 按项目隔离的AI状态（已提取到 features/project-ai-state.js）
    const {
      getProjectAiState,
      getActiveAiState,
      scrollChatToBottomNow,
      followChatToBottom,
      syncAiStateToProject,
      syncAiStateFromProject,
      generateSummaryHtml,
      clearToolStats
    } = window.ProjectAiState?.bind({
      getProjects: () => projects,
      getActiveProjectId: () => activeProjectId,
      getCurrentAiMsg: () => currentAiMsg,
      setCurrentAiMsg: v => { currentAiMsg = v },
      getCurrentToolCount: () => currentToolCount,
      setCurrentToolCount: v => { currentToolCount = v },
      getCurrentOpCount: () => currentOpCount,
      setCurrentOpCount: v => { currentOpCount = v },
      getCurrentChangeSession: () => currentChangeSession,
      setCurrentChangeSession: v => { currentChangeSession = v },
      getCurrentToolStats: () => currentToolStats,
      setCurrentToolStats: v => { currentToolStats = v },
      getChatMessages: () => chatMessages,
      syncChatBottomInset,
      getActiveProject,
      isProjectAiRunActive,
      captureRunningAiSnapshot: (project, msg) => captureRunningAiSnapshot(project, msg),
      getChangeSessionActions: () => changeSessionActions,
      getOpIcons: () => opIcons,
      getFileName
    }) || {}
    // AI 内容渲染（已提取到 features/ai-content-renderer.js）
    const {
      setAiContent,
      startTypewriterEffect,
      finishTypewriterEffect,
      setAiContentImmediate,
      sanitizeAiContent,
      normalizeRenderOptions,
      renderAiContent
    } = window.AiContentRenderer?.bind({
      getCurrentAiMsg: () => currentAiMsg,
      getAiMessageUI: () => aiMessageUI,
      getChatMessages: () => chatMessages,
      getCurrentToolStats: () => currentToolStats,
      generateSummaryHtml,
      clearToolStats,
      stopThinkingTimer: fn => stopThinkingTimer(fn),
      updateWorkStatus
    }) || {}

    // 项目切换（已提取到 features/project-switcher.js）
    window.ProjectSwitcher?.bind({
      getProjects: () => projects,
      getActiveProjectId: () => activeProjectId,
      getActiveProject,
      getInputBox: () => inputBox,
      getChatMessages: () => chatMessages,
      getChatRenderer: () => chatRenderer,
      syncProjectState,
      setActiveProject,
      clearViewedProjectActivity,
      setChatInputVisible,
      setCurrentProjectPath: v => { currentProjectPath = v },
      renderProjectList,
      updateProjectDisplay,
      renderActiveCacheUsageStrip: (...args) => renderActiveCacheUsageStrip(...args),
      isProjectAiRunActive,
      ensureRunningAiBlockVisible,
      syncAiStateToProject,
      syncAiStateFromProject,
      scheduleRunningAiBlockEnsure,
      updateSendBtnState,
      getExecutionMode: () => executionMode,
      getCurrentAiMsg: () => currentAiMsg,
      setCurrentAiMsg: v => { currentAiMsg = v },
      getCurrentToolCount: () => currentToolCount,
      setCurrentToolCount: v => { currentToolCount = v },
      getCurrentOpCount: () => currentOpCount,
      setCurrentOpCount: v => { currentOpCount = v },
      setCurrentThinkingBlock: v => { currentThinkingBlock = v },
      setCurrentThinkingStartTime: v => { currentThinkingStartTime = v },
      setCurrentChangeSession: v => { currentChangeSession = v },
      getAiChangePill: () => aiChangePill,
      saveProjectsList,
      updateWorkbenchMentionHighlight: (...args) => updateWorkbenchMentionHighlight(...args),
      setExecutionMode: v => { executionMode = v },
      updateExecModeUI,
      setCurrentPhase: v => { currentPhase = v },
      setPlanSteps: v => { planSteps = v },
      setCurrentStepIndex: v => { currentStepIndex = v },
      setIsProgressExpanded: v => { isProgressExpanded = v },
      stripActiveRunHistory,
      restoreChatHistory,
      mapMessagesHistoryForProject,
      cacheAiRuntimeForProject: (...args) => window.AiRuntimeCache?.cacheAiRuntimeForProject?.(...args),
      captureRunningAiSnapshot: (...args) => window.AiRuntimeCache?.captureRunningAiSnapshot?.(...args),
      resumeRunningAiMessage: (...args) => window.AiRuntimeCache?.resumeRunningAiMessage?.(...args),
      createAiMessage: (...args) => (typeof createAiMessage === 'function'
        ? createAiMessage(...args)
        : window.AiMessageUI?.createAiMessage?.(...args)),
      getProjectModel,
      getModelCurrent: () => modelCurrent,
      setCurrentSkill: v => { currentSkill = v },
      updateSkillButton,
      getWindowTabsFeature: () => windowTabsFeature,
      scrollToLatestAiMessage,
      getProjectModelName,
      loadGitStatusForProject,
      getTerminalPanel: () => terminalPanel,
      showToast,
      getVisibleAiMessageForProject,
      renderChatHistory,
      loadContextStatus,
      closeSkillPanel
    })
    const { returnToChatArea, switchProject, deriveBranchTitle, syncProjectBranchSession, reloadActiveBranchSession } = window.ProjectSwitcher || {}
    Object.assign(window, {
      returnToChatArea,
      switchProject,
      deriveBranchTitle,
      syncProjectBranchSession,
      reloadActiveBranchSession
    })
    window.LingxiProjectState = {
      getActiveProjectId: () => activeProjectId,
      getActiveProject,
      getProjects: () => projects
    }

    // 消息发送（已提取到 features/message-sender.js）
    window.MessageSender?.bind({
      getActiveProjectId: () => activeProjectId,
      getCurrentAiMsg: () => currentAiMsg,
      setCurrentAiMsg: v => { currentAiMsg = v },
      setCurrentToolCount: v => { currentToolCount = v },
      setCurrentOpCount: v => { currentOpCount = v },
      setCurrentThinkingBlock: v => { currentThinkingBlock = v },
      setCurrentChangeSession: v => { currentChangeSession = v },
      setAutoFollowCurrentRun: v => { autoFollowCurrentRun = v },
      setUserHasScrolledUp: v => { userHasScrolledUp = v },
      setLastScrollTop: v => { lastScrollTop = v },
      getExecutionMode: () => executionMode,
      getUploadedFiles: () => uploadedFiles,
      getQuotedArtifacts: () => quotedArtifacts,
      setQuotedArtifacts: v => { quotedArtifacts = v },
      getInputBox: () => inputBox,
      getSavedModels: () => savedModels,
      getMaxInlineImageBytes: () => maxInlineImageBytes,
      getAiChangePill: () => aiChangePill,
      getModelStore: () => modelStore,
      getTextInputUI: () => textInputUI,
      getAttachmentStore: () => attachmentStore,
      getAllSkills: () => allSkills,
      buildSkillContentForSend: (opts) => (typeof window.__buildSkillContentForSend === 'function'
        ? window.__buildSkillContentForSend(opts)
        : null),
      parseSkillMentionTokens: (...args) => (window.WorkbenchMention?.parseSkillMentionTokens?.(...args) || []),
      clearActiveSkill: () => skillsFeature?.pickActiveSkill?.(null),
      syncProjectState,
      getActiveProject,
      saveProjectsList,
      showNoProjectSendPrompt,
      getReferenceTitle,
      getProjectModel,
      getChatRenderer: () => chatRenderer,
      addErrorMessage,
      setProjectActivity,
      addUserMessage,
      createAiMessage: (...args) => createAiMessage(...args),
      withCacheUsageViewState: (...args) => withCacheUsageViewState(...args),
      resetCacheUsageViewState: (...args) => resetCacheUsageViewState(...args),
      setCacheUsageText: (...args) => setCacheUsageText(...args),
      clearToolStats,
      syncAiStateToProject,
      updateSendBtnState,
      addThinking: (...args) => addThinking(...args),
      waitForUiFrame,
      isImageUpload,
      readFileContentGlobal: (...args) => readFileContentGlobal(...args),
      showToast,
      readFileAsBase64Global: (...args) => readFileAsBase64Global(...args),
      formatUploadBytes,
      buildMentionDirectivePrompt: (...args) => buildMentionDirectivePrompt(...args),
      stripMentionDirectives: (...args) => stripMentionDirectives(...args),
      getMentionDirectiveBadges: (...args) => getMentionDirectiveBadges(...args),
      syncChatBottomInset,
      updateWorkbenchMentionHighlight: (...args) => updateWorkbenchMentionHighlight(...args),
      syncUploadedFiles,
      renderUploadedFiles,
      renderArtifactRefs,
      renderProjectList,
      finalizeAiFailure,
      clearProjectAiRunState,
      setProjectActivity,
      clearAiRuntimeForProject: (...args) => clearAiRuntimeForProject(...args),
      // 首条消息发送后，若项目仍缺 chatSessionId（如打开已有目录未拉会话列表），
      // 用它兜底拉取后端会话列表，确保侧栏出现会话标题
      reloadActiveBranchSession: (...args) => reloadActiveBranchSession(...args)
    })
    const { sendChangeSessionPrompt, failCurrentSend, setCollabReportCleanupFlag, clearCollabReportCleanupFlag, cleanupCollabReportsAfterSuccessfulReply, sendMessage } = window.MessageSender || {}
    Object.assign(window, {
      sendChangeSessionPrompt,
      failCurrentSend,
      setCollabReportCleanupFlag,
      clearCollabReportCleanupFlag,
      cleanupCollabReportsAfterSuccessfulReply,
      sendMessage
    })
    const chatRenderer = window.ChatRenderer?.bind({
      getContainer: () => chatMessages,
      highlightMessage: element => chatHistoryUI.highlight(element),
      sanitizeContent: content => sanitizeAiContent(content),
      renderAiContent: (content, options = {}) => renderAiContent(content, options),
      generateSummaryHtml: (stats, changeSession, operationSnapshot) => generateSummaryHtml(stats, changeSession, operationSnapshot),
      getOpIcons: () => opIcons,
      getOpTypes: () => opTypes,
      getVisibleProjectId: () => activeProjectId,
      getVisibleSessionId: () => window.RunningUiRestore?.currentSessionId?.(getActiveProject()) || getActiveProject()?.chatSessionId || '',
      onAfterRestore: () => updateMessagesVisibility()
    })
    const contextVisibility = window.ContextVisibility?.bind({
      api: window.api,
      getActiveProjectId: () => activeProjectId,
      getChatMessages: () => chatMessages,
      showToast,
      addAiMessage: addAiMessageToUI
    })
    let gitPanelFeature = null
    let storageSettings = null
    let settingsMainFeature = null
    let themeSettings = null
    let skillsFeature = null
    let quickModelSettings = null
    let projectActions = null
    let windowTabsFeature = null
    let aiMessageUI = null
    let summaryMenu = null
    let filePreview = null
    let changeSessionActions = null
    let aiChangePill = null
    let terminalPanel = null
    let uploadedFiles = attachmentStore?.getFiles() || []  // 已上传的文件列表
    let quotedArtifacts = []

    function syncUploadedFiles() {
      uploadedFiles = attachmentStore?.getFiles() || []
    }

    function updateSidebarContext(ratio, estimatedTokens = 0) {
      return updateSidebarContextImpl(ratio, estimatedTokens)
    }

    function updateSidebarContextImpl(ratio, estimatedTokens = 0) {
      contextUI.updateSidebar(ratio, estimatedTokens)
    }

    function updateSidebarProject() {
      return updateSidebarProjectImpl()
    }

    function updateSidebarProjectImpl() {
      renderProjectList()
    }

    function updateProjectDisplay() {
      return updateProjectDisplayImpl()
    }

    function updateProjectDisplayImpl() {
      if (projectNameEl) {
        const activeProject = getActiveProject()
        const name = activeProject?.name || (currentProjectPath ? currentProjectPath.split(/[\\/]/).pop() : ((window.i18n?.t?.('auto.js_app_215_1') ?? '默认项目')))
        projectNameEl.textContent = name
        projectNameEl.title = currentProjectPath
        if (!currentProjectPath) {
          projectNameEl.textContent = '未选择项目'
          projectNameEl.title = ''
        }
      }
      window.ChatToolbarContext?.refresh?.()
    }

    async function loadContextStatus() {
      return loadContextStatusImpl()
    }

    async function loadContextStatusImpl() {
      const project = getActiveProject()
      if (!project) {
        updateSidebarContext(0, 0)
        return
      }
      if (window.api) {
        const status = await window.api.getContextStatus(project.id, getProjectContextDescriptor(project))
        if (getActiveProject()?.id !== project.id) return
        project.contextStatus = status
        if (status?.error) {
          updateSidebarContext(0, 0)
          return
        }
        currentProjectPath = status.projectPath || ''
        currentStoragePath = status.storagePath || ''
        updateSidebarProject()
        updateSidebarContext(status.contextRatio || 0, status.estimatedTokens || 0)
      }
    }


    function renderUploadedFiles() {
      return renderUploadedFilesImpl()
    }

    function renderUploadedFilesImpl() {
      attachmentStore.render({
        area: uploadedFilesArea,
        inputWrapper,
        onChange: () => {
          syncUploadedFiles()
          renderUploadedFiles()
        },
        onRestoreText: file => {
          const text = String(file?.pastedText || '')
          if (!text || !textInputUI?.insertText) {
            showToast('该附件无法恢复为输入文字', 'warning')
            return false
          }
          textInputUI.insertText(text)
          inputBox.focus({ preventScroll: true })
          showToast('已恢复为输入框文字', 'success')
          return true
        }
      })
      syncChatBottomInset()
    }

    function getReferenceTitle(ref) {
      if (!ref) return ((window.i18n?.t?.('auto.js_app_293_2') ?? '引用'))
      if (ref.type === 'message') return ref.title || (ref.part === 'user' ? `用户消息 #${ref.turnId}` : `AI消息 #${ref.turnId}`)
      if (ref.type === 'summary') return ref.title || ref.summaryId || ((window.i18n?.t?.('auto.js_app_295_3') ?? '压缩摘要'))
      return ref.title || ref.artifactId || ((window.i18n?.t?.('auto.js_app_296_4') ?? '完整详情'))
    }

    function renderArtifactRefs() {
      let refsArea = document.getElementById('artifactRefsArea')
      if (!refsArea) {
        refsArea = document.createElement('div')
        refsArea.id = 'artifactRefsArea'
        refsArea.className = 'artifact-refs-area'
        inputWrapper.insertBefore(refsArea, inputWrapper.firstChild)
      }
      if (quotedArtifacts.length === 0) {
        refsArea.classList.remove('show')
        refsArea.innerHTML = ''
        syncChatBottomInset()
        return
      }
      refsArea.classList.add('show')
      refsArea.innerHTML = quotedArtifacts.map((artifact, index) => `
        <div class="artifact-ref-chip" data-index="${index}">
          <span class="artifact-ref-label">引用：${escapeHtml(getReferenceTitle(artifact))}</span>
          <button type="button" onclick="removeQuotedArtifact(${index})">×</button>
        </div>
      `).join('')
      syncChatBottomInset()
    }

    window.removeQuotedArtifact = function(index) {
      quotedArtifacts.splice(index, 1)
      renderArtifactRefs()
    }
    // ===== 同项目多会话入口 =====
    // 删除/切换/新建会话后，先立刻恢复输入框可编辑，再做重渲染。
    // 否则重历史 DOM 重建会卡住主线程，出现“要等一会才能点输入框”。
    function unlockChatComposer(options = {}) {
      const clearValue = options.clearValue === true
      const focus = options.focus !== false
      try { setChatInputVisible(true) } catch (_) {}
      // 真实输入框 id 是 inputBox。不要依赖历史遗留的 messageInput 名称。
      const inputEl = document.getElementById('inputBox') || inputBox
      if (inputEl) {
        if (clearValue) inputEl.value = ''
        inputEl.readOnly = false
        inputEl.disabled = false
        inputEl.removeAttribute('disabled')
        inputEl.removeAttribute('readonly')
        try {
          inputEl.style.pointerEvents = ''
          inputEl.tabIndex = 0
        } catch (_) {}
        if (focus) {
          // 原生 confirm 关闭后，Windows 上焦点可能还在系统对话框上。
          // 先请主进程回焦窗口，再多帧重试 input focus。
          const tryFocus = () => {
            try {
              if (document.hidden) return false
              inputEl.focus({ preventScroll: true })
            } catch (_) {
              try { inputEl.focus?.() } catch (_) {}
            }
            return document.hasFocus() && document.activeElement === inputEl
          }
          const runFocusRecovery = () => {
            let settled = false
            let focusRequestInFlight = false
            const requestWindowFocus = () => {
              if (!window.api?.focusMainWindow || focusRequestInFlight || document.hasFocus()) return
              focusRequestInFlight = true
              Promise.resolve(window.api.focusMainWindow())
                .catch(() => null)
                .finally(() => { focusRequestInFlight = false })
            }
            const settle = () => {
              if (settled) return true
              requestWindowFocus()
              settled = tryFocus()
              if (settled) window.removeEventListener('focus', settle, true)
              return settled
            }
            window.addEventListener('focus', settle, true)
            setTimeout(() => window.removeEventListener('focus', settle, true), 1200)
            if (settle()) return
            requestAnimationFrame(() => {
              if (settle()) return
              setTimeout(settle, 0)
              setTimeout(settle, 80)
              setTimeout(settle, 200)
              setTimeout(settle, 500)
              setTimeout(settle, 900)
            })
          }
          if (window.api?.focusMainWindow) {
            Promise.resolve(window.api.focusMainWindow())
              .catch(() => null)
              .finally(() => runFocusRecovery())
          } else {
            runFocusRecovery()
          }
        }
      }
      try { updateSendBtnState?.() } catch (_) {}
      return inputEl
    }

    function scheduleAfterInteraction(task) {
      const run = typeof task === 'function' ? task : null
      if (!run) return
      // 先让出当前点击/确认弹窗的交互帧，再做重渲染
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            try { run() } catch (error) {
              console.error('[Frontend] deferred UI task failed:', error)
            }
          }, 0)
        })
      })
    }

    window.ProjectChatSessionHandlers.bind({
      showToast,
      getActiveProject,
      switchProject: (...args) => (typeof switchProject === 'function'
        ? switchProject(...args)
        : window.ProjectSwitcher?.switchProject?.(...args)),
      returnToChatArea: () => {
        try { returnToChatArea?.() } catch (_) {}
        try { window.ProjectSwitcher?.returnToChatArea?.() } catch (_) {}
      },
      getChatMessages: () => document.getElementById('chatMessages') || chatMessages,
      getCurrentAiMsg: () => currentAiMsg,
      setCurrentAiMsg: v => { currentAiMsg = v },
      getCurrentToolCount: () => currentToolCount,
      setCurrentToolCount: v => { currentToolCount = v },
      getCurrentOpCount: () => currentOpCount,
      setCurrentOpCount: v => { currentOpCount = v },
      setCurrentThinkingBlock: v => { currentThinkingBlock = v },
      setCurrentThinkingStartTime: v => { currentThinkingStartTime = v },
      setCurrentChangeSession: v => { currentChangeSession = v },
      setAutoFollowCurrentRun: v => { autoFollowCurrentRun = v },
      updateSendBtnState,
      unlockChatComposer,
      scheduleAfterInteraction,
      syncProjectBranchSession,
      reloadActiveBranchSession,
      clearViewedProjectActivity: (...args) => clearViewedProjectActivity(...args),
      mapMessagesHistoryForProject: (...args) => mapMessagesHistoryForProject(...args),
      restoreRecentHistoryByRounds,
      isProjectAiRunActive: (...args) => isProjectAiRunActive(...args),
      setProjectActivity: (...args) => setProjectActivity(...args),
      clearProjectAiRunState: (...args) => clearProjectAiRunState(...args),
      renderProjectList: () => renderProjectList(),
      updateProjectDisplay: (...args) => updateProjectDisplay(...args)
    })
    const handleCreateProjectChatSession = (...a) => window.ProjectChatSessionHandlers.handleCreateProjectChatSession(...a)
    const handleSwitchProjectChatSession = (...a) => window.ProjectChatSessionHandlers.handleSwitchProjectChatSession(...a)
    const handleDeleteProjectChatSession = (...a) => window.ProjectChatSessionHandlers.handleDeleteProjectChatSession(...a)

    function renderProjectList() {
      return renderProjectListImpl()
    }

    function renderProjectListImpl() {
      if (!window.ProjectListUI) return
      syncProjectState()
      renderArchivePanel()
      window.ProjectListUI.render({
        container: 'sidebarProject',
        projects,
        activeProjectId,
        folderIcon: `<svg class="folder-motion-icon project-folder-state-icon" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="1.65" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="folder-state-closed"><path d="M3.5 7.5h6.6l1.8 2h8.6v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z"/></g><g class="folder-state-open"><path d="M3.5 9V7.5h6.6l1.8 2h7.8a1.5 1.5 0 0 1 1.4 2.05l-2.3 6a2 2 0 0 1-1.86 1.28H5.5a2 2 0 0 1-1.88-1.32L2.5 14.4A2 2 0 0 1 4.38 11.7h15.9"/></g></svg>`,
        onMoveProject: (draggedId, targetId, extra = {}) => {
          if (projectStore.moveProject(draggedId, targetId, extra)) {
            syncProjectState()
            saveProjectsList()
            syncProjectState()
            renderProjectList()
          }
        },
        onOpenFolder: openProjectFolder,
        onCloseProject: closeProject,
        onToggleProject: (project, item, isExpanded) => {
          const willExpand = !isExpanded
          project.expanded = willExpand
          item.classList.toggle('expanded', willExpand)
          const projectHead = item.querySelector('.project-item-head')
          projectHead?.setAttribute('aria-expanded', String(willExpand))
          projectHead?.setAttribute('title', project.path || '')
          saveProjectsList(getActiveProject()?.path || project.path || '')
        },
        onViewGit: async project => {
          await switchProject(project.id)
          showGitPanel()
        },
        onInitGit: initGitForProject,
        onCreateProjectChatSession: (...a) => handleCreateProjectChatSession(...a),
        onSwitchChatSession: (...a) => handleSwitchProjectChatSession(...a),
        onDeleteProjectChatSession: (...a) => handleDeleteProjectChatSession(...a),
        onProjectAction: (...a) => handleProjectListAction(...a),
        onSwitchBranchSession: (...a) => switchBranchSession(...a),
        onDeleteBranchSession: (...a) => deleteProjectBranch(...a),
        onBranchSessionAction: (...a) => handleBranchSessionAction(...a),
        onSwitchProject: project => {
          switchProject(project.id)
        }
      })
      window.ChatToolbarContext?.refresh?.()
    }
    window.ProjectBranchSession.bind({
      getProjects: () => projects,
      getActiveProject,
      switchProject,
      showToast,
      syncProjectState,
      saveProjectsList,
      renderProjectList,
      loadGitStatusForProject,
      reloadActiveBranchSession,
      openProjectFolder,
      archiveProject: (...a) => archiveProject(...a),
      closeProject,
      updateProjectDisplay,
      syncProjectBranchSession,
      isProjectAiRunActive,
      escapeHtml
    })
    window.ProjectWorkspaces?.bind({
      createProject,
      saveProjectsList,
      switchProject,
      renderProjectList,
      showToast,
      projectStore,
      unlockChatComposer
    })
    const {
      switchBranchSession,
      handleProjectListAction,
      createProjectBranch,
      createBranchWithContext,
      openCreateBranchFromChatToolbar,
      openCreateBranchFromMessage,
      deleteProjectBranch,
      toggleProjectPinned,
      renameProject,
      showProjectTextInputDialog,
      showProjectRenameDialog,
      isValidProjectBranchName
    } = window.ProjectBranchSession
    window.ProjectBranchSession.bindCreateBranchToolbar?.()

    async function handleBranchSessionAction(project, session = {}, action = '') {
      if (!project || !action) return
      const branchName = String(session.branchName || '').trim()
      if (!branchName) return
      if (session.isMainline || /^(main|master)$/i.test(branchName)) {
        showToast('主线会话不提供分支操作菜单', 'info')
        return
      }

      if (action === 'delete') {
        await deleteProjectBranch(project, session)
        return
      }

      if (action === 'view-diff') {
        await switchProject(project.id)
        const opened = await gitPanelFeature?.openBranchDetail?.(branchName)
        if (!opened?.success) {
          // 兼容 Git 面板尚未完成初始化时的兜底
          showGitPanel()
          await gitPanelFeature?.openBranchDetail?.(branchName)
        }
        return
      }

      if (action === 'merge') {
        await switchProject(project.id)
        // 合并前先切到主线，避免“当前分支合并到当前分支”
        const mainlineName = String(
          project.branchSessions?.find(item => item?.isMainline)?.branchName
          || project.gitStatus?.mainBranch
          || project.gitStatus?.defaultBranch
          || 'main'
        ).trim()
        if (mainlineName && mainlineName !== project.branchName) {
          await switchBranchSession(project, {
            branchName: mainlineName,
            isMainline: true
          })
        }
        const result = await gitPanelFeature?.mergeBranchByName?.(branchName)
        if (!result?.success && result?.error && result.error !== 'cancelled') {
          // 失败时打开详情页，方便继续处理冲突
          await gitPanelFeature?.openBranchDetail?.(branchName)
        }
      }
    }

    function getProjectSearchName(project) {
      return [project?.name, project?.title, project?.path].filter(Boolean).join(' ').toLowerCase()
    }

    // 归档面板（已提取到 features/archive-panel.js）
    window.ArchivePanel.bind({
      getProjects: () => projects,
      getActiveProjectId: () => activeProjectId,
      projectStore,
      syncProjectState,
      switchProject,
      escapeHtml,
      showToast,
      saveProjectsList,
      renderProjectList,
      getActiveProject,
      enterNoProjectState,
      getProjectSearchName,
      closeSkillPanel
    })
    const {
      getArchiveElements,
      archiveProject,
      restoreArchivedProject,
      renderArchivePanel,
      closeArchivePanel,
      openArchivePanel,
      bindArchivePanel
    } = window.ArchivePanel

    function openProjectFolder(path) {
      return openProjectFolderImpl(path)
    }

    function openProjectFolderImpl(path) {
      AppLogger.debug('[Frontend] 打开项目文件夹:', path)
      if (window.api) {
        window.api.openProjectFolder?.(path)
      }
    }

    async function closeProject(projectId) {
      return closeProjectImpl(projectId)
    }

    async function closeProjectImpl(projectId) {
      const index = projects.findIndex(p => p.id === projectId)
      if (index === -1) {
        AppLogger.debug('[Frontend] 删除项目失败：找不到项目', projectId)
        return
      }

      const project = projects[index]
      AppLogger.debug('[Frontend] 准备删除项目:', projectId, '名称:', project.name)

      if (project.isRunning && window.api) {
        window.api.interruptAi?.(project.id)
      }

      const result = await showDeleteProjectDialog(project.name || project.path)
      AppLogger.debug('[Frontend] 用户选择删除模式:', result)
      if (result === 'cancel') return

      let deleteResult = null
      if (window.api && window.api.deleteProject) {
        try {
          deleteResult = await window.api.deleteProject(projectId, result)
          if (!deleteResult?.success) {
            if (/项目不存在|project not found/i.test(String(deleteResult?.error || ''))) {
              console.warn('[Frontend] 后端项目已不存在，继续清理前端项目列表残留:', projectId)
            } else {
              showToast(deleteResult?.error || ((window.i18n?.t?.('auto.js_app_540_7') ?? '删除项目失败')), 'error')
              return
            }
          }
          AppLogger.debug('[Frontend] 主进程删除结果:', deleteResult)
        } catch (e) {
          console.error('[Frontend] deleteProject failed:', e)
          showToast(((window.i18n?.t?.('auto.js_app_547_0') ?? ((window.i18n?.t?.('auto.js_app_547_8') ?? '删除项目失败: ')))) + e.message, 'error')
          return
        }
      }

      const wasActiveProject = projectId === activeProjectId
      const currentActiveProject = getActiveProject()

      const idsToRemove = [projectId, ...(deleteResult?.removedProjectListIds || [])]
      const pathsToRemove = [project.path, ...(deleteResult?.removedProjectListPaths || [])]
      if (projectStore.removeProjectsByIdentity) {
        projectStore.removeProjectsByIdentity({ ids: idsToRemove, paths: pathsToRemove }, { selectNext: false })
      } else {
        projectStore.removeProjectById(projectId, { selectNext: false })
      }
      syncProjectState()
      const nextProject = wasActiveProject
        ? (projects[0] || null)
        : (currentActiveProject && projects.find(p => p.id === currentActiveProject.id) ? currentActiveProject : (projects[0] || null))
      await saveProjectsList(nextProject?.path || '')

      const activeProjectStillExists = activeProjectId && projects.some(p => p.id === activeProjectId)
      if (wasActiveProject || !activeProjectStillExists) {
        const visibleProjects = projects.filter(p => !p.archived)
        if (visibleProjects.length > 0) {
          switchProject(visibleProjects[0].id)
        } else {
          enterNoProjectState()
        }
      } else {
        renderProjectList()
      }
    }

    function showDeleteProjectDialog(projectName) {
      return showDeleteProjectDialogImpl(projectName)
    }

    function showDeleteProjectDialogImpl(projectName) {
      return window.DeleteProjectDialog.show(projectName)
    }

    async function initProjects() {
      return window.ProjectInit.init()
    }

    // ===== 全局辅助函数 =====
    const readFileContentGlobal = window.FileUtils.readTextFile
    const readFileAsBase64Global = window.FileUtils.readFileAsBase64
    const formatFileSizeGlobal = window.FileUtils.formatFileSize
    const imageFileExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'])
    const maxInlineImageBytes = 8 * 1024 * 1024

    function isImageUpload(file) {
      const ext = String(file?.name || file?.path || '').split('.').pop().toLowerCase()
      return !!((file?.type && String(file.type).startsWith('image/')) || imageFileExts.has(ext))
    }

    function formatUploadBytes(bytes) {
      return formatFileSizeGlobal ? formatFileSizeGlobal(bytes) : `${Math.round(bytes / 1024 / 1024)} MB`
    }

    function waitForUiFrame() {
      return new Promise(resolve => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
        else setTimeout(resolve, 0)
      })
    }

    function scrollToLatestAiMessage(options = {}) {
      if (!chatMessages) return
      syncChatBottomInset()

      requestAnimationFrame(() => {
        // forceStick 统一处理：清 escaped + 设 programmaticUntil + 滚到 scrollHeight
        // 避免 observer mount 轮次时 mountRound 高度补偿把视口拉偏（700+ 轮项目高频触发）
        if (window.ChatStickyBottom?.forceStick) {
          window.ChatStickyBottom.forceStick(chatMessages)
        } else {
          chatMessages.scrollTop = chatMessages.scrollHeight
        }
        lastScrollTop = chatMessages.scrollTop
      })
    }

    // ===== 多项目状态管理 =====
    // 多项目状态管理辅助函数（已提取到 features/project-state-helpers.js）
    const _psh = window.ProjectStateHelpers.bind({
      getProjectStore: () => projectStore,
      getModelStore: () => modelStore,
      getProjects: () => projects,
      setProjects: value => { projects = value },
      getActiveProjectId: () => activeProjectId,
      setActiveProjectId: value => { activeProjectId = value },
      getSavedModels: () => savedModels,
      getChatInputArea: () => chatInputArea,
      getInputBox: () => inputBox,
      getAttachmentStore: () => attachmentStore,
      getChatMessages: () => chatMessages,
      getExecModeIcon: () => execModeIcon,
      getExecModeCurrent: () => execModeCurrent,
      getExecModeMenu: () => execModeMenu,
      getGitPanelFeature: () => gitPanelFeature,
      getChatRenderer: () => chatRenderer,
      getExecutionMode: () => executionMode,
      setExecutionMode: v => { executionMode = v },
      getNoProjectChatPrompt: () => NO_PROJECT_CHAT_PROMPT,
      getNoProjectSendPrompt: () => NO_PROJECT_SEND_PROMPT,
      getQuotedArtifacts: () => quotedArtifacts,
      setQuotedArtifacts: value => { quotedArtifacts = value },
      setCurrentProjectPath: v => { currentProjectPath = v },
      setCurrentStoragePath: v => { currentStoragePath = v },
      setCurrentSkill: v => { currentSkill = v },
      setCurrentAiMsg: v => { currentAiMsg = v },
      setCurrentToolCount: v => { currentToolCount = v },
      setCurrentOpCount: v => { currentOpCount = v },
      renderProjectList,
      updateSkillButton,
      updateProjectDisplay,
      updateSidebarContext,
      updateSendBtnState,
      syncUploadedFiles,
      renderUploadedFiles,
      renderArtifactRefs,
      syncChatBottomInset,
      scrollToLatestAiMessage,
      showToast,
      // switchProject / createProject 在后续初始化，发送时再从全局读取
      switchProject: (...args) => (typeof window.switchProject === 'function'
        ? window.switchProject(...args)
        : window.ProjectSwitcher?.switchProject?.(...args)),
      createProject: (...args) => (typeof createProject === 'function'
        ? createProject(...args)
        : _psh?.createProject?.(...args))
    })
    function syncProjectState(...a) { return _psh.syncProjectState(...a) }
    function setProjectActivity(...a) { return _psh.setProjectActivity(...a) }
    function clearViewedProjectActivity(...a) { return _psh.clearViewedProjectActivity(...a) }
    function setProjectModel(...a) { return _psh.setProjectModel(...a) }
    function resolveProjectModelIndex(...a) { return _psh.resolveProjectModelIndex(...a) }
    function getProjectModel(...a) { return _psh.getProjectModel(...a) }
    function getProjectModelName(...a) { return _psh.getProjectModelName(...a) }
    function getProjectContextDescriptor(project) {
      const model = getProjectModel(project)
      return {
        modelName: model?.modelName || getProjectModelName(project) || '',
        modelId: model?.modelId || '',
        modelKey: model?.modelKey || project?.modelKey || '',
        contextWindow: model?.contextWindow || model?.contextLength || model?.maxContextTokens || 0
      }
    }
    function syncAllProjectModelRefs(...a) { return _psh.syncAllProjectModelRefs(...a) }
    function ensureActiveProject(...a) { return _psh.ensureActiveProject(...a) }
    function hasVisibleProjects(...a) { return _psh.hasVisibleProjects(...a) }
    function setChatInputVisible(...a) { return _psh.setChatInputVisible(...a) }
    function enterNoProjectState(...a) { return _psh.enterNoProjectState(...a) }
    function renderWelcomeEmptyState(...a) { return _psh.renderWelcomeEmptyState(...a) }
    function clearWelcomeEmptyState(...a) { return _psh.clearWelcomeEmptyState(...a) }
    function hasWelcomeEmptyState(...a) { return _psh.hasWelcomeEmptyState(...a) }
    function ensureStatelessChatProject(...a) { return _psh.ensureStatelessChatProject(...a) }
    function showNoProjectSendPrompt(...a) { return _psh.showNoProjectSendPrompt(...a) }
    window.renderWelcomeEmptyState = renderWelcomeEmptyState
    window.clearWelcomeEmptyState = clearWelcomeEmptyState
    window.hasWelcomeEmptyState = hasWelcomeEmptyState
    window.ensureStatelessChatProject = ensureStatelessChatProject
    window.restoreWelcomeComposerInput = function () { return _psh.restoreWelcomeComposerInput() }
    function setActiveProject(...a) { return _psh.setActiveProject(...a) }
    function generateProjectId(...a) { return _psh.generateProjectId(...a) }
    function createProject(...a) { return _psh.createProject(...a) }
    function saveProjectsList(...a) { return _psh.saveProjectsList(...a) }
    function loadProjectsList(...a) { return _psh.loadProjectsList(...a) }
    function getActiveProject(...a) { return _psh.getActiveProject(...a) }
    function updateExecModeUI(...a) { return _psh.updateExecModeUI(...a) }
    function loadGitStatusForProject(...a) { return _psh.loadGitStatusForProject(...a) }
    function initGitForProject(...a) { return _psh.initGitForProject(...a) }
    function addUserMessageToUI(...a) { return _psh.addUserMessageToUI(...a) }
    function addAiMessageToUI(...a) { return _psh.addAiMessageToUI(...a) }
    function restoreChatHistory(...a) { return _psh.restoreChatHistory(...a) }
    function mapMessagesHistoryForProject(...a) { return _psh.mapMessagesHistoryForProject(...a) }
    function isAiMessageStillRunning(...a) { return _psh.isAiMessageStillRunning(...a) }
    function isProjectAiRunActive(...a) { return _psh.isProjectAiRunActive(...a) }
    function stripActiveRunHistory(...a) { return _psh.stripActiveRunHistory(...a) }

    window.ProjectInit.bind({
      getProjects: () => projects,
      getActiveProjectId: () => activeProjectId,
      getActiveProject,
      getModelCurrent: () => modelCurrent,
      loadProjectsList,
      createProject,
      resolveProjectModelIndex,
      getProjectContextDescriptor,
      loadGitStatusForProject,
      generateProjectId,
      enterNoProjectState,
      setActiveProject,
      setChatInputVisible,
      setCurrentProjectPath: v => { currentProjectPath = v },
      setCurrentSkill: v => { currentSkill = v },
      updateSkillButton: () => updateSkillButton(),
      saveProjectsList,
      syncProjectBranchSession,
      restoreRecentHistoryByRounds,
      mapMessagesHistoryForProject,
      getProjectModel,
      ensureActiveProject,
      hasVisibleProjects,
      renderProjectList,
      updateSidebarProject,
      loadContextStatus,
      refreshTerminalPanel: id => terminalPanel?.refresh?.(id),
      updateProjectDisplay
    })

    // 缓存使用量渲染模块（已提取到 features/cache-usage-renderer.js）
    window.CacheUsageRenderer.bind({
      escapeHtml,
      syncChatBottomInset,
      getActiveProjectId: () => activeProjectId
    })
    const {
      formatCompactTokenCount,
      setCacheUsageText,
      withCacheUsageViewState,
      resetCacheUsageViewState,
      resetCacheUsageStrip,
      renderActiveCacheUsageStrip,
      renderCacheUsage
    } = window.CacheUsageRenderer

    // AI运行时缓存与快照（已提取到 features/ai-runtime-cache.js）
    window.AiRuntimeCache.bind({
      getCurrentAiMsg: () => currentAiMsg,
      setCurrentAiMsg: v => { currentAiMsg = v },
      getCurrentToolCount: () => currentToolCount,
      setCurrentToolCount: v => { currentToolCount = v },
      getCurrentOpCount: () => currentOpCount,
      setCurrentOpCount: v => { currentOpCount = v },
      getCurrentChangeSession: () => currentChangeSession,
      setCurrentChangeSession: v => { currentChangeSession = v },
      setCurrentThinkingBlock: v => { currentThinkingBlock = v },
      setCurrentThinkingStartTime: v => { currentThinkingStartTime = v },
      getChatMessages: () => chatMessages,
      getAiMessageUI: () => aiMessageUI,
      updateWorkStatus,
      isProjectAiRunActive,
      addThinking: (...a) => addThinking(...a),
      appendAiContentChunk: (...a) => appendAiContentChunk(...a),
      preShowOperation: (...a) => aiToolRenderer?.preShowOperation?.(...a),
      updateStreamingOperation: (...a) => aiToolRenderer?.updateStreamingOperation?.(...a),
      addOperation: (...a) => addOperation(...a),
      startToolGroup,
      updateAiStats: (...a) => updateAiStats(...a)
    })
    const {
      getProjectRuntimeKey,
      getCachedAiRuntime,
      cacheAiRuntimeForProject,
      clearAiRuntimeForProject,
      captureRunningAiSnapshot,
      restoreAiMessageFromSnapshot,
      resumeRunningAiMessage,
      reattachProjectAiRuntime,
      replayProjectAiOperations
    } = window.AiRuntimeCache

    // AI 运行时辅助函数（已提取到 features/ai-message-helpers.js）
    const _amh = window.AiMessageHelpers.bind({
      getCurrentAiMsg: () => currentAiMsg,
      setCurrentAiMsg: v => { currentAiMsg = v },
      getCurrentToolCount: () => currentToolCount,
      setCurrentToolCount: v => { currentToolCount = v },
      getCurrentOpCount: () => currentOpCount,
      setCurrentOpCount: v => { currentOpCount = v },
      getCurrentChangeSession: () => currentChangeSession,
      setCurrentChangeSession: v => { currentChangeSession = v },
      getChatMessages: () => chatMessages,
      getActiveProjectId: () => activeProjectId,
      getActiveProject,
      isProjectAiRunActive,
      getCachedAiRuntime,
      cacheAiRuntimeForProject,
      restoreAiMessageFromSnapshot,
      reattachProjectAiRuntime,
      replayProjectAiOperations,
      resumeRunningAiMessage,
      createAiMessage: (...a) => createAiMessage(...a),
      updateSendBtnState,
      syncAiStateToProject
    })
    function ensureCurrentAiMessageForProject(...a) { return _amh.ensureCurrentAiMessageForProject(...a) }
    function getVisibleAiMessageForProject(...a) { return _amh.getVisibleAiMessageForProject(...a) }
    function applyProjectRunStartTime(...a) { return _amh.applyProjectRunStartTime(...a) }
    function ensureRunningAiBlockVisible(...a) { return _amh.ensureRunningAiBlockVisible(...a) }
    function scheduleRunningAiBlockEnsure(...a) { return _amh.scheduleRunningAiBlockEnsure(...a) }

    window.UserMessageEdit?.bind?.({
      getActiveProject,
      showToast,
      stripMentionDirectives: (...args) => stripMentionDirectives(...args),
      sendMessage,
      replaceHistory: (...args) => window.ChatMessageActions?.replaceHistory?.(...args)
    })

    window.ChatMessageActions = {
      getActiveProjectId: () => activeProjectId,
      showToast,
      addQuotedReference: (reference) => {
        if (!reference) return
        if (reference.type === 'artifact' || reference.artifactId) return
        const normalized = {
          type: reference.type || (reference.summaryId ? 'summary' : 'message'),
          summaryId: reference.summaryId || '',
          turnId: Number(reference.turnId) || null,
          part: reference.part || '',
          title: reference.title || '',
          content: reference.content || '',
          preview: reference.preview || ''
        }
        const key = normalized.type === 'summary'
          ? `summary:${normalized.summaryId}`
          : `message:${normalized.part}:${normalized.turnId}`
        if ((normalized.type === 'summary' && !normalized.summaryId) || (normalized.type === 'message' && (!normalized.turnId || !normalized.part))) return
        if (quotedArtifacts.some(item => item._key === key)) return
        quotedArtifacts.push({ ...normalized, _key: key })
        renderArtifactRefs()
        inputBox.focus()
        showToast(((window.i18n?.t?.('auto.js_app_1391_3') ?? ((window.i18n?.t?.('auto.js_app_1391_17') ?? '已引用，发送时会加入本轮上下文')))), 'info')
      },
      canDeleteMessages: () => {
        const project = getActiveProject()
        return !project?.isRunning
      },
      replaceHistory: (messagesHistory = [], pageData = null, done = null) => {
        const project = getActiveProject()
        if (!project) {
          if (typeof done === 'function') done()
          return
        }
        project.messagesHistory = Array.isArray(messagesHistory) ? messagesHistory : []
        project.history = mapMessagesHistoryForProject(messagesHistory)
        // 删除消息后先恢复输入，再异步重建历史 DOM，避免短暂点不进输入框
        unlockChatComposer({ clearValue: false, focus: true })
        scheduleAfterInteraction(() => {
          let finished = false
          const finish = () => {
            if (finished) return
            finished = true
            renderChatHistory()
            pollContextStatus()
            unlockChatComposer({ clearValue: false, focus: true })
            if (typeof done === 'function') done()
          }
          if (messagesHistory.length > 0) {
            // 交给虚拟滚动器重置历史 DOM，避免外层一次性同步清空/重建大量节点。
            // 必须等 onReady 后再继续发送，否则刚挂上的 AI 块会被 innerHTML 清掉。
            restoreRecentHistoryByRounds(messagesHistory, project.path, pageData, project.id, { onReady: finish })
            setTimeout(finish, 700)
            return
          }
          window.ChatVirtualScroller?.destroy?.(chatMessages)
          chatMessages.innerHTML = ''
          finish()
        })
      }
    }

    // ===== AI可见性分割线功能 =====

    // 更新消息可见性（根据边界索引）
    function updateMessagesVisibility() {
      return contextVisibility?.updateMessagesVisibility()
    }

    // 应用可见性到消息元素
    function applyVisibilityToMessages(startIndex, stats) {
      return contextVisibility?.applyVisibilityToMessages(startIndex, stats)
    }

    // 渲染分割线
    function renderContextDivider(startIndex, stats) {
      return contextVisibility?.renderContextDivider(startIndex, stats)
    }

    // 重置可见边界
    function resetVisibility() {
      return contextVisibility?.resetVisibility()
    }

    // 显示记忆查询面板
    function showMemoryQuery() {
      return contextVisibility?.showMemoryQuery()
    }

    // 显示分割线
    function showSplitDivider(splitIndex, summary) {
      return contextVisibility?.showSplitDivider(splitIndex, summary)
    }

    // 获取工具类型（用于显示图标）
    function getToolType(name) {
      return window.AiMessageUI?.getToolType(name) || 'unknown'
    }

    // 获取工具摘要（用于显示标题）
    function getToolSummary(name, args, result) {
      return window.AiMessageUI?.getToolSummary(name, args, result) || name
    }

    // 智能执行系统状态
    let executionMode = 'ask'  // ask | full（与设置页 AI 授权同步）
    let currentPhase = 'normal'  // normal | plan | auto-exec
    let planSteps = []  // 计划步骤列表
    let currentStepIndex = 0  // 当前执行步骤
    let pendingAsk = null  // 待处理的询问

    const modelStore = window.ModelStore
    let currentConfig = modelStore?.getCurrentModel() || {}
    let savedModels = modelStore?.getModels() || []  // 已保存的模型列表
    let currentModelIndex = modelStore?.getCurrentIndex() ?? -1  // 当前使用的模型索引
    let editingModelIndex = -1  // 正在编辑的模型索引

    function syncModelState() {
      savedModels = modelStore?.getModels() || []
      currentModelIndex = modelStore?.getCurrentIndex() ?? -1
      currentConfig = modelStore?.getCurrentModel() || {}
      syncAllProjectModelRefs()
    }

    // ===== 按项目隔离的AI状态 =====
    // getProjectAiState / getActiveAiState / scrollChatToBottomNow / followChatToBottom
    // / syncAiStateToProject / syncAiStateFromProject / generateSummaryHtml / clearToolStats
    // 已提取到 features/project-ai-state.js

    // 兼容旧代码的快捷访问
    let currentAiMsg = null     // 指向当前激活项目的 _aiState.currentAiMsg
    let userHasScrolledUp = false  // 用户是否往上滚动了（停止自动滚动）
    let lastScrollTop = 0       // 上次滚动位置（用于检测往上滚动）
    let currentToolCount = 0
    let currentOpCount = 0
    let currentToolStats = { modified: [], created: [], read: [], commands: [] }  // 工具调用统计
    let currentChangeSession = null
    let autoFollowCurrentRun = false
    let contextCompressionInFlight = false

    aiMessageUI = window.AiMessageUI?.bind({
      getCurrentAiMsg: () => currentAiMsg,
      onStatusFrame: () => followChatToBottom(autoFollowCurrentRun)
    })
    const aiToolRenderer = window.AiToolRenderer?.bind({
      getCurrentAiMsg: () => currentAiMsg,
      getCurrentProjectPath: () => getActiveProject()?.path || '',
      getOpIcons: () => opIcons,
      getOpTypes: () => opTypes,
      getFileName,
      calculateEditLines,
      sanitizeContent: content => sanitizeAiContent(content)
    })
    summaryMenu = window.SummaryMenu?.bind({
      api: window.api,
      showToast,
      getFileName,
      openFilePreview: (...a) => window.AiFileReference?.openFilePreview?.(...a)
    })
    changeSessionActions = window.ChangeSessionActions?.bind({
      api: window.api,
      getActiveProject,
      sendPrompt: sendChangeSessionPrompt,
      showToast,
      refreshProject: () => {
        const project = getActiveProject()
        if (project) loadGitStatusForProject(project)
      }
    })
    aiChangePill = window.AiChangePill?.bind({
      api: window.api,
      getActiveProject,
      showToast,
      openInRightView: detail => {
        windowTabsFeature?.createChangeDiffTab?.(detail)
      }
    })
    window.aiChangePill = aiChangePill
    // 操作摘要文件行 +N/-N 打开右侧改前改后
    window.openSummaryChangeDiff = detail => {
      windowTabsFeature?.createChangeDiffTab?.(detail)
    }
    window.getActiveProject = getActiveProject
    async function sendTerminalOutputToAi(content) {
      if (!content) return false
      const project = getActiveProject()
      if (project?.isRunning) {
        showToast('当前会话的 AI 正在执行，请结束或中断后再发送终端输出', 'warning')
        return false
      }
      await sendMessage({
        aiMessage: content,
        displayMessage: '请分析当前终端输出'
      })
      return true
    }
    terminalPanel = window.TerminalPanel?.bind({
      api: window.api,
      getProject: getActiveProject,
      showToast,
      onSendToAi: sendTerminalOutputToAi
    })

    // 文件摘要右键菜单
    function showSummaryFileMenu(event, element) {
      return summaryMenu?.showSummaryFileMenu(event, element)
    }

    function closeSummaryFileMenu() {
      return summaryMenu?.closeSummaryFileMenu()
    }

    function repairChangeSession(button) {
      return changeSessionActions?.repair(button)
    }

    function rollbackChangeSession(button) {
      return changeSessionActions?.rollback(button)
    }

    function viewSafetySnapshotDiff(button) {
      return changeSessionActions?.viewSnapshotDiff(button)
    }

    function restoreSafetySnapshot(button) {
      return changeSessionActions?.restoreSnapshot(button)
    }

    // 标签页管理（已提取到 features/tabs-proxy.js）
    const tabsProxy = window.TabsProxy.bind({
      elements: { tabCountEl, webviewPanel, center, divider1, sidebar, sidebarToggle, rightViewToggle, webviewContainer, webviewTabs, webviewEmpty, webviewPanelExpand, collapseBtn },
      layoutUI,
      monacoEditors,
      initMonaco,
      getMonacoLanguage,
      getFileName,
      getOpIcons: () => opIcons,
      showToast,
      updateRightPanelWidthVar,
      scrollToLatestAiMessage,
      scrollChatToBottom: () => scrollChatToBottomNow(),
      getActiveProject,
      getActiveProjectId: () => activeProjectId,
      getProjects: () => projects,
      getSavedModels: () => savedModels,
      getAllSkills: () => allSkills,
      getEnabledSkills: () => enabledSkills,
      getProjectModel,
      switchProject,
      sendMessage,
      getCurrentAiMsg: () => currentAiMsg,
      api: window.api
    })
    windowTabsFeature = tabsProxy.windowTabsFeature
    filePreview = tabsProxy.filePreview
    window.AiFileReference.bind({
      getChatMessages: () => chatMessages,
      getActiveProject,
      getFilePreview: () => filePreview,
      showToast
    })
    const openFilePreviewFromData = (...a) => window.AiFileReference.openFilePreviewFromData(...a)
    const openFilePreview = (...a) => window.AiFileReference.openFilePreview(...a)
    const openImagePreviewFromData = (...a) => window.AiFileReference.openImagePreviewFromData(...a)
    const {
      updateTabCount,
      adjustLayout,
      createTab,
      createFileTab,
      createMusicTab,
      sendMusicCommand,
      createCollaborationTab,
      showCanvasInspector,
      closeCanvasInspector,
      renderMainPlanPanel,
      openAgentMusicStudioFromTool,
      openBlendFile,
      showBlendInFolder,
      createEmbeddedFileTab,
      markFileModified,
      toggleFileRunMode,
      saveFileTab,
      createEmbeddedTab,
      setupWebviewEvents,
      detachTab,
      updateTabLabel,
      switchTab,
      closeTab,
      openInWebview,
      openInNewTab
    } = tabsProxy
    Object.assign(window, {
      createTab,
      createFileTab,
      createMusicTab,
      sendMusicCommand,
      createCollaborationTab,
      showCanvasInspector,
      closeCanvasInspector,
      openAgentMusicStudioFromTool,
      openBlendFile,
      showBlendInFolder,
      createEmbeddedFileTab,
      markFileModified,
      toggleFileRunMode,
      saveFileTab,
      createEmbeddedTab,
      setupWebviewEvents,
      detachTab,
      updateTabLabel,
      switchTab,
      closeTab,
      openInWebview,
      openInNewTab
    })

    // 聊天顶栏：终端右侧的浏览器入口 → 直接打开右侧百度页（无需 AI 输出链接）
    const toolbarBrowserBtn = document.getElementById('toolbarBrowserBtn')
    if (toolbarBrowserBtn) {
      toolbarBrowserBtn.addEventListener('click', () => {
        const homeUrl = 'https://www.baidu.com'
        try {
          if (typeof openInWebview === 'function') openInWebview(homeUrl)
          else if (typeof createTab === 'function') createTab(homeUrl)
          else showToast?.('浏览器入口暂不可用', 'warning')
        } catch (error) {
          console.warn('[ToolbarBrowser] open failed:', error)
          showToast?.(error?.message || '打开浏览器失败', 'error')
        }
      })
    }

    // 快速模型设置（已提取到 features/model-settings-proxy.js）
    const _msp = window.ModelSettingsProxy.bind({
      modelStore,
      getModels: () => savedModels,
      getCurrentIndex: () => currentModelIndex,
      getCurrentConfig: () => currentConfig,
      syncModelState,
      getActiveProject,
      getProjectModelIndex: resolveProjectModelIndex,
      setProjectModel,
      getEditingIndex: () => editingModelIndex,
      setEditingIndex: index => { editingModelIndex = index },
      settingsPanelUI,
      openModelEditorModal: (mode, index) => settingsMainFeature?.openModelEditorModal?.(mode, index),
      saveProjectsList
    })
    quickModelSettings = _msp.quickModelSettings
    const {
      fillQuickModelForm,
      switchSettingsTab,
      renderModelList,
      renderModelSelect,
      useModel,
      editModel,
      deleteModel,
      saveModel,
      setupModelDragSort,
      loadConfig,
      saveModelsToStorage
    } = _msp
    Object.assign(window, {
      fillQuickModelForm,
      switchSettingsTab,
      renderModelList,
      renderModelSelect,
      useModel,
      editModel,
      deleteModel,
      saveModel,
      setupModelDragSort,
      loadConfig,
      saveModelsToStorage
    })

    // ========== 标题栏逻辑 ==========
    const aboutPanel = document.getElementById('aboutPanel')
    const aboutClose = document.getElementById('aboutClose')
    titlebarUI.bindAbout(aboutPanel, aboutClose)

    // 标题栏/菜单动作（已提取到 features/titlebar-actions.js）
    window.TitlebarActions.bind({
      getProjects: () => projects,
      getActiveProject,
      getChatMessages: () => chatMessages,
      getAboutPanel: () => aboutPanel,
      titlebarUI,
      generateProjectId,
      createProject,
      switchProject,
      setActiveProject,
      syncAiStateToProject,
      setChatInputVisible,
      setCurrentProjectPath: v => { currentProjectPath = v },
      setCurrentSkill: v => { currentSkill = v },
      updateSkillButton,
      getProjectModelName,
      loadGitStatusForProject,
      renderProjectList,
      updateSidebarProject,
      updateProjectDisplay,
      mapMessagesHistoryForProject,
      restoreChatHistory,
      renderChatHistory,
      saveProjectsList,
      loadContextStatus,
      initProgressIndicator,
      showToast
    })
    const {
      normalizeMenuAction,
      openAboutPanel,
      openProjectFromMenu,
      exportActiveProjectHistory,
      pickJsonFile,
      readTextFile,
      extractImportedMessages,
      importActiveProjectHistory,
      clearVisibleChatFromMenu,
      clearContextFromMenu,
    } = window.TitlebarActions

    titlebarUI.bindTitlebar({
      onMenuItem: async (action, text) => {
        const menuAction = normalizeMenuAction(action, text)
        if (menuAction === 'file:open-project') {
          await openProjectFromMenu()
        } else if (menuAction === 'file:import-history') {
          await importActiveProjectHistory()
        } else if (menuAction === 'file:export-history') {
          await exportActiveProjectHistory()
        } else if (menuAction === 'edit:clear-chat') {
          await clearVisibleChatFromMenu()
        } else if (menuAction === 'edit:clear-context') {
          await clearContextFromMenu()
        } else if (menuAction === 'app:about') {
          openAboutPanel()
        } else if (menuAction === 'app:exit') {
          if (window.api) window.api.mainWindowClose()
        } else if (menuAction.includes('设置')) {
          quickModelSettings?.togglePanel()
        }
      }
    })

    // 窗口控制按钮
    titlebarUI.bindWindowControls(window.api)

    // 异步加载配置，等待完成后初始化界面和项目
    const modelConfigLoadPromise = loadConfig()
    window.__lingxiModelConfigReadyPromise = modelConfigLoadPromise
    modelConfigLoadPromise.then(async () => {
      renderModelSelect()
      AppLogger.debug('[Frontend] API 配置已加载，共', savedModels.length, '个模型')
      
      // 配置加载完成后，再初始化项目（确保 savedModels 已准备好）
      await initProjects()
    }).catch(e => {
      console.error('[Frontend] 加载 API 配置失败:', e)
      renderModelSelect()
      // 即使配置加载失败，也要初始化项目
      initProjects().catch(() => {})
    })
    
    // 初始化布局：无浏览器视图时，聊天80% + 功能栏20%（立即执行，不依赖配置）
    adjustLayout(false)

    // ===== 技能系统 =====
    let allSkills = []        // 已安装（纯 Skill + 后续插件）
    let enabledSkills = []    // 已启用 = 可选池（资源中心管理）
    let currentSkill = null   // 输入框当前选中 = 才对模型可见

    bindArchivePanel()
    const integrationMarketFeature = window.IntegrationMarket?.bind({
      showToast,
      getActiveProjectId: () => activeProjectId || '',
      getActiveProject,
      getAllSkills: () => allSkills,
      setAllSkills: skills => { allSkills = skills || [] },
      getEnabledSkills: () => enabledSkills,
      setEnabledSkills: skills => { enabledSkills = skills || [] }
    })

    // ===== 本地应用 =====
    const localAppsFeature = window.LocalApps?.bind({ showToast })

    window.showSummaryFileMenu = showSummaryFileMenu
    window.closeSummaryFileMenu = closeSummaryFileMenu
    window.repairChangeSession = repairChangeSession
    window.rollbackChangeSession = rollbackChangeSession
    window.viewSafetySnapshotDiff = viewSafetySnapshotDiff
    window.restoreSafetySnapshot = restoreSafetySnapshot
    window.resetVisibility = resetVisibility
    window.showMemoryQuery = showMemoryQuery
    window.toggleDynamicArea = toggleDynamicArea
    window.toggleToolCard = toggleToolCard
    window.toggleToolGroup = toggleToolGroup
    window.openFilePreviewFromData = openFilePreviewFromData
    window.openImagePreviewFromData = openImagePreviewFromData
    window.openBlendFile = openBlendFile
    window.showBlendInFolder = showBlendInFolder
    window.openInWebview = openInWebview
    window.toggleFoldedReport = toggleFoldedReport
    window.useModelFromSettings = useModelFromSettings
    window.editModelFromSettings = editModelFromSettings
    window.deleteModelFromSettings = deleteModelFromSettings

    // 加载技能列表
    skillsFeature = window.SkillsMain?.bind({
      getAllSkills: () => allSkills,
      setAllSkills: skills => { allSkills = skills || [] },
      getEnabledSkills: () => enabledSkills,
      setEnabledSkills: skills => { enabledSkills = skills || [] },
      getCurrentSkill: () => currentSkill,
      setCurrentSkill: skillName => { currentSkill = skillName },
      getActiveProject,
      showToast
    })
    window.__buildSkillContentForSend = (opts) => skillsFeature?.buildSkillContentForSend?.(opts) || null

    async function loadSkills() {
      return await skillsFeature?.loadSkills()
    }

    function renderSkillCategoryTabs() {
      return skillsFeature?.renderSkillCategoryTabs()
    }

    function renderSkillList(filter = '') {
      return skillsFeature?.renderSkillList(filter)
    }

    function showSkillDetail(skillName) {
      return skillsFeature?.showSkillDetail(skillName)
    }

    function closeSkillDetail() {
      return skillsFeature?.closeSkillDetail()
    }

    function closeSkillPanel() {
      return skillsFeature?.closeSkillPanel()
    }

    function updateSkillButton() {
      return skillsFeature?.updateSkillButton?.()
    }

    function getCurrentSkillContent() {
      return skillsFeature?.getCurrentSkillContent() || null
    }
    // ===== 设置面板事件 =====
    const workerModelSettings = window.WorkerModelSettings?.bind({
      showToast,
      getModels: () => savedModels,
      modelStore
    })

    async function loadWorkerModelSettings() {
      return await workerModelSettings?.load()
    }

    const aiPermissionSettings = window.AIPermissionSettings?.bind({
      showToast
    })

    async function loadAIPermissionSettings() {
      return await aiPermissionSettings?.load()
    }

    settingsMainFeature = window.SettingsMain?.bind({
      showToast,
      modelStore,
      getModels: () => savedModels,
      syncModelState,
      saveModelsToStorage,
      renderModelSelect,
      useModel,
      loadSettingsPaths,
      loadWorkerModelSettings,
      loadAIPermissionSettings,
      getEditingIndex: () => editingModelIndex,
      setEditingIndex: index => { editingModelIndex = index }
    })

    function renderSettingsModelList() {
      return settingsMainFeature?.renderSettingsModelList()
    }

    function renderCapabilityRouting() {
      return settingsMainFeature?.renderCapabilityRouting?.()
    }

    function useModelFromSettings(index) {
      return settingsMainFeature?.useModelFromSettings(index)
    }

    function editModelFromSettings(index) {
      return settingsMainFeature?.editModelFromSettings(index)
    }

    function deleteModelFromSettings(index) {
      return settingsMainFeature?.deleteModelFromSettings(index)
    }
    // 加载存储路径（统一路径管理）
    storageSettings = window.StorageSettings?.bind({
      showToast,
      getActiveProject,
      onStorageChanged: async () => {
        if (window.api?.reloadSkills) {
          await window.api.reloadSkills()
        }
      }
    })
    window.StorageSettingsInstance = storageSettings
    window.AiOperationMemoSettings?.bind({ showToast })

    themeSettings = window.ThemeSettings?.bind({ showToast })

    async function loadSettingsPaths() {
      return await storageSettings?.loadSettingsPaths()
    }

    // ===== Git 面板事件 =====
    gitPanelFeature = window.GitPanel?.bind({
      getActiveProject,
      showToast,
      removeToast,
      renderProjectList,
      chatMessages,
      onBranchSessionChanged: reloadActiveBranchSession
    })
    // 供侧栏分支菜单等外部入口复用 Git 面板能力
    if (gitPanelFeature) {
      window.GitPanelApi = gitPanelFeature
    }

    function showGitPanel() {
      return gitPanelFeature?.showGitPanel()
    }

    async function loadGitStatus() {
      return await gitPanelFeature?.loadGitStatus()
    }

    async function loadGitHistory() {
      return await gitPanelFeature?.loadGitHistory()
    }

    async function showGitDiffPanel(projectPath, hash) {
      return await gitPanelFeature?.showGitDiffPanel(projectPath, hash)
    }

    async function loadGitBranches() {
      return await gitPanelFeature?.loadGitBranches()
    }
    // 初始加载技能
    loadSkills()

    // 功能栏按钮事件
    const sidebarProjectName = document.getElementById('sidebarProjectName')
    projectActions = window.ProjectActions?.bind({
      getProjects: () => projects,
      getActiveProject,
      generateProjectId,
      createProject,
      switchProject,
      setActiveProject,
      syncAiStateToProject,
      getSavedModels: () => savedModels,
      getProjectModelName,
      chatMessages,
      setCurrentProjectPath: path => { currentProjectPath = path },
      loadGitStatusForProject,
      renderProjectList,
      updateSidebarProject,
      updateProjectDisplay,
      loadContextStatus,
      setChatInputVisible,
      enterNoProjectState,
      closeSkillPanel,
      showToast,
      showProjectTextInputDialog
    })
    // 创建用户消息
    function addUserMessage(content, options = {}) {
      // 用户发送新消息，重置滚动状态
      userHasScrolledUp = false
      lastScrollTop = 0

      const project = getActiveProject()
      const userMsgIndex = project ? project.history.filter(m => m.role === 'user' && !m.hidden).length : 0
      // 计算 turnId：基于记忆系统的历史长度（如果没有记忆系统，使用当前用户消息数 + 1）
      const turnId = userMsgIndex + 1  // Turn ID 从 1 开始，每条用户消息是一个新 Turn
      return addUserMessageToUI(content, userMsgIndex, turnId, options)
    }

    // 获取当前项目使用的模型显示名
    function getModelDisplayName() {
      const project = getActiveProject()
      return getProjectModelName(project) || ((window.i18n?.t?.('auto.js_app_2230_25') ?? '灵犀LingXiCode'))
    }

    // AI 流式渲染（已提取到 features/ai-stream-renderer.js）
    window.AiStreamRenderer.bind({
      getCurrentAiMsg: () => currentAiMsg,
      setCurrentAiMsg: v => { currentAiMsg = v },
      getCurrentThinkingBlock: () => currentThinkingBlock,
      setCurrentThinkingBlock: v => { currentThinkingBlock = v },
      setCurrentThinkingStartTime: v => { currentThinkingStartTime = v },
      setCurrentThinkingTimerId: v => { currentThinkingTimerId = v },
      getToolCallCount: () => toolCallCount,
      setToolCallCount: v => { toolCallCount = v },
      getCurrentToolCount: () => currentToolCount,
      getCurrentOpCount: () => currentOpCount,
      getCurrentToolStats: () => currentToolStats,
      getAutoFollowCurrentRun: () => autoFollowCurrentRun,
      getChatMessages: () => chatMessages,
      getAiMessageUI: () => aiMessageUI,
      getAiToolRenderer: () => aiToolRenderer,
      getActiveProject,
      getModelDisplayName,
      scrollToLatestAiMessage,
      ensureCurrentAiMessageForProject,
      updateWorkStatus,
      collapseDynamicArea,
      finishThinkingBlock,
      followChatToBottom,
      sanitizeAiContent,
      renderAiContent,
      generateSummaryHtml,
      clearToolStats,
      startTypewriterEffect
    })
    const {
      createAiMessage,
      createNewThinkingBlock,
      stopThinkingTimer,
      addThinking,
      appendAiContentChunk,
      resetFinalStreamContent,
      appendAiFinalDelta,
      finishAiStreaming,
      refreshCurrentSummary,
      updateAiStats,
      finishStreamingOnInterrupt,
      isInternalUiOnlyTool,
      addOperation,
      addIntermediateContent
    } = window.AiStreamRenderer

    // 折叠/展开动态区域
    function toggleDynamicArea(headerEl) {
      return aiMessageUI?.toggleDynamicArea(headerEl)
    }

    // 收起动态区域（当开始输出最终正文时调用）
    function collapseDynamicArea() {
      return aiMessageUI?.collapseDynamicArea()
    }

    // 更新工作状态文字
    function updateWorkStatus(status) {
      return aiMessageUI?.updateWorkStatus(currentAiMsg, status)
    }

    function updateWorkElapsed(final = false) {
      return aiMessageUI?.updateWorkElapsed?.(currentAiMsg, final)
    }

    // 交替显示相关状态
    let currentThinkingBlock = null      // 当前活跃的思考块
    let currentThinkingStartTime = null  // 当前思考块开始时间
    let currentThinkingTimerId = null    // 当前思考块计时器ID
    let toolCallCount = 0                // 工具调用计数

    // 思考块计时器
    function startBlockTimer(blockEl) {
      const timerId = aiMessageUI?.startBlockTimer(blockEl)
      currentThinkingTimerId = timerId
      return timerId
    }

    // 结束思考块计时
    function finishThinkingBlock(blockEl, reason = 'done') {
      return aiMessageUI?.finishThinkingBlock(blockEl, reason)
    }

    // 展开/折叠思考块
    function toggleThinkingBlock(headerRowEl) {
      return aiMessageUI?.toggleThinkingBlock(headerRowEl)
    }

    // 展开/折叠操作列表
    function toggleAiStats(statsEl) {
      return aiMessageUI?.toggleAiStats(statsEl)
    }

    // 展开/折叠单个操作
    function toggleOpDetail(headerEl) {
      return aiMessageUI?.toggleOpDetail(headerEl)
    }

    // setAiContent / startTypewriterEffect / finishTypewriterEffect / setAiContentImmediate
    // / sanitizeAiContent / normalizeRenderOptions / renderAiContent 已提取到 features/ai-content-renderer.js
    aiMessageUI?.ensureTypewriterStyle()

    // Toast 提示系统
    function normalizeToastMessage(message) {
      const text = String(message || '')
      if (/瀹告彃缍婄痪鎶|顕嗙窗|顕嗟窗|宸插綊绾|已归纳项目|已归档项目/.test(text)) {
        const projectName = text
          .replace(/^.*?(?:顕嗙窗|[：:])/, '')
          .replace(/^已归纳项目[：:]?/, '')
          .replace(/^已归档项目[：:]?/, '')
          .trim()
        return `已归档项目：${projectName}`
      }
      if (/宸叉斁鍥|已放回项目列表/.test(text)) {
        const projectName = text
          .replace(/^.*?[：:]/, '')
          .replace(/^已放回项目列表[：:]?/, '')
          .trim()
        return `已放回项目列表：${projectName}`
      }
      return message
    }

    function showToast(message, type = 'info', duration = 3000) {
      return window.ToastUI?.show(normalizeToastMessage(message), type, duration)
    }
    function removeToast(toastEl) {
      return window.ToastUI?.remove(toastEl)
    }

    const opIcons = window.AiMessageUI?.opIcons || {}
    const opTypes = window.AiMessageUI?.opTypes || {}

    // 计算编辑行数变化
    function calculateEditLines(oldStr, newStr) {
      return window.AiMessageUI?.calculateEditLines(oldStr, newStr) || { add: 0, remove: 0, modified: false }
    }

    // 提取文件路径显示名
    function getFileName(path) {
      return window.AiMessageUI?.getFileName(path) || ''
    }

    // 输入框上方执行计划待办面板（plan-progress-dock）
    let isProgressExpanded = false
    let progressPhaseLabel = ''

    function resolveProgressPhaseLabel(options = {}) {
      const steps = Array.isArray(options.steps) ? options.steps : (Array.isArray(planSteps) ? planSteps : [])
      const stepIndex = Number.isFinite(Number(options.currentStepIndex))
        ? Number(options.currentStepIndex)
        : Number(currentStepIndex) || 0
      const total = steps.length
      const allDone = total > 0 && stepIndex >= total
      const rawPhase = String(options.phase || progressPhaseLabel || '').trim()
      const normalizedPhase = rawPhase.replace(/[.。…]+$/g, '')

      if (allDone) {
        if (!normalizedPhase || normalizedPhase === '执行中' || normalizedPhase === '计划确认') return '已完成'
        return normalizedPhase
      }

      if (normalizedPhase && normalizedPhase !== '已完成') return normalizedPhase
      if (currentPhase === 'plan') return '计划确认'
      if (currentPhase === 'auto-exec') return '执行中'
      return normalizedPhase || ''
    }

    function updateExecutionProgress(options = {}) {
      const ui = window.PlanProgressUI
      if (!ui) return

      const steps = Array.isArray(options.steps) ? options.steps : (Array.isArray(planSteps) ? planSteps : [])
      if (!steps.length || currentPhase === 'normal') {
        progressPhaseLabel = ''
        ui.clear()
        return
      }

      if (options.phase != null) {
        progressPhaseLabel = String(options.phase || '').trim()
      }

      const phaseLabel = resolveProgressPhaseLabel({
        steps,
        currentStepIndex: options.currentStepIndex,
        phase: progressPhaseLabel
      })

      // 同步到当前项目，便于切换项目后恢复
      const project = getActiveProject()
      if (project) {
        project.progressPhase = currentPhase
        project.progressPhaseLabel = phaseLabel
        project.progressSteps = steps.slice()
        project.progressStepIndex = currentStepIndex
        project.progressExpanded = isProgressExpanded
      }

      ui.render({
        steps,
        currentStepIndex,
        phase: phaseLabel,
        expanded: isProgressExpanded,
        onToggleExpand: () => {
          isProgressExpanded = !isProgressExpanded
          const active = getActiveProject()
          if (active) active.progressExpanded = isProgressExpanded
          updateExecutionProgress()
        }
      })
    }

    // 隐藏/重置进度指示器（切换项目、清空聊天等）
    function initProgressIndicator() {
      currentPhase = 'normal'
      planSteps = []
      currentStepIndex = 0
      isProgressExpanded = false
      progressPhaseLabel = ''

      const project = getActiveProject()
      if (project) {
        project.progressPhase = 'normal'
        project.progressPhaseLabel = ''
        project.progressSteps = []
        project.progressStepIndex = 0
        project.progressExpanded = false
      }

      window.PlanProgressUI?.clear?.()
      executionProgressUI.clear?.()
    }

    function startToolGroup() {
      return aiToolRenderer?.startToolGroup()
    }

    // 展开/折叠工具卡片
    function toggleToolCard(headerEl) {
      return aiMessageUI?.toggleToolCard(headerEl)
    }

    function toggleToolGroup(headerEl) {
      return aiMessageUI?.toggleToolGroup(headerEl)
    }

    function toggleFoldedReport(buttonEl) {
      return aiMessageUI?.toggleFoldedReport(buttonEl)
    }

    // 创建错误消息
    function addErrorMessage(content) {
      return window.ChatScroll?.addErrorMessage(chatMessages, content)
    }

    function clearProjectAiRunState(project, options = {}) {
      if (!project) return
      const sessionId = options.sessionId
        ?? project._runningSessionId
        ?? project.chatSessionId
        ?? ''
      clearAiRuntimeForProject(project, sessionId)
      try { window.RunningUiRestore?.clearSnapshot?.(project, sessionId) } catch (_) {}
      project.isRunning = false
      project._runningSessionId = ''
      project.awaitingFinalReply = false
      project._pendingRunningUiRestore = false
      project.aiOperations = []
      project.savedAiMsg = null
      project.savedToolCount = 0
      project.savedOpCount = 0
      project.savedOperationCount = 0
      project.aiRunningState = null
      project._frozenAiHtml = ''
      project._frozenAiClassName = ''
      project._frozenAiDataset = null
      project._frozenAiVisualCount = 0
      project._frozenOpCount = 0
      project._lastSnapshotHtml = ''
      project._lastSnapshotHtmlAt = 0
      project.aiRunStartedAt = 0
      project.aiRunCompletedAt = 0
      project.streamingContent = ''
      if (project._aiState) {
        project._aiState.aiRunStartedAt = 0
        project._aiState.aiRunCompletedAt = 0
        project._aiState.currentAiMsg = null
        project._aiState.currentToolCount = 0
        project._aiState.currentOpCount = 0
        project._aiState.currentChangeSession = null
      }
    }

    function finalizeAiFailure(project, message, options = {}) {
      const mode = options.mode === 'interrupted' ? 'interrupted' : 'error'
      const shouldRenderError = options.renderError !== false && mode === 'error'

      autoFollowCurrentRun = false
      const activitySessionId = project?._runningSessionId || project?.chatSessionId || ''
      clearProjectAiRunState(project, { sessionId: activitySessionId })
      if (project) {
        // 会话级：错误始终红点+红标题；中断则清除该会话指示
        setProjectActivity(
          project,
          mode === 'error' ? 'error' : '',
          { sessionId: activitySessionId }
        )
      }

      if (currentThinkingBlock && !currentThinkingBlock.classList.contains('stopped')) {
        finishThinkingBlock(currentThinkingBlock, mode)
      }
      currentThinkingBlock = null

      if (currentAiMsg && document.contains(currentAiMsg)) {
        currentAiMsg.classList.remove('thinking')
        updateWorkStatus(mode)
        window.AiMessageUI?.finishDeepReasoningBlock?.(currentAiMsg)
        window.AiMessageUI?.collapseAllDeepReasoningBlocks?.(currentAiMsg)
        collapseDynamicArea()
        try { window.MessageQueue?.relocatePendingInterjectMessages?.() } catch (_) {}
      }

      currentAiMsg = null
      currentToolCount = 0
      currentOpCount = 0
      syncAiStateToProject()
      updateSendBtnState()

      if (shouldRenderError && message) {
        addErrorMessage(message)
      }
    }

    // ===== 自定义右键菜单 =====
    const contextMenuEl = document.getElementById('contextMenu')
    contextMenuUI.bind(contextMenuEl)

    // 监听AI状态
    if (window.api) {
      // 询问弹窗处理（已提取到 features/ask-popup-handler.js）
      const {
        getAskPopupElements,
        getAskPopupHandlers,
        ensureAskFeedback,
        ensureAskProjectActive,
        showPlanAskPopup,
        showExecAskPopup,
        handleAskResponse
      } = window.AskPopupHandler?.bind({
        aiAskPopup,
        askContent,
        askOptions,
        askCustomInputBox,
        customAnswerInput,
        customSubmitBtn,
        askPopup,
        getProjects: () => projects,
        getActiveProject,
        getActiveProjectId: () => activeProjectId,
        getCurrentAiMsg: () => currentAiMsg,
        getPendingAsk: () => pendingAsk,
        setPendingAsk: v => { pendingAsk = v },
        getExecutionMode: () => executionMode,
        setExecutionMode: v => { executionMode = v },
        updateSendBtnState,
        ensureCurrentAiMessageForProject,
        updateWorkStatus,
        addThinking,
        syncAiStateToProject,
        switchProject
      }) || {}
      // webview/agent/music/embed/projectPathChanged/执行系统 监听器（已提取到 features/ipc-exec-system-listeners.js）
      window.IpcExecSystemListeners.bind({
        getActiveProjectId: () => activeProjectId,
        getProjects: () => projects,
        getCurrentAiMsg: () => currentAiMsg,
        updateExecutionProgress,
        setCurrentPhase: v => { currentPhase = v },
        getPlanSteps: () => planSteps,
        setPlanSteps: v => { planSteps = Array.isArray(v) ? v : [] },
        getCurrentStepIndex: () => currentStepIndex,
        setCurrentStepIndex: v => { currentStepIndex = Number(v) || 0 },
        getPendingAsk: () => pendingAsk,
        setPendingAsk: v => { pendingAsk = v },
        setCurrentProjectPath: v => { currentProjectPath = v },
        setCurrentStoragePath: v => { currentStoragePath = v },
        createTab,
        openInWebview,
        showToast,
        createMusicTab,
        createFileTab,
        sendMusicCommand,
        sendMessage,
        syncProjectState,
        updateProjectDisplay,
        renderProjectList,
    

        ensureCurrentAiMessageForProject,
        getActiveProject,
        renderMainPlanPanel,
        ensureAskProjectActive,
        ensureAskFeedback,
        showPlanAskPopup,
        showExecAskPopup,
        askPopup,
        getAskPopupElements,
        getAskPopupHandlers
      })
      window.IpcExecSystemListeners.register()

      // 上下文压缩状态卡：在用户消息落库后、AI 真正开始执行前显示
      if (window.ContextCompressionStatus?.bind) {
        window.ContextCompressionStatus.bind({
          getContainer: () => document.getElementById('chatMessages'),
          getActiveProjectId: () => activeProjectId
        })
      }
      if (typeof window.ContextCompressionStatus?.onInFlightChange === 'function') {
        window.ContextCompressionStatus.onInFlightChange(value => {
          contextCompressionInFlight = !!value
          updateSendBtnState()
        })
      }

      // AI 流式监听器（已提取到 features/ipc-ai-stream-listeners.js）
      window.IpcAiStreamListeners.bind({
        getActiveProjectId: () => activeProjectId,
        getProjects: () => projects,
        getCurrentAiMsg: () => currentAiMsg,
        getCurrentThinkingBlock: () => currentThinkingBlock,
        setCurrentThinkingBlock: v => { currentThinkingBlock = v },
        getCurrentToolCount: () => currentToolCount,
        setCurrentToolCount: v => { currentToolCount = v },
        getCurrentOpCount: () => currentOpCount,
        setCurrentOpCount: v => { currentOpCount = v },
        getAiToolRenderer: () => aiToolRenderer,
        getAiMessageUI: () => aiMessageUI,
        getAiChangePill: () => aiChangePill,
        getWindowTabsFeature: () => windowTabsFeature,
        setProjectActivity,
        ensureCurrentAiMessageForProject,
        syncAiStateToProject,
        getProjectAiState,
        updateSendBtnState,
        startToolGroup,
        updateAiStats,
        refreshCurrentSummary,
        finalizeAiFailure,
        clearProjectAiRunState,
        finishThinkingBlock,
        finishStreamingOnInterrupt,
        updateWorkStatus,
        addThinking,
        appendAiContentChunk,
        appendAiFinalDelta,
        resetFinalStreamContent,
        renderCacheUsage,
        addIntermediateContent,
        isInternalUiOnlyTool,
        addOperation,
        getActiveProject
      })
      window.IpcAiStreamListeners.register()

      // 监听远程桥接用户消息（手机端发的消息在桌面端渲染）
      window.api.onRemoteUserMessage?.((data) => {
        if (data && data.projectId === activeProjectId) {
          addUserMessage(data.content || '', { fromRemote: true })
        }
      })

      window.HandoffConfirmationQueue?.bind({
        getActiveProjectId: () => activeProjectId,
        showToast
      })

      window.SkillDraftUI?.bind({
        getActiveProjectId: () => activeProjectId,
        getActiveProject,
        getProjectById: projectId => projects.find(p => p.id === projectId),
        reloadSkills: () => loadSkills(),
        showToast
      })

      window.AiOperationMemoUI?.bind({
        getActiveProjectId: () => activeProjectId,
        showToast
      })

      // onReply 监听器（已提取到 features/ipc-reply-listener.js）
      window.IpcReplyListener.bind({
        getActiveProjectId: () => activeProjectId,
        getProjects: () => projects,
        getCurrentAiMsg: () => currentAiMsg,
        setCurrentAiMsg: v => { currentAiMsg = v },
        getCurrentChangeSession: () => currentChangeSession,
        setCurrentChangeSession: v => { currentChangeSession = v },
        getCurrentThinkingBlock: () => currentThinkingBlock,
        setCurrentThinkingBlock: v => { currentThinkingBlock = v },
        setCurrentToolCount: v => { currentToolCount = v },
        setCurrentOpCount: v => { currentOpCount = v },
        setAutoFollowCurrentRun: v => { autoFollowCurrentRun = v },
        getChatMessages: () => chatMessages,
        getAiMessageUI: () => aiMessageUI,
        getAiChangePill: () => aiChangePill,
        getChatRenderer: () => chatRenderer,
        getOpIcons: () => opIcons,
        getActiveProject,
        setProjectActivity,
        getProjectAiState,
        clearProjectAiRunState,
        cleanupCollabReportsAfterSuccessfulReply,
        loadGitStatusForProject,
        updateSendBtnState,
        ensureCurrentAiMessageForProject,
        finalizeAiFailure,
        finishThinkingBlock,
        updateWorkStatus,
        addAiMessageToUI,
        finishAiStreaming,
        collapseDynamicArea,
        syncAiStateToProject,
        pollContextStatus: (...a) => pollContextStatus(...a)
      })
      window.IpcReplyListener.register()

      // 同项目多会话走侧栏「新开会话」

      // 定期更新上下文状态（已提取到 features/context-status-poller.js）
      window.ContextStatusPoller.bind({
        getActiveProject,
        getProjectModel,
        updateSidebarContext,
        addThinking
      })
      window.ContextCompressionStack?.bind?.({
        getActiveProject,
        getProjectModel
      })
      const { pollContextStatus } = window.ContextStatusPoller

      // 空闲时 12 秒轮询一次上下文状态，降低长会话后台 IPC 压力
      setInterval(pollContextStatus, 12000)

      // 点击项目选择器
      if (projectSelector) projectSelector.onclick = async () => {
        if (window.api) {
          const result = await window.api.selectProjectPath()
          if (!result.canceled && result.path) {
            AppLogger.debug('切换到:', result.path)
          }
        }
      }

      // ===== 授权模式选择器（已提取到 features/exec-mode-selector.js，与设置页 AI 授权同步）=====
      window.ExecModeSelector?.bind({
        execModeTrigger,
        execModeMenu,
        execModeIcon,
        execModeCurrent,
        contextPanel,
        getExecutionMode: () => executionMode,
        setExecutionMode: v => { executionMode = v },
        showToast
      })

      // 询问弹窗处理已提取到 features/ask-popup-handler.js

      // 初始加载
      // Project initialization is started after model config is loaded above.
    }

    window.SendInterruptQueue.bind({
      getActiveProject,
      getProjects: () => projects,
      getActiveProjectId: () => activeProjectId,
      getInputBox: () => inputBox,
      getQuotedArtifacts: () => quotedArtifacts,
      getCurrentAiMsg: () => currentAiMsg,
      setCurrentAiMsg: v => { currentAiMsg = v },
      setCurrentToolCount: v => { currentToolCount = v },
      setCurrentOpCount: v => { currentOpCount = v },
      setCurrentThinkingBlock: v => { currentThinkingBlock = v },
      setAutoFollowCurrentRun: v => { autoFollowCurrentRun = v },
      getProjectModelName,
      mapMessagesHistoryForProject,
      getTextInputUI: () => textInputUI,
      getAttachmentStore: () => attachmentStore,
      syncUploadedFiles,
      renderUploadedFiles,
      renderArtifactRefs,
      updateSendBtnState,
      setProjectActivity,
      clearAiRuntimeForProject,
      syncAiStateToProject,
      getAiAskPopup: () => aiAskPopup,
      getContextCompressionInFlight: () => contextCompressionInFlight,
      showToast,
      finishStreamingOnInterrupt,
      updateWorkStatus,
      sendMessage,
      getChatMessages: () => chatMessages,
      getChatRenderer: () => chatRenderer
    })
    const interruptAi = (...a) => window.SendInterruptQueue.interruptAi(...a)
    const sendOrInterruptWithLatestInput = (...a) => window.SendInterruptQueue.sendOrInterruptWithLatestInput(...a)
    const isActiveSessionTheRunningSession = (...a) => window.SendInterruptQueue.isActiveSessionTheRunningSession(...a)

    // ===== 更新按钮状态 =====
    // 5 态：
    //   空闲 + 输入空 → 发送（置灰）
    //   空闲 + 输入有字 → 发送
    //   当前会话执行中 + 输入空 → 中断（红）
    //   当前会话执行中 + 输入有字 → 发送（点击会进队列，不打断 AI）
    //   另一会话执行中 → 正常发送（会话隔离，不互相阻塞）
    function updateSendBtnState() {
      const project = getActiveProject()
      const running = !!(project && project.isRunning)
      const runningIsCurrentSession = running && isActiveSessionTheRunningSession()
      const hasText = hasInputContent()
      const stats = window.MessageQueue?.getStats?.() || { normal: 0, interject: 0 }
      const queueActive = stats.normal + stats.interject > 0

      // 移除所有态 class，根据当前状态重新挂
      sendBtn.classList.remove('active', 'is-interrupt', 'is-queue', 'is-empty')
      if (runningIsCurrentSession) {
        if (hasText) {
          // 当前会话执行中 + 有字 → 发送态（点击进队列）
          sendBtn.classList.add('is-queue')
          sendBtn.title = `点击进入排队队列（已有 ${stats.normal + stats.interject} 条在排）`
          sendBtn.setAttribute('aria-label', '排队发送')
        } else {
          // 当前会话执行中 + 空 → 中断态（红色，沿用现有 .active 类）
          sendBtn.classList.add('active', 'is-interrupt')
          sendBtn.title = contextCompressionInFlight
            ? '正在整理上下文'
            : ((window.i18n?.t?.('auto.js_app_4409_7') ?? ((window.i18n?.t?.('auto.js_app_4409_75') ?? '中断AI'))))
        }
      } else {
        // 空闲态，或另一会话在执行：正常发送按钮
        sendBtn.classList.add('is-empty')
        if (hasText) {
          sendBtn.title = ((window.i18n?.t?.('auto.js_app_4412_8') ?? ((window.i18n?.t?.('auto.js_app_4412_76') ?? '发送'))))
        } else {
          sendBtn.title = queueActive
            ? `发送（${stats.normal + stats.interject} 条队列消息等待）`
            : ((window.i18n?.t?.('auto.js_app_4412_8') ?? ((window.i18n?.t?.('auto.js_app_4412_76') ?? '发送'))))
        }
      }
      sendBtn.setAttribute('data-queue-count', String(stats.normal + stats.interject))
    }

    // 判断输入框是否有可发送内容（文字 / 附件 / 引用）
    function hasInputContent() {
      const text = String(inputBox?.value || '').trim()
      const filesCount = (attachmentStore?.getFiles?.() || []).length
      const refsCount = (quotedArtifacts?.length || 0)
      return !!text || filesCount > 0 || refsCount > 0
    }

    // 发送按钮点击
    sendBtn.onclick = () => {
      sendOrInterruptWithLatestInput()
    }

    // 工作台 @提及 功能（已提取到 features/workbench-mention.js）
    window.WorkbenchMention.bind({
      inputBox,
      inputWrapper,
      getTextInputUI: () => textInputUI,
      updateSendBtnState,
      getActiveProjectId: () => activeProjectId
    })
    const {
      buildMentionDirectivePrompt,
      stripMentionDirectives,
      getMentionDirectiveBadges,
      updateWorkbenchMentionHighlight,
      deleteWorkbenchMentionToken,
      hideWorkbenchMentionMenu,
      renderWorkbenchMentionMenu,
      insertWorkbenchMention,
      handleMentionKeyDown
    } = window.WorkbenchMention

    // 输入框防抖：mention 菜单和高亮层用 rAF 合并，避免每帧多次 innerHTML 重建
    let _inputRafId = 0
    let _sendBtnTimer = null
    function _debouncedSendBtn() {
      if (_sendBtnTimer) clearTimeout(_sendBtnTimer)
      _sendBtnTimer = setTimeout(() => { _sendBtnTimer = null; updateSendBtnState() }, 100)
    }
    inputBox.addEventListener('input', () => {
      // 中文输入法组合过程中跳过，避免卡顿导致拼音变字母
      if (inputBox.isComposing) return      _debouncedSendBtn()
      if (_inputRafId) cancelAnimationFrame(_inputRafId)
      _inputRafId = requestAnimationFrame(() => {
        _inputRafId = 0
        renderWorkbenchMentionMenu()
        updateWorkbenchMentionHighlight()
      })
    })
    inputBox.addEventListener('scroll', updateWorkbenchMentionHighlight)
    inputBox.addEventListener('blur', () => {
      setTimeout(hideWorkbenchMentionMenu, 120)
    })

    // 从其它应用切回窗口后的通用回焦兜底：
    // 主进程已把焦点还给 webContents，这里再延一拍判断，如果焦点没落在任何可编辑/表单/
    // webview 控件上（说明用户没有点向别的输入位置），就把聊天输入框回焦，
    // 复用「不清空内容、不打断输入法、只在非可编辑元素时回焦」的恢复策略。
    if (!window.__lingxiInputRefocusBound) {
      window.__lingxiInputRefocusBound = true
      const isFocusHolder = el => {
        if (!el || el === document.body) return false
        if (el.isContentEditable) return true
        const tag = el.tagName
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
          tag === 'BUTTON' || tag === 'WEBVIEW' || tag === 'IFRAME'
      }
      let refocusPending = false
      window.addEventListener('focus', () => {
        if (refocusPending) return
        refocusPending = true
        // 延到点击目标聚焦之后再判断，避免抢走用户点向的其它输入框/按钮
        setTimeout(() => {
          refocusPending = false
          try {
            if (document.hidden) return
            if (isFocusHolder(document.activeElement)) return
            const inputEl = document.getElementById('inputBox')
            if (!inputEl || inputEl === document.activeElement) return
            // 输入框被禁用/只读/隐藏时不强行聚焦
            if (inputEl.disabled || inputEl.readOnly || inputEl.offsetParent === null) return
            inputEl.focus({ preventScroll: true })
          } catch (_) {}
        }, 0)
      }, false)
    }

    // 回车发送，Shift+Enter换行
    inputBox.onkeydown = async e => {
      // 中文输入法组合过程中，只允许输入法处理按键，不触发发送等操作
      if (e.isComposing) return
      if (handleMentionKeyDown(e)) return
      if (e.key === 'Enter') {
        if (e.shiftKey) {
          // Shift+Enter: 换行，不做任何处理（默认行为）
          return
        } else {
          // 单独 Enter: 发送消息
          e.preventDefault()
          sendOrInterruptWithLatestInput()
        }
      }
    }

    attachmentStore?.bindUpload?.({
      api: window.api,
      uploadButton: fileUploadBtn,
      fileInput,
      pasteTarget: inputBox,
      dropTarget: inputWrapper,
      onInsertText: text => {
        const value = String(text || '')
        if (!value) return
        if (textInputUI?.insertText) textInputUI.insertText(value)
        else inputBox.value = `${inputBox.value || ''}${value}`
        inputBox.focus({ preventScroll: true })
        textInputUI?.autoResize?.()
      },
      onChange: () => {
        syncUploadedFiles()
        renderUploadedFiles()
      }
    })

    layoutUI.bindDividerDrag({ divider: divider1, webviewPanel, onResize: updateRightPanelWidthVar })

    function updateExpandButtonI18n() {
      if (!webviewPanelExpand) return
      if (webviewPanelExpand.classList.contains('is-expanded')) {
        webviewPanelExpand.title = (window.i18n?.t?.('auto.l262.title') ?? '恢复默认大小')
      } else {
        webviewPanelExpand.title = (window.i18n?.t?.('auto.l261.title') ?? '向左扩展（隐藏聊天区域）')
      }
    }

    // ===== i18n 启动：等翻译表加载完，应用到整个 DOM =====
    if (window.i18n && typeof window.i18n.init === 'function') {
      window.i18n.init().then(() => {
        if (typeof window.i18n.applyI18n === 'function') window.i18n.applyI18n();
        if (typeof updateExpandButtonI18n === 'function') updateExpandButtonI18n();
      }).catch(err => console.error('[i18n] init failed:', err));
    }
