(function () {
  const LABELS = {
    chatgpt: 'ChatGPT web.run',
    lxweb: '灵犀内置搜索',
    grok: 'Grok 网页版',
    deepseek: 'DeepSeek 网页版',
    qwen: '通义网页版',
    gemini: 'Gemini 网页版',
    claude: 'Claude 网页版',
    arena: 'Arena 网页版'
  }
  const DEFAULT_ORDER = ['chatgpt', 'lxweb', 'grok', 'deepseek', 'qwen', 'gemini', 'claude', 'arena']

  function normalizeOrder(list) {
    const seen = new Set()
    const next = []
    for (const item of Array.isArray(list) ? list : []) {
      const id = String(item || '').trim()
      if (!LABELS[id] || seen.has(id)) continue
      seen.add(id)
      next.push(id)
    }
    if (!seen.has('lxweb')) {
      const chatgptIndex = next.indexOf('chatgpt')
      if (chatgptIndex >= 0) next.splice(chatgptIndex + 1, 0, 'lxweb')
      else next.unshift('lxweb')
      seen.add('lxweb')
    }
    for (const id of DEFAULT_ORDER) {
      if (seen.has(id)) continue
      next.push(id)
    }
    return next
  }

  const CHEVRON_UP = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>'
  const CHEVRON_DOWN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>'

  function bind() {
    const toggle = document.getElementById('webBridgePageSearchToggle')
    const list = document.getElementById('webBridgeSearchOrderList')
    if (!toggle || !list || !window.api?.getWebBridgeSearchSettings) return

    let order = normalizeOrder(DEFAULT_ORDER)
    let enabled = true
    let draggedId = ''
    let persistSeq = 0
    let ready = false

    function applyEnabledUi() {
      list.classList.toggle('is-disabled', !enabled)
      list.setAttribute('aria-disabled', enabled ? 'false' : 'true')
    }

    function persist() {
      if (!ready) return Promise.resolve()
      const seq = ++persistSeq
      return window.api.setWebBridgeSearchSettings({
        pageSearchEnabled: enabled,
        searchProviderOrder: order
      }).then(result => {
        if (seq !== persistSeq) return
        enabled = result?.pageSearchEnabled !== false
        if (Array.isArray(result?.searchProviderOrder) && result.searchProviderOrder.length) {
          order = normalizeOrder(result.searchProviderOrder)
        }
        toggle.checked = enabled
        render()
      }).catch(() => {
        if (seq !== persistSeq) return
        toggle.checked = enabled
        render()
      })
    }

    function moveItem(id, toIndex) {
      const from = order.indexOf(id)
      if (from < 0) return
      const next = Math.max(0, Math.min(order.length - 1, toIndex))
      if (next === from) return
      const copy = order.slice()
      copy.splice(from, 1)
      copy.splice(next, 0, id)
      order = copy
      persist()
    }

    function render() {
      applyEnabledUi()
      toggle.checked = enabled
      list.innerHTML = order.map((id, index) => `
        <li class="web-bridge-search-order-item${index === 0 ? ' is-primary' : ''}" draggable="true" data-id="${id}">
          <span class="web-bridge-search-order-index">${index + 1}</span>
          <span class="web-bridge-search-order-label">${LABELS[id] || id}${index === 0 ? '<span class="web-bridge-search-order-badge">优先</span>' : ''}</span>
          <span class="web-bridge-search-order-actions">
            <button type="button" class="web-bridge-search-order-btn" data-move="up" data-id="${id}" ${index === 0 ? 'disabled' : ''} aria-label="上移">${CHEVRON_UP}</button>
            <button type="button" class="web-bridge-search-order-btn" data-move="down" data-id="${id}" ${index === order.length - 1 ? 'disabled' : ''} aria-label="下移">${CHEVRON_DOWN}</button>
          </span>
        </li>
      `).join('')

      list.querySelectorAll('.web-bridge-search-order-item').forEach(item => {
        item.addEventListener('dragstart', event => {
          draggedId = item.dataset.id || ''
          item.classList.add('dragging')
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
        })
        item.addEventListener('dragend', () => {
          draggedId = ''
          item.classList.remove('dragging')
          list.querySelectorAll('.web-bridge-search-order-item').forEach(node => node.classList.remove('drag-over'))
        })
        item.addEventListener('dragover', event => {
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          if (item.dataset.id !== draggedId) item.classList.add('drag-over')
        })
        item.addEventListener('dragleave', () => {
          item.classList.remove('drag-over')
        })
        item.addEventListener('drop', event => {
          event.preventDefault()
          item.classList.remove('drag-over')
          const targetId = item.dataset.id
          if (!draggedId || !targetId || draggedId === targetId) return
          moveItem(draggedId, order.indexOf(targetId))
        })
      })

      list.querySelectorAll('[data-move]').forEach(button => {
        button.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          const id = button.getAttribute('data-id')
          const from = order.indexOf(id)
          if (from < 0) return
          moveItem(id, button.getAttribute('data-move') === 'up' ? from - 1 : from + 1)
        })
      })
    }

    toggle.addEventListener('change', () => {
      enabled = toggle.checked
      persist()
    })

    window.api.getWebBridgeSearchSettings().then(result => {
      enabled = result?.pageSearchEnabled !== false
      if (Array.isArray(result?.searchProviderOrder) && result.searchProviderOrder.length) {
        order = normalizeOrder(result.searchProviderOrder)
      }
      ready = true
      render()
    }).catch(() => {
      enabled = true
      ready = true
      render()
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true })
  else bind()
})()
