/**
 * Durable per-project task run journal.
 *
 * A run is stored under the app-managed project storage directory, never under
 * the user's source project. Events are JSONL so progress survives crashes more
 * reliably than rewriting one large JSON document on every step.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')
const turnLifecycle = require('./chat/turn-lifecycle')

const activeRuns = new Map()
const FINAL_STATUSES = new Set(['completed', 'failed', 'interrupted', 'abandoned'])
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_MAX_FINAL_RUNS = 200
const STATE_FLUSH_MS = 80
const REPLACE_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EEXIST', 'EBUSY'])
const cleanupState = new Map()
/** 热路径先改内存，避免每次 event() 都同步 rewrite state.json */
const stateCache = new Map()
const pendingStateFlushes = new Map()
const stateFlushTimers = new Map()
const runIoChains = new Map()
const errorLogState = new Map()

function runKey(projectId, runId) {
  return `${projectId}::${runId}`
}

function isReplaceBusyError(error) {
  return !!(error && REPLACE_BUSY_CODES.has(error.code))
}

function logOperationError(error) {
  const message = String(error?.message || error || 'unknown error')
  const key = `${error?.code || 'ERR'}:${message.replace(/\.tmp' -> .*$/, ".tmp'")}`
  const now = Date.now()
  const prev = errorLogState.get(key) || { at: 0, count: 0 }
  prev.count += 1
  if (now - prev.at < 2000) {
    errorLogState.set(key, prev)
    return
  }
  const extra = prev.count > 1 ? ` (x${prev.count})` : ''
  console.error('[TaskRuns] operation failed:', message + extra)
  errorLogState.set(key, { at: now, count: 0 })
}

function safeCall(fallback, fn) {
  try {
    return fn()
  } catch (error) {
    logOperationError(error)
    return fallback
  }
}

