const fs = require('fs')
const path = require('path')
const storageConfig = require('./storage-config')

const FILE_NAME = 'path-permissions.json'
const VERSION = 2
const FILE_PERMISSION_OPERATIONS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'create_directory',
  'list_files',
  'render_svg_asset',
  'runtime_verify',
  'capture_screenshot',
  'inspect_image',
  'vision_analyze',
  'run_command',
  'terminal_run',
  'find_software',
  'open_software',
  'desktop_control'
])

function normalizePath(value = '') {
  if (!value) return ''
  return path.resolve(String(value)).toLowerCase()
}

function isPathInside(parentPath, childPath) {
  if (!parentPath || !childPath) return false
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath))
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function getStorePath() {
  try {
    const configDir = storageConfig.getConfigDir()
    if (configDir) return path.join(configDir, FILE_NAME)
  } catch (error) { /* storageConfig 尚未初始化 */ }
  return path.join(process.cwd(), '.lingxi', 'config', FILE_NAME)
}

function normalizeMode(mode) {
  if (mode === 'auto' || mode === 'critical') return 'ask'
  return ['ask', 'smart', 'full'].includes(mode) ? mode : 'ask'
}

function normalizeModes(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    const id = String(key || '').trim()
    if (!id) continue
    out[id] = normalizeMode(value)
  }
  return out
}

function emptyStore() {
  return { version: VERSION, mode: 'ask', modes: {}, rules: [] }
}

function readStore() {
  try {
    const filePath = getStorePath()
    if (!fs.existsSync(filePath)) return emptyStore()
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return {
      version: VERSION,
      mode: normalizeMode(data.mode),
      modes: normalizeModes(data.modes),
      rules: Array.isArray(data.rules) ? data.rules : []
    }
  } catch (error) {
    return emptyStore()
  }
}

function writeStore(store) {
  const filePath = getStorePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify({
    version: VERSION,
    mode: normalizeMode(store.mode),
    modes: normalizeModes(store.modes),
    updatedAt: Date.now(),
    rules: Array.isArray(store.rules) ? store.rules : []
  }, null, 2), 'utf-8')
}

function getModeFromStore(store, projectId) {
  const id = String(projectId || '').trim()
  if (id && store.modes && store.modes[id]) return store.modes[id]
  return normalizeMode(store.mode)
}

function getMode(projectId) {
  return getModeFromStore(readStore(), projectId)
}

function getSettings(projectId) {
  const store = readStore()
  const id = String(projectId || '').trim()
  return {
    version: store.version,
    mode: getModeFromStore(store, id),
    defaultMode: normalizeMode(store.mode),
    projectId: id || null,
    rules: Array.isArray(store.rules) ? store.rules : []
  }
}

function setMode(mode, projectId) {
  const store = readStore()
  const value = normalizeMode(mode)
  const id = String(projectId || '').trim()
  if (id) {
    if (!store.modes || typeof store.modes !== 'object') store.modes = {}
    store.modes[id] = value
  } else {
    store.mode = value
  }
  writeStore(store)
  return getSettings(id)
}

function makeRuleKey(projectId, operation, targetPath) {
  return [
    String(projectId || 'global'),
    String(operation || 'unknown'),
    normalizePath(targetPath)
  ].join('|')
}

function getParentDirectory(targetPath) {
  if (!targetPath) return ''
  try {
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath)
      return stat.isDirectory() ? targetPath : path.dirname(targetPath)
    }
  } catch (error) { /* 文件状态读取失败 */ }
  const ext = path.extname(targetPath)
  return ext ? path.dirname(targetPath) : targetPath
}

function isInsideProject(projectPath, targetPath) {
  if (!projectPath || !targetPath) return true
  return isPathInside(projectPath, targetPath)
}

function findAllowedRule(projectId, operation, targetPath) {
  const store = readStore()
  if (getModeFromStore(store, projectId) === 'full') {
    return { key: 'full-access-mode', mode: 'full', allowed: true }
  }
  const normalizedTarget = normalizePath(targetPath)
  const normalizedOperation = String(operation || 'unknown')
  const normalizedProjectId = String(projectId || 'global')

  return store.rules.find(rule => {
    if (!rule || rule.allowed !== true) return false
    const ruleProjectId = String(rule.projectId || 'global')
    if (ruleProjectId !== 'global' && ruleProjectId !== normalizedProjectId) return false
    const ruleOperation = String(rule.operation || 'unknown')
    const operationMatches = ruleOperation === '*'
      || ruleOperation === normalizedOperation
      || (ruleOperation === 'manual_path' && FILE_PERMISSION_OPERATIONS.has(normalizedOperation))
    if (!operationMatches) return false
    if (rule.scope === 'path') return normalizePath(rule.path) === normalizedTarget
    if (rule.scope === 'directory') return isPathInside(rule.path, targetPath)
    return false
  }) || null
}

function rememberAllowed(projectId, operation, targetPath, options = {}) {
  const store = readStore()
  const scope = options.scope === 'path' ? 'path' : 'directory'
  const rememberedPath = scope === 'path' ? targetPath : getParentDirectory(targetPath)
  const key = makeRuleKey(projectId, operation, scope === 'path' ? rememberedPath : `${rememberedPath}${path.sep}*`)
  const rule = {
    key,
    projectId: String(projectId || 'global'),
    operation: String(operation || 'unknown'),
    allowed: true,
    scope,
    path: path.resolve(rememberedPath),
    label: options.label || '',
    kind: options.kind || (scope === 'path' ? 'application' : 'path'),
    createdAt: Date.now()
  }

  store.rules = [rule, ...store.rules.filter(item => item?.key !== key)].slice(0, 500)
  writeStore(store)
  return rule
}

function listRules() {
  return getSettings()
}

function removeRule(key) {
  const store = readStore()
  const before = store.rules.length
  store.rules = store.rules.filter(rule => rule?.key !== key)
  writeStore(store)
  return { success: true, removed: before - store.rules.length, settings: getSettings() }
}

function addManualRule(input = {}) {
  const targetPath = input.path || ''
  if (!targetPath) return { success: false, error: 'path is required' }
  const kind = input.kind === 'application' ? 'application' : 'path'
  const operation = input.operation || '*'
  const rule = rememberAllowed(input.projectId || 'global', operation, targetPath, {
    scope: kind === 'application' ? 'path' : 'directory',
    label: input.label || 'manual',
    kind
  })
  return { success: true, rule, settings: getSettings(input.projectId) }
}

function registerIPC(ipcMain, dialog) {
  ipcMain.handle('path-permissions:get', async (event, projectId) => ({ success: true, ...getSettings(projectId) }))
  ipcMain.handle('path-permissions:set-mode', async (event, mode, projectId) => ({ success: true, ...setMode(mode, projectId) }))
  ipcMain.handle('path-permissions:remove', async (event, key) => removeRule(key))
  ipcMain.handle('path-permissions:add', async (event, input = {}) => addManualRule(input))
  ipcMain.handle('path-permissions:select-path', async (event, kind = 'path') => {
    const result = kind === 'application'
      ? await dialog.showOpenDialog({ title: '选择要授权的应用', properties: ['openFile'] })
      : await dialog.showOpenDialog({ title: '选择要授权的路径', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true }
    return { success: true, path: result.filePaths[0] }
  })
}

module.exports = {
  normalizePath,
  isPathInside,
  isInsideProject,
  findAllowedRule,
  rememberAllowed,
  getParentDirectory,
  getSettings,
  getMode,
  setMode,
  listRules,
  removeRule,
  addManualRule,
  registerIPC
}
