function isRecallUnstartedReason(error, signal = null) {
  return !!(error?.recallUnstarted || signal?.reason?.recallUnstarted)
}

function isDurableAssistantWork(message) {
  if (!message || typeof message !== 'object') return false
  if (message.role === 'tool') return true
  if (message.role !== 'assistant') return false
  if (message.interrupted === true || message.interjectPause === true) return false
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true
  const content = String(message.content || '').trim()
  if (!content) return false
  if (content === '[已中断]' || content === '[注入中断，续轮中]') return false
  return true
}

function hasDurableWorkAfter(history, startIndex) {
  const list = Array.isArray(history) ? history : []
  return list.slice(Math.max(0, startIndex + 1)).some(isDurableAssistantWork)
}

function popUnstartedUserMessage(history, userIndex) {
  const list = Array.isArray(history) ? history : []
  const index = Number(userIndex)
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return { popped: false, history: list }
  }
  if (list[index]?.role !== 'user') {
    return { popped: false, history: list }
  }
  if (hasDurableWorkAfter(list, index)) {
    return { popped: false, history: list }
  }
  return {
    popped: true,
    history: list.slice(0, index),
    removed: list.slice(index)
  }
}

function findLastVisibleUserIndex(history) {
  const list = Array.isArray(history) ? history : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === 'user' && !list[index]?.hidden) return index
  }
  return -1
}

module.exports = {
  isRecallUnstartedReason,
  isDurableAssistantWork,
  hasDurableWorkAfter,
  popUnstartedUserMessage,
  findLastVisibleUserIndex
}
