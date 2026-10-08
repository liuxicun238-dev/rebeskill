/**
 * 灵犀能力规划器。
 *
 * 这里不执行工具，也不替代模型决策；它只在 Turn 开始时记录一份
 * 可解释的“能力预判”，供后续 capability graph / model broker 使用。
 * 这样模型路由、工具包加载和 UI 诊断都有一个稳定的事实入口。
 */

const { normalizeModel, hasCapability } = require('../model-capabilities')

const RULES = Object.freeze([
  {
    id: 'web_research',
    capability: 'webSearch',
    stableTools: ['web_search', 'web_open'],
    match: text => /搜索|查询|查找|官方|文档|网页|最新|资料|链接|search|docs|website/i.test(text)
  },
  {
    id: 'image_generation',
    capability: 'imageGeneration',
    stableTools: ['image_generate'],
    match: text => /生图|生成(?:一张|图片|图像|海报|封面|主视觉|插画)|画一张|绘制|image generation/i.test(text)
  },
  {
    id: 'vision_analysis',
    capability: 'vision',
    stableTools: ['vision_analyze'],
    match: (text, options) => options.hasImages || /分析|识别|查看|理解|截图|图片|视觉|看图/i.test(text)
  },
  {
    id: 'workspace_coding',
    capability: 'toolCalling',
    stableTools: ['file_read', 'grep', 'apply_patch', 'shell_run', 'runtime_verify'],
    match: text => /代码|项目|文件|工程|报错|修复|修改|实现|开发|重构|运行|测试|git|code|file/i.test(text)
  },
  {
    id: 'desktop_control',
    capability: 'toolCalling',
    stableTools: ['desktop_control'],
    match: text => /桌面|鼠标|键盘|点击|窗口|应用|软件|blender/i.test(text)
  }
])

function planCapabilities(options = {}) {
  const message = String(options.message || '').trim()
  const model = normalizeModel(options.modelConfig || {})
  const hasImages = Array.isArray(options.imageDataList) && options.imageDataList.length > 0
  const intents = []

  for (const rule of RULES) {
    if (!rule.match(message, { hasImages })) continue
    const currentModelSupports = hasCapability(model, rule.capability)
    intents.push({
      id: rule.id,
      capability: rule.capability,
      stableTools: [...rule.stableTools],
      currentModelSupports,
      routingRequired: !currentModelSupports && rule.capability !== 'toolCalling',
      confidence: rule.id === 'vision_analysis' && hasImages ? 'high' : 'medium'
    })
  }

  return {
    planner: 'lingxi-capability-planner-v1',
    messagePreview: message.slice(0, 300),
    intents,
    primaryIntent: intents[0]?.id || 'conversation',
    stableTools: [...new Set(intents.flatMap(item => item.stableTools))],
    routeRequired: intents.some(item => item.routingRequired),
    hasImages
  }
}

function buildCapabilityPlanPrompt(plan = {}, modelRoute = {}) {
  if (!Array.isArray(plan.intents) || plan.intents.length === 0) return ''
  const lines = [
    '===== 灵犀本轮能力预判 =====',
    '这是运行时根据本轮用户请求生成的能力线索，不是对用户的最终答复。'
  ]
  for (const intent of plan.intents) {
    const tools = intent.stableTools.join('、')
    const route = Array.isArray(modelRoute.routes)
      ? modelRoute.routes.find(item => item.intentId === intent.id)
      : null
    lines.push(
      `- ${intent.id}：优先入口 ${tools}；当前模型${intent.currentModelSupports ? '已具备该能力' : '未标注具备该能力'}。`
    )
    if (route?.mode === 'routed-model' && route.model) {
      lines.push(`  运行时已发现可路由模型：${route.model}；不要因为当前模型不支持就否认系统能力。`)
    }
    if (intent.routingRequired) {
      lines.push('  当前模型不具备时，不要直接声称系统没有能力；优先调用稳定入口或 capability_discover，由运行时路由到其他已配置模型。')
    }
  }
  lines.push('- 只有当用户目标确实需要该能力时才调用工具；如果已有上一轮真实证据，优先复用证据，不要无理由重复执行。')
  return lines.join('\n')
}

module.exports = {
  RULES,
  planCapabilities,
  buildCapabilityPlanPrompt
}
