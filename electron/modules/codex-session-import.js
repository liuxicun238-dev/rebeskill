/**
 * Scan local Codex CLI session rollouts and map them to Lingxi chat history
 * plus compression summaries. Never reads auth.json, config.toml, or secrets.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const contextCompression = require('./context-compression')
const chatMessageIdentity = require('./chat-message-identity')

const RETAIN_LIVE_USER_TURNS = 8
const LIST_HEAD_BYTES = 256 * 1024
const MAX_SESSION_FILES = 400
const MAX_IMPORT_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const FORBIDDEN_BASENAMES = new Set([
  'auth.json',
  'config.toml',
  'credentials.json',
  '.env'
])
const SESSION_ROOTS = ['sessions', 'archived_sessions']

function getCodexHome(options = {}) {
  const override = String(options.codexHome || process.env.CODEX_HOME || '').trim()
  if (override) return path.resolve(override)
  return path.join(os.homedir(), '.codex')
}

function isPathInside(child, parent) {
  const resolvedChild = path.resolve(child)
  const resolvedParent = path.resolve(parent)
  const rel = path.relative(resolvedParent, resolvedChild)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function assertSessionFilePath(filePath, codexHome) {
  const resolved = path.resolve(filePath)
  const home = path.resolve(codexHome)
  const allowed = SESSION_ROOTS.some(root => isPathInside(resolved, path.join(home, root)))
  if (!allowed) {
    const error = new Error('session path is not a Codex session file')
    error.code = 'SESSION_PATH_DENIED'
    throw error
  }
  const base = path.basename(resolved).toLowerCase()
  if (FORBIDDEN_BASENAMES.has(base) || !resolved.toLowerCase().endsWith('.jsonl')) {
    const error = new Error('refusing to read a non-session Codex file')
    error.code = 'SESSION_PATH_DENIED'
    throw error
  }
  return resolved
}

async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function collectJsonlFiles(dir, acc = []) {
  if (acc.length >= MAX_SESSION_FILES) return acc
  let entries = []
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (acc.length >= MAX_SESSION_FILES) break
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectJsonlFiles(full, acc)
      continue
    }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (FORBIDDEN_BASENAMES.has(lower)) continue
    if (!lower.endsWith('.jsonl')) continue
    acc.push(full)
  }
  return acc
}

function unwrapLine(rawLine) {
  const line = String(rawLine || '').trim()
  if (!line) return null
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const type = String(obj.type || obj.item?.type || '').trim()
  const payload = obj.payload !== undefined
    ? obj.payload
    : (obj.item?.payload !== undefined ? obj.item.payload : obj)
  return {
    type,
    payload: payload && typeof payload === 'object' ? payload : {},
    timestamp: obj.timestamp || payload?.timestamp || '',
    raw: obj
  }
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, num) => {
      const code = Number(num)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function splitTableRow(line = '') {
  let value = String(line).trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  return value.split('|').map(cell => cell.trim())
}

function looksLikeSeparatorCells(cells) {
  return Array.isArray(cells)
    && cells.length >= 2
    && cells.every(cell => /^:?-{1,}:?$/.test(String(cell || '').replace(/\s+/g, '')))
}

function normalizeMarkdownTables(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  for (let index = 0; index < lines.length - 1; index++) {
    if (!lines[index].includes('|') || !lines[index + 1].includes('|')) continue
    const header = splitTableRow(lines[index])
    const separator = splitTableRow(lines[index + 1])
    if (header.length < 2 || !looksLikeSeparatorCells(separator)) continue
    const columns = Math.max(header.length, separator.length)
    while (header.length < columns) header.push('')
    while (separator.length < columns) separator.push('---')
    const fixed = separator.map((cell) => {
      const trimmed = String(cell || '').replace(/\s+/g, '')
      const left = trimmed.startsWith(':')
      const right = trimmed.endsWith(':') && trimmed.length > 1
      return `${left ? ':' : ''}---${right ? ':' : ''}`
    })
    lines[index] = `| ${header.join(' | ')} |`
    lines[index + 1] = `| ${fixed.join(' | ')} |`
  }
  return lines.join('\n')
}

const INJECTED_CONTEXT_TAG_RE = /^<(?:recommended_plugins|environment_context|user_instructions|skills_instructions|plugins_instructions|apps_instructions|environments_instructions|collaboration_mode|multi_agent_mode|app-context|tools|skill|goal_context|codex_internal_context|subagent_notification|context_window(?:_guidance)?|realtime_conversation)\b/i

function cleanImportedText(text) {
  let value = String(text || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/gi, '')
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, '')
    .replace(/^#\s*AGENTS\.md instructions[^\n]*(?:\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>)?/i, '')
    .replace(/You are performing a CONTEXT CHECKPOINT COMPACTION[\s\S]*$/i, '')
  value = decodeHtmlEntities(value)
  value = value
    .split('\n')
    .map(line => (line.includes('|') ? line.replace(/\\\|/g, '|').replace(/\\&/g, '&') : line))
    .join('\n')
  value = normalizeMarkdownTables(value)
  return value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function collectImagePaths(value, acc = []) {
  if (!value) return acc
  if (typeof value === 'string') {
    const trimmed = value.replace(/^file:\/\//i, '').trim()
    if (IMAGE_EXT_RE.test(trimmed) && /(?:^[A-Za-z]:[\\/]|\/|\\)/.test(trimmed)) acc.push(trimmed)
    return acc
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImagePaths(item, acc)
    return acc
  }
  if (typeof value === 'object') {
    collectImagePaths(value.path || value.url || value.image_url || value.filename || value.file, acc)
  }
  return acc
}

function extractContentParts(content, extraImages) {
  const texts = []
  const images = []
  collectImagePaths(extraImages, images)

  function walk(part) {
    if (part == null) return
    if (typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean') {
      texts.push(String(part))
      return
    }
    if (Array.isArray(part)) {
      part.forEach(walk)
      return
    }
    if (typeof part !== 'object') return
    const kind = String(part.type || '')
    if (kind === 'input_image' || kind === 'image_url' || kind === 'image') {
      collectImagePaths(part, images)
      return
    }
    if (kind === 'input_text' || kind === 'output_text' || kind === 'text') {
      if (part.text != null) texts.push(String(part.text))
      return
    }
    if (typeof part.text === 'string') texts.push(part.text)
    else if (typeof part.message === 'string') texts.push(part.message)
    collectImagePaths(part, images)
  }

  walk(content)
  return {
    text: texts.filter(Boolean).join('\n'),
    images: [...new Set(images)]
  }
}

function stripRequestHeading(text) {
  return String(text || '').replace(/##\s*My request(?:\s+for Codex)?:\s*/i, '')
}

