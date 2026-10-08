/**
 * LingXi Capability Catalog
 * -------------------------
 *
 * 统一包装稳定能力和按需工具包。具体 handler/schema 仍由旧模块提供，
 * 但模型、诊断和 UI 通过这里看到同一份能力目录。
 */

const capabilityTiers = require('../capability-tiers')
const { hasCapability, normalizeModel } = require('../model-capabilities')
const { planModelRoutes } = require('./model-broker')

const AUTO_PREPARE_RULES = Object.freeze([
  {
    packId: 'media',
    reason: '检测到音乐、音频、视频或动画生成意图',
    match: text => /音乐|音频|配乐|背景音乐|BGM|视频生成|生成视频|动画|角色动画|generate\s+(music|video)|audio|video|animation/i.test(text)
  },
  {
    packId: 'analysis',
    reason: '检测到二进制或逆向分析意图',
    match: text => /二进制|逆向|反汇编|PE\b|ELF\b|malware|binary\s+analysis|disassembl/i.test(text)
  }
])

// 兼容 capability_discover 旧响应格式的唯一事实源。
// 对外仍保留旧 id（例如 web_search），同时补充 catalog_id 供新 Harness 使用。
const DISCOVERY_CAPABILITIES = Object.freeze([
  {
    id: 'web_search',
    catalogId: 'web_research',
    title: '网页搜索与官方文档',
    keywords: ['搜索', '网页', '官方', '文档', '最新', '资料', 'web', 'search', 'docs'],
    tools: ['web_search', 'web_open', 'web_bridge_search', 'lxweb'],
    stableTools: ['web_search', 'web_open'],
    modelCapability: 'webSearch',
    nextAction: '公开检索调用 web_search；已知网址、官方文档正文或页内查找调用 web_open。失败时再使用兼容入口。'
  },
  {
    id: 'vision',
    catalogId: 'vision',
    title: '视觉理解与截图分析',
    keywords: ['图片', '截图', '视觉', '识图', '看图', 'vision', 'image'],
    tools: ['vision_analyze', 'inspect_image'],
    stableTools: ['vision_analyze'],
    modelCapability: 'vision',
    nextAction: '调用 vision_analyze；系统会按路由选择当前模型或其他视觉模型。'
  },
  {
    id: 'image_generation',
    catalogId: 'image_generation',
    title: '图片生成',
    keywords: ['生图', '生成图片', '出图', '海报', '封面', '主视觉', '插画', 'image generation'],
    tools: ['image_generate', 'generate_image'],
    stableTools: ['image_generate'],
    modelCapability: 'imageGeneration',
    nextAction: '调用 image_generate；系统会自动路由到已配置的图片生成模型。只有需要音乐/视频等其他媒体工具时才加载 media 工具包。'
  },
  {
    id: 'music_generation',
    catalogId: 'music_generation',
    title: '音乐生成',
    keywords: ['音乐', '音频', '配乐', 'bgm', 'music'],
    tools: ['generate_music'],
    stableTools: [],
    modelCapability: 'musicGeneration',
    pack: 'media',
    nextAction: '先加载 media 工具包，再调用 generate_music。'
  },
  {
    id: 'video_generation',
    catalogId: 'video_generation',
    title: '视频生成',
    keywords: ['视频', '动画', 'video'],
    tools: ['generate_video'],
    stableTools: [],
    modelCapability: 'videoGeneration',
    pack: 'media',
    nextAction: '先加载 media 工具包，再调用 generate_video。'
  }
])

const STABLE_CAPABILITIES = Object.freeze([
  ...DISCOVERY_CAPABILITIES
    .filter(item => !item.pack)
    .map(item => ({
      id: item.catalogId,
      title: item.title,
      stableTools: item.stableTools,
      modelCapability: item.modelCapability
    }))
])

function getStableCapabilities(options = {}) {
  const currentModel = normalizeModel(options.modelConfig || {})
  const routes = planModelRoutes({
    intents: STABLE_CAPABILITIES.map(item => ({
      id: item.id,
      capability: item.modelCapability,
      stableTools: item.stableTools
    }))
  }, {
    currentModel,
    availableModels: options.availableModels
  }).routes

  return STABLE_CAPABILITIES.map(item => {
    const route = routes.find(candidate => candidate.intentId === item.id)
    const currentModelSupports = hasCapability(currentModel, item.modelCapability)
    return {
      id: item.id,
      title: item.title,
      stable_tools: [...item.stableTools],
      available: true,
      current_model_supports: currentModelSupports,
      route_mode: route?.mode || 'stable-entrypoint',
      routed_model: route?.model || '',
      model_capability: item.modelCapability
    }
  })
}

