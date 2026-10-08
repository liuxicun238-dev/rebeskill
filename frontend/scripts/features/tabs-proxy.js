(function () {
  function bind(options = {}) {
    // ===== 标签页状态 =====
    let tabs = []  // 标签页列表: [{id, url, title, webview, detached, detachedEl}]
    let activeTabId = null
    let detachedWindows = []  // 独立窗口列表
    let sidebarExpanded = true  // 右侧功能栏默认展开

    // ===== 依赖注入 =====
    const elements = options.elements || {}
    const layoutUI = options.layoutUI
    const monacoEditors = options.monacoEditors
    const initMonaco = options.initMonaco
    const getMonacoLanguage = options.getMonacoLanguage
    const getFileName = options.getFileName || function () { return '' }
    const getOpIcons = options.getOpIcons || function () { return ({}) }
    const showToast = options.showToast || function () {}
    const updateRightPanelWidthVar = options.updateRightPanelWidthVar || function () {}
    const scrollToLatestAiMessage = options.scrollToLatestAiMessage || function () {}
    const scrollChatToBottom = options.scrollChatToBottom || function () {}
    const getActiveProject = options.getActiveProject || function () { return null }
    const getActiveProjectId = options.getActiveProjectId || function () { return null }
    const getProjects = options.getProjects || function () { return [] }
    const getSavedModels = options.getSavedModels || function () { return [] }
    const getAllSkills = options.getAllSkills || function () { return [] }
    const getEnabledSkills = options.getEnabledSkills || function () { return [] }
    const getProjectModel = options.getProjectModel || function () { return null }
    const switchProject = options.switchProject || async function () {}
    const sendMessage = options.sendMessage || async function () {}
    const getCurrentAiMsg = options.getCurrentAiMsg || function () { return null }
    const api = options.api

    let windowTabsFeature = window.WindowTabsFeature?.bind({
      tabs,
      elements: {
        tabCountEl: elements.tabCountEl,
        webviewPanel: elements.webviewPanel,
        center: elements.center,
        divider1: elements.divider1,
        sidebar: elements.sidebar,
        sidebarToggle: elements.sidebarToggle,
        rightViewToggle: elements.rightViewToggle,
        webviewContainer: elements.webviewContainer,
        webviewTabs: elements.webviewTabs,
        webviewEmpty: elements.webviewEmpty,
        webviewPanelExpand: elements.webviewPanelExpand
      },
      layoutUI,
      monacoEditors,
      initMonaco,
      getMonacoLanguage,
      getFileName,
      getFileIcon: () => getOpIcons().file,
      getActiveTabId: () => activeTabId,
      setActiveTabId: id => { activeTabId = id },
      getSidebarExpanded: () => sidebarExpanded,
      setSidebarExpanded: value => { sidebarExpanded = value },
      scrollChatToBottom: () => scrollChatToBottom(),
      sendMessage,
      getActiveProjectId,
      getActiveProject,
      showToast
    })

    let filePreview = window.FilePreview?.bind({
      api,
      createFileTab,
      closeTab: (id) => windowTabsFeature?.closeTab?.(id),
      showToast,
      getCurrentProjectPath: () => getActiveProject()?.path || ''
    })

    // 更新标签数量
    function updateTabCount() {
      return windowTabsFeature?.updateTabCount()
    }

    // 调整布局
    function adjustLayout(hasTabs) {
      const result = windowTabsFeature?.adjustLayout(hasTabs)
      requestAnimationFrame(updateRightPanelWidthVar)
      return result
    }

    layoutUI?.bindSidebarControls({
      elements: {
        webviewPanel: elements.webviewPanel,
        center: elements.center,
        sidebar: elements.sidebar,
        sidebarToggle: elements.sidebarToggle,
        collapseButton: elements.collapseBtn
      },
      getHasTabs: () => tabs.filter(t => !t.detached).length > 0,
      setSidebarExpanded: value => { sidebarExpanded = value },
      // onAfterToggle 内三件事原本是同帧内同步连调：
      //   syncRightViewLayout() 写 DOM classList
      //   updateRightPanelWidthVar() 改 CSS 变量（触发 reflow）
      //   scrollToLatestAiMessage() 读 offsetHeight + scrollIntoView（又触发 reflow）
      // 写插在读中间是经典 layout thrashing。 现在先批量写、下帧再读+滚：
      // 三步被分别丢到两帧内，layout 在每帧之间自动稳定，scroll 读到的是稳定值。
      onAfterToggle: () => {
        windowTabsFeature?.syncRightViewLayout?.()
        updateRightPanelWidthVar()
        requestAnimationFrame(() => {
          scrollToLatestAiMessage()
        })
      }
    })

    // 创建新标签（webview）
    function createTab(url, detached = false) {
      return windowTabsFeature?.createTab(url, detached)
    }

    // 创建文件标签页
    function createFileTab(path, content, wasRunning = false, options = {}) {
      return windowTabsFeature?.createFileTab(path, content, wasRunning, options)
    }

    function createMusicTab(url) {
      return windowTabsFeature?.createMusicTab?.(url, 'Music Studio')
    }

    function sendMusicCommand(payload) {
      return windowTabsFeature?.sendMusicCommand?.(payload)
    }

    function createCollaborationTab() {
      return null
    }

    function renderMainPlanPanel(steps = [], title = '计划') {
      window.PlanProgressUI?.renderInMessage?.(steps, title, getCurrentAiMsg())
    }

    function showCanvasInspector(payload = {}) {
      const tab = windowTabsFeature?.showCanvasInspector?.(payload)
      requestAnimationFrame(updateRightPanelWidthVar)
      return tab
    }

    function closeCanvasInspector() {
      return windowTabsFeature?.closeCanvasInspector?.()
    }

    function openAgentMusicStudioFromTool(projectId = '') {
      const targetProjectId = projectId || getActiveProjectId() || ''
      const url = `agent-music-studio.html?projectId=${encodeURIComponent(targetProjectId)}&restore=1`
      return createMusicTab(url)
    }

    window.openAgentMusicStudioFromTool = openAgentMusicStudioFromTool

    function openBlendFile(id) {
      const tab = tabs.find(t => t.id === id)
      if (tab?.path) api?.openProjectFolder?.(tab.path)
    }

    function showBlendInFolder(id) {
      const tab = tabs.find(t => t.id === id)
      if (!tab?.path) return
      const folder = String(tab.path).replace(/[\\/][^\\/]*$/, '')
      api?.openProjectFolder?.(folder)
    }

    // 创建嵌入文件标签
    function createEmbeddedFileTab(id, filePath, content, wasRunning = false) {
      return windowTabsFeature?.createEmbeddedFileTab(id, filePath, content, wasRunning)
    }

    // 标记文件已修改
    function markFileModified(id) {
      return windowTabsFeature?.markFileModified(id)
    }

    // 切换文件运行模式（仅 HTML 文件，使用 iframe）
    function toggleFileRunMode(id) {
      return windowTabsFeature?.toggleFileRunMode(id)
    }

    // 保存文件
    function saveFileTab(id) {
      return windowTabsFeature?.saveFileTab(id)
    }

    // 创建嵌入标签（webview）
    function createEmbeddedTab(id, url) {
      return windowTabsFeature?.createEmbeddedTab(id, url)
    }

    // 设置webview事件（用于嵌入标签）
    function setupWebviewEvents(webview, id) {
      return windowTabsFeature?.setupWebviewEvents(webview, id)
    }

    // 更新标签标题
    function updateTabLabel(id, title) {
      return windowTabsFeature?.updateTabLabel(id, title)
    }

    // 切换标签（只对嵌入标签）
    function switchTab(id) {
      return windowTabsFeature?.switchTab(id)
    }

    // 关闭标签
    function closeTab(id) {
      return windowTabsFeature?.closeTab(id)
    }

    // 在左侧打开链接（嵌入标签）
    function openInWebview(url) {
      return windowTabsFeature?.openInWebview(url)
    }

    // 在右侧标签中打开
    function openInNewTab(url) {
      return windowTabsFeature?.openInNewTab(url)
    }

    return {
      windowTabsFeature,
      filePreview,
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
      updateTabLabel,
      switchTab,
      closeTab,
      openInWebview,
      openInNewTab
    }
  }

  window.TabsProxy = { bind }
})()