function makeTmpPath(filePath) {
  return `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
}

function unlinkQuiet(filePath) {
  try { fs.unlinkSync(filePath) } catch (_) { /* ignore */ }
}

function replaceFileSync(tmpPath, filePath) {
  // Windows 上 rename 覆盖已有文件经常 EPERM；copyFile 可以直接覆盖。
  if (process.platform === 'win32') {
    fs.copyFileSync(tmpPath, filePath)
    unlinkQuiet(tmpPath)
    return
  }
  try {
    fs.renameSync(tmpPath, filePath)
  } catch (error) {
    if (!isReplaceBusyError(error)) throw error
    fs.copyFileSync(tmpPath, filePath)
    unlinkQuiet(tmpPath)
  }
}

async function replaceFileAsync(tmpPath, filePath) {
  if (process.platform === 'win32') {
    await fs.promises.copyFile(tmpPath, filePath)
    await fs.promises.unlink(tmpPath).catch(() => {})
    return
  }
  try {
    await fs.promises.rename(tmpPath, filePath)
  } catch (error) {
    if (!isReplaceBusyError(error)) throw error
    await fs.promises.copyFile(tmpPath, filePath)
    await fs.promises.unlink(tmpPath).catch(() => {})
  }
}

function enqueueRunIo(key, fn) {
  const previous = runIoChains.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(fn)
  runIoChains.set(key, next)
  next.finally(() => {
    if (runIoChains.get(key) === next) runIoChains.delete(key)
  })
  return next
}

function getCleanupMarkerPath(projectId) {
  return path.join(getRunsDir(projectId), '.cleanup-state.json')
}

function getRunTime(run) {
  const value = Date.parse(run.finishedAt || run.updatedAt || run.createdAt || '')
  return Number.isFinite(value) ? value : 0
}

function isFinalRun(run) {
  return FINAL_STATUSES.has(run?.status)
}

function forgetRunState(projectId, runId) {
  const key = runKey(projectId, runId)
  stateCache.delete(key)
  pendingStateFlushes.delete(key)
  const timer = stateFlushTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    stateFlushTimers.delete(key)
  }
}

function removeRunFiles(projectId, runId) {
  const { journalPath, statePath } = getRunPaths(projectId, runId)
  forgetRunState(projectId, runId)
  for (const filePath of [journalPath, statePath]) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch (error) {
      console.warn('[TaskRuns] failed to remove stale run file:', filePath, error.message)
    }
  }
}

async function removeRunFilesAsync(projectId, runId) {
  const { journalPath, statePath } = getRunPaths(projectId, runId)
  forgetRunState(projectId, runId)
  for (const filePath of [journalPath, statePath]) {
    try {
      await fs.promises.access(filePath)
      await fs.promises.unlink(filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[TaskRuns] async remove stale run file failed:', filePath, error.message)
      }
    }
  }
}

function cleanupLeftoverTmpFiles(runsDir) {
  let removed = 0
  let names
  try {
    names = fs.readdirSync(runsDir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    const filePath = path.join(runsDir, name)
    try {
      const stat = fs.statSync(filePath)
      if (Date.now() - stat.mtimeMs < 60000) continue
      fs.unlinkSync(filePath)
      removed += 1
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[TaskRuns] failed to remove leftover tmp:', filePath, error.message)
      }
    }
  }
  return removed
}

async function cleanupLeftoverTmpFilesAsync(runsDir) {
  let removed = 0
  let names
  try {
    names = await fs.promises.readdir(runsDir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    const filePath = path.join(runsDir, name)
    try {
      const stat = await fs.promises.stat(filePath)
      if (Date.now() - stat.mtimeMs < 60000) continue
      await fs.promises.unlink(filePath)
      removed += 1
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[TaskRuns] async remove leftover tmp failed:', filePath, error.message)
      }
    }
  }
  return removed
}

function cleanupOrphanedJournals(runsDir, knownRunIds, cutoffTime) {
  let removed = 0
  for (const name of fs.readdirSync(runsDir)) {
    if (!name.endsWith('.jsonl')) continue
    const runId = name.slice(0, -'.jsonl'.length)
    if (knownRunIds.has(runId)) continue
    const filePath = path.join(runsDir, name)
    try {
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs < cutoffTime) {
        fs.unlinkSync(filePath)
        removed += 1
      }
    } catch (error) {
      console.warn('[TaskRuns] failed to inspect orphaned journal:', filePath, error.message)
    }
  }
  return removed
}

async function cleanupOrphanedJournalsAsync(runsDir, knownRunIds, cutoffTime) {
  let removed = 0
  let names
  try {
    names = await fs.promises.readdir(runsDir)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const runId = name.slice(0, -'.jsonl'.length)
    if (knownRunIds.has(runId)) continue
    const filePath = path.join(runsDir, name)
    try {
      const stat = await fs.promises.stat(filePath)
      if (stat.mtimeMs < cutoffTime) {
        await fs.promises.unlink(filePath)
        removed += 1
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[TaskRuns] async inspect orphaned journal failed:', filePath, error.message)
      }
    }
  }
  return removed
}

function cleanupOldRuns(projectId, options = {}) {
  return safeCall({ removed: 0, kept: 0, skipped: true }, () => {
    const runsDir = getRunsDir(projectId)
    if (!fs.existsSync(runsDir)) return { removed: 0, kept: 0 }

    const now = Date.now()
    const retentionDays = Number(options.retentionDays || DEFAULT_RETENTION_DAYS)
    const maxFinalRuns = Number(options.maxFinalRuns || DEFAULT_MAX_FINAL_RUNS)
    const cutoffTime = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
    const markerPath = getCleanupMarkerPath(projectId)
    let lastCleanupAt = 0

    try {
      if (fs.existsSync(markerPath)) {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
        lastCleanupAt = Number(marker.lastCleanupAt || 0)
      }
    } catch {
      lastCleanupAt = 0
    }

    if (!options.force && now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return { removed: 0, kept: 0, skipped: true, reason: 'recently_cleaned' }
    }

    const runs = listRuns(projectId, { limit: Number.MAX_SAFE_INTEGER })
    const knownRunIds = new Set(runs.map(run => run.runId).filter(Boolean))
    const finalRuns = runs
      .filter(isFinalRun)
      .sort((a, b) => getRunTime(b) - getRunTime(a))

    const keepIds = new Set(finalRuns.slice(0, Math.max(0, maxFinalRuns)).map(run => run.runId))
    const removeIds = new Set()

    for (const run of finalRuns) {
      const runTime = getRunTime(run)
      if (!keepIds.has(run.runId) || (runTime > 0 && runTime < cutoffTime)) {
        removeIds.add(run.runId)
      }
    }

    for (const runId of removeIds) {
      removeRunFiles(projectId, runId)
    }

    const orphanedRemoved = cleanupOrphanedJournals(runsDir, knownRunIds, cutoffTime)
    const tmpRemoved = cleanupLeftoverTmpFiles(runsDir)

    atomicWriteJson(markerPath, {
      lastCleanupAt: now,
      retentionDays,
      maxFinalRuns,
      removed: removeIds.size,
      orphanedRemoved,
      tmpRemoved
    })

    return {
      removed: removeIds.size,
      orphanedRemoved,
      tmpRemoved,
      kept: runs.length - removeIds.size,
      retentionDays,
      maxFinalRuns
    }
  })
}

async function cleanupOldRunsAsync(projectId, options = {}) {
  try {
    const runsDir = getRunsDir(projectId)
    let dirExists = false
    try { await fs.promises.access(runsDir); dirExists = true } catch {}
    if (!dirExists) return { removed: 0, kept: 0 }

    const now = Date.now()
    const retentionDays = Number(options.retentionDays || DEFAULT_RETENTION_DAYS)
    const maxFinalRuns = Number(options.maxFinalRuns || DEFAULT_MAX_FINAL_RUNS)
    const cutoffTime = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
    const markerPath = getCleanupMarkerPath(projectId)
    let lastCleanupAt = 0

    try {
      let markerExists = false
      try { await fs.promises.access(markerPath); markerExists = true } catch {}
      if (markerExists) {
        const marker = JSON.parse(await fs.promises.readFile(markerPath, 'utf-8'))
        lastCleanupAt = Number(marker.lastCleanupAt || 0)
      }
    } catch {
      lastCleanupAt = 0
    }

    if (!options.force && now - lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return { removed: 0, kept: 0, skipped: true, reason: 'recently_cleaned' }
    }

    const runs = listRuns(projectId, { limit: Number.MAX_SAFE_INTEGER })
    const knownRunIds = new Set(runs.map(run => run.runId).filter(Boolean))
    const finalRuns = runs
      .filter(isFinalRun)
      .sort((a, b) => getRunTime(b) - getRunTime(a))

    const keepIds = new Set(finalRuns.slice(0, Math.max(0, maxFinalRuns)).map(run => run.runId))
    const removeIds = new Set()

    for (const run of finalRuns) {
      const runTime = getRunTime(run)
      if (!keepIds.has(run.runId) || (runTime > 0 && runTime < cutoffTime)) {
        removeIds.add(run.runId)
      }
    }

    // 串行异步删除，避免 Windows 文件锁冲突（EPERM）
    for (const runId of removeIds) {
      await removeRunFilesAsync(projectId, runId)
    }

    const orphanedRemoved = await cleanupOrphanedJournalsAsync(runsDir, knownRunIds, cutoffTime)
    const tmpRemoved = await cleanupLeftoverTmpFilesAsync(runsDir)

    await atomicWriteJsonAsync(markerPath, {
      lastCleanupAt: now,
      retentionDays,
      maxFinalRuns,
      removed: removeIds.size,
      orphanedRemoved,
      tmpRemoved
    })

    return {
      removed: removeIds.size,
      orphanedRemoved,
      tmpRemoved,
      kept: runs.length - removeIds.size,
      retentionDays,
      maxFinalRuns
    }
  } catch (error) {
    console.error('[TaskRuns] cleanupOldRunsAsync failed:', error.message)
    return { removed: 0, kept: 0, error: error.message }
  }
}

function cleanupOldRunsDeferred(projectId, options = {}) {
  if (!projectId) return null
  const lastStartedAt = cleanupState.get(projectId) || 0
  const now = Date.now()
  if (!options.force && now - lastStartedAt < CLEANUP_INTERVAL_MS) return null
  cleanupState.set(projectId, now)
  setTimeout(async () => {
    await cleanupOldRunsAsync(projectId, options)
  }, 0)
  return { scheduled: true }
}
function makeRunId() {
  return `run-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
}

