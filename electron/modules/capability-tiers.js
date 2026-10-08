/**
 * Capability tiers for Lingxi agent tools and prompts.
 *
 * Layers:
 * - always-on core tools
 * - gated workbenches (@ mention)
 * - intent-adaptive optional packs
 * - skills as progressive-disclosure workflows (catalog + load_skill)
 *
 * Single source of truth for pack membership and gate rules.
 * model-api-adapter uses packs for adaptive tool visibility;
 * system-prompt-builder uses gates for workbench/MCP prompt sections.
 */

const { getCompositeToolsForCapability } = require('./composite-tool-contracts')

/** @typedef {'always'|'workbench'|'intent'|'mcp'|'skill'} CapabilityTier */

const WORKBENCH_TOOL_NAMES = Object.freeze([
  'blender_status',
  'blender_create_demo_model',
  'blender_run_script',
  'blender_modify_scene',
  'blender_import_asset',
  'blender_inspect_scene'
])

const MCP_TOOL_NAMES = Object.freeze(['mcp'])

/**
 * ChatGPT 网页桥接不支持原生 function calling，工具 schema 会被整段贴进输入框。
 * 只保留搜 / 看 / 改 / 命令，外加询问、计划和备忘录，避免把整份灵犀工具表塞进网页提示词。
 */
const WEB_GPT_CORE_TOOLS = Object.freeze([
  'code_inspect',
  'file_search',
  'file_read',
  'text_edit',
  'apply_patch',
  'write_file',
  'edit_file',
  'json_edit',
  'file_manage',
  'shell_run',
  'ask_user_choice',
  'enter_plan_mode',
  'confirm_plan',
  'complete_step',
  'record_ai_operation_memo',
  'load_skill',
  'project_history',
  'web_search',
  'web_open',
  'vision_analyze',
  'image_generate'
])
const WEB_GPT_CORE_TOOL_SET = new Set(WEB_GPT_CORE_TOOLS)
const WEB_GPT_OPTIONAL_TOOLS = new Set(['generate_image', 'generate_music', 'generate_video'])

function isClaudeWebBridgeModel(modelConfig = {}, modelId = '') {
  const provider = String(modelConfig.provider || '').toLowerCase()
  const text = String(modelId || modelConfig.modelId || modelConfig.model || '').toLowerCase()
  return provider === 'claude-web-bridge' || /claude-web-chat/.test(text)
}

function isGeminiWebBridgeModel(modelConfig = {}, modelId = '') {
  const provider = String(modelConfig.provider || '').toLowerCase()
  const text = String(modelId || modelConfig.modelId || modelConfig.model || '').toLowerCase()
  return provider === 'gemini-web-bridge' || /gemini-web-chat/.test(text)
}

function isGeminiSparkAgentModel(modelConfig = {}, modelId = '') {
  const provider = String(modelConfig.provider || '').toLowerCase()
  const text = String(modelId || modelConfig.modelId || modelConfig.model || '').toLowerCase()
  return provider === 'gemini-spark-web-bridge' || /gemini-spark-agent/.test(text)
}

function isChatGptWebChatVisionModel(modelConfig = {}, modelId = '') {
  const provider = String(modelConfig.provider || '').toLowerCase()
  const text = String(modelId || modelConfig.modelId || modelConfig.model || '').toLowerCase()
  if (provider !== 'chatgpt-web-bridge' && !/chatgpt-web-chat/.test(text)) return false
  return /chatgpt-web-chat/.test(text)
}

