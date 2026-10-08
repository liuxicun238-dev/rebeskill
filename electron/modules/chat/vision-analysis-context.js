/**
 * Durable image-analysis facts for later turns and context compression.
 * Pixel payloads can expire; the text conclusion must not.
 */

const VISION_ANALYSIS_MARKERS = /【(?:图片分析|视觉模型分析结果)】/
const DEFAULT_SUMMARY_LIMIT = 1600

function clipText(text, maxLength = DEFAULT_SUMMARY_LIMIT) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return ''
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(1, maxLength - 3)).trim()}...`
}

function uniqueTexts(list = []) {
  const seen = new Set()
  const result = []
  for (const item of list) {
    const text = String(item || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

function parseMaybeJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function formatVisionAnalysisBlock(analysis = {}, extra = {}) {
  const summary = clipText(analysis.summary || '', extra.maxSummaryLength || DEFAULT_SUMMARY_LIMIT)
  if (!summary) return ''
  const model = String(analysis.model || extra.model || '').trim()
  const names = []
  for (const name of [
    extra.name,
    ...(Array.isArray(analysis.imageNames) ? analysis.imageNames : [])
  ]) {
    const next = String(name || '').trim()
    if (next && !names.includes(next)) names.push(next)
  }
  const lines = ['【图片分析】']
  if (model) lines.push(`分析模型：${model}`)
  if (names.length) lines.push(`图片：${names.slice(0, 8).join('、')}`)
  lines.push(summary)
  return lines.join('\n')
}

function compactVisionAnalysis(analysis, maxSummaryLength = DEFAULT_SUMMARY_LIMIT) {
  if (!analysis || typeof analysis !== 'object') return null
  const summary = clipText(analysis.summary, maxSummaryLength)
  if (!summary) return null
  const imageNames = Array.isArray(analysis.imageNames)
    ? analysis.imageNames.map(name => String(name || '').trim().slice(0, 120)).filter(Boolean).slice(0, 8)
    : []
  return {
    model: String(analysis.model || '').trim().slice(0, 80),
    summary,
    imageNames,
    analyzedAt: analysis.analyzedAt || undefined,
    compacted: true
  }
}

function collectVisionAnalysisBlocks(message = {}, options = {}) {
  const blocks = []
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  for (const att of attachments) {
    const va = att?.visionAnalysis
    if (!va || !va.summary) continue
    blocks.push(formatVisionAnalysisBlock(va, {
      name: att.name || att.path,
      maxSummaryLength: options.maxSummaryLength
    }))
  }

  const toolName = String(message.name || message.toolName || '').trim()
  const parsed = parseMaybeJson(message.content)
  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  const kind = String(result?.kind || result?.file_type || '')
  if (
    (message.role === 'tool' || toolName === 'inspect_image') &&
    result &&
    (kind === 'vision_inspection' || kind === 'image_analysis') &&
    result.summary
  ) {
    blocks.push(formatVisionAnalysisBlock({
      model: result.modelName || result.model,
      summary: result.summary,
      imageNames: result.imageNames
    }, {
      name: result.path,
      maxSummaryLength: options.maxSummaryLength
    }))
  }

  return uniqueTexts(blocks)
}

function collectVisionAnalysesFromHistory(messages = [], options = {}) {
  const blocks = []
  for (const message of Array.isArray(messages) ? messages : []) {
    blocks.push(...collectVisionAnalysisBlocks(message, options))
  }
  return uniqueTexts(blocks).slice(0, 8)
}

function contentTextOf(message = {}) {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    return String(part?.text || part?.content || '')
  }).join('\n')
}

function messageAlreadyHasVisionAnalysisText(message = {}) {
  return VISION_ANALYSIS_MARKERS.test(contentTextOf(message))
}

function appendTextToContent(content, block) {
  const text = String(block || '').trim()
  if (!text) return content
  if (typeof content === 'string' || content == null) {
    const base = String(content || '').trim()
    if (!base || base === '[图片]' || base === '[图片上下文已过期]') return text
    return `${base}\n\n${text}`
  }
  if (Array.isArray(content)) {
    const next = content.slice()
    next.push({ type: 'text', text })
    return next
  }
  return text
}

function withVisionAnalysisForModel(message) {
  if (!message) return message
  const blocks = collectVisionAnalysisBlocks(message)
  if (!blocks.length || messageAlreadyHasVisionAnalysisText(message)) return message
  return {
    ...message,
    content: appendTextToContent(message.content, blocks.join('\n\n'))
  }
}

function replaceImageUrlsWithAnalysis(message) {
  if (!message || !Array.isArray(message.content)) return message
  const analysisText = collectVisionAnalysisBlocks(message).join('\n\n')
  let replaced = false
  const nextContent = message.content.map(part => {
    if (!(part && part.type === 'image_url')) return part
    if (replaced) return null
    replaced = true
    return { type: 'text', text: analysisText || '[图片]' }
  }).filter(Boolean)
  if (!nextContent.length) {
    nextContent.push({ type: 'text', text: analysisText || '[图片]' })
  }
  return { ...message, content: nextContent }
}

module.exports = {
  DEFAULT_SUMMARY_LIMIT,
  clipText,
  formatVisionAnalysisBlock,
  compactVisionAnalysis,
  collectVisionAnalysisBlocks,
  collectVisionAnalysesFromHistory,
  messageAlreadyHasVisionAnalysisText,
  withVisionAnalysisForModel,
  replaceImageUrlsWithAnalysis
}
