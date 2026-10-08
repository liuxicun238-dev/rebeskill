/**
 * 查看/了解项目时的取证门槛：README/Markdown 不能代替实现。
 */

const READ_TOOLS = new Set(['file_read', 'read_file'])
const SEARCH_TOOLS = new Set(['file_search', 'code_inspect', 'grep', 'grep_code', 'search_project'])
const DOC_NAME_RE = /(?:^|[\\/])(?:readme|changelog|changes|license|copying|contributing|authors|notice|history|security|code_of_conduct)(?:\.[^\\/]+)?$/i
const DOC_EXT_RE = /\.(md|mdx|txt|rst|adoc)$/i
const IMPL_EXT_RE = /\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|go|rs|java|kt|cs|php|rb|swift|html|htm|css|scss|less)$/i
const CONFIG_ONLY_RE = /(?:^|[\\/])(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|jsconfig\.json|composer\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod)$/i

function stripInspectPromptNoise(text = '') {
  return String(text || '')
    .replace(/【本轮动态执行上下文】[\s\S]*$/g, '')
    .replace(/当前项目路径：\s*[^\n\r]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksLikeProjectInspectIntent(text = '') {
  const value = stripInspectPromptNoise(text)
  if (!value) return false
  const wantsChange = /(?:改|修|实现|优化|升级|重写|删除|新建|创建|补上|写成|做成|做一下|做一个|做个)/.test(value)
    && !/(?:先看|先了解|先别改|不要改|不用改|只看|只是看|深入查看|深入了解)/.test(value)
  if (wantsChange) return false
  return /有什么内容|是什么内容|有哪些(?:文件|内容)|是什么项目|项目里有|看看项目|看一下项目|了解(?:一下)?项目|项目结构|做什么的|介绍一下(?:这个|当前)?项目|当前项目(?:是|有)|深入(?:查看|了解|看一下|看看)|摸底|(?:查看|看看)(?:一下)?(?:这个|当前)?项目/.test(value)
    || /^(?:先)?(?:看|读|了解|介绍|说说|讲讲)(?:一下|看)?(?:这个|当前)?项目/.test(value)
}

function looksLikeDeepProjectInspectIntent(text = '') {
  if (!looksLikeProjectInspectIntent(text)) return false
  return /深入|详细|全面|摸底|仔细|好好看|完整了解|审查项目|项目审查|源码|实现/.test(stripInspectPromptNoise(text))
}

function normalizeInspectPath(value = '') {
  return String(value || '').replace(/\\/g, '/').trim()
}

function isDocLikePath(filePath = '') {
  const target = normalizeInspectPath(filePath)
  if (!target) return false
  const base = target.split('/').pop() || target
  return DOC_NAME_RE.test(target) || DOC_EXT_RE.test(base)
}

function isConfigOnlyPath(filePath = '') {
  return CONFIG_ONLY_RE.test(normalizeInspectPath(filePath))
}

function isImplementationPath(filePath = '') {
  const target = normalizeInspectPath(filePath)
  if (!target) return false
  if (isDocLikePath(target) || isConfigOnlyPath(target)) return false
  const base = target.split('/').pop() || target
  return IMPL_EXT_RE.test(base)
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

function parseCallArgs(call = {}) {
  let args = call?.args
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { args = {} }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
  const raw = call?.function?.arguments
  if (raw && !args.path && !args.file_path && !args.filePath) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = { ...parsed, ...args }
    } catch { /* ignore malformed tool arguments */ }
  }
  return args
}

function collectCallPaths(call = {}) {
  const paths = []
  const args = parseCallArgs(call)
  const result = call?.result || {}
  const push = value => {
    const target = normalizeInspectPath(value)
    if (target) paths.push(target)
  }
  push(args.path || args.file_path || args.filePath || args.target)
  push(result.path || result.resolved_path || result.file_path)
  const lists = [result.files, result.matches, result.hits, result.results]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item === 'string') push(item)
      else push(item?.path || item?.file || item?.name)
    }
  }
  return [...new Set(paths)]
}

