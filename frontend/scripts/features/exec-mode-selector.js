(function () {
  function normalizeMode(mode) {
    if (mode === 'auto' || mode === 'critical') return 'ask'
    return ['ask', 'smart', 'full'].includes(mode) ? mode : 'ask'
  }

  function resolveProjectId(explicitId) {
    const fromArg = String(explicitId || '').trim()
    if (fromArg) return fromArg
    try {
      const project = typeof window.getActiveProject === 'function' ? window.getActiveProject() : null
      if (project?.id) return String(project.id)
    } catch (_) {}
    return ''
  }

  function cacheProjectMode(mode, projectId) {
    const value = normalizeMode(mode)
    const id = String(projectId || '').trim()
    if (!id) return
    try {
      const project = typeof window.getActiveProject === 'function' ? window.getActiveProject() : null
      if (project && String(project.id) === id) project.execMode = value
    } catch (_) {}
  }

  async function persistMode(mode, projectId) {
    const value = normalizeMode(mode)
    const id = resolveProjectId(projectId)
    if (!id || typeof window.api?.setPathPermissionMode !== 'function') {
      return { success: false, skipped: !id, mode: value, projectId: id || null }
    }
    const result = await window.api.setPathPermissionMode(value, id)
    if (result?.success) cacheProjectMode(value, id)
    return result || { success: false, mode: value, projectId: id }
  }

  async function loadMode(projectId) {
    const id = resolveProjectId(projectId)
    if (!id || typeof window.api?.getPathPermissions !== 'function') {
      return { success: false, mode: 'ask', projectId: id || null }
    }
    try {
      const result = await window.api.getPathPermissions(id)
      const mode = normalizeMode(result?.mode)
      if (result?.success) cacheProjectMode(mode, id)
      return { success: !!result?.success, mode, projectId: id, ...result }
    } catch (_) {
      return { success: false, mode: 'ask', projectId: id }
    }
  }

  function bind(options = {}) {
    const execModeTrigger = options.execModeTrigger
    const execModeMenu = options.execModeMenu
    const execModeIcon = options.execModeIcon
    const execModeCurrent = options.execModeCurrent
    const contextPanel = options.contextPanel
    const setExecutionMode = options.setExecutionMode || function () {}
    const showToast = options.showToast || function () {}

    if (!execModeTrigger || !execModeMenu) return

    function applyUi(mode) {
      const value = normalizeMode(mode)
      setExecutionMode(value)
      const option = execModeMenu.querySelector(`.exec-mode-option[data-value="${value}"]`)
      if (!option) return value
      const selectedIcon = option.querySelector('.option-icon svg')
      if (selectedIcon && execModeIcon) execModeIcon.innerHTML = selectedIcon.outerHTML
      if (execModeCurrent) execModeCurrent.textContent = option.querySelector('.option-name')?.textContent || ''
      execModeMenu.querySelectorAll('.exec-mode-option').forEach(o => o.classList.remove('selected'))
      option.classList.add('selected')
      execModeTrigger.classList.toggle('mode-full', value === 'full')
      return value
    }

    window.ExecModeSelector.applyUi = applyUi

    execModeTrigger.onclick = (e) => {
      e.stopPropagation()
      execModeMenu.classList.toggle('show')
    }

    execModeMenu.querySelectorAll('.exec-mode-option').forEach(option => {
      option.onclick = async () => {
        const value = option.dataset.value
        const projectId = resolveProjectId()
        if (projectId) {
          try {
            const result = await persistMode(value, projectId)
            if (!result?.success) {
              showToast('授权模式切换失败', 'error')
              return
            }
          } catch (err) {
            showToast('授权模式切换失败: ' + (err?.message || err), 'error')
            return
          }
        }
        applyUi(value)
        if (document.body.classList.contains('welcome-composer-mode')
          || window.WelcomeComposerExec?.shouldHoldAsk?.()) {
          window.WelcomeComposerExec?.markUserChanged?.()
        }
        execModeMenu.classList.remove('show')
        showToast(value === 'full' ? '已切换为完整授权' : value === 'smart' ? '已切换为智能授权' : '已切换为询问授权', 'success')
      }
    })

    document.addEventListener('click', event => {
      execModeMenu.classList.remove('show')
      if (contextPanel && !contextPanel.contains(event.target)) {
        contextPanel.classList.remove('show')
      }
    })

    async function syncFromBackend() {
      try {
        if (window.WelcomeComposerExec?.shouldHoldAsk?.()) {
          applyUi('ask')
          return
        }
        const projectId = resolveProjectId()
        if (!projectId) return
        const result = await loadMode(projectId)
        if (!result?.success) return
        applyUi(result.mode)
      } catch (err) {}
    }
    syncFromBackend()
  }

  window.ExecModeSelector = {
    bind,
    applyUi: function () {},
    persistMode,
    loadMode,
    resolveProjectId,
    normalizeMode
  }
})()
