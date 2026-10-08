const handlers = {
  capability_discover: async (args = {}, ctx = {}) => {
    const storageConfig = require('../storage-config')
    const capabilityCatalog = require('../lingxi-harness/capability-catalog')
    const query = String(args.query || args.q || '').trim()
    const apiConfig = storageConfig.getApiConfig()
    const models = apiConfig?.success && Array.isArray(apiConfig.data?.models)
      ? apiConfig.data.models
      : []
    const capabilities = capabilityCatalog.discoverCapabilities({
      query: args.query || args.q || '',
      modelConfig: ctx.modelConfig,
      availableModels: models,
      includeRoutes: args.include_routes !== false
    })
    return {
      success: true,
      query: args.query || args.q || '',
      capabilities,
      loaded_packs: Array.isArray(ctx.options?.enabledPacks) ? ctx.options.enabledPacks : [],
      harness_catalog: capabilityCatalog.discover({
        query: args.query || args.q || '',
        modelConfig: ctx.modelConfig,
        availableModels: models,
        enabledPacks: ctx.options?.enabledPacks
      }),
      hint: '当前对话模型只是协调器；能力可以路由到其他已配置模型。工具未加载不等于系统没有能力。'
    }
  },
  tool_self_check: async (args, ctx) => {
    const { runToolSelfCheck } = require('../tool-self-check')
    return runToolSelfCheck(args || {}, ctx || {})
  },
  create_skill_draft: async (args, ctx) => {
    const projectSkillDrafts = require('../project-skill-drafts')
    return projectSkillDrafts.createSkillDraft(args || {}, ctx || {})
  },
  install_skill_draft: async (args, ctx) => {
    const projectSkillDrafts = require('../project-skill-drafts')
    return projectSkillDrafts.installSkillDraft(args || {}, ctx || {})
  },
  list_skill_drafts: async (args, ctx) => {
    const projectSkillDrafts = require('../project-skill-drafts')
    const projectPath = ctx?.projectPath || args?.projectPath || ''
    const scope = String(args?.scope || '').trim().toLowerCase()
    const globalDrafts = projectSkillDrafts.listSkillDrafts(projectPath, 'global')
    const projectDrafts = projectPath ? projectSkillDrafts.listSkillDrafts(projectPath, 'project') : []
    return {
      success: true,
      drafts: scope === 'project' ? projectDrafts : scope === 'global' ? globalDrafts : globalDrafts,
      globalDrafts,
      projectDrafts,
      skills: projectSkillDrafts.listProjectSkills(projectPath)
    }
  },
  load_skill: async (args, ctx) => {
    const skills = require('../skills')
    const selectedName = String(
      ctx?.options?.selectedSkillName ||
      ctx?.options?.skillName ||
      ''
    ).trim()
    return skills.loadSkillBody(args?.name || args?.skill || args?.skill_name, ctx?.projectPath || '', {
      selectedName
    })
  },
  search_tools: async (args = {}, ctx = {}) => {
    const capabilityTiers = require('../capability-tiers')
    const capabilityCatalog = require('../lingxi-harness/capability-catalog')
    const { MODEL_TOOLS_SCHEMA } = require('../schemas')
    const action = String(args.action || (args.pack ? 'load' : 'search')).trim().toLowerCase()
    const query = String(args.query || args.q || '').trim()
    const getToolSpecs = names => {
      const wanted = new Set((Array.isArray(names) ? names : []).map(name => String(name || '').trim()))
      return MODEL_TOOLS_SCHEMA
        .filter(tool => wanted.has(String(tool.function?.name || '').trim()))
        .map(tool => ({
          name: tool.function?.name || '',
          description: tool.function?.description || '',
          parameters: tool.function?.parameters || {}
        }))
    }
    if (action === 'load') {
      const pack = capabilityCatalog.describePack(args.pack || args.id || query)
      if (!pack) {
        return {
          success: false,
          error: '未知工具包。先 search_tools action=search，再使用返回的 id 调用 load。',
          packs: capabilityCatalog.searchPacks(query)
        }
      }
      const enableToolPack = typeof ctx.options?.enableToolPack === 'function'
        ? ctx.options.enableToolPack
        : (typeof ctx.enableToolPack === 'function' ? ctx.enableToolPack : null)
      const harnessCatalog = capabilityCatalog.loadPack(pack.id, { enableToolPack })
      if (typeof ctx.options?.recordHarnessEvent === 'function') {
        ctx.options.recordHarnessEvent('capability_pack_loaded', {
          packId: pack.id,
          tools: pack.tools,
          source: 'search_tools'
        })
      }
      return {
        success: true,
        loaded: pack.id,
        title: pack.title,
        tools: pack.tools,
        tool_specs: getToolSpecs(pack.tools),
        harness_catalog: harnessCatalog,
        persistent: harnessCatalog.persistent === true,
        hint: '本轮下一次模型调用即可使用这些工具，后续项目轮次也会保留；不必再编造工具名。'
      }
    }
    const packs = capabilityCatalog.searchPacks(query)
    const hints = []
    if (/mcp|aidev/i.test(query)) hints.push('外部 MCP 不是工具包，需要用户在输入里写 @MCP。')
    if (/blender|ppt|音乐工作台/i.test(query)) hints.push('Blender / PPT / 音乐是用户工作台，不能当模型工具加载。')
    if (/桌面|desktop_control/i.test(query)) hints.push('桌面操控在 设置 → 能力开关 中打开后才可见。')
    return {
      success: true,
      packs,
      harness_catalog: capabilityCatalog.discover({
        query,
        enabledPacks: ctx.options?.enabledPacks
      }),
      tool_specs: packs.flatMap(pack => getToolSpecs(pack.tools)),
      hints,
      hint: packs.length ? '需要某个包时再 search_tools action=load，pack 用上面的 id；加载状态会保留到后续项目轮次。' : '没有匹配的工具包。可换关键词，或只用常驻的读/改/命令/提问。'
    }
  }
}

module.exports = {
  handlers
}
