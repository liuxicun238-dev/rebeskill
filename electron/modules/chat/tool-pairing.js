/**
 * 工具调用与结果的配对边界。压缩和裁剪只切在配对完整处，
 * 不靠事后补合成 tool 结果来“修”一次非法切开。
 */

function isSkippedPairingMessage(message) {
  return !message || message.type === 'compression-divider'
}

function listToolCallIds(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return []
  return message.tool_calls
    .map(item => String(item?.id || '').trim())
    .filter(Boolean)
}

function isVisibleUserBoundary(message) {
  return Boolean(
    message &&
    message.role === 'user' &&
    !message.hidden &&
    message.type !== 'compression-divider' &&
    !message._deepseekBridge &&
    !message.deepseekBridge
  )
}

function inspectPairingRange(history = [], startIndex = 0, exclusiveEnd = 0) {
  const start = Math.max(0, startIndex)
  const end = Math.max(start, Math.min(Number(exclusiveEnd) || 0, history.length))
  const openIds = new Set()
  const orphanResultIds = []
  for (let index = start; index < end; index += 1) {
    const message = history[index]
    if (isSkippedPairingMessage(message)) continue
    if (message.role === 'assistant') {
      for (const id of listToolCallIds(message)) openIds.add(id)
      continue
    }
    if (message.role !== 'tool') continue
    const id = String(message.tool_call_id || '').trim()
    if (!id) continue
    if (openIds.has(id)) openIds.delete(id)
    else orphanResultIds.push(id)
  }
  return {
    startIndex: start,
    exclusiveEnd: end,
    openIds: [...openIds],
    orphanResultIds,
    balanced: openIds.size === 0 && orphanResultIds.length === 0
  }
}

function isPairingBalanced(history = [], startIndex = 0, exclusiveEnd = 0) {
  return inspectPairingRange(history, startIndex, exclusiveEnd).balanced
}

function isUserTurnExclusiveEnd(history = [], exclusiveEnd = 0) {
  if (exclusiveEnd >= history.length) return true
  return isVisibleUserBoundary(history[exclusiveEnd])
}

/**
 * 把候选切开点回退到「配对完整 + 落在用户轮边界」的位置。
 * exclusiveEnd 语义与 Array#slice 相同：切开点本身不进入被压缩片段。
 */
function snapExclusiveEndToPairingBoundary(history = [], startIndex = 0, exclusiveEnd = 0) {
  const start = Math.max(0, startIndex)
  let end = Math.max(start, Math.min(Number(exclusiveEnd) || 0, history.length))
  while (end > start) {
    if (isUserTurnExclusiveEnd(history, end) && isPairingBalanced(history, start, end)) return end
    end -= 1
  }
  return start
}

function snapStartPastLeadingOrphanTools(history = [], startIndex = 0, exclusiveEnd = 0) {
  const end = Math.max(0, Math.min(Number(exclusiveEnd) || 0, history.length))
  let start = Math.max(0, Math.min(startIndex, end))
  while (start < end && history[start]?.role === 'tool') start += 1
  return start
}

function collectCompletedToolEvidence(messages = [], options = {}) {
  const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : 40
  const argChars = Number(options.argChars) > 0 ? Number(options.argChars) : 600
  const resultChars = Number(options.resultChars) > 0 ? Number(options.resultChars) : 1200
  const lines = []
  let pending = null

  const pushLine = (line) => {
    if (lines.length >= maxLines) return false
    lines.push(line)
    return true
  }

  const flushPending = () => {
    if (!pending) return
    for (const call of pending.calls) {
      const returned = pending.results.has(call.id)
      const args = String(call.args || '{}').slice(0, argChars)
      if (!pushLine(`调用 ${call.name}：${args}${returned ? '' : '（尚未返回）'}`)) break
      if (returned && !pushLine(`结果 ${call.id}：${String(pending.results.get(call.id) || '').slice(0, resultChars)}`)) break
    }
    pending = null
  }

  for (const message of messages) {
    if (message?.role === 'assistant' && listToolCallIds(message).length > 0) {
      flushPending()
      pending = {
        calls: message.tool_calls.map(item => ({
          id: String(item?.id || '').trim(),
          name: item?.function?.name || item?.name || 'tool',
          args: item?.function?.arguments || '{}'
        })).filter(item => item.id),
        results: new Map()
      }
      continue
    }
    if (message?.role === 'tool' && pending) {
      const id = String(message.tool_call_id || '').trim()
      if (id) pending.results.set(id, message.content == null ? '' : String(message.content))
      continue
    }
    if (message?.role === 'system' && message.content) {
      flushPending()
      pushLine(`运行约束：${String(message.content).slice(0, 800)}`)
    }
  }
  flushPending()
  return lines
}

module.exports = {
  inspectPairingRange,
  isPairingBalanced,
  snapExclusiveEndToPairingBoundary,
  snapStartPastLeadingOrphanTools,
  collectCompletedToolEvidence,
  isUserTurnExclusiveEnd
}
