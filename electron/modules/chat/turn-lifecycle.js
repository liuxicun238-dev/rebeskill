/**
 * 这一轮观察台：只记录，不接管。
 * 发送 / 插话 / 打断 / 编辑重发 / 审批弹窗仍由原模块做主。
 * 这里把同一轮的 requestId、runId、门槛、插话数收到一张快照上，避免后再叠一套状态机。
 */

const PHASES = Object.freeze({
  idle: 'idle',
  running: 'running',
  awaiting_gate: 'awaiting_gate',
  interrupted: 'interrupted',
  completed: 'completed',
  failed: 'failed'
})

const FINISH_PHASES = new Set([PHASES.interrupted, PHASES.completed, PHASES.failed])

const snapshots = new Map()

function now() {
  return Date.now()
}

function emptySnapshot(projectId = '') {
  return {
    projectId: String(projectId || ''),
    phase: PHASES.idle,
    requestId: '',
    runId: '',
    startedAt: 0,
    updatedAt: 0,
    lastAction: '',
    pendingInjectCount: 0,
    lastInjectItemId: '',
    gateDepth: 0,
    gate: null,
    interruptRequested: false,
    recallUnstarted: false,
    finishStatus: '',
    resumePhase: PHASES.idle
  }
}

function copySnapshot(snapshot) {
  return {
    ...snapshot,
    gate: snapshot.gate ? { ...snapshot.gate } : null
  }
}

function getMutable(projectId) {
  const id = String(projectId || '')
  if (!id) return emptySnapshot('')
  if (!snapshots.has(id)) snapshots.set(id, emptySnapshot(id))
  return snapshots.get(id)
}

function touch(snapshot, action) {
  snapshot.updatedAt = now()
  if (action) snapshot.lastAction = action
  return snapshot
}

function beginTurn(projectId, info = {}) {
  const id = String(projectId || '')
  if (!id) return emptySnapshot('')
  const snapshot = emptySnapshot(id)
  snapshot.phase = PHASES.running
  snapshot.requestId = String(info.requestId || '')
  snapshot.runId = String(info.runId || '')
  snapshot.startedAt = now()
  touch(snapshot, 'begin')
  snapshots.set(id, snapshot)
  return copySnapshot(snapshot)
}

function noteInject(projectId, info = {}) {
  const snapshot = getMutable(projectId)
  if (!snapshot.projectId) return copySnapshot(snapshot)
  if (Number.isFinite(Number(info.pendingCount))) {
    snapshot.pendingInjectCount = Math.max(0, Number(info.pendingCount))
  } else {
    snapshot.pendingInjectCount += 1
  }
  if (info.itemId) snapshot.lastInjectItemId = String(info.itemId)
  touch(snapshot, 'inject')
  return copySnapshot(snapshot)
}

function noteInjectAbsorbed(projectId, info = {}) {
  const snapshot = getMutable(projectId)
  if (!snapshot.projectId) return copySnapshot(snapshot)
  if (Number.isFinite(Number(info.pendingCount))) {
    snapshot.pendingInjectCount = Math.max(0, Number(info.pendingCount))
  } else {
    snapshot.pendingInjectCount = 0
  }
  touch(snapshot, 'inject-absorbed')
  return copySnapshot(snapshot)
}

function noteGateWait(projectId, info = {}) {
  const snapshot = getMutable(projectId)
  if (!snapshot.projectId) return copySnapshot(snapshot)
  if (snapshot.gateDepth === 0) {
    snapshot.resumePhase = snapshot.phase === PHASES.awaiting_gate ? PHASES.running : snapshot.phase
  }
  snapshot.gateDepth += 1
  snapshot.phase = PHASES.awaiting_gate
  snapshot.gate = {
    requestId: String(info.requestId || ''),
    type: String(info.type || 'ask')
  }
  touch(snapshot, 'gate-wait')
  return copySnapshot(snapshot)
}

function noteGateSettled(projectId, info = {}) {
  const snapshot = getMutable(projectId)
  if (!snapshot.projectId) return copySnapshot(snapshot)
  snapshot.gateDepth = Math.max(0, snapshot.gateDepth - 1)
  if (snapshot.gateDepth === 0) {
    snapshot.gate = null
    if (snapshot.phase === PHASES.awaiting_gate && !FINISH_PHASES.has(snapshot.resumePhase)) {
      snapshot.phase = snapshot.resumePhase || PHASES.running
    }
  }
  touch(snapshot, info.error ? 'gate-error' : 'gate-settled')
  return copySnapshot(snapshot)
}

function observeGate(projectId, requestId, type, promise) {
  noteGateWait(projectId, { requestId, type })
  return Promise.resolve(promise).finally(() => {
    noteGateSettled(projectId, { requestId })
  })
}

function noteInterrupt(projectId, info = {}) {
  const snapshot = getMutable(projectId)
  if (!snapshot.projectId) return copySnapshot(snapshot)
  snapshot.interruptRequested = true
  snapshot.recallUnstarted = !!info.recallUnstarted
  touch(snapshot, info.recallUnstarted ? 'recall' : 'interrupt')
  return copySnapshot(snapshot)
}

function finishTurn(projectId, status, info = {}) {
  const snapshot = getMutable(projectId)
  if (!snapshot.projectId) return copySnapshot(snapshot)
  if (info.runId && snapshot.runId && String(info.runId) !== snapshot.runId) {
    return copySnapshot(snapshot)
  }
  const normalized = String(status || PHASES.completed)
  snapshot.finishStatus = normalized
  snapshot.pendingInjectCount = 0
  snapshot.gateDepth = 0
  snapshot.gate = null
  if (normalized === 'interrupted' || snapshot.interruptRequested) {
    snapshot.phase = PHASES.interrupted
  } else if (normalized === 'failed' || normalized === 'abandoned') {
    snapshot.phase = PHASES.failed
  } else {
    snapshot.phase = PHASES.completed
  }
  touch(snapshot, 'finish')
  return copySnapshot(snapshot)
}

function getSnapshot(projectId) {
  const id = String(projectId || '')
  if (!id || !snapshots.has(id)) return emptySnapshot(id)
  return copySnapshot(snapshots.get(id))
}

function reset(projectId) {
  const id = String(projectId || '')
  if (id) snapshots.delete(id)
  else snapshots.clear()
}

module.exports = {
  PHASES,
  beginTurn,
  noteInject,
  noteInjectAbsorbed,
  noteGateWait,
  noteGateSettled,
  observeGate,
  noteInterrupt,
  finishTurn,
  getSnapshot,
  reset
}
