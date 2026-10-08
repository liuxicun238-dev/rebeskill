/**
 * In-memory file version observations for write/edit guards.
 *
 * After a successful read (or a confirmed miss), remember present/absent plus a
 * content hash. Mutating tools then refuse to clobber a file that was never
 * observed, or that changed since the last observation.
 *
 * This is Lingxi-native (no session event log):
 * - write: unseen/absent → createIfAbsent; present → replaceIfVersion
 * - edit: unobserved is allowed (old_content / hunk matching still applies);
 *   a recorded observation must still be fresh
 * - successful mutations refresh the observation so the same turn can keep writing
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { toProjectRelative } = require('../path-utils')

const observationsByProject = new Map()

function normalizePath(filePath) {
  return path.resolve(String(filePath || ''))
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function sha256Text(value = '') {
  return sha256Buffer(Buffer.from(String(value ?? ''), 'utf-8'))
}

function projectMap(projectId) {
  if (!projectId) return null
  if (!observationsByProject.has(projectId)) {
    observationsByProject.set(projectId, new Map())
  }
  return observationsByProject.get(projectId)
}

function getObservation(projectId, filePath) {
  if (!projectId || !filePath) return null
  const map = observationsByProject.get(projectId)
  if (!map) return null
  return map.get(normalizePath(filePath)) || null
}

function recordObservation(projectId, filePath, observation) {
  if (!projectId || !filePath || !observation) return null
  const map = projectMap(projectId)
  const entry = {
    kind: observation.kind === 'absent' ? 'absent' : 'present',
    hash: observation.hash || null,
    size: Number(observation.size) || 0,
    mtimeMs: observation.mtimeMs == null ? null : Number(observation.mtimeMs),
    observedAt: Date.now()
  }
  map.set(normalizePath(filePath), entry)
  return entry
}

async function snapshotFile(filePath) {
  const normalized = normalizePath(filePath)
  try {
    const stat = await fs.promises.stat(normalized)
    if (!stat.isFile()) {
      return {
        kind: 'unsupported',
        exists: true,
        hash: null,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      }
    }
    const buffer = await fs.promises.readFile(normalized)
    return {
      kind: 'present',
      exists: true,
      hash: sha256Buffer(buffer),
      size: buffer.length,
      mtimeMs: stat.mtimeMs
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { kind: 'absent', exists: false, hash: null, size: 0, mtimeMs: null }
    }
    throw error
  }
}

async function recordPresentObservation(projectId, filePath, extras = {}) {
  if (!projectId || !filePath) return null
  if (extras.hash) {
    return recordObservation(projectId, filePath, {
      kind: 'present',
      hash: extras.hash,
      size: extras.size,
      mtimeMs: extras.mtimeMs
    })
  }
  if (extras.buffer) {
    const buffer = extras.buffer
    return recordObservation(projectId, filePath, {
      kind: 'present',
      hash: sha256Buffer(buffer),
      size: buffer.length,
      mtimeMs: extras.mtimeMs
    })
  }
  if (extras.content != null) {
    const buffer = Buffer.from(String(extras.content), 'utf-8')
    return recordObservation(projectId, filePath, {
      kind: 'present',
      hash: sha256Buffer(buffer),
      size: buffer.length,
      mtimeMs: extras.mtimeMs
    })
  }
  const snapshot = await snapshotFile(filePath)
  if (snapshot.kind !== 'present') {
    return recordObservation(projectId, filePath, { kind: 'absent' })
  }
  return recordObservation(projectId, filePath, snapshot)
}

function recordAbsentObservation(projectId, filePath) {
  return recordObservation(projectId, filePath, { kind: 'absent' })
}

function hasFileBeenRead(projectId, filePath) {
  const observed = getObservation(projectId, filePath)
  return !!(observed && observed.kind === 'present')
}

function clearProjectReadRecords(projectId) {
  if (projectId) observationsByProject.delete(projectId)
}

function rereadAction(toolName = '') {
  const name = String(toolName || 'write_file')
  if (name === 'text_edit' || name === 'edit_file' || name === 'json_edit' || name === 'apply_patch') {
    return `重新调用 read_file 读取该文件当前内容，用最新片段构造 old_content / 补丁后再重试 ${name}。`
  }
  return `重新调用 read_file 读取该文件当前内容，确认后再调用 ${name}。`
}

function failGuard({
  filePath,
  errorType,
  message,
  toolName,
  observed,
  current,
  intent
}) {
  return {
    ok: false,
    intent: intent || '',
    error_type: errorType,
    path: filePath,
    message,
    next_action: rereadAction(toolName),
    observed_kind: observed?.kind || null,
    observed_hash: observed?.hash || null,
    current_kind: current?.kind || null,
    current_hash: current?.hash || null
  }
}

async function assertFileVersion(projectId, filePath, options = {}) {
  const mode = options.mode === 'edit' ? 'edit' : 'write'
  const toolName = options.toolName || (mode === 'edit' ? 'text_edit' : 'write_file')
  const normalized = normalizePath(filePath)
  if (!projectId || options.skip) {
    return { ok: true, skipped: true, path: normalized, intent: 'skipped' }
  }

  const current = await snapshotFile(normalized)
  const observed = getObservation(projectId, normalized)

  if (mode === 'write') {
    if (!observed || observed.kind === 'absent') {
      if (current.kind === 'present') {
        const appearedAfterAbsent = observed?.kind === 'absent'
        return failGuard({
          filePath: normalized,
          errorType: appearedAfterAbsent ? 'stale_file_version' : 'must_read_before_write',
          message: appearedAfterAbsent
            ? `${toolName} 拦截：上次读取时文件不存在，但现在已经存在，拒绝覆盖。请重新读取确认当前内容后再写入。`
            : `${toolName} 拦截：已存在的文件必须先用 read_file 读取后才能覆盖写入。请先调用 read_file 读取该文件，确认原内容后再写入。`,
          toolName,
          observed,
          current,
          intent: 'createIfAbsent'
        })
      }
      if (current.kind === 'unsupported') {
        return failGuard({
          filePath: normalized,
          errorType: 'not_a_file',
          message: `${toolName} 拦截：目标路径不是普通文件，拒绝覆盖。`,
          toolName,
          observed,
          current,
          intent: 'createIfAbsent'
        })
      }
      return { ok: true, path: normalized, intent: 'createIfAbsent' }
    }

    if (current.kind !== 'present' || current.hash !== observed.hash) {
      return failGuard({
        filePath: normalized,
        errorType: 'stale_file_version',
        message: `${toolName} 拦截：目标文件在读取之后已被修改或删除，拒绝覆盖过期内容。请重新读取当前内容后再写入。`,
        toolName,
        observed,
        current,
        intent: 'replaceIfVersion'
      })
    }
    return { ok: true, path: normalized, intent: 'replaceIfVersion' }
  }

  if (!observed) {
    return { ok: true, path: normalized, intent: 'unobservedEditAllowed' }
  }
  if (observed.kind === 'absent') {
    return failGuard({
      filePath: normalized,
      errorType: 'file_not_found',
      message: `${toolName} 拦截：上次读取时文件不存在，不能按已有内容编辑。请确认路径，或改为新建写入。`,
      toolName,
      observed,
      current,
      intent: 'editAbsent'
    })
  }
  if (current.kind !== 'present' || current.hash !== observed.hash) {
    return failGuard({
      filePath: normalized,
      errorType: 'stale_file_version',
      message: `${toolName} 拦截：目标文件在读取之后已被修改，拒绝按过期内容改写。请重新读取当前内容后再编辑。`,
      toolName,
      observed,
      current,
      intent: 'replaceIfVersion'
    })
  }
  return { ok: true, path: normalized, intent: 'replaceIfVersion' }
}

function toToolResult(guard, projectPath = '', extra = {}) {
  if (!guard || guard.ok) return null
  return {
    success: false,
    error_type: guard.error_type,
    recoverable: true,
    path: guard.path,
    relative_path: toProjectRelative(projectPath, guard.path),
    message: guard.message,
    next_action: guard.next_action,
    observed_kind: guard.observed_kind,
    observed_hash: guard.observed_hash,
    current_kind: guard.current_kind,
    current_hash: guard.current_hash,
    ...extra
  }
}

function throwIfGuardFailed(guard) {
  if (!guard || guard.ok) return
  const error = new Error(guard.message)
  error.error_type = guard.error_type
  error.guard = guard
  throw error
}

module.exports = {
  normalizePath,
  sha256Buffer,
  sha256Text,
  snapshotFile,
  getObservation,
  recordObservation,
  recordPresentObservation,
  recordAbsentObservation,
  hasFileBeenRead,
  clearProjectReadRecords,
  assertFileVersion,
  toToolResult,
  throwIfGuardFailed
}
