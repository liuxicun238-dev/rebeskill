// 上下文状态轮询模块
// 负责定期查询当前项目的上下文使用状态并更新侧边栏。
// 通过 window.ContextStatusPoller.bind(deps) 注入依赖后使用。

(function () {
  let getActiveProjectFn = null
  let getProjectModelFn = null
  let updateSidebarContextFn = null
  let addThinkingFn = null

  let lastRatio = 0
  let lastContextStatusError = ''

  async function pollContextStatus() {
    const project = getActiveProjectFn ? getActiveProjectFn() : null
    if (!project) {
      lastRatio = 0
      if (updateSidebarContextFn) updateSidebarContextFn(0, 0)
      return
    }
    // AI 运行时跳过轮询，避免大量流式 IPC + 上下文状态 IPC 争抢渲染线程，导致输入法 composition 事件丢失
    if (project?.isRunning) return
    if (window.api) {
      let status
      try {
        const model = getProjectModelFn ? getProjectModelFn(project) : null
        const modelDescriptor = {
          modelName: model?.modelName || '',
          modelId: model?.modelId || '',
          modelKey: model?.modelKey || '',
          contextWindow: model?.contextWindow || model?.contextLength || model?.maxContextTokens || 0
        }
        status = await window.api.getContextStatus(project.id, modelDescriptor)
      } catch (error) {
        status = { error: error?.message || String(error) }
      }
      const activeProject = getActiveProjectFn ? getActiveProjectFn() : null
      if (!activeProject || activeProject.id !== project.id) return
      if (status?.error) {
        project.contextStatus = status
        if (updateSidebarContextFn) updateSidebarContextFn(0, 0)
        if (project.isRunning && status.error !== lastContextStatusError) {
          lastContextStatusError = status.error
          if (addThinkingFn) addThinkingFn(`上下文状态读取失败：${status.error}`, { isProgressNarration: true, forceUpdate: true })
        }
        return
      }
      lastContextStatusError = ''
      const newRatio = status.contextRatio || 0

      lastRatio = newRatio
      project.contextStatus = status
      if (updateSidebarContextFn) updateSidebarContextFn(newRatio, status.estimatedTokens || 0)
    }
  }

  function bind(deps = {}) {
    if (typeof deps.getActiveProject === 'function') getActiveProjectFn = deps.getActiveProject
    if (typeof deps.getProjectModel === 'function') getProjectModelFn = deps.getProjectModel
    if (typeof deps.updateSidebarContext === 'function') updateSidebarContextFn = deps.updateSidebarContext
    if (typeof deps.addThinking === 'function') addThinkingFn = deps.addThinking
  }

  if (window.api && typeof window.api.onTurnEvent === 'function') {
    window.api.onTurnEvent(data => {
      const project = getActiveProjectFn ? getActiveProjectFn() : null
      if (!project || !data || (data.projectId && data.projectId !== project.id)) return
      // 工具项进行中不抢占聊天流；Turn 收束后主动拉一次，让侧栏与底部
      // 上下文组件使用同一份最新 Turn/Item 摘要。
      if (data.type === 'turn-completed') {
        setTimeout(() => pollContextStatus(), 180)
      }
    })
  }

  window.ContextStatusPoller = {
    bind,
    pollContextStatus,
    get lastRatio() { return lastRatio },
    set lastRatio(v) { lastRatio = v }
  }
})()