function safeJson(value) {
  return JSON.stringify(value, (key, item) => {
    if (typeof item === 'string' && item.length > 20000) {
      return `${item.slice(0, 20000)}\n...[truncated ${item.length - 20000} chars]`
    }
    return item
  })
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = makeTmpPath(filePath)
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    replaceFileSync(tmpPath, filePath)
  } catch (error) {
    unlinkQuiet(tmpPath)
    throw error
  }
}

async function atomicWriteJsonAsync(filePath, data) {
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })
  const tmpPath = makeTmpPath(filePath)
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    await replaceFileAsync(tmpPath, filePath)
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => {})
    throw error
  }
}

function getProjectInstance(projectId) {
  return config.getProjectInstance(projectId)
}

function getRunsDir(projectId) {
  const instance = getProjectInstance(projectId)
  if (!instance?.storagePath) {
    throw new Error(`Project storage path not found for ${projectId}`)
  }
  return path.join(instance.storagePath, 'runs')
}

function getRunPaths(projectId, runId) {
  const runsDir = getRunsDir(projectId)
  return {
    dir: runsDir,
    journalPath: path.join(runsDir, `${runId}.jsonl`),
    statePath: path.join(runsDir, `${runId}.state.json`)
  }
}

function readStateFromDisk(projectId, runId) {
  const { statePath } = getRunPaths(projectId, runId)
  if (!fs.existsSync(statePath)) return null
  return JSON.parse(fs.readFileSync(statePath, 'utf-8'))
}

