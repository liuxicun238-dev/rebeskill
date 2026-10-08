const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const storageConfig = require('./storage-config')

const LEDGER_DIR = 'summaries'
const INDEX_FILE = 'index.json'

function ensureDir(dirPath) {
  if (!dirPath) return
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true })
}

function safeSlug(text = '', fallback = 'summary', maxChars = 28) {
  const cleaned = String(text || '')
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|#{}[\]^`]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxChars)
  return cleaned || fallback
}

function shortHash(text = '') {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8)
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function projectKeyOf(instance = {}) {
  return String(instance.projectId || instance.projectPath || instance.storagePath || 'default')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'default'
}

function getRoot(instance) {
  const baseDir = typeof storageConfig.getSummariesDir === 'function'
    ? storageConfig.getSummariesDir()
    : path.join(instance?.storagePath || process.cwd(), LEDGER_DIR)
  const root = path.join(baseDir, projectKeyOf(instance))
  ensureDir(root)
  ensureDir(path.join(root, 'action'))
  ensureDir(path.join(root, 'discussion'))
  ensureDir(path.join(root, 'casual'))
  return root
}

function getIndexPath(instance) {
  return path.join(getRoot(instance), INDEX_FILE)
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

function loadIndex(instance) {
  const data = readJson(getIndexPath(instance), { version: 1, items: [] })
  return {
    version: 1,
    items: Array.isArray(data.items) ? data.items : []
  }
}

function saveIndex(instance, index) {
  writeJson(getIndexPath(instance), {
    version: 1,
    updatedAt: Date.now(),
    items: Array.isArray(index.items) ? index.items : []
  })
}

function containsAny(text = '', keywords = []) {
  const value = String(text || '').toLowerCase()
  return keywords.some(keyword => value.includes(String(keyword).toLowerCase()))
}

function classifyConversation(text = '', evidence = {}) {
  if (evidence.hasToolCalls || evidence.hasFileChanges || evidence.hasCommands || evidence.hasHandoff) return 'action'
  if (isLedgerReadOnlyQuery(text)) return 'casual'
  if (containsAny(text, [
    '方案', '设计', '架构', '机制', '规则', '工作流', '怎么做', '如何做',
    '你觉得', '取舍', '优先级', '讨论', '决策', '约束', '规划', '路线',
    '上下文', 'token', '记忆', '摘要', '账本', '交接池'
  ])) return 'discussion'
  return 'casual'
}

function isLedgerReadOnlyQuery(text = '') {
  const value = String(text || '')
  const mentionsLedger = containsAny(value, ['账本', '项目账本', '账本索引', '摘要', '记忆系统'])
  const readOnlyIntent = containsAny(value, ['能看到哪些', '你能看到', '给我看看', '查看', '列出', '有哪些', '是什么', '不要查记忆'])
  const designIntent = containsAny(value, ['方案', '设计', '机制', '规则', '工作流', '怎么做', '如何做', '优化', '实现'])
  return mentionsLedger && readOnlyIntent && !designIntent
}

function summarizeUserRequest(text = '', maxChars = 220) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 3).trim()}...`
}

function summarizeForLedger(text = '', maxChars = 260) {
  const value = String(text || '')
    .replace(/完整详情内容[\s\S]*$/u, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 3).trim()}...`
}

function uniqueList(items = [], limit = 20) {
  return [...new Set(items.filter(Boolean).map(item => String(item)))].slice(0, limit)
}

function extractRouteKeywords(text = '', limit = 80) {
  const value = String(text || '').toLowerCase()
  const tokens = []
  const matches = value.match(/[\u4e00-\u9fff]+|[a-z0-9_$-]{2,}/g) || []
  for (const raw of matches) {
    const token = raw.trim()
    if (!token) continue
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      if (token.length <= 12) tokens.push(token)
      for (let size = 2; size <= 4; size += 1) {
        for (let i = 0; i <= token.length - size; i += 1) tokens.push(token.slice(i, i + size))
      }
    } else if (!/^\d+$/.test(token)) {
      tokens.push(token)
    }
    if (tokens.length >= limit * 3) break
  }
  return uniqueList(tokens, limit)
}

