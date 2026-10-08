(function () {
  function normalizeStatus(statusOrRatio, estimatedTokens = 0) {
    if (typeof statusOrRatio === 'object') {
      return {
        ratio: statusOrRatio.contextRatio || 0,
        tokens: statusOrRatio.estimatedTokens || 0,
        error: statusOrRatio.error || ''
      }
    }
    return { ratio: statusOrRatio || 0, tokens: estimatedTokens || 0, error: '' }
  }

  function setRiskClass(element, ratio) {
    element.classList.remove('warning', 'full')
    if (ratio >= 0.9) {
      element.classList.add('full')
    } else if (ratio >= 0.7) {
      element.classList.add('warning')
    }
  }

  function updatePanel(elements, status) {
    if (!status) return
    if (status.error) {
      if (elements.tokenValue) elements.tokenValue.textContent = (window.i18n?.t?.('auto.js_context_ui_53_0') ?? ((window.i18n?.t?.('auto.js_context_ui_53_1') ?? '读取失败')))
      if (elements.tokenFill) {
        elements.tokenFill.style.width = '100%'
        elements.tokenFill.classList.remove('normal', 'warning')
        elements.tokenFill.classList.add('full')
      }
      if (elements.strategy) elements.strategy.textContent = `上下文状态读取失败：${status.error}`
      return
    }

    const ratio = status.contextRatio || 0
    const tokens = status.estimatedTokens || 0
    const limit = status.modelLimit || 128000
    const formatNum = n => n >= 100000 ? `${Math.round(n / 1000)}K` : Math.round(n)

    if (elements.tokenValue) {
      elements.tokenValue.textContent = `${formatNum(tokens)} / ${formatNum(limit)}`
    }

    if (elements.tokenFill) {
      const percent = Math.round(ratio * 100)
      elements.tokenFill.style.width = `${percent}%`
      setRiskClass(elements.tokenFill, ratio)
    }

    if (elements.turnCount) elements.turnCount.textContent = status.tapeLength || 0
    if (elements.summaryCount) elements.summaryCount.textContent = status.summaryCount || 0
    if (elements.indexSize) elements.indexSize.textContent = status.indexSize || 0

    if (elements.strategy) {
      const strategies = [((window.i18n?.t?.('auto.js_context_ui_83_2') ?? '工具结果压缩'))]
      if (status.summaryCount > 0) strategies.push(((window.i18n?.t?.('auto.js_context_ui_84_3') ?? '摘要缓存')))
      if (status.tapeLength > 20) strategies.push(((window.i18n?.t?.('auto.js_context_ui_85_4') ?? '滑动窗口')))
      elements.strategy.textContent = strategies.join(' + ')
    }
  }

  function updateSidebar(ratio, estimatedTokens = 0) {
    // 侧边栏旧版圆环已由底部 #contextMemoryStack 统一接管，保持空实现避免历史调用报错
  }

  function bindPanel(elements, handlers = {}) {
    const { indicator, panel, closeButton, summaryButton, clearButton } = elements

    if (indicator) {
      indicator.onclick = async () => {
        if (!panel) return
        await handlers.onOpen?.()
        panel.classList.toggle('show')
      }
    }

    if (closeButton) {
      closeButton.onclick = () => hidePanel(panel)
    }

    if (summaryButton) {
      summaryButton.onclick = async () => {
        await handlers.onSummary?.()
        hidePanel(panel)
      }
    }

    if (clearButton) {
      clearButton.onclick = async () => {
        const shouldClose = await handlers.onClear?.()
        if (shouldClose !== false) hidePanel(panel)
      }
    }
  }

  function hidePanel(panel) {
    if (panel) panel.classList.remove('show')
  }

  window.ContextUI = {
    updatePanel,
    updateSidebar,
    bindPanel,
    hidePanel
  }
})()