function isChatGptWebBridgeModel(modelConfig = {}, modelId = '') {
  const provider = String(modelConfig.provider || '').toLowerCase()
  const text = String(modelId || modelConfig.modelId || modelConfig.model || '').toLowerCase()
  if (/chatgpt-pro-web|grok-web-image|minimax-music-web|gemini-spark-agent/.test(text)) return false
  if (provider === 'minimax-music-web-bridge' || provider === 'gemini-spark-web-bridge') return false
  if (provider === 'chatgpt-web-bridge' || provider === 'deepseek-web-bridge' || provider === 'grok-web-bridge' || provider === 'claude-web-bridge' || provider === 'arena-web-bridge' || provider === 'qwen-web-bridge' || provider === 'gemini-web-bridge' || provider === 'genspark-web-bridge') return true
  return /chatgpt-web-chat|deepseek-web-chat|grok-web-chat|claude-web-chat|arena-web-chat|qwen-web-chat|gemini-web-chat|genspark-web-chat/.test(text)

}

function getWebGptCoreTools() {
  return WEB_GPT_CORE_TOOL_SET
}

function filterWebGptCoreTools(tools = []) {
  if (!Array.isArray(tools)) return []
  return tools.filter(tool => {
    const name = String(tool?.function?.name || tool?.name || '').trim()
    return WEB_GPT_CORE_TOOL_SET.has(name) || WEB_GPT_OPTIONAL_TOOLS.has(name)
  })
}

/**
 * High-level capability inventory for docs, prompts, and UI.
 * tools listed here are model-facing names when possible.
 */
const CAPABILITY_CATALOG = Object.freeze([
  {
    id: 'core-coding',
    tier: 'always',
    title: '核心工程',
    summary: '读搜改、命令、验证、计划、过程说明与恢复点',
    tools: [
      'show_thinking_note', 'start_final_reply', 'delegate_agents', 'shell_run', 'apply_patch', 'text_edit',
      'write_file', 'edit_file', 'json_edit', 'runtime_verify', 'dev_workflow',
      'tool_self_check', 'record_ai_operation_memo', 'enter_plan_mode', 'confirm_plan',
      'ask_user_choice', 'complete_step', 'web_bridge_search', 'load_skill', 'search_tools',
      'capability_discover', 'web_search', 'web_open', 'vision_analyze', 'image_generate'
    ]
  },
  {
    id: 'core-memory',
    tier: 'always',
    title: '记忆与历史',
    summary: '项目记忆、变更会话与 AI 备忘录',
    tools: getCompositeToolsForCapability('always').filter(name =>
      /history|memo|change|ledger|project_history/i.test(name)
    )
  },
  {
    id: 'user-workbenches',
    tier: 'user-only',
    title: '用户工作台',
    summary: 'Blender/PPT/音乐等工作台仅用户手动操作，不对模型暴露工具',
    tools: [...WORKBENCH_TOOL_NAMES, 'artifact_workflow']
  },
  {
    id: 'intent-web',
    tier: 'intent',
    title: '网页/前端/运行态',
    summary: '意图命中时加载（页面、UI、预览、可视化等）',
    tools: ['runtime_verify', 'web_search', 'web_open', 'web_bridge_search', 'lxweb', 'research_website_runtime', 'website_delivery', ...getCompositeToolsForCapability('web')]
  },
  {
    id: 'intent-media',
    tier: 'intent',
    title: '媒体生成',
    summary: '文生图/音视频等意图命中时加载',
    tools: ['image_generate', 'generate_image', 'generate_music', 'generate_video', ...getCompositeToolsForCapability('media')]
  },
  {
    id: 'intent-software',
    tier: 'intent',
    title: '本地软件',
    summary: '打开/查找本机应用',
    tools: getCompositeToolsForCapability('software')
  },
  {
    id: 'user-desktop-control',
    tier: 'user-gated',
    title: '桌面操控',
    summary: '默认关闭；设置 → 能力开关 中开启后才对模型可见',
    tools: ['desktop_control']
  },
  {
    id: 'mcp-external',
    tier: 'mcp',
    title: '外部 MCP',
    summary: '默认隐藏，需显式 @MCP；也可在能力开关中总关闭',
    tools: [...MCP_TOOL_NAMES]
  },
  {
    id: 'skill-manage',
    tier: 'skill',
    title: '技能沉淀',
    summary: '创建/安装技能草稿；执行前用 load_skill 加载 SKILL.md 全文',
    tools: getCompositeToolsForCapability('skill')
  }
])