function extractFileMentionEnvelope(text) {
  const images = []
  let body = String(text || '')
  const filesIdx = body.search(/#\s*Files (?:mentioned|pasted) by the user:/i)
  const requestIdx = body.search(/##\s*My request(?:\s+for Codex)?:/i)
  if (filesIdx >= 0) {
    const section = requestIdx > filesIdx ? body.slice(filesIdx, requestIdx) : body.slice(filesIdx)
    collectImagePaths(section.match(/(?:[A-Za-z]:[\\/]|\/)[^\s\n]+/g) || [], images)
    if (requestIdx >= 0) {
      body = stripRequestHeading(body.slice(requestIdx))
    } else {
      const pastedTitle = section.match(/##\s*"([^"]+)"/)
      body = pastedTitle ? pastedTitle[1].trim() : body.slice(0, filesIdx)
    }
  } else if (requestIdx >= 0) {
    body = stripRequestHeading(body.slice(requestIdx))
  }
  const lines = String(body || '').split('\n').filter((line) => {
    const match = String(line).match(/((?:[A-Za-z]:[\\/]|\/)[^\s]+)/)
    if (match && IMAGE_EXT_RE.test(match[1]) && /^\s*[-*]/.test(line)) {
      images.push(match[1])
      return false
    }
    return true
  })
  return {
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    images: [...new Set(images.filter(item => IMAGE_EXT_RE.test(item)))]
  }
}

function isSkippableUserPrompt(text) {
  const value = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!value) return true
  if (/CONTEXT CHECKPOINT COMPACTION/i.test(value)) return true
  if (/You are a coding agent running in Codex/i.test(value)) return true
  if (/^#\s*AGENTS\.md instructions\b/i.test(value)) return true
  if (/^These AGENTS\.md instructions replace/i.test(value)) return true
  if (/^The previously provided AGENTS\.md instructions\b/i.test(value)) return true
  return INJECTED_CONTEXT_TAG_RE.test(value)
}

function isToolPayload(payload = {}) {
  const kind = String(payload.type || payload.role || '')
  return (
    kind === 'function_call'
    || kind === 'function_call_output'
    || kind === 'custom_tool_call'
    || kind === 'custom_tool_call_output'
    || kind === 'tool_call'
    || kind === 'tool_result'
    || Array.isArray(payload.tool_calls)
  )
}

function sessionIdFromFile(filePath) {
  const name = path.basename(filePath, '.jsonl')
  const match = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return match ? match[0] : name
}

function firstLine(text, max = 80) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function pushMessage(state, role, rawText, time, extraImages) {
  const parts = extractContentParts(rawText, extraImages)
  let cleaned = cleanImportedText(parts.text)
  let images = parts.images || []
  if (role === 'user') {
    const envelope = extractFileMentionEnvelope(cleaned)
    cleaned = envelope.text
    images = [...new Set([...images, ...(envelope.images || [])])]
    if (isSkippableUserPrompt(cleaned)) return
  }
  if (!cleaned && !images.length) return
  state.items.push({
    kind: 'message',
    role,
    content: cleaned,
    images,
    time: time || ''
  })
}

function consumeRecord(record, state) {
  if (!record) return
  const type = record.type
  const payload = record.payload || {}

  if (type === 'session_meta') {
    state.id = String(payload.id || state.id || '')
    state.cwd = String(payload.cwd || payload.cwd_path || state.cwd || '')
    state.timestamp = record.timestamp || payload.timestamp || state.timestamp
    state.source = String(payload.source || payload.originator || state.source || '')
    state.cliVersion = String(payload.cli_version || payload.cliVersion || state.cliVersion || '')
    return
  }

  if (type === 'compacted') {
    const text = cleanImportedText(payload.message || payload.text || '')
    if (text) state.items.push({ kind: 'compacted', text, time: record.timestamp || '' })
    return
  }

  if (type === 'event_msg') {
    const eventType = String(payload.type || '')
    if (eventType === 'user_message') {
      pushMessage(state, 'user', payload.message || payload.text || '', record.timestamp, payload.images)
      return
    }
    if (eventType === 'agent_message') {
      pushMessage(state, 'assistant', payload.message || payload.text || '', record.timestamp)
    }
    return
  }

  if (type === 'response_item' || type === 'message') {
    if (isToolPayload(payload)) {
      const kind = String(payload.type || '')
      const toolOnly = (
        kind === 'function_call'
        || kind === 'function_call_output'
        || kind === 'custom_tool_call'
        || kind === 'custom_tool_call_output'
        || kind === 'tool_call'
        || kind === 'tool_result'
      )
      if (toolOnly) {
        state.skippedTools += 1
        state.items.push({ kind: 'tool' })
        return
      }
      const role = String(payload.role || '').trim()
      const parts = extractContentParts(payload.content || payload.message || payload.text)
      const text = cleanImportedText(parts.text)
      if (text && role === 'assistant') {
        pushMessage(state, 'assistant', text, record.timestamp, parts.images)
        return
      }
      state.skippedTools += 1
      state.items.push({ kind: 'tool' })
      return
    }
    const itemType = String(payload.type || type)
    if (itemType === 'reasoning') return
    const role = String(payload.role || '').trim()
    if (role === 'user' || role === 'assistant') {
      pushMessage(state, role, payload.content || payload.message || payload.text, record.timestamp)
    }
  }
}

function createParseState(filePath) {
  return {
    id: sessionIdFromFile(filePath),
    cwd: '',
    timestamp: '',
    source: '',
    cliVersion: '',
    skippedTools: 0,
    items: []
  }
}

function sameMessage(left, right) {
  return left?.kind === 'message'
    && right?.kind === 'message'
    && left.role === right.role
    && left.content === right.content
}

function dedupeMessages(items) {
  const out = []
  for (const item of items) {
    if (item?.kind !== 'message') {
      out.push(item)
      continue
    }
    const last = out[out.length - 1]
    if (sameMessage(last, item)) {
      last.images = [...new Set([...(last.images || []), ...(item.images || [])])]
      continue
    }
    out.push(item)
  }
  return out
}

function finalizeParsed(state, filePath, extras = {}) {
  state.items = dedupeMessages(state.items)
  const firstUser = state.items.find(item => item.kind === 'message' && item.role === 'user')
  const previewSource = extractFileMentionEnvelope(firstUser?.content || '').text || firstUser?.content || ''
  const userTurns = state.items.filter(item => item.kind === 'message' && item.role === 'user').length
  const namedTitle = firstLine(extras.threadName, 48)
  return {
    id: state.id,
    cwd: state.cwd,
    timestamp: state.timestamp || extras.mtimeMs || '',
    source: state.source,
    cliVersion: state.cliVersion,
    title: namedTitle || firstLine(previewSource, 48) || 'Codex 会话',
    preview: firstLine(previewSource, 96) || namedTitle,
    userTurns,
    skippedTools: state.skippedTools,
    items: state.items,
    path: filePath,
    ...extras
  }
}

async function loadThreadNames(codexHome) {
  const names = new Map()
  try {
    const text = await fs.promises.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8')
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const id = String(obj?.id || obj?.thread_id || '').trim()
      const name = String(obj?.thread_name || obj?.name || '').trim()
      if (id && name && !isSkippableUserPrompt(name)) names.set(id, name)
    }
  } catch {}
  return names
}

async function readFileHead(filePath, maxBytes = LIST_HEAD_BYTES) {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const size = Math.min(maxBytes, stat.size)
    const buffer = Buffer.alloc(size)
    if (size > 0) await handle.read(buffer, 0, size, 0)
    let text = buffer.toString('utf8')
    const lastNl = text.lastIndexOf('\n')
    if (lastNl >= 0 && stat.size > size) text = text.slice(0, lastNl)
    return { text, size: stat.size, mtimeMs: stat.mtimeMs }
  } finally {
    await handle.close()
  }
}

function parseHeadText(filePath, head, extras = {}) {
  const state = createParseState(filePath)
  const lines = String(head.text || '').split(/\r?\n/)
  for (const line of lines) consumeRecord(unwrapLine(line), state)
  return finalizeParsed(state, filePath, {
    size: head.size,
    mtimeMs: head.mtimeMs,
    partial: head.size > LIST_HEAD_BYTES,
    ...extras
  })
}

async function parseCodexSessionFile(filePath, options = {}) {
  const home = getCodexHome(options)
  const resolved = assertSessionFilePath(filePath, home)
  const state = createParseState(resolved)
  const stream = fs.createReadStream(resolved, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) consumeRecord(unwrapLine(line), state)
  } finally {
    rl.close()
    stream.destroy()
  }
  const stat = await fs.promises.stat(resolved)
  const threadNames = await loadThreadNames(home)
  const threadName = threadNames.get(state.id) || threadNames.get(sessionIdFromFile(resolved)) || ''
  return finalizeParsed(state, resolved, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    partial: false,
    threadName
  })
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4)
}