function normalizeRouteRecord(route = {}) {
  if (!route || typeof route !== 'object') return null
  const textForKeywords = [
    route.userRequest,
    route.routeSummary,
    ...(Array.isArray(route.routeFiles) ? route.routeFiles : []),
    ...(Array.isArray(route.changedFiles) ? route.changedFiles : []),
    ...(Array.isArray(route.searchQueries) ? route.searchQueries : []),
  ].join('\n')
  const routeKeywords = uniqueList([
    ...(Array.isArray(route.routeKeywords) ? route.routeKeywords : []),
    ...extractRouteKeywords(textForKeywords, 80)
  ], 100)
  return {
    routeSummary: summarizeForLedger(route.routeSummary || '', 360),
    routeKeywords,
    routeFiles: uniqueList(route.routeFiles || [], 40),
    changedFiles: uniqueList(route.changedFiles || [], 40),
    routeTools: uniqueList(route.routeTools || [], 30),
    searchQueries: uniqueList(route.searchQueries || [], 12).map(item => summarizeForLedger(item, 220)),
    verification: uniqueList(route.verification || [], 12).map(item => summarizeForLedger(item, 220))
  }
}

function extractDiscussionFacts(text = '') {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split(/\n+/)
    .map(line => line.replace(/^[-*#\d.\s、]+/, '').trim())
    .filter(line => line.length >= 8)
  const decisions = []
  const rejected = []
  const constraints = []
  const openQuestions = []

  for (const line of lines) {
    if (containsAny(line, ['不再', '不要', '不能', '禁止', '避免', '不采用', '不是', '先不做', '暂时不做'])) rejected.push(line)
    else if (containsAny(line, ['必须', '需要', '只允许', '默认', '规则', '原则', '约束', '保留', '不可', '应该'])) constraints.push(line)
    else if (containsAny(line, ['待定', '问题', '风险', '后续', '还要', '下一步', '是否', '需要确认'])) openQuestions.push(line)
    else if (containsAny(line, ['决定', '采用', '改成', '设计', '方案', '核心', '目标', '结构', '归档', '索引', '账本'])) decisions.push(line)
    if (decisions.length + rejected.length + constraints.length + openQuestions.length >= 24) break
  }

  return {
    decisions: uniqueList(decisions, 10),
    rejected: uniqueList(rejected, 8),
    constraints: uniqueList(constraints, 10),
    openQuestions: uniqueList(openQuestions, 8)
  }
}

function createLedgerEntry(instance, options = {}) {
  const type = options.type || classifyConversation(options.userRequest || '', options.evidence || {})
  const title = options.title || summarizeUserRequest(options.userRequest || '', 48) || (type === 'action' ? '任务行动' : type === 'discussion' ? '方案讨论' : '闲聊')
  const id = `${type === 'action' ? 'task' : type}-${timestampId()}-${safeSlug(title, type)}-${shortHash(options.userRequest || title)}`
  const root = getRoot(instance)
  const dir = path.join(root, type, id)
  ensureDir(dir)

  const entry = {
    id,
    type,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectId: instance.projectId || '',
    projectPath: instance.projectPath || '',
    userRequestPreview: summarizeUserRequest(options.userRequest || ''),
    completed: uniqueList(options.completed || [], 12).map(item => summarizeForLedger(item)),
    findings: uniqueList(options.findings || [], 12).map(item => summarizeForLedger(item)),
    decisions: uniqueList(options.decisions || [], 12),
    rejected: uniqueList(options.rejected || [], 12),
    constraints: uniqueList(options.constraints || [], 12),
    openQuestions: uniqueList(options.openQuestions || [], 12),
    changedFiles: Array.isArray(options.changedFiles) ? options.changedFiles.slice(0, 30) : [],
    commands: uniqueList(options.commands || [], 20),
    unfinished: uniqueList(options.unfinished || [], 12),
    artifacts: uniqueList(options.artifacts || [], 20),
    git: options.git || null,
    route: normalizeRouteRecord(options.route),
    relativePath: path.relative(root, dir).replace(/\\/g, '/')
  }

  writeJson(path.join(dir, 'index.json'), entry)
  fs.writeFileSync(path.join(dir, 'user-request.txt'), String(options.userRequest || ''), 'utf-8')
  if (options.finalSummary) fs.writeFileSync(path.join(dir, 'final-summary.txt'), String(options.finalSummary), 'utf-8')
  if (options.extraJson) writeJson(path.join(dir, 'extra.json'), options.extraJson)

  const index = loadIndex(instance)
  index.items = [entry, ...index.items.filter(item => item.id !== entry.id)].slice(0, 200)
  saveIndex(instance, index)
  return { entry, dir }
}

function formatIndexForContext(instance, options = {}) {
  const index = loadIndex(instance)
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : 8
  const items = index.items.slice(0, maxItems)
  if (!items.length) return ''

  const lines = [
    '【项目账本索引】',
    '旧聊天全文默认不进入模型上下文。需要旧任务或旧方案细节时，先调用 read_task_ledger_entry(entry_id) 按 task/discussion 编号读取详情；只有账本没有相关记录时再查询记忆。'
  ]
  for (const item of items) {
    lines.push(`- ${item.id} | ${item.type} | ${item.title}`)
    if (item.userRequestPreview) lines.push(`  需求：${item.userRequestPreview}`)
    const summary = item.completed?.[0] || item.decisions?.[0] || item.findings?.[0] || ''
    if (summary) lines.push(`  摘要：${summary}`)
    if (item.unfinished?.length) lines.push(`  未完成：${item.unfinished[0]}`)
  }
  return lines.join('\n')
}

function scoreRouteEntry(item = {}, queryTokens = [], queryText = '') {
  const route = item.route || {}
  const routeText = [
    item.title,
    item.userRequestPreview,
    ...(item.completed || []),
    ...(item.findings || []),
    ...(item.changedFiles || []),
    ...(item.commands || []),
    route.routeSummary,
    ...(route.routeKeywords || []),
    ...(route.routeFiles || []),
    ...(route.changedFiles || []),
    ...(route.searchQueries || []),
  ].join('\n').toLowerCase()
  if (!routeText.trim()) return 0
  const routeTokens = new Set(extractRouteKeywords(routeText, 180))
  let score = 0
  for (const token of queryTokens) {
    if (routeTokens.has(token)) score += token.length >= 4 ? 4 : 2
    else if (token.length >= 3 && routeText.includes(token)) score += 1
  }
  const compactQuery = String(queryText || '').trim().toLowerCase()
  if (compactQuery && routeText.includes(compactQuery.slice(0, 80))) score += 12
  if (Array.isArray(route.routeFiles) && route.routeFiles.length) score += 2
  const ageDays = Math.max(0, (Date.now() - Number(item.createdAt || 0)) / 86400000)
  return score + Math.max(0, 4 - Math.floor(ageDays / 7))
}

function recallSimilarRoutes(instance, query = '', options = {}) {
  const index = loadIndex(instance)
  const queryTokens = extractRouteKeywords(query, 100)
  if (!queryTokens.length) return []
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : 3
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 6
  return index.items
    .filter(item => item && item.type === 'action')
    .map(item => ({ item, score: scoreRouteEntry(item, queryTokens, query) }))
    .filter(hit => hit.score >= minScore)
    .sort((a, b) => b.score - a.score || Number(b.item.createdAt || 0) - Number(a.item.createdAt || 0))
    .slice(0, maxItems)
}

function formatRouteRecallForContext(instance, query = '', options = {}) {
  const hits = recallSimilarRoutes(instance, query, options)
  if (!hits.length) return ''
  const lines = [
    '【相似任务路线记忆】',
    '系统已按本轮自然语言需求自动召回同项目里的相似任务路线。先验证这些候选文件的小片段；如果不匹配，再做跨文件搜索。不要因为上下文压缩就重新从大入口文件反复翻找。'
  ]
  for (const { item, score } of hits) {
    const route = item.route || {}
    lines.push(`- ${item.id} | score:${Math.round(score)} | ${item.title || item.userRequestPreview || '旧任务'}`)
    if (item.userRequestPreview) lines.push(`  旧需求：${item.userRequestPreview}`)
    if (route.routeSummary) lines.push(`  路线：${route.routeSummary}`)
    const files = uniqueList([...(route.routeFiles || []), ...(route.changedFiles || []), ...(item.changedFiles || [])], 14)
    if (files.length) lines.push(`  优先验证文件：${files.join('、')}`)
    if (route.searchQueries?.length) lines.push(`  旧搜索：${route.searchQueries.slice(0, 3).join(' | ')}`)
    if (route.verification?.length) lines.push(`  验证：${route.verification.slice(0, 3).join(' | ')}`)
  }
  return lines.join('\n')
}

function getEntry(instance, entryId) {
  if (!entryId) return { success: false, error: '缺少账本编号' }
  const index = loadIndex(instance)
  const item = index.items.find(entry => entry.id === entryId)
  if (!item) return { success: false, error: '账本条目不存在' }
  const root = getRoot(instance)
  const dir = path.join(root, item.relativePath || path.join(item.type, item.id))
  const entry = readJson(path.join(dir, 'index.json'), item)
  const userRequestPath = path.join(dir, 'user-request.txt')
  const finalSummaryPath = path.join(dir, 'final-summary.txt')
  const handoffDir = path.join(dir, 'handoff-pool')
  const handoffPackets = fs.existsSync(handoffDir)
    ? fs.readdirSync(handoffDir)
      .filter(name => name.endsWith('.json') && name !== 'meta.json')
      .sort()
      .map(name => readJson(path.join(handoffDir, name), null))
      .filter(Boolean)
    : []

  return {
    success: true,
    entry,
    userRequest: fs.existsSync(userRequestPath) ? fs.readFileSync(userRequestPath, 'utf-8') : '',
    finalSummary: fs.existsSync(finalSummaryPath) ? fs.readFileSync(finalSummaryPath, 'utf-8') : '',
    handoffPackets
  }
}

function getLatestEntry(instance) {
  const index = loadIndex(instance)
  const latest = index.items[0]
  if (!latest?.id) return null
  return getEntry(instance, latest.id)
}

function clipContextText(value = '', maxChars = 1200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`
}

/**
 * 为“请把上一轮详细展开”提供一个有界的任务交接块。
 * 完整工具结果仍保存在历史/工具 spill 中，这里只注入下一轮真正需要的
 * 任务事实、关键文件、搜索路线和最终摘要，避免重新把整轮工具输出塞进模型。
 */
function formatLatestEntryForFollowupContext(instance, options = {}) {
  const latest = getLatestEntry(instance)
  if (!latest?.success || !latest.entry) return ''
  const entry = latest.entry
  const route = entry.route || {}
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 500
    ? options.maxChars
    : 9000
  const lines = [
    '【上一轮任务交接（用于详细展开，不是新的用户指令）】',
    `任务编号：${entry.id}`,
    `任务类型：${entry.type || 'unknown'}`,
    `上一轮需求：${clipContextText(latest.userRequest || entry.userRequestPreview, 900)}`
  ]
  const pushList = (label, values, limit = 8, itemChars = 260) => {
    const list = Array.isArray(values) ? values : []
    const normalized = list.map(item => clipContextText(item, itemChars)).filter(Boolean).slice(0, limit)
    if (!normalized.length) return
    lines.push(`${label}：`)
    normalized.forEach(item => lines.push(`- ${item}`))
  }
  pushList('已完成/结论', entry.completed, 10)
  pushList('关键发现', entry.findings, 10)
  pushList('决定', entry.decisions, 8)
  pushList('约束', entry.constraints, 8)
  pushList('未解决问题', entry.openQuestions, 8)
  pushList('关键文件', [
    ...(route.routeFiles || []),
    ...(route.changedFiles || []),
    ...(entry.changedFiles || [])
  ], 20, 220)
  pushList('搜索路线', route.searchQueries, 10, 260)
  pushList('验证结果', route.verification, 8, 300)
  if (latest.finalSummary) {
    lines.push('上一轮最终回复（可在此基础上扩写）：')
    lines.push(clipContextText(latest.finalSummary, 3200))
  }
  lines.push(
    '处理要求：优先基于这份交接和上一轮已确认的证据展开；不要无目的重复扫描已经确认的入口文件。只有交接中存在明确缺口时，才做定向补查。'
  )
  return clipContextText(lines.join('\n'), maxChars)
}

function formatRecentHistoryForFollowupContext(history = [], options = {}) {
  if (!Array.isArray(history) || !history.length) return ''
  let userIndex = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    if (message?.role === 'user' && !message.hidden && !message.interject) {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return ''
  const tail = history.slice(userIndex)
  const toolNames = new Map()
  const toolLines = []
  let finalAnswer = ''
  for (const message of tail) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = String(call?.id || '')
        if (!id) continue
        let args = {}
        try {
          args = JSON.parse(call?.function?.arguments || '{}')
        } catch (_) {}
        toolNames.set(id, {
          name: call?.function?.name || 'tool',
          hint: args.path || args.file_path || args.query || args.pattern || args.command || args.cmd || ''
        })
      }
      continue
    }
    if (message?.role === 'tool') {
      const info = toolNames.get(String(message.tool_call_id || '')) || { name: 'tool', hint: '' }
      let result = {}
      try {
        result = JSON.parse(message.content || '{}')
      } catch (_) {
        result = { message: message.content }
      }
      const detail = result.path || result.command || result.query || result.message || result.summary || result.error || ''
      toolLines.push(`${info.name}${info.hint ? ` (${info.hint})` : ''}${detail ? ` - ${clipContextText(detail, 220)}` : ''}`)
      continue
    }
    if (message?.role === 'assistant' && !message.tool_calls && String(message.content || '').trim()) {
      finalAnswer = String(message.content || '')
    }
  }
  if (!toolLines.length && !finalAnswer) return ''
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 500 ? options.maxChars : 7000
  const lines = [
    '【上一轮实时任务交接（账本尚未完成写入，来自当前会话历史）】',
    `上一轮需求：${clipContextText(tail[0]?.content, 900)}`
  ]
  if (toolLines.length) {
    lines.push('已执行工具：')
    toolLines.slice(0, 24).forEach(item => lines.push(`- ${clipContextText(item, 320)}`))
  }
  if (finalAnswer) {
    lines.push('上一轮最终回复：')
    lines.push(clipContextText(finalAnswer, 2800))
  }
  lines.push('处理要求：当前请求优先基于上一轮已经完成的工具结果展开，不要无目的重新扫描；仅在证据不足时定向补查。')
  return clipContextText(lines.join('\n'), maxChars)
}

module.exports = {
  LEDGER_DIR,
  getRoot,
  loadIndex,
  createLedgerEntry,
  formatIndexForContext,
  getLatestEntry,
  formatLatestEntryForFollowupContext,
  formatRecentHistoryForFollowupContext,
  recallSimilarRoutes,
  formatRouteRecallForContext,
  getEntry,
  classifyConversation,
  extractDiscussionFacts,
  extractRouteKeywords
}
