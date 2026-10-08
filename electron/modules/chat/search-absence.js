/**
 * 搜索 0 命中不能当「没有接线」。窄目录空结果时补上级搜索，
 * 审查「孤岛 / 没接入」时在组装口提醒去装配层核对。
 */

const path = require('path')

const SKIP_LITERALS = new Set([
  'require', 'import', 'from', 'module', 'exports', 'chat', 'src', 'lib',
  'modules', 'electron', 'frontend', 'scripts', 'node', 'js', 'ts', 'tsx',
  'mjs', 'cjs', 'index', 'utils', 'helper', 'common', 'dist', 'build'
])

const BROAD_RELATIVE_DIRS = new Set([
  '', '.', 'electron', 'electron/modules', 'frontend', 'frontend/scripts', 'src'
])

const ASSEMBLY_FILE_RE = /(?:^|\/)(?:ai-chat|ipc|main|preload|tools|index)\.(?:js|mjs|cjs|ts)$/i

const SEARCH_TOOL_NAMES = new Set(['code_inspect', 'grep', 'grep_code', 'file_search', 'search_project'])
const READ_TOOL_NAMES = new Set(['file_read', 'read_file'])

const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'search-absence' })

const WIRING_INTENT_RE = /孤岛|没(?:有)?接入|未接入|没有引用|0\s*命中|零命中|死代码|接进(?:主循环|ai-chat)|接线|没用上|没有用上|没有跑进|生产路径|有没有(?:接上|接入|引用)|接上了没|not\s+wired|dead\s+code|unused\s+module|no\s+references/i