function collectInspectEvidence(toolCalls = []) {
  const reads = []
  const listed = []
  const searched = []
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!isSuccessfulCall(call)) continue
    const name = getCallName(call)
    const paths = collectCallPaths(call)
    if (READ_TOOLS.has(name)) reads.push(...paths)
    else if (SEARCH_TOOLS.has(name)) {
      const action = String(call?.args?.action || call?.result?._tool_route?.action || '').toLowerCase()
      if (action === 'directory' || action === 'glob' || action === 'list') listed.push(...paths)
      else searched.push(...paths)
    }
  }
  const uniqueReads = [...new Set(reads)]
  const implReads = uniqueReads.filter(isImplementationPath)
  const docReads = uniqueReads.filter(isDocLikePath)
  return {
    readCount: uniqueReads.length,
    implReadCount: implReads.length,
    docReadCount: docReads.length,
    implReads,
    docReads,
    listedCount: listed.length,
    searchedCount: searched.length,
    hasImplementationEvidence: implReads.length > 0,
    docsOnly: uniqueReads.length > 0 && implReads.length === 0
  }
}

function needsInspectSourceEvidence(userMessage = '', toolCalls = []) {
  if (!looksLikeProjectInspectIntent(userMessage)) return false
  const evidence = collectInspectEvidence(toolCalls)
  const needed = looksLikeDeepProjectInspectIntent(userMessage) ? 2 : 1
  return evidence.implReadCount < needed
}

function buildProjectInspectContext(userMessage = '') {
  if (!looksLikeProjectInspectIntent(userMessage)) return ''
  if (looksLikeDeepProjectInspectIntent(userMessage)) {
    return '本轮要深入了解项目：README/Markdown 只是线索，不能当实现。必须读入口和至少两个真实源码文件后再总结。文档与代码冲突以代码为准。'
  }
  return '本轮要了解项目：不要只看 README/Markdown 或目录名就总结。至少读入口或一个真实实现文件；文档与代码冲突以代码为准。'
}

function buildDocsOnlyInspectNudge(userMessage = '', toolCalls = []) {
  if (!needsInspectSourceEvidence(userMessage, toolCalls)) return ''
  const evidence = collectInspectEvidence(toolCalls)
  if (!evidence.readCount && !evidence.listedCount && !evidence.searchedCount) return ''
  const needed = looksLikeDeepProjectInspectIntent(userMessage) ? 2 : 1
  const seen = evidence.docReads.slice(0, 3).map(item => item.split('/').pop()).join('、')
  return [
    `内部提醒：当前还只看到文档/目录${seen ? `（${seen}）` : ''}，没有足够的实现源码。`,
    `README/Markdown 不能当项目事实。下一步必须 file_read 入口和真实代码（js/ts/py/html 等），至少 ${needed} 个实现文件后再总结。`,
    '文档与代码冲突以代码为准。不要重复读同一份说明文档。'
  ].join('')
}

function buildInspectFinalNudge(userMessage = '', toolCalls = []) {
  if (!needsInspectSourceEvidence(userMessage, toolCalls)) return ''
  const needed = looksLikeDeepProjectInspectIntent(userMessage) ? 2 : 1
  return [
    `最终回复前先判断：了解项目还不能只靠 README/Markdown。`,
    `若还没读到真实实现，先 file_read 入口和源码（至少 ${needed} 个实现文件）再介绍；已经根据源码能说明项目也可以收尾，但不要把文档复述说成已经看过代码。`
  ].join('')
}

module.exports = {
  looksLikeProjectInspectIntent,
  looksLikeDeepProjectInspectIntent,
  isDocLikePath,
  isImplementationPath,
  collectInspectEvidence,
  needsInspectSourceEvidence,
  buildProjectInspectContext,
  buildDocsOnlyInspectNudge,
  buildInspectFinalNudge
}