function readState(projectId, runId) {
  const key = runKey(projectId, runId)
  if (stateCache.has(key)) return stateCache.get(key)
  const fromDisk = readStateFromDisk(projectId, runId)
  if (fromDisk) stateCache.set(key, fromDisk)
  return fromDisk
}

function persistStateNow(projectId, runId, state) {
  const { statePath } = getRunPaths(projectId, runId)
  atomicWriteJson(statePath, state)
}

function scheduleStateFlush(projectId, runId) {
  const key = runKey(projectId, runId)
  const cached = stateCache.get(key)
  if (!cached) return
  pendingStateFlushes.set(key, { projectId, runId, state: cached })
  if (stateFlushTimers.has(key)) return
  const timer = setTimeout(() => {
    stateFlushTimers.delete(key)
    const pending = pendingStateFlushes.get(key)
    if (!pending) return
    pendingStateFlushes.delete(key)
    enqueueRunIo(key, async () => {
      try {
        const latest = stateCache.get(key) || pending.state
        const { statePath } = getRunPaths(pending.projectId, pending.runId)
        await atomicWriteJsonAsync(statePath, latest)
      } catch (error) {
        logOperationError(error)
      }
    })
  }, STATE_FLUSH_MS)
  timer.unref?.()
  stateFlushTimers.set(key, timer)
}

function flushStateNow(projectId, runId) {
  const key = runKey(projectId, runId)
  const timer = stateFlushTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    stateFlushTimers.delete(key)
  }
  pendingStateFlushes.delete(key)
  const cached = stateCache.get(key)
  if (!cached) return
  persistStateNow(projectId, runId, cached)
}