/**
 * Adaptive tool packs used when prompt-cache does not pin full schema.
 * Keys must stay stable: always, web, vision, media, speech, workflow,
 * software, skill, runtime, analysis.
 */
function buildToolPacks() {
  return {
    always: new Set([
      'show_thinking_note',
      'start_final_reply',
      'complete_step',
      'confirm_plan',
      'ask_user_choice',
      'enter_plan_mode',
      'write_file',
      'edit_file',
      'text_edit',
      'apply_patch',
      'json_edit',
      'runtime_verify',
      'dev_workflow',
      'record_ai_operation_memo',
      'shell_run',
      'tool_self_check',
      'lxweb',
      'web_bridge_search',
      'load_skill',
      'search_tools',
      'capability_discover',
      'web_search',
      'web_open',
      'vision_analyze',
      'image_generate',
      'parallel_research',
      'delegate_agents',
      ...getCompositeToolsForCapability('always')
    ]),
    web: new Set([
      'runtime_verify',
      'website_delivery',
      'research_website_runtime',
      'create_canvas_workflow',
      ...getCompositeToolsForCapability('web')
    ]),
    vision: new Set(['runtime_verify', ...getCompositeToolsForCapability('vision')]),
    media: new Set(['generate_image', 'generate_music', 'generate_video', 'character_animation_preview', 'create_inline_visual', ...getCompositeToolsForCapability('media')]),
    speech: new Set(['text_to_speech']),
    // Workbench orchestration is user-UI only; keep pack empty so it never reappears in adaptive allow lists.
    workflow: new Set([]),
    software: new Set(['office_from_template', ...getCompositeToolsForCapability('software')]),
    skill: new Set(getCompositeToolsForCapability('skill')),
    runtime: new Set(['runtime_verify']),
    analysis: new Set(['inspect_binary'])
  }
}

const TOOL_PACKS = buildToolPacks()

const OPTIONAL_MODEL_TOOLS = new Set(
  Object.entries(TOOL_PACKS)
    .filter(([name]) => name !== 'always')
    .flatMap(([, tools]) => [...tools])
)

function hasAnyPattern(text = '', patterns = []) {
  return patterns.some(pattern => pattern.test(text))
}

function detectWorkbenchMentions(text = '') {
  const value = String(text || '')
  const hasBlender = /@(?:Blender|blender|布兰德)(?=$|[\s，。,.、:：；;])/i.test(value)
  const hasPpt = /@(?:PPT|ppt|PPT制作|ppt制作|演示文稿)(?=$|[\s，。,.、:：；;])/i.test(value)
  const hasMusic = /@(?:音乐|音乐工作台|music|Music|BGM工作台)(?=$|[\s，。,.、:：；;])/i.test(value)
  return {
    blender: hasBlender,
    ppt: hasPpt,
    music: hasMusic,
    any: hasBlender || hasPpt || hasMusic
  }
}

function getDisabledWorkbenchTools(_features = {}) {
  // Workbenches are user-operated UI only; always hide related model tools.
  return [...WORKBENCH_TOOL_NAMES, 'artifact_workflow', 'office_workflow', 'blender_workflow']
}

function detectMcpMentions(text = '') {
  const value = String(text || '')
  const hasShortMcp = /@(?:MCP|mcp)\b/.test(value)
  const hasAidev = /@(?:aidev|AIDev|AiDev|aidev[-_]prototype)\b/i.test(value)
  const hasMcpDirective = /@MCP\s*:\s*[\w-]+\s*:\s*[\w-]+/i.test(value)
  const any = hasShortMcp || hasAidev || hasMcpDirective
  return {
    aidev: any,
    any,
    raw: { hasShortMcp, hasAidev, hasMcpDirective }
  }
}

