/**
 * 轻量版 Codex-style Turn / Item 持久化层。
 *
 * 当前项目仍保留 messagesHistory 作为模型 API 兼容历史；本模块不替换它，
 * 而是把一轮运行和其中的工具项另外写入 task-runs 的 JSONL journal：
 *
 *   Turn
 *     ├─ tool_call / command_execution / file_change ...
 *     └─ agent_message
 *
 * 这样模型上下文可以继续裁剪 messagesHistory，UI/诊断/后续历史恢复仍有
 * 独立的结构化执行记录可读取。
 */

const fs = require('fs')
const path = require('path')
const taskRuns = require('../task-runs')
const turnEventBus = require('./turn-event-bus')

const activeTurns = new Map()
const turnSummaryCache = new Map()
const MAX_TEXT_CHARS = 6000

function runKey(runRef = {}) {
  return `${runRef.projectId || ''}::${runRef.runId || ''}`
}

function clipText(value = '', maxChars = MAX_TEXT_CHARS) {
  const text = String(value ?? '')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

function compactValue(value, maxChars = MAX_TEXT_CHARS) {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return clipText(value, maxChars)
  try {
    const raw = JSON.stringify(value)
    if (raw.length <= maxChars) return value
    return {
      truncated: true,
      preview: clipText(raw, maxChars)
    }
  } catch (_) {
    return clipText(value, maxChars)
  }
}

function compactItem(item = {}) {
  const next = {
    id: String(item.id || ''),
    type: String(item.type || 'tool_call'),
    toolName: String(item.toolName || item.name || ''),
    status: String(item.status || 'in_progress'),
    createdAt: item.createdAt || new Date().toISOString(),
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
    durationMs: Number.isFinite(Number(item.durationMs)) ? Number(item.durationMs) : null
  }
  if (item.arguments !== undefined) next.arguments = compactValue(item.arguments, 3200)
  if (item.result !== undefined) next.result = compactValue(item.result, MAX_TEXT_CHARS)
  if (item.error) next.error = clipText(item.error, 1200)
  if (item.message) next.message = clipText(item.message, 1200)
  return next
}

function publicItem(item = {}) {
  return {
    id: String(item.id || ''),
    type: String(item.type || 'tool_call'),
    toolName: String(item.toolName || item.name || ''),
    status: String(item.status || 'in_progress'),
    createdAt: item.createdAt || null,
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
    durationMs: Number.isFinite(Number(item.durationMs)) ? Number(item.durationMs) : null
  }
}

function emitTurnEvent(runRef, type, payload = {}) {
  try {
    turnEventBus.emitTurnEvent({
      projectId: String(runRef?.projectId || ''),
      runId: String(runRef?.runId || ''),
      turnId: String(payload.turnId || runRef?.runId || ''),
      chatSessionId: String(runRef?.chatSessionId || payload.chatSessionId || ''),
      type,
      ...payload
    })
  } catch (_) {
    // 事件观察失败不能影响工具执行或 journal 持久化。
  }
}

function ensureTurn(runRef, metadata = {}) {
  const key = runKey(runRef)
  if (!runRef?.projectId || !runRef?.runId) return null
  let turn = activeTurns.get(key)
  if (!turn) {
    turn = {
      id: String(runRef.runId),
      projectId: String(runRef.projectId),
      runId: String(runRef.runId),
      status: 'running',
      startedAt: Date.now(),
      items: new Map(),
      metadata: {
        userMessage: clipText(metadata.userMessage || '', 1200),
        modelName: clipText(metadata.modelName || '', 160),
        modelId: clipText(metadata.modelId || '', 160)
      }
    }
    activeTurns.set(key, turn)
    taskRuns.event(runRef, 'turn_started', {
      turnId: turn.id,
      metadata: turn.metadata
    })
    emitTurnEvent(runRef, 'turn-started', {
      turnId: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      metadata: turn.metadata
    })
  }
  return turn
}

function beginTurn(runRef, metadata = {}) {
  return ensureTurn(runRef, metadata)
}

function createItem(runRef, item = {}) {
  const turn = ensureTurn(runRef)
  if (!turn || !item.id) return null
  const id = String(item.id)
  if (turn.items.has(id)) return turn.items.get(id)
  const now = new Date().toISOString()
  const next = compactItem({
    ...item,
    id,
    status: item.status || 'in_progress',
    createdAt: item.createdAt || now,
    startedAt: item.startedAt || now
  })
  turn.items.set(id, next)
  taskRuns.event(runRef, 'turn_item_created', {
    turnId: turn.id,
    item: next
  })
  emitTurnEvent(runRef, 'turn-item-created', {
    turnId: turn.id,
    item: publicItem(next),
    itemCount: turn.items.size
  })
  return next
}

function updateItem(runRef, itemId, patch = {}) {
  const turn = ensureTurn(runRef)
  const id = String(itemId || '')
  if (!turn || !id) return null
  const current = turn.items.get(id) || compactItem({ id })
  const next = compactItem({ ...current, ...patch, id })
  turn.items.set(id, next)
  taskRuns.event(runRef, 'turn_item_updated', {
    turnId: turn.id,
    itemId: id,
    patch: next
  })
  emitTurnEvent(runRef, 'turn-item-updated', {
    turnId: turn.id,
    itemId: id,
    item: publicItem(next),
    itemCount: turn.items.size,
    toolCount: [...turn.items.values()].filter(item => item.type !== 'agent_message' && item.toolName).length
  })
  return next
}

function completeItem(runRef, itemId, result, options = {}) {
  const turn = activeTurns.get(runKey(runRef))
  const existingItem = turn?.items.get(String(itemId || ''))
  const startedMs = existingItem?.startedAt ? Date.parse(existingItem.startedAt) : NaN
  const durationMs = Number.isFinite(Number(options.durationMs))
    ? Number(options.durationMs)
    : (Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : undefined)
  const updated = updateItem(runRef, itemId, {
    status: options.status || (result?.success === false ? 'failed' : 'completed'),
    result,
    error: options.error || (result?.success === false ? result?.error : ''),
    completedAt: new Date().toISOString(),
    durationMs
  })
  return updated
}

function addAgentMessage(runRef, content, options = {}) {
  const id = String(options.id || `agent-${runRef?.runId || Date.now()}`)
  return createItem(runRef, {
    id,
    type: options.type || 'agent_message',
    toolName: '',
    status: options.status || 'completed',
    message: content,
    result: { content: clipText(content, MAX_TEXT_CHARS) },
    startedAt: options.startedAt || null,
    completedAt: options.completedAt || new Date().toISOString(),
    durationMs: options.durationMs
  })
}

function finishTurn(runRef, status = 'completed', details = {}) {
  const turn = activeTurns.get(runKey(runRef))
  if (!turn) return null
  turn.status = String(status || 'completed')
  turn.completedAt = Date.now()
  taskRuns.event(runRef, 'turn_completed', {
    turnId: turn.id,
    status: turn.status,
    durationMs: Math.max(0, turn.completedAt - turn.startedAt),
    itemCount: turn.items.size,
    details: compactValue(details, 2400)
  })
  const toolCount = [...turn.items.values()].filter(item => item.type !== 'agent_message' && item.toolName).length
  emitTurnEvent(runRef, 'turn-completed', {
    turnId: turn.id,
    status: turn.status,
    completedAt: new Date(turn.completedAt).toISOString(),
    durationMs: Math.max(0, turn.completedAt - turn.startedAt),
    itemCount: turn.items.size,
    toolCount,
    evidenceAvailable: toolCount > 0
  })
  const snapshot = {
    id: turn.id,
    projectId: turn.projectId,
    runId: turn.runId,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: Math.max(0, turn.completedAt - turn.startedAt),
    metadata: turn.metadata,
    items: [...turn.items.values()]
  }
  activeTurns.delete(runKey(runRef))
  return snapshot
}

function readTurnFromJournal(storagePath, runId) {
  const journalPath = getJournalPath(storagePath, runId)
  if (!journalPath || !fs.existsSync(journalPath)) return null
  const items = new Map()
  let turn = {
    id: String(runId || ''),
    status: 'unknown',
    metadata: {},
    startedAt: null,
    completedAt: null,
    durationMs: null
  }
  try {
    const lines = fs.readFileSync(journalPath, 'utf-8').split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch (_) { continue }
      const payload = event.payload || {}
      if (event.type === 'run_started') {
        const runMetadata = payload.metadata || payload
        turn.metadata = {
          ...turn.metadata,
          ...runMetadata,
          userMessage: clipText(
            runMetadata.userMessage || runMetadata.messagePreview || turn.metadata.userMessage || '',
            1200
          )
        }
        turn.projectId = String(event.projectId || turn.projectId || '')
        turn.startedAt = event.time || turn.startedAt
      } else if (event.type === 'turn_started') {
        turn.metadata = payload.metadata || {}
        turn.startedAt = event.time || turn.startedAt
      } else if (event.type === 'turn_item_created' && payload.item?.id) {
        items.set(String(payload.item.id), payload.item)
      } else if (event.type === 'turn_item_updated' && payload.itemId) {
        const current = items.get(String(payload.itemId)) || { id: String(payload.itemId) }
        items.set(String(payload.itemId), { ...current, ...(payload.patch || {}) })
      } else if (event.type === 'tool_started' && payload.toolCallId) {
        const id = String(payload.toolCallId)
        if (!items.has(id)) {
          items.set(id, compactItem({
            id,
            type: payload.name === 'shell_run' || payload.name === 'run_command'
              ? 'command_execution'
              : 'tool_call',
            toolName: payload.name,
            arguments: payload.args,
            status: 'in_progress',
            startedAt: event.time || null,
            createdAt: event.time || null
          }))
        }
      } else if (event.type === 'tool_finished' && payload.toolCallId) {
        const id = String(payload.toolCallId)
        const current = items.get(id) || compactItem({
          id,
          type: payload.name === 'shell_run' || payload.name === 'run_command'
            ? 'command_execution'
            : 'tool_call',
          toolName: payload.name,
          status: 'in_progress'
        })
        items.set(id, compactItem({
          ...current,
          toolName: current.toolName || payload.name,
          status: payload.success === false ? 'failed' : 'completed',
          result: payload.result,
          completedAt: event.time || null
        }))
      } else if (event.type === 'turn_completed') {
        turn.status = payload.status || turn.status
        turn.completedAt = event.time || turn.completedAt
        turn.durationMs = payload.durationMs ?? turn.durationMs
      } else if (event.type === 'run_finished') {
        turn.status = payload.status || turn.status
        turn.completedAt = event.time || turn.completedAt
      }
    }
  } catch (_) {
    return null
  }
  return { ...turn, items: [...items.values()] }
}