function toAttachments(paths = []) {
  return [...new Set(paths.filter(item => IMAGE_EXT_RE.test(item)))].slice(0, 12).map(filePath => ({
    kind: 'image',
    name: path.basename(filePath),
    path: filePath,
    type: 'image/*'
  }))
}

function buildLingxiImportPayload(parsed = {}) {
  const messages = []
  const compacted = []
  let skippedTools = 0

  for (const item of Array.isArray(parsed.items) ? parsed.items : []) {
    if (item?.kind === 'compacted' && item.text) compacted.push(item.text)
    if (item?.kind === 'tool') {
      skippedTools += 1
      continue
    }
    if (item?.kind !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue
    const envelope = item.role === 'user' ? extractFileMentionEnvelope(item.content) : { text: item.content, images: [] }
    const imagePaths = [...(item.images || []), ...(envelope.images || [])]
    const attachments = toAttachments(imagePaths)
    const displayContent = String(envelope.text || item.content || '').trim()
    const missingNote = attachments.length === 0 && imagePaths.length > 0
      ? `（${imagePaths.length} 张原图已不在本地）`
      : ''
    const visible = [displayContent, missingNote].filter(Boolean).join('\n')
    if (!visible && !attachments.length) continue
    const message = {
      role: item.role,
      content: visible || (attachments.length ? `[图片 ×${attachments.length}]` : ''),
      displayContent: visible,
      time: item.time || '',
      importedFrom: 'codex'
    }
    if (attachments.length) message.attachments = attachments
    if (item.role === 'assistant') message.modelName = 'Codex'
    messages.push(message)
  }

  chatMessageIdentity.assignMessageIdentity(messages, {
    sessionId: parsed.id || 'codex-import',
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
  } else if (compacted.length && userTurns > 2) {
    coverUntilExclusive = userIndices[userTurns - 2]
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
      compactedText: compacted.slice(-2).join('\n\n'),
      sourceTokenEstimate: slice.reduce((sum, item) => sum + estimateTokens(item.content), 0)
    }))
  }

  const firstUser = messages.find(item => item.role === 'user')
  return {
    id: parsed.id || '',
    cwd: parsed.cwd || '',
    title: parsed.title || firstLine(firstUser?.displayContent || firstUser?.content, 48) || 'Codex 会话',
    messages,
    summaries,
    userTurns,
    skippedTools,
    compactedCount: compacted.length
  }
}

