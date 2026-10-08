(function () {
  const containerId = 'settingsContentWebBridge'

  function initWebBridgeUiEnhancements() {
    const container = document.getElementById(containerId)
    if (!container || container.dataset.uiEnhanced === 'true') return
    container.dataset.uiEnhanced = 'true'

    const chips = container.querySelectorAll('.web-bridge-category-chip')
    const cards = container.querySelectorAll('[data-bridge-card="true"]')
    const checkAllBtn = document.getElementById('webBridgeCheckAllBtn')

    // Tab filtering
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        const filter = chip.getAttribute('data-bridge-filter') || 'all'
        chips.forEach(c => c.classList.remove('is-active'))
        chip.classList.add('is-active')

        cards.forEach(card => {
          const category = card.getAttribute('data-bridge-category') || ''
          const categories = category.split(/\s+/).filter(Boolean)
          if (filter === 'all' || categories.includes(filter)) {
            card.removeAttribute('data-bridge-hidden')
          } else {
            card.setAttribute('data-bridge-hidden', 'true')
          }
        })
      })
    })

    // "Check all bridges" button
    if (checkAllBtn) {
      checkAllBtn.addEventListener('click', () => {
        const checkButtons = [
          'chatgptImageBridgeCheckBtn',
          'deepseekWebBridgeCheckBtn',
          'grokWebBridgeCheckBtn',
          'claudeWebBridgeCheckBtn',
          'arenaWebBridgeCheckBtn',
          'qwenWebBridgeCheckBtn',
          'geminiWebBridgeCheckBtn',
          'gensparkWebBridgeCheckBtn',
          'geminiSparkWebBridgeCheckBtn',
          'minimaxMusicBridgeCheckBtn'
        ]

        let count = 0
        checkButtons.forEach(id => {
          const btn = document.getElementById(id)
          if (btn && typeof btn.click === 'function') {
            btn.click()
            count++
          }
        })

        const originalText = checkAllBtn.textContent
        checkAllBtn.textContent = `已触发 ${count} 个桥接状态检查...`
        checkAllBtn.disabled = true
        setTimeout(() => {
          checkAllBtn.textContent = originalText
          checkAllBtn.disabled = false
        }, 2200)
      })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWebBridgeUiEnhancements)
  } else {
    initWebBridgeUiEnhancements()
  }

  // Also hook into modal/tab switches if dynamic
  document.addEventListener('settingsTabChanged', (e) => {
    if (e.detail?.tab === 'webBridge') {
      initWebBridgeUiEnhancements()
    }
  })
})()
