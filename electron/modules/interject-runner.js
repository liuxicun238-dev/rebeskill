/**
 * 消息注入机制 - 队列 + 运行状态中枢
 * 每个项目维护独立的 pendingInterjectMap 与 runStateMap（按 projectId 隔离）。
 * ai-chat.js 的 handleSendMessage 通过本模块读取待注入消息并跟踪运行状态。
 *
 * 语义对齐 DeepSeek Harness 的 steer：新消息进入下一步收件箱，
 * 不取消正在跑的工具批次或整轮任务。停止按钮才是真正的 cancel。
 */

const turnLifecycle = require('./chat/turn-lifecycle')

const pendingInterjectMap = new Map() // projectId -> [{ itemId, content, createdAt }]
const runStateMap = new Map() // projectId -> 'idle' | 'thinking' | 'tools' | 'streaming'

function enqueueInterject(payload = {}) {
  const { projectId, itemId, content, createdAt } = payload || {}
  if (!projectId || !content) {
    return { ok: false, reason: 'missing_projectId_or_content' }
  }
  if (!pendingInterjectMap.has(projectId)) pendingInterjectMap.set(projectId, [])
  const queue = pendingInterjectMap.get(projectId)
  const entry = {
    itemId: itemId || `interject-${Date.now()}-${queue.length}`,
    content: String(content),
    createdAt: createdAt || Date.now()
  }
  queue.push(entry)

  const runState = runStateMap.get(projectId) || 'idle'
  try {
    turnLifecycle.noteInject(projectId, { itemId: entry.itemId, pendingCount: queue.length })
  } catch (_) { /* 观察台失败不影响插话 */ }
  console.log(`[Interject] queued project=${projectId} pending=${queue.length} itemId=${entry.itemId} runState=${runState} interrupted=false absorbAt=step-boundary`)
  return {
    ok: true,
    queued: queue.length,
    runState,
    interrupted: false,
    absorbAt: 'step-boundary',
    itemId: entry.itemId
  }
}

function isInterjectAbortReason(reason) {
  if (reason === 'interject') return true
  if (reason && typeof reason === 'object') {
    return reason.code === 'interject' || String(reason.message || '') === 'interject'
  }
  return false
}

function takePendingInterjectMessages(projectId) {
  const queue = pendingInterjectMap.get(projectId)
  if (!queue || !queue.length) return []
  pendingInterjectMap.delete(projectId)
  try {
    turnLifecycle.noteInjectAbsorbed(projectId, { pendingCount: 0 })
  } catch (_) { /* 观察台失败不影响吸收 */ }
  return queue.slice()
}

function peekPendingInterjectMessages(projectId) {
  const queue = pendingInterjectMap.get(projectId)
  return queue ? queue.slice() : []
}

function clearPendingInterjectMessages(projectId) {
  pendingInterjectMap.delete(projectId)
  try {
    turnLifecycle.noteInjectAbsorbed(projectId, { pendingCount: 0 })
  } catch (_) { /* 观察台失败不影响清理 */ }
}

function getRunState(projectId) {
  return runStateMap.get(projectId) || 'idle'
}

function setRunState(projectId, state) {
  if (!projectId || !state) return
  runStateMap.set(projectId, state)
}

module.exports = {
  enqueueInterject,
  takePendingInterjectMessages,
  peekPendingInterjectMessages,
  clearPendingInterjectMessages,
  isInterjectAbortReason,
  getRunState,
  setRunState
}