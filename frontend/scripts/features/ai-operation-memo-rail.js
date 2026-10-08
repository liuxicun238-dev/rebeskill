(function () {
  const TICK_HEIGHT = 16
  const LENS_RADIUS = 72
  const VISIBILITY_KEY = 'lingxiAiMemoRailVisible'
  const DRAWER_OPEN_KEY = 'lingxiAiMemoDrawerOpen'

  const state = {
    rail: null,
    drawer: null,
    tape: null,
    drawerList: null,
    tooltip: null,
    modal: null,
    items: [],
    loading: false,
    selectedId: '',
    viewportActiveId: '',
    cursorActiveIndex: 0,
    tapeOffsetY: 0,
    drawerOpen: false,
    searchQuery: '',
    activeFilter: 'all',
    expandedFiles: new Set(),
    refreshTimer: null,
    eventsBound: false,
    documentEventsBound: false,
    chatScrollBound: false,
    userScrolledTape: false
  }

  function parseVisibility(value) {
    if (value == null || value === '') return null
    if (typeof value === 'boolean') return value
    const text = String(value).trim().toLowerCase()
    if (['false', '0', 'off', 'no', 'hidden', 'hide', 'disabled'].includes(text)) return false
    if (['true', '1', 'on', 'yes', 'visible', 'show', 'enabled'].includes(text)) return true
    return null
  }

  function isVisibleEnabled() {
    try {
      const saved = parseVisibility(localStorage.getItem(VISIBILITY_KEY))
      if (saved != null) return saved
    } catch {}
    return true
  }

  function escapeHtml(value = '') {
    if (window.HtmlUtils?.escapeHtml) return window.HtmlUtils.escapeHtml(value)
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function getActiveProject() {
    return window.ProjectStore?.getActiveProject?.() || null
  }

  function getActiveProjectPath() {
    return getActiveProject()?.path || ''
  }

  function formatDate(value = '') {
    if (!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    const pad = n => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function formatRelativeTime(value = '') {
    if (!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    const now = Date.now()
    const diff = Math.max(0, Math.floor((now - date.getTime()) / 1000))
    if (diff < 60) return '刚刚'
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
    if (diff < 86400 * 3) return `${Math.floor(diff / 86400)}天前`
    const pad = n => String(n).padStart(2, '0')
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  function getSummary(item = {}) {
    return item.modelSummary || item.summary || ''
  }

  function getCategory(item = {}) {
    if (item.status === 'draft') return 'draft'
    const title = String(item.title || '').toLowerCase()
    const summary = String(getSummary(item)).toLowerCase()
    const text = `${title} ${summary}`

    if (/fix|bug|修复|报错|异常|解决|回归|纠正|错误/.test(text)) return 'fix'
    if (/feat|feature|新增|添加|实现|接入|支持|创建/.test(text)) return 'feat'
    if (/refactor|重构|迁移|拆分|调整|整合|重写/.test(text)) return 'refactor'
    if (/optimize|perf|优化|提速|改进|增强|加速/.test(text)) return 'optimize'

    const stats = item.stats || {}
    if (Number(stats.created || 0) > 0) return 'feat'
    if (Number(stats.deleted || 0) > 0 && Number(stats.modified || 0) === 0) return 'refactor'
    return 'feat'
  }

  function getCategoryLabel(category) {
    switch (category) {
      case 'feat': return '功能'
      case 'fix': return '修复'
      case 'refactor': return '重构'
      case 'optimize': return '优化'
      case 'draft': return '草稿'
      default: return '改动'
    }
  }

  function getCategoryColor(category) {
    switch (category) {
      case 'feat': return '#3b82f6'
      case 'fix': return '#ef4444'
      case 'refactor': return '#8b5cf6'
      case 'optimize': return '#10b981'
      case 'draft': return '#f59e0b'
      default: return 'var(--accent-primary)'
    }
  }

  function ensureDom() {
    const center = document.getElementById('center')
    const chatMessages = document.getElementById('chatMessages')
    if (!center || !chatMessages) return false

    let rail = document.getElementById('aiMemoChatRail')
    if (!rail) {
      rail = document.createElement('div')
      rail.className = 'ai-memo-chat-rail'
      rail.id = 'aiMemoChatRail'
      rail.setAttribute('aria-label', 'AI 操作备忘录标尺')
      rail.innerHTML = [
        '<div class="ai-memo-chat-rail-viewport">',
        '  <div class="ai-memo-chat-rail-tape" id="aiMemoRailTape"></div>',
        '</div>'
      ].join('')
      rail.addEventListener('wheel', handleRailWheel, { passive: false })
      rail.addEventListener('pointermove', handleRailPointerMove)
      rail.addEventListener('pointerleave', handleRailPointerLeave)
    }
    if (rail.parentNode !== center) {
      center.insertBefore(rail, chatMessages)
    }
    rail.querySelector('.ai-memo-chat-rail-indicator')?.remove()
    rail.querySelector('.ai-memo-chat-rail-toggle')?.remove()
    let drawer = document.getElementById('aiMemoChatDrawer')
    if (!drawer) {
      drawer = document.createElement('aside')
      drawer.className = 'ai-memo-chat-drawer'
      drawer.id = 'aiMemoChatDrawer'
      drawer.setAttribute('aria-label', '项目里程碑时间树')
      drawer.innerHTML = `
        <header class="ai-memo-drawer-header">
          <div class="ai-memo-drawer-header-left">
            <svg class="ai-memo-drawer-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            <span class="ai-memo-drawer-title">里程碑时间树</span>
            <span class="ai-memo-drawer-count" id="aiMemoDrawerCount">0</span>
          </div>
          <div class="ai-memo-drawer-header-actions">
            <button type="button" class="ai-memo-drawer-btn" id="aiMemoDrawerRefresh" title="刷新备忘录" aria-label="刷新">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 11-.57-8.38l5.67-5.67"/></svg>
            </button>
            <button type="button" class="ai-memo-drawer-btn" id="aiMemoDrawerClose" title="收起抽屉 (Esc)" aria-label="收起">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </header>
        <div class="ai-memo-drawer-filter">
          <div class="ai-memo-drawer-search-box">
            <svg class="ai-memo-drawer-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input type="text" class="ai-memo-drawer-search-input" id="aiMemoDrawerSearch" placeholder="搜索标题、摘要或改动文件..." />
            <button type="button" class="ai-memo-drawer-search-clear" id="aiMemoDrawerSearchClear" aria-label="清空搜索">×</button>
          </div>
          <div class="ai-memo-drawer-chips" id="aiMemoDrawerChips">
            <button type="button" class="ai-memo-filter-chip active" data-filter="all">全部</button>
            <button type="button" class="ai-memo-filter-chip" data-filter="feat">功能</button>
            <button type="button" class="ai-memo-filter-chip" data-filter="fix">修复</button>
            <button type="button" class="ai-memo-filter-chip" data-filter="refactor">重构</button>
            <button type="button" class="ai-memo-filter-chip" data-filter="optimize">优化</button>
            <button type="button" class="ai-memo-filter-chip" data-filter="draft">草稿</button>
          </div>
        </div>
        <div class="ai-memo-drawer-list" id="aiMemoDrawerList"></div>
        <footer class="ai-memo-drawer-footer">
          <span>点击文件查看 Diff · 点击定位直达对话</span>
          <span class="ai-memo-drawer-esc-hint">Esc 收起</span>
        </footer>
      `
      drawer.querySelector('#aiMemoDrawerClose')?.addEventListener('click', () => toggleDrawer(false))
      drawer.querySelector('#aiMemoDrawerRefresh')?.addEventListener('click', () => refresh())

      const searchInput = drawer.querySelector('#aiMemoDrawerSearch')
      const clearBtn = drawer.querySelector('#aiMemoDrawerSearchClear')
      searchInput?.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.trim()
        clearBtn?.classList.toggle('show', Boolean(state.searchQuery))
        renderDrawer()
      })
      clearBtn?.addEventListener('click', () => {
        if (searchInput) searchInput.value = ''
        state.searchQuery = ''
        clearBtn.classList.remove('show')
        renderDrawer()
      })

      drawer.querySelector('#aiMemoDrawerChips')?.addEventListener('click', (e) => {
        const chip = e.target.closest('.ai-memo-filter-chip')
        if (!chip) return
        drawer.querySelectorAll('.ai-memo-filter-chip').forEach(el => el.classList.remove('active'))
        chip.classList.add('active')
        state.activeFilter = chip.dataset.filter || 'all'
        renderDrawer()
      })
    }
    if (drawer.parentNode !== center) {
      center.insertBefore(drawer, chatMessages)
    }

    let tooltip = document.querySelector('.ai-memo-chat-tooltip')
    if (!tooltip) {
      tooltip = document.createElement('div')
      tooltip.className = 'ai-memo-chat-tooltip'
      tooltip.setAttribute('role', 'tooltip')
      document.body.appendChild(tooltip)
    }

    let modal = document.getElementById('aiMemoChatModal')
    if (!modal) {
      modal = document.createElement('div')
      modal.className = 'ai-memo-chat-modal hidden'
      modal.id = 'aiMemoChatModal'
      modal.setAttribute('aria-hidden', 'true')
      modal.innerHTML = `
        <div class="ai-memo-chat-modal-backdrop" data-action="close"></div>
        <section class="ai-memo-chat-modal-panel" role="dialog" aria-modal="true" aria-labelledby="aiMemoChatModalTitle">
          <header class="ai-memo-chat-modal-header">
            <div>
              <div class="ai-memo-chat-modal-kicker">AI 操作备忘录详情</div>
              <h2 id="aiMemoChatModalTitle">AI 操作备忘录</h2>
              <div class="ai-memo-chat-modal-meta" id="aiMemoChatModalMeta"></div>
            </div>
            <button type="button" class="ai-memo-chat-modal-close" data-action="close" aria-label="关闭">×</button>
          </header>
          <div class="ai-memo-chat-modal-summary" id="aiMemoChatModalSummary"></div>
          <pre class="ai-memo-chat-modal-content" id="aiMemoChatModalContent"></pre>
        </section>
      `
      document.body.appendChild(modal)
      modal.addEventListener('click', event => {
        const action = event.target?.dataset?.action
        if (action === 'close') closeModal()
      })
    }

    if (!state.documentEventsBound) {
      state.documentEventsBound = true
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          if (!state.modal?.classList.contains('hidden')) {
            closeModal()
          } else if (state.drawerOpen) {
            toggleDrawer(false)
          }
        }
      })
    }

    if (!state.chatScrollBound) {
      bindChatScrollListener()
    }

    state.rail = rail
    state.drawer = drawer
    state.tape = rail.querySelector('#aiMemoRailTape')
    state.drawerList = drawer.querySelector('#aiMemoDrawerList')
    state.tooltip = tooltip
    state.modal = modal
    return true
  }

  function toggleDrawer(open) {
    if (!ensureDom()) return
    state.drawerOpen = typeof open === 'boolean' ? open : !state.drawerOpen
    try {
      localStorage.setItem(DRAWER_OPEN_KEY, state.drawerOpen ? 'true' : 'false')
    } catch {}

    state.drawer?.classList.toggle('is-open', state.drawerOpen)
    state.rail?.classList.toggle('is-drawer-open', state.drawerOpen)
    hideTooltip()
    if (state.drawerOpen) {
      renderDrawer()
      const searchInput = state.drawer?.querySelector('#aiMemoDrawerSearch')
      if (searchInput) searchInput.focus()
    }
  }

  function setRailVisible(visible) {
    if (!state.rail) return
    state.rail.classList.toggle('is-empty', !visible)
  }

  function removeRail() {
    hideTooltip()
    if (state.modal) {
      state.modal.classList.add('hidden')
      state.modal.setAttribute('aria-hidden', 'true')
    }
    state.selectedId = ''
    if (state.rail) {
      state.rail.remove()
      state.rail = null
      state.tape = null
    }
    if (state.drawer) {
      state.drawer.remove()
      state.drawer = null
      state.drawerList = null
    }
    window.clearTimeout(state.refreshTimer)
    state.refreshTimer = null
    state.items = []
  }

  function normalizeItems(items = []) {
    return (Array.isArray(items) ? items : [])
      .filter(item => item && item.id)
      .sort((a, b) => String(a.savedAt || a.createdAt || '').localeCompare(String(b.savedAt || b.createdAt || '')))
  }

  function getTapeBounds() {
    const total = state.items.length
    const viewH = state.rail?.clientHeight || 0
    const contentH = total * TICK_HEIGHT
    return {
      maxOffset: 0,
      minOffset: Math.min(0, viewH - contentH)
    }
  }

  function applyFisheyeLens(pointerY = null) {
    if (pointerY == null || !state.tape || !state.items.length) return
    const ticks = Array.from(state.tape.querySelectorAll('.ai-memo-chat-tick'))
    if (!ticks.length) return

    let closestTick = null
    let minDistance = Infinity

    ticks.forEach(tick => {
      const rect = tick.getBoundingClientRect()
      const centerY = rect.top + rect.height / 2
      const dist = Math.abs(pointerY - centerY)

      if (dist < minDistance) {
        minDistance = dist
        closestTick = tick
      }

      if (dist < LENS_RADIUS) {
        const t = Math.cos((dist / LENS_RADIUS) * (Math.PI / 2))
        const ease = t * t
        const len = 8 + ease * 14

        tick.style.setProperty('--tick-len', `${len.toFixed(1)}px`)
        tick.style.setProperty('--tick-thick', `${(1.5 + ease * 0.7).toFixed(2)}px`)
        tick.classList.toggle('is-lens-center', dist < 6)
      } else {
        tick.style.removeProperty('--tick-len')
        tick.style.removeProperty('--tick-thick')
        tick.classList.remove('is-lens-center')
      }
    })

    if (closestTick) {
      const idx = Number(closestTick.dataset.memoIndex || 0)
      state.cursorActiveIndex = idx
      const item = state.items[idx]
      if (item) showTooltip(closestTick, item)
    }
  }

  function clearFisheyeLens() {
    if (!state.tape) return
    state.tape.querySelectorAll('.ai-memo-chat-tick').forEach(tick => {
      tick.style.removeProperty('--tick-len')
      tick.style.removeProperty('--tick-thick')
      tick.classList.remove('is-lens-center')
    })
    hideTooltip()
  }

  function handleRailPointerMove(event) {
    if (!state.items.length || !state.tape) return
    applyFisheyeLens(event.clientY)
  }

  function handleRailPointerLeave() {
    clearFisheyeLens()
  }

  function handleRailWheel(event) {
    if (!state.items.length || !state.tape) return
    event.preventDefault()
    const delta = event.deltaY || event.deltaX || 0
    if (!delta) return

    state.userScrolledTape = true
    const { minOffset, maxOffset } = getTapeBounds()
    const step = (Math.sign(delta) * TICK_HEIGHT) * (event.shiftKey ? 3 : 1)
    state.tapeOffsetY = Math.max(minOffset, Math.min(maxOffset, state.tapeOffsetY - step))
    state.cursorActiveIndex = Math.max(0, Math.min(state.items.length - 1, Math.round(-state.tapeOffsetY / TICK_HEIGHT)))

    updateTapeTransform()
    if (event.clientY) applyFisheyeLens(event.clientY)
  }

  function updateTapeTransform() {
    if (!state.tape) return
    state.tape.style.transform = `translateY(${state.tapeOffsetY}px)`
  }

  function buildTick(item, index) {
    const tick = document.createElement('div')
    tick.className = 'ai-memo-chat-tick is-major'
    tick.dataset.memoId = item.id
    tick.dataset.memoIndex = String(index)
    tick.title = item.title || 'AI 操作备忘录'

    const category = getCategory(item)
    tick.classList.add(`category-${category}`)
    if (item.status === 'draft') tick.classList.add('is-draft')
    if (item.id === state.selectedId) tick.classList.add('is-active')
    if (item.id === state.viewportActiveId) tick.classList.add('is-viewport-active')

    tick.addEventListener('click', () => {
      state.cursorActiveIndex = index
      toggleDrawer(true)
      highlightDrawerCard(item.id)
    })
    return tick
  }

  function renderRail() {
    if (!ensureDom() || !state.tape) return
    state.tape.innerHTML = ''
    const items = normalizeItems(state.items)
    setRailVisible(items.length > 0)
    if (!items.length) return

    items.forEach((item, index) => {
      state.tape.appendChild(buildTick(item, index))
    })
    if (!state.userScrolledTape) {
      state.cursorActiveIndex = items.length - 1
      state.tapeOffsetY = getTapeBounds().minOffset
    }
    updateTapeTransform()
  }
  function filterItems(items = []) {
    let result = [...items]
    if (state.activeFilter !== 'all') {
      result = result.filter(item => getCategory(item) === state.activeFilter)
    }
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase()
      result = result.filter(item => {
        const title = String(item.title || '').toLowerCase()
        const summary = String(getSummary(item)).toLowerCase()
        const files = (item.files || []).map(f => String(f.path || '').toLowerCase()).join(' ')
        return title.includes(q) || summary.includes(q) || files.includes(q)
      })
    }
    return result.reverse()
  }

  function renderDrawer() {
    if (!ensureDom() || !state.drawerList) return
    const allItems = normalizeItems(state.items)
    const countEl = state.drawer?.querySelector('#aiMemoDrawerCount')
    if (countEl) countEl.textContent = String(allItems.length)
    const filtered = filterItems(allItems)
    if (!filtered.length) {
      state.drawerList.innerHTML = `
        <div class="ai-memo-drawer-empty">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <span>${state.searchQuery || state.activeFilter !== 'all' ? '未找到匹配的备忘录里程碑' : '暂无 AI 操作备忘录记录'}</span>
        </div>
      `
      return
    }

    state.drawerList.innerHTML = ''
    state.drawerList.innerHTML = ''
    filtered.forEach(item => {
      const category = getCategory(item)
      const categoryLabel = getCategoryLabel(category)
      const relativeTime = formatRelativeTime(item.savedAt || item.createdAt)
      const summary = getSummary(item)
      const files = Array.isArray(item.files) ? item.files : []
      const isExpanded = state.expandedFiles.has(item.id)

      const card = document.createElement('div')
      card.className = 'ai-memo-drawer-card'
      card.id = `memo-card-${item.id}`
      card.dataset.memoId = item.id
      if (item.id === state.selectedId) card.classList.add('is-active')
      if (item.id === state.viewportActiveId) card.classList.add('is-viewport-active')

      const stats = item.stats || {}
      const modified = Number(stats.modified || 0)
      const created = Number(stats.created || 0)
      const deleted = Number(stats.deleted || 0)
      let statsHtml = ''
      if (modified || created || deleted) {
        statsHtml = `
          <div class="ai-memo-card-stats">
            <div class="ai-memo-card-stats-text">
              ${created ? `<span class="ai-memo-stat-add">+${created} 增</span>` : ''}
              ${modified ? `<span>${modified} 改</span>` : ''}
              ${deleted ? `<span class="ai-memo-stat-del">-${deleted} 删</span>` : ''}
            </div>
            ${files.length ? `<button type="button" class="ai-memo-card-files-toggle" data-action="toggle-files">${isExpanded ? '收起文件' : `查看 ${files.length} 个文件`}</button>` : ''}
          </div>
        `
      }      let filesHtml = ''
      if (files.length) {
        filesHtml = `
          <div class="ai-memo-card-file-list ${isExpanded ? 'show' : ''}">
            ${files.map(f => `
              <div class="ai-memo-card-file-item" data-action="open-diff" data-path="${escapeHtml(f.path)}" title="点击查看 ${escapeHtml(f.path)} 的修改对比">
                <span class="ai-memo-card-file-path">${escapeHtml(f.path)}</span>
                <span style="font-size: 10px; opacity: 0.7;">+${f.additions || 0} / -${f.deletions || 0}</span>
              </div>            `).join('')}
          </div>
        `
      }

      card.innerHTML = `
        <div class="ai-memo-card-top">
          <div class="ai-memo-card-title-row">
            <span class="ai-memo-card-dot dot-${category}" title="${categoryLabel}"></span>
            <span class="ai-memo-card-title" title="${escapeHtml(item.title || 'AI 操作备忘录')}">${escapeHtml(item.title || 'AI 操作备忘录')}</span>
          </div>
          <span class="ai-memo-card-time" title="${formatDate(item.savedAt || item.createdAt)}">${relativeTime}</span>
        </div>
        ${summary ? `<div class="ai-memo-card-summary">${escapeHtml(summary)}</div>` : ''}
        ${statsHtml}
        ${filesHtml}
        <div class="ai-memo-card-actions">
          <button type="button" class="ai-memo-action-btn primary" data-action="jump-to-chat" title="定位到产生该备忘录的对话">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            定位对话
          </button>
          <button type="button" class="ai-memo-action-btn" data-action="view-diff" title="查看完整代码改动差异">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5M4 20L21 3m0 13v5h-5M4 4l5 5"/></svg>
            改动Diff
          </button>
          <button type="button" class="ai-memo-action-btn" data-action="open-detail" title="查看备忘录完整内容">
            详情
          </button>
          ${item.changeSessionId ? `
            <button type="button" class="ai-memo-action-btn danger" data-action="rollback" title="仅回退本次改动">
              回退
            </button>
          ` : ''}
        </div>
      `

      card.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]')
        if (!btn) return
        const action = btn.dataset.action

        if (action === 'toggle-files') {
          if (state.expandedFiles.has(item.id)) {
            state.expandedFiles.delete(item.id)
          } else {
            state.expandedFiles.add(item.id)
          }
          renderDrawer()
        } else if (action === 'open-diff') {
          const path = btn.dataset.path || files[0]?.path || ''
          openItemDiff(item, path)
        } else if (action === 'jump-to-chat') {
          jumpToChatSession(item)
        } else if (action === 'view-diff') {
          openItemDiff(item, files[0]?.path || '')
        } else if (action === 'open-detail') {
          openMemo(item.id)
        } else if (action === 'rollback') {
          rollbackItem(item)
        }
      })

      state.drawerList.appendChild(card)
    })
  }

  function highlightDrawerCard(memoId) {
    if (!state.drawerOpen || !state.drawerList) return
    const card = state.drawerList.querySelector(`#memo-card-${memoId}`)
    if (card) {
      state.drawerList.querySelectorAll('.ai-memo-drawer-card').forEach(c => c.classList.remove('is-active'))
      card.classList.add('is-active')
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }

  function mapDiffFile(file = {}) {
    return {
      path: file.path || '',
      action: file.action || 'modify',
      added: Number(file.added || file.additions || 0),
      removed: Number(file.removed || file.deletions || 0),
      beforeText: file.beforeText || '',
      afterText: file.afterText || '',
      language: file.language || '',
      previewMode: file.previewMode || ''
    }
  }

  function decodeAttr(value = '') {
    const text = String(value || '')
    if (!text) return ''
    try {
      return decodeURIComponent(text)
    } catch {
      return text
    }
  }

  function highlightMemoTarget(targetEl, item = {}) {
    if (!targetEl) return
    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
    targetEl.classList.remove('ai-memo-target-highlight')
    void targetEl.offsetWidth
    targetEl.classList.add('ai-memo-target-highlight')
    setTimeout(() => targetEl.classList.remove('ai-memo-target-highlight'), 2000)
    window.showToast?.(`已定位到对话：${item.title || '备忘录'}`, 'info')
  }

  async function openItemDiff(item = {}, targetPath = '') {
    const project = getActiveProject()
    const sessionId = String(item.changeSessionId || '').trim()
    const memoFiles = Array.isArray(item.files) ? item.files : []
    let files = []

    if (project?.id && sessionId && window.api?.getChangeSession) {
      try {
        const result = await window.api.getChangeSession(project.id, sessionId)
        if (result?.success && result.session) {
          files = Array.isArray(result.session.files) ? result.session.files.map(mapDiffFile) : []
        }
      } catch (error) {
        console.warn('[AiMemoChatRail] getChangeSession failed:', error)
      }
    }

    if (!files.length) {
      files = memoFiles.map(mapDiffFile)
    }

    const openTab = window.windowTabsFeature?.createChangeDiffTab || window.WindowTabs?.createChangeDiffTab
    if (typeof openTab !== 'function') {
      window.showToast?.('差异面板暂不可用', 'error')
      return
    }

    const selectedPath = targetPath || files[0]?.path || ''
    openTab({
      title: item.title || 'AI 本轮改动',
      sessionId,
      files,
      summary: {
        added: files.reduce((sum, file) => sum + (Number(file.added) || 0), 0),
        removed: files.reduce((sum, file) => sum + (Number(file.removed) || 0), 0),
        fileCount: files.length
      },
      selectedPath,
      selectedIndex: Math.max(0, files.findIndex(file => file.path === selectedPath))
    })
  }

  async function rollbackItem(item = {}) {
    const project = getActiveProject()
    const sessionId = item.changeSessionId
    if (!project?.id || !sessionId || !window.api?.rollbackChangeSession) {
      window.showToast?.('当前记录不支持回退或回退接口不可用', 'error')
      return
    }

    const confirmed = await window.LingxiDialog.show({
      tone: 'danger',
      title: '回退本次改动',
      message: `确认要回退本次改动吗？\n\n【${item.title || 'AI 操作备忘录'}】\n这会反向撤销本次操作记录的所有文件修改。`,
      confirmText: '确认回退'
    })
    if (!confirmed) return

    window.showToast?.('正在执行安全回退...', 'info')
    try {
      const result = await window.api.rollbackChangeSession(project.id, sessionId, false)
      if (!result?.success) {
        window.showToast?.(result?.error || '回退失败', 'error')
        return
      }
      const count = result.rolledBack?.length || 0
      window.showToast?.(`已成功回退 ${count} 个文件`, 'success')
      refresh()
    } catch (err) {
      window.showToast?.(err?.message || '回退出现异常', 'error')
    }
  }

  async function jumpToChatSession(item = {}) {
    const chatMessages = document.getElementById('chatMessages')
    if (!chatMessages) return

    const sessionId = String(item.changeSessionId || '').trim()
    const requestId = String(item.requestId || item.runId || '').trim()

    const findInDom = () => {
      const nodes = Array.from(chatMessages.querySelectorAll('[data-session-id], [data-request-id], [data-round-id]'))
      return nodes.find(el => {
        const sid = decodeAttr(el.dataset.sessionId || el.getAttribute('data-session-id') || '')
        const rid = decodeAttr(
          el.dataset.requestId ||
          el.getAttribute('data-request-id') ||
          el.dataset.roundId ||
          el.getAttribute('data-round-id') ||
          ''
        )
        return (sessionId && sid === sessionId) || (requestId && rid === requestId)
      }) || null
    }

    const targetEl = findInDom()
    if (targetEl) {
      highlightMemoTarget(targetEl, item)
      return
    }

    const project = getActiveProject()
    const history = Array.isArray(project?.messagesHistory) ? project.messagesHistory : []
    const historyIndex = history.findIndex(message => {
      const session = message?.changeSession || {}
      const sid = String(session.id || session.sessionId || message?.operationSnapshot?.sessionId || '')
      const rid = String(message?._lingxiTurnId || message?._lingxiRunId || message?.requestId || '')
      return (sessionId && sid === sessionId) || (requestId && rid === requestId)
    })
    if (historyIndex >= 0 && typeof window.jumpToTurnByUserIndex === 'function') {
      window.jumpToTurnByUserIndex(0, historyIndex)
      window.setTimeout(() => {
        const el = findInDom()
        if (el) highlightMemoTarget(el, item)
      }, 80)
      return
    }

    if (project?.id && window.api?.locateChatHistoryTurn) {
      try {
        const located = await window.api.locateChatHistoryTurn(project.id, {
          changeSessionId: sessionId,
          requestId,
          runId: item.runId || ''
        })
        if (located?.success && located.entry && typeof window.jumpToChatHistoryEntry === 'function') {
          await window.jumpToChatHistoryEntry(located.entry)
          window.setTimeout(() => {
            const el = findInDom()
            if (el) highlightMemoTarget(el, item)
          }, 120)
          return
        }
      } catch (error) {
        console.warn('[AiMemoChatRail] locateChatHistoryTurn failed:', error)
      }
    }

    window.showToast?.('找不到对应的对话轮次。这条备忘录可能不在当前会话，或对话已被删除。', 'info')
  }

  function bindChatScrollListener() {
    const chatMessages = document.getElementById('chatMessages')
    if (!chatMessages || state.chatScrollBound) return
    state.chatScrollBound = true

    let scrollRaf = 0
    chatMessages.addEventListener('scroll', () => {
      if (scrollRaf) return
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0
        syncViewportMemo(chatMessages)
      })
    }, { passive: true })
  }

  function syncViewportMemo(container) {
    if (!state.items.length) return
    const containerRect = container.getBoundingClientRect()
    const centerY = containerRect.top + containerRect.height / 3

    const summaries = Array.from(container.querySelectorAll('[data-session-id], .ai-summary, .message.assistant'))
    let closestSessionId = ''
    let minDistance = Infinity

    summaries.forEach(el => {
      const rect = el.getBoundingClientRect()
      const dist = Math.abs((rect.top + rect.height / 2) - centerY)
      if (dist < minDistance) {
        minDistance = dist
        closestSessionId = el.dataset.sessionId || el.closest('[data-session-id]')?.dataset.sessionId || ''
      }
    })

    if (closestSessionId) {
      const matchedIdx = state.items.findIndex(it => it.changeSessionId === closestSessionId)
      if (matchedIdx >= 0) {
        const matched = state.items[matchedIdx]
        state.viewportActiveId = matched.id
        state.tape?.querySelectorAll('.ai-memo-chat-tick').forEach(tick => {
          tick.classList.toggle('is-viewport-active', tick.dataset.memoId === matched.id)
        })
        state.drawerList?.querySelectorAll('.ai-memo-drawer-card').forEach(card => {
          card.classList.toggle('is-viewport-active', card.dataset.memoId === matched.id)
        })
      }
    }
  }

  function showTooltip(node, item = {}) {
    if (!state.tooltip) return
    const category = getCategory(item)
    const summary = getSummary(item)
    const time = formatRelativeTime(item.savedAt || item.createdAt)

    state.tooltip.innerHTML = `
      <div style="display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 2px;">
        <span style="display: inline-block; width: 6px; height: 6px; border-radius: 99px; background: ${getCategoryColor(category)};"></span>
        <span>${escapeHtml(item.title || 'AI 操作备忘录')}</span>
        <span style="font-size: 10px; color: var(--text-muted); margin-left: auto;">${time}</span>
      </div>
      ${summary ? `<div style="font-size: 11px; color: var(--text-secondary); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(summary)}</div>` : ''}
      <div style="font-size: 10.5px; color: var(--accent-light, #60a5fa); margin-top: 4px;">点击展开时间树抽屉</div>
    `
    state.tooltip.classList.add('show')
    const rect = node.getBoundingClientRect()
    state.tooltip.style.left = `${rect.right + 8}px`
    state.tooltip.style.top = `${rect.top + rect.height / 2}px`
  }

  function hideTooltip() {
    if (!state.tooltip) return
    state.tooltip.classList.remove('show')
  }

  function setModalLoading(item = {}) {
    if (!state.modal) return
    state.modal.querySelector('#aiMemoChatModalTitle').textContent = item.title || 'AI 操作备忘录'
    state.modal.querySelector('#aiMemoChatModalMeta').textContent = formatDate(item.savedAt || item.createdAt)
    state.modal.querySelector('#aiMemoChatModalSummary').textContent = getSummary(item)
    state.modal.querySelector('#aiMemoChatModalContent').textContent = '正在读取备忘录内容...'
  }

  function openModal(item = {}, content = '') {
    if (!ensureDom()) return
    state.selectedId = item.id || ''
    state.modal.querySelector('#aiMemoChatModalTitle').textContent = item.title || 'AI 操作备忘录'
    state.modal.querySelector('#aiMemoChatModalMeta').textContent = formatDate(item.savedAt || item.createdAt)
    state.modal.querySelector('#aiMemoChatModalSummary').textContent = getSummary(item)
    state.modal.querySelector('#aiMemoChatModalContent').textContent = content || '这条备忘录没有可显示的内容。'
    state.modal.classList.remove('hidden')
    state.modal.setAttribute('aria-hidden', 'false')
    renderRail()
    renderDrawer()
  }

  function closeModal() {
    if (!state.modal) return
    state.modal.classList.add('hidden')
    state.modal.setAttribute('aria-hidden', 'true')
    state.selectedId = ''
    renderRail()
    renderDrawer()
  }

  async function openMemo(memoId = '') {
    const projectPath = getActiveProjectPath()
    const item = state.items.find(entry => entry.id === memoId) || {}
    if (!projectPath || !memoId) return
    hideTooltip()
    if (!ensureDom()) return
    state.selectedId = memoId
    state.modal.classList.remove('hidden')
    state.modal.setAttribute('aria-hidden', 'false')
    setModalLoading(item)
    renderRail()
    renderDrawer()

    try {
      const result = await window.api?.readAiOperationMemo?.(projectPath, memoId)
      if (!result?.success) {
        if (result?.error === '备忘录文件不存在') {
          state.items = state.items.filter(entry => entry.id !== memoId)
          renderRail()
          renderDrawer()
          scheduleRefresh(0)
        }
        state.modal.querySelector('#aiMemoChatModalContent').textContent = result?.error || '备忘录读取失败。'
        return
      }
      openModal(result.item || item, result.content || '')
    } catch (error) {
      state.modal.querySelector('#aiMemoChatModalContent').textContent = error?.message || '备忘录读取失败。'
    }
  }

  async function refresh() {
    if (state.loading) return
    if (!isVisibleEnabled()) {
      removeRail()
      return
    }
    const projectPath = getActiveProjectPath()
    if (!ensureDom()) return
    if (!projectPath || !window.api?.listAiOperationMemoTimeline) {
      state.items = []
      renderRail()
      renderDrawer()
      return
    }

    state.loading = true
    try {
      const result = await window.api.listAiOperationMemoTimeline(projectPath)
      state.items = result?.success ? normalizeItems(result.items || []) : []
    } catch (error) {
      state.items = []
      console.warn('[AiMemoChatRail] load failed:', error)
    } finally {
      state.loading = false
      renderRail()
      renderDrawer()
    }
  }

  function scheduleRefresh(delay = 120) {
    if (!isVisibleEnabled()) {
      removeRail()
      return
    }
    window.clearTimeout(state.refreshTimer)
    state.refreshTimer = window.setTimeout(refresh, delay)
  }

  function bindEvents() {
    if (state.eventsBound) return
    state.eventsBound = true
    window.addEventListener('lingxi:active-project-changed', () => scheduleRefresh(80))
    window.addEventListener('focus', () => scheduleRefresh(200))
  }

  function init() {
    if (!isVisibleEnabled()) return
    if (!ensureDom()) return
    bindEvents()
    scheduleRefresh(200)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true })
  } else {
    init()
  }

  window.AiMemoChatRail = {
    refresh,
    openMemo,
    closeModal,
    toggleDrawer,
    isVisible: isVisibleEnabled,
    setVisible: enabled => {
      try {
        localStorage.setItem(VISIBILITY_KEY, enabled ? 'true' : 'false')
      } catch {}
      if (enabled) {
        if (!ensureDom()) return
        bindEvents()
        scheduleRefresh(0)
      } else {
        removeRail()
      }
    }
  }
})()
