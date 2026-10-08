(function () {
  const AUTO_COLLAPSED_ATTR = 'autoCollapsed'
  const RIGHT_PANEL_WIDTH_KEY = 'lingxi.rightPanelWidth'
  const RIGHT_PANEL_WIDTH_VAR = '--lingxi-right-panel-width'
  const RIGHT_PANEL_CUSTOM_CLASS = 'right-panel-custom-width'
  const RIGHT_PANEL_DEFAULT_WIDTH = 760
  const RIGHT_PANEL_MIN_WIDTH = 360
  const RIGHT_PANEL_MIN_CENTER = 360

  function clampRightPanelWidth(width, viewportWidth) {
    const viewport = Number(viewportWidth)
    const view = Number.isFinite(viewport) && viewport > 0
      ? viewport
      : (typeof window !== 'undefined' ? window.innerWidth : 1280)
    const minPanel = RIGHT_PANEL_MIN_WIDTH
    const maxPanel = Math.max(minPanel, view - RIGHT_PANEL_MIN_CENTER)
    const n = Math.round(Number(width) || 0)
    return Math.min(maxPanel, Math.max(minPanel, n))
  }

  function widthFromRightDividerDrag(startWidth, startX, clientX, viewportWidth) {
    return clampRightPanelWidth(Number(startWidth) + (Number(startX) - Number(clientX)), viewportWidth)
  }

  function readStoredRightPanelWidth() {
    try {
      const n = Number(window.localStorage?.getItem(RIGHT_PANEL_WIDTH_KEY))
      return Number.isFinite(n) && n >= RIGHT_PANEL_MIN_WIDTH ? Math.round(n) : null
    } catch {
      return null
    }
  }

  function persistRightPanelWidth(width) {
    try {
      window.localStorage?.setItem(RIGHT_PANEL_WIDTH_KEY, String(width))
    } catch (_) {}
  }

  function clearInlinePanelWidth(webviewPanel) {
    if (!webviewPanel) return
    webviewPanel.style.flex = ''
    webviewPanel.style.minWidth = ''
    webviewPanel.style.maxWidth = ''
  }

  function applyRightPanelWidth(width, options = {}) {
    const next = clampRightPanelWidth(width, options.viewportWidth)
    const root = document.documentElement
    root.style.setProperty(RIGHT_PANEL_WIDTH_VAR, `${next}px`)
    if (options.custom) root.classList.add(RIGHT_PANEL_CUSTOM_CLASS)
    if (options.persist) persistRightPanelWidth(next)
    if (options.clearCustom) root.classList.remove(RIGHT_PANEL_CUSTOM_CLASS)
    return next
  }

  function restoreRightPanelWidth() {
    const stored = readStoredRightPanelWidth()
    if (stored == null) return RIGHT_PANEL_DEFAULT_WIDTH
    return applyRightPanelWidth(stored, { custom: true })
  }

  function resetRightPanelWidth() {
    try {
      window.localStorage?.removeItem(RIGHT_PANEL_WIDTH_KEY)
    } catch (_) {}
    document.documentElement.classList.remove(RIGHT_PANEL_CUSTOM_CLASS)
    document.documentElement.style.removeProperty(RIGHT_PANEL_WIDTH_VAR)
    return RIGHT_PANEL_DEFAULT_WIDTH
  }

  function markAutoCollapsed(sidebar) {
    if (sidebar) sidebar.dataset[AUTO_COLLAPSED_ATTR] = '1'
  }

  function clearAutoCollapsed(sidebar) {
    if (sidebar) delete sidebar.dataset[AUTO_COLLAPSED_ATTR]
  }

  function wasAutoCollapsed(sidebar) {
    return sidebar?.dataset?.[AUTO_COLLAPSED_ATTR] === '1'
  }

  let layoutSwitchFrame = 0
  function markLayoutSwitching() {
    const root = document.documentElement
    root.classList.add('layout-switching')
    if (layoutSwitchFrame) cancelAnimationFrame(layoutSwitchFrame)
    layoutSwitchFrame = requestAnimationFrame(() => {
      layoutSwitchFrame = requestAnimationFrame(() => {
        layoutSwitchFrame = 0
        root.classList.remove('layout-switching')
      })
    })
  }

  function adjust(elements, hasTabs) {
    const { webviewPanel, center, divider, sidebar, sidebarToggle } = elements
    if (!webviewPanel || !center || !divider || !sidebar) return false

    markLayoutSwitching()
    clearInlinePanelWidth(webviewPanel)
    center.style.flex = ''

    if (hasTabs) {
      webviewPanel.classList.add('show')
      webviewPanel.classList.remove('shrink')
      center.classList.remove('full', 'shrink', 'max', 'with-toggle')
      center.classList.add('has-webview')
      divider.classList.remove('hidden')
      if (sidebar.classList.contains('expanded')) {
        markAutoCollapsed(sidebar)
        sidebar.classList.remove('expanded')
        sidebarToggle?.classList.add('is-collapsed')
      }
    } else {
      webviewPanel.classList.remove('show', 'shrink')
      divider.classList.add('hidden')
      center.classList.remove('shrink', 'with-toggle', 'has-webview')
      if (wasAutoCollapsed(sidebar)) {
        sidebar.classList.add('expanded')
        sidebarToggle?.classList.remove('is-collapsed')
        clearAutoCollapsed(sidebar)
      }
      center.classList.add('full')
    }

    return sidebar.classList.contains('expanded')
  }

  function collapse(elements, hasTabs) {
    const { webviewPanel, center, sidebar, sidebarToggle } = elements
    if (!webviewPanel || !center || !sidebar) return false

    markLayoutSwitching()
    clearAutoCollapsed(sidebar)
    sidebar.classList.remove('expanded')
    sidebarToggle?.classList.add('is-collapsed')

    if (hasTabs) {
      webviewPanel.classList.remove('shrink')
      center.classList.remove('shrink', 'full', 'max')
      center.classList.add('with-toggle')
    } else {
      center.classList.remove('full')
      center.classList.add('max')
    }

    return false
  }

  function expand(elements, hasTabs) {
    const { webviewPanel, center, sidebar, sidebarToggle } = elements
    if (!webviewPanel || !center || !sidebar) return true

    markLayoutSwitching()
    clearAutoCollapsed(sidebar)
    sidebar.classList.add('expanded')
    sidebarToggle?.classList.remove('is-collapsed')

    if (hasTabs) {
      webviewPanel.classList.add('shrink')
      center.classList.add('shrink')
      center.classList.remove('with-toggle')
    } else {
      center.classList.remove('max')
      center.classList.add('full')
    }

    return true
  }

  function bindSidebarControls(options = {}) {
    const elements = options.elements || {}
    const getHasTabs = options.getHasTabs || function () { return false }
    const setSidebarExpanded = options.setSidebarExpanded || function () {}
    const onAfterToggle = options.onAfterToggle || function () {}
    const { collapseButton, sidebarToggle, sidebar } = elements

    function notifyAfterToggle(expanded) {
      requestAnimationFrame(() => onAfterToggle(expanded))
    }

    if (collapseButton) {
      collapseButton.onclick = () => {
        const expanded = collapse(elements, getHasTabs())
        setSidebarExpanded(expanded)
        notifyAfterToggle(expanded)
      }
    }

    if (sidebarToggle) {
      sidebarToggle.onclick = () => {
        const isExpanded = sidebar?.classList.contains('expanded')
        const expanded = isExpanded ? collapse(elements, getHasTabs()) : expand(elements, getHasTabs())
        sidebarToggle.blur()
        setSidebarExpanded(expanded)
        notifyAfterToggle(expanded)
      }
    }
  }

  function bindDividerDrag(options = {}) {
    const divider = options.divider
    const webviewPanel = options.webviewPanel
    const onResize = options.onResize || function () {}
    if (!divider || !webviewPanel) return

    restoreRightPanelWidth()
    clearInlinePanelWidth(webviewPanel)

    let dragging = false
    let moved = false
    let startX = 0
    let startWidth = 0
    let lastWidth = 0
    let pendingWidth = 0
    let resizeFrame = 0
    const DRAG_THRESHOLD_PX = 3

    function canResize() {
      if (divider.classList.contains('hidden')) return false
      if (webviewPanel.classList.contains('expand-left')) return false
      if (webviewPanel.classList.contains('right-view-hidden')) return false
      return webviewPanel.classList.contains('show') || webviewPanel.classList.contains('shrink')
    }

    function emitResize(width) {
      pendingWidth = Math.max(0, Math.round(Number(width) || 0))
      if (resizeFrame) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0
        onResize(pendingWidth)
      })
    }

    function setDragging(active) {
      document.documentElement.classList.toggle('is-resizing-right-panel', active)
    }

    divider.title = divider.title || '拖动调整预览宽度，双击恢复默认'
    divider.addEventListener('dblclick', event => {
      event.preventDefault()
      if (!canResize()) return
      lastWidth = resetRightPanelWidth()
      clearInlinePanelWidth(webviewPanel)
      emitResize(webviewPanel.offsetWidth || lastWidth)
    })

    divider.onmousedown = event => {
      if (event.button !== 0) return
      event.preventDefault()
      if (!canResize()) return
      dragging = true
      moved = false
      startX = event.clientX
      startWidth = webviewPanel.offsetWidth || RIGHT_PANEL_DEFAULT_WIDTH
      lastWidth = startWidth
      setDragging(true)
    }

    document.addEventListener('mousemove', event => {
      if (!dragging) return
      if (!moved && Math.abs(event.clientX - startX) < DRAG_THRESHOLD_PX) return
      moved = true
      lastWidth = widthFromRightDividerDrag(startWidth, startX, event.clientX, window.innerWidth)
      applyRightPanelWidth(lastWidth, { custom: true })
      clearInlinePanelWidth(webviewPanel)
      emitResize(lastWidth)
    })

    document.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      setDragging(false)
      if (!moved) return
      const committed = applyRightPanelWidth(lastWidth || webviewPanel.offsetWidth, { custom: true, persist: true })
      emitResize(committed)
    })

    window.addEventListener('resize', () => {
      if (!document.documentElement.classList.contains(RIGHT_PANEL_CUSTOM_CLASS)) return
      const current = Number.parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(RIGHT_PANEL_WIDTH_VAR),
        10
      )
      if (!Number.isFinite(current)) return
      applyRightPanelWidth(current, { custom: true, persist: true })
      emitResize(webviewPanel.offsetWidth || current)
    })
  }

  window.LayoutUI = {
    adjust,
    collapse,
    expand,
    bindSidebarControls,
    bindDividerDrag,
    clampRightPanelWidth,
    widthFromRightDividerDrag,
    restoreRightPanelWidth,
    resetRightPanelWidth,
    applyRightPanelWidth
  }
})()