function writeState(projectId, runId, patch, options = {}) {
  const existing = readState(projectId, runId) || {
    runId,
    projectId,
    status: 'running',
    eventCount: 0,
    createdAt: new Date().toISOString()
  }
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  stateCache.set(runKey(projectId, runId), next)
  if (options.flush) flushStateNow(projectId, runId)
  else scheduleStateFlush(projectId, runId)
  return next
}

function appendEvent(projectId, runId, type, payload = {}) {
  const paths = getRunPaths(projectId, runId)
  fs.mkdirSync(paths.dir, { recursive: true })
  const event = {
    seq: Date.now(),
    time: new Date().toISOString(),
    projectId,
    runId,
    type,
    payload
  }
  fs.appendFileSync(paths.journalPath, `${safeJson(event)}\n`, 'utf-8')
  const current = readState(projectId, runId) || {}
  const turnSummaryPatch = updateTurnSummaryState(current, type, payload, event)
  writeState(projectId, runId, {
    eventCount: Number(current.eventCount || 0) + 1,
    lastEventType: type,
    ...turnSummaryPatch
  })
  return event
}

function updateTurnSummaryState(current = {}, type, payload = {}, event = {}) {
  const itemIds = new Set(Array.isArray(current.turnItemIds) ? current.turnItemIds.map(String) : [])
  const toolItemIds = new Set(Array.isArray(current.turnToolItemIds) ? current.turnToolItemIds.map(String) : [])
  const item = payload.item || {}
  const itemId = String(payload.itemId || item.id || payload.toolCallId || '')
  const itemType = String(item.type || payload.type || '')
  const toolName = String(item.toolName || item.name || payload.name || '')
  const isToolItem = itemType !== 'agent_message' && !!toolName

  if (type === 'run_started' || type === 'turn_started') {
    return {
      turnId: String(payload.turnId || current.turnId || runIdFromEvent(event) || ''),
      turnStartedAt: event.time || current.turnStartedAt || null
    }
  }

  if (type === 'turn_item_created' || type === 'turn_item_updated' || type === 'tool_started' || type === 'tool_finished') {
    if (itemId) itemIds.add(itemId)
    if (isToolItem || type === 'tool_started' || type === 'tool_finished') toolItemIds.add(itemId)
    return {
      turnItemIds: [...itemIds],
      turnToolItemIds: [...toolItemIds],
      turnItemCount: itemIds.size,
      turnToolCount: toolItemIds.size,
      turnEvidenceAvailable: toolItemIds.size > 0,
      latestTurnItemAt: event.time || current.latestTurnItemAt || null
    }
  }

  if (type === 'turn_completed' || type === 'run_finished') {
    return {
      turnId: String(payload.turnId || current.turnId || runIdFromEvent(event) || ''),
      turnStatus: String(payload.status || current.turnStatus || 'unknown'),
      turnCompletedAt: event.time || current.turnCompletedAt || null,
      turnDurationMs: payload.durationMs ?? current.turnDurationMs ?? null
    }
  }

  return {}
}

function runIdFromEvent(event = {}) {
  return String(event.runId || '')
}

function startRun(projectId, requestId, metadata = {}) {
  const runId = metadata.runId || makeRunId()
  const runRef = safeCall({ runId, projectId, requestId, journalUnavailable: true }, () => {
    const now = new Date().toISOString()
    writeState(projectId, runId, {
      requestId,
      projectId,
      runId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      metadata
    }, { flush: true })
    activeRuns.set(projectId, runId)
    appendEvent(projectId, runId, 'run_started', { requestId, ...metadata })
    return { runId, projectId, requestId, chatSessionId: String(metadata.chatSessionId || '') }
  })
  try {
    turnLifecycle.beginTurn(projectId, { requestId, runId: runRef.runId })
  } catch (_) { /* 观察台失败不影响发消息 */ }
  return runRef
}

