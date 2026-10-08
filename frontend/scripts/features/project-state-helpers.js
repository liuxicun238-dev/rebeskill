(function () {
  function bind(options = {}) {
    const getProjectStore = options.getProjectStore || function () { return null }
    const getModelStore = options.getModelStore || function () { return null }
    const getProjects = options.getProjects || function () { return [] }
    const setProjects = options.setProjects || function () {}
    const getActiveProjectId = options.getActiveProjectId || function () { return null }
    const setActiveProjectId = options.setActiveProjectId || function () {}
    const getSavedModels = options.getSavedModels || function () { return [] }
    const getChatInputArea = options.getChatInputArea || function () { return null }
    const getInputBox = options.getInputBox || function () { return null }
    const getAttachmentStore = options.getAttachmentStore || function () { return null }
    const getChatMessages = options.getChatMessages || function () { return null }
    const getExecModeIcon = options.getExecModeIcon || function () { return null }
    const getExecModeCurrent = options.getExecModeCurrent || function () { return null }
    const getExecModeMenu = options.getExecModeMenu || function () { return null }
    const getGitPanelFeature = options.getGitPanelFeature || function () { return null }
    const getChatRenderer = options.getChatRenderer || function () { return null }
    const getExecutionMode = options.getExecutionMode || function () { return 'ask' }
    const setExecutionMode = options.setExecutionMode || function () {}
    const getNoProjectSendPrompt = options.getNoProjectSendPrompt || function () { return '' }
    const getQuotedArtifacts = options.getQuotedArtifacts || function () { return [] }
    const setQuotedArtifacts = options.setQuotedArtifacts || function () {}
    const setCurrentProjectPath = options.setCurrentProjectPath || function () {}
    const setCurrentStoragePath = options.setCurrentStoragePath || function () {}
    const setCurrentSkill = options.setCurrentSkill || function () {}
    const setCurrentAiMsg = options.setCurrentAiMsg || function () {}
    const setCurrentToolCount = options.setCurrentToolCount || function () {}
    const setCurrentOpCount = options.setCurrentOpCount || function () {}
    const renderProjectList = options.renderProjectList || function () {}
    const updateSkillButton = options.updateSkillButton || function () {}
    const updateProjectDisplay = options.updateProjectDisplay || function () {}
    const updateSidebarContext = options.updateSidebarContext || function () {}
    const updateSendBtnState = options.updateSendBtnState || function () {}
    const syncUploadedFiles = options.syncUploadedFiles || function () {}
    const renderUploadedFiles = options.renderUploadedFiles || function () {}
    const renderArtifactRefs = options.renderArtifactRefs || function () {}
    const syncChatBottomInset = options.syncChatBottomInset || function () {}
    const scrollToLatestAiMessage = options.scrollToLatestAiMessage || function () {}
    const switchProjectFn = options.switchProject || null
    const makeProjectFn = options.createProject || null
    const showToast = options.showToast || ((message, type = 'info') => window.showToast?.(message, type))
    let ensureStatelessChatPromise = null

    function syncProjectState() {
      const projectStore = getProjectStore()
      setProjects(projectStore?.getProjects() || [])
      setActiveProjectId(projectStore?.getActiveProjectId() || null)
    }

    function resolveActivitySessionId(project, options = {}) {
      const fromOpt = String(options?.sessionId || options?.chatSessionId || '').trim()
      if (fromOpt) return fromOpt
      const running = String(project?._runningSessionId || '').trim()
      if (running) return running
      const current = String(project?.chatSessionId || '').trim()
      if (current) return current
      const primary = Array.isArray(project?.chatSessions)
        ? (project.chatSessions.find(s => s?.isPrimary)?.sessionId
          || project.chatSessions.find(s => s?.sessionId === 'main')?.sessionId
          || project.chatSessions[0]?.sessionId
          || '')
        : ''
      return String(primary || 'main').trim() || 'main'
    }

    function ensureSessionActivityMap(project) {
      if (!project) return null
      if (!project.sessionActivityStatus || typeof project.sessionActivityStatus !== 'object') {
        project.sessionActivityStatus = {}
      }
      return project.sessionActivityStatus
    }

    function getSessionActivityStatus(project, sessionId) {
      if (!project) return ''
      const key = String(sessionId || '').trim()
      const map = project.sessionActivityStatus
      if (key && map && typeof map === 'object') {
        const status = map[key]
        if (['running', 'done', 'error'].includes(status)) return status
      }
      // 兼容旧的项目级状态：仅映射到当前/运行中会话，避免两会话同时亮同一指示
      const legacy = project.projectActivityStatus
      if (!['running', 'done', 'error'].includes(legacy)) return ''
      const runningId = String(project._runningSessionId || project.chatSessionId || '').trim()
      if (!key || !runningId || key === runningId) return legacy
      return ''
    }

    function setProjectActivity(projectOrId, status, options = {}) {
      const projects = getProjects()
      const project = typeof projectOrId === 'string'
        ? projects.find(p => p.id === projectOrId)
        : projectOrId
      if (!project) return
      const nextStatus = ['running', 'done', 'error'].includes(status) ? status : ''
      const sessionId = resolveActivitySessionId(project, options)
      const map = ensureSessionActivityMap(project)
      // 下线项目名右侧指示：清空旧字段，状态只挂在会话上
      if (project.projectActivityStatus) project.projectActivityStatus = ''

      if (nextStatus) {
        if (map[sessionId] === nextStatus) return
        map[sessionId] = nextStatus
      } else {
        if (!map[sessionId]) {
          // 若传入空状态且无 session 键，清掉全部非 running 遗留
          if (!String(options?.sessionId || options?.chatSessionId || '').trim() && !project._runningSessionId) {
            let changed = false
            for (const key of Object.keys(map)) {
              if (map[key] === 'done' || map[key] === 'error') {
                delete map[key]
                changed = true
              }
            }
            if (!changed) return
            renderProjectList()
            return
          }
          return
        }
        delete map[sessionId]
      }
      renderProjectList()
    }

    function clearViewedProjectActivity(project, options = {}) {
      if (!project) return
      const map = project.sessionActivityStatus
      const sessionId = String(options?.sessionId || project.chatSessionId || '').trim()

      if (map && typeof map === 'object') {
        if (sessionId) {
          const status = map[sessionId]
          if (status === 'done' || status === 'error') {
            setProjectActivity(project, '', { sessionId })
          }
          return
        }
        let changed = false
        for (const key of Object.keys(map)) {
          if (map[key] === 'done' || map[key] === 'error') {
            delete map[key]
            changed = true
          }
        }
        if (changed) renderProjectList()
        return
      }

      // 兼容旧项目级字段
      if (project.projectActivityStatus === 'done' || project.projectActivityStatus === 'error') {
        project.projectActivityStatus = ''
        renderProjectList()
      }
    }

    function setProjectModel(project, index) {
      if (!project) return null
      const modelStore = getModelStore()
      const savedModels = getSavedModels()
      const model = modelStore?.getModelAt?.(index) || null
      project.modelIndex = model ? savedModels.indexOf(model) : -1
      project.modelKey = model ? modelStore.getModelKey(model) : null
      return model
    }

    function resolveProjectModelIndex(project) {
      if (!project) return -1
      const modelStore = getModelStore()
      const index = modelStore?.resolveModelIndex?.({
        modelKey: project.modelKey,
        modelIndex: project.modelIndex
      }) ?? -1
      if (index !== project.modelIndex) {
        setProjectModel(project, index)
      } else if (index >= 0 && !project.modelKey) {
        setProjectModel(project, index)
      }
      return index
    }

    function getProjectModel(project) {
      const index = resolveProjectModelIndex(project)
      const savedModels = getSavedModels()
      return index >= 0 ? savedModels[index] || null : null
    }

    function getProjectModelName(project) {
      return getProjectModel(project)?.modelName || null
    }

    function syncAllProjectModelRefs() {
      const projects = getProjects()
      projects.forEach(project => resolveProjectModelIndex(project))
    }

    function ensureActiveProject(preferredPath = '') {
      const projectStore = getProjectStore()
      const project = projectStore?.ensureActiveProject?.(preferredPath) || null
      syncProjectState()
      return project
    }

    function hasVisibleProjects() {
      syncProjectState()
      const projects = getProjects()
      return projects.some(project => !project.archived && !project.stateless)
    }

    let noProjectScene = null
    let noProjectSceneHost = null

    function destroyNoProjectScene() {
      try { noProjectSceneHost?._noProjectCleanup?.() } catch {}
      try { noProjectScene?.destroy?.() } catch {}
      if (noProjectSceneHost) {
        try { delete noProjectSceneHost._noProjectCleanup } catch {}
      }
      noProjectScene = null
      noProjectSceneHost = null
    }

    async function mountWelcomeLogoMark(root) {
      destroyNoProjectScene()
      const host = root?.querySelector?.('.welcome-mark')
      if (!host) return

      if (window.NoProjectLogoScene?.mount) {
        try {
          const scene = await window.NoProjectLogoScene.mount(host)
          noProjectScene = scene
          noProjectSceneHost = host
          host.dataset.sceneState = 'idle'
          const onMove = (event) => {
            const rect = host.getBoundingClientRect()
            if (!rect.width || !rect.height) return
            const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
            const y = 1 - ((event.clientY - rect.top) / rect.height) * 2
            scene?.setPointer?.({ strength: 1, x, y })
          }
          const onLeave = () => scene?.setPointer?.({ strength: 0 })
          const onEnter = () => scene?.setActive?.(true)
          const onBlur = () => scene?.setActive?.(false)
          host.addEventListener('pointermove', onMove)
          host.addEventListener('pointerleave', onLeave)
          host.addEventListener('pointerenter', onEnter)
          host.addEventListener('pointerdown', onEnter)
          host.addEventListener('pointerup', onBlur)
          host._noProjectCleanup = () => {
            host.removeEventListener('pointermove', onMove)
            host.removeEventListener('pointerleave', onLeave)
            host.removeEventListener('pointerenter', onEnter)
            host.removeEventListener('pointerdown', onEnter)
            host.removeEventListener('pointerup', onBlur)
          }
          return
        } catch (error) {
          console.warn('[Welcome] logo scene mount failed:', error)
        }
      }

      host.classList.add('is-fallback')
      host.innerHTML = '<img class="welcome-logo-image no-project-logo-fallback" src="assets/brand/lingxi-logo-transparent.png" alt="">'
      noProjectSceneHost = host
    }

    const WELCOME_COMPOSER_PLACEHOLDER = '描述你想要构建的内容'

    function restoreWelcomeComposerInput() {
      const area = getChatInputArea()
      if (!area || !area.closest('.welcome-composer-slot')) return
      const center = document.querySelector('.center')
      const anchor = document.getElementById('scrollToBottomBtn')
      if (anchor && center && anchor.parentNode === center) {
        center.insertBefore(area, anchor.nextSibling)
      } else if (center) {
        center.appendChild(area)
      }
      area.classList.remove('is-welcome-composer')
      const inputBox = getInputBox()
      if (inputBox?.dataset.defaultPlaceholder != null) {
        inputBox.setAttribute('placeholder', inputBox.dataset.defaultPlaceholder)
      }
    }

    function applyWelcomeComposerPlaceholder() {
      const inputBox = getInputBox()
      if (!inputBox) return
      if (inputBox.dataset.defaultPlaceholder == null) {
        inputBox.dataset.defaultPlaceholder = inputBox.getAttribute('placeholder') || ''
      }
      inputBox.setAttribute('placeholder', WELCOME_COMPOSER_PLACEHOLDER)
    }

    function attachWelcomeComposerInput(root) {
      const slot = root?.querySelector?.('.welcome-composer-slot')
      const area = getChatInputArea()
      if (!slot || !area) return
      restoreWelcomeComposerInput()
      slot.appendChild(area)
      area.classList.add('is-welcome-composer')
      area.classList.remove('hidden-no-project')
      applyWelcomeComposerPlaceholder()
      requestAnimationFrame(() => {
        try { getInputBox()?.focus() } catch (_) {}
      })
    }

    function closeWelcomeMenus(root) {
      if (!root) return
      root.querySelectorAll('.welcome-menu').forEach((menu) => { menu.hidden = true })
      root.querySelectorAll('[data-welcome-menu]').forEach((btn) => {
        btn.setAttribute('aria-expanded', 'false')
      })
    }

    function unbindWelcomeMenuDoc(root) {
      if (!root) return
      if (root._welcomeMenuOnDoc) {
        try { document.removeEventListener('pointerdown', root._welcomeMenuOnDoc, true) } catch (_) {}
        try { document.removeEventListener('click', root._welcomeMenuOnDoc, true) } catch (_) {}
        root._welcomeMenuOnDoc = null
      }
      if (root._welcomeMenuOnKey) {
        try { document.removeEventListener('keydown', root._welcomeMenuOnKey, true) } catch (_) {}
        root._welcomeMenuOnKey = null
      }
    }

    const composerExec = {
      active: false,
      snapshot: 'ask',
      userChanged: false,
      originProjectId: null,
      createdProjectId: null
    }
    let welcomeProjectMode = 'standard'

    function normalizeProjectMode(mode) {
      return mode === 'research' ? 'research' : 'standard'
    }

    function getWelcomeProjectMode(options = {}) {
      if (options.keepProject === true) {
        return normalizeProjectMode(getActiveProject()?.projectMode)
      }
      return normalizeProjectMode(welcomeProjectMode)
    }

    function projectModeLabel(mode) {
      return normalizeProjectMode(mode) === 'research' ? '研究模式' : '标准模式'
    }

    function projectHasConversation(project) {
      const hist = Array.isArray(project?.messagesHistory) && project.messagesHistory.length
        ? project.messagesHistory
        : (Array.isArray(project?.history) ? project.history : [])
      return hist.some((msg) => {
        if (!msg || msg.hidden) return false
        return msg.role === 'user' || msg.role === 'assistant' || msg.role === 'ai'
      })
    }

    function composerHasSelectedProject() {
      const project = getActiveProject()
      return !!(project?.id && project.path && !project.stateless)
    }

    async function persistAndApplyExecMode(mode, projectId) {
      const value = ['ask', 'smart', 'full'].includes(mode) ? mode : 'ask'
      const id = String(projectId || getActiveProject()?.id || '').trim()
      setExecutionMode(value)
      if (typeof window.ExecModeSelector?.applyUi === 'function') {
        window.ExecModeSelector.applyUi(value)
      } else {
        updateExecModeUI(value)
      }
      if (!id) return
      try {
        if (typeof window.ExecModeSelector?.persistMode === 'function') {
          await window.ExecModeSelector.persistMode(value, id)
        } else {
          await window.api?.setPathPermissionMode?.(value, id)
        }
      } catch (_) {}
      const project = getProjects().find(item => item?.id === id) || (getActiveProject()?.id === id ? getActiveProject() : null)
      if (project) project.execMode = value
    }

    async function applyProjectExecMode(projectId, fallback = 'ask') {
      const id = String(projectId || '').trim()
      if (!id) {
        const value = ['ask', 'smart', 'full'].includes(fallback) ? fallback : 'ask'
        setExecutionMode(value)
        window.ExecModeSelector?.applyUi?.(value)
        return value
      }
      let mode = fallback
      try {
        const loaded = typeof window.ExecModeSelector?.loadMode === 'function'
          ? await window.ExecModeSelector.loadMode(id)
          : await window.api?.getPathPermissions?.(id)
        if (['ask', 'smart', 'full'].includes(loaded?.mode)) mode = loaded.mode
      } catch (_) {}
      setExecutionMode(mode)
      if (typeof window.ExecModeSelector?.applyUi === 'function') {
        window.ExecModeSelector.applyUi(mode)
      } else {
        updateExecModeUI(mode)
      }
      const project = getProjects().find(item => item?.id === id) || (getActiveProject()?.id === id ? getActiveProject() : null)
      if (project) project.execMode = mode
      return mode
    }

    async function enterComposerExec() {
      if (!composerExec.active) {
        composerExec.snapshot = getExecutionMode() || 'ask'
        composerExec.userChanged = false
        composerExec.originProjectId = noProjectReturnContext?.projectId || getActiveProject()?.id || null
        composerExec.createdProjectId = null
        composerExec.active = true
      }
      if (composerExec.userChanged) {
        const current = getExecutionMode() || 'ask'
        window.ExecModeSelector?.applyUi?.(current)
        return
      }
      setExecutionMode('ask')
      window.ExecModeSelector?.applyUi?.('ask')
      const currentId = getActiveProject()?.id
      if (currentId && currentId === composerExec.createdProjectId) {
        await persistAndApplyExecMode('ask', currentId)
      }
    }

    async function leaveComposerExec(options = {}) {
      if (!composerExec.active) return
      const current = getActiveProject()
      const destId = String(options.nextProjectId || current?.id || '').trim()
      const goingToOrigin = !!(destId && composerExec.originProjectId && destId === composerExec.originProjectId)
      const hasConversation = options.hasConversation === true
      const keepAsk = !goingToOrigin && (
        composerExec.userChanged
        || (!hasConversation && (
          (destId && destId === composerExec.createdProjectId)
          || current?.stateless === true
        ))
      )
      composerExec.active = false
      document.body.classList.remove('welcome-composer-mode')
      document.body.classList.remove('welcome-composer-has-project')
      if (keepAsk && destId) {
        const mode = composerExec.userChanged ? (getExecutionMode() || 'ask') : 'ask'
        await persistAndApplyExecMode(mode, destId)
        return
      }
      if (destId) await applyProjectExecMode(destId, composerExec.snapshot || 'ask')
    }

    function bindWelcomeReturnButton() {
      const btn = document.getElementById('chatWelcomeReturnBtn')
      if (!btn || btn.dataset.bound === '1') return
      btn.dataset.bound = '1'
      btn.addEventListener('click', (event) => {
        event.preventDefault()
        void returnFromNoProject()
      })
    }

    function isStatelessChrome() {
      const project = getActiveProject()
      return document.body.classList.contains('welcome-composer-mode')
        || document.body.classList.contains('no-project-mode')
        || !!project?.stateless
    }

    function syncWelcomeReturnButton() {
      const btn = document.getElementById('chatWelcomeReturnBtn')
      if (!btn) return
      bindWelcomeReturnButton()
      const show = isStatelessChrome() && !!noProjectReturnContext
      btn.hidden = !show
    }

    function syncWelcomeComposerChrome() {
      const on = document.body.classList.contains('welcome-composer-mode')
      document.body.classList.toggle('welcome-composer-has-project', on && composerHasSelectedProject())
      bindWelcomeReturnButton()
      syncWelcomeReturnButton()
      try { window.ChatToolbarContext?.refresh?.() } catch (_) {}
      try { window.ContextCompressionStack?.remount?.() } catch (_) {}
    }

    window.WelcomeComposerExec = {
      getProjectMode() {
        return getActiveProject()?.id ? null : normalizeProjectMode(welcomeProjectMode)
      },
      markUserChanged() { composerExec.userChanged = true },
      shouldHoldAsk() {
        return !!(composerExec.active && !composerExec.userChanged)
      },
      captureReturnContext(options) {
        captureNoProjectReturnContext(options || {})
      },
      syncReturnButton() {
        syncWelcomeReturnButton()
      },
      noteCreatedProject(id) {
        const next = String(id || '').trim()
        if (next) composerExec.createdProjectId = next
        syncWelcomeComposerChrome()
      },
      async prepareForProjectSwitch(nextProjectId) {
        const nextId = String(nextProjectId || '').trim()
        restoreWelcomeComposerInput()
        if (!composerExec.active) return
        if (nextId && composerExec.originProjectId && nextId === composerExec.originProjectId) {
          await leaveComposerExec({ nextProjectId: nextId })
          restoreWelcomeComposerInput()
          syncWelcomeComposerChrome()
          return
        }
        document.body.classList.remove('welcome-composer-mode')
        document.body.classList.remove('welcome-composer-has-project')
        syncWelcomeReturnButton()
      },
      async afterProjectReady(project) {
        if (!composerExec.active) return
        const id = String(project?.id || '').trim()
        if (id && !composerExec.createdProjectId) composerExec.createdProjectId = id
        if (!projectHasConversation(project)) {
          const mode = composerExec.userChanged ? (getExecutionMode() || 'ask') : 'ask'
          await persistAndApplyExecMode(mode, id)
          return
        }
        await leaveComposerExec({ nextProjectId: id, hasConversation: true })
        restoreWelcomeComposerInput()
        syncWelcomeComposerChrome()
      }
    }

    function setWelcomeComposerMode(enabled) {
      document.body.classList.toggle('welcome-composer-mode', !!enabled)
      if (enabled) {
        void enterComposerExec().then(() => syncWelcomeComposerChrome())
      } else {
        restoreWelcomeComposerInput()
        void leaveComposerExec().then(() => syncWelcomeComposerChrome())
      }
      syncWelcomeComposerChrome()
    }

    function setChatInputVisible(visible) {
      const chatInputArea = getChatInputArea()
      if (!chatInputArea) return
      // 无项目态也保留输入框，支持直接发送。
      chatInputArea.classList.remove('hidden-no-project')
      document.body.classList.toggle('no-project-mode', !visible)
      if (visible) {
        const hasComposer = !!getChatMessages()?.querySelector?.('.welcome-composer-slot')
        if (!hasComposer) {
          destroyNoProjectScene()
          setWelcomeComposerMode(false)
        }
      }
      syncChatBottomInset()
    }

    function triggerNoProjectCreate() {
      if (typeof window.ProjectActions?.createProjectDirectory === 'function') {
        window.ProjectActions.createProjectDirectory()
        return
      }
      showToast?.('当前版本不支持新建项目目录', 'error')
    }

    function triggerNoProjectOpen() {
      if (typeof window.TitlebarActions?.openProjectFromMenu === 'function') {
        window.TitlebarActions.openProjectFromMenu()
        return
      }
      const openItem = document.querySelector('[data-menu-action="file:open-project"]')
      if (openItem) {
        openItem.click()
        return
      }
      showToast?.('当前版本不支持打开已有项目', 'error')
    }

    let noProjectReturnContext = null

    function captureNoProjectReturnContext(options = {}) {
      const leaving = getActiveProject()
      if (!leaving?.id || leaving.archived) return
      if (options.skipStateless && leaving.stateless) return
      const chatMessages = getChatMessages()
      let chatPlace = null
      try {
        chatPlace = window.ChatStickyBottom?.capturePlace?.(chatMessages) || {
          top: chatMessages?.scrollTop || 0,
          height: chatMessages?.scrollHeight || 0,
          escaped: window.ChatStickyBottom?.isEscaped?.(chatMessages) || false
        }
      } catch (_) {
        chatPlace = {
          top: chatMessages?.scrollTop || 0,
          height: chatMessages?.scrollHeight || 0,
          escaped: false
        }
      }
      noProjectReturnContext = {
        projectId: leaving.id,
        sessionId: String(leaving.chatSessionId || ''),
        chatPlace
      }
    }

    async function returnFromNoProject() {
      const ctx = noProjectReturnContext
      if (!ctx?.projectId) return
      noProjectReturnContext = null
      const switcher = switchProjectFn
      if (typeof switcher !== 'function') {
        showToast?.('无法返回刚才的项目', 'error')
        return
      }
      window.ProjectSwitcher?.setPendingChatPlace?.(ctx.chatPlace)
      try {
        await switcher(ctx.projectId)
      } catch (error) {
        showToast?.(error?.message || '返回项目失败', 'error')
      }
    }

    function bindNoProjectEmptyState(root) {
      if (!root) return
      unbindWelcomeMenuDoc(root)
      root.querySelectorAll('[data-no-project-action="create"]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault()
          closeWelcomeMenus(root)
          triggerNoProjectCreate()
        })
      })
      root.querySelectorAll('[data-no-project-action="open"]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault()
          closeWelcomeMenus(root)
          triggerNoProjectOpen()
        })
      })
      root.querySelectorAll('[data-no-project-action="return"]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault()
          void returnFromNoProject()
        })
      })
      root.querySelectorAll('[data-welcome-codex-import]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          closeWelcomeMenus(root)
          window.CodexImportUi?.open?.()
        })
      })
      root.querySelectorAll('[data-welcome-cursor-import]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          closeWelcomeMenus(root)
          window.CursorImportUi?.open?.()
        })
      })
      root.querySelectorAll('[data-welcome-menu]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const key = btn.getAttribute('data-welcome-menu')
          const menu = root.querySelector(`[data-welcome-panel="${key}"]`)
          const willOpen = !!(menu && menu.hidden)
          closeWelcomeMenus(root)
          if (menu && willOpen) {
            menu.hidden = false
            btn.setAttribute('aria-expanded', 'true')
          }
        })
      })
      root.querySelectorAll('[data-welcome-project-mode]').forEach((btn) => {
        btn.addEventListener('click', async (event) => {
          event.preventDefault()
          event.stopPropagation()
          const activeProject = getActiveProject()
          if (activeProject?.projectModeLocked === true) {
            closeWelcomeMenus(root)
            showToast?.('该项目已发送过消息，项目模式不能更换', 'warning')
            return
          }
          const mode = normalizeProjectMode(btn.getAttribute('data-welcome-project-mode'))
          welcomeProjectMode = mode
          if (activeProject?.id) {
            activeProject.projectMode = mode
            await saveProjectsList(activeProject.path || '')
            try { window.ChatToolbarContext?.refresh?.() } catch (_) {}
          }
          root.querySelector('[data-welcome-project-mode-label]')?.replaceChildren(document.createTextNode(projectModeLabel(mode)))
          root.querySelectorAll('[data-welcome-project-mode]').forEach((item) => {
            item.classList.toggle('is-active', item.getAttribute('data-welcome-project-mode') === mode)
          })
          closeWelcomeMenus(root)
          showToast?.('已选择' + projectModeLabel(mode), 'success')
        })
      })
      const isInsideOpenWelcomeSelect = (event) => {
        const select = event.target?.closest?.('.welcome-select')
        if (!select || !root.contains(select)) return false
        const menu = select.querySelector('.welcome-menu')
        return !!(menu && menu.hidden === false)
      }
      const onDoc = (event) => {
        if (!root.isConnected) {
          unbindWelcomeMenuDoc(root)
          return
        }
        if (isInsideOpenWelcomeSelect(event)) return
        closeWelcomeMenus(root)
      }
      const onKey = (event) => {
        if (event.key === 'Escape') closeWelcomeMenus(root)
      }
      document.addEventListener('pointerdown', onDoc, true)
      document.addEventListener('click', onDoc, true)
      document.addEventListener('keydown', onKey, true)
      root._welcomeMenuOnDoc = onDoc
      root._welcomeMenuOnKey = onKey
    }

    function welcomeFolderLabel(options = {}) {
      if (options.keepProject === true) {
        const project = getActiveProject()
        const name = String(project?.name || '').trim()
        if (name) return name
        const pathName = pathBasename(project?.path || '')
        if (pathName) return pathName
      }
      return '选择工作目录'
    }

    function escapeWelcomeText(value = '') {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    function buildNoProjectWelcomeHtml(options = {}) {
      const folderLabel = escapeWelcomeText(welcomeFolderLabel(options))
      const projectMode = getWelcomeProjectMode(options)
      const modeLabel = projectModeLabel(projectMode)
      const modeLocked = getActiveProject()?.projectModeLocked === true
      const modeLockedAttr = modeLocked ? ' disabled aria-disabled="true"' : ''
      return `
        <div class="no-project-empty-state welcome-empty-state welcome-composer-state" aria-live="polite">
          <div class="welcome-stage">
            <div class="welcome-hero">
              <div class="welcome-title-row">
                <div class="welcome-title">
                  <span class="welcome-title-lead">
                    <span class="welcome-mark" aria-hidden="true" data-scene-state="idle"></span>
                    <span class="welcome-title-brand">灵犀</span>
                  </span>
                  <span class="welcome-title-rest">一点，做你所想</span>
                </div>
              </div>
            </div>
            <div class="welcome-composer-block">
              <div class="welcome-selectors">
                <div class="welcome-select">
                  <button type="button" class="welcome-select-btn" data-welcome-menu="folder" aria-expanded="false" aria-haspopup="true">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5h6.6l1.8 2h8.6"/><path d="M3.5 7.5h17v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z"/></svg>
                    <span class="welcome-select-label" data-welcome-folder-label>${folderLabel}</span>
                    <svg class="welcome-select-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div class="welcome-menu" data-welcome-panel="folder" hidden>
                    <button type="button" class="welcome-menu-item" data-no-project-action="create">新建项目目录</button>
                    <button type="button" class="welcome-menu-item" data-no-project-action="open">打开已有目录</button>
                  </div>
                </div>
                <div class="welcome-select">
                  <button type="button" class="welcome-select-btn" data-welcome-menu="mode" aria-expanded="false" aria-haspopup="true">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="12" r="2.2"/><circle cx="12" cy="6.5" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M8 11.2 10.4 7.8"/><path d="M14 7.8 16.4 11.2"/></svg>
                    <span class="welcome-select-label" data-welcome-project-mode-label>${modeLabel}</span>
                    <svg class="welcome-select-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div class="welcome-menu welcome-mode-menu" data-welcome-panel="mode" hidden>
                    <button type="button" class="welcome-menu-item welcome-mode-option${projectMode === 'standard' ? ' is-active' : ''}" data-welcome-project-mode="standard"${modeLockedAttr}>
                      <span class="welcome-mode-option-copy">
                        <span class="welcome-mode-option-name">标准模式</span>
                        <span class="welcome-mode-option-desc">按常规项目流程使用工具、授权与上下文执行任务。</span>
                      </span>
                      <svg class="welcome-mode-option-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                    <button type="button" class="welcome-menu-item welcome-mode-option${projectMode === 'research' ? ' is-active' : ''}" data-welcome-project-mode="research"${modeLockedAttr}>
                      <span class="welcome-mode-option-copy">
                        <span class="welcome-mode-option-name">研究模式</span>
                        <span class="welcome-mode-option-desc">动态形成项目级严格约束；每轮执行前核对，冲突即拒绝，文件发生改动时可启用独立 Agent 审查。</span>
                      </span>
                      <svg class="welcome-mode-option-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                  </div>
                </div>
              </div>
              <div class="welcome-composer-slot"></div>
              <div class="welcome-import-stack">
                <button type="button" class="welcome-codex-import" data-welcome-codex-import>
                  <span class="welcome-codex-import-icons" aria-hidden="true">
                    <span class="welcome-codex-import-mark is-codex">
                      <img src="assets/model-icons/lobe/codex-color.svg" alt="">
                    </span>
                    <span class="welcome-codex-import-dots"><i></i><i></i><i></i></span>
                    <span class="welcome-codex-import-mark is-lingxi">
                      <img src="assets/brand/lingxi-logo-transparent.png" alt="">
                    </span>
                  </span>
                  <span class="welcome-codex-import-copy">
                    <span class="welcome-codex-import-title">导入你的 Codex 会话</span>
                    <span class="welcome-codex-import-desc">把聊天记录接到灵犀里继续</span>
                  </span>
                </button>
                <button type="button" class="welcome-codex-import" data-welcome-cursor-import>
                  <span class="welcome-codex-import-icons" aria-hidden="true">
                    <span class="welcome-codex-import-mark is-cursor">
                      <img src="assets/model-icons/lobe/cursor.svg" alt="">
                    </span>
                    <span class="welcome-codex-import-dots"><i></i><i></i><i></i></span>
                    <span class="welcome-codex-import-mark is-lingxi">
                      <img src="assets/brand/lingxi-logo-transparent.png" alt="">
                    </span>
                  </span>
                  <span class="welcome-codex-import-copy">
                    <span class="welcome-codex-import-title">导入你的 Cursor 会话</span>
                    <span class="welcome-codex-import-desc">把聊天记录接到灵犀里继续</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      `
    }

    function hasWelcomeEmptyState(root = null) {
      const chatMessages = root || getChatMessages()
      if (!chatMessages) return false
      return !!chatMessages.querySelector?.('.welcome-empty-state, .no-project-empty-state')
    }

    /**
     * 首条真实消息出现前清除欢迎页 DOM。
     * 新建/打开空项目时 keepProject 欢迎页会挂在 #chatMessages 内；
     * 若只 append 用户/AI 消息而不移除，欢迎页会一直残留（切换项目再回来才会被历史渲染覆盖）。
     */
    function clearWelcomeEmptyState(options = {}) {
      restoreWelcomeComposerInput()
      setWelcomeComposerMode(false)
      const chatMessages = options.root || getChatMessages()
      if (!chatMessages) return false
      const nodes = chatMessages.querySelectorAll?.('.welcome-empty-state, .no-project-empty-state')
      if (!nodes || nodes.length === 0) return false
      nodes.forEach((node) => unbindWelcomeMenuDoc(node))
      destroyNoProjectScene()
      nodes.forEach((node) => {
        try { node.remove() } catch (_) {
          try { node.parentNode?.removeChild(node) } catch (_) { /* ignore */ }
        }
      })
      // 有真实项目时不要保留 no-project-mode；无项目会话仍由后续逻辑设置。
      if (options.keepNoProjectMode !== true) {
        const active = getActiveProject?.() || null
        if (active?.id && !active.stateless) {
          document.body.classList.remove('no-project-mode')
        }
      }
      syncChatBottomInset()
      return true
    }

    function renderWelcomeEmptyState(options = {}) {
      const chatMessages = getChatMessages()
      if (!chatMessages) return
      restoreWelcomeComposerInput()
      destroyNoProjectScene()
      // 先替换内容为欢迎页，再关闭面板+显示 chatMessages
      // 避免 returnToChatArea 先显示 chatMessages 时闪现旧聊天记录
      chatMessages.innerHTML = buildNoProjectWelcomeHtml({
        showReturn: options.keepProject !== true && !!noProjectReturnContext,
        keepProject: options.keepProject === true
      })
      // 渲染欢迎页前确保聊天区可见，避免停在设置/资源中心等外部面板
      try { window.ProjectSwitcher?.returnToChatArea?.() } catch (_) {}
      try { window.returnToChatArea?.() } catch (_) {}
      chatMessages.style.display = 'block'
      const root = chatMessages.querySelector('.no-project-empty-state')
      bindNoProjectEmptyState(root)
      void mountWelcomeLogoMark(root)
      attachWelcomeComposerInput(root)
      if (options.keepProject === true) {
        window.WelcomeComposerExec?.noteCreatedProject?.(getActiveProject()?.id)
      }
      setWelcomeComposerMode(true)
      if (options.keepProject !== true) {
        document.body.classList.add('no-project-mode')
      } else {
        document.body.classList.remove('no-project-mode')
      }
      syncChatBottomInset()
      updateSendBtnState()
    }

    async function enterNoProjectState(options = {}) {
      captureNoProjectReturnContext()
      welcomeProjectMode = 'standard'
      // 只关闭各面板，不在此处显示 chatMessages（避免旧聊天记录闪现）
      // chatMessages 的显示由 renderWelcomeEmptyState 统一处理（先替换内容再显示）
      try { window.closeCanvasView?.() } catch (_) {}
      try { window.LingxiPanelManager?.closeMany?.(['archive','integration','localApps','settings','git','gitHistory','gitBranch']) } catch (_) {}

      // 销毁聊天视图（虚拟滚动器 + 分页加载器），避免 pending 的 requestAnimationFrame
      // 回调在欢迎页渲染后把历史聊天记录恢复到 chatMessages，覆盖欢迎页
      restoreWelcomeComposerInput()
      const chatMessagesForCleanup = getChatMessages()
      if (chatMessagesForCleanup) {
        try { window.ChatSessionCleanup?.destroyChatViews?.(chatMessagesForCleanup) } catch (_) {}
        try {
          delete chatMessagesForCleanup.dataset.projectId
          delete chatMessagesForCleanup.dataset.chatSessionId
        } catch (_) { /* ignore */ }
      }

      const projectStore = getProjectStore()
      projectStore?.setActiveProjectId?.(null)
      syncProjectState()
      setCurrentProjectPath('')
      setCurrentStoragePath('')
      setCurrentSkill(null)
      setCurrentAiMsg(null)
      setCurrentToolCount(0)
      setCurrentOpCount(0)
      localStorage.removeItem('lastProjectPath')
      if (window.ContextCompressionStatus?.clearForProjectSwitch) {
        window.ContextCompressionStatus.clearForProjectSwitch()
      }
      if (window.ContextCompressionStack?.clearForProjectSwitch) {
        window.ContextCompressionStack.clearForProjectSwitch()
      }
      renderWelcomeEmptyState({ keepProject: false })
      // 无项目也显示输入框，允许直接发送。
      setChatInputVisible(false)
      if (options.save !== false) await saveProjectsList('')
      renderProjectList()
      updateSkillButton()
      updateProjectDisplay()
      updateSidebarContext(0, 0)
      updateSendBtnState()
    }

    async function ensureStatelessChatProject() {
      const existing = getActiveProject()
      if (existing?.id) return existing

      if (ensureStatelessChatPromise) return ensureStatelessChatPromise

      ensureStatelessChatPromise = (async () => {
        if (!window.api?.createStatelessChatProject) {
          throw new Error('当前客户端不支持无项目聊天，请重启应用后再试')
        }

        const createResult = await window.api.createStatelessChatProject({ projectMode: normalizeProjectMode(welcomeProjectMode) })
        if (!createResult?.success || !createResult.projectId) {
          throw new Error(createResult?.error || '创建无项目会话失败')
        }

        const projects = getProjects()
        const existingProject = projects.find(p => p.id === createResult.projectId)
        let project = existingProject
        if (!project) {
          const maker = makeProjectFn || createProject
          project = maker('', {
            id: createResult.projectId,
            name: '无项目会话',
            storagePath: createResult.storagePath || '',
            projectMode: createResult.projectMode || normalizeProjectMode(welcomeProjectMode),
            projectModeLocked: createResult.projectModeLocked === true,
            stateless: true,
            workspaceOrigin: 'none',
            skipSave: true
          })
        }

        if (!project?.id) throw new Error('无项目会话绑定失败')

        window.WelcomeComposerExec?.noteCreatedProject?.(project.id)
        setActiveProject(project.id)
        setCurrentProjectPath('')
        setCurrentStoragePath(createResult.storagePath || '')
        restoreWelcomeComposerInput()
        setWelcomeComposerMode(false)
        const chatMessages = getChatMessages()
        if (chatMessages) chatMessages.innerHTML = ''
        document.body.classList.add('no-project-mode')
        renderProjectList()
        updateProjectDisplay()
        updateSendBtnState()
        syncChatBottomInset()
        return getActiveProject() || project
      })()

      try {
        return await ensureStatelessChatPromise
      } finally {
        ensureStatelessChatPromise = null
      }
    }

    function pathBasename(fullPath = '') {
      const text = String(fullPath || '')
      const parts = text.split(/[\\/]/).filter(Boolean)
      return parts[parts.length - 1] || text
    }

    async function showNoProjectSendPrompt() {
      try {
        await ensureStatelessChatProject()
        return true
      } catch (error) {
        showToast?.(error?.message || getNoProjectSendPrompt() || '无项目会话创建失败', 'error')
        return false
      }
    }

    function setActiveProject(projectId) {
      const projectStore = getProjectStore()
      projectStore.setActiveProjectId(projectId)
      syncProjectState()
      return getActiveProject()
    }

    // 生成项目ID（路径哈希）
    function generateProjectId(path) {
      const projectStore = getProjectStore()
      return projectStore.generateProjectId(path)
    }

    // 创建新项目
    function createProject(path, options = {}) {
      const projectStore = getProjectStore()
      const modelStore = getModelStore()
      const savedModels = getSavedModels()
      const lingxiDefaultIndex = savedModels.findIndex(model => {
        const key = modelStore?.getModelKey?.(model) || ''
        return key === 'lingxi-default' || model?.modelId === 'lingxi-default'
      })
      const currentModelIndex = modelStore?.getCurrentIndex?.() ?? -1
      const defaultModelIndex = lingxiDefaultIndex >= 0
        ? lingxiDefaultIndex
        : (currentModelIndex >= 0 ? currentModelIndex : (savedModels.length > 0 ? 0 : -1))
      const resolvedOptions = {
        modelIndex: defaultModelIndex,
        modelKey: defaultModelIndex >= 0 ? modelStore?.getModelKey?.(savedModels[defaultModelIndex]) || null : null,
        projectMode: composerExec.active && !getActiveProject()?.id ? normalizeProjectMode(welcomeProjectMode) : 'standard',
        ...options
      }
      if (resolvedOptions.modelIndex >= 0 && !resolvedOptions.modelKey) {
        resolvedOptions.modelKey = modelStore?.getModelKey?.(savedModels[resolvedOptions.modelIndex]) || null
      }
      const project = projectStore.createProject(path, resolvedOptions)
      resolveProjectModelIndex(project)
      syncProjectState()
      if (!options.skipSave) {
        saveProjectsList(options.lastProjectPath || path)  // 持久化保存项目列表
      }
      return project
    }

    // 保存所有项目列表到后端（持久化，统一存储）
    async function saveProjectsList(lastProjectPath = '') {
      const projectStore = getProjectStore()
      syncProjectState()
      const targetLastProjectPath = arguments.length > 0 ? lastProjectPath : (getActiveProject()?.path || '')
      await projectStore.saveList(targetLastProjectPath)
    }

    // 从后端恢复项目列表（支持迁移）
    async function loadProjectsList() {
      const projectStore = getProjectStore()
      return projectStore.loadList()
    }

    // 获取当前激活项目
    function getActiveProject() {
      const projectStore = getProjectStore()
      return projectStore.getActiveProject()
    }

    // 更新执行模式 UI 显示
    function updateExecModeUI(mode) {
      const modeConfig = {
        ask: { name: ((window.i18n?.t?.('auto.l1084') ?? '询问授权')), icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>' },
        full: { name: ((window.i18n?.t?.('auto.l1089') ?? '完整授权')), icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>' }
      }
      const config = { ...(modeConfig[mode] || modeConfig.ask) }
      const askLabel = window.i18n?.t?.('auto.l1084') || '询问授权'
      const fullLabel = window.i18n?.t?.('auto.l1089') || '完整授权'
      if (mode === 'ask') config.name = askLabel
      if (mode === 'full') config.name = fullLabel
      const execModeIcon = getExecModeIcon()
      const execModeCurrent = getExecModeCurrent()
      const execModeMenu = getExecModeMenu()
      if (execModeIcon) execModeIcon.innerHTML = config.icon
      if (execModeCurrent) execModeCurrent.textContent = config.name
      // 更新选中状态
      execModeMenu.querySelectorAll('.exec-mode-option').forEach(o => {
        o.classList.toggle('selected', o.dataset.value === mode)
      })
    }

    // 加载指定项目的 Git 状态（不依赖全局变量）
    async function loadGitStatusForProject(project) {
      const gitPanelFeature = getGitPanelFeature()
      return await gitPanelFeature?.loadGitStatusForProject(project)
    }

    // 初始化项目 Git 仓库
    async function initGitForProject(project) {
      const gitPanelFeature = getGitPanelFeature()
      return await gitPanelFeature?.initGitForProject(project)
    }

    // 添加用户消息到UI（不记录到history）
    function addUserMessageToUI(content, index = null, turnId = null, options = {}) {
      const chatRenderer = getChatRenderer()
      return chatRenderer?.addUserMessage(content, { index, turnId, ...options })
    }

    // 添加AI消息到UI（不记录到history）
    function addAiMessageToUI(content, options = {}) {
      const chatRenderer = getChatRenderer()
      return chatRenderer?.addAiMessage(content, options)
    }

    // 恢复完整聊天历史（包括工具调用）
    function restoreChatHistory(messagesHistory, options = {}) {
      const chatRenderer = getChatRenderer()
      const projectPath = options.projectPath || getActiveProject()?.path || ''
      const restored = chatRenderer?.restoreChatHistory(messagesHistory, { ...options, projectPath })
      scrollToLatestAiMessage()
      return restored
    }

    function mapMessagesHistoryForProject(messagesHistory) {
      let userMsgCount = 0
      return (messagesHistory || []).map((msg) => {
        if (msg.role === 'user') {
          const index = userMsgCount
          if (!msg.hidden) userMsgCount += 1
          return {
            role: msg.role,
            content: msg.content,
            displayContent: msg.displayContent,
            attachments: msg.attachments,
            directiveBadges: msg.directiveBadges,
            references: msg.references,
            hidden: !!msg.hidden,
            index,
            time: msg.time || ''
          }
        }
        return msg
      })
    }

    function isAiMessageStillRunning(aiMsg) {
      if (!aiMsg) return false
      if (aiMsg.dataset?.workDone === 'true') return false
      if (aiMsg.dataset?.finalStreamStarted === 'true' || aiMsg.dataset?.finalStreamContent) return false
      return aiMsg.classList?.contains('thinking') || !!aiMsg.querySelector?.('.ai-thinking-block.active:not(.stopped)')
    }

    function isProjectAiRunActive(project) {
      if (!project) return false
      if (window.RunningUiRestore?.isCurrentSessionRunning && !window.RunningUiRestore.isCurrentSessionRunning(project)) return false
      // 如果 AI 已完成（只是在等 message-reply:done），不算“活跃”
      // 避免 ai-status:done 与 message-reply:done 之间的时序窗口导致 stripActiveRunHistory 被误触发
      // 但如果 awaitingFinalReply 为 true，说明还在等最终回复，AI 运行还没完全结束，仍算活跃
      // 否则切换项目回来时 ensureRunningAiBlockVisible 被跳过，看不见执行过程
      const hasCompletedRun = Number(project.aiRunCompletedAt || project._aiState?.aiRunCompletedAt || 0) > 0
      if (hasCompletedRun && !project.awaitingFinalReply && !project._pendingRunningUiRestore) return false
      return !!(
        project.isRunning ||
        project.awaitingFinalReply ||
        project._pendingRunningUiRestore ||
        (Array.isArray(project.aiOperations) && project.aiOperations.length > 0) ||
        isAiMessageStillRunning(project.savedAiMsg) ||
        project.aiRunningState?.html ||
        project._frozenAiHtml ||
        isAiMessageStillRunning(project._aiState?.currentAiMsg)
      )
    }

    function stripActiveRunHistory(messagesHistory = []) {
      const history = Array.isArray(messagesHistory) ? messagesHistory : []
      const lastUserIndex = history.map(m => m?.role).lastIndexOf('user')
      if (lastUserIndex < 0) return []
      return history.slice(0, lastUserIndex + 1)
    }

    return {
      syncProjectState,
      setProjectActivity,
      clearViewedProjectActivity,
      getSessionActivityStatus,
      resolveActivitySessionId,
      setProjectModel,
      resolveProjectModelIndex,
      getProjectModel,
      getProjectModelName,
      syncAllProjectModelRefs,
      ensureActiveProject,
      hasVisibleProjects,
      setChatInputVisible,
      enterNoProjectState,
      renderWelcomeEmptyState,
      clearWelcomeEmptyState,
      hasWelcomeEmptyState,
      ensureStatelessChatProject,
      showNoProjectSendPrompt,
      setActiveProject,
      generateProjectId,
      createProject,
      saveProjectsList,
      loadProjectsList,
      getActiveProject,
      updateExecModeUI,
      loadGitStatusForProject,
      initGitForProject,
      addUserMessageToUI,
      addAiMessageToUI,
      restoreChatHistory,
      mapMessagesHistoryForProject,
      isAiMessageStillRunning,
      isProjectAiRunActive,
      stripActiveRunHistory,
      restoreWelcomeComposerInput
    }
  }

  window.ProjectStateHelpers = { bind }
})()
