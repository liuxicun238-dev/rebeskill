function normalizeAttachments(list = []) {
  return (Array.isArray(list) ? list : [])
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const name = String(item.name || item.path || '').split(/[\\/]/).pop()
      const pathValue = String(item.path || '').trim()
      if (!name && !pathValue) return null
      const entry = {
        name,
        path: pathValue,
        type: String(item.type || ''),
        size: Number(item.size) || 0
      }
      if (item.kind) entry.kind = item.kind
      return entry
    })
    .filter(Boolean)
}

function normalizeReferences(list = []) {
  return (Array.isArray(list) ? list : [])
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const type = item.type || (item.summaryId ? 'summary' : 'message')
      if (type === 'summary' && item.summaryId) {
        return {
          type,
          summaryId: String(item.summaryId),
          title: String(item.title || item.summaryId),
          preview: String(item.preview || '')
        }
      }
      if (type === 'message' && item.turnId && item.part) {
        return {
          type,
          turnId: Number(item.turnId),
          part: String(item.part),
          title: String(item.title || ''),
          preview: String(item.preview || item.content || '')
        }
      }
      return null
    })
    .filter(Boolean)
}

function findEditableUserIndex(history, locator = {}) {
  const list = Array.isArray(history) ? history : []
  const messageId = String(locator.messageId || '').trim()
  if (messageId) {
    const byId = list.findIndex(item => item?.role === 'user' && String(item.messageId || '') === messageId)
    if (byId >= 0) return byId
  }
  const historyIndex = Number(locator.historyIndex)
  if (Number.isInteger(historyIndex) && historyIndex >= 0 && historyIndex < list.length && list[historyIndex]?.role === 'user') {
    return historyIndex
  }
  if (locator.fallbackLastUser) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index]?.role === 'user' && !list[index]?.hidden) return index
    }
  }
  return -1
}

function applyEditAndTruncate(history, payload = {}) {
  const list = Array.isArray(history) ? history : []
  const index = findEditableUserIndex(list, payload)
  if (index < 0) {
    return { ok: false, error: '这条消息不在当前可编辑范围内', history: list }
  }
  const current = list[index] && typeof list[index] === 'object' ? list[index] : null
  if (!current || current.hidden || current.isInterject) {
    return { ok: false, error: '这条消息不能编辑', history: list }
  }
  const content = String(payload.content || '').trim()
  const attachments = normalizeAttachments(payload.attachments)
  const references = normalizeReferences(payload.references)
  if (!content && attachments.length === 0 && references.length === 0) {
    return { ok: false, error: '编辑后的消息不能为空', history: list }
  }
  const updated = {
    ...current,
    content,
    displayContent: String(payload.displayContent || content),
    time: current.time || new Date().toISOString(),
    editedAt: Date.now()
  }
  if (attachments.length) updated.attachments = attachments
  else delete updated.attachments
  if (references.length) updated.references = references
  else delete updated.references
  if (Array.isArray(payload.directiveBadges) && payload.directiveBadges.length) {
    updated.directiveBadges = payload.directiveBadges
  }
  const removed = list.slice(index + 1)
  return {
    ok: true,
    index,
    history: [...list.slice(0, index), updated],
    removed
  }
}

module.exports = {
  normalizeAttachments,
  normalizeReferences,
  findEditableUserIndex,
  applyEditAndTruncate
}
