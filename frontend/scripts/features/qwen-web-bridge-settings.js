(function () {
  const BRIDGE_PROVIDER = 'qwen-web-bridge'

  function setMessage(element, message, kind = '') {
    if (!element) return
    element.textContent = message || ''
    element.className = `chatgpt-image-bridge-message${kind ? ` is-${kind}` : ''}`
  }

  function renderStatus(elements, status = {}) {
    if (elements.url && status.apiUrl) elements.url.textContent = status.apiUrl
    if (!elements.state) return

    elements.state.className = 'chatgpt-image-bridge-state'
    if (!status.running) {
      elements.state.textContent = '未启动'
      elements.state.classList.add('is-error')
    } else if (status.activeJob) {
      elements.state.textContent = `网页聊天中${status.queueDepth > 1 ? ` · 排队 ${status.queueDepth}` : ''}`
      elements.state.classList.add('is-busy')
    } else if (status.loggedIn === true) {
      elements.state.textContent = '已登录'
      elements.state.classList.add('is-ready')
    } else if (status.loggedIn === false) {
      elements.state.textContent = '需要登录'
      elements.state.classList.add('is-warning')
    } else if (status.browserMode === 'login') {
      elements.state.textContent = '等待登录并关闭浏览器'
      elements.state.classList.add('is-warning')
    } else if (status.browserMode === 'automation') {
      elements.state.textContent = '自动化已连接'
      elements.state.classList.add('is-idle')
    } else {
      elements.state.textContent = status.browserOpen
        ? `${status.browserName || '外部浏览器'} 已打开`
        : '服务已启动'
      elements.state.classList.add('is-idle')
    }
  }

  function findExistingBridgeModel(models, modelId) {
    return models.findIndex(model => (
      model?.provider === BRIDGE_PROVIDER && model?.modelId === modelId
    ))
  }

  async function addOrUpdateChatModel(elements) {
    const getSuggestedModel = window.api?.getQwenWebBridgeSuggestedChatModel
    if (!getSuggestedModel || !window.ModelStore) {
      throw new Error('当前界面尚未加载模型配置模块。')
    }
    const result = await getSuggestedModel()
    if (!result?.success || !result.model) throw new Error(result?.error || '无法读取本地网关配置。')

    const store = window.ModelStore
    const models = store.getModels()
    const previousModel = store.getCurrentModel()
    const previousKey = store.getModelKey(previousModel)
    const existingIndex = findExistingBridgeModel(models, result.model.modelId)
    if (existingIndex >= 0) store.updateModel(existingIndex, { ...models[existingIndex], ...result.model })
    else store.addModel(result.model)

    const previousIndex = previousKey ? store.findModelIndexByKey(previousKey) : -1
    if (previousIndex >= 0) store.setCurrentIndex(previousIndex)
    await store.save()
    window.dispatchEvent(new CustomEvent('lingxi:model-config-changed', {
      detail: { provider: BRIDGE_PROVIDER, action: existingIndex >= 0 ? 'updated' : 'added' }
    }))
    renderStatus(elements, result.status || {})
    return existingIndex >= 0 ? '已更新 Qwen 网页版聊天模型。' : '已添加 Qwen 网页版聊天模型，并保留当前模型不变。'
  }

  function bind() {
    const elements = {
      state: document.getElementById('qwenWebBridgeState'),
      url: document.getElementById('qwenWebBridgeUrl'),
      message: document.getElementById('qwenWebBridgeMessage'),
      login: document.getElementById('qwenWebBridgeLoginBtn'),
      check: document.getElementById('qwenWebBridgeCheckBtn'),
      addChat: document.getElementById('qwenWebBridgeAddChatBtn'),
      dumpDom: document.getElementById('qwenWebBridgeDumpDomBtn')
    }
    if (!elements.state) return

    const runAction = async (button, action, pendingText) => {
      if (button) button.disabled = true
      setMessage(elements.message, pendingText)
      try {
        const result = await action()
        if (result?.status) renderStatus(elements, result.status)
        else if (result) renderStatus(elements, result)
        return result
      } catch (error) {
        setMessage(elements.message, error?.message || String(error), 'error')
        throw error
      } finally {
        if (button) button.disabled = false
      }
    }

    elements.login?.addEventListener('click', () => {
      runAction(elements.login, async () => {
        const result = await window.api.openQwenWebBridgeLogin()
        renderStatus(elements, result)
        setMessage(elements.message, `${result?.browserName || '普通浏览器'} 已以普通模式打开。请在 chat.qwen.ai 完成通义千问登录，关闭整个专用浏览器窗口，再点击第 2 步。`)
        return result
      }, '正在启动没有自动化参数的普通 Chrome/Edge……').catch(() => {})
    })

    elements.check?.addEventListener('click', () => {
      runAction(elements.check, async () => {
        const result = await window.api.checkQwenWebBridgeLogin()
        renderStatus(elements, result)
        setMessage(elements.message, result?.loggedIn
          ? '登录有效，网页聊天已就绪。'
          : (result?.instruction || '尚未检测到登录。请重新执行第 1 步。'), result?.loggedIn ? 'success' : 'warning')
        return result
      }, '正在检查 Qwen 登录状态……').catch(() => {})
    })

    elements.dumpDom?.addEventListener('click', () => {
      runAction(elements.dumpDom, async () => {
        const result = await window.api.dumpQwenWebBridgeReplyDom()
        if (!result?.success) throw new Error(result?.error || '抓取失败')
        const json = JSON.stringify(result.dom, null, 2)
        try {
          await navigator.clipboard.writeText(json)
          setMessage(elements.message, '已复制回复 DOM 结构到剪贴板，请粘贴给开发者。', 'success')
        } catch (_) {
          setMessage(elements.message, json.slice(0, 4000), 'success')
        }
        return null
      }, '正在抓取 Qwen 回复 DOM 结构……').catch(() => {})
    })

    elements.addChat?.addEventListener('click', () => {
      runAction(elements.addChat, async () => {
        const message = await addOrUpdateChatModel(elements)
        setMessage(elements.message, message, 'success')
        return null
      }, '正在写入网页版聊天模型配置……').catch(() => {})
    })

    window.api?.getQwenWebBridgeStatus?.().then(status => {
      renderStatus(elements, status)
      if (status?.lastError) setMessage(elements.message, status.lastError, 'error')
    }).catch(error => {
      renderStatus(elements, { running: false })
      setMessage(elements.message, error?.message || '本地 Qwen 网关启动失败。', 'error')
    })

    setInterval(() => {
      if (document.visibilityState !== 'visible') return
      window.api?.getQwenWebBridgeStatus?.().then(status => {
        renderStatus(elements, status)
        if (status?.waitDiagnostics) {
          const d = status.waitDiagnostics
          elements.state.textContent = `等待中 count=${d.count} baseline=${d.baselineCount} textLen=${d.textLen} stable=${d.stableCount}`
          elements.state.classList.add('is-busy')
        }
      }).catch(() => {})
    }, 5000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true })
  else bind()
})()