function uniqueDestPath(destDir, fileName) {
  const safe = String(fileName || 'image.png').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(-180) || 'image.png'
  const stamp = Date.now().toString(36)
  const suffix = Math.random().toString(36).slice(2, 8)
  return path.join(destDir, `${stamp}-${suffix}-${safe}`)
}

async function materializeImportedAttachments(messages = [], destDir = '') {
  if (!destDir) return messages
  await fs.promises.mkdir(destDir, { recursive: true })
  const copied = new Map()
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(message.attachments) || message.attachments.length === 0) continue
    const next = []
    let missing = 0
    for (const attachment of message.attachments) {
      const source = String(attachment.path || '').trim()
      if (!source || !IMAGE_EXT_RE.test(source)) {
        missing += 1
        continue
      }
      if (copied.has(source)) {
        next.push({ ...attachment, ...copied.get(source) })
        continue
      }
      try {
        const stat = await fs.promises.stat(source)
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMPORT_IMAGE_BYTES) {
          missing += 1
          continue
        }
        const dest = uniqueDestPath(destDir, attachment.name || path.basename(source))
        await fs.promises.copyFile(source, dest)
        const resolved = {
          kind: 'image',
          name: attachment.name || path.basename(source),
          path: dest,
          type: attachment.type || 'image/*'
        }
        copied.set(source, resolved)
        next.push(resolved)
      } catch {
        missing += 1
      }
    }
    message.attachments = next
    if (!next.length) delete message.attachments
    if (missing > 0 && !(message.displayContent || '').includes('原图已不在本地')) {
      const note = `（${missing} 张原图已不在本地）`
      message.displayContent = [message.displayContent, note].filter(Boolean).join('\n')
      message.content = [message.content, note].filter(Boolean).join('\n')
    }
  }
  return messages
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, () => worker()))
  return out
}

