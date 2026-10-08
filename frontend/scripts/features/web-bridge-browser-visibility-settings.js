(function () {
  function bind() {
    const toggle = document.getElementById('webBridgeBrowserVisibleToggle')
    if (!toggle || !window.api?.getWebBridgeBrowserVisible) return

    window.api.getWebBridgeBrowserVisible().then(result => {
      toggle.checked = result?.visible === true
    }).catch(() => {
      toggle.checked = false
    })

    toggle.addEventListener('change', () => {
      const visible = toggle.checked
      window.api.setWebBridgeBrowserVisible(visible).then(result => {
        toggle.checked = result?.visible === true
      }).catch(() => {
        toggle.checked = !visible
      })
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true })
  else bind()
})()