function getJournalPath(storagePath, runId) {
  const root = String(storagePath || '').trim()
  const id = String(runId || '').trim()
  if (!root || !id) return ''
  return path.join(root, 'runs', `${id}.jsonl`)
}

function getJournalSignature(journalPath) {
  try {
    const stat = fs.statSync(journalPath)
    const statePath = journalPath.replace(/\.jsonl$/i, '.state.json')
    let stateSignature = ''
    try {
      const stateStat = fs.statSync(statePath)
      stateSignature = `${stateStat.size}:${stateStat.mtimeMs}`
    } catch (_) {}
    return `${stat.size}:${stat.mtimeMs}|${stateSignature}`
  } catch (_) {
    return ''
  }
}

function readTurnSummaryFromJournal(storagePath, runId) {
  const journalPath = getJournalPath(storagePath, runId)
  if (!journalPath || !fs.existsSync(journalPath)) return null

  const signature = getJournalSignature(journalPath)
  const cached = turnSummaryCache.get(journalPath)
  if (cached && cached.signature === signature) return cached.summary

  const statePath = journalPath.replace(/\.jsonl$/i, '.state.json')
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    if (state && (
      Number.isFinite(Number(state.turnItemCount))
      || state.turnId
      || state.turnStatus
      || state.turnCompletedAt
    )) {
      const summary = {
        id: String(state.turnId || runId || ''),
        projectId: String(state.projectId || ''),
        runId: String(state.runId || runId || ''),
        status: String(state.turnStatus || state.status || 'unknown'),
        metadata: {},
        startedAt: state.turnStartedAt || state.createdAt || null,
        completedAt: state.turnCompletedAt || state.finishedAt || null,
        durationMs: state.turnDurationMs ?? null,
        itemCount: Math.max(0, Number(state.turnItemCount) || 0),
        toolCount: Math.max(0, Number(state.turnToolCount) || 0),
        evidenceAvailable: state.turnEvidenceAvailable === true
          || Number(state.turnToolCount) > 0,
        latestItemAt: state.latestTurnItemAt || null,
        latestItem: null
      }
      turnSummaryCache.set(journalPath, { signature, summary })
      return summary
    }
  } catch (_) {
    // Older journals may not have the compact state projection yet; fall back
    // to the compatibility parser below.
  }

  const items = new Map()
  const summary = {
    id: String(runId || ''),
    projectId: '',
    runId: String(runId || ''),
    status: 'unknown',
    metadata: {},
    startedAt: null,
    completedAt: null,
    durationMs: null,
    itemCount: 0,
    toolCount: 0,
    evidenceAvailable: false,
    latestItemAt: null,
    latestItem: null
  }

  const updateLatestItem = item => {
    if (!item) return
    const timestamp = item.completedAt || item.createdAt || item.startedAt || null
    if (!timestamp || !summary.latestItemAt || String(timestamp) >= String(summary.latestItemAt)) {
      summary.latestItemAt = timestamp
      summary.latestItem = {
        id: String(item.id || ''),
        type: String(item.type || 'tool_call'),
        toolName: String(item.toolName || item.name || ''),
        status: String(item.status || 'in_progress'),
        createdAt: item.createdAt || null,
        startedAt: item.startedAt || null,
        completedAt: item.completedAt || null
      }
    }
  }

  const upsertItem = (id, item = {}) => {
    const normalizedId = String(id || item.id || '')
    if (!normalizedId) return
    const current = items.get(normalizedId) || { id: normalizedId }
    const next = { ...current, ...item, id: normalizedId }
    items.set(normalizedId, next)
    updateLatestItem(next)
  }

  try {
    const lines = fs.readFileSync(journalPath, 'utf-8').split(/\r?\n/)
    for (const line of lines) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch (_) { continue }
      const payload = event.payload || {}
      if (event.type === 'run_started') {
        const metadata = payload.metadata || payload
        summary.projectId = String(event.projectId || summary.projectId || '')
        summary.metadata = { ...summary.metadata, ...metadata }
        summary.startedAt = event.time || summary.startedAt
      } else if (event.type === 'turn_started') {
        summary.id = String(payload.turnId || summary.id || runId)
        summary.metadata = payload.metadata || summary.metadata
        summary.startedAt = event.time || summary.startedAt
      } else if (event.type === 'turn_item_created' && payload.item?.id) {
        upsertItem(payload.item.id, payload.item)
      } else if (event.type === 'turn_item_updated' && payload.itemId) {
        upsertItem(payload.itemId, payload.patch || {})
      } else if (event.type === 'tool_started' && payload.toolCallId) {
        upsertItem(payload.toolCallId, {
          type: payload.name === 'shell_run' || payload.name === 'run_command'
            ? 'command_execution'
            : 'tool_call',
          toolName: payload.name,
          status: 'in_progress',
          arguments: undefined,
          startedAt: event.time || null,
          createdAt: event.time || null
        })
      } else if (event.type === 'tool_finished' && payload.toolCallId) {
        const current = items.get(String(payload.toolCallId)) || {}
        upsertItem(payload.toolCallId, {
          type: current.type || (payload.name === 'shell_run' || payload.name === 'run_command'
            ? 'command_execution'
            : 'tool_call'),
          toolName: current.toolName || payload.name,
          status: payload.success === false ? 'failed' : 'completed',
          completedAt: event.time || null
        })
      } else if (event.type === 'turn_completed') {
        summary.status = String(payload.status || summary.status)
        summary.completedAt = event.time || summary.completedAt
        summary.durationMs = payload.durationMs ?? summary.durationMs
      } else if (event.type === 'run_finished') {
        summary.status = String(payload.status || summary.status)
        summary.completedAt = event.time || summary.completedAt
      }
    }
  } catch (_) {
    return null
  }

  const values = [...items.values()]
  const toolItems = values.filter(item => item.type !== 'agent_message' && item.toolName)
  summary.itemCount = values.length
  summary.toolCount = toolItems.length
  summary.evidenceAvailable = toolItems.length > 0
  turnSummaryCache.set(journalPath, { signature, summary })
  return summary
}