function getDisabledMcpTools(features = {}) {
  if (features && (features.aidev || features.any)) return []
  return [...MCP_TOOL_NAMES]
}

/**
 * Intent → optional packs (mirrors prior model-api-adapter heuristics, centralized).
 */
function getAdaptiveToolAllowSet(latestUserText = '', options = {}) {
  const text = String(latestUserText || '')
  const allow = new Set(TOOL_PACKS.always)
  const addPack = name => {
    for (const tool of TOOL_PACKS[name] || []) allow.add(tool)
  }

  // 桌面操控的 UIA 树并不覆盖所有自绘界面。用户显式开启桌面操控后，
  // 同时保留视觉分析入口，让模型能分析 get_window_state 返回的截图，
  // 而不是在看不到控件时猜坐标。
  try {
    if (require('./desktop-control/settings').isEnabled()) addPack('vision')
  } catch (_) { /* desktop-control is optional during early boot/tests */ }

  if (hasAnyPattern(text, [
    /网页|页面|前端|UI|界面|样式|CSS|HTML|DOM|按钮|布局|响应式|暗色|浅色|主题|截图|预览|webview|浏览器|网站|复刻|设计风格|滚动|动效|canvas|webgl|three|gsap|可视化|落地页|官网|站点|门户|主页/i,
    /website|frontend|landing|portfolio|hero|animation|visual|screenshot|responsive|layout|homepage|site delivery/i
  ])) {
    addPack('web')
    addPack('runtime')
  }

  if (hasAnyPattern(text, [
    /图片|截图|视觉|看图|上传图|图里|如图|缩略图|封面|logo|图标|画面|视频首帧/i,
    /image|screenshot|vision|thumbnail|poster|logo|icon/i
  ])) addPack('vision')

  if (hasAnyPattern(text, [
    /生成\s*图片|生成一张|文生图|出图|画一张|图片生成|海报|封面图|音乐|音频|BGM|配乐|视频生成|生成视频|素材|资产/i,
    /generate (image|music|video)|text-to-image|audio|video|asset/i,
    /可视化|可视化展示|交互图|关系图|模拟器|可调参数|示意图|流程图|仪表盘|图表交互|可视化解释/i,
    /visuali[sz]e|interactive chart|simulator|diagram|explorer/i
  ])) addPack('media')

  if (hasAnyPattern(text, [
    /运行|启动|预览|冒烟|测试|验证|构建|打包|报错|错误|崩溃|卡死|白屏|初始化失败|点击没反应|语法/i,
    /run|start|preview|smoke|test|verify|build|pack|error|crash|syntax/i
  ])) addPack('runtime')

  if (hasAnyPattern(text, [
    /打开软件|启动软件|本地软件|应用|程序|PowerPoint|Chrome|浏览器|Blender|VS Code|vscode/i,
    /open app|open software|launch/i
  ])) addPack('software')

  if (hasAnyPattern(text, [
    /skill|技能|沉淀经验|经验沉淀|学习经验|安装技能|技能草稿|\$[A-Za-z][\w-]*/i
  ])) addPack('skill')

  if (hasAnyPattern(text, [
    /朗读|语音|播报|听书|text.?to.?speech|tts|speak/i
  ])) addPack('speech')

  if (hasAnyPattern(text, [
    /二进制|逆向|PE\b|elf\b|malware|反汇编|inspect_binary/i,
    /binary analysis|disassembl/i
  ])) addPack('analysis')

  for (const pack of normalizePackIds(options.enabledPacks)) addPack(pack)

  const previousToolNames = Array.isArray(options.previousToolNames) ? options.previousToolNames : []
  for (const toolName of previousToolNames) {
    for (const [packName, tools] of Object.entries(TOOL_PACKS)) {
      if (packName !== 'always' && tools.has(toolName)) addPack(packName)
    }
  }

  return allow
}

