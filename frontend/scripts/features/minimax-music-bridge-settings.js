(function () {
  const BRIDGE_PROVIDER = 'minimax-music-web-bridge'

  function setMessage(element, message, kind = '') {
    if (!element) return
    element.textContent = message || ''
    element.className = `chatgpt-image-bridge-message${kind ? ` is-${kind}` : ''}`
  }

  function renderStatus(elements, status = {}) {
    if (elements.url && status.apiUrl) elements.url.textContent = '页面直连（无本地 HTTP）'
    if (!elements.state) return

    elements.state.className = 'chatgpt-image-bridge-state'
    if (status.activeJob) {
      elements.state.textContent = `生成音乐中${status.queueDepth > 1 ? ` · 排队 ${status.queueDepth}` : ''}`
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
        : '待登录'
      elements.state.classList.add('is-idle')
    }
  }

  function findExistingBridgeModel(models, modelId) {
    return models.findIndex(model => (
      model?.provider === BRIDGE_PROVIDER && model?.modelId === modelId
    ))
  }

  async function addOrUpdateModel(elements) {
    const getSuggestedModel = window.api?.getMiniMaxMusicBridgeSuggestedModel
    if (!getSuggestedModel || !window.ModelStore) {
      throw new Error('当前界面尚未加载模型配置模块。')
    }
    const result = await getSuggestedModel()
    if (!result?.success || !result.model) throw new Error(result?.error || '无法读取 MiniMax 音乐桥配置。')

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
    return existingIndex >= 0 ? '已更新 MiniMax 音乐网页模型。' : '已添加 MiniMax 音乐网页模型，并保留当前聊天模型不变。请在能力路由里把它放到音乐生成最前，才会走网页而不是官方 API。'
  }

  function bind() {
    const elements = {
      state: document.getElementById('minimaxMusicBridgeState'),
      url: document.getElementById('minimaxMusicBridgeUrl'),
      message: document.getElementById('minimaxMusicBridgeMessage'),
      login: document.getElementById('minimaxMusicBridgeLoginBtn'),
      check: document.getElementById('minimaxMusicBridgeCheckBtn'),
      add: document.getElementById('minimaxMusicBridgeAddBtn'),
      dumpDom: document.getElementById('minimaxMusicBridgeDumpDomBtn')
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
        const result = await window.api.openMiniMaxMusicBridgeLogin()
        renderStatus(elements, result)
        setMessage(elements.message, `${result?.browserName || '普通浏览器'} 已以普通模式打开。请在 minimaxi.com/audio/music 完成 MiniMax 登录，关闭整个专用浏览器窗口，再点击第 2 步。`)
        return result
      }, '正在启动没有自动化参数的普通 Chrome/Edge……').catch(() => {})
    })

    elements.check?.addEventListener('click', () => {
      runAction(elements.check, async () => {
        const result = await window.api.checkMiniMaxMusicBridgeLogin()
        renderStatus(elements, result)
        setMessage(elements.message, result?.loggedIn
          ? '登录有效，网页音乐生成已就绪。'
          : (result?.instruction || '尚未检测到登录。请重新执行第 1 步。'), result?.loggedIn ? 'success' : 'warning')
        return result
      }, '正在检查 MiniMax 音乐页登录状态……').catch(() => {})
    })

    elements.dumpDom?.addEventListener('click', () => {
      runAction(elements.dumpDom, async () => {
        const result = await window.api.dumpMiniMaxMusicBridgeDom()
        if (!result?.success) throw new Error(result?.error || '抓取失败')
        const json = JSON.stringify(result.dom, null, 2)
        try {
          await navigator.clipboard.writeText(json)
          setMessage(elements.message, '已复制音乐页 DOM 结构到剪贴板，请粘贴给开发者。', 'success')
        } catch (_) {
          setMessage(elements.message, json.slice(0, 4000), 'success')
        }
        return null
      }, '正在抓取 MiniMax 音乐页 DOM……').catch(() => {})
    })

    elements.add?.addEventListener('click', () => {
      runAction(elements.add, async () => {
        const message = await addOrUpdateModel(elements)
        setMessage(elements.message, message, 'success')
        return null
      }, '正在写入音乐生成模型配置……').catch(() => {})
    })

    window.api?.getMiniMaxMusicBridgeStatus?.().then(status => {
      renderStatus(elements, status)
      if (status?.lastError) setMessage(elements.message, status.lastError, 'error')
    }).catch(error => {
      renderStatus(elements, { running: false })
      setMessage(elements.message, error?.message || 'MiniMax 音乐桥初始化失败。', 'error')
    })

    setInterval(() => {
      if (document.visibilityState !== 'visible') return
      window.api?.getMiniMaxMusicBridgeStatus?.().then(status => renderStatus(elements, status)).catch(() => {})
    }, 5000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true })
  else bind()
})()