function normalizeFsPath(value = '') {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function samePath(left, right) {
  const a = normalizeFsPath(path.resolve(String(left || '')))
  const b = normalizeFsPath(path.resolve(String(right || '')))
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

function toProjectRelative(targetPath = '', projectPath = '') {
  const root = String(projectPath || '').trim()
  const target = String(targetPath || '').trim()
  if (!root || !target) return normalizeFsPath(target)
  try {
    const relative = path.relative(root, target)
    if (!relative || relative === '.') return ''
    if (relative.startsWith('..') || path.isAbsolute(relative)) return normalizeFsPath(target)
    return normalizeFsPath(relative)
  } catch {
    return normalizeFsPath(target)
  }
}

function isNestedSearchPath(searchPath = '', projectPath = '') {
  const relative = toProjectRelative(searchPath, projectPath).toLowerCase()
  if (!projectPath || !searchPath) return false
  if (samePath(searchPath, projectPath)) return false
  return !BROAD_RELATIVE_DIRS.has(relative)
}

function parentSearchPath(searchPath = '', projectPath = '') {
  const raw = String(searchPath || '').trim()
  const root = path.resolve(String(projectPath || ''))
  // 相对路径应基于项目根解析，而不是进程 cwd
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw)
  const parent = path.dirname(resolved)
  if (!projectPath) return parent
  const rel = path.relative(root, parent)
  if (rel.startsWith('..') && rel !== '') return root
  if (samePath(parent, resolved)) return root
  return parent
}

function pushLiteral(list, value) {
  const next = String(value || '').trim().replace(/^['"./]+|['"]+$/g, '')
  if (next.length < 3 || next.length > 80) return
  const key = next.toLowerCase()
  if (SKIP_LITERALS.has(key)) return
  if (list.some(item => item.toLowerCase() === key)) return
  list.push(next)
}

function deriveWidenedSearchLiterals(pattern = '', extraPatterns = []) {
  const literals = []
  const sources = [pattern, ...(Array.isArray(extraPatterns) ? extraPatterns : [])]
  for (const raw of sources) {
    const text = String(raw || '').trim()
    if (!text) continue
    const requireMatch = text.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/i)
    const importMatch = text.match(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/i)
    const spec = (requireMatch || importMatch)?.[1]
    if (spec) {
      const normalized = spec.replace(/\\/g, '/').replace(/^\.\//, '')
      const base = normalized.split('/').pop() || ''
      pushLiteral(literals, base)
      pushLiteral(literals, base.replace(/\.(?:js|mjs|cjs|ts|tsx)$/i, ''))
      pushLiteral(literals, normalized)
    }
    const globBase = text.replace(/^\*\*\//, '').split('/').pop() || ''
    if (globBase && globBase !== text) {
      pushLiteral(literals, globBase.replace(/\*/g, ''))
      pushLiteral(literals, globBase.replace(/\.(?:js|mjs|cjs|ts|tsx)$/i, '').replace(/\*/g, ''))
    }
    if (/^[A-Za-z_][\w.-]{2,}$/.test(text)) pushLiteral(literals, text)
    const idents = text.match(/[A-Za-z_][\w.-]{2,}/g) || []
    for (const ident of idents) pushLiteral(literals, ident)
  }
  return literals.slice(0, 4)
}

function buildScopeWarning() {
  return '搜索目录是模块自己的文件夹时，引用通常在上一级。0 命中不能当成没有接线。'
}

function looksLikeWiringReviewIntent(text = '') {
  return WIRING_INTENT_RE.test(String(text || ''))
}

function getCallName(call = {}) {
  return String(call?.name || call?.function?.name || '').trim()
}

function isSuccessfulCall(call = {}) {
  const result = call?.result
  if (!result || typeof result !== 'object') return true
  if (result.success === false || result.error || result.aborted) return false
  return true
}

function collectCallPaths(call = {}) {
  const paths = []
  const push = (value) => {
    const target = normalizeFsPath(value)
    if (target) paths.push(target)
  }
  const args = call?.args || {}
  const result = call?.result || {}
  push(args.path || args.file_path || args.filePath)
  push(result.path || result.resolved_path)
  for (const list of [result.files, result.matches, result.follow_up_matches, result.hits]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item === 'string') push(item)
      else push(item?.path || item?.file)
    }
  }
  return [...new Set(paths)]
}

function isZeroHitSearchResult(result = {}, args = {}) {
  if (!result || result.success === false) return false
  const action = String(args.action || result._tool_route?.action || '').toLowerCase()
  if (action === 'directory' || action === 'list') return false
  if (Array.isArray(result.matches)) return result.matches.length === 0 && Number(result.follow_up_total || 0) === 0
  if (Array.isArray(result.files)) return result.files.length === 0 && !(Array.isArray(result.follow_up_files) && result.follow_up_files.length)
  return Number(result.totalMatches || result.count || 0) === 0 && Number(result.follow_up_total || 0) === 0
}

function collectSearchAbsenceEvidence(toolCalls = [], projectPath = '') {
  const nestedZeroHits = []
  let followUpHits = 0
  let assemblyReads = 0
  let broadSearches = 0
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!isSuccessfulCall(call)) continue
    const name = getCallName(call)
    const args = call.args || {}
    const result = call.result || {}
    const searchPath = result.path || args.path || ''
    if (READ_TOOL_NAMES.has(name)) {
      if (collectCallPaths(call).some(item => ASSEMBLY_FILE_RE.test(normalizeFsPath(item)))) assemblyReads += 1
      continue
    }
    if (!SEARCH_TOOL_NAMES.has(name)) continue
    if (!isNestedSearchPath(searchPath, projectPath)) broadSearches += 1
    followUpHits += Number(result.follow_up_total || result.follow_up_matches?.length || result.follow_up_files?.length || 0)
    if (isZeroHitSearchResult(result, args) && isNestedSearchPath(searchPath, projectPath)) {
      nestedZeroHits.push({ name, path: searchPath, pattern: args.pattern || result.pattern || '' })
    }
  }
  return {
    nestedZeroHits,
    followUpHits,
    assemblyReads,
    broadSearches,
    hasCallerEvidence: followUpHits > 0 || assemblyReads > 0 || broadSearches > 0
  }
}

function needsWiringCallerEvidence(userMessage = '', toolCalls = [], projectPath = '') {
  if (!looksLikeWiringReviewIntent(userMessage)) return false
  const evidence = collectSearchAbsenceEvidence(toolCalls, projectPath)
  if (!evidence.nestedZeroHits.length && evidence.followUpHits === 0) return false
  if (evidence.assemblyReads > 0 || evidence.broadSearches > 0) return false
  return true
}

function buildWiringNudge(userMessage = '', toolCalls = [], projectPath = '') {
  if (!needsWiringCallerEvidence(userMessage, toolCalls, projectPath)) return ''
  const evidence = collectSearchAbsenceEvidence(toolCalls, projectPath)
  if (evidence.followUpHits > 0) {
    return [
      '内部提醒：模块目录里的 0 命中不是全仓库没有引用。',
      '工具结果里已有上级补搜命中（follow_up_matches / follow_up_files）。先读这些文件再判断有没有接入，不要把最初的空搜索说成孤岛。'
    ].join('')
  }
  return [
    '内部提醒：正在判断模块有没有接入。在模块自己的目录里搜 require() 得到 0 命中，不能当成没接线。',
    '下一步：用模块文件名在上一级或项目根做 code_inspect grep，并打开 ai-chat.js / ipc.js / main.js 的 require 列表核对。'
  ].join('')
}