function getAdaptiveDisabledTools(latestUserText = '', options = {}) {
  const allow = getAdaptiveToolAllowSet(latestUserText, options)
  const disabled = new Set()
  for (const name of OPTIONAL_MODEL_TOOLS) {
    if (!allow.has(name)) disabled.add(name)
  }
  return disabled
}

function getPinnedCoreDisabledTools(options = {}) {
  return getAdaptiveDisabledTools('', {
    enabledPacks: options.enabledPacks,
    previousToolNames: options.previousToolNames
  })
}

const DISCOVERABLE_PACKS = Object.freeze([
  { id: 'web', title: '网页与预览', summary: '落地页、运行态、画布工作流', keywords: '网页 页面 前端 预览 网站 落地' },
  { id: 'vision', title: '看图', summary: '识图、截图分析', keywords: '图片 截图 视觉 看图' },
  { id: 'media', title: '出图与音视频', summary: '文生图、音乐、视频、可视化', keywords: '生成图片 海报 音乐 视频 可视化' },
  { id: 'speech', title: '语音', summary: '朗读与播报', keywords: '朗读 语音 tts' },
  { id: 'software', title: '本地软件与办公模板', summary: '打开本机应用、办公套件模板', keywords: '打开软件 PowerPoint 办公 模板' },
  { id: 'skill', title: '技能草稿', summary: '创建或安装技能', keywords: '技能 沉淀 草稿' },
  { id: 'runtime', title: '运行验证', summary: '预览、冒烟、报错核查', keywords: '运行 预览 测试 验证 报错' },
  { id: 'analysis', title: '二进制分析', summary: '检查可执行文件与二进制', keywords: '二进制 逆向 PE' }
])

function normalizePackIds(value) {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return [...new Set(list.map(item => String(item || '').trim()).filter(id => id && TOOL_PACKS[id] && id !== 'always' && id !== 'workflow'))]
}

function collectToolNamesFromMessages(messages = []) {
  const names = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const calls = message.tool_calls || message.toolCalls || []
    if (!Array.isArray(calls)) continue
    for (const call of calls) {
      const name = String(call?.function?.name || call?.name || '').trim()
      if (name) names.push(name)
    }
  }
  return names
}

function describeToolPack(packId = '') {
  const id = String(packId || '').trim()
  const meta = DISCOVERABLE_PACKS.find(item => item.id === id)
  const tools = TOOL_PACKS[id]
  if (!meta || !tools) return null
  return {
    id,
    title: meta.title,
    summary: meta.summary,
    tools: [...tools].filter(name => name !== 'runtime_verify').sort()
  }
}

function searchToolPacks(query = '') {
  const text = String(query || '').trim().toLowerCase()
  const packs = DISCOVERABLE_PACKS.map(item => describeToolPack(item.id)).filter(Boolean)
  if (!text) return packs
  return packs.filter(pack => {
    const meta = DISCOVERABLE_PACKS.find(item => item.id === pack.id)
    const hay = [pack.id, pack.title, pack.summary, meta?.keywords, ...(pack.tools || [])].join(' ').toLowerCase()
    return text.split(/\s+/).filter(Boolean).every(part => hay.includes(part))
  })
}

/**
 * Short, cache-stable system-prompt section describing capability layering.
 */
