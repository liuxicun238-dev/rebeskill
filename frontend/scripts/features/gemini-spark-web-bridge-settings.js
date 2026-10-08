(function () {
  const BRIDGE_PROVIDER = 'gemini-spark-web-bridge'

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
      elements.state.textContent = `Spark 任务中${status.queueDepth > 1 ? ` · 排队 ${status.queueDepth}` : ''}`
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

  async function addOrUpdateAgentModel(elements) {
    const getSuggestedModel = window.api?.getGeminiSparkWebBridgeSuggestedAgentModel
    if (!getSuggestedModel || !window.ModelStore) {
      throw new Error('当前界面尚未加载模型配置模块。')
    }
    const result = await getSuggestedModel()
    if (!result?.success || !result.model) throw new Error(result?.error || '无法读取本地 Spark 网关配置。')

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
    return existingIndex >= 0 ? '已更新 Gemini Spark Agent 模型。' : '已添加 Gemini Spark Agent 模型，并保留当前模型不变。'
  }

  function bind() {
    const elements = {
      state: document.getElementById('geminiSparkWebBridgeState'),
      url: document.getElementById('geminiSparkWebBridgeUrl'),
      message: document.getElementById('geminiSparkWebBridgeMessage'),
      login: document.getElementById('geminiSparkWebBridgeLoginBtn'),
      check: document.getElementById('geminiSparkWebBridgeCheckBtn'),
      addAgent: document.getElementById('geminiSparkWebBridgeAddAgentBtn')
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
        const result = await window.api.openGeminiSparkWebBridgeLogin()
        renderStatus(elements, result)
        setMessage(elements.message, `${result?.browserName || '普通浏览器'} 已以普通模式打开。请在 gemini.google.com/spark 完成 Google 账号登录，关闭整个专用浏览器窗口，再点击第 2 步。`)
        return result
      }, '正在启动没有自动化参数的普通 Chrome/Edge……').catch(() => {})
    })

    elements.check?.addEventListener('click', () => {
      runAction(elements.check, async () => {
        const result = await window.api.checkGeminiSparkWebBridgeLogin()
        renderStatus(elements, result)
        if (!result?.loggedIn) {
          setMessage(elements.message, result?.instruction || '尚未检测到登录。请重新执行第 1 步。', 'warning')
          return result
        }
        let syncNote = ''
        try {
          syncNote = await addOrUpdateAgentModel(elements)
        } catch (error) {
          syncNote = `登录有效，但同步模型密钥失败：${error?.message || error}`
          setMessage(elements.message, syncNote, 'warning')
          return result
        }
        setMessage(
          elements.message,
          `登录有效，Spark Agent 已就绪。${syncNote}请在模型列表里选中「Gemini Spark Agent」后再发任务。`,
          'success'
        )
        return result
      }, '正在检查 Spark 登录状态……').catch(() => {})
    })

    elements.addAgent?.addEventListener('click', () => {
      runAction(elements.addAgent, async () => {
        const message = await addOrUpdateAgentModel(elements)
        setMessage(elements.message, message, 'success')
        return null
      }, '正在写入 Spark Agent 模型配置……').catch(() => {})
    })

    window.api?.getGeminiSparkWebBridgeStatus?.().then(status => {
      renderStatus(elements, status)
      if (status?.lastError) setMessage(elements.message, status.lastError, 'error')
    }).catch(error => {
      renderStatus(elements, { running: false })
      setMessage(elements.message, error?.message || '本地 Spark 网关启动失败。', 'error')
    })

    setInterval(() => {
      if (document.visibilityState !== 'visible') return
      window.api?.getGeminiSparkWebBridgeStatus?.().then(status => {
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
