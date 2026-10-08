const { normalizeModel } = require('../model-capabilities')

function buildCurrentModelCapabilityPrompt(modelConfig = {}) {
  const normalized = normalizeModel(modelConfig)
  const capabilities = normalized.capabilities || {}
  const labels = {
    text: '文本',
    toolCalling: '工具调用',
    vision: '视觉理解',
    imageGeneration: '图片生成',
    musicGeneration: '音乐生成',
    videoGeneration: '视频生成',
    speechSynthesis: '语音合成',
    webSearch: '搜索调用'
  }
  const enabled = []
  const disabled = []
  for (const [key, label] of Object.entries(labels)) {
    if (capabilities[key]) enabled.push(label)
    else disabled.push(label)
  }
  return [
    '===== 当前模型能力标注 =====',
    `当前模型：${normalized.modelName || normalized.modelId || '未命名模型'}`,
    `已标注具备：${enabled.join('、') || '无'}`,
    `未标注具备：${disabled.join('、') || '无'}`,
    '- 回答“我是否具备视觉/图片/音乐/视频/搜索能力”时，必须以这里的能力标注为准。',
    '- 当前对话模型是协调器，不等于系统只有它自己；未标注的能力可能由其他已配置模型通过能力路由执行。',
    '- 当任务明显需要搜索、官方文档、视觉分析或图片生成时，不要先说“没有工具”；优先直接调用 web_search、web_open、vision_analyze、image_generate 这些稳定入口，或调用 capability_discover 查询可用路由。',
    '- 如果 capability_discover 返回 required_pack，先用 search_tools 查找并加载对应工具包，再在下一次模型调用中使用返回的 stable_tools；稳定入口本身不需要先加载工具包。',
    '- 如果“视觉理解”已标注具备：用户上传图片会直接发给当前模型分析。',
    '- 如果“视觉理解”未标注具备：需要理解图片时，只能在用户确认后借用已配置的视觉模型。',
    '- 如果当前或其他模型已标注“搜索调用”：公开检索请调用 web_search，由运行时路由到该搜索模型。关闭网页桥搜索不会关闭这些搜索模型；不要改用 lxweb 或 web_bridge_search，除非 web_search 已经失败。当前模型没有搜索能力不代表系统没有搜索能力。'
  ].join('\n')
}

module.exports = { buildCurrentModelCapabilityPrompt }
