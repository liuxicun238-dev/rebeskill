/**
 * 项目级能力状态。
 *
 * Codex 的延迟工具状态不会只存在一次请求的局部变量中。这里把已经
 * 发现/加载的工具包保存到项目存储目录，使切换项目、新开一轮追问时，
 * 下一次模型请求仍能看到上一轮已经加载的能力。
 */

const fs = require('fs')
const path = require('path')

const STATE_FILE_NAME = 'capability-state.json'
const STATE_VERSION = 1
const MAX_PACKS = 32
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

function normalizePackId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

function getStorageRoot(target) {
  if (typeof target === 'string') return target
  if (!target || typeof target !== 'object') return ''
  return String(
    target.rootStoragePath ||
    target.storagePath ||
    target.contextStoragePath ||
    ''
  ).trim()
}

function getStatePath(target) {
  const root = getStorageRoot(target)
  return root ? path.join(root, STATE_FILE_NAME) : ''
}

function normalizeState(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const loadedPacks = Array.isArray(source.loadedPacks)
    ? source.loadedPacks.map(normalizePackId).filter(Boolean).slice(0, MAX_PACKS)
    : []
  const loadedAt = source.loadedAt && typeof source.loadedAt === 'object'
    ? Object.fromEntries(
        Object.entries(source.loadedAt)
          .map(([key, timestamp]) => [normalizePackId(key), Number(timestamp) || 0])
          .filter(([key, timestamp]) => key && timestamp > 0)
          .slice(0, MAX_PACKS)
      )
    : {}
  const now = Date.now()
  const retained = loadedPacks.filter(packId => {
    const timestamp = Number(loadedAt[packId]) || 0
    return !timestamp || now - timestamp <= RETENTION_MS
  })
  return {
    version: STATE_VERSION,
    loadedPacks: [...new Set(retained)].slice(0, MAX_PACKS),
    loadedAt,
    updatedAt: Number(source.updatedAt) || 0
  }
}

function attachState(instance, state, statePath) {
  if (!instance || typeof instance !== 'object') return state
  instance._capabilityState = state
  instance._capabilityStatePath = statePath || ''
  instance._capabilityStateLoaded = true
  instance._enabledToolPacks = new Set(state.loadedPacks)
  return state
}

function loadForInstance(instance) {
  const statePath = getStatePath(instance)
  if (!statePath) return attachState(instance, normalizeState(), '')
  if (instance?._capabilityStateLoaded && instance._capabilityStatePath === statePath) {
    return instance._capabilityState || normalizeState()
  }

  let state = normalizeState()
  try {
    if (fs.existsSync(statePath)) {
      state = normalizeState(JSON.parse(fs.readFileSync(statePath, 'utf8')))
    }
  } catch (error) {
    console.warn('[CapabilityState] read state failed:', statePath, error.message)
  }
  return attachState(instance, state, statePath)
}

function saveState(instance) {
  const statePath = getStatePath(instance) || instance?._capabilityStatePath || ''
  if (!statePath || !instance) return false
  const state = normalizeState(instance._capabilityState || {
    loadedPacks: [...(instance._enabledToolPacks || [])]
  })
  state.updatedAt = Date.now()
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8')
    fs.renameSync(tempPath, statePath)
    attachState(instance, state, statePath)
    return true
  } catch (error) {
    console.warn('[CapabilityState] write state failed:', statePath, error.message)
    return false
  }
}

function getLoadedPacks(instance) {
  const state = loadForInstance(instance)
  return [...new Set([
    ...state.loadedPacks,
    ...(instance?._enabledToolPacks instanceof Set ? [...instance._enabledToolPacks] : [])
  ].map(normalizePackId).filter(Boolean))]
}

function enableToolPack(instance, packId) {
  const id = normalizePackId(packId)
  if (!instance || !id) return false
  const state = loadForInstance(instance)
  if (!state.loadedPacks.includes(id)) state.loadedPacks.push(id)
  state.loadedPacks = [...new Set(state.loadedPacks)].slice(0, MAX_PACKS)
  state.loadedAt[id] = Date.now()
  state.updatedAt = Date.now()
  instance._capabilityState = state
  instance._enabledToolPacks = new Set(state.loadedPacks)
  saveState(instance)
  return true
}

function disableToolPack(instance, packId) {
  const id = normalizePackId(packId)
  if (!instance || !id) return false
  const state = loadForInstance(instance)
  state.loadedPacks = state.loadedPacks.filter(item => item !== id)
  delete state.loadedAt[id]
  instance._capabilityState = state
  instance._enabledToolPacks = new Set(state.loadedPacks)
  saveState(instance)
  return true
}

module.exports = {
  STATE_FILE_NAME,
  normalizeState,
  getStatePath,
  loadForInstance,
  saveState,
  getLoadedPacks,
  enableToolPack,
  disableToolPack
}