function buildCapabilityLayeringPrompt(lang = 'zh-CN') {
  if (lang === 'en-US') {
    return `===== Capability layering =====
  - Always-on core: coding, search, shell, plan, verification, memory, thinking notes, capability_discover, search_tools, web_search, web_open, vision_analyze, and image_generate. These are stable provider-agnostic entry points; runtime routing chooses the configured backend/model. Prefer high-level tools (apply_patch/text_edit, shell_run, runtime_verify) over inventing ad-hoc scripts.
- Product workbenches (Blender / PPT / music panels) are user-operated only. Do not call workbench tools or pretend to drive those UIs.
- Optional packs (web/media/software/skill): not preloaded. Call search_tools to find and load a pack, then use those tools. Do not invent missing tools.
- User master switches (Settings → Capability switches) can hide desktop control, browser preview, media gen, shell, MCP, etc. If a tool is missing, do not invent it; ask the user to enable it in settings when needed.
- Skills: workflows and domain playbooks. Read SKILL.md fully before acting; do not invent new tool names for a skill.
- Preferred engineering skills when relevant: engineering-flow, write-plan, systematic-debug, verify-before-done.
- External MCP: only after explicit @MCP/@aidev, and only if not master-disabled.`
  }
  return `===== 能力分层（工具加载策略） =====
  - 核心层始终可用，包含 capability_discover、search_tools，以及稳定的 web_search、web_open、vision_analyze、image_generate 入口。模型不需要知道底层 Provider 或动态工具包名称；由运行时自动路由。冷门能力（音乐、视频、办公模板、二进制等）再先发现并 load。工具包加载状态会保留到后续项目轮次；缺工具时不要编造。
- 产品工作台（Blender/PPT/音乐）仅用户手动操作，不是 AI 工具。
- 技能与剧本渐进展开：发现只用名称+短描述；命中后才加载完整 SKILL.md / 本轮短链。工程技能优先 engineering-flow、write-plan、systematic-debug、verify-before-done。
- 用户总开关可隐藏桌面操控、浏览器、媒体、终端、MCP 等。外部 MCP 需显式 @MCP/@aidev。`
}

/**
 * Skill progressive-disclosure rules.
 */
function buildSkillUsagePrompt(lang = 'zh-CN') {
  if (lang === 'en-US') {
    return `===== How to use skills =====
- Discovery: when a Skills list is present, use only listed skills (name + description + source).
- Trigger: if the user names a skill ($Name or plain text) or the task clearly matches a skill description, use that skill this turn.
- Progressive disclosure: read the full SKILL.md before task actions; follow references/ yourself; do not delegate skill-instruction reading to a sub-agent.
- Missing skill: say briefly and continue with the best fallback.`
  }
  return `===== 技能使用规则（Codex 渐进展开） =====
- 发现：只用列表中的 name + 短 description（控制体积，勿预载全文）。
- 触发：用户点名（$SkillName）或任务明显匹配 description 时，本回合先读完整 SKILL.md 再动手。
- 引用 references/ 由主会话读取；禁止把“读 skill”丢给子协作。
- 技能只补充做法，不能覆盖安全、授权、最新用户目标与路径规则。`
}

function describeActiveCapabilities(features = {}, options = {}) {
  const enabled = []
  if (features.mcp?.any || features.mcp?.aidev) enabled.push('@MCP')
  if (options.skillActive) enabled.push('技能')
  return enabled
}

module.exports = {
  CAPABILITY_CATALOG,
  WORKBENCH_TOOL_NAMES,
  MCP_TOOL_NAMES,
  WEB_GPT_CORE_TOOLS,
  isChatGptWebBridgeModel,
  isClaudeWebBridgeModel,
  isGeminiWebBridgeModel,
  isGeminiSparkAgentModel,
  isChatGptWebChatVisionModel,
  getWebGptCoreTools,
  filterWebGptCoreTools,
  TOOL_PACKS,
  OPTIONAL_MODEL_TOOLS,
  detectWorkbenchMentions,
  getDisabledWorkbenchTools,
  detectMcpMentions,
  getDisabledMcpTools,
  getAdaptiveToolAllowSet,
  getAdaptiveDisabledTools,
  getPinnedCoreDisabledTools,
  collectToolNamesFromMessages,
  searchToolPacks,
  describeToolPack,
  DISCOVERABLE_PACKS,
  buildCapabilityLayeringPrompt,
  buildSkillUsagePrompt,
  describeActiveCapabilities,
  hasAnyPattern
}
