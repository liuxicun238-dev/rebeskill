const {
  compactVisionAnalysis,
  collectVisionAnalysisBlocks,
  withVisionAnalysisForModel,
  replaceImageUrlsWithAnalysis
} = require('./vision-analysis-context')

// 清理历史中超过 N 轮的「模型侧」图片像素：
// - 剥离 content 里的 image_url（base64，体积大）
// - 把 visionAnalysis 收成短文本结论，供后续轮次和压缩摘要继续使用
// - 保留 path/name/type 轻量字段，供 UI 历史缩略图懒加载
function stripImageAttachments(message) {
  if (!message) return false
  let changed = false
  if (Array.isArray(message.content)) {
    const filtered = message.content.filter(function (part) { return !(part && part.type === 'image_url') })
    if (filtered.length !== message.content.length) changed = true
    message.content = filtered.length > 0
      ? filtered
      : [{ type: 'text', text: '[图片上下文已过期]' }]
  }
  if (Array.isArray(message.attachments)) {
    for (let i = 0; i < message.attachments.length; i++) {
      const att = message.attachments[i]
      if (!att || typeof att !== 'object') continue
      if (att.visionAnalysis) {
        const compacted = compactVisionAnalysis(att.visionAnalysis)
        if (!compacted) {
          delete att.visionAnalysis
          changed = true
        } else if (
          compacted.summary !== att.visionAnalysis.summary ||
          compacted.compacted !== att.visionAnalysis.compacted
        ) {
          att.visionAnalysis = compacted
          changed = true
        }
      }
      if (att.thumb || att.dataUrl || att.data) {
        delete att.thumb
        delete att.dataUrl
        delete att.data
        changed = true
      }
    }
  }
  return changed
}

function pruneExpiredImageAttachments(messagesHistory, keepRecentUserMessages = 4, state = null) {
  if (!Array.isArray(messagesHistory) || messagesHistory.length === 0) return false
  if (!Number.isFinite(keepRecentUserMessages) || keepRecentUserMessages <= 0) return false
  let userCount = 0
  let firstKeptUserIndex = -1
  for (let i = messagesHistory.length - 1; i >= 0; i--) {
    if (messagesHistory[i] && messagesHistory[i].role === 'user') {
      userCount++
      if (userCount === keepRecentUserMessages) {
        firstKeptUserIndex = i
        break
      }
    }
  }
  if (firstKeptUserIndex <= 0) return false

  const previousBoundary = state && state.history === messagesHistory
    ? Number(state.firstKeptUserIndex)
    : NaN
  const scanStart = Number.isInteger(previousBoundary) && previousBoundary >= 0 && previousBoundary <= firstKeptUserIndex
    ? previousBoundary
    : 0
  let changed = false
  for (let i = scanStart; i < firstKeptUserIndex; i++) {
    changed = stripImageAttachments(messagesHistory[i]) || changed
  }
  if (state && typeof state === 'object') {
    state.history = messagesHistory
    state.firstKeptUserIndex = firstKeptUserIndex
  }
  return changed
}

// 按当前模型能力规范化历史中的图片上下文（只改请求副本，不写回持久历史）：
// - 视觉模型且仍有 image_url：保留原图
// - 非视觉模型：把 image_url 换成分析结论
// - 像素已过期但 attachments 里还有分析：把结论补回正文，避免压缩后断层
function normalizeFullHistoryForModel(fullHistory, currentModelHasVision, currentHistoryIndex) {
  if (!Array.isArray(fullHistory)) return
  for (let i = 0; i < fullHistory.length; i++) {
    if (i === currentHistoryIndex) continue
    const msg = fullHistory[i]
    if (!msg) continue
    const hasImageUrl = Array.isArray(msg.content) && msg.content.some(part => part && part.type === 'image_url')
    if (hasImageUrl && currentModelHasVision) continue
    if (hasImageUrl) {
      fullHistory[i] = replaceImageUrlsWithAnalysis(msg)
      continue
    }
    if (collectVisionAnalysisBlocks(msg).length) {
      const next = withVisionAnalysisForModel(msg)
      if (next !== msg) fullHistory[i] = next
    }
  }
}

module.exports = { pruneExpiredImageAttachments, normalizeFullHistoryForModel, stripImageAttachments }