function event(runRef, type, payload = {}) {
  if (!runRef?.projectId || !runRef?.runId) return null
  return safeCall(null, () => appendEvent(runRef.projectId, runRef.runId, type, payload))
}

function finishRun(runRef, status, payload = {}) {
  if (!runRef?.projectId || !runRef?.runId) return null
  const state = safeCall(null, () => {
    const normalizedStatus = status || 'completed'
    appendEvent(runRef.projectId, runRef.runId, 'run_finished', { status: normalizedStatus, ...payload })
    const next = writeState(runRef.projectId, runRef.runId, {
      status: normalizedStatus,
      finishedAt: new Date().toISOString(),
      result: payload
    }, { flush: true })
    if (activeRuns.get(runRef.projectId) === runRef.runId) activeRuns.delete(runRef.projectId)
    return next
  })
  try {
    turnLifecycle.finishTurn(runRef.projectId, status || 'completed', {
      runId: runRef.runId,
      requestId: runRef.requestId
    })
  } catch (_) { /* 观察台失败不影响收尾 */ }
  return state
}

function getActiveRun(projectId) {
  const runId = activeRuns.get(projectId)
  if (!runId) return null
  return readState(projectId, runId)
}

function overlayCachedRuns(projectId, runs, limit) {
  const byId = new Map(runs.map(run => [run.runId, run]))
  for (const state of stateCache.values()) {
    if (!state?.runId) continue
    if (projectId && state.projectId !== projectId) continue
    byId.set(state.runId, state)
  }
  return [...byId.values()]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit)
}

function listRunsFromDirectory(runsDir, options = {}) {
  if (!fs.existsSync(runsDir)) return []
  const limit = Number(options.limit || 50)
  return fs.readdirSync(runsDir)
    .filter(name => name.endsWith('.state.json'))
    .map(name => {
      try {
        return JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf-8'))
      } catch (error) {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit)
}

function listRuns(projectId, options = {}) {
  return safeCall([], () => {
    const limit = Number(options.limit || 50)
    const fromDisk = listRunsFromDirectory(getRunsDir(projectId), {
      ...options,
      limit: Number.MAX_SAFE_INTEGER
    })
    return overlayCachedRuns(projectId, fromDisk, limit)
  })
}

function listRunsFromStoragePath(storagePath, options = {}) {
  return safeCall([], () => {
    if (!String(storagePath || '').trim()) return []
    const resolvedStoragePath = path.resolve(String(storagePath || ''))
    if (!resolvedStoragePath || resolvedStoragePath === path.parse(resolvedStoragePath).root) return []
    return listRunsFromDirectory(path.join(resolvedStoragePath, 'runs'), options)
  })
}

function getRecoverableRuns(projectId) {
  return listRuns(projectId, { limit: 100 })
    .filter(run => !FINAL_STATUSES.has(run.status))
    .map(run => ({ ...run, status: 'recoverable' }))
}

function markStaleRunningRuns(projectId) {
  const runs = listRuns(projectId, { limit: 200 })
  const updated = []
  for (const run of runs) {
    if (run.status === 'running') {
      const state = writeState(projectId, run.runId, {
        status: 'recoverable',
        recoveryReason: 'app_restarted_or_runtime_lost'
      }, { flush: true })
      appendEvent(projectId, run.runId, 'run_recoverable', {
        reason: 'app_restarted_or_runtime_lost'
      })
      updated.push(state)
    }
  }
  return updated
}

module.exports = {
  atomicWriteJson,
  atomicWriteJsonAsync,
  startRun,
  event,
  finishRun,
  getActiveRun,
  listRuns,
  listRunsFromStoragePath,
  cleanupOldRuns,
  cleanupOldRunsDeferred,
  getRecoverableRuns,
  markStaleRunningRuns
}
