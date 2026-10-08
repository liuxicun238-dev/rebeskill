/* 个性化 → 窗口尺寸：默认 1295×918，宽屏 1280×800（图一横向比例） */
(function () {
  function setActive(preset) {
    document.querySelectorAll('[data-window-size]').forEach(button => {
      button.classList.toggle('active', button.dataset.windowSize === preset)
    })
  }

  function fillCards(presets = []) {
    presets.forEach(item => {
      const button = document.querySelector(`[data-window-size="${item.id}"]`)
      if (!button) return
      const name = button.querySelector('.window-size-card-name')
      const meta = button.querySelector('.window-size-card-meta')
      if (name && item.label) name.textContent = item.label
      if (meta && item.width && item.height) meta.textContent = `${item.width} × ${item.height}`
    })
  }

  function applyConfig(cfg = {}) {
    if (!cfg || cfg.ok === false) return
    fillCards(cfg.presets || [])
    setActive(cfg.preset || 'default')
  }

  function init() {
    const grid = document.getElementById('windowSizeGrid')
    if (!grid) return

    if (window.api?.getWindowSizeConfig) {
      window.api.getWindowSizeConfig().then(applyConfig).catch(() => setActive('default'))
    } else {
      setActive('default')
    }

    grid.querySelectorAll('[data-window-size]').forEach(button => {
      button.addEventListener('click', () => {
        const preset = button.dataset.windowSize
        if (!preset) return
        setActive(preset)
        if (!window.api?.setWindowSizePreset) return
        window.api.setWindowSizePreset(preset).then(result => {
          applyConfig(result)
          if (result?.ok === false && window.showToast) {
            window.showToast(result.error || '调整窗口尺寸失败', 'error')
          }
        }).catch(error => {
          if (window.showToast) window.showToast(error?.message || '调整窗口尺寸失败', 'error')
        })
      })
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