function toListItem(parsed, cwdExists) {
  return {
    id: parsed.id,
    path: parsed.path,
    cwd: parsed.cwd || '',
    cwdExists: !!cwdExists,
    title: parsed.title || 'Codex 会话',
    preview: parsed.preview || '',
    userTurns: parsed.userTurns || 0,
    skippedTools: parsed.skippedTools || 0,
    updatedAt: parsed.mtimeMs || 0,
    source: parsed.source || '',
    cliVersion: parsed.cliVersion || '',
    size: parsed.size || 0
  }
}

async function listCodexSessions(options = {}) {
  const home = getCodexHome(options)
  if (!(await pathExists(home))) {
    return { success: true, home, missingHome: true, sessions: [] }
  }
  const files = []
  for (const root of SESSION_ROOTS) {
    await collectJsonlFiles(path.join(home, root), files)
  }
  files.sort((a, b) => String(b).localeCompare(String(a)))
  const threadNames = await loadThreadNames(home)
  const parsedList = await mapLimit(files.slice(0, MAX_SESSION_FILES), 8, async (filePath) => {
    try {
      const head = await readFileHead(filePath)
      const parsed = parseHeadText(filePath, head)
      const threadName = threadNames.get(parsed.id) || threadNames.get(sessionIdFromFile(filePath)) || ''
      if (threadName) {
        parsed.title = firstLine(threadName, 48)
        parsed.threadName = threadName
      }
      return parsed
    } catch (error) {
      return {
        id: sessionIdFromFile(filePath),
        path: filePath,
        cwd: '',
        title: path.basename(filePath, '.jsonl'),
        preview: '',
        userTurns: 0,
        skippedTools: 0,
        items: [],
        error: error.message
      }
    }
  })
  const cwdCache = new Map()
  const sessions = []
  for (const parsed of parsedList) {
    if (parsed.error) continue
    let cwdExists = false
    if (parsed.cwd) {
      if (!cwdCache.has(parsed.cwd)) cwdCache.set(parsed.cwd, await pathExists(parsed.cwd))
      cwdExists = cwdCache.get(parsed.cwd)
    }
    sessions.push(toListItem(parsed, cwdExists))
  }
  sessions.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
  return { success: true, home, missingHome: false, sessions }
}

module.exports = {
  RETAIN_LIVE_USER_TURNS,
  getCodexHome,
  listCodexSessions,
  parseCodexSessionFile,
  buildLingxiImportPayload,
  materializeImportedAttachments,
  cleanImportedText,
  extractFileMentionEnvelope,
  assertSessionFilePath
}