function discoverCapabilities(options = {}) {
  const query = String(options.query || '').trim().toLowerCase()
  const queryParts = query.split(/\s+/).filter(Boolean)
  const currentModel = normalizeModel(options.modelConfig || {})
  const models = Array.isArray(options.availableModels) ? options.availableModels : []
  const includeRoutes = options.includeRoutes !== false

  const matches = definition => {
    if (!queryParts.length) return true
    const haystack = [
      definition.id,
      definition.catalogId,
      definition.title,
      ...definition.keywords,
      ...definition.tools
    ].join(' ').toLowerCase()
    const intentMatch = (
      (definition.id === 'image_generation' && /生成|生图|出图|画一张|绘制/.test(query) && /图片|图像|海报|封面|主视觉|插画|图/.test(query)) ||
      (definition.id === 'web_search' && /搜索|查询|查找|官方|文档|网页|最新|资料|search|docs/.test(query)) ||
      (definition.id === 'vision' && /分析|识别|查看|理解|截图|图片|视觉|看图/.test(query))
    )
    return queryParts.some(part => haystack.includes(part)) ||
      definition.keywords.some(keyword => query.includes(String(keyword).toLowerCase())) ||
      definition.title.toLowerCase().split(/\s+/).some(part => query.includes(part)) ||
      intentMatch
  }

  return DISCOVERY_CAPABILITIES
    .filter(matches)
    .map(definition => {
      const candidates = models
        .map(model => normalizeModel(model))
        .filter(model => definition.modelCapability && hasCapability(model, definition.modelCapability))
        .map(model => model.modelName || model.modelId || model.provider)
        .filter(Boolean)
        .slice(0, 5)
      const currentModelSupports = hasCapability(currentModel, definition.modelCapability)
      return {
        id: definition.id,
        catalog_id: definition.catalogId,
        title: definition.title,
        available: true,
        backend_configured: currentModelSupports || candidates.length > 0,
        current_model_supports: currentModelSupports,
        stable_tools: [...definition.stableTools],
        tools: [...definition.tools],
        required_pack: definition.pack || null,
        ...(includeRoutes ? { routed_model_candidates: candidates } : {}),
        next_action: definition.nextAction
      }
    })
}

function searchPacks(query = '') {
  return capabilityTiers.searchToolPacks(query)
}

function describePack(packId = '') {
  return capabilityTiers.describeToolPack(packId)
}

function loadPack(packId, options = {}) {
  const pack = describePack(packId)
  if (!pack) {
    return {
      success: false,
      error: '未知工具包。先搜索能力目录，再使用返回的 id 加载。',
      packs: searchPacks(options.query || '')
    }
  }
  const persisted = typeof options.enableToolPack === 'function'
    ? options.enableToolPack(pack.id) !== false
    : false
  return {
    success: true,
    loaded: pack.id,
    title: pack.title,
    tools: pack.tools,
    persistent: persisted,
    catalog: 'lingxi-capability-catalog-v1'
  }
}

function discover(options = {}) {
  const query = String(options.query || '').trim()
  const loadedPacks = Array.isArray(options.enabledPacks) ? options.enabledPacks : []
  return {
    catalog: 'lingxi-capability-catalog-v1',
    stable_capabilities: getStableCapabilities(options),
    packs: searchPacks(query),
    loaded_packs: loadedPacks,
    hint: '稳定能力直接调用 stable_tools；冷门能力先搜索工具包，再调用 loadPack 或 search_tools action=load。'
  }
}

/**
 * 在模型真正请求前，根据用户意图预热能力。
 *
 * 预热只负责让工具在本轮可见、并把冷包状态持久化；不会代替模型执行
 * 生图、发起协作、运行命令等有副作用的动作。稳定入口（搜索、看图、
 * 生图）不需要先加载工具包。
 */
