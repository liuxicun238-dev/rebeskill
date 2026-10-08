(function () {
  let openMenu = null
  const GROUP_COLLAPSE_STORAGE_KEY = 'lingxi-sidebar-project-groups'
  const groupCollapsed = { pinned: false, projects: false }
  const dragState = { id: '', group: '', didDrag: false }
  const DRAG_THRESHOLD_PX = 6

  function groupItems(body) {
    return Array.from(body?.querySelectorAll('.project-item') || [])
  }

  function groupKeyFromEl(node) {
    return node?.closest?.('.project-list-group')?.dataset?.group || ''
  }

  function resolveDropTarget(clientY, container, draggedItem) {
    const groups = Array.from(container?.querySelectorAll('.project-list-group') || [])
    if (!groups.length) return null

    const pickGroup = group => {
      const key = group.dataset.group || ''
      if (!key) return null
      const heading = group.querySelector('.project-list-heading')
      const body = group.querySelector('.project-list-group-body')
      const items = groupItems(body).filter(item => item !== draggedItem)
      if (group.classList.contains('collapsed') || !items.length) {
        return { group: key, item: null, body, heading, place: 'after' }
      }
      if (heading) {
        const headRect = heading.getBoundingClientRect()
        if (clientY < headRect.bottom) {
          return { group: key, item: items[0], body, place: 'before' }
        }
      }
      for (const item of items) {
        const rect = item.getBoundingClientRect()
        if (clientY < rect.top + rect.height / 2) {
          return { group: key, item, body, place: 'before' }
        }
      }
      return { group: key, item: items[items.length - 1], body, place: 'after' }
    }

    for (const group of groups) {
      const rect = group.getBoundingClientRect()
      if (clientY >= rect.top && clientY <= rect.bottom) return pickGroup(group)
    }

    let nearest = null
    let nearestDist = Infinity
    for (const group of groups) {
      const rect = group.getBoundingClientRect()
      const dist = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom
      if (dist < nearestDist) {
        nearestDist = dist
        nearest = group
      }
    }
    return nearest ? pickGroup(nearest) : null
  }

  function ensureDragChrome() {
    let ghost = document.getElementById('projectDragGhost')
    if (!ghost) {
      ghost = document.createElement('div')
      ghost.id = 'projectDragGhost'
      ghost.className = 'project-drag-ghost'
      ghost.setAttribute('aria-hidden', 'true')
      document.body.appendChild(ghost)
    }
    let indicator = document.getElementById('projectDropIndicator')
    if (!indicator) {
      indicator = document.createElement('div')
      indicator.id = 'projectDropIndicator'
      indicator.className = 'project-drop-indicator'
      indicator.setAttribute('aria-hidden', 'true')
      document.body.appendChild(indicator)
    }
    return { ghost, indicator }
  }

  function hideDragChrome() {
    const ghost = document.getElementById('projectDragGhost')
    const indicator = document.getElementById('projectDropIndicator')
    if (ghost) {
      ghost.classList.remove('is-visible')
      ghost.replaceChildren()
    }
    indicator?.classList.remove('is-visible')
    document.body.classList.remove('project-list-reordering')
    document.querySelectorAll('.project-item.is-drop-origin').forEach(el => el.classList.remove('is-drop-origin'))
    document.querySelectorAll('.project-list-group.is-drop-target').forEach(el => el.classList.remove('is-drop-target'))
    document.getElementById('btnExcel')?.classList.remove('drag-over')
  }

  function moveGhost(ghost, clientX, clientY) {
    ghost.style.transform = `translate(${Math.round(clientX - 16)}px, ${Math.round(clientY - 14)}px)`
  }

  function placeDropIndicator(indicator, target) {
    if (!target) {
      indicator.classList.remove('is-visible')
      return
    }
    const collapsed = !!target.body?.closest?.('.project-list-group.collapsed')
    const rect = target.item
      ? target.item.getBoundingClientRect()
      : (collapsed ? target.heading : target.body || target.heading)?.getBoundingClientRect()
    if (!rect) {
      indicator.classList.remove('is-visible')
      return
    }
    const y = target.item
      ? (target.place === 'after' ? rect.bottom : rect.top)
      : (collapsed ? rect.bottom : rect.top + 8)
    indicator.style.left = `${Math.round(rect.left)}px`
    indicator.style.width = `${Math.round(rect.width)}px`
    indicator.style.top = `${Math.round(y - 1)}px`
    indicator.classList.add('is-visible')
  }

  function bindProjectListReorder(container, options) {
    if (!container) return
    container.querySelectorAll('.project-item-head.is-drag-handle').forEach(head => {
      head.draggable = false
      head.addEventListener('pointerdown', event => {
        if (event.isPrimary === false || (typeof event.button === 'number' && event.button !== 0)) return
        if (event.target?.closest?.('button, a, input, textarea, select, .project-action-btn')) return
        const item = head.closest('.project-item')
        if (!item || !container.contains(item)) return
        const pointerId = event.pointerId
        const startX = Number(event.clientX) || 0
        const startY = Number(event.clientY) || 0
        const sourceGroup = item.dataset.group || groupKeyFromEl(item)
        const draggedId = item.dataset.id || ''
        let moved = false
        let drop = null
        let overArchive = false
        const doc = head.ownerDocument || document

        const cleanup = (started) => {
          doc.removeEventListener('pointermove', onMove)
          doc.removeEventListener('pointerup', onUp)
          doc.removeEventListener('pointercancel', onCancel)
          try {
            if (pointerId !== undefined && head.hasPointerCapture?.(pointerId)) {
              head.releasePointerCapture(pointerId)
            }
          } catch {}
          hideDragChrome()
          if (started) {
            window.dispatchEvent(new CustomEvent('lingxi-project-drag-end', { detail: { projectId: draggedId } }))
          }
          dragState.id = ''
          dragState.group = ''
          setTimeout(() => { dragState.didDrag = false }, 200)
        }

        const onMove = moveEvent => {
          if (pointerId !== undefined && moveEvent.pointerId !== undefined && moveEvent.pointerId !== pointerId) return
          const clientX = Number(moveEvent.clientX) || 0
          const clientY = Number(moveEvent.clientY) || 0
          if (!moved) {
            if (Math.hypot(clientX - startX, clientY - startY) < DRAG_THRESHOLD_PX) return
            moved = true
            dragState.didDrag = true
            dragState.id = draggedId
            dragState.group = sourceGroup
            closeProjectMenu()
            item.classList.add('is-drop-origin')
            const { ghost } = ensureDragChrome()
            ghost.replaceChildren()
            const clone = head.cloneNode(true)
            clone.removeAttribute('draggable')
            clone.removeAttribute('tabindex')
            ghost.appendChild(clone)
            ghost.classList.add('is-visible')
            document.body.classList.add('project-list-reordering')
            try { head.setPointerCapture?.(pointerId) } catch {}
            window.dispatchEvent(new CustomEvent('lingxi-project-drag-start', { detail: { projectId: draggedId, group: sourceGroup } }))
          }
          moveEvent.preventDefault()
          const { ghost, indicator } = ensureDragChrome()
          moveGhost(ghost, clientX, clientY)
          const hit = doc.elementFromPoint?.(clientX, clientY)
          const archiveBtn = doc.getElementById?.('btnExcel')
          overArchive = !!(archiveBtn && hit && archiveBtn.contains(hit))
          archiveBtn?.classList.toggle('drag-over', overArchive)
          container.querySelectorAll('.project-list-group.is-drop-target').forEach(el => el.classList.remove('is-drop-target'))
          if (overArchive) {
            drop = null
            indicator.classList.remove('is-visible')
            return
          }
          drop = resolveDropTarget(clientY, container, item)
          if (drop?.group) {
            container.querySelector(`.project-list-group[data-group="${drop.group}"]`)?.classList.add('is-drop-target')
          }
          placeDropIndicator(indicator, drop)
        }

        const onUp = upEvent => {
          if (pointerId !== undefined && upEvent.pointerId !== undefined && upEvent.pointerId !== pointerId) return
          const didMove = moved
          const finalDrop = drop
          const archive = overArchive
          if (didMove) upEvent.preventDefault()
          cleanup(didMove)
          if (!didMove || !draggedId) return
          if (archive) {
            window.dispatchEvent(new CustomEvent('lingxi-project-drop-archive', { detail: { projectId: draggedId } }))
            return
          }
          if (!finalDrop?.group) return
          if (groupCollapsed[finalDrop.group]) {
            groupCollapsed[finalDrop.group] = false
            saveGroupCollapsed()
          }
          const targetId = finalDrop.item?.dataset?.id || ''
          options.onMoveProject?.(draggedId, targetId, {
            group: finalDrop.group,
            place: finalDrop.place === 'after' ? 'after' : 'before'
          })
        }

        const onCancel = cancelEvent => {
          if (pointerId !== undefined && cancelEvent.pointerId !== undefined && cancelEvent.pointerId !== pointerId) return
          cleanup(moved)
        }

        doc.addEventListener('pointermove', onMove, { passive: false })
        doc.addEventListener('pointerup', onUp)
        doc.addEventListener('pointercancel', onCancel)
      })
    })
  }

  const escapeHtml = HtmlUtils.escapeHtml

  function escapeAttr(value = '') {
    return escapeHtml(value)
  }

  function actionIcon(name) {
    const icons = {
      pin: '<path d="M12 17v5"/><path d="M5 17h14"/><path d="m7 9 5-5 5 5"/><path d="M9 17V9h6v8"/>',
      folder: '<path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
      edit: '<path d="M12 20h9"/><path d="m16.5 3.5 4 4L8 20H4v-4Z"/>',
      branch: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h3a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3h1"/>',
      archive: '<path d="M3 7h18"/><path d="M5 7v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7"/><path d="M9 11h6"/><path d="M4 4h16v3H4z"/>',
      close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
      more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
      snapshot: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M9 12h6"/><path d="M12 9v6"/>',
      trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
      chevron: '<polyline points="9 6 15 12 9 18"/>',
      newChat: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>'
    }
    return `<svg viewBox="0 0 24 24">${icons[name] || ''}</svg>`
  }

  function groupStorageKey(label) {
    return label === '置顶' ? 'pinned' : 'projects'
  }

  function loadGroupCollapsed() {
    try {
      const raw = JSON.parse(localStorage.getItem(GROUP_COLLAPSE_STORAGE_KEY) || '{}')
      if (!raw || typeof raw !== 'object') return
      groupCollapsed.pinned = raw.pinned === true
      groupCollapsed.projects = raw.projects === true
    } catch {}
  }

  function saveGroupCollapsed() {
    try {
      localStorage.setItem(GROUP_COLLAPSE_STORAGE_KEY, JSON.stringify(groupCollapsed))
    } catch {}
  }

  loadGroupCollapsed()

  function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
  }

  function firstUserMessageText(project) {
    const history = Array.isArray(project?.history) && project.history.length
      ? project.history
      : (Array.isArray(project?.messagesHistory) ? project.messagesHistory : [])
    const first = history.find(msg => msg?.role === 'user' && !msg.hidden)
    return compactText(first?.displayContent || first?.content || '')
  }

  function resolveChatSessionTitle(session, project) {
    const stored = compactText(session?.title || '') || '新会话'
    const isCurrent = !!session?.current || (!!session?.sessionId && session.sessionId === project?.chatSessionId)
    if (!isCurrent) return stored
    const fromUser = firstUserMessageText(project)
    if (!fromUser) return stored
    if (fromUser !== stored) session.title = fromUser
    return fromUser
  }

  function pad2(value) {
    return String(value).padStart(2, '0')
  }

  function formatSessionDate(session) {
    const time = Number(session?.updatedAt || 0)
    if (!time) return ''
    const date = new Date(time)
    if (Number.isNaN(date.getTime())) return ''

    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startOfThatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const dayDiff = Math.round((startOfToday - startOfThatDay) / (24 * 60 * 60 * 1000))
    const hm = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`

    if (dayDiff === 0) return `今天 ${hm}`
    if (dayDiff === 1) return `昨天 ${hm}`
    if (dayDiff > 1 && dayDiff < 7) return `${dayDiff}天前`
    if (date.getFullYear() === now.getFullYear()) {
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
  }

  function isMainlineBranchName(branchName = '') {
    return /^(main|master)$/i.test(String(branchName || '').trim())
  }

  function isRenderableBranchName(branchName = '') {
    const value = String(branchName || '').trim()
    return !!value && !['workspace', '-', '未开启', '未选择'].includes(value)
  }

  function normalizeBranchName(branchName = '') {
    const value = String(branchName || '').trim()
    return isRenderableBranchName(value) ? value : ''
  }

  function getProjectBranchSessions(project) {
    const currentBranchName = normalizeBranchName(project.branchName || project.gitStatus?.branch || '')
    const currentBranchKey = String(project.branchKey || '').trim()
    const rawSessions = Array.isArray(project.branchSessions) ? project.branchSessions.filter(Boolean) : []
    const mainlineFromBackend = rawSessions.find(session => session?.isMainline)
    const mainlineName = String(
      mainlineFromBackend?.branchName ||
      (isMainlineBranchName(currentBranchName) ? currentBranchName : '') ||
      rawSessions.find(session => isMainlineBranchName(session?.branchName))?.branchName ||
      ''
    ).trim()
    const sessionsByKey = new Map()

    const addSession = (session = {}) => {
      const branchName = String(session.branchName || currentBranchName || '').trim()
      if (!branchName) return
      const branchKey = String(session.branchKey || (branchName === currentBranchName ? currentBranchKey : '') || branchName).trim()
      const isMainline = !!session.isMainline || (!!mainlineName && branchName === mainlineName) || (!mainlineName && isMainlineBranchName(branchName))
      // 只认项目当前分支，忽略历史列表中残留的 session.current。
      const current = (!!currentBranchName && branchName === currentBranchName)
        || (!!currentBranchKey && branchKey === currentBranchKey)
      const fallbackTitle = isMainline ? '主线会话' : ''

      // 同名 Git 分支只显示一行，避免 branchKey 变化生成重复条目。
      const existing = sessionsByKey.get(branchName)
      sessionsByKey.set(branchName, {
        ...existing,
        ...session,
        branchName,
        branchKey,
        title: session.title || fallbackTitle,
        updatedAt: Number(session.updatedAt || (current ? project.updatedAt || project.lastOpenedAt : 0) || 0),
        isMainline,
        current
      })
    }

    rawSessions
      .filter(session => isRenderableBranchName(session?.branchName) || session?.isMainline)
      .forEach(addSession)

    if (currentBranchName) {
      addSession({
        branchName: currentBranchName,
        branchKey: currentBranchKey || currentBranchName,
        title: project.branchTitle || (isMainlineBranchName(currentBranchName) ? (project.title || '主线会话') : ''),
        updatedAt: project.updatedAt || project.lastOpenedAt || 0,
        current: true,
        isMainline: isMainlineBranchName(currentBranchName)
      })
    }

    // 若后端返回了空标题，但本地 project.branchTitle 有值，回填到当前分支行
    if (project.branchTitle) {
      for (const session of sessionsByKey.values()) {
        if (session.current && !String(session.title || '').trim()) {
          session.title = project.branchTitle
        }
      }
    }

    if (mainlineName && ![...sessionsByKey.values()].some(session => session.isMainline)) {
      addSession({
        branchName: mainlineName,
        title: '主线会话',
        updatedAt: 0,
        current: mainlineName === currentBranchName,
        isMainline: true
      })
    }

    if (![...sessionsByKey.values()].some(session => session.isMainline)) {
      sessionsByKey.set('__mainline__', {
        branchName: '',
        branchKey: '__mainline__',
        title: project.branchTitle || project.title || project.name || '主线会话',
        updatedAt: project.updatedAt || project.lastOpenedAt || 0,
        current: !currentBranchName,
        isMainline: true
      })
    }

    return [...sessionsByKey.values()]
      .filter(session => session.isMainline || isRenderableBranchName(session.branchName))
      .sort((a, b) =>
      Number(b.isMainline) - Number(a.isMainline) ||
      Number(b.current) - Number(a.current) ||
      (b.updatedAt || 0) - (a.updatedAt || 0) ||
      String(a.branchName || '').localeCompare(String(b.branchName || ''), 'zh-Hans-CN')
    )
  }

  function closeProjectMenu() {
    openMenu?.cleanup?.()
    if (openMenu?.el) openMenu.el.remove()
    if (openMenu?.item) openMenu.item.classList.remove('menu-open')
    if (openMenu?.row) openMenu.row.classList.remove('menu-open')
    openMenu = null
  }

  function placeActionMenu(menu, button) {
    const rect = button.getBoundingClientRect()
    const menuRect = menu.getBoundingClientRect()
    const left = Math.min(Math.max(8, rect.right - menuRect.width), window.innerWidth - menuRect.width - 8)
    const top = Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 8)
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }

  function bindActionMenuLifecycle(menu, button, item, row = null) {
    item?.classList.add('menu-open')
    row?.classList.add('menu-open')
    placeActionMenu(menu, button)

    const onDocumentPointerDown = event => {
      if (!menu.contains(event.target) && event.target !== button) {
        closeProjectMenu()
      }
    }
    const onScrollOrResize = () => closeProjectMenu()
    const onKeydown = event => {
      if (event.key === 'Escape') closeProjectMenu()
    }
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    document.addEventListener('keydown', onKeydown, true)
    openMenu = {
      el: menu,
      item,
      row,
      cleanup: () => {
        document.removeEventListener('pointerdown', onDocumentPointerDown, true)
        window.removeEventListener('scroll', onScrollOrResize, true)
        window.removeEventListener('resize', onScrollOrResize)
        document.removeEventListener('keydown', onKeydown, true)
      }
    }
  }

  function showProjectMenu(button, project, item, options) {
    closeProjectMenu()

    const menu = document.createElement('div')
    menu.className = 'project-action-menu'
    const pinLabel = project.pinned ? '取消置顶' : '置顶项目'
    menu.innerHTML = `
      <button class="project-action-menu-item" type="button" data-action="pin">${actionIcon('pin')}<span>${pinLabel}</span></button>
      <button class="project-action-menu-item" type="button" data-action="open">${actionIcon('folder')}<span>在资源管理器中打开</span></button>
      <button class="project-action-menu-item" type="button" data-action="rename">${actionIcon('edit')}<span>重命名项目</span></button>
      ${project.workspaceKind === 'worktree' ? `<button class="project-action-menu-item" type="button" data-action="workspace-merge">${actionIcon('branch')}<span>合并回主工作区</span></button>` : ''}
      <button class="project-action-menu-item" type="button" data-action="archive">${actionIcon('archive')}<span>归档项目</span></button>
      ${project.workspaceKind === 'worktree' ? `<button class="project-action-menu-item danger" type="button" data-action="workspace-delete">${actionIcon('trash')}<span>删除独立工作区</span></button>` : ''}
      <button class="project-action-menu-item danger" type="button" data-action="remove">${actionIcon('close')}<span>移除</span></button>
    `
    document.body.appendChild(menu)
    bindActionMenuLifecycle(menu, button, item)

    menu.querySelectorAll('[data-action]').forEach(actionBtn => {
      actionBtn.onclick = event => {
        event.stopPropagation()
        const action = actionBtn.dataset.action
        closeProjectMenu()
        options.onProjectAction?.(project, action)
      }
    })
  }

  function showBranchSessionMenu(button, project, session, item, options) {
    closeProjectMenu()
    const branchName = String(session?.branchName || '').trim()
    if (!branchName || session?.isMainline || /^(main|master)$/i.test(branchName)) return

    const menu = document.createElement('div')
    menu.className = 'project-action-menu project-branch-action-menu'
    menu.innerHTML = `
      <button class="project-action-menu-item" type="button" data-action="view-diff">${actionIcon('branch')}<span>查看相对主线改动</span></button>
      <button class="project-action-menu-item" type="button" data-action="merge">${actionIcon('snapshot')}<span>合并到主线</span></button>
      <button class="project-action-menu-item danger" type="button" data-action="delete">${actionIcon('trash')}<span>删除分支</span></button>
    `
    document.body.appendChild(menu)
    const row = button.closest('.project-branch-session')
    bindActionMenuLifecycle(menu, button, item, row)

    menu.querySelectorAll('[data-action]').forEach(actionBtn => {
      actionBtn.onclick = event => {
        event.stopPropagation()
        const action = actionBtn.dataset.action
        closeProjectMenu()
        options.onBranchSessionAction?.(project, session, action)
      }
    })
  }

  function createProjectItem(project, options, state) {
    const item = document.createElement('div')
    const projectPath = project.path || ''
    const folderIcon = state.folderIcon || ''
    const activeProjectId = state.activeProjectId || null
    const isActiveProject = project.id === activeProjectId
    const allBranchSessions = getProjectBranchSessions(project)
    const mainlineSession = allBranchSessions.find(session => session.isMainline) || null
    const branchOnlySessions = allBranchSessions.filter(session => !session.isMainline)
    const getSessionActivityStatus = (sessionId) => {
      if (typeof state.getSessionActivityStatus === 'function') {
        return state.getSessionActivityStatus(project, sessionId) || ''
      }
      const map = project.sessionActivityStatus
      if (map && typeof map === 'object') {
        const status = map[sessionId]
        if (['running', 'done', 'error'].includes(status)) return status
      }
      return ''
    }
    const renderSessionActivityIndicator = (activityStatus) => {
      if (!activityStatus) return ''
      if (activityStatus === 'running') {
        return `<span class="session-activity-indicator session-activity-spinner" aria-hidden="true" title="执行中"></span>`
      }
      if (activityStatus === 'done') {
        return `<span class="session-activity-indicator session-activity-dot session-activity-done" aria-hidden="true" title="已完成"></span>`
      }
      if (activityStatus === 'error') {
        return `<span class="session-activity-indicator session-activity-dot session-activity-error" aria-hidden="true" title="出错"></span>`
      }
      return ''
    }
    const isExpanded = project.expanded !== false
    // 初始化成功后立刻以明确状态为准。后续一次瞬时的 git-status 失败不应让
    // “开启安全快照”图标重新闪烁，误导用户以为刚才没有开启成功。
    const needsSnapshotInit = project.snapshotProtectionEnabled !== true && !!project.gitStatus?.error
    const snapshotTitle = needsSnapshotInit ? '开启 AI 安全快照' : '查看 AI 安全快照'
    const mainlineRowHtml = mainlineSession ? (() => {
      const mainlineBranch = mainlineSession.branchName || ''
      const sessionTitle = mainlineSession.title || project.title || project.name || '主线会话'
      const sessionDate = formatSessionDate(mainlineSession)
      const selectedClass = isActiveProject && mainlineSession.current ? ' selected' : ''
      if (!branchOnlySessions.length) {
        return `<button class="project-branch-session project-mainline-session project-single-session ${mainlineSession.current ? 'current' : ''}${selectedClass}" type="button" data-branch="${escapeAttr(mainlineBranch)}" title="${escapeAttr(sessionTitle)}">
          <span class="project-branch-session-main">
            <span class="project-branch-session-title">${escapeHtml(sessionTitle)}</span>
            ${sessionDate ? `<span class="project-branch-session-date">${escapeHtml(sessionDate)}</span>` : ''}
          </span>
        </button>`
      }
      return `<button class="project-branch-session project-mainline-session ${mainlineSession.current ? 'current' : ''}${selectedClass}" type="button" data-branch="${escapeAttr(mainlineBranch)}" title="主线 / ${escapeAttr(sessionTitle)}">
        <span class="project-branch-session-spacer"></span>
        <span class="project-branch-session-main">
          <span class="project-branch-session-meta">
            <span class="project-mainline-session-label">主线</span>
            ${sessionDate ? `<span class="project-branch-session-date">${escapeHtml(sessionDate)}</span>` : ''}
          </span>
          <span class="project-branch-session-title">${escapeHtml(sessionTitle)}</span>
        </span>
      </button>`
    })() : ''
    const chatSessions = Array.isArray(project.chatSessions) ? project.chatSessions : []
    // sessionId 去重，防止后端/内存污染导致侧栏出现同会话多条
    const dedupedChatSessions = []
    const seenChatSessionIds = new Set()
    for (const session of chatSessions) {
      const id = String(session?.sessionId || '').trim()
      if (!id || seenChatSessionIds.has(id)) continue
      seenChatSessionIds.add(id)
      dedupedChatSessions.push(session)
    }
    const visibleChatSessions = dedupedChatSessions
      .slice()
      // 按创建时间正序：新开会话插在原会话下面，点击切换不重排
      .sort((a, b) =>
        (Number(a.createdAt || 0) - Number(b.createdAt || 0)) ||
        String(a.sessionId || '').localeCompare(String(b.sessionId || ''), 'zh-Hans-CN')
      )
    // 主会话固定：优先后端 isPrimary / main，其次最早创建；不能用“当前选中”或排序后 index 猜
    const primarySessionId =
      visibleChatSessions.find(item => item?.isPrimary)?.sessionId ||
      visibleChatSessions.find(item => item?.sessionId === 'main')?.sessionId ||
      visibleChatSessions[0]?.sessionId ||
      ''
    // 同项目多会话：有会话就显示列表，不能只显示 1 个，否则原会话标题会消失
    const chatSessionRowsHtml = visibleChatSessions.length
      ? `<span class="project-chat-session-list">
        ${visibleChatSessions.map(session => {
          const sessionId = session.sessionId || ''
          const sessionTitle = resolveChatSessionTitle(session, project)
          const sessionDate = formatSessionDate(session)
          const isBranchSessionActive = isActiveProject && !!project.branchName && !project.chatSessionId
          const isChatSessionCurrent = !!session.current || (!!sessionId && sessionId === String(project.chatSessionId || '').trim())
          const selectedClass = isActiveProject && !isBranchSessionActive && isChatSessionCurrent ? ' selected' : ''
          const isCurrent = isActiveProject && !isBranchSessionActive && isChatSessionCurrent
          const isPrimarySession = !!session.isPrimary || sessionId === primarySessionId
          const sessionActivity = getSessionActivityStatus(sessionId)
          const activityClass = sessionActivity ? ` session-activity-${sessionActivity}` : ''
          return `<button class="project-chat-session ${isPrimarySession ? 'is-primary' : 'is-extra'}${isCurrent ? ' current' : ''}${selectedClass}${activityClass}" type="button" data-chat-session="${escapeAttr(sessionId)}" title="${escapeAttr(sessionTitle)}">
            <span class="project-chat-session-main">
              ${renderSessionActivityIndicator(sessionActivity)}
              <span class="project-chat-session-title">${escapeHtml(sessionTitle)}</span>
              <span class="project-chat-session-delete" role="button" tabindex="0" data-chat-session="${escapeAttr(sessionId)}" title="删除会话">${actionIcon('trash')}</span>
              ${sessionDate ? `<span class="project-chat-session-date">${escapeHtml(sessionDate)}</span>` : ''}
            </span>
          </button>`
        }).join('')}
      </span>`
      : ''
    // Git 分支和同项目会话是并列层级，不能用 || 二选一。
    // 有 chat-sessions 时主线由会话列表承载，只追加非主线分支，避免主线重复。
    // 共享目录 Git 分支只在安全快照中心管理；侧栏只展示普通会话和独立工作区项目。
    const showSharedBranchSessions = false
    const branchSessionRowsHtml = showSharedBranchSessions && (branchOnlySessions.length || (!chatSessionRowsHtml && mainlineRowHtml))
      ? `<span class="project-branch-session-list">
      ${chatSessionRowsHtml ? '' : mainlineRowHtml}
      ${branchOnlySessions.filter(session => isRenderableBranchName(session.branchName)).map(session => {
        const branch = session.branchName
        const sessionTitle = session.title || ''
        const sessionDate = formatSessionDate(session)
        const isCurrentBranchSession = isActiveProject && !project.chatSessionId && session.current
        const selectedClass = isCurrentBranchSession ? ' selected' : ''
        return `<button class="project-branch-session project-branch-line-session ${isCurrentBranchSession ? 'current' : ''}${selectedClass}" type="button" data-branch="${escapeAttr(branch)}" title="${escapeAttr(branch)} / ${escapeAttr(sessionTitle)}">
          <span class="project-branch-session-icon">${actionIcon('branch')}</span>
          <span class="project-branch-session-main">
            <span class="project-branch-session-meta">
              <span class="project-branch-session-branch">${escapeHtml(branch)}</span>
              ${sessionDate ? `<span class="project-branch-session-date">${escapeHtml(sessionDate)}</span>` : ''}
            </span>
            <span class="project-branch-session-title">${escapeHtml(sessionTitle)}</span>
          </span>
          ${isCurrentBranchSession
            ? `<span class="project-branch-session-more" role="button" tabindex="0" data-branch="${escapeAttr(branch)}" title="分支操作">${actionIcon('more')}</span>`
            : `<span class="project-branch-session-delete" role="button" tabindex="0" data-branch="${escapeAttr(branch)}" title="删除分支">${actionIcon('trash')}</span>`}
        </button>`
      }).join('')}
    </span>`
      : ''
    const sessionRowsHtml = `${chatSessionRowsHtml}${branchSessionRowsHtml}`
    // 项目名和会话标题之间加分割线，层次更清晰
    const sessionSectionHtml = sessionRowsHtml
      ? `<span class="project-session-divider" aria-hidden="true"></span>${sessionRowsHtml}`
      : ''

    item.className = 'project-item' +
      (isActiveProject ? ' active' : '') +
      (project.pinned ? ' pinned' : '') +
      (isExpanded ? ' expanded' : '')
    item.dataset.id = project.id
    item.dataset.group = state.group || (project.pinned ? 'pinned' : 'projects')
    if (projectPath) {
      item.dataset.path = projectPath
      item.title = `路径：${projectPath}`
    }
    item.draggable = false
    item.innerHTML = `
      <div class="project-item-row">
          <span class="project-item-main">
            <span class="project-item-header-row">
              <span class="project-item-head is-drag-handle" role="button" tabindex="0" aria-expanded="${isExpanded ? 'true' : 'false'}" title="${escapeAttr(projectPath)}">
                <span class="project-item-icon" aria-hidden="true">${folderIcon}</span>
                <span class="project-item-folder">${escapeHtml(project.name || '未命名项目')}</span>
                ${project.workspaceKind === 'worktree' ? `<span class="project-workspace-badge" title="独立工作区：${escapeAttr(project.workspaceBranch || '')}">并行</span>` : ''}
              </span>
              <button class="project-action-btn project-new-chat-btn" type="button" title="新开会话">${actionIcon('newChat')}</button>
              <button class="project-action-btn project-snapshot-btn ${needsSnapshotInit ? 'needs-init' : ''}" type="button" title="${escapeAttr(snapshotTitle)}">${actionIcon('snapshot')}</button>
              <span class="project-item-actions">
                <button class="project-action-btn project-more-btn" type="button" title="项目操作">${actionIcon('more')}</button>
              </span>
            </span>
          ${sessionSectionHtml}
        </span>
      </div>
    `

    item.onclick = e => {
      const moreButton = e.target.closest('.project-more-btn')
      const projectHead = e.target.closest('.project-item-head')
      const snapshotButton = e.target.closest('.project-snapshot-btn')
      const newChatButton = e.target.closest('.project-new-chat-btn')
      const branchMoreButton = e.target.closest('.project-branch-session-more')
      const branchSessionButton = e.target.closest('.project-branch-session')
      const deleteBranchButton = e.target.closest('.project-branch-session-delete')
      const deleteChatSessionButton = e.target.closest('.project-chat-session-delete')
      const chatSessionButton = e.target.closest('.project-chat-session')
      if (moreButton) {
        e.stopPropagation()
        showProjectMenu(moreButton, project, item, options)
      } else if (newChatButton) {
        e.stopPropagation()
        options.onCreateProjectChatSession?.(project)
      } else if (deleteChatSessionButton) {
        e.stopPropagation()
        const sessionId = deleteChatSessionButton.dataset.chatSession || ''
        options.onDeleteProjectChatSession?.(project, { sessionId })
      } else if (chatSessionButton) {
        e.stopPropagation()
        const sessionId = chatSessionButton.dataset.chatSession || ''
        options.onSwitchChatSession?.(project, { sessionId })
      } else if (projectHead) {
        e.stopPropagation()
        if (dragState.didDrag) {
          dragState.didDrag = false
          return
        }
        options.onToggleProject?.(project, item, item.classList.contains('expanded'))
      } else if (snapshotButton) {
        e.stopPropagation()
        if (project.gitStatus?.error) {
          options.onInitGit?.(project)
        } else {
          options.onViewGit?.(project)
        }
      } else if (deleteBranchButton) {
        e.stopPropagation()
        const branch = deleteBranchButton.dataset.branch || ''
        const session = allBranchSessions.find(item => item.branchName === branch) || { branchName: branch }
        options.onDeleteBranchSession?.(project, session)
      } else if (branchMoreButton) {
        e.stopPropagation()
        const branch = branchMoreButton.dataset.branch || ''
        const session = allBranchSessions.find(item => item.branchName === branch) || { branchName: branch }
        showBranchSessionMenu(branchMoreButton, project, session, item, options)
      } else if (branchSessionButton) {
        e.stopPropagation()
        const branch = branchSessionButton.dataset.branch || ''
        const session = allBranchSessions.find(item => item.branchName === branch) || { branchName: branch }
        options.onSwitchBranchSession?.(project, session)
      }
    }

    item.querySelector('.project-item-head')?.addEventListener('keydown', e => {
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      options.onToggleProject?.(project, item, item.classList.contains('expanded'))
    })

    return item
  }

  function appendProjectGroup(container, label, projects, options, state) {
    const key = groupStorageKey(label)
    const collapsed = !!groupCollapsed[key]
    const group = document.createElement('div')
    group.className = 'project-list-group' + (collapsed ? ' collapsed' : '')
    group.dataset.group = key
    group.innerHTML = `<button class="project-list-heading" type="button" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span class="project-list-heading-label">${escapeHtml(label)}</span>
      <span class="project-list-heading-chevron" aria-hidden="true">${actionIcon('chevron')}</span>
    </button>
    <div class="project-list-group-body${projects.length === 0 ? ' is-empty' : ''}"></div>`
    const body = group.querySelector('.project-list-group-body')
    const heading = group.querySelector('.project-list-heading')
    const itemState = { ...state, group: key }
    projects.forEach(project => body.appendChild(createProjectItem(project, options, itemState)))
    heading.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      groupCollapsed[key] = !groupCollapsed[key]
      saveGroupCollapsed()
      const nowCollapsed = groupCollapsed[key]
      group.classList.toggle('collapsed', nowCollapsed)
      heading.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true')
    })
    container.appendChild(group)
  }

  function render(options) {
    const container = typeof options.container === 'string'
      ? document.getElementById(options.container)
      : options.container
    if (!container) return

    const projects = (options.projects || []).filter(project => !project.archived && !project.stateless)
    const activeProjectId = options.activeProjectId || null
    const folderIcon = options.folderIcon || ''

    closeProjectMenu()
    // 执行中会反复刷活动点。整表 innerHTML 重建不能把侧栏滚回顶部。
    const prevScrollTop = container.scrollTop || 0
    container.innerHTML = ''

    if (projects.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">暂无项目</div>'
      container.scrollTop = prevScrollTop
      return
    }

    const pinnedProjects = projects.filter(project => project.pinned)
    const normalProjects = projects.filter(project => !project.pinned)
    const state = { container, activeProjectId, folderIcon }
    appendProjectGroup(container, '置顶', pinnedProjects, options, state)
    appendProjectGroup(container, '项目', normalProjects, options, state)
    bindProjectListReorder(container, options)
    container.scrollTop = prevScrollTop
  }

  window.ProjectListUI = { render }
})()
