(function () {
  const BRIDGE_PROVIDER = 'gemini-web-bridge'

  function setMessage(element, message, kind = '') {
    if (!element) return
    element.textContent = message || ''
    element.className = `chatgpt-image-bridge-message${kind ? ` is-${kind}` : ''}`
  }

  function renderStatus(elements, status = {}) {
    if (elements.url && status.apiUrl) elements.url.textContent = status.apiUrl
    syncTransportUi(elements, status)
    if (!elements.state) return

    elements.state.className = 'chatgpt-image-bridge-state'
    if (!status.running) {
      elements.state.textContent = '未启动'
      elements.state.classList.add('is-error')
    } else if (status.transportMode === 'direct') {
      elements.state.textContent = '协议直连'
      elements.state.classList.add('is-ready')
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

  function syncTransportUi(elements, status = {}) {
    const direct = status.transportMode === 'direct'
    if (elements.transportToggle) elements.transportToggle.checked = !direct
    elements.card?.classList.toggle('is-direct-transport', direct)
    const modelTrigger = elements.prefs?.querySelector('#geminiWebBridgePageModel .web-bridge-picker-trigger')
    if (modelTrigger) {
      modelTrigger.disabled = false
      modelTrigger.title = direct ? '协议直连会严格请求所选模型；账号不支持时返回明确错误，不会降级。' : ''
    }
    if (elements.dumpDom) {
      elements.dumpDom.disabled = direct
      elements.dumpDom.title = direct ? '协议直连不使用 DOM。' : ''
    }
    if (elements.transportNote) {
      elements.transportNote.textContent = direct
        ? '当前：协议直连。聊天不会打开 Gemini 页面，也不会写入网页会话列表；严格请求上方选择的模型，账号不支持时明确报错，绝不静默降级。扩展思考开启后按任务阶段自适应。'
        : '当前：可见浏览器。模型和扩展思考均按上方选择在 Gemini 页面切换，再从完整回复气泡读取结果。'
    }
  }

  function findExistingBridgeModel(models, modelId) {
    return models.findIndex(model => (
      model?.provider === BRIDGE_PROVIDER
    ))
  }

  function isLegacyDirectModel(model = {}) {
    const modelId = String(model.modelId || model.model || model.modelName || '').toLowerCase()
    const apiUrl = String(model.apiUrl || model.baseUrl || '').toLowerCase()
    return model.provider !== BRIDGE_PROVIDER
      && /gemini-web-chat(?:-thinking)?/.test(modelId)
      && /(?:127\.0\.0\.1|localhost):3310(?:\/|$)/.test(apiUrl)
  }

  function normalizeApiUrl(value = '') {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase()
  }

  function needsUnifiedModelRefresh(model = {}, status = {}) {
    if (model?.provider !== BRIDGE_PROVIDER) return false
    const expectedApiUrl = normalizeApiUrl(status?.apiUrl)
    const currentApiUrl = normalizeApiUrl(model.apiUrl || model.baseUrl)
    if (expectedApiUrl && currentApiUrl !== expectedApiUrl) return true
    return /本地 Chrome|127\.0\.0\.1:3310|localhost:3310/i.test(String(model.modelName || '') + String(model.apiUrl || ''))
  }

  function readPagePrefs() {
    return window.WebBridgePagePrefUi?.read(document.getElementById('geminiWebBridgePagePrefs')) || {
      pageModel: 'flash',
      thinkingEnabled: false,
      thinkingLevel: 'default'
    }
  }

  function applyPagePrefsToControls(prefs = {}) {
    const root = document.getElementById('geminiWebBridgePagePrefs')
    if (prefs?.pageModel) window.WebBridgePagePrefUi?.write(root, prefs, true)
    else window.WebBridgePagePrefUi?.sync(root)
  }

  async function persistPagePrefs() {
    if (!window.api?.setGeminiWebBridgePagePrefs) return
    const result = await window.api.setGeminiWebBridgePagePrefs(readPagePrefs())
    return result
  }

  async function addOrUpdateChatModel(elements) {
    const getSuggestedModel = window.api?.getGeminiWebBridgeSuggestedChatModel
    if (!getSuggestedModel || !window.ModelStore) {
      throw new Error('当前界面尚未加载模型配置模块。')
    }
    const result = await getSuggestedModel()
    if (!result?.success || !result.model) throw new Error(result?.error || '无法读取本地网关配置。')

    const store = window.ModelStore
    const models = store.getModels()
    const previousModel = store.getCurrentModel()
    const previousKey = store.getModelKey(previousModel)
    const previousWasLegacyDirect = isLegacyDirectModel(previousModel)
    const existingIndex = findExistingBridgeModel(models, result.model.modelId)
    if (existingIndex >= 0) store.updateModel(existingIndex, { ...models[existingIndex], ...result.model })
    else store.addModel(result.model)

    const unifiedModel = store.getModels().find(model => (
      model?.provider === BRIDGE_PROVIDER && model?.modelId === result.model.modelId
    ))
    const unifiedKey = store.getModelKey(unifiedModel)
    const legacyIndexes = store.getModels()
      .map((model, index) => isLegacyDirectModel(model) ? index : -1)
      .filter(index => index >= 0)
      .sort((a, b) => b - a)
    legacyIndexes.forEach(index => store.removeModel(index))

    const previousIndex = previousKey ? store.findModelIndexByKey(previousKey) : -1
    const unifiedIndex = unifiedKey ? store.findModelIndexByKey(unifiedKey) : -1
    if (previousWasLegacyDirect && unifiedIndex >= 0) store.setCurrentIndex(unifiedIndex)
    else if (previousIndex >= 0) store.setCurrentIndex(previousIndex)
    await store.save()
    window.dispatchEvent(new CustomEvent('lingxi:model-config-changed', {
      detail: { provider: BRIDGE_PROVIDER, action: existingIndex >= 0 ? 'updated' : 'added' }
    }))
    renderStatus(elements, result.status || {})
    const merged = legacyIndexes.length ? `已合并并移除 ${legacyIndexes.length} 个旧的 3310 Gemini 重复入口。` : ''
    return `${existingIndex >= 0 ? '已更新' : '已添加'}唯一的 Gemini 网页版聊天模型。${merged}`
  }

  function bind() {
    const elements = {
      state: document.getElementById('geminiWebBridgeState'),
      url: document.getElementById('geminiWebBridgeUrl'),
      message: document.getElementById('geminiWebBridgeMessage'),
      login: document.getElementById('geminiWebBridgeLoginBtn'),
      check: document.getElementById('geminiWebBridgeCheckBtn'),
      addChat: document.getElementById('geminiWebBridgeAddChatBtn'),
      dumpDom: document.getElementById('geminiWebBridgeDumpDomBtn'),
      prefs: document.getElementById('geminiWebBridgePagePrefs'),
      card: document.getElementById('geminiWebBridgeCard'),
      transportToggle: document.getElementById('geminiWebBridgeBrowserModeToggle'),
      transportNote: document.getElementById('geminiWebBridgeTransportNote')
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
        const result = await window.api.openGeminiWebBridgeLogin()
        renderStatus(elements, result)
        setMessage(elements.message, `${result?.browserName || '普通浏览器'} 已以普通模式打开。请在 gemini.google.com 完成 Google 账号登录，关闭整个专用浏览器窗口，再点击第 2 步。`)
        return result
      }, '正在启动没有自动化参数的普通 Chrome/Edge……').catch(() => {})
    })

    elements.check?.addEventListener('click', () => {
      runAction(elements.check, async () => {
        const result = await window.api.checkGeminiWebBridgeLogin()
        renderStatus(elements, result)
        if (!result?.loggedIn) {
          setMessage(elements.message, result?.instruction || '尚未检测到登录。请重新执行第 1 步。', 'warning')
          return result
        }
        if (result?.directAuthenticated === false) {
          setMessage(elements.message, result?.directAuthError || result?.instruction || '网页登录有效，但直连鉴权刷新失败；旧会话未被覆盖。', 'warning')
          return result
        }
        let syncNote = ''
        try {
          syncNote = await addOrUpdateChatModel(elements)
        } catch (error) {
          syncNote = `登录有效，但同步模型密钥失败：${error?.message || error}`
          setMessage(elements.message, syncNote, 'warning')
          return result
        }
        setMessage(
          elements.message,
          `登录与直连鉴权均有效${result?.directModels?.length ? `，账号模型：${result.directModels.map(model => model.name || model.id).join(' / ')}` : ''}。${syncNote}请在模型列表里选中「Gemini 网页版」后再发消息。`,
          'success'
        )
        return result
      }, '正在检查 Gemini 登录状态……').catch(() => {})
    })

    elements.dumpDom?.addEventListener('click', () => {
      runAction(elements.dumpDom, async () => {
        const result = await window.api.dumpGeminiWebBridgeReplyDom()
        if (!result?.success) throw new Error(result?.error || '抓取失败')
        const json = JSON.stringify(result.dom, null, 2)
        try {
          await navigator.clipboard.writeText(json)
          setMessage(elements.message, '已复制回复 DOM 结构到剪贴板，请粘贴给开发者。', 'success')
        } catch (_) {
          setMessage(elements.message, json.slice(0, 4000), 'success')
        }
        return null
      }, '正在抓取 Gemini 回复 DOM 结构……').catch(() => {})
    })

    elements.addChat?.addEventListener('click', () => {
      runAction(elements.addChat, async () => {
        const result = await persistPagePrefs()
        if (result?.status) renderStatus(elements, result.status)
        const message = await addOrUpdateChatModel(elements)
        setMessage(elements.message, message, 'success')
        return null
      }, '正在写入网页版聊天模型配置……').catch(() => {})
    })

    elements.transportToggle?.addEventListener('change', () => {
      const requestedMode = elements.transportToggle.checked ? 'browser' : 'direct'
      runAction(elements.transportToggle, async () => {
        const result = await window.api.setGeminiWebBridgeTransportMode(requestedMode)
        if (!result?.success) throw new Error(result?.error || '切换 Gemini 传输方式失败。')
        renderStatus(elements, result.status || {})
        await addOrUpdateChatModel(elements)
        const message = requestedMode === 'direct'
          ? '已切换为协议直连。仍使用同一个 Gemini 网页版模型，由通用 Agent API 网关负责协议转换与校验。'
          : '已切换为可见浏览器。之后仍选择同一个 Gemini 网页版模型。'
        setMessage(elements.message, message, 'success')
        return result
      }, requestedMode === 'direct' ? '正在启动 Gemini 协议直连组件……' : '正在切换到可见浏览器……').catch(() => {
        elements.transportToggle.checked = requestedMode !== 'browser'
      })
    })

    window.WebBridgePagePrefUi?.bind(elements.prefs)
    elements.prefs?.addEventListener('web-bridge-page-prefs-change', () => {
      persistPagePrefs().then(result => {
        if (result?.status) renderStatus(elements, result.status)
        return addOrUpdateChatModel(elements)
      }).catch(() => {})
    })

    window.api?.getGeminiWebBridgeStatus?.().then(status => {
      renderStatus(elements, status)
      applyPagePrefsToControls(status?.pagePrefs || {})
      if (status?.lastError) setMessage(elements.message, status.lastError, 'error')
      if (window.ModelStore?.getModels?.().some(model => isLegacyDirectModel(model) || needsUnifiedModelRefresh(model, status))) {
        addOrUpdateChatModel(elements).then(message => {
          setMessage(elements.message, message, 'success')
        }).catch(() => {})
      }
    }).catch(error => {
      renderStatus(elements, { running: false })
      setMessage(elements.message, error?.message || '本地 Gemini 网关启动失败。', 'error')
    })

    setInterval(() => {
      if (document.visibilityState !== 'visible') return
      window.api?.getGeminiWebBridgeStatus?.().then(status => {
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