function buildWiringFinalNudge(userMessage = '', toolCalls = [], projectPath = '') {
  if (!needsWiringCallerEvidence(userMessage, toolCalls, projectPath)) return ''
  const evidence = collectSearchAbsenceEvidence(toolCalls, projectPath)
  if (evidence.followUpHits > 0) {
    return '最终回复前先判断：不要把模块目录的 0 命中说成没有接入。上级补搜已经给出引用，先读那些命中再下结论。'
  }
  return '最终回复前先判断：模块目录 0 命中不能当没接线。用文件名在上一级 grep，或打开 ai-chat.js / ipc.js / main.js 核对；已经根据上级引用能下结论也可以收尾。'
}

async function attachGrepZeroHitEnrichment(result, options = {}) {
  if (!result || result.success === false) return result
  const matchCount = Array.isArray(result.matches) ? result.matches.length : Number(result.totalMatches || 0)
  if (matchCount > 0) return result
  const projectPath = options.projectPath || ''
  const searchPath = result.path || options.searchPath || ''
  if (!isNestedSearchPath(searchPath, projectPath)) return result

  const warning = buildScopeWarning()
  result.scope_warning = warning
  const literals = deriveWidenedSearchLiterals(result.pattern, result.patterns)
  if (!literals.length || typeof options.searchContent !== 'function') {
    result.hint = result.hint || warning
    return result
  }

  const parentPath = parentSearchPath(searchPath, projectPath)
  if (!parentPath || samePath(parentPath, searchPath)) {
    result.hint = result.hint || warning
    return result
  }

  try {
    const follow = await options.searchContent({
      searchPath: parentPath,
      patterns: literals,
      maxResults: 15
    })
    const matches = Array.isArray(follow?.matches) ? follow.matches.slice(0, 15) : []
    result.follow_up_path = parentPath
    result.follow_up_patterns = literals
    result.follow_up_matches = matches
    result.follow_up_total = matches.length
    result.hint = matches.length
      ? `${warning} 已在上级目录用 ${literals.join('、')} 补搜，发现 ${matches.length} 处引用。请先读 follow_up_matches，不要把最初的 0 命中说成没有接入。`
      : `${warning} 已在上级目录补搜仍无命中。若要下「没有接线」的结论，还需打开 ai-chat.js / ipc.js / main.js 核对 require。`
  } catch (error) {
    result.hint = `${warning} 上级补搜失败：${error.message}`
  }
  return result
}

async function attachGlobZeroHitEnrichment(result, options = {}) {
  if (!result || result.success === false) return result
  const fileCount = Array.isArray(result.files) ? result.files.length : Number(result.count || 0)
  if (fileCount > 0) return result
  const projectPath = options.projectPath || ''
  const searchPath = result.path || options.searchPath || ''
  const pattern = String(result.pattern || options.pattern || '').trim()
  if (!pattern || pattern === '*' || pattern === '**/*') return result
  if (!isNestedSearchPath(searchPath, projectPath)) return result

  const warning = buildScopeWarning()
  result.scope_warning = warning
  if (typeof options.searchFiles !== 'function') {
    result.hint = result.hint || warning
    return result
  }
  const parentPath = parentSearchPath(searchPath, projectPath)
  if (!parentPath || samePath(parentPath, searchPath)) {
    result.hint = result.hint || warning
    return result
  }
  const literals = deriveWidenedSearchLiterals(pattern)
  const followPattern = literals[0] && !literals[0].includes('*')
    ? `*${literals[0]}*`
    : pattern
  try {
    const follow = await options.searchFiles({
      searchPath: parentPath,
      pattern: followPattern,
      limit: 20
    })
    const files = Array.isArray(follow?.files) ? follow.files.slice(0, 20) : []
    result.follow_up_path = parentPath
    result.follow_up_pattern = followPattern
    result.follow_up_files = files
    result.follow_up_total = files.length
    result.hint = files.length
      ? `${warning} 已在上级目录补搜，发现 ${files.length} 个路径。请先看 follow_up_files，不要把最初的空 glob 说成文件不存在。`
      : `${warning} 已在上级目录补搜仍无路径命中。`
  } catch (error) {
    result.hint = `${warning} 上级补搜失败：${error.message}`
  }
  return result
}

module.exports = {
  PLUGIN_SOURCE,
  deriveWidenedSearchLiterals,
  isNestedSearchPath,
  parentSearchPath,
  looksLikeWiringReviewIntent,
  collectSearchAbsenceEvidence,
  needsWiringCallerEvidence,
  buildWiringNudge,
  buildWiringFinalNudge,
  attachGrepZeroHitEnrichment,
  attachGlobZeroHitEnrichment
}
