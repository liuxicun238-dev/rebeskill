const fs = require('fs')
const path = require('path')

const MODE_FILE = 'project-mode.json'
const MODE_VERSION = 1

class ProjectModeConflictError extends Error {
  constructor(projectId, requestedMode, existingMode) {
    super('项目“' + (projectId || 'unknown') + '”已锁定为' + modeLabel(existingMode) + '，不能改为' + modeLabel(requestedMode))
    this.name = 'ProjectModeConflictError'
    this.code = 'PROJECT_MODE_CONFLICT'
    this.projectId = String(projectId || '')
    this.requestedMode = normalizeMode(requestedMode)
    this.existingMode = normalizeMode(existingMode)
  }
}

class ProjectModeStorageConflictError extends Error {
  constructor(projectId, storedProjectId) {
    super('项目“' + (projectId || 'unknown') + '”不能使用属于项目“' + (storedProjectId || 'unknown') + '”的模式存储')
    this.name = 'ProjectModeStorageConflictError'
    this.code = 'PROJECT_MODE_STORAGE_CONFLICT'
    this.projectId = String(projectId || '')
    this.storedProjectId = String(storedProjectId || '')
  }
}

function normalizeMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'research' ? 'research' : 'standard'
}

function modeLabel(mode) {
  return normalizeMode(mode) === 'research' ? '研究模式' : '标准模式'
}

function storageRoot(instance = {}) {
  return String(instance.rootStoragePath || instance.storagePath || '').trim()
}

function getModePath(instance = {}) {
  const root = storageRoot(instance)
  if (!root) throw new Error('项目模式锁缺少项目存储目录')
  return path.join(root, MODE_FILE)
}

function readMode(instance = {}) {
  const filePath = getModePath(instance)
  if (!fs.existsSync(filePath)) return null
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!['standard', 'research'].includes(parsed?.mode)) {
    throw new Error('项目模式锁文件无效：' + filePath)
  }
  const projectId = String(instance.projectId || '')
  const storedProjectId = String(parsed?.projectId || '')
  if (projectId && storedProjectId && projectId !== storedProjectId) {
    throw new ProjectModeStorageConflictError(projectId, storedProjectId)
  }
  return normalizeMode(parsed.mode)
}

function writeMode(instance = {}, mode = 'standard') {
  const filePath = getModePath(instance)
  const value = normalizeMode(mode)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const payload = {
    version: MODE_VERSION,
    projectId: String(instance.projectId || ''),
    mode: value,
    locked: true,
    createdAt: Date.now()
  }
  const tempPath = filePath + '.' + process.pid + '.' + Date.now() + '.tmp'
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.renameSync(tempPath, filePath)
  return value
}

function setProvisionalProjectMode(instance = {}, requestedMode) {
  const hasRequested = requestedMode !== undefined && requestedMode !== null && String(requestedMode).trim() !== ''
  const requested = hasRequested ? normalizeMode(requestedMode) : null
  const memoryMode = instance.projectModeLocked ? normalizeMode(instance.projectMode) : null
  const diskMode = readMode(instance)
  const existing = diskMode || memoryMode

  if (diskMode && memoryMode && diskMode !== memoryMode) {
    throw new ProjectModeConflictError(instance.projectId, memoryMode, diskMode)
  }
  if (existing && requested && existing !== requested) {
    throw new ProjectModeConflictError(instance.projectId, requested, existing)
  }

  const resolved = existing || requested || normalizeMode(instance.projectMode)
  instance.projectMode = resolved
  instance.projectModeLocked = !!existing
  return resolved
}

function assertRequestMode(instance = {}, requestedMode) {
  const hasRequested = requestedMode !== undefined && requestedMode !== null && String(requestedMode).trim() !== ''
  const requested = hasRequested ? normalizeMode(requestedMode) : normalizeMode(instance.projectMode)
  const diskMode = readMode(instance)
  const memoryMode = instance.projectModeLocked ? normalizeMode(instance.projectMode) : null
  const existing = diskMode || memoryMode

  if (diskMode && memoryMode && diskMode !== memoryMode) {
    throw new ProjectModeConflictError(instance.projectId, memoryMode, diskMode)
  }
  if (existing && requested !== existing) {
    throw new ProjectModeConflictError(instance.projectId, requested, existing)
  }

  const resolved = existing || requested
  if (!diskMode) writeMode(instance, resolved)
  instance.projectMode = resolved
  instance.projectModeLocked = true
  return resolved
}

function isProjectModeLocked(instance = {}) {
  const diskMode = readMode(instance)
  if (diskMode) {
    instance.projectMode = diskMode
    instance.projectModeLocked = true
    return true
  }
  return instance.projectModeLocked === true
}

module.exports = {
  ProjectModeConflictError,
  ProjectModeStorageConflictError,
  normalizeMode,
  modeLabel,
  getModePath,
  readMode,
  setProvisionalProjectMode,
  assertRequestMode,
  isProjectModeLocked
}
