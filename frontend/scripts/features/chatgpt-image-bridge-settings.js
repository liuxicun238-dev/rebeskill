(function () {
  const BRIDGE_PROVIDER = 'chatgpt-web-bridge'

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
      elements.state.textContent = `${status.activeJobType === 'chat' ? '网页聊天中' : '生图中'}${status.queueDepth > 1 ? ` · 排队 ${status.queueDepth}` : ''}`
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

  function readPagePrefs() {
    return window.WebBridgePagePrefUi?.read(document.getElementById('chatgptWebBridgePagePrefs')) || {
      pageModel: 'gpt-5.6',
      thinkingEnabled: true,
      thinkingLevel: 'high'
    }
  }

  function applyPagePrefsToControls(prefs = {}) {
    const root = document.getElementById('chatgptWebBridgePagePrefs')
    if (prefs?.pageModel) window.WebBridgePagePrefUi?.write(root, prefs, true)
    else window.WebBridgePagePrefUi?.sync(root)
  }

  async function persistPagePrefs() {
    if (!window.api?.setChatGptWebBridgePagePrefs) return
    return window.api.setChatGptWebBridgePagePrefs(readPagePrefs())
  }

  async function migrateExistingChatModel(attempt = 0) {
    const store = window.ModelStore
    if (!store) {
      if (attempt < 20) setTimeout(() => migrateExistingChatModel(attempt + 1), 500)
      return
    }
    const models = store.getModels()
    const index = findExistingBridgeModel(models, 'chatgpt-web-chat')
    if (index < 0) return
    const current = models[index]
    if (current?.capabilities?.toolCalling === true && current?.capabilities?.vision === true) return
    store.updateModel(index, {
      ...current,
      capabilities: {
        ...(current.capabilities || {}),
        text: true,
        toolCalling: true,
        vision: true
      }
    })
    await store.save()
    window.dispatchEvent(new CustomEvent('lingxi:model-config-changed', {
      detail: { provider: BRIDGE_PROVIDER, action: 'capability-migrated' }
    }))
  }

  async function addOrUpdateModel(elements, kind = 'image') {
    const getSuggestedModel = kind === 'chat'
      ? window.api?.getChatGptWebBridgeSuggestedChatModel
      : window.api?.getChatGptImageBridgeSuggestedModel
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
    const label = kind === 'chat' ? 'ChatGPT 网页版聊天模型' : 'ChatGPT Pro 本地生图模型'
    return existingIndex >= 0 ? `已更新${label}。` : `已添加${label}，并保留当前模型不变。`
  }

  function bind() {
    const elements = {
      state: document.getElementById('chatgptImageBridgeState'),
      url: document.getElementById('chatgptImageBridgeUrl'),
      message: document.getElementById('chatgptImageBridgeMessage'),
      login: document.getElementById('chatgptImageBridgeLoginBtn'),
      check: document.getElementById('chatgptImageBridgeCheckBtn'),
      add: document.getElementById('chatgptImageBridgeAddBtn'),
      addChat: document.getElementById('chatgptWebBridgeAddChatBtn'),
      prefs: document.getElementById('chatgptWebBridgePagePrefs')
    }
    if (!elements.state) return
    migrateExistingChatModel().catch(() => {})

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
        const result = await window.api.openChatGptImageBridgeLogin()
        renderStatus(elements, result)
        setMessage(elements.message, `${result?.browserName || '普通浏览器'} 已以普通模式打开。请完成登录，关闭整个专用浏览器窗口，再点击第 2 步。`)
        return result
      }, '正在启动没有自动化参数的普通 Chrome/Edge……').catch(() => {})
    })

    elements.check?.addEventListener('click', () => {
      runAction(elements.check, async () => {
        const result = await window.api.checkChatGptImageBridgeLogin()
        renderStatus(elements, result)
        setMessage(elements.message, result?.loggedIn
          ? '登录有效，网页聊天和生图已就绪。'
          : (result?.instruction || '尚未检测到登录。请重新执行第 1 步。'), result?.loggedIn ? 'success' : 'warning')
        return result
      }, '正在检查 ChatGPT 登录状态……').catch(() => {})
    })

    elements.add?.addEventListener('click', () => {
      runAction(elements.add, async () => {
        const message = await addOrUpdateModel(elements, 'image')
        setMessage(elements.message, message, 'success')
        return null
      }, '正在写入生图模型配置……').catch(() => {})
    })

    elements.addChat?.addEventListener('click', () => {
      runAction(elements.addChat, async () => {
        const result = await persistPagePrefs()
        if (result?.status) renderStatus(elements, result.status)
        const message = await addOrUpdateModel(elements, 'chat')
        setMessage(elements.message, message, 'success')
        return null
      }, '正在写入网页版聊天模型配置……').catch(() => {})
    })

    window.WebBridgePagePrefUi?.bind(elements.prefs)
    elements.prefs?.addEventListener('web-bridge-page-prefs-change', () => {
      persistPagePrefs().then(result => {
        if (result?.status) renderStatus(elements, result.status)
      }).catch(() => {})
    })

    window.api?.getChatGptImageBridgeStatus?.().then(status => {
      renderStatus(elements, status)
      applyPagePrefsToControls(status?.pagePrefs || {})
      if (status?.lastError) setMessage(elements.message, status.lastError, 'error')
    }).catch(error => {
      renderStatus(elements, { running: false })
      setMessage(elements.message, error?.message || '本地生图网关启动失败。', 'error')
    })

    setInterval(() => {
      if (document.visibilityState !== 'visible') return
      window.api?.getChatGptImageBridgeStatus?.().then(status => renderStatus(elements, status)).catch(() => {})
    }, 5000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true })
  else bind()
})()
