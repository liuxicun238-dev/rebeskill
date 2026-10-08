(function () {
  const PANEL_IDS = {
    archive: 'archivePanel',
    git: 'gitPanel',
    gitBranch: 'gitBranchPanel',
    gitHistory: 'gitHistoryPanel',
    integration: 'integrationPanel',
    localApps: 'localAppsPanel',
    settings: 'settingsMainPanel',
    skill: 'skillPanel'
  }

  const MAIN_PANEL_KEYS = Object.keys(PANEL_IDS)
  let savedChatPlace = null
  let restoreRaf = 0

  function getPanelId(panel) {
    return PANEL_IDS[panel] || panel
  }

  function getPanel(panel) {
    if (!panel) return null
    if (panel instanceof Element) return panel
    return document.getElementById(getPanelId(panel))
  }

  function isOpen(panel) {
    return !!getPanel(panel)?.classList.contains('show')
  }

  function anyPanelOpen(panels = MAIN_PANEL_KEYS) {
    return panels.some(isOpen)
  }

  function getChatMessages() {
    return document.getElementById('chatMessages')
  }

  function captureChatPlace() {
    const chatMessages = getChatMessages()
    if (!chatMessages) return null
    try {
      return window.ChatStickyBottom?.capturePlace?.(chatMessages) || {
        top: chatMessages.scrollTop,
        height: chatMessages.scrollHeight,
        escaped: window.ChatStickyBottom?.isEscaped?.(chatMessages) || false
      }
    } catch (_) {
      return {
        top: chatMessages.scrollTop,
        height: chatMessages.scrollHeight,
        escaped: false
      }
    }
  }

  function restoreChatPlace(place) {
    const chatMessages = getChatMessages()
    if (!chatMessages || !place) return
    if (chatMessages.style.display === 'none') chatMessages.style.display = 'block'
    const apply = () => {
      try {
        if (window.ChatStickyBottom?.restorePlace) {
          window.ChatStickyBottom.restorePlace(chatMessages, place)
        } else {
          chatMessages.scrollTop = Number(place.top) || 0
        }
      } catch (_) {
        chatMessages.scrollTop = Number(place.top) || 0
      }
    }
    apply()
    if (restoreRaf) cancelAnimationFrame(restoreRaf)
    restoreRaf = requestAnimationFrame(() => {
      restoreRaf = 0
      apply()
    })
  }

  function restoreChatPlaceIfIdle() {
    if (anyPanelOpen()) return
    const place = savedChatPlace
    savedChatPlace = null
    restoreChatPlace(place)
  }

  function hide(panel) {
    const element = getPanel(panel)
    if (!element) return false
    element.classList.remove('show')
    return true
  }

  function open(panel) {
    const element = getPanel(panel)
    if (!element) return false
    if (!anyPanelOpen()) savedChatPlace = captureChatPlace()
    element.classList.add('show')
    return true
  }

  function close(panel) {
    if (!hide(panel)) return false
    restoreChatPlaceIfIdle()
    return true
  }

  function closeMany(panels) {
    panels.forEach(hide)
    restoreChatPlaceIfIdle()
  }

  function closePeers(except, panels = Object.keys(PANEL_IDS)) {
    const exceptId = getPanelId(except)
    panels.forEach(panel => {
      const panelId = getPanelId(panel)
      if (panelId !== exceptId) hide(panelId)
    })
  }

  function ensureChatVisible(options = {}) {
    if (options.hideChat) return
    window.closeCanvasView?.()
    const chatMessages = getChatMessages()
    if (chatMessages) chatMessages.style.display = 'block'
  }

  function openExclusive(panel, options = {}) {
    const panelId = getPanelId(panel)
    const element = getPanel(panelId)
    if (!element) return false
    if (!anyPanelOpen()) savedChatPlace = captureChatPlace()
    closePeers(panelId, options.panels || MAIN_PANEL_KEYS)
    ensureChatVisible(options)
    element.classList.add('show')
    return true
  }

  window.LingxiPanelManager = {
    ids: PANEL_IDS,
    getPanel,
    open,
    openExclusive,
    close,
    closeMany,
    closePeers,
    isOpen,
    captureChatPlace,
    restoreChatPlace
  }

  // Escape 键关闭所有打开的面板，返回聊天区域
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    // 跳过输入框、弹窗等内部 Escape 用途
    const tag = (e.target.tagName || '').toLowerCase()
    const isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable
    if (isInput) return
    const anyOpen = Object.values(PANEL_IDS).some(id => {
      const el = document.getElementById(id)
      return el?.classList.contains('show')
    })
    if (!anyOpen) return
    e.preventDefault()
    closeMany(Object.keys(PANEL_IDS))
    window.ProjectSwitcher?.returnToChatArea?.()
  })
})()
