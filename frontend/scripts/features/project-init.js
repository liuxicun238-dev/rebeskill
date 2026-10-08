// 启动时加载已保存项目、恢复最近会话历史。
(function () {
  'use strict'

  let deps = {}

  async function init() {
    const log = window.AppLogger
    log?.debug?.('[Frontend] initProjects 开始')
    if (!window.api) return

    const getProjects = () => deps.getProjects?.() || []

    try {
      const savedProjects = await deps.loadProjectsList?.()
      const lastProjectPath = localStorage.getItem('lastProjectPath')

      if (savedProjects.length > 0) {
        for (const saved of savedProjects) {
          const createResult = await window.api.createProject(saved.path, {
            projectId: saved.id || '',
            storagePath: saved.storagePath || '',
            projectModeLocked: saved.projectModeLocked === true,
            projectMode: saved.projectMode === 'research' ? 'research' : 'standard'
          })
          if (createResult.success && createResult.projectId) {
            const project = deps.createProject?.(saved.path, {
              id: createResult.projectId,
              skipSave: true,
              modelIndex: saved.modelIndex,
              modelKey: saved.modelKey || null,
              projectMode: createResult.projectMode || (saved.projectMode === 'research' ? 'research' : 'standard'),
              projectModeLocked: createResult.projectModeLocked === true || saved.projectModeLocked === true,
              skillName: saved.skillName || null,
              title: saved.title || '',
              storagePath: createResult.storagePath || saved.storagePath || '',
              pinned: !!saved.pinned,
              expanded: saved.expanded !== false,
              archived: !!saved.archived,
              workspaceOrigin: saved.workspaceOrigin || '',
              workspaceBranch: saved.workspaceBranch || '',
              workspaceKind: saved.workspaceKind || '',
              createdAt: saved.createdAt || 0,
              updatedAt: saved.updatedAt || 0,
              lastOpenedAt: saved.lastOpenedAt || 0,
              folderMtimeMs: createResult.folderMtimeMs || saved.folderMtimeMs || 0
            })
            deps.resolveProjectModelIndex?.(project)
            project.skillName = saved.skillName || null
            project.isRunning = false
            project.contextStatus = { tapeLength: 0, contextRatio: 0 }
            project.aiOperations = []

            const status = await window.api.getContextStatus(project.id, deps.getProjectContextDescriptor?.(project))
            project.contextStatus = status
            deps.loadGitStatusForProject?.(project)
          }
        }

        const projects = getProjects()
        let targetProject = lastProjectPath
          ? projects.find(p => !p.archived && p.path === lastProjectPath) || projects.find(p => !p.archived && p.id === deps.generateProjectId?.(lastProjectPath)) || projects.find(p => !p.archived)
          : projects.find(p => !p.archived)

        if (!targetProject) {
          await deps.enterNoProjectState?.({ save: false })
          return
        }

        deps.setActiveProject?.(targetProject.id)
        deps.setChatInputVisible?.(true)
        deps.setCurrentProjectPath?.(targetProject.path)
        deps.setCurrentSkill?.(targetProject.skillName || null)
        deps.updateSkillButton?.()

        await deps.saveProjectsList?.(targetProject.path)

        const allProjectData = await window.api.getAllProjects()
        allProjectData.forEach(p => {
          const project = getProjects().find(item => item.id === p.id)
          if (project) deps.syncProjectBranchSession?.(project, p)
        })
        const targetData = window.api.getChatHistoryPage
          ? await window.api.getChatHistoryPage(targetProject.id, { pageChunks: 1, direction: 'older' })
          : window.api.getChatHistory
            ? await window.api.getChatHistory(targetProject.id)
            : allProjectData.find(p => p.id === targetProject.id)
        const targetMessages = targetData?.messages || targetData?.messagesHistory || []
        if (targetData && targetMessages.length > 0) {
          deps.syncProjectBranchSession?.(targetProject, { ...targetData, messagesHistory: targetMessages })
          deps.restoreRecentHistoryByRounds?.(targetMessages, targetProject.path, targetData, targetProject.id)
          targetProject.history = deps.mapMessagesHistoryForProject?.(targetMessages) || []
          const firstUserMsg = targetMessages.find(m => m.role === 'user' && !m.hidden)
          if (firstUserMsg) {
            targetProject.branchTitle = targetData.branchTitle || (firstUserMsg.displayContent || firstUserMsg.content || '').substring(0, 30)
          }
        }

        const targetModel = deps.getProjectModel?.(targetProject)
        const modelCurrent = deps.getModelCurrent?.()
        if (targetModel && modelCurrent) {
          modelCurrent.textContent = targetModel.modelName
        }
      } else {
        const existingProjects = await window.api.getAllProjects()
        log?.debug?.('[Frontend] getAllProjects 返回:', existingProjects)

        if (existingProjects && existingProjects.length > 0) {
          for (const p of existingProjects) {
            const project = deps.createProject?.(p.path, {
              id: p.id,
              skipSave: true,
              storagePath: p.storagePath || '',
              projectMode: p.projectMode === 'research' ? 'research' : 'standard',
              projectModeLocked: p.projectModeLocked === true,
              branchName: p.branchName || '',
              branchKey: p.branchKey || '',
              branchTitle: p.branchTitle || '',
              branchSessionPath: p.branchSessionPath || '',
              branchSessions: p.branchSessions || [],
              expanded: p.expanded !== false,
              archived: !!p.archived,
              stateless: !!p.stateless,
              workspaceOrigin: p.workspaceOrigin || '',
              folderMtimeMs: p.folderMtimeMs || 0
            })
            project.contextStatus = p.status || { tapeLength: 0, contextRatio: 0 }
          }

          const projects = getProjects()
          const targetProject = lastProjectPath
            ? projects.find(p => !p.archived && !p.stateless && p.path === lastProjectPath) || projects.find(p => !p.archived && !p.stateless && p.id === deps.generateProjectId?.(lastProjectPath)) || projects.find(p => !p.archived && !p.stateless)
            : projects.find(p => !p.archived && !p.stateless)
          if (!targetProject) {
            await deps.enterNoProjectState?.({ save: false })
            return
          }
          deps.setActiveProject?.(targetProject.id)
          deps.setChatInputVisible?.(true)
          deps.setCurrentProjectPath?.(targetProject.path)
          await deps.saveProjectsList?.(targetProject.path)

          const targetData = window.api.getChatHistoryPage
            ? await window.api.getChatHistoryPage(targetProject.id, { pageChunks: 1, direction: 'older' })
            : window.api.getChatHistory
              ? await window.api.getChatHistory(targetProject.id)
              : existingProjects.find(p => p.id === targetProject.id)
          const targetMessages = targetData?.messages || targetData?.messagesHistory || []
          if (targetMessages.length > 0) {
            deps.syncProjectBranchSession?.(targetProject, { ...targetData, messagesHistory: targetMessages })
            deps.restoreRecentHistoryByRounds?.(targetMessages, targetProject.path, targetData, targetProject.id)
            targetProject.history = deps.mapMessagesHistoryForProject?.(targetMessages) || []
          } else if (targetProject) {
            targetProject.history = []
          }
        }
      }
    } catch (err) {
      console.error('[Frontend] initProjects 失败:', err)
    }

    deps.ensureActiveProject?.(localStorage.getItem('lastProjectPath') || '')
    if (!deps.hasVisibleProjects?.() || !deps.getActiveProject?.()) {
      await deps.enterNoProjectState?.({ save: false })
      return
    }
    deps.renderProjectList?.()
    deps.updateSidebarProject?.()
    const activeProjectId = deps.getActiveProjectId?.()
    if (activeProjectId) deps.loadContextStatus?.()
    if (activeProjectId) deps.refreshTerminalPanel?.(activeProjectId)
    deps.updateProjectDisplay?.()
  }

  function bind(depsObj = {}) {
    deps = depsObj
  }

  window.ProjectInit = { bind, init }
})()
