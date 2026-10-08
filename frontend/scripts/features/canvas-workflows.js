(function () {
  'use strict'

  const state = {
    projectId: '',
    workflow: null,
    items: [],
    loading: null,
    loadToken: 0
  }

  const saveQueue = window.CanvasWorkflowSaveQueue?.create?.({
    getSnapshot: () => clone(state.workflow),
    persist: snapshot => window.api.saveAgentWorkflow(state.projectId || getActiveProjectId() || '', snapshot),
    onPersisted: async (result, context) => {
      if (!result?.success || !result.workflow) throw new Error(result?.error || '工作流保存失败')
      if (context.isCurrent) state.workflow = result.workflow
      await refreshList(state.projectId || getActiveProjectId())
      emitChange('save')
    },
    onError: error => window.ToastUI?.show?.(error?.message || '工作流保存失败', 'error')
  })

  function createId(prefix = 'item') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }

  function createDefaultWorkflow() {
    const inputId = createId('input')
    const outputId = createId('output')
    return {
      version: 1,
      id: createId('workflow'),
      name: '未命名工作流',
      description: '',
      nodes: [
        { id: inputId, type: 'input', name: '工作流输入', task: '', outputRule: '', modelKey: '', modelName: '', x: 90, y: 315 },
        { id: outputId, type: 'output', name: '交付结果', task: '', outputRule: '汇总上游节点的有效交付结果', modelKey: '', modelName: '', x: 1090, y: 315 }
      ],
      edges: [{ id: createId('edge'), source: inputId, target: outputId }]
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value))
  }

  function getActiveProjectId() {
    return window.ProjectStore?.getActiveProjectId?.() || ''
  }

  function emitChange(reason = 'update') {
    window.dispatchEvent(new CustomEvent('lingxi:canvas-workflow-changed', {
      detail: { reason, projectId: state.projectId, workflow: clone(state.workflow) }
    }))
  }

  async function load(projectId = getActiveProjectId()) {
    const scopeProjectId = projectId || ''
    if (state.loading && state.projectId === scopeProjectId) return state.loading
    state.projectId = scopeProjectId
    const loadToken = ++state.loadToken
    state.loading = (async () => {
      const listed = await window.api?.listAgentWorkflows?.(scopeProjectId, { page: 0, limit: 80 })
      if (loadToken !== state.loadToken || scopeProjectId !== state.projectId) return state.workflow
      state.items = listed?.success && Array.isArray(listed.items) ? listed.items : []
      const first = state.items.find(item => item.enabled !== false) || state.items[0] || null
      if (first?.id) {
        const result = await window.api?.getAgentWorkflow?.(scopeProjectId, first.id)
        if (loadToken !== state.loadToken || scopeProjectId !== state.projectId) return state.workflow
        state.workflow = result?.success && result.workflow ? result.workflow : createDefaultWorkflow()
      } else {
        state.workflow = createDefaultWorkflow()
      }
      saveQueue?.reset?.()
      emitChange('load')
      return state.workflow
    })().finally(() => {
      if (loadToken === state.loadToken) state.loading = null
    })
    return state.loading
  }

  async function refreshList(projectId = state.projectId || getActiveProjectId()) {
    const listed = await window.api?.listAgentWorkflows?.(projectId, { page: 0, limit: 80 })
    state.items = listed?.success && Array.isArray(listed.items) ? listed.items : []
    return state.items
  }

  function getWorkflowItems() {
    return state.items.slice()
  }

  async function selectWorkflow(workflowId) {
    const projectId = state.projectId || getActiveProjectId() || ''
    if (!workflowId) throw new Error('请选择工作流')
    const result = await window.api?.getAgentWorkflow?.(projectId, workflowId)
    if (!result?.success || !result.workflow) throw new Error(result?.error || '工作流加载失败')
    state.projectId = projectId || ''
    state.workflow = result.workflow
    saveQueue?.reset?.()
    emitChange('select')
    return state.workflow
  }

  async function save() {
    if (!state.workflow) throw new Error('请先创建工作流')
    const result = await saveQueue?.flush?.({ force: true })
    return result?.workflow || state.workflow
  }

  function createNewWorkflow() {
    state.workflow = createDefaultWorkflow()
    emitChange('new')
    return state.workflow
  }

  function clearDesign() {
    if (!state.workflow) state.workflow = createDefaultWorkflow()
    const id = state.workflow.id
    const name = state.workflow.name
    state.workflow = createDefaultWorkflow()
    state.workflow.id = id
    state.workflow.name = name
    state.workflow.description = ''
    emitChange('clear')
    return state.workflow
  }

  function getWorkflow() {
    return state.workflow || createDefaultWorkflow()
  }

  function setWorkflow(nextWorkflow, reason = 'update') {
    state.workflow = clone(nextWorkflow)
    saveQueue?.markChanged?.()
    if (reason === 'node-position') saveQueue?.schedule?.(650)
    else saveQueue?.schedule?.(280)
    emitChange(reason)
    return state.workflow
  }

  function updateWorkflow(patch = {}) {
    return setWorkflow({ ...getWorkflow(), ...patch }, 'workflow-update')
  }

  function getNode(nodeId) {
    return getWorkflow().nodes.find(node => node.id === nodeId) || null
  }

  function updateNode(nodeId, patch = {}, options = {}) {
    const workflow = getWorkflow()
    workflow.nodes = workflow.nodes.map(node => node.id === nodeId ? { ...node, ...patch } : node)
    const positionOnly = Object.keys(patch).length > 0 && Object.keys(patch).every(key => key === 'x' || key === 'y')
    return setWorkflow(workflow, options.reason || (positionOnly ? 'node-position' : 'node-update'))
  }

  function addWork(afterNodeId = '') {
    const workflow = getWorkflow()
    const input = workflow.nodes.find(node => node.type === 'input')
    const output = workflow.nodes.find(node => node.type === 'output')
    const workNodes = workflow.nodes.filter(node => node.type === 'work')
    const source = workflow.nodes.find(node => node.id === afterNodeId && node.type !== 'output')
      || workNodes[workNodes.length - 1]
      || input
    const node = {
      id: createId('work'),
      type: 'work',
      name: `Work ${workNodes.length + 1}`,
      task: '',
      outputRule: '',
      modelKey: '',
      modelName: '',
      x: Math.min(820, Math.max(360, Number(source?.x || 90) + 290)),
      y: 150 + (workNodes.length % 4) * 184
    }
    workflow.nodes.push(node)
    const directOutputEdge = workflow.edges.find(edge => edge.source === source?.id && edge.target === output?.id)
    if (directOutputEdge) {
      workflow.edges = workflow.edges.filter(edge => edge.id !== directOutputEdge.id)
    }
    if (source) workflow.edges.push({ id: createId('edge'), source: source.id, target: node.id })
    if (output) workflow.edges.push({ id: createId('edge'), source: node.id, target: output.id })
    setWorkflow(workflow, 'node-add')
    return node
  }

  function removeNode(nodeId) {
    const workflow = getWorkflow()
    const target = workflow.nodes.find(node => node.id === nodeId)
    if (!target || target.type !== 'work') return false
    const incoming = workflow.edges.filter(edge => edge.target === nodeId)
    const outgoing = workflow.edges.filter(edge => edge.source === nodeId)
    workflow.nodes = workflow.nodes.filter(node => node.id !== nodeId)
    workflow.edges = workflow.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId)
    incoming.forEach(left => {
      outgoing.forEach(right => {
        if (left.source === right.target) return
        if (workflow.edges.some(edge => edge.source === left.source && edge.target === right.target)) return
        workflow.edges.push({ id: createId('edge'), source: left.source, target: right.target })
      })
    })
    setWorkflow(workflow, 'node-remove')
    return true
  }

  function setIncoming(nodeId, sourceIds = []) {
    const workflow = getWorkflow()
    const allowed = new Set(workflow.nodes.filter(node => node.id !== nodeId && node.type !== 'output').map(node => node.id))
    const normalized = [...new Set(sourceIds.filter(id => allowed.has(id)))]
    workflow.edges = workflow.edges.filter(edge => edge.target !== nodeId)
    normalized.forEach(source => {
      workflow.edges.push({ id: createId('edge'), source, target: nodeId })
    })
    setWorkflow(workflow, 'edges-update')
  }

  function validateWorkflow(workflow = getWorkflow()) {
    const workNodes = workflow.nodes.filter(node => node.type === 'work')
    if (!workNodes.length) throw new Error('请先添加至少一个 Work 节点')
    const ids = new Set(workNodes.map(node => node.id))
    for (const node of workNodes) {
      if (!String(node.task || '').trim()) throw new Error(`请填写「${node.name}」的任务`)
    }
    const indegree = new Map(workNodes.map(node => [node.id, 0]))
    const adjacency = new Map(workNodes.map(node => [node.id, []]))
    workflow.edges.forEach(edge => {
      if (!ids.has(edge.source) || !ids.has(edge.target)) return
      indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1)
      adjacency.get(edge.source).push(edge.target)
    })
    const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id)
    let visited = 0
    while (queue.length) {
      const id = queue.shift()
      visited += 1
      for (const next of adjacency.get(id) || []) {
        indegree.set(next, indegree.get(next) - 1)
        if (indegree.get(next) === 0) queue.push(next)
      }
    }
    if (visited !== workNodes.length) throw new Error('工作流存在循环连接，请调整节点依赖')
    return workNodes
  }

  function getCanonicalModelKey(model = {}) {
    if (window.ModelStore?.getModelKey) {
      const official = String(window.ModelStore.getModelKey(model) || '').trim()
      if (official) return official
    }
    return String(model.modelKey || model.id || model.key || model.modelId || model.modelName || model.name || model.model || '').trim()
  }

  function getModelIdentityKeys(model = {}) {
    return [...new Set([
      getCanonicalModelKey(model),
      model.modelKey,
      model.id,
      model.key,
      model.modelId,
      model.modelName,
      model.displayName,
      model.name,
      model.model
    ].map(value => String(value || '').trim()).filter(Boolean))]
  }

  function modelMatchesKey(model, key) {
    const target = String(key || '').trim()
    return !!target && getModelIdentityKeys(model).includes(target)
  }

  function findModelByStoredKey(key, models = []) {
    const target = String(key || '').trim()
    if (!target) return null
    const list = Array.isArray(models) ? models : []
    const exact = list.find(model => modelMatchesKey(model, target))
    if (exact) return exact
    const storeIndex = window.ModelStore?.findModelIndexByKey?.(target)
    if (Number.isInteger(storeIndex) && storeIndex >= 0) {
      return window.ModelStore.getModelAt?.(storeIndex) || list[storeIndex] || null
    }
    return null
  }

  function getModelDisplayName(model = {}) {
    return String(model.displayName || model.modelName || model.modelId || model.name || model.model || '').trim()
  }

  function resolveSelectedModel(node = {}, models = []) {
    const list = Array.isArray(models) ? models : []
    const byKey = findModelByStoredKey(node.modelKey, list)
    if (byKey) return byKey
    const name = String(node.modelName || '').trim()
    if (!name) return null
    const named = list.filter(model => getModelDisplayName(model) === name)
    return named.length === 1 ? named[0] : null
  }

  function getNodeModelLabel(node = {}, models = window.ModelStore?.getModels?.() || []) {
    const matched = resolveSelectedModel(node, models)
    if (matched) return getModelDisplayName(matched) || String(node.modelName || '').trim()
    if (String(node.modelName || '').trim()) return String(node.modelName).trim()
    if (String(node.modelKey || '').trim()) return String(node.modelKey).trim()
    return ''
  }

  function resolveModel(node, models, fallback) {
    if (!String(node?.modelKey || '').trim()) return fallback || null
    return resolveSelectedModel(node, models) || null
  }

  async function run() {
    throw new Error('多 AI 协作已移除，画布不再派发子代理。工作流仍可编辑和保存。')
  }

  // 监听 AI 创建工作流通知，自动刷新并切换到画布视图
  let _workflowCreatedListenerBound = false
  function bindWorkflowCreatedListener() {
    if (_workflowCreatedListenerBound) return
    _workflowCreatedListenerBound = true
    if (window.api?.onCanvasWorkflowCreated) {
      window.api.onCanvasWorkflowCreated(async (data) => {
        try {
          const projectId = data?.projectId || ''
          if (projectId && projectId !== state.projectId) {
            state.projectId = projectId
          }
          await refreshList(state.projectId || getActiveProjectId())
          if (data?.workflow?.id) {
            await selectWorkflow(data.workflow.id)
          } else {
            await load(state.projectId || getActiveProjectId())
          }
          // 自动切换到画布视图
          if (typeof window.openCanvasView === 'function') {
            window.openCanvasView()
          } else {
            const workTab = document.querySelector('.chat-toolbar-tab[data-tab="work"]')
            if (workTab) workTab.click()
          }
        } catch (_) {
          // 切换失败不影响保存结果
        }
      })
    }
  }

  // 延迟绑定，确保 DOM 和 API 就绪
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindWorkflowCreatedListener)
    } else {
      bindWorkflowCreatedListener()
    }
  }

  window.CanvasWorkflows = {
    load,
    refreshList,
    save,
    run,
    selectWorkflow,
    createNewWorkflow,
    clearDesign,
    getWorkflowItems,
    getWorkflow,
    getNode,
    setWorkflow,
    updateWorkflow,
    updateNode,
    addWork,
    removeNode,
    setIncoming,
    validateWorkflow,
    getCanonicalModelKey,
    getModelIdentityKeys,
    modelMatchesKey,
    findModelByStoredKey,
    resolveSelectedModel,
    getNodeModelLabel,
    resolveModel,
    flushPendingSave: () => saveQueue?.flush?.()
  }
})()
