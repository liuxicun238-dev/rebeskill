/**
 * Read local Cursor composer chats (state.vscdb) and map them to Lingxi history.
 * Only opens Cursor User state.vscdb / workspace.json. Never reads tokens, cookies,
 * storage.json, messageRequestContext, or checkpoint blobs.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const contextCompression = require('./context-compression')
const chatMessageIdentity = require('./chat-message-identity')
const codexImport = require('./codex-session-import')

const RETAIN_LIVE_USER_TURNS = 8
const MAX_SESSIONS = 400
const BUBBLE_BATCH = 200
const COMPOSER_ID_RE = /^[A-Za-z0-9._-]{6,80}$/
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig
const FORBIDDEN_BASENAMES = new Set([
  'storage.json',
  'secret.json',
  'secrets.json',
  'credentials.json',
  'auth.json',
  'tokens.json',
  '.env'
])

function getCursorUserDir(options = {}) {
  const override = String(options.cursorUserDir || process.env.CURSOR_USER_DIR || '').trim()
  if (override) return path.resolve(override)
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User')
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User')
}

function isPathInside(child, parent) {
  const resolvedChild = path.resolve(child)
  const resolvedParent = path.resolve(parent)
  const rel = path.relative(resolvedParent, resolvedChild)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function assertCursorReadablePath(filePath, userDir) {
  const resolved = path.resolve(filePath)
  const home = path.resolve(userDir)
  if (!isPathInside(resolved, home) && resolved !== home) {
    const error = new Error('path is outside the Cursor user directory')
    error.code = 'CURSOR_PATH_DENIED'
    throw error
  }
  const base = path.basename(resolved).toLowerCase()
  if (FORBIDDEN_BASENAMES.has(base)) {
    const error = new Error('refusing to read a Cursor credential file')
    error.code = 'CURSOR_PATH_DENIED'
    throw error
  }
  const rel = path.relative(home, resolved).replace(/\\/g, '/')
  const allowed = (
    rel === 'globalStorage/state.vscdb'
    || /^workspaceStorage\/[^/]+\/state\.vscdb$/.test(rel)
    || /^workspaceStorage\/[^/]+\/workspace\.json$/.test(rel)
  )
  if (!allowed) {
    const error = new Error('refusing to read a non-session Cursor file')
    error.code = 'CURSOR_PATH_DENIED'
    throw error
  }
  return resolved
}

function assertComposerId(composerId) {
  const value = String(composerId || '').trim()
  if (!COMPOSER_ID_RE.test(value) || value === 'empty-state-draft') {
    const error = new Error('invalid Cursor session id')
    error.code = 'SESSION_MISSING'
    throw error
  }
  return value
}

async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath)
    return true
  } catch {
    return false
  }
}

function blobToString(value) {
  if (value == null) return ''
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return String(value)
}

function parseJson(value) {
  const text = blobToString(value).trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function openReadonlySqlite(dbPath) {
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(dbPath, { readOnly: true })
}

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  } catch {
    return false
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

function selectValueByKey(db, table, key) {
  if (!tableExists(db, table)) return null
  try {
    const row = db.prepare(`SELECT value FROM ${quoteIdent(table)} WHERE ${quoteIdent('key')} = ?`).get(key)
    return row ? parseJson(row.value) : null
  } catch {
    return null
  }
}

function normalizeFsPath(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return path.normalize(raw)
}

function fileUriToPath(uri) {
  if (!uri) return ''
  if (typeof uri === 'object') {
    if (uri.fsPath) return normalizeFsPath(uri.fsPath)
    if (uri.scheme && String(uri.scheme) !== 'file') return ''
    if (uri.path) {
      let value = String(uri.path)
      if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1)
      return normalizeFsPath(value)
    }
    return fileUriToPath(uri.external || uri.folder)
  }
  const raw = String(uri).trim()
  if (!raw) return ''
  if (/^vscode-remote:/i.test(raw)) return ''
  if (!/^file:/i.test(raw)) {
    return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') ? normalizeFsPath(raw) : ''
  }
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'file:') return ''
    let value = decodeURIComponent(parsed.pathname)
    if (/^\/[A-Za-z]:/.test(value)) value = value.slice(1)
    return normalizeFsPath(value)
  } catch {
    return ''
  }
}

function firstLine(text, max = 80) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function headerType(header) {
  return Number(header?.type)
}

function bubbleRole(type) {
  if (Number(type) === 1) return 'user'
  if (Number(type) === 2) return 'assistant'
  return ''
}

function extractBubbleText(bubble) {
  if (!bubble || typeof bubble !== 'object') return ''
  if (typeof bubble.text === 'string' && bubble.text.trim()) return bubble.text
  if (typeof bubble.richText === 'string' && bubble.richText.trim() && !bubble.richText.trim().startsWith('{')) {
    return bubble.richText
  }
  return ''
}

function extractVisibleUserText(text) {
  const raw = String(text || '')
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)
  if (query && String(query[1] || '').trim()) return String(query[1]).trim()
  return raw
}

function isCursorSystemUserText(bubble, text) {
  if (bubble && (bubble.isSimulatedMsg === true || Number(bubble.simulatedMsgReason) > 0)) return true
  const value = String(text || '')
  if (/<system_notification\b/i.test(value)) return true
  if (/The following task has (?:finished|notified)/i.test(value)) return true
  if (/<task\b/i.test(value) && /(?:kind|status|task_id|tool_call_id)\s*:/i.test(value)) return true
  return false
}

function isToolOnlyBubble(bubble) {
  if (!bubble || typeof bubble !== 'object') return false
  if (extractBubbleText(bubble)) return false
  return !!(
    bubble.toolFormerData
    || (Array.isArray(bubble.toolResults) && bubble.toolResults.length)
    || bubble.capabilityType
    || bubble.tool
    || bubble.thinking
  )
}

function pushImportedMessage(items, role, text, time) {
  const last = items[items.length - 1]
  if (last?.kind === 'message' && last.role === role && role === 'assistant') {
    last.content = `${last.content}\n\n${text}`.replace(/\n{3,}/g, '\n\n').trim()
    if (time) last.time = time
    return
  }
  items.push({
    kind: 'message',
    role,
    content: text,
    images: [],
    time: time || ''
  })
}

function collectComposerIds(value, acc = new Set()) {
  if (value == null) return acc
  if (typeof value === 'string') {
    if (COMPOSER_ID_RE.test(value) && value.includes('-')) acc.add(value)
    for (const match of value.matchAll(UUID_RE)) acc.add(match[0])
    return acc
  }
  if (Array.isArray(value)) {
    for (const item of value) collectComposerIds(item, acc)
    return acc
  }
  if (typeof value === 'object') {
    if (value.composerId) collectComposerIds(value.composerId, acc)
    for (const item of Object.values(value)) collectComposerIds(item, acc)
  }
  return acc
}

function workspacePathFromMeta(meta = {}, workspaceMap = new Map()) {
  const fromUri = fileUriToPath(meta.workspaceIdentifier?.uri)
    || fileUriToPath(meta.draftTarget?.environment?.uri)
    || fileUriToPath(meta.cwd)
    || fileUriToPath(meta.folder)
  if (fromUri) return fromUri
  const workspaceId = String(meta.workspaceId || meta.workspaceIdentifier?.id || '').trim()
  if (workspaceId && workspaceMap.has(workspaceId)) return workspaceMap.get(workspaceId)
  return ''
}

function upsertSession(byId, meta = {}) {
  const composerId = String(meta.composerId || meta.id || '').trim()
  if (!COMPOSER_ID_RE.test(composerId) || composerId === 'empty-state-draft') return
  const prev = byId.get(composerId) || { composerId }
  const next = {
    ...prev,
    composerId,
    name: meta.name || prev.name || '',
    subtitle: meta.subtitle || prev.subtitle || '',
    cwd: meta.cwd || prev.cwd || '',
    workspaceId: meta.workspaceId || prev.workspaceId || '',
    createdAt: Number(meta.createdAt || prev.createdAt || 0) || 0,
    updatedAt: Number(meta.lastUpdatedAt || meta.updatedAt || meta.recency || prev.updatedAt || 0) || 0,
    unifiedMode: meta.unifiedMode || prev.unifiedMode || '',
    isDraft: meta.isDraft === true || prev.isDraft === true,
    isSubagent: meta.isSubagent === true || Number(meta.isSubagent) === 1 || prev.isSubagent === true,
    isEphemeral: meta.isEphemeral === true || prev.isEphemeral === true,
    isArchived: meta.isArchived === true || Number(meta.isArchived) === 1 || prev.isArchived === true,
    userTurns: Number(meta.userTurns || prev.userTurns || 0) || 0,
    headerCount: Number(meta.headerCount || prev.headerCount || 0) || 0,
    hasComposerData: meta.hasComposerData === true || prev.hasComposerData === true,
    modelName: meta.modelName || prev.modelName || ''
  }
  byId.set(composerId, next)
}

function readWorkspaceMap(userDir) {
  const root = path.join(userDir, 'workspaceStorage')
  const map = new Map()
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return map
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metaPath = path.join(root, entry.name, 'workspace.json')
    try {
      assertCursorReadablePath(metaPath, userDir)
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      const folder = fileUriToPath(raw?.folder || raw?.workspace)
      if (folder) map.set(entry.name, folder)
    } catch {
      // skip unreadable / forbidden workspace files
    }
  }
  return map
}

function readWorkspaceComposerIndex(userDir, workspaceMap, byId) {
  const root = path.join(userDir, 'workspaceStorage')
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dbPath = path.join(root, entry.name, 'state.vscdb')
    if (!fs.existsSync(dbPath)) continue
    let db
    try {
      assertCursorReadablePath(dbPath, userDir)
      db = openReadonlySqlite(dbPath)
    } catch {
      continue
    }
    try {
      const cwd = workspaceMap.get(entry.name) || ''
      const composerData = selectValueByKey(db, 'ItemTable', 'composer.composerData') || {}
      for (const item of Array.isArray(composerData.allComposers) ? composerData.allComposers : []) {
        upsertSession(byId, {
          ...item,
          cwd: workspacePathFromMeta(item, workspaceMap) || cwd,
          workspaceId: entry.name
        })
      }
      const extraIds = new Set()
      collectComposerIds(composerData.selectedComposerIds, extraIds)
      collectComposerIds(composerData.lastFocusedComposerIds, extraIds)
      if (tableExists(db, 'ItemTable')) {
        let rows = []
        try {
          rows = db.prepare(
            `SELECT ${quoteIdent('key')} AS key, value FROM ItemTable WHERE ${quoteIdent('key')} LIKE 'workbench.panel.composerChatViewPane%'`
          ).all()
        } catch {
          rows = []
        }
        for (const row of rows) collectComposerIds(parseJson(row.value) || blobToString(row.value), extraIds)
      }
      for (const composerId of extraIds) {
        upsertSession(byId, { composerId, cwd, workspaceId: entry.name })
      }
    } finally {
      try { db.close() } catch {}
    }
  }
}

function readComposerHeadersTable(db, workspaceMap, byId) {
  if (!tableExists(db, 'composerHeaders')) return
  let rows = []
  try {
    rows = db.prepare(
      'SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value FROM composerHeaders'
    ).all()
  } catch {
    return
  }
  for (const row of rows) {
    const value = parseJson(row.value) || {}
    upsertSession(byId, {
      ...value,
      composerId: row.composerId,
      workspaceId: row.workspaceId || value.workspaceIdentifier?.id || '',
      createdAt: row.createdAt || value.createdAt,
      lastUpdatedAt: row.lastUpdatedAt || value.lastUpdatedAt || row.recency,
      isArchived: row.isArchived,
      isSubagent: row.isSubagent,
      cwd: workspacePathFromMeta({
        workspaceIdentifier: value.workspaceIdentifier,
        draftTarget: value.draftTarget,
        workspaceId: row.workspaceId
      }, workspaceMap)
    })
  }
}

function readLegacyComposerHeaders(db, workspaceMap, byId) {
  const headers = selectValueByKey(db, 'ItemTable', 'composer.composerHeaders')
  for (const item of Array.isArray(headers?.allComposers) ? headers.allComposers : []) {
    upsertSession(byId, {
      ...item,
      cwd: workspacePathFromMeta(item, workspaceMap)
    })
  }
}

function slimComposerData(raw) {
  if (!raw || typeof raw !== 'object') return null
  const headers = Array.isArray(raw.fullConversationHeadersOnly) ? raw.fullConversationHeadersOnly : []
  const conversationMap = raw.conversationMap && typeof raw.conversationMap === 'object'
    ? raw.conversationMap
    : {}
  return {
    composerId: String(raw.composerId || ''),
    name: String(raw.name || ''),
    subtitle: String(raw.subtitle || ''),
    createdAt: Number(raw.createdAt || 0) || 0,
    lastUpdatedAt: Number(raw.lastUpdatedAt || raw.createdAt || 0) || 0,
    unifiedMode: String(raw.unifiedMode || ''),
    modelName: String(raw.modelConfig?.modelName || raw.modelName || ''),
    workspaceIdentifier: raw.workspaceIdentifier && typeof raw.workspaceIdentifier === 'object'
      ? raw.workspaceIdentifier
      : null,
    isDraft: raw.isDraft === true,
    isSubagent: raw.isSubagent === true || raw.isBestOfNSubcomposer === true,
    headers: headers.map(item => ({
      bubbleId: String(item?.bubbleId || ''),
      type: Number(item?.type)
    })).filter(item => item.bubbleId),
    conversationMap
  }
}

function readComposerData(db, composerId) {
  const raw = selectValueByKey(db, 'cursorDiskKV', `composerData:${composerId}`)
  return slimComposerData(raw)
}

function enrichFromComposerData(db, workspaceMap, session) {
  const data = readComposerData(db, session.composerId)
  if (!data) return session
  const userTurns = data.headers.filter(item => item.type === 1).length
  session.hasComposerData = true
  session.name = session.name || data.name
  session.subtitle = session.subtitle || data.subtitle
  session.createdAt = session.createdAt || data.createdAt
  session.updatedAt = session.updatedAt || data.lastUpdatedAt || data.createdAt
  session.unifiedMode = session.unifiedMode || data.unifiedMode
  session.modelName = session.modelName || data.modelName
  session.userTurns = session.userTurns || userTurns
  session.headerCount = session.headerCount || data.headers.length
  session.isDraft = session.isDraft || data.isDraft
  session.isSubagent = session.isSubagent || data.isSubagent
  session.cwd = session.cwd || workspacePathFromMeta({
    workspaceIdentifier: data.workspaceIdentifier,
    workspaceId: session.workspaceId
  }, workspaceMap)
  return session
}

function fallbackScanComposerData(db, workspaceMap, byId) {
  if (byId.size >= MAX_SESSIONS) return
  if (!tableExists(db, 'cursorDiskKV')) return
  let rows = []
  try {
    rows = db.prepare(
      `SELECT ${quoteIdent('key')} AS key FROM cursorDiskKV WHERE ${quoteIdent('key')} >= 'composerData:' AND ${quoteIdent('key')} < 'composerData;' LIMIT ?`
    ).all(MAX_SESSIONS)
  } catch {
    return
  }
  for (const row of rows) {
    const composerId = String(row.key || '').slice('composerData:'.length)
    upsertSession(byId, { composerId })
    if (byId.size >= MAX_SESSIONS) break
  }
}

function shouldListSession(session) {
  if (!session?.composerId) return false
  if (session.isDraft || session.isArchived || session.isSubagent) return false
  if (session.isEphemeral && !session.hasComposerData && !session.userTurns) return false
  if (!session.userTurns && !session.headerCount) return false
  return true
}

function toListItem(session, cwdExists) {
  return {
    id: session.composerId,
    composerId: session.composerId,
    cwd: session.cwd || '',
    cwdExists: !!cwdExists,
    title: firstLine(session.name, 48) || 'Cursor 会话',
    preview: firstLine(session.subtitle, 96),
    userTurns: session.userTurns || 0,
    skippedTools: 0,
    updatedAt: session.updatedAt || session.createdAt || 0,
    createdAt: session.createdAt || 0,
    unifiedMode: session.unifiedMode || '',
    modelName: session.modelName || ''
  }
}

async function listCursorSessions(options = {}) {
  const home = getCursorUserDir(options)
  if (!(await pathExists(home))) {
    return { success: true, home, missingHome: true, sessions: [] }
  }
  const globalDbPath = path.join(home, 'globalStorage', 'state.vscdb')
  if (!(await pathExists(globalDbPath))) {
    return { success: true, home, missingHome: true, sessions: [] }
  }
  assertCursorReadablePath(globalDbPath, home)
  const workspaceMap = readWorkspaceMap(home)
  const byId = new Map()
  const db = openReadonlySqlite(globalDbPath)
  try {
    readComposerHeadersTable(db, workspaceMap, byId)
    readLegacyComposerHeaders(db, workspaceMap, byId)
    readWorkspaceComposerIndex(home, workspaceMap, byId)
    if (byId.size === 0) fallbackScanComposerData(db, workspaceMap, byId)
    for (const session of byId.values()) {
      if (!session.hasComposerData || !session.name || !session.cwd || !session.userTurns) {
        enrichFromComposerData(db, workspaceMap, session)
      }
    }
  } finally {
    try { db.close() } catch {}
  }

  const cwdCache = new Map()
  const sessions = []
  for (const session of byId.values()) {
    if (!shouldListSession(session)) continue
    let cwdExists = false
    if (session.cwd) {
      if (!cwdCache.has(session.cwd)) cwdCache.set(session.cwd, await pathExists(session.cwd))
      cwdExists = cwdCache.get(session.cwd)
    }
    sessions.push(toListItem(session, cwdExists))
    if (sessions.length >= MAX_SESSIONS) break
  }
  sessions.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
  return { success: true, home, missingHome: false, sessions }
}

function readBubbles(db, composerId, headers, conversationMap = {}) {
  const byId = new Map()
  for (const header of headers) {
    const mapped = conversationMap[header.bubbleId]
    if (mapped && typeof mapped === 'object') byId.set(header.bubbleId, mapped)
  }
  const missing = headers.filter(item => !byId.has(item.bubbleId)).map(item => item.bubbleId)
  for (let index = 0; index < missing.length; index += BUBBLE_BATCH) {
    const chunk = missing.slice(index, index + BUBBLE_BATCH)
    const keys = chunk.map(bubbleId => `bubbleId:${composerId}:${bubbleId}`)
    const placeholders = keys.map(() => '?').join(', ')
    let rows = []
    try {
      rows = db.prepare(
        `SELECT ${quoteIdent('key')} AS key, value FROM cursorDiskKV WHERE ${quoteIdent('key')} IN (${placeholders})`
      ).all(...keys)
    } catch {
      rows = []
    }
    for (const row of rows) {
      const key = String(row.key || '')
      const prefix = `bubbleId:${composerId}:`
      if (!key.startsWith(prefix)) continue
      const parsed = parseJson(row.value)
      if (parsed) byId.set(key.slice(prefix.length), parsed)
    }
  }
  return byId
}

function parseCursorSession(composerId, options = {}) {
  const home = getCursorUserDir(options)
  const id = assertComposerId(composerId)
  const globalDbPath = path.join(home, 'globalStorage', 'state.vscdb')
  assertCursorReadablePath(globalDbPath, home)
  const workspaceMap = readWorkspaceMap(home)
  const db = openReadonlySqlite(globalDbPath)
  try {
    const data = readComposerData(db, id)
    if (!data) {
      const error = new Error('未找到该 Cursor 会话')
      error.code = 'PARSE_FAILED'
      throw error
    }
    let headers = data.headers
    if (!headers.length && data.conversationMap) {
      headers = Object.entries(data.conversationMap).map(([bubbleId, item]) => ({
        bubbleId,
        type: Number(item?.type)
      }))
    }
    const bubbles = readBubbles(db, id, headers, data.conversationMap)
    const items = []
    let skippedTools = 0
    for (const header of headers) {
      const bubble = bubbles.get(header.bubbleId)
      if (isToolOnlyBubble(bubble) || (!bubble && header.type === 2 && !bubbles.has(header.bubbleId))) {
        skippedTools += 1
        continue
      }
      const role = bubbleRole(bubble?.type ?? header.type)
      let text = extractBubbleText(bubble)
      if (role === 'user') {
        if (isCursorSystemUserText(bubble, text)) {
          skippedTools += 1
          continue
        }
        text = extractVisibleUserText(text)
      }
      text = codexImport.cleanImportedText(text)
      if (!role || !text) {
        if (bubble && (bubble.toolFormerData || header.type === 2) && !text) skippedTools += 1
        continue
      }
      pushImportedMessage(
        items,
        role,
        text,
        bubble?.createdAt || data.lastUpdatedAt || data.createdAt || ''
      )
    }
    const firstUser = items.find(item => item.kind === 'message' && item.role === 'user')
    let workspaceId = String(options.workspaceId || data.workspaceIdentifier?.id || '').trim()
    if (!workspaceId && tableExists(db, 'composerHeaders')) {
      try {
        const row = db.prepare('SELECT workspaceId FROM composerHeaders WHERE composerId = ?').get(id)
        workspaceId = String(row?.workspaceId || '').trim()
      } catch {}
    }
    const cwd = workspacePathFromMeta({
      workspaceIdentifier: data.workspaceIdentifier,
      workspaceId
    }, workspaceMap)
    return {
      id,
      cwd,
      timestamp: data.lastUpdatedAt || data.createdAt || '',
      title: firstLine(data.name || firstUser?.content, 48) || 'Cursor 会话',
      preview: firstLine(data.subtitle || firstUser?.content, 96),
      userTurns: items.filter(item => item.kind === 'message' && item.role === 'user').length,
      skippedTools,
      items,
      modelName: data.modelName || 'Cursor',
      unifiedMode: data.unifiedMode || ''
    }
  } finally {
    try { db.close() } catch {}
  }
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4)
}

function buildLingxiImportPayload(parsed = {}) {
  const messages = []
  let skippedTools = Number(parsed.skippedTools || 0)
  for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
    if (item?.kind === 'tool') {
      skippedTools += 1
      continue
    }
    if (item?.kind !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue
    const visible = String(item.content || '').trim()
    if (!visible) continue
    const message = {
      role: item.role,
      content: visible,
      displayContent: visible,
      time: item.time || '',
      importedFrom: 'cursor'
    }
    if (item.role === 'assistant') message.modelName = parsed.modelName || 'Cursor'
    messages.push(message)
  }

  chatMessageIdentity.assignMessageIdentity(messages, {
    sessionId: parsed.id || 'cursor-import',
    deterministic: true
  })

  const userIndices = []
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].role === 'user') userIndices.push(index)
  }
  const userTurns = userIndices.length
  let coverUntilExclusive = 0
  if (userTurns > RETAIN_LIVE_USER_TURNS) {
    coverUntilExclusive = userIndices[userTurns - RETAIN_LIVE_USER_TURNS]
  }

  const summaries = []
  if (coverUntilExclusive > 0) {
    const slice = messages.slice(0, coverUntilExclusive)
    const endTurn = slice.filter(item => item.role === 'user').length
    summaries.push(contextCompression.buildImportedCompressionSummary({
      id: 'summary-0001',
      startTurn: 1,
      endTurn: Math.max(1, endTurn),
      startHistoryIndex: 0,
      endHistoryIndex: coverUntilExclusive,
      historySlice: slice,
      compactedText: '',
      sourceTokenEstimate: slice.reduce((sum, item) => sum + estimateTokens(item.content), 0)
    }))
  }

  const firstUser = messages.find(item => item.role === 'user')
  return {
    id: parsed.id || '',
    cwd: parsed.cwd || '',
    title: parsed.title || firstLine(firstUser?.displayContent || firstUser?.content, 48) || 'Cursor 会话',
    messages,
    summaries,
    userTurns,
    skippedTools,
    compactedCount: 0
  }
}

module.exports = {
  RETAIN_LIVE_USER_TURNS,
  getCursorUserDir,
  listCursorSessions,
  parseCursorSession,
  buildLingxiImportPayload,
  materializeImportedAttachments: codexImport.materializeImportedAttachments,
  assertCursorReadablePath,
  assertComposerId
}
