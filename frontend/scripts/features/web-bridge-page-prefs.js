(function () {
  let openPicker = null
  let delegated = false

  function liveMenu(picker) {
    return picker?._liveMenu || picker?.querySelector('.web-bridge-picker-menu') || null
  }

  function prefsRootFromNode(node) {
    const menu = node?.closest?.('.web-bridge-picker-menu')
    if (menu?.dataset.prefsId) return document.getElementById(menu.dataset.prefsId)
    return node?.closest?.('.web-bridge-page-prefs') || null
  }

  function optionScope(root) {
    const nodes = []
    if (!root) return nodes
    root.querySelectorAll('.web-bridge-picker-option').forEach(node => nodes.push(node))
    if (root.id) {
      document.querySelectorAll(`.web-bridge-picker-menu.is-portaled[data-prefs-id="${root.id}"] .web-bridge-picker-option`).forEach(node => {
        if (!nodes.includes(node)) nodes.push(node)
      })
    }
    return nodes
  }

  function closePicker(picker) {
    if (!picker) return
    picker.classList.remove('is-open')
    const menu = liveMenu(picker)
    const trigger = picker.querySelector('.web-bridge-picker-trigger')
    if (menu) {
      menu.hidden = true
      menu.classList.remove('is-portaled')
      menu.style.left = ''
      menu.style.top = ''
      menu.style.minWidth = ''
      menu.style.position = ''
      menu.style.zIndex = ''
      delete menu.dataset.prefsId
      if (menu.parentElement !== picker) picker.appendChild(menu)
    }
    picker._liveMenu = null
    if (trigger) trigger.setAttribute('aria-expanded', 'false')
    if (openPicker === picker) openPicker = null
  }

  function closeAll(except) {
    document.querySelectorAll('.web-bridge-picker.is-open').forEach(picker => {
      if (picker !== except) closePicker(picker)
    })
  }

  function placeMenu(trigger, menu) {
    const picker = trigger.closest('.web-bridge-picker')
    const root = trigger.closest('.web-bridge-page-prefs')
    const rect = trigger.getBoundingClientRect()
    const minWidth = Math.max(268, Math.round(rect.width))
    if (menu.parentElement !== document.body) document.body.appendChild(menu)
    if (picker) picker._liveMenu = menu
    if (root?.id) menu.dataset.prefsId = root.id
    menu.classList.add('is-portaled')
    menu.hidden = false
    menu.style.position = 'fixed'
    menu.style.zIndex = '4000'
    menu.style.minWidth = `${minWidth}px`
    menu.style.left = `${Math.max(8, Math.round(rect.left))}px`
    menu.style.top = `${Math.round(rect.bottom + 6)}px`
    const box = menu.getBoundingClientRect()
    if (box.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, Math.round(rect.top - box.height - 6))}px`
    }
    const next = menu.getBoundingClientRect()
    if (next.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, Math.round(window.innerWidth - next.width - 8))}px`
    }
  }

  function optionLabel(option) {
    return String(option.getAttribute('data-label') || option.querySelector('.web-bridge-picker-option-title')?.textContent || option.dataset.value || '').trim()
  }

  function readRoot(root) {
    if (!root) {
      return { pageModel: '', thinkingEnabled: false, thinkingLevel: '' }
    }
    return {
      pageModel: String(root.dataset.pageModel || ''),
      thinkingEnabled: root.dataset.thinkingEnabled === 'true',
      thinkingLevel: String(root.dataset.thinkingLevel || '')
    }
  }

  function syncRoot(root) {
    if (!root) return
    const prefs = readRoot(root)
    optionScope(root).forEach(option => {
      if (option.dataset.toggle === 'thinkingEnabled') {
        option.classList.toggle('is-selected', prefs.thinkingEnabled)
        option.setAttribute('aria-pressed', prefs.thinkingEnabled ? 'true' : 'false')
        return
      }
      if (option.dataset.level) {
        const selected = option.dataset.level === prefs.thinkingLevel
        option.classList.toggle('is-selected', selected)
        option.setAttribute('aria-selected', selected ? 'true' : 'false')
        return
      }
      if (option.dataset.value) {
        const selected = option.dataset.value === prefs.pageModel
        option.classList.toggle('is-selected', selected)
        option.setAttribute('aria-selected', selected ? 'true' : 'false')
      }
    })
    root.querySelectorAll('.web-bridge-picker').forEach(picker => {
      const valueNode = picker.querySelector('[data-role="value"]')
      if (!valueNode) return
      const kind = picker.getAttribute('data-kind')
      const options = optionScope(root)
      if (kind === 'thinking') {
        const selected = options.find(option => option.dataset.level === prefs.thinkingLevel)
        valueNode.textContent = selected ? optionLabel(selected) : (prefs.thinkingLevel || '中')
        return
      }
      const selected = options.find(option => option.dataset.value === prefs.pageModel)
      let label = selected ? optionLabel(selected) : (prefs.pageModel || '选择模型')
      if (kind === 'model' && prefs.thinkingEnabled) {
        const extra = options.find(option => option.dataset.toggle === 'thinkingEnabled')
        const extraLabel = extra ? optionLabel(extra) : ''
        if (extraLabel && !label.includes(extraLabel)) label = `${label} · ${extraLabel}`
      }
      valueNode.textContent = label
    })
  }

  function writeRoot(root, patch = {}, silent = false) {
    const next = { ...readRoot(root), ...patch }
    root.dataset.pageModel = next.pageModel
    root.dataset.thinkingEnabled = next.thinkingEnabled ? 'true' : 'false'
    root.dataset.thinkingLevel = next.thinkingLevel
    syncRoot(root)
    if (!silent) {
      root.dispatchEvent(new CustomEvent('web-bridge-page-prefs-change', {
        bubbles: true,
        detail: next
      }))
    }
  }

  function chooseOption(option) {
    const host = prefsRootFromNode(option)
    if (!host) return
    if (option.dataset.toggle === 'thinkingEnabled') {
      const enabled = !readRoot(host).thinkingEnabled
      const patch = { thinkingEnabled: enabled }
      if (host.dataset.bridge === 'gemini') patch.thinkingLevel = enabled ? 'extended' : 'default'
      writeRoot(host, patch)
      if (openPicker) {
        const trigger = openPicker.querySelector('.web-bridge-picker-trigger')
        const menu = liveMenu(openPicker)
        if (trigger && menu) placeMenu(trigger, menu)
      }
      return
    }
    if (option.dataset.level) {
      writeRoot(host, {
        thinkingEnabled: option.dataset.level !== 'off',
        thinkingLevel: option.dataset.level
      })
      closeAll()
      return
    }
    if (option.dataset.value) {
      writeRoot(host, { pageModel: option.dataset.value })
      closeAll()
    }
  }

  function bindRoot(root) {
    if (!root || root.dataset.pickerBound === '1') return
    root.dataset.pickerBound = '1'
    root.querySelectorAll('.web-bridge-picker-trigger').forEach(trigger => {
      trigger.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        const picker = trigger.closest('.web-bridge-picker')
        const menu = liveMenu(picker)
        if (!picker || !menu) return
        const willOpen = !picker.classList.contains('is-open')
        closeAll()
        if (!willOpen) return
        picker.classList.add('is-open')
        trigger.setAttribute('aria-expanded', 'true')
        placeMenu(trigger, menu)
        openPicker = picker
      })
    })
    syncRoot(root)
  }

  function ensureDelegates() {
    if (delegated) return
    delegated = true
    document.addEventListener('click', event => {
      const option = event.target.closest('.web-bridge-picker-option')
      if (option) {
        event.preventDefault()
        event.stopPropagation()
        chooseOption(option)
        return
      }
      if (!openPicker) return
      const menu = liveMenu(openPicker)
      if (openPicker.contains(event.target) || menu?.contains(event.target)) return
      closeAll()
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeAll()
    })
    window.addEventListener('resize', () => closeAll())
    window.addEventListener('scroll', () => closeAll(), true)
  }

  ensureDelegates()

  window.WebBridgePagePrefUi = {
    bind: bindRoot,
    read: readRoot,
    write: writeRoot,
    sync: syncRoot
  }
})()