function resolveForTurn(options = {}) {
  const message = String(options.message || options.query || '').trim()
  const enabledPacks = [...new Set(
    (Array.isArray(options.enabledPacks) ? options.enabledPacks : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]
  const autoPrepare = options.autoPrepare !== false
  const autoPrepared = []
  if (autoPrepare) {
    for (const rule of AUTO_PREPARE_RULES) {
      if (!rule.match(message) || enabledPacks.includes(rule.packId)) continue
      const pack = describePack(rule.packId)
      if (!pack) continue
      const loaded = loadPack(rule.packId, {
        enableToolPack: options.enableToolPack
      })
      if (!loaded.success) continue
      autoPrepared.push({
        packId: rule.packId,
        title: pack.title,
        tools: pack.tools,
        reason: rule.reason,
        persistent: loaded.persistent === true
      })
      enabledPacks.push(rule.packId)
    }
  }

  const stableCapabilities = getStableCapabilities({
    modelConfig: options.modelConfig,
    availableModels: options.availableModels
  })
  const stableTools = stableCapabilities.flatMap(item => item.stable_tools)
  const packTools = enabledPacks.flatMap(packId => describePack(packId)?.tools || [])
  const confirmations = autoPrepared
    .filter(item => item.packId === 'media')
    .map(item => ({
      capability: item.packId,
      reason: '媒体生成可能产生外部模型调用或费用，执行前仍遵守现有确认和权限策略。'
    }))

  return {
    catalog: 'lingxi-capability-catalog-v1',
    message,
    stable_capabilities: stableCapabilities,
    stable_tools: [...new Set(stableTools)],
    enabled_packs: [...new Set(enabledPacks)],
    prepared_packs: autoPrepared,
    tools_to_expose: [...new Set([...stableTools, ...packTools])],
    confirmations,
    auto_prepare: autoPrepare,
    planner: 'intent-driven-capability-preparation-v1'
  }
}

/**
 * 给模型上下文使用的短目录。
 *
 * 这不是工具 schema 的替代品，而是一个稳定、低体积的“能力地图”：
 * 新开一轮、切换项目或工具包按需加载后，模型仍然能知道系统有哪些
 * provider-agnostic 入口，以及下一步应该调用哪个发现/加载动作。
 */
function buildPrompt(options = {}) {
  const query = String(options.query || '').trim()
  const stable = getStableCapabilities({
    modelConfig: options.modelConfig,
    // 上下文提示不应因为读取全局模型配置而产生副作用或警告；真实执行
    // 时由 model-broker/capability-tools 使用完整模型目录完成路由。
    availableModels: Array.isArray(options.availableModels) ? options.availableModels : []
  })
  const matchedPacks = searchPacks(query).slice(0, 4)
  const stableLines = stable.map(item => {
    const route = item.routed_model
      ? `（当前路由：${item.routed_model}）`
      : '（由运行时自动路由）'
    return `- ${item.id}：${item.title}；直接调用 ${item.stable_tools.join('、')}${route}`
  })
  const loaded = [...new Set(
    (Array.isArray(options.enabledPacks) ? options.enabledPacks : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )]
  const prepared = Array.isArray(options.capabilityResolution?.prepared_packs)
    ? options.capabilityResolution.prepared_packs
    : []
  const packLines = matchedPacks.length
    ? matchedPacks.map(pack => `- ${pack.id}：${pack.title}（${pack.tools.slice(0, 8).join('、')}）`)
    : ['- 当前消息没有匹配到额外工具包；需要冷门能力时先调用 search_tools action=search。']
  return [
    '===== 灵犀能力目录（LingXi Harness） =====',
    '这是运行时能力地图，不要因为当前聊天模型未标注某项能力就回答“系统没有该能力”。',
    ...stableLines,
    loaded.length
      ? `- 已加载工具包（跨本轮/项目轮次保留）：${loaded.join('、')}`
      : '- 当前没有额外加载工具包。',
    ...prepared.map(item =>
      `- 本轮已自动准备：${item.packId}（${item.reason}）；工具已可见，但不会绕过执行确认。`
    ),
    '冷门能力流程：先调用 search_tools action=search；再用返回的 pack id 调用 action=load；加载成功后下一次模型调用即可使用返回的工具。',
    '稳定入口不需要先加载工具包。用户明确要求搜索、打开网页、看图或生图时，直接调用对应稳定入口，不要先声明“没有工具”。',
    ...(query ? ['本轮相关工具包：', ...packLines] : [])
  ].join('\n')
}

module.exports = {
  STABLE_CAPABILITIES,
  DISCOVERY_CAPABILITIES,
  AUTO_PREPARE_RULES,
  getStableCapabilities,
  discoverCapabilities,
  searchPacks,
  describePack,
  loadPack,
  discover,
  resolveForTurn,
  buildPrompt
}
