(function () {
  const escapeHtml = window.HtmlUtils?.escapeHtml || function (value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  let dialog = null
  let sessions = []
  let selected = new Set()
  let importing = false

  function toast(message, type = 'info') {
    window.showToast?.(message, type)
  }

  function formatTime(value) {
    const ms = Number(value || 0)
    if (!ms) return ''
    try {
      return new Date(ms).toLocaleString()
    } catch {
      return ''
    }
  }

  function close() {
    if (importing) return
    dialog?.remove()
    dialog = null
    sessions = []
    selected = new Set()
  }

  function selectedSessions() {
    return sessions.filter(item => selected.has(item.path))
  }

  function renderList() {
    const body = dialog?.querySelector('.codex-import-body')
    const confirmBtn = dialog?.querySelector('[data-codex-import-confirm]')
    if (!body) return
    if (!sessions.length) {
      body.innerHTML = `<div class="codex-import-empty">没有找到本机 Codex 会话。<br>确认已使用过 Codex，且数据在 ~/.codex/sessions。</div>`
      if (confirmBtn) confirmBtn.disabled = true
      return
    }
    const groups = new Map()
    for (const item of sessions) {
      const key = item.cwd || '（未记录工作目录）'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    const html = []
    for (const [cwd, items] of groups) {
      html.push(`<div class="codex-import-group">`)
      html.push(`<div class="codex-import-group-title">${escapeHtml(cwd)}</div>`)
      for (const item of items) {
        const checked = selected.has(item.path)
        const warn = item.cwd && !item.cwdExists
          ? `<span class="codex-import-item-warn">目录不存在，导入时需另选文件夹</span>`
          : `${escapeHtml(String(item.userTurns || 0))} 轮 · ${escapeHtml(formatTime(item.updatedAt))}`
        html.push(`
          <button type="button" class="codex-import-item${checked ? ' is-selected' : ''}" data-codex-session="${escapeHtml(item.path)}">
            <span aria-hidden="true">${checked ? '☑' : '☐'}</span>
            <span class="codex-import-item-copy">
              <span class="codex-import-item-title">${escapeHtml(item.title || 'Codex 会话')}</span>
              <span class="codex-import-item-meta">${warn}</span>
            </span>
          </button>
        `)
      }
      html.push(`</div>`)
    }
    body.innerHTML = html.join('')
    if (confirmBtn) confirmBtn.disabled = selected.size === 0 || importing
  }

  function setStatus(text) {
    const body = dialog?.querySelector('.codex-import-body')
    if (body) body.innerHTML = `<div class="codex-import-status">${escapeHtml(text)}</div>`
  }

  async function ensureFrontendProject(result) {
    const store = window.ProjectStore
    if (!store) return null
    let project = store.findProjectById?.(result.projectId)
      || store.findProjectByPath?.(result.projectPath)
    if (!project) {
      project = store.createProject(result.projectPath, {
        id: result.projectId,
        storagePath: result.storagePath || '',
        projectMode: result.projectMode || window.WelcomeComposerExec?.getProjectMode?.() || 'standard',
        projectModeLocked: result.projectModeLocked === true,
        folderMtimeMs: result.folderMtimeMs || 0
      })
      try { await store.saveList?.(result.projectPath) } catch (_) {}
    }
    window.WelcomeComposerExec?.noteCreatedProject?.(project.id)
    return project
  }

  async function applyImportedResult(result) {
    const project = await ensureFrontendProject(result)
    if (!project) {
      toast('导入成功，但无法加入项目列表，请重新打开该目录', 'warning')
      return
    }
    window.clearWelcomeEmptyState?.()
    await window.ProjectSwitcher?.switchProject?.(project.id)
    await window.ProjectSwitcher?.reloadActiveBranchSession?.({ force: true, result })
    try { await window.WelcomeComposerExec?.afterProjectReady?.(window.ProjectStore?.getActiveProject?.()) } catch (_) {}
    window.ContextCompressionStack?.refresh?.()
    window.ContextCompressionStatus?.refresh?.()
  }

  async function pickFallbackFolder() {
    if (!window.api?.selectProjectPath) return ''
    const picked = await window.api.selectProjectPath()
    if (picked?.canceled || !picked?.path) return ''
    return picked.path
  }

  async function importOne(session) {
    const projectMode = window.WelcomeComposerExec?.getProjectMode?.() || 'standard'
    let projectPath = session.cwdExists ? session.cwd : ''
    if (!projectPath) {
      projectPath = await pickFallbackFolder()
      if (!projectPath) {
        return { success: false, skipped: true, error: '已跳过：未选择工作目录' }
      }
    }
    let result = await window.api.importCodexSession({
      sessionPath: session.path,
      projectPath,
      projectMode
    })
    if (result?.code === 'CWD_MISSING') {
      projectPath = await pickFallbackFolder()
      if (!projectPath) return { success: false, skipped: true, error: '已跳过：未选择工作目录' }
      result = await window.api.importCodexSession({
        sessionPath: session.path,
        projectPath,
        projectMode
      })
    }
    return result
  }

  async function confirmImport() {
    const picked = selectedSessions()
    if (!picked.length || importing) return
    if (!window.api?.importCodexSession) {
      toast('当前客户端还不支持导入 Codex 会话', 'error')
      return
    }
    importing = true
    const confirmBtn = dialog?.querySelector('[data-codex-import-confirm]')
    if (confirmBtn) confirmBtn.disabled = true
    let imported = 0
    let lastResult = null
    try {
      for (const session of picked) {
        setStatus(`正在导入：${session.title || 'Codex 会话'}`)
        const result = await importOne(session)
        if (result?.skipped) continue
        if (!result?.success) {
          toast(result?.error || `导入失败：${session.title || 'Codex 会话'}`, 'error')
          continue
        }
        imported += 1
        lastResult = result
      }
      if (lastResult) await applyImportedResult(lastResult)
      importing = false
      close()
      if (imported > 0) toast(imported > 1 ? `已导入 ${imported} 个 Codex 会话` : '已导入 Codex 会话', 'success')
    } catch (error) {
      importing = false
      renderList()
      toast(error?.message || '导入 Codex 会话失败', 'error')
    }
  }

  async function loadSessions() {
    setStatus('正在扫描本机 Codex 会话…')
    if (!window.api?.listCodexSessions) {
      setStatus('当前客户端还不支持扫描 Codex 会话')
      return
    }
    const result = await window.api.listCodexSessions()
    if (!result?.success) {
      setStatus(result?.error || '扫描 Codex 会话失败')
      return
    }
    sessions = Array.isArray(result.sessions) ? result.sessions : []
    selected = new Set()
    if (!sessions.length && result.missingHome) {
      const body = dialog?.querySelector('.codex-import-body')
      if (body) {
        body.innerHTML = `<div class="codex-import-empty">未找到 Codex 主目录。<br>${escapeHtml(result.home || '~/.codex')}</div>`
      }
      return
    }
    renderList()
  }

  function open() {
    if (dialog) return
    dialog = document.createElement('div')
    dialog.className = 'codex-import-dialog'
    dialog.innerHTML = `
      <div class="codex-import-panel" role="dialog" aria-modal="true" aria-label="导入 Codex 会话">
        <div class="codex-import-header">
          <div class="codex-import-title">导入 Codex 会话</div>
          <button type="button" class="codex-import-close" data-codex-import-close aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="codex-import-body"></div>
        <div class="codex-import-footer">
          <button type="button" class="codex-import-btn cancel" data-codex-import-close>取消</button>
          <button type="button" class="codex-import-btn confirm" data-codex-import-confirm disabled>导入为新会话</button>
        </div>
      </div>
    `
    dialog.addEventListener('click', (event) => {
      const target = event.target.closest('[data-codex-import-close], [data-codex-import-confirm], [data-codex-session], .codex-import-panel')
      if (event.target === dialog) {
        close()
        return
      }
      if (!target) return
      if (target.matches('[data-codex-import-close]')) {
        close()
        return
      }
      if (target.matches('[data-codex-import-confirm]')) {
        void confirmImport()
        return
      }
      const sessionPath = target.getAttribute('data-codex-session')
      if (sessionPath) {
        if (selected.has(sessionPath)) selected.delete(sessionPath)
        else selected.add(sessionPath)
        renderList()
      }
    })
    document.body.appendChild(dialog)
    void loadSessions()
  }

  window.CodexImportUi = { open, close }
})()
