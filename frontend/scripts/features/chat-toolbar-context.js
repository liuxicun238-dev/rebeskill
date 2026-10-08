(function () {
  const TITLE_MAX = 14
  const PLACEHOLDER_TITLES = new Set(['新会话', '主线会话', '无项目会话'])

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
  }

  function truncateTitle(value, max = TITLE_MAX) {
    const raw = compactText(value)
    if (!raw) return ''
    if (raw.length <= max) return raw
    return `${raw.slice(0, max)}...`
  }

  function firstUserText(project) {
    const history = Array.isArray(project?.history) && project.history.length
      ? project.history
      : (Array.isArray(project?.messagesHistory) ? project.messagesHistory : [])
    const first = history.find(msg => msg?.role === 'user' && !msg.hidden)
    return compactText(first?.displayContent || first?.content || '')
  }

  function sessionTitle(project) {
    const fromUser = firstUserText(project)
    if (fromUser) return fromUser
    const saved = compactText(project?.chatSessionTitle || project?.branchTitle || project?.title || '')
    if (saved && !PLACEHOLDER_TITLES.has(saved)) return saved
    return ''
  }

  function projectName(project) {
    if (!project) return ''
    const named = compactText(project.name)
    if (named) return named
    const fromPath = compactText(String(project.path || '').split(/[\\/]/).filter(Boolean).pop() || '')
    return fromPath
  }

  function projectModeInfo(mode) {
    if (mode === 'research') {
      return {
        label: '研究模式',
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 15h9"/></svg>'
      }
    }
    return {
      label: '标准模式',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="18" cy="12" r="2"/><path d="M8 11 10.5 7.5M13.5 7.5 16 11"/></svg>'
    }
  }

  function els() {
    return {
      title: document.getElementById('chatSessionTitle'),
      mode: document.getElementById('chatProjectMode'),
      modeIcon: document.getElementById('chatProjectModeIcon'),
      modeLabel: document.getElementById('chatProjectModeLabel'),
      pill: document.getElementById('chatProjectPill'),
      pillName: document.getElementById('chatProjectPillName'),
      explorer: document.getElementById('chatToolbarExplorerBtn')
    }
  }

  function setHidden(node, hidden) {
    if (!node) return
    node.hidden = !!hidden
  }

  function refresh() {
    const { title, mode, modeIcon, modeLabel, pill, pillName, explorer } = els()
    if (!title || !mode || !modeIcon || !modeLabel || !pill || !pillName || !explorer) return

    const project = window.getActiveProject?.() || null
    const composerMode = document.body.classList.contains('welcome-composer-mode')
    const statelessView = composerMode
      || document.body.classList.contains('no-project-mode')
      || !!project?.stateless

    if (composerMode) {
      title.textContent = ''
      title.removeAttribute('title')
      setHidden(title, true)
    } else {
      const fullTitle = sessionTitle(project)
      const shortTitle = truncateTitle(fullTitle)
      if (shortTitle) {
        title.textContent = shortTitle
        title.title = fullTitle
        setHidden(title, false)
      } else {
        title.textContent = ''
        title.removeAttribute('title')
        setHidden(title, true)
      }
    }

    if (!statelessView && project?.id) {
      const info = projectModeInfo(project.projectMode)
      modeIcon.innerHTML = info.icon
      modeLabel.textContent = info.label
      mode.dataset.projectMode = project.projectMode === 'research' ? 'research' : 'standard'
      setHidden(mode, false)
    } else {
      modeIcon.innerHTML = ''
      modeLabel.textContent = ''
      delete mode.dataset.projectMode
      setHidden(mode, true)
    }

    if (statelessView) {
      pillName.textContent = ''
      pill.removeAttribute('title')
      setHidden(pill, true)
      explorer.title = '打开资源管理器'
      explorer.disabled = true
      setHidden(explorer, true)
      try { window.WelcomeComposerExec?.syncReturnButton?.() } catch (_) {}
      return
    }

    const name = projectName(project)
    const folderPath = compactText(project?.path || '')

    if (name) {
      pillName.textContent = name
      pill.title = folderPath || name
      setHidden(pill, false)
    } else {
      pillName.textContent = ''
      pill.removeAttribute('title')
      setHidden(pill, true)
    }

    if (folderPath) {
      explorer.title = `打开资源管理器：${folderPath}`
      explorer.disabled = false
      setHidden(explorer, false)
    } else {
      explorer.title = '打开资源管理器'
      explorer.disabled = true
      setHidden(explorer, true)
    }
    try { window.WelcomeComposerExec?.syncReturnButton?.() } catch (_) {}
  }

  async function openProjectExplorer() {
    const project = window.getActiveProject?.() || null
    const folderPath = compactText(project?.path || '')
    if (!folderPath) return
    const opener = window.api?.openProjectFolder || window.api?.showItemInFolder
    if (!opener) return
    try {
      const result = await opener(folderPath)
      if (result?.error) {
        window.showToast?.(result.error, 'error')
      }
    } catch (error) {
      window.showToast?.(error?.message || String(error), 'error')
    }
  }

  function bind() {
    const explorer = document.getElementById('chatToolbarExplorerBtn')
    if (explorer && !explorer.dataset.bound) {
      explorer.dataset.bound = '1'
      explorer.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        openProjectExplorer()
      })
    }
    refresh()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind)
  } else {
    bind()
  }

  window.ChatToolbarContext = {
    TITLE_MAX,
    truncateTitle,
    sessionTitle,
    refresh,
    bind
  }
})()
