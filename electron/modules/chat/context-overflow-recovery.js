/**
 * 上下文溢出恢复：先剪工具结果中间段（不拆工具配对），必要时再交给调用方做同轮压缩。
 * 发给模型的历史窗口也可以在请求前做同一套剪枝，但必须换新对象，不能改磁盘上的完整记录。
 */

const DEFAULT_MIN_CHARS = 8192
const DEFAULT_HEAD_CHARS = 4096
const DEFAULT_TAIL_CHARS = 1024
const DEFAULT_KEEP_RECENT = 8
const SPILLED_MAX_CHARS = 1600
const PRUNE_MARKER = '[... tool result middle pruned ...]'

function clipPositive(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function clipNonNegative(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

function pruneToolResultText(text, options = {}) {
  const raw = String(text || '')
  const minChars = clipPositive(options.minChars, DEFAULT_MIN_CHARS)
  const headChars = clipPositive(options.headChars, DEFAULT_HEAD_CHARS)
  const tailChars = clipPositive(options.tailChars, DEFAULT_TAIL_CHARS)
  if (raw.length <= minChars) {
    return { text: raw, pruned: false, savedChars: 0 }
  }
  if (raw.includes(PRUNE_MARKER)) {
    return { text: raw, pruned: false, savedChars: 0 }
  }
  const head = raw.slice(0, headChars)
  const tail = raw.slice(-tailChars)
  const next = `${head}\n${PRUNE_MARKER}\n${tail}`
  if (next.length >= raw.length) {
    return { text: raw, pruned: false, savedChars: 0 }
  }
  return { text: next, pruned: true, savedChars: raw.length - next.length }
}

function compactSpilledToolContent(content, maxChars = SPILLED_MAX_CHARS) {
  const raw = String(content || '')
  if (!raw.includes('"spilled":true') && !raw.includes('"spilled": true')) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_) {
    return null
  }
  if (!parsed || parsed.spilled !== true || !parsed.spill_path) return null
  const compact = {
    success: parsed.success,
    spilled: true,
    truncated: true,
    spill_path: parsed.spill_path,
    spill_bytes: parsed.spill_bytes,
    original_chars: parsed.original_chars,
    retrieval_hint: parsed.retrieval_hint || `完整输出已写入 ${parsed.spill_path}。用 file_read 按行段读取，不要把预览当成全文。`
  }
  const next = JSON.stringify(compact)
  const limit = clipPositive(maxChars, SPILLED_MAX_CHARS)
  if (next.length >= raw.length) return null
  if (next.length <= limit) return { text: next, savedChars: raw.length - next.length }
  const pruned = pruneToolResultText(next, { minChars: limit, headChars: Math.min(900, limit - 200), tailChars: 200 })
  return { text: pruned.text, savedChars: raw.length - pruned.text.length }
}

function isPrunableToolMessage(message) {
  if (!message || typeof message.content !== 'string') return false
  if (message.role === 'tool') return true
  return Boolean(message._deepseekBridge && message.role === 'user')
}

function replaceMessageContent(messages, index, message, content, clone) {
  if (clone) {
    messages[index] = {
      ...message,
      content,
      _lingxiSource: message._lingxiSource || { kind: 'plugin', plugin: 'tool-result-pruner' }
    }
    return
  }
  message.content = content
  message._lingxiSource = message._lingxiSource || { kind: 'plugin', plugin: 'tool-result-pruner' }
}

function pruneToolResultsInMessages(messages, options = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    return { changed: false, prunedCount: 0, savedChars: 0, spilledCount: 0 }
  }
  const clone = options.clone !== false
  const keepRecent = options.forceAll === true ? 0 : clipNonNegative(options.keepRecentToolMessages, DEFAULT_KEEP_RECENT)
  const spilledMaxChars = clipPositive(options.spilledMaxChars, SPILLED_MAX_CHARS)
  const prunableIndexes = []
  for (let index = 0; index < messages.length; index += 1) {
    if (isPrunableToolMessage(messages[index])) prunableIndexes.push(index)
  }
  const protectedRecent = keepRecent > 0
    ? new Set(prunableIndexes.slice(-keepRecent))
    : new Set()
  let prunedCount = 0
  let spilledCount = 0
  let savedChars = 0

  for (const index of prunableIndexes) {
    const message = messages[index]
    const spilled = compactSpilledToolContent(message.content, spilledMaxChars)
    if (spilled) {
      replaceMessageContent(messages, index, message, spilled.text, clone)
      prunedCount += 1
      spilledCount += 1
      savedChars += spilled.savedChars
      continue
    }
    if (protectedRecent.has(index)) continue
    const result = pruneToolResultText(message.content, options)
    if (!result.pruned) continue
    replaceMessageContent(messages, index, message, result.text, clone)
    prunedCount += 1
    savedChars += result.savedChars
  }

  return { changed: prunedCount > 0, prunedCount, spilledCount, savedChars }
}

function pruneHistoricalToolResults(messages, options = {}) {
  return pruneToolResultsInMessages(messages, {
    keepRecentToolMessages: DEFAULT_KEEP_RECENT,
    clone: true,
    ...options,
    forceAll: false
  })
}

function recoverContextOverflow(messages, options = {}) {
  const pruned = pruneToolResultsInMessages(messages, {
    ...options,
    forceAll: true,
    clone: false
  })
  if (pruned.changed && pruned.savedChars >= 500) {
    return {
      advanced: true,
      method: 'tool-result-prune',
      prunedCount: pruned.prunedCount,
      savedChars: pruned.savedChars
    }
  }
  const compacted = typeof options.onCompact === 'function' ? options.onCompact() : null
  if (compacted?.compacted) {
    return {
      advanced: true,
      method: 'same-turn-compact',
      prunedCount: pruned.prunedCount,
      savedChars: pruned.savedChars,
      beforeTokens: compacted.beforeTokens,
      afterTokens: compacted.afterTokens
    }
  }
  return {
    advanced: false,
    method: 'none',
    prunedCount: pruned.prunedCount,
    savedChars: pruned.savedChars
  }
}

module.exports = {
  PRUNE_MARKER,
  DEFAULT_KEEP_RECENT,
  pruneToolResultText,
  compactSpilledToolContent,
  pruneToolResultsInMessages,
  pruneHistoricalToolResults,
  recoverContextOverflow
}
