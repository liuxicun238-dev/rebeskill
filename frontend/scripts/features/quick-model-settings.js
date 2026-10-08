(function () {
  function bind(options = {}) {
    const modelStore = options.modelStore
    const getModels = options.getModels || function () { return [] }
    const getCurrentIndex = options.getCurrentIndex || function () { return -1 }
    const getCurrentConfig = options.getCurrentConfig || function () { return null }
    const syncModelState = options.syncModelState || function () {}
    const saveModelsToStorage = options.saveModelsToStorage || async function () {}
    const getActiveProject = options.getActiveProject || function () { return null }
    const getProjectModelIndex = options.getProjectModelIndex || function (project) { return project?.modelIndex ?? -1 }
    const setProjectModel = options.setProjectModel || function (project, index) {
      if (project) project.modelIndex = index
    }
    const setEditingIndex = options.setEditingIndex || function () {}
    const getEditingIndex = options.getEditingIndex || function () { return -1 }
    const settingsPanelUI = options.settingsPanelUI
    const openModelEditorModal = options.openModelEditorModal || function () {}

    const panel = document.getElementById('settingsPanel')
    const closeButton = document.getElementById('settingsClose')
    const modelNameInput = document.getElementById('modelName')
    const modelIdInput = document.getElementById('modelId')
    const apiUrlInput = document.getElementById('apiUrl')
    const apiUrlFullModeInput = document.getElementById('apiUrlFullMode')
    const apiKeyInput = document.getElementById('apiKey')
    const contextWindowInput = document.getElementById('contextWindow')
    const modelAdvancedDetails = document.getElementById('modelAdvanced')

    const keyToggle = document.getElementById('keyToggle')
    const saveBtn = document.getElementById('saveBtn')
    const settingsStatus = document.getElementById('settingsStatus')
    const modelMenu = document.getElementById('modelMenu')
    const modelTrigger = document.getElementById('modelTrigger')
    const modelCurrent = document.getElementById('modelCurrent')
    const modelReasoningTag = document.getElementById('modelReasoningTag')
    const reasoningDropdown = document.getElementById('reasoningDropdown')
    const reasoningTrigger = document.getElementById('reasoningTrigger')
    const reasoningMenu = document.getElementById('reasoningMenu')
    const reasoningCurrent = document.getElementById('reasoningCurrent')
    const capabilityInputs = {
      text: document.getElementById('capabilityText'),
      vision: document.getElementById('capabilityVision'),
      imageGeneration: document.getElementById('capabilityImageGeneration'),
      musicGeneration: document.getElementById('capabilityMusicGeneration'),
      videoGeneration: document.getElementById('capabilityVideoGeneration'),
      speechSynthesis: document.getElementById('capabilitySpeechSynthesis'),
      webSearch: document.getElementById('capabilityWebSearch'),
      toolCalling: document.getElementById('capabilityToolCalling')
    }
    let draggedModelIndex = null
    let modelSearchValue = ''

    const escapeHtml = HtmlUtils.escapeHtml

    function openAddModelEditor() {
      modelSearchValue = ''
      modelMenu?.classList.remove('show')
      openModelEditorModal('add')
    }

    function getHubVendor(model) {
      const detected = window.ModelBrandIcons?.detect?.(model)
      if (detected?.label) return detected.label
      const explicit = String(model?.provider || model?.cloudProvider || '').trim()
      if (explicit) return explicit
      const url = String(model?.apiUrl || '')
      try {
        const host = new URL(url).hostname.toLowerCase()
        if (host) return host.replace(/^api\./, '').split('.')[0]
      } catch {}
      return '其他'
    }

    function getHubVendorIconHtml(vendor) {
      return getModelIconHtml({ modelName: vendor, provider: vendor }, 'model-hub-vendor-icon')
    }

    function groupModelsByVendor(refs) {
      const groups = []
      const map = new Map()
      refs.forEach(ref => {
        const vendor = getHubVendor(ref.model)
        if (!map.has(vendor)) {
          const group = { vendor, models: [] }
          map.set(vendor, group)
          groups.push(group)
        }
        map.get(vendor).models.push(ref)
      })
      return groups
    }

    function getModelSearchText(model) {
      const labels = modelStore?.getCapabilityLabels?.(model) || []
      return [
        model?.modelName,
        model?.modelId,
        model?.cloudProvider,
        model?.provider,
        model?.apiUrl,
        getHubVendor(model),
        labels.join(' ')
      ].filter(Boolean).join(' ').toLowerCase()
    }

    function isChatSelectableModel(model) {
      const capabilities = modelStore?.normalizeCapabilities?.(model?.capabilities) || { text: true }
      return capabilities.text === true
    }

    function getModelIconHtml(model, className = '') {
      return window.ModelBrandIcons?.getIconHtml?.(model, className) || ''
    }

    function getModelDisplayName(model) {
      if (!model) return '未命名模型'
      return model.modelName || model.modelId || '未命名模型'
    }

    function getCapabilityBadgesHtml(labels = []) {
      if (!labels || labels.length === 0) return ''
      const badgeMap = {
        '视觉理解': { cls: 'badge-vision', label: '视觉' },
        '工具调用': { cls: 'badge-tools', label: '工具' },
        '深度思考': { cls: 'badge-reasoning', label: '思考' },
        '文生图': { cls: 'badge-image', label: '生图' },
        '网页搜索': { cls: 'badge-search', label: '联网' }
      }
      const filtered = labels.filter(l => l !== '文本')
      const displayLabels = filtered.length > 0 ? filtered : (labels.includes('文本') ? ['文本'] : [])
      if (displayLabels.length === 0) return ''

      return `<div class="model-option-badges">` + displayLabels.map(label => {
        const meta = badgeMap[label] || { cls: 'badge-default', label }
        return `<span class="model-cap-badge ${meta.cls}">${escapeHtml(meta.label)}</span>`
      }).join('') + `</div>`
    }

    function getModelMetaText(model, labels = []) {
      return labels.join(' / ')
    }

    function getSafeSavedModelMeta(model, labels = []) {
      const modelId = model?.modelId && model.modelId !== model.modelName ? model.modelId : ''
      const source = '自定义模型'
      return [modelId, source, labels.join(' / ')].filter(Boolean).join(' · ')
    }

    function getCapabilityHtml(model) {
      const labels = modelStore?.getCapabilityLabels?.(model) || []
      if (labels.length === 0) return ''
      return `<div class="model-capability-badges">${labels.map(label => `<span class="model-capability-badge">${label}</span>`).join('')}</div>`
    }

    function getReasoningDefinitions() {
      return modelStore?.reasoningEffortDefinitions || [
        { value: '', label: ((window.i18n?.t?.('auto.js_quick_model_settings_69_1') ?? '自动')), desc: ((window.i18n?.t?.('auto.js_quick_model_settings_69_2') ?? '不额外发送推理强度参数')) },
        { value: 'low', label: '轻度', desc: '快速响应，适合简单对话' },
        { value: 'medium', label: ((window.i18n?.t?.('auto.js_quick_model_settings_71_5') ?? '中')), desc: ((window.i18n?.t?.('auto.js_quick_model_settings_71_6') ?? '平衡速度和推理')) },
        { value: 'high', label: ((window.i18n?.t?.('auto.js_quick_model_settings_72_7') ?? '高')), desc: ((window.i18n?.t?.('auto.js_quick_model_settings_72_8') ?? '更慢，适合开发和审查')) },
        { value: 'xhigh', label: ((window.i18n?.t?.('auto.js_quick_model_settings_73_9') ?? '极高')), desc: ((window.i18n?.t?.('auto.js_quick_model_settings_73_10') ?? '最慢，适合大型开发和复杂审查')) }
      ]
    }

    function getReasoningEffort(model) {
      return modelStore?.normalizeReasoningEffort?.(model?.reasoning_effort ?? model?.reasoningEffort) || ''
    }

    function getHubReasoningItems() {
      return [
        { value: 'low', label: '轻度' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '高' },
        { value: 'xhigh', label: '极高' }
      ]
    }

    function getReasoningLabel(model) {
      const value = getReasoningEffort(model)
      const option = getHubReasoningItems().find(item => item.value === value)
      return option?.label || ((window.i18n?.t?.('auto.js_quick_model_settings_84_11') ?? '自动'))
    }


    function readCapabilities() {
      const capabilities = {
        text: !!capabilityInputs.text?.checked,
        vision: !!capabilityInputs.vision?.checked,
        imageGeneration: !!capabilityInputs.imageGeneration?.checked,
        musicGeneration: !!capabilityInputs.musicGeneration?.checked,
        videoGeneration: !!capabilityInputs.videoGeneration?.checked,
        speechSynthesis: !!capabilityInputs.speechSynthesis?.checked,
        webSearch: !!capabilityInputs.webSearch?.checked,
        toolCalling: !!capabilityInputs.toolCalling?.checked
      }
      return capabilities
    }

    function writeCapabilities(modelOrCapabilities = null) {
      const caps = modelStore?.normalizeCapabilities?.(modelOrCapabilities?.capabilities || modelOrCapabilities) || {}
      Object.entries(capabilityInputs).forEach(([key, input]) => {
        if (input) input.checked = !!caps[key]
      })
    }

    function fillQuickModelForm(model) {
      if (!model) {
        if (contextWindowInput) contextWindowInput.value = ''
        if (modelAdvancedDetails) modelAdvancedDetails.open = false
        writeCapabilities()
        return
      }
      modelNameInput.value = model.modelName || ''
      modelIdInput.value = model.modelId || model.modelName || ''
      apiUrlInput.value = model.apiUrl || ''
      if (apiUrlFullModeInput) apiUrlFullModeInput.checked = model.useFullUrl === true || model.fullUrl === true || model.apiUrlMode === 'full'
      const keyValue = model.apiKey || ''
      apiKeyInput.value = keyValue
      window.SettingsPanelUI?.setApiKeyRealValue?.(apiKeyInput, keyValue)
      window.SettingsPanelUI?.setApiKeyMasked?.(apiKeyInput, true)
      if (contextWindowInput) contextWindowInput.value = model.contextWindow || model.contextLength || model.maxContextTokens || ''
      if (modelAdvancedDetails) modelAdvancedDetails.open = false
      writeCapabilities(model)
    }

    function readContextWindow() {
      const raw = String(contextWindowInput?.value || '').trim()
      if (!raw) return 0
      const value = Number(raw)
      if (!Number.isInteger(value) || value < 16000 || value > 100000000) return -1
      return value
    }

    function switchSettingsTab(tab) {
      document.getElementById('contentNew')?.classList.toggle('show', true)
    }

    function openModelSettingsPage() {
      activeFlyout = null
      activeVendor = null
      modelMenu?.classList.remove('show')
      const settingsBtn = document.getElementById('btnSettings')
      if (settingsBtn) settingsBtn.click()
      else {
        window.LingxiPanelManager?.openExclusive?.('settings')
        document.getElementById('settingsPanel')?.classList.add('show')
      }
      document.getElementById('settingsTabModel')?.click()
    }

    function activeModelIndex() {
      const activeProject = getActiveProject()
      return activeProject ? getProjectModelIndex(activeProject) : getCurrentIndex()
    }

    function updateReasoningTrigger() {
      const model = getModels()[activeModelIndex()]
      const label = model ? getReasoningLabel(model) : '自动'
      if (reasoningCurrent) reasoningCurrent.textContent = label
      if (modelReasoningTag) modelReasoningTag.textContent = label
    }

    function renderReasoningMenu() {
      if (!reasoningMenu) return
      const index = activeModelIndex()
      const model = getModels()[index]
      const current = model ? getReasoningEffort(model) : ''
      reasoningMenu.innerHTML = `<div class="model-reasoning-title">推理强度</div>` +
        getReasoningDefinitions().map(item =>
          `<button class="model-reasoning-option ${item.value === current ? 'selected' : ''}" data-reasoning-value="${escapeHtml(item.value)}" type="button">
            <span class="model-reasoning-label">${escapeHtml(item.label)}</span>
            <span class="model-reasoning-desc">${escapeHtml(item.desc || '')}</span>
          </button>`
        ).join('')
      reasoningMenu.querySelectorAll('.model-reasoning-option').forEach(button => {
        button.onclick = e => {
          e.stopPropagation()
          const value = button.dataset.reasoningValue || ''
          const updatedModel = modelStore?.setModelReasoningEffort?.(index, value)
          if (!updatedModel) return
          syncModelState()
          saveModelsToStorage()
          renderModelSelect(modelSearchValue)
          updateReasoningTrigger()
          reasoningMenu?.classList.remove('show')
        }
      })
    }

    function renderModelList() {
      const modelListEl = document.getElementById('modelList')
      if (!modelListEl) return
      const savedModels = getModels()
      if (savedModels.length === 0) {
        modelListEl.innerHTML = '<div class="model-empty">暂无已储存的模型</div>'
        return
      }
      modelListEl.innerHTML = savedModels.map((model, index) => `
        <div class="model-item" data-index="${index}">
          ${getModelIconHtml(model, 'model-item-icon')}
          <div class="model-info">
            <div class="model-name">${escapeHtml(model.modelName || '未命名模型')}</div>
            <div class="model-url">${escapeHtml(getSafeSavedModelMeta(model, modelStore?.getCapabilityLabels?.(model) || []))}</div>
            ${getCapabilityHtml(model)}
          </div>
          <div class="model-actions">
            <span class="model-btn use" data-action="use" data-index="${index}" title="使用">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
            </span>
            <span class="model-btn edit" data-action="edit" data-index="${index}" title="编辑">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </span>
            <span class="model-btn delete" data-action="delete" data-index="${index}" title="删除">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </span>
          </div>
        </div>
      `).join('')

      modelListEl.querySelectorAll('.model-btn').forEach(button => {
        button.onclick = () => {
          const index = parseInt(button.dataset.index, 10)
          if (button.dataset.action === 'use') useModel(index)
          if (button.dataset.action === 'edit') editModel(index)
          if (button.dataset.action === 'delete') deleteModel(index)
        }
      })

      setupModelDragSort()
    }

    let renderModelSelect

    function useModel(index, silent = false) {
      modelStore.setCurrentIndex(index)
      if (!silent) {
        const project = getActiveProject()
        if (project) setProjectModel(project, index)
      }
      syncModelState()
      saveModelsToStorage()
      if (!silent) {
        const currentConfig = getModels()[index] || getCurrentConfig()
        if (currentConfig) modelCurrent.textContent = currentConfig.modelName
        renderModelSelect()
        window.dispatchEvent(new CustomEvent('lingxi:model-changed', {
          detail: {
            projectId: getActiveProject()?.id || '',
            modelName: currentConfig?.modelName || currentConfig?.modelId || ''
          }
        }))
        settingsStatus.textContent = ((window.i18n?.t?.('auto.js_quick_model_settings_292_1') ?? ((window.i18n?.t?.('auto.js_quick_model_settings_292_21') ?? '已切换到: ')))) + (currentConfig?.modelName || '')
        setTimeout(() => { settingsStatus.textContent = '' }, 1500)
      }
    }

    let activeFlyout = null
    let activeVendor = null
    let flyoutTimer = null
    let vendorListScrollTop = 0
    const checkSvg = '<span class="model-option-check" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>'
    const chevronSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'

    function collectHubModelGroups(filter = modelSearchValue) {
      const savedModels = getModels()
      const activeProject = getActiveProject()
      const currentModelIndex = activeProject ? getProjectModelIndex(activeProject) : getCurrentIndex()
      const currentModel = currentModelIndex >= 0 ? savedModels[currentModelIndex] : null
      const normalizedFilter = String(filter || '').trim().toLowerCase()
      const allModelRefs = savedModels
        .map((model, index) => ({ model, index }))
        .filter(({ model }) => isChatSelectableModel(model))
      const filteredModels = allModelRefs.filter(({ model }) => !normalizedFilter || getModelSearchText(model).includes(normalizedFilter))
      return {
        savedModels,
        currentModelIndex,
        currentModel,
        allModelRefs,
        filteredModels,
        vendorGroups: groupModelsByVendor(filteredModels)
      }
    }

    function buildVendorModelsPanelHtml(group, currentModelIndex) {
      if (!group) return ''
      return `
        <div class="model-vendor-models" id="modelVendorModels">
          <div class="model-vendor-models-card">
            <div class="model-menu-list">
              ${group.models.map(({ model, index }) => {
                const selected = currentModelIndex === index ? 'selected' : ''
                return `
                  <div class="model-option ${selected}" data-value="${index}" title="${escapeHtml(getModelDisplayName(model))}">
                    <div class="model-option-main">
                      <span class="model-option-name">${escapeHtml(getModelDisplayName(model))}</span>
                      ${selected ? checkSvg : ''}
                    </div>
                  </div>
                `
              }).join('')}
            </div>
          </div>
        </div>
      `
    }

    function bindModelOptionClicks(root) {
      root?.querySelectorAll('.model-option[data-value]').forEach(option => {
        option.onclick = e => {
          e.stopPropagation()
          const value = option.dataset.value
          if (value === 'add') {
            activeFlyout = null
            activeVendor = null
            openAddModelEditor()
            return
          }
          if (value !== '-1' && value !== undefined) {
            modelSearchValue = ''
            activeFlyout = null
            activeVendor = null
            useModel(parseInt(value, 10))
          }
          modelMenu.classList.remove('show')
        }
      })
    }

    function captureVendorListScroll() {
      const list = modelMenu?.querySelector('#modelVendorList')
      if (list) vendorListScrollTop = list.scrollTop
    }

    function restoreVendorListScroll() {
      const list = modelMenu?.querySelector('#modelVendorList')
      if (list) list.scrollTop = vendorListScrollTop
    }

    function bindVendorListScroll() {
      const list = modelMenu?.querySelector('#modelVendorList')
      if (!list) return
      list.onscroll = () => {
        vendorListScrollTop = list.scrollTop
      }
    }

    function refreshVendorModelsPanel() {
      const flyout = modelMenu?.querySelector('#modelFlyoutRight')
      if (!flyout) return
      const { currentModelIndex, vendorGroups } = collectHubModelGroups()
      if (activeVendor && !vendorGroups.some(group => group.vendor === activeVendor)) {
        activeVendor = null
      }
      flyout.querySelectorAll('.model-vendor-row[data-vendor]').forEach(row => {
        row.classList.toggle('active', row.dataset.vendor === activeVendor)
      })
      const group = vendorGroups.find(item => item.vendor === activeVendor) || null
      const nextHtml = buildVendorModelsPanelHtml(group, currentModelIndex)
      const currentPanel = flyout.querySelector('#modelVendorModels')
      if (!nextHtml) {
        currentPanel?.remove()
        return
      }
      const wrap = document.createElement('div')
      wrap.innerHTML = nextHtml.trim()
      const nextPanel = wrap.firstElementChild
      if (currentPanel) currentPanel.replaceWith(nextPanel)
      else flyout.appendChild(nextPanel)
      bindModelOptionClicks(nextPanel)
    }

    renderModelSelect = function (filter = modelSearchValue) {
      captureVendorListScroll()
      const nextFilter = String(filter || '')
      if (nextFilter !== modelSearchValue) vendorListScrollTop = 0
      modelSearchValue = nextFilter
      const {
        savedModels,
        currentModelIndex,
        currentModel,
        allModelRefs,
        vendorGroups
      } = collectHubModelGroups(modelSearchValue)
      const currentReasoning = currentModel ? getReasoningEffort(currentModel) : ''
      const reasoningLabel = currentModel ? getReasoningLabel(currentModel) : '自动'
      const normalizedFilter = modelSearchValue.trim().toLowerCase()
      if (activeVendor && !vendorGroups.some(group => group.vendor === activeVendor)) {
        activeVendor = normalizedFilter && vendorGroups[0] ? vendorGroups[0].vendor : null
      } else if (normalizedFilter && !activeVendor && vendorGroups[0]) {
        activeVendor = vendorGroups[0].vendor
      }
      const activeVendorGroup = vendorGroups.find(group => group.vendor === activeVendor) || null

      // ── 主菜单 (Master Hub) ──
      const masterHtml = `
        <div class="model-hub-master">
          <div class="model-hub-master-list">
            <div class="model-hub-row ${activeFlyout === 'models' ? 'active' : ''}" data-flyout="models">
              <span class="model-hub-row-label">模型</span>
              <span class="model-hub-row-value">${escapeHtml(currentModel ? getModelDisplayName(currentModel) : '未选择')}</span>
              <span class="model-hub-row-arrow">${chevronSvg}</span>
            </div>
            <div class="model-hub-row ${activeFlyout === 'reasoning' ? 'active' : ''}" data-flyout="reasoning">
              <span class="model-hub-row-label">推理强度</span>
              <span class="model-hub-row-value">${escapeHtml(reasoningLabel)}</span>
              <span class="model-hub-row-arrow">${chevronSvg}</span>
            </div>
          </div>
          <div class="model-hub-divider"></div>
          <div class="model-hub-row model-hub-row-advanced" id="modelHubManage">
            <span class="model-hub-row-label">模型管理</span>
          </div>
        </div>
      `

      // ── 侧边子面板：推理在左，厂商/模型在右 ──
      let flyoutHtml = ''
      if (activeFlyout === 'reasoning') {
        const definitions = getHubReasoningItems()
        flyoutHtml = `
          <div class="model-hub-flyout model-flyout-left" id="modelFlyoutLeft">
            <div class="model-hub-subhead">推理强度</div>
            <div class="model-menu-list">
              ${definitions.map(item => `
                <div class="model-option model-reasoning-item ${item.value === currentReasoning ? 'selected' : ''}" data-reasoning-value="${escapeHtml(item.value)}">
                  <div class="model-option-main">
                    <span class="model-option-name">${escapeHtml(item.label)}</span>
                    ${item.value === currentReasoning ? checkSvg : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `
      } else if (activeFlyout === 'models') {
        let vendorListHtml = ''
        if (savedModels.length === 0) {
          vendorListHtml = '<div class="model-option model-option-empty" data-value="-1">暂无可用模型</div>'
        } else if (allModelRefs.length === 0) {
          vendorListHtml = '<div class="model-empty-option">暂无可聊天的文本模型</div>'
        } else if (vendorGroups.length === 0) {
          vendorListHtml = '<div class="model-empty-option">暂无匹配的模型</div>'
        } else {
          vendorListHtml = vendorGroups.map(group => {
            const active = group.vendor === activeVendor ? 'active' : ''
            const hasCurrent = group.models.some(ref => ref.index === currentModelIndex)
            return `
              <div class="model-option model-vendor-row ${active}" data-vendor="${escapeHtml(group.vendor)}" title="${escapeHtml(group.vendor)}">
                <div class="model-option-main">
                  ${getHubVendorIconHtml(group.vendor)}
                  <span class="model-option-name">${escapeHtml(group.vendor)}</span>
                  <span class="model-vendor-count">${group.models.length}</span>
                  ${hasCurrent ? checkSvg : ''}
                  <span class="model-hub-row-arrow">${chevronSvg}</span>
                </div>
              </div>
            `
          }).join('')
        }

        flyoutHtml = `
          <div class="model-hub-flyout model-flyout-right" id="modelFlyoutRight">
            <div class="model-menu-head">
              <div class="model-menu-search-wrap">
                <svg class="model-menu-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input class="model-menu-search" id="modelMenuSearch" type="text" placeholder="搜索模型..." autocomplete="off" spellcheck="false">
              </div>
            </div>
            <div class="model-menu-list" id="modelVendorList">
              ${vendorListHtml}
            </div>
            ${buildVendorModelsPanelHtml(activeVendorGroup, currentModelIndex)}
          </div>
        `
      }

      modelMenu.innerHTML = `<div class="model-hub-wrapper">${masterHtml}${flyoutHtml}</div>`

      // ── 搜索框监听 ──
      const searchInput = modelMenu.querySelector('.model-menu-search')
      if (searchInput) {
        searchInput.value = modelSearchValue
        searchInput.oninput = e => {
          renderModelSelect(e.target.value)
          const nextInput = modelMenu.querySelector('.model-menu-search')
          if (nextInput) {
            nextInput.focus()
            const cursor = nextInput.value.length
            nextInput.setSelectionRange(cursor, cursor)
          }
        }
      }

      // ── Master Hub 悬停与点击切换侧栏 ──
      modelMenu.querySelectorAll('.model-hub-row[data-flyout]').forEach(row => {
        row.onmouseenter = () => {
          clearTimeout(flyoutTimer)
          const target = row.dataset.flyout
          if (target && activeFlyout !== target) {
            activeFlyout = target
            if (target !== 'models') activeVendor = null
            renderModelSelect()
          }
        }
        row.onclick = e => {
          e.stopPropagation()
          const target = row.dataset.flyout
          const next = (activeFlyout === target) ? null : target
          activeFlyout = next
          if (next !== 'models') activeVendor = null
          renderModelSelect()
        }
      })

      // ── 侧栏悬停保活 ──
      const flyoutEl = modelMenu.querySelector('.model-hub-flyout')
      if (flyoutEl) {
        flyoutEl.onmouseenter = () => {
          clearTimeout(flyoutTimer)
        }
      }

      // ── 厂商悬停后再展开该厂商模型（不重绘整栏，避免滚动被拉回顶部） ──
      modelMenu.querySelectorAll('.model-vendor-row[data-vendor]').forEach(row => {
        row.onmouseenter = () => {
          clearTimeout(flyoutTimer)
          const vendor = row.dataset.vendor
          if (vendor && activeVendor !== vendor) {
            activeVendor = vendor
            refreshVendorModelsPanel()
          }
        }
        row.onclick = e => {
          e.stopPropagation()
          const vendor = row.dataset.vendor
          if (vendor && activeVendor !== vendor) {
            activeVendor = vendor
            refreshVendorModelsPanel()
          }
        }
      })
      const vendorModelsEl = modelMenu.querySelector('#modelVendorModels')
      if (vendorModelsEl) {
        vendorModelsEl.onmouseenter = () => clearTimeout(flyoutTimer)
      }
      bindVendorListScroll()
      restoreVendorListScroll()

      const manageRow = modelMenu.querySelector('#modelHubManage')
      if (manageRow) {
        manageRow.onclick = e => {
          e.stopPropagation()
          openModelSettingsPage()
        }
      }

      bindModelOptionClicks(modelMenu)

      // ── 推理强度点击选择 ──
      modelMenu.querySelectorAll('.model-reasoning-item[data-reasoning-value]').forEach(option => {
        option.onclick = e => {
          e.stopPropagation()
          const value = option.dataset.reasoningValue || ''
          const index = activeModelIndex()
          const updatedModel = modelStore?.setModelReasoningEffort?.(index, value)
          if (updatedModel) {
            syncModelState()
            saveModelsToStorage()
            updateReasoningTrigger()
          }
          activeFlyout = null
          activeVendor = null
          modelMenu.classList.remove('show')
        }
      })

      if (modelCurrent) {
        modelCurrent.textContent = currentModel && isChatSelectableModel(currentModel)
          ? getModelDisplayName(currentModel)
          : '暂无可聊天的文本模型'
      }
      updateReasoningTrigger()
    }

    function editModel(index) {
      setEditingIndex(index)
      const model = getModels()[index]
      if (!model) return
      modelNameInput.value = model.modelName || ''
      modelIdInput.value = model.modelId || model.modelName || ''
      apiUrlInput.value = model.apiUrl || ''
      if (apiUrlFullModeInput) apiUrlFullModeInput.checked = model.useFullUrl === true || model.fullUrl === true || model.apiUrlMode === 'full'
      const keyValue = model.apiKey || ''
      apiKeyInput.value = keyValue
      window.SettingsPanelUI?.setApiKeyRealValue?.(apiKeyInput, keyValue)
      window.SettingsPanelUI?.setApiKeyMasked?.(apiKeyInput, true)
      if (contextWindowInput) contextWindowInput.value = model.contextWindow || model.contextLength || model.maxContextTokens || ''
      if (modelAdvancedDetails) modelAdvancedDetails.open = false
      writeCapabilities(model)
      switchSettingsTab('new')
      saveBtn.textContent = ((window.i18n?.t?.('auto.js_quick_model_settings_377_3') ?? ((window.i18n?.t?.('auto.js_quick_model_settings_377_27') ?? '更新'))))
    }

    async function deleteModel(index) {
      const model = getModels()[index] || {}
      const confirmed = await window.LingxiDangerDialog.show({
        title: '删除模型',
        targetName: model.modelName || model.modelId || '该模型',
        targetLabel: '目标模型',
        subtitle: '将从本机模型配置中移除这个模型。',
        tags: ['API 配置', '能力标记'],
        note: '不会删除服务商账号中的模型。',
        confirmText: '确认删除'
      })
      if (confirmed) {
        modelStore.removeModel(index)
        syncModelState()
        saveModelsToStorage()
        renderModelList()
        renderModelSelect()
        settingsStatus.textContent = ((window.i18n?.t?.('auto.js_quick_model_settings_387_4') ?? ((window.i18n?.t?.('auto.js_quick_model_settings_387_29') ?? '已删除'))))
        setTimeout(() => { settingsStatus.textContent = '' }, 1500)
      }
    }

    function saveModel() {
      const modelId = modelIdInput.value.trim()
      const modelName = modelNameInput.value.trim() || modelId
      const apiUrl = apiUrlInput.value.trim()
      const useFullUrl = !!apiUrlFullModeInput?.checked
      const contextWindow = readContextWindow()
      if (contextWindow < 0) {
        settingsStatus.textContent = '上下文窗口上限必须是 16000 到 100000000 之间的整数'
        modelAdvancedDetails && (modelAdvancedDetails.open = true)
        contextWindowInput?.focus()
        return
      }
      const apiKeyRaw = window.SettingsPanelUI?.getApiKeyRealValue?.(apiKeyInput) ?? apiKeyInput.value
      if (window.SettingsPanelUI?.isMaskOnlyKey?.(apiKeyRaw)) {
        showToast?.('Key 是圆点掩码，不是真值。请重新粘贴真实 API Key 后再保存', 'error')
        return
      }
      const apiKey = (window.SettingsPanelUI?.sanitizeApiKeyText?.(apiKeyRaw) ?? String(apiKeyRaw || '').trim())
      if (apiKeyInput && apiKey !== apiKeyInput.value) {
        apiKeyInput.value = apiKey
        window.SettingsPanelUI?.setApiKeyRealValue?.(apiKeyInput, apiKey)
      }

      if (!modelId || !apiUrl || !apiKey) {
        settingsStatus.textContent = ((window.i18n?.t?.('auto.js_quick_model_settings_399_5') ?? ((window.i18n?.t?.('auto.js_quick_model_settings_399_30') ?? '请填写完整信息'))))
        return
      }

      const capabilities = readCapabilities()
      if (!Object.values(capabilities).some(Boolean)) {
        settingsStatus.textContent = ((window.i18n?.t?.('auto.js_quick_model_settings_405_6') ?? ((window.i18n?.t?.('auto.js_quick_model_settings_405_31') ?? '请至少标注一种模型能力'))))
        return
      }

      const model = { modelName, modelId, apiUrl, apiKey, useFullUrl, contextWindow, capabilities }
      const editingModelIndex = getEditingIndex()
      if (editingModelIndex >= 0) {
        modelStore.updateModel(editingModelIndex, model)
        setEditingIndex(-1)
        saveBtn.textContent = ((window.i18n?.t?.('auto.js_quick_model_settings_414_7') ?? ((window.i18n?.t?.('auto.js_quick_model_settings_414_32') ?? '保存'))))
        settingsStatus.textContent = ((window.i18n?.t?.('auto.js_quick_model_settings_415_8') ?? ((window.i18n?.t?.('auto.js_quick_model_settings_415_33') ?? '已更新'))))
      } else {
        modelStore.addModel(model)
        settingsStatus.textContent = ((window.i18n?.t?.('auto.js_quick_model_settings_418_9') ?? ((window.i18n?.t?.('auto.js_quick_model_settings_418_34') ?? '已保存'))))
      }

      syncModelState()
      saveModelsToStorage()
      renderModelSelect()
      modelNameInput.value = ''
      modelIdInput.value = ''
      apiUrlInput.value = ''
      if (apiUrlFullModeInput) apiUrlFullModeInput.checked = false
      if (contextWindowInput) contextWindowInput.value = ''
      if (modelAdvancedDetails) modelAdvancedDetails.open = false
      apiKeyInput.value = ''
      window.SettingsPanelUI?.setApiKeyRealValue?.(apiKeyInput, '')
      writeCapabilities()

      setTimeout(() => {
        panel.classList.remove('show')
        settingsStatus.textContent = ''
      }, 1000)
    }

    function setupModelDragSort() {
      const modelListEl = document.getElementById('modelList')
      if (!modelListEl) return
      const modelItems = modelListEl.querySelectorAll('.model-item')
      modelItems.forEach(item => {
        item.draggable = true
        item.addEventListener('dragstart', e => {
          draggedModelIndex = parseInt(item.dataset.index, 10)
          item.classList.add('dragging')
          e.dataTransfer.effectAllowed = 'move'
        })
        item.addEventListener('dragend', () => {
          item.classList.remove('dragging')
          modelItems.forEach(i => i.classList.remove('drag-over'))
          draggedModelIndex = null
        })
        item.addEventListener('dragover', e => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const targetIndex = parseInt(item.dataset.index, 10)
          if (targetIndex !== draggedModelIndex) {
            item.classList.add('drag-over')
          }
        })
        item.addEventListener('dragleave', () => {
          item.classList.remove('drag-over')
        })
        item.addEventListener('drop', e => {
          e.preventDefault()
          item.classList.remove('drag-over')
          const targetIndex = parseInt(item.dataset.index, 10)
          if (draggedModelIndex !== null && targetIndex !== draggedModelIndex) {
            modelStore.moveModel(draggedModelIndex, targetIndex)
            syncModelState()
            saveModelsToStorage()
            renderModelList()
            renderModelSelect()
          }
        })
      })
    }

    if (settingsPanelUI) {
      settingsPanelUI.bind({
        panel,
        closeButton,
        keyToggle,
        apiKeyInput
      })
    }

    if (saveBtn) saveBtn.onclick = saveModel
    if (modelTrigger) modelTrigger.onclick = e => {
      e.stopPropagation()
      reasoningMenu?.classList.remove('show')
      modelMenu.classList.toggle('show')
      if (modelMenu.classList.contains('show')) {
        activeFlyout = null
        activeVendor = null
        vendorListScrollTop = 0
        renderModelSelect()
      }
    }
    if (modelMenu) modelMenu.onclick = e => e.stopPropagation()
    if (reasoningTrigger) {
      reasoningTrigger.onclick = e => {
        e.stopPropagation()
        modelMenu?.classList.remove('show')
        const opening = !reasoningMenu?.classList.contains('show')
        reasoningMenu?.classList.toggle('show', opening)
        if (opening) renderReasoningMenu()
      }
    }
    if (reasoningMenu) reasoningMenu.onclick = e => e.stopPropagation()
    document.addEventListener('click', e => {
      modelMenu.classList.remove('show')
      if (reasoningDropdown && !reasoningDropdown.contains(e.target)) {
        reasoningMenu?.classList.remove('show')
      }
    })
    updateReasoningTrigger()

    function togglePanel() {
      panel.classList.toggle('show')
    }

    return {
      fillQuickModelForm,
      switchSettingsTab,
      renderModelList,
      renderModelSelect,
      useModel,
      editModel,
      deleteModel,
      saveModel,
      setupModelDragSort,
      togglePanel
    }
  }

  window.QuickModelSettings = { bind }
})()