function formatTurnForFollowupContext(turn, options = {}) {
  if (!turn || !Array.isArray(turn.items)) return ''
  const maxChars = Math.max(1200, Number(options.maxChars) || 7000)
  const lines = [
    '【上一轮持久化执行证据】',
    '以下内容来自上一轮真实 Turn/Item 记录，不是模型猜测。',
    '如果当前用户是在要求展开、详细说明或补充上一轮，优先基于这些已完成证据回答；不要无理由重复执行同一轮已经完成的搜索和读取。只有证据明确不足时，才补充最小范围的核对。',
    `上一轮状态：${turn.status || 'unknown'}`
  ]
  if (turn.metadata?.userMessage) lines.push(`上一轮用户请求：${clipText(turn.metadata.userMessage, 1200)}`)

  for (const item of turn.items) {
    if (!item || item.type === 'agent_message') continue
    const toolName = String(item.toolName || item.name || '').trim()
    if (!toolName) continue
    lines.push('', `工具：${toolName}（${item.status || 'unknown'}）`)
    if (item.arguments !== undefined) lines.push(`参数：${clipText(stringifyForContext(item.arguments), 1600)}`)
    if (item.result !== undefined) lines.push(`结果：${clipText(stringifyForContext(item.result), 3600)}`)
    if (item.error) lines.push(`错误：${clipText(item.error, 900)}`)
  }

  const finalMessage = [...turn.items].reverse().find(item =>
    item?.type === 'agent_message' && (item.message || item.result?.content)
  )
  if (finalMessage) {
    lines.push('', '上一轮最终回复：', clipText(finalMessage.message || finalMessage.result?.content || '', 2400))
  }
  return clipText(lines.join('\n'), maxChars)
}

function stringifyForContext(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch (_) { return String(value ?? '') }
}

module.exports = {
  beginTurn,
  createItem,
  updateItem,
  completeItem,
  addAgentMessage,
  finishTurn,
  readTurnFromJournal,
  readTurnSummaryFromJournal,
  formatTurnForFollowupContext
}
