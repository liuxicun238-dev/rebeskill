/**
 * 网页桥提示词：少说话，工具协议收死。
 * 完整 JSON Schema 和灵犀主系统提示都不往页面输入框里塞。
 * 不要在提示词里提搜索、lxweb、联网：一提，网页模型就会以为自己不能搜。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {
  looksLikeProjectInspectIntent,
  looksLikeDeepProjectInspectIntent,
  needsInspectSourceEvidence
} = require('./project-inspect-evidence')

const TOOL_CALL_OPEN = '<LINGXI_TOOL_CALLS>'
const TOOL_CALL_CLOSE = '</LINGXI_TOOL_CALLS>'
const FINAL_OPEN = '<LINGXI_FINAL>'
const FINAL_CLOSE = '</LINGXI_FINAL>'
const FINAL_OPEN_RE = /<\s*LINGXI_FINAL\s*>/i
const FINAL_CLOSE_RE = /<\s*\/\s*LINGXI_FINAL\s*>/i
const FINAL_TAG_RE = /<\s*\/?\s*LINGXI_FINAL\s*>/gi
const STAGE_OPEN = '<LINGXI_STAGE>'
const STAGE_CLOSE = '</LINGXI_STAGE>'
const STAGE_OPEN_RE = /<\s*LINGXI_STAGE\s*>/i
const STAGE_CLOSE_RE = /<\s*\/\s*LINGXI_STAGE\s*>/i
const STAGE_TAG_RE = /<\s*\/?\s*LINGXI_STAGE\s*>/gi
const RUNTIME_MARK = '【本轮动态执行上下文】'
const TOOL_RESULT_KEEP = 12000
const TOOL_CALL_KEEP = 12000
const PASTE_FILE_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.svg'])
const PASTE_FILE_SKIP = /(?:^|[\\/])(?:node_modules|dist|payload|\.git|win-unpacked)(?:[\\/]|$)/i
const PASTE_FILE_PREFERRED = ['index.html', 'index.htm', 'style.css', 'styles.css', 'script.js', 'app.js', 'main.js']
const PASTE_FILE_MAX_FILES = 8
const PASTE_FILE_MAX_BYTES = 80000
const PASTE_FILE_MAX_FILE_BYTES = 40000
const PASTE_FILE_MAX_DEPTH = 2

const WEB_TOOL_HINTS = {
  code_inspect: '搜代码，grep/locate',
  file_search: '找文件，glob',
  file_read: '读文件',
  read_file: '读文件',
  text_edit: '局部改',
  apply_patch: '打补丁',
  write_file: '写文件，新建或整文件覆盖都可以',
  edit_file: '单点替换',
  json_edit: '改 JSON',
    file_manage: '新建目录/复制/移动/删除',
  shell_run: '跑命令',
  ask_user_choice: '弹窗让用户选，不要把选择题写进最终回复',
  enter_plan_mode: '先出方案再让用户选',
  confirm_plan: '弹窗确认待办步骤，不要把确认写进正文',
  complete_step: '证据够了必须勾进度；不要把阶段性说明当成完成',
  record_ai_operation_memo: '改完项目后记一条备忘，title+summary+changes',
  project_history: '查旧备忘录 search_memos/read_memo，或看最近改动',
  generate_music: '歌词lyrics≤3500，风格prompt≤2000，歌名title，数量n；纯音乐用 is_instrumental'
}

const WEB_BRIDGE_DIALECT_JSON_FENCE = 'json-fence'
const WEB_BRIDGE_DIALECT_PASTE_FILES = 'paste-files'
const WEB_BRIDGE_MODE_LINGXI = 'lingxi'
const WEB_BRIDGE_MODE_PASSTHROUGH = 'passthrough'
const PASSTHROUGH_MAX_TOOLS = 32
const PASSTHROUGH_SYSTEM_KEEP = 8000
const PASSTHROUGH_RUN_CODE_SYSTEM_KEEP = 40000

function isWebJsonFenceDialect(dialect = '') {
  return String(dialect || '').toLowerCase() === WEB_BRIDGE_DIALECT_JSON_FENCE
}

function isWebPasteFilesDialect(dialect = '') {
  return String(dialect || '').toLowerCase() === WEB_BRIDGE_DIALECT_PASTE_FILES
}

function countHtmlTag(text = '', tag = '') {
  const name = String(tag || '').trim()
  if (!name) return 0
  const re = new RegExp(`<${name}\\b[^>]*>`, 'gi')
  return (String(text || '').match(re) || []).length
}

function countHtmlCloseTag(text = '', tag = '') {
  const name = String(tag || '').trim()
  if (!name) return 0
  const re = new RegExp(`</${name}\\s*>`, 'gi')
  return (String(text || '').match(re) || []).length
}

function looksLikeHtmlDocumentWrite(filePath = '', content = '') {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  const text = String(content || '')
  if (!text.trim()) return false
  if (ext === '.html' || ext === '.htm') return true
  return /<!DOCTYPE\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text)
}

function inspectWebBridgeHtmlDocument(filePath = '', content = '') {
  const text = String(content || '')
  const problems = []
  if (!looksLikeHtmlDocumentWrite(filePath, text)) return problems
  const hasDoctype = /<!DOCTYPE\s+html/i.test(text)
  const htmlOpen = countHtmlTag(text, 'html')
  const htmlClose = countHtmlCloseTag(text, 'html')
  const headOpen = countHtmlTag(text, 'head')
  const headClose = countHtmlCloseTag(text, 'head')
  const bodyOpen = countHtmlTag(text, 'body')
  const bodyClose = countHtmlCloseTag(text, 'body')
  const styleOpen = countHtmlTag(text, 'style')
  const styleClose = countHtmlCloseTag(text, 'style')
  const scriptOpen = countHtmlTag(text, 'script')
  const scriptClose = countHtmlCloseTag(text, 'script')
  const divOpen = countHtmlTag(text, 'div')
  const divClose = countHtmlCloseTag(text, 'div')
  const spanOpen = countHtmlTag(text, 'span')
  const spanClose = countHtmlCloseTag(text, 'span')
  const svgOpen = countHtmlTag(text, 'svg')
  const svgClose = countHtmlCloseTag(text, 'svg')
  if (!hasDoctype) problems.push('缺少 <!DOCTYPE html>')
  if (!htmlOpen) problems.push('缺少 <html>')
  if (htmlOpen && !htmlClose) problems.push('缺少 </html>')
  if (!headOpen) problems.push('缺少 <head>')
  if (headOpen && !headClose) problems.push('缺少 </head>')
  if (!bodyOpen) problems.push('缺少 <body>')
  if (bodyOpen && !bodyClose) problems.push('缺少 </body>')
  if (/:root\s*\{|--[a-zA-Z-]+:/.test(text) && !styleOpen) problems.push('CSS 变量写进了正文，缺少 <style>')
  if (styleOpen && styleOpen !== styleClose) problems.push('<style> 标签未成对')
  if (scriptOpen && scriptOpen !== scriptClose) problems.push('<script> 标签未成对')
  if (divOpen && divClose === 0) problems.push('存在未闭合的 <div>')
  if (spanOpen && spanClose === 0) problems.push('存在未闭合的 <span>')
  if (svgOpen && svgClose === 0) problems.push('存在未闭合的 <svg>')
  if (divOpen > 0 && divClose > 0 && divOpen - divClose >= 3) problems.push('<div> 开闭标签数量严重不匹配')
  return problems
}

function assertWebBridgeHtmlDocument(filePath = '', content = '') {
  const problems = inspectWebBridgeHtmlDocument(filePath, content)
  if (!problems.length) return
  throw Object.assign(new Error(`HTML 页面结构不完整，已拒绝写入：${problems.join('；')}。请补齐 <!DOCTYPE>、<html>、<head>、<style>、<body> 和对应结束标签后再输出 write_file。`), {
    code: 'INVALID_HTML_DOCUMENT'
  })
}

function extractWebBridgeWriteDiagnostics(result = {}) {
  const payload = result && typeof result === 'object' ? result : {}
  const nested = payload.postEditDiagnostics && typeof payload.postEditDiagnostics === 'object'
    ? payload.postEditDiagnostics
    : {}
  const blocking = payload.blocking === true || nested.blocking === true
  const requiresFix = payload.requires_fix === true || nested.requires_fix === true
  const errors = []
  const collect = (list) => {
    if (!Array.isArray(list)) return
    for (const item of list) {
      const message = String(item?.message || item || '').trim()
      if (message && !errors.includes(message)) errors.push(message)
    }
  }
  collect(payload.syntaxWarning?.errors)
  collect(nested.errors)
  if (Array.isArray(nested.failed_files)) {
    nested.failed_files.forEach((file) => collect(file?.errors))
  }
  return {
    blocking,
    requiresFix,
    errors,
    nextAction: String(payload.next_action || nested.next_action || '').trim()
  }
}

function hasBlockingWebBridgeWriteDiagnostics(result = {}) {
  const info = extractWebBridgeWriteDiagnostics(result)
  return info.blocking || info.requiresFix || info.errors.length > 0
}

function collectBlockingWebBridgeWriteDiagnostics(toolResults = []) {
  const items = []
  for (const entry of Array.isArray(toolResults) ? toolResults : []) {
    const name = String(entry?.toolName || entry?.name || '').trim()
    if (!/^(write_file|text_edit|edit_file|apply_patch|json_edit)$/.test(name)) continue
    const result = entry?.result && typeof entry.result === 'object' ? entry.result : {}
    if (!hasBlockingWebBridgeWriteDiagnostics(result)) continue
    const info = extractWebBridgeWriteDiagnostics(result)
    const filePath = String(result.path || result.relative_path || '').trim()
    items.push({
      name,
      path: filePath,
      errors: info.errors,
      nextAction: info.nextAction
    })
  }
  return items
}

function collectUnresolvedBlockingWebBridgeWriteDiagnostics(toolResults = []) {
  const latestByKey = new Map()
  let anon = 0
  for (const entry of Array.isArray(toolResults) ? toolResults : []) {
    const name = String(entry?.toolName || entry?.name || '').trim()
    if (!/^(write_file|text_edit|edit_file|apply_patch|json_edit)$/.test(name)) continue
    const result = entry?.result && typeof entry.result === 'object' ? entry.result : {}
    const filePath = String(result.path || result.relative_path || entry?.args?.path || '').trim().replace(/\\/g, '/').toLowerCase()
    const key = filePath || `__anon_${anon++}`
    latestByKey.set(key, entry)
  }
  return collectBlockingWebBridgeWriteDiagnostics([...latestByKey.values()])
}

function buildWebBridgeBlockingWriteFixPrompt(diagnostics = []) {
  const items = Array.isArray(diagnostics) ? diagnostics.filter(Boolean) : []
  const details = items.slice(0, 4).map((item, index) => {
    const where = item.path ? ` ${item.path}` : ''
    const errors = (item.errors || []).slice(0, 6).join('；') || '结构不完整'
    return `${index + 1}.${where}：${errors}`
  }).join('\n')
  return [
    '刚才写入的页面没有通过结构检查，不能当成完成。',
    '禁止输出 <LINGXI_FINAL>，也不要把成功创建当最终回复。',
    '先 file_read 读取刚写入的源码，再 write_file 或 text_edit 补齐缺失的 HTML 标签。',
    '必须保留 <!DOCTYPE html>、<html>、<head>、<style>、<body> 以及对应结束标签。',
    details ? `诊断：\n${details}` : ''
  ].filter(Boolean).join('\n')
}

function shouldAcceptWebBridgeFinalReply({ stageTurn = false, blockingWrites = false, inspectNeedsMore = false } = {}) {
  return !(stageTurn || blockingWrites || inspectNeedsMore)
}

function webBridgeInspectNeedsMore(userText = '', toolCalls = []) {
  return needsInspectSourceEvidence(userText, toolCalls)
}

function buildWebBridgeInspectKeepGoingPrompt({ userText = '', toolCalls = [], dialect = '' } = {}) {
  if (!webBridgeInspectNeedsMore(userText, toolCalls)) return ''
  const needed = looksLikeDeepProjectInspectIntent(userText) ? 2 : 1
  if (isWebPasteFilesDialect(dialect)) {
    return `上面还只是目录、README 或 package.json 一类配置，不能当项目结论。继续读入口和真实源码后再介绍，至少 ${needed} 个实现文件。`
  }
  if (isWebJsonFenceDialect(dialect)) {
    return [
      '上面还只是目录、README 或 package.json 一类配置，不能当项目结论。',
      `下一句必须写 json 代码块，file_read 入口和真实源码（js/ts/html 等），至少 ${needed} 个实现文件。`,
      '禁止再次 file_search 同一路径或 **/*。禁止输出 <LINGXI_FINAL>。'
    ].join('')
  }
  return [
    '上面还只是目录、README 或 package.json 一类配置，不能当项目结论。',
    `下一句必须继续 file_read 入口和真实源码，至少 ${needed} 个实现文件。`,
    '禁止再次 file_search 同一路径或 **/*。禁止输出 <LINGXI_FINAL>。'
  ].join('')
}

function buildWebBridgeStageFinalRejectPrompt({ dialect = '' } = {}) {
  const stageRule = '这一轮只允许阶段性说明：必须整段包在 <LINGXI_STAGE> 和 </LINGXI_STAGE> 里。'
  const banFinal = '禁止输出 <LINGXI_FINAL>，也不要把“已成功创建/已完成”当最终回复。'
  if (isWebJsonFenceDialect(dialect)) {
    return [stageRule, banFinal, '不要再写 json 代码块。工具结果若仍有 HTML 结构错误或 blocking，先说明问题和下一步修复，不要宣布完成。'].join('\n')
  }
  return [stageRule, banFinal, '不要调工具，不要复述指令。'].join('\n')
}

function isWebBridgePassthroughMode(mode = '') {
  const value = mode === true ? WEB_BRIDGE_MODE_PASSTHROUGH : String(mode || '').toLowerCase()
  return value === WEB_BRIDGE_MODE_PASSTHROUGH || value === 'generic' || value === 'openai'
}

const WEB_BRIDGE_TOOL_ALIASES = {
  read_file: 'file_read',
  readfile: 'file_read',
  cat: 'file_read',
  open_file: 'file_read',
  view_file: 'file_read',
  search_file: 'file_search',
  search_files: 'file_search',
  glob: 'file_search',
  list_dir: 'file_search',
  list_files: 'file_search',
  ls: 'file_search',
  grep: 'code_inspect',
  search_code: 'code_inspect',
  create_file: 'write_file',
  writefile: 'write_file',
  save_file: 'write_file',
  patch: 'apply_patch',
  str_replace: 'edit_file',
  replace: 'edit_file',
  run_command: 'shell_run',
  bash: 'shell_run',
  terminal: 'shell_run',
  mkdir: 'file_manage',
  create_directory: 'file_manage',
  ask_user: 'ask_user_choice',
  ask_choice: 'ask_user_choice',
  confirm: 'confirm_plan'
}

const WEB_BRIDGE_PLACEHOLDER_TOOL_NAMES = new Set([
  '工具名',
  'toolname',
  'tool_name',
  'name',
  'tool',
  'function',
  'xxx',
  'todo'
])

function normalizeWebBridgeToolNameToken(name = '') {
  return String(name || '').trim().replace(/[\s-]+/g, '_').replace(/[“”"']/g, '')
}

function isPlaceholderWebBridgeToolName(name = '') {
  const raw = String(name || '').trim()
  const token = normalizeWebBridgeToolNameToken(raw).toLowerCase()
  if (!raw || !token) return true
  if (WEB_BRIDGE_PLACEHOLDER_TOOL_NAMES.has(raw) || WEB_BRIDGE_PLACEHOLDER_TOOL_NAMES.has(token)) return true
  return /^(?:tool|name|function|xxx|todo)(?:name)?$/i.test(token)
}

function inferWebBridgeToolNameFromArgs(args = {}, allowed) {
  const payload = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const names = allowed instanceof Set ? [...allowed] : []
  const pick = (...candidates) => candidates.find(name => allowed.has(name)) || ''
  if (payload.patch != null) return pick('apply_patch')
  if (payload.old_content != null && payload.new_content != null) return pick('edit_file', 'text_edit')
  if (Array.isArray(payload.edits) || payload.start_line != null || payload.startLine != null) return pick('text_edit', 'edit_file')
  if (payload.content != null || payload.contents != null) return pick('write_file')
  if (payload.command != null) return pick('shell_run')
  if (payload.action && /^(create_directory|mkdir|copy|move|delete|rename)$/i.test(String(payload.action))) return pick('file_manage')
  if (payload.question != null || payload.options != null) return pick('ask_user_choice')
  if (payload.plan != null || payload.steps != null) return pick('confirm_plan')
  if (payload.step_index != null) return pick('complete_step')
  if (payload.pattern != null || payload.query != null || payload.glob != null) {
    return pick('file_search', 'code_inspect', 'file_read')
  }
  if (payload.path != null || payload.file_path != null) {
    return pick('file_read', 'file_search', 'write_file')
  }
  return ''
}

function resolveWebBridgeToolName(name = '', args = {}, allowedNames = []) {
  const allowed = allowedNames instanceof Set ? allowedNames : new Set(allowedNames)
  const raw = normalizeWebBridgeToolNameToken(name)
  if (raw && allowed.has(raw)) return raw
  const alias = WEB_BRIDGE_TOOL_ALIASES[raw] || WEB_BRIDGE_TOOL_ALIASES[raw.toLowerCase()]
  if (alias && allowed.has(alias)) return alias
  const lower = raw.toLowerCase()
  for (const candidate of allowed) {
    if (String(candidate).toLowerCase() === lower) return candidate
  }
  if (isPlaceholderWebBridgeToolName(raw)) {
    return inferWebBridgeToolNameFromArgs(args, allowed)
  }
  return ''
}

function collectWebBridgeToolNames(tools = []) {
  if (!Array.isArray(tools)) return []
  const names = []
  for (const tool of tools) {
    const nested = tool?.function && typeof tool.function === 'object' ? tool.function : null
    const name = String(nested?.name || tool?.name || '').trim()
    if (name) names.push(name)
  }
  return names
}

function looksLikeLingxiWebToolset(tools = []) {
  const names = collectWebBridgeToolNames(tools)
  if (!names.length || names.includes('run_code')) return false
  const lingxiHits = names.filter(name => Object.prototype.hasOwnProperty.call(WEB_TOOL_HINTS, name))
  if (lingxiHits.length >= 3) return true
  return lingxiHits.length > 0 && lingxiHits.length === names.length
}

function looksLikeLingxiWebRequest(body = {}, tools = []) {
  if (looksLikeLingxiWebToolset(tools.length ? tools : body?.tools)) return true
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.some(message => {
    const content = typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.map(part => String(part?.text || part?.content || '')).join('\n')
        : ''
    return /【内部工作流指令】|<LINGXI_TOOL_CALLS>|<LINGXI_FINAL>/.test(content)
  })
}

function getWebBridgeAgentLane({ headers = {}, body = {}, tools = [], bridgeMode = '' } = {}) {
  const toolset = Array.isArray(tools) && tools.length ? tools : (body?.tools || [])
  if (looksLikeLingxiWebRequest(body, toolset) || String(bridgeMode || '').toLowerCase() === WEB_BRIDGE_MODE_LINGXI) {
    return 'lingxi'
  }
  const names = collectWebBridgeToolNames(toolset).slice().sort()
  const agentId = String(
    headers?.['x-lingxi-agent-id']
    || body?.metadata?.agent_id
    || body?.metadata?.agentId
    || ''
  ).trim()
  const protocol = names.length ? names.join(',') : 'none'
  const raw = `${agentId || 'external'}:${protocol}`
  return `passthrough:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
}

function buildWebChatSessionKey({ projectId = '', sessionId = '', lane = '' } = {}) {
  const pid = String(projectId || '').trim()
  const sid = String(sessionId || 'default').trim() || 'default'
  const agentLane = String(lane || 'lingxi')
  if (agentLane === 'lingxi') {
    return crypto.createHash('sha256').update(`${pid}:${sid}`).digest('hex').slice(0, 24)
  }
  return crypto.createHash('sha256').update(`${agentLane}:${pid}:${sid}`).digest('hex').slice(0, 24)
}

function buildWebChatSessionKeyFromRequest(req = {}, body = {}, bridgeMode = '') {
  const projectId = String(req?.headers?.['x-lingxi-project-id'] || body?.metadata?.project_id || '').trim()
  const sessionId = String(req?.headers?.['x-lingxi-session-id'] || body?.metadata?.session_id || body?.user || 'default').trim()
  const lane = getWebBridgeAgentLane({ headers: req?.headers, body, tools: body?.tools, bridgeMode })
  return buildWebChatSessionKey({ projectId, sessionId, lane })
}

function pickReusableWebChatPage(pages = [], { savedUrl = '', sessionKey = '', chatSessions = new Map() } = {}) {
  const otherOwned = new Set()
  for (const [key, session] of chatSessions.entries()) {
    if (key === sessionKey) continue
    if (session?.page && !session.page.isClosed()) otherOwned.add(session.page)
  }
  const open = (Array.isArray(pages) ? pages : []).filter(page => page && !page.isClosed() && !otherOwned.has(page))
  const want = String(savedUrl || '')
  if (want) {
    const exact = open.find(page => page.url() === want)
    if (exact) return exact
  }
  return null
}

const WEB_BRIDGE_NEW_CHAT_SELECTORS = [
  '[data-testid="create-new-chat-button"]',
  'a[href="/new"]',
  'a[href="https://claude.ai/new"]',
  'button[aria-label*="New chat" i]',
  'button[aria-label*="new chat" i]',
  'button[aria-label*="新对话"]',
  'button[aria-label*="新聊天"]',
  'a[aria-label*="New chat" i]',
  'a[aria-label*="新对话"]',
  '.new-chat',
  '[aria-label="New Chat"]'
]

async function clickWebBridgeNewChatButton(page) {
  if (!page) return false
  const names = /new chat|new conversation|新对话|新聊天|新建对话/i
  try {
    const button = page.getByRole?.('button', { name: names })
    if (button && await button.count()) {
      await button.first().click({ timeout: 2000 })
      return true
    }
  } catch (_) { /* try selectors */ }
  try {
    const link = page.getByRole?.('link', { name: names })
    if (link && await link.count()) {
      await link.first().click({ timeout: 2000 })
      return true
    }
  } catch (_) { /* try selectors */ }
  for (const selector of WEB_BRIDGE_NEW_CHAT_SELECTORS) {
    try {
      const loc = page.locator(selector).first()
      if (await loc.count() && await loc.isVisible()) {
        await loc.click({ timeout: 1500 })
        return true
      }
    } catch (_) { /* next */ }
  }
  return false
}

function resolveWebBridgeApiMode({ headers = {}, body = {}, queryMode = '', tools = [] } = {}) {
  const headerMode = String(headers?.['x-lingxi-bridge-mode'] || '').trim().toLowerCase()
  const bodyMode = String(body?.metadata?.bridge_mode || body?.metadata?.bridgeMode || '').trim().toLowerCase()
  const mode = headerMode || bodyMode || String(queryMode || '').trim().toLowerCase()
  const toolset = Array.isArray(tools) && tools.length ? tools : (body?.tools || [])
  if (looksLikeLingxiWebRequest(body, toolset)) return WEB_BRIDGE_MODE_LINGXI
  if (isWebBridgePassthroughMode(mode)) return WEB_BRIDGE_MODE_PASSTHROUGH
  if (mode === WEB_BRIDGE_MODE_LINGXI) return WEB_BRIDGE_MODE_LINGXI
  const projectId = String(headers?.['x-lingxi-project-id'] || body?.metadata?.project_id || '').trim()
  return projectId ? WEB_BRIDGE_MODE_LINGXI : WEB_BRIDGE_MODE_PASSTHROUGH
}

function getWebBridgeSystemStandin(options = {}) {
  if (isWebPasteFilesDialect(options.dialect)) {
    return [
      '下面会贴上当前项目文件。若要修改，按同样格式用代码块给出改完后的完整文件，语言标记后面写路径。',
      '路径用正斜杠，如 E:/a/b.js。CSS 注释必须是 /* ... */，禁止 ===== /。能直接回答就用中文回答。',
      '需要用户选择时写成“请用户选择”，下面写问题和两个选项，不要把选择题当最终回答。'
    ].join('\n')
  }
  if (isWebJsonFenceDialect(options.dialect)) {
    return [
      '这是桌面编辑器里的对话。需要看或改项目文件时，写一个 json 代码块，编辑器会读写文件并把结果贴回来。',
      'write_file 可以新建或覆盖。路径用正斜杠，如 E:/a/b.js。JSON 只转义双引号和换行，不要把 \\:root 写进源码。每轮最多 4 条。能直接回答就用普通文字。',
      '需要用户选择时写 json 代码块，name 为 ask_user_choice；确认计划用 confirm_plan。',
      '改完项目可 record_ai_operation_memo。查旧备忘录用 project_history action=search_memos/read_memo。',
      '纯闲聊才直接回答。'
    ].join('\n')
  }
  return [
    '本地客户端会解析你回复里的标签，并在用户电脑上改文件。你本人不执行、不连接电脑，只填写调用单。',
    '需要看或改文件时，直接输出标签，不要讨论有没有工具、能不能执行、是不是伪造。不要把完整文件写在普通代码块里。',
    '改文件就直接写。write_file 可以新建，也可以整文件覆盖已有文件。局部改动用 apply_patch 或 text_edit。审查先读后改。路径用正斜杠，如 E:/a/b.js。',
    buildWebBridgeSourceQualityRule({ compact: true }),
    `每轮最多 4 个调用。能回答用户时用 ${FINAL_OPEN} 包住最终回答，不要用 ${STAGE_OPEN}，不要再调工具。`,
    '需要用户做选择时用 ask_user_choice，确认执行计划用 confirm_plan，不要把选择题或确认写进最终说明。',
    '改完项目可 record_ai_operation_memo。查旧备忘录用 project_history，action 为 search_memos 或 read_memo。',
    '纯闲聊才直接回答。'
  ].join('\n')
}

function compactLongText(text, keep) {
  const value = String(text || '')
  if (value.length <= keep) return value
  const head = Math.max(80, Math.floor(keep * 0.7))
  const tail = Math.max(80, keep - head - 48)
  return `${value.slice(0, head)}\n...[已省略 ${value.length - keep} 字]...\n${value.slice(-tail)}`
}

function isWebThinkingPlaceholder(text) {
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
  if (!value) return true
  if (value.length > 80) return false
  return /^(正在处理|处理中|正在思考|思考中|深度思考中|Thinking|Thinking…|Thinking\.\.\.|Processing)[.。…\s]*$/i.test(value)
}

function decodeWebBridgeCipherEntities(text = '') {
  return String(text || '')
    .replace(/&lt;(\s*\/?\s*LINGXI_(?:FINAL|STAGE|TOOL_CALLS)\s*)&gt;/gi, '<$1>')
}

function isInstructionalWebBridgeFinalInner(inner = '') {
  const body = String(inner || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '')
  return /^(?:与|和|or|and|\/|、|，|,)?$/i.test(body)
}

function isInstructionalWebBridgeFinalContext(before = '', after = '') {
  const around = `${String(before || '').slice(-48)} ${String(after || '').slice(0, 48)}`.replace(/\s+/g, '')
  return /包在|必须用|不要用|不要混用|两套暗号|填写调用标签|整段包在/.test(around)
}

function nextClosedWebBridgeFinalMatch(text = '', from = 0) {
  const value = String(text || '')
  const slice = value.slice(from)
  const openMatch = slice.match(FINAL_OPEN_RE)
  if (!openMatch) return null
  const openAt = from + openMatch.index
  const afterOpen = value.slice(openAt + openMatch[0].length)
  const closeMatch = afterOpen.match(FINAL_CLOSE_RE)
  if (!closeMatch) {
    return { instructional: true, nextFrom: openAt + openMatch[0].length }
  }
  const nestedOpen = afterOpen.match(FINAL_OPEN_RE)
  if (nestedOpen && nestedOpen.index < closeMatch.index) {
    return { instructional: true, nextFrom: openAt + openMatch[0].length }
  }
  const inner = afterOpen.slice(0, closeMatch.index)
  const afterClose = afterOpen.slice(closeMatch.index + closeMatch[0].length)
  const before = value.slice(0, openAt)
  const shortInner = String(inner).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').length < 24
  return {
    openAt,
    openLen: openMatch[0].length,
    closeAt: openAt + openMatch[0].length + closeMatch.index,
    closeLen: closeMatch[0].length,
    inner,
    afterClose,
    instructional: isInstructionalWebBridgeFinalInner(inner)
      || (shortInner && isInstructionalWebBridgeFinalContext(before, afterClose)),
    nextFrom: openAt + openMatch[0].length + closeMatch.index + closeMatch[0].length
  }
}

function hasClosedWebBridgeFinalCipher(text = '') {
  const value = decodeWebBridgeCipherEntities(text)
  let from = 0
  while (from < value.length) {
    const match = nextClosedWebBridgeFinalMatch(value, from)
    if (!match) return false
    if (!match.instructional) return true
    from = match.nextFrom
  }
  return false
}

function stripWebBridgeFinalMarkers(content = '') {
  return decodeWebBridgeCipherEntities(content).replace(FINAL_TAG_RE, '').trim()
}

function extractWebBridgeStageNote(content = '') {
  const notes = []
  let rest = decodeWebBridgeCipherEntities(content)
  for (let index = 0; index < 6; index += 1) {
    const openMatch = rest.match(STAGE_OPEN_RE)
    if (!openMatch) break
    const openAt = openMatch.index
    const after = rest.slice(openAt + openMatch[0].length)
    const closeMatch = after.match(STAGE_CLOSE_RE)
    const before = rest.slice(Math.max(0, openAt - 32), openAt).replace(/\s+/g, '')
    if (!closeMatch && /不要用|禁止输出|不要和|两套暗号|不要混用/.test(before)) {
      rest = `${rest.slice(0, openAt)}${after}`
      continue
    }
    const inner = (closeMatch ? after.slice(0, closeMatch.index) : after).replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    const afterClose = closeMatch ? after.slice(closeMatch.index + closeMatch[0].length) : ''
    rest = `${rest.slice(0, openAt)}\n${afterClose}`
    if (inner) notes.push(inner)
    if (!closeMatch) break
  }
  rest = rest.replace(STAGE_TAG_RE, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  return { found: notes.length > 0, note: notes.join('\n'), rest }
}

function stripWebBridgeStageMarkers(content = '') {
  const extracted = extractWebBridgeStageNote(content)
  return extracted.found ? extracted.rest : String(content || '').replace(STAGE_TAG_RE, '').trim()
}

function looksLikeWebBridgeStageNote(text = '') {
  return extractWebBridgeStageNote(text).found
}

function buildWebBridgeFinalReplyConstraint() {
  return `给用户的最终回答必须整段包在 ${FINAL_OPEN} 与 ${FINAL_CLOSE} 里。阶段性说明只用 ${STAGE_OPEN}。两套暗号不要混用。`
}

function isWebBridgeCjkChar(ch = '') {
  return /[\u4e00-\u9fff]/.test(ch)
}

function joinWebBridgeWrappedLines(left, right) {
  const a = String(left || '').replace(/[ \t]+$/g, '')
  const b = String(right || '').replace(/^[ \t]+/g, '')
  if (!a) return b
  if (!b) return a
  const gap = (isWebBridgeCjkChar(a.slice(-1)) && isWebBridgeCjkChar(b[0]))
    || /[-–—/：:]$/.test(a)
    || /^[-–—/]/.test(b)
    ? ''
    : ' '
  return `${a}${gap}${b}`
}

function shouldJoinWebBridgeVisualWrap(prev, next) {
  if (!prev || !next) return false
  if (/^\s*(?:[-*+] |\d+\. |#{1,6} |```|> |\|)/.test(next)) return false
  if (/^\s*\|/.test(prev) || (/\|/.test(prev.trim()) && /\|/.test(next.trim()))) return false
  if (/```/.test(prev) || /```/.test(next)) return false
  if (/^\s*(?:[-*+] |\d+\. )/.test(prev) && !/^\s*(?:[-*+] |\d+\. |#{1,6} )/.test(next)) return true
  if (/[。！？…；.!?;:]$/.test(prev.trimEnd())) return false
  return prev.trim().length <= 56
}

function looksLikeWebBridgePipeTableText(text = '') {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^```/.test(line))
  if (lines.length < 2) return false
  const tableLines = lines.filter(line => /\|/.test(line))
  if (tableLines.length < 2 || tableLines.length < lines.length * 0.7) return false
  return tableLines.some(line => /\|[\s:|-]+\|/.test(line) || /^\|?\s*:?-{2,}/.test(line.replace(/\s/g, '')))
}

function looksLikeWebBridgeHtmlTableOnly(text = '') {
  const value = String(text || '').trim()
  if (!/<table[\s>]/i.test(value) || !/<\/table>/i.test(value)) return false
  const leftover = value
    .replace(/<table[\s\S]*?<\/table>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/i, '')
    .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
    .replace(/\s+/g, '')
  return leftover.length < 48
}

function htmlTableStringToMarkdown(html = '') {
  const tableMatch = String(html || '').match(/<table[\s\S]*?<\/table>/i)
  if (!tableMatch) return ''
  const rows = []
  const chunk = tableMatch[0]
  const trRe = /<tr[\s\S]*?<\/tr>/gi
  let tr = null
  while ((tr = trRe.exec(chunk))) {
    const cells = []
    const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi
    let cell = null
    while ((cell = cellRe.exec(tr[0]))) {
      cells.push(String(cell[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim())
    }
    if (cells.length && cells.some(Boolean)) rows.push(cells)
  }
  if (!rows.length) return ''
  const width = Math.max(...rows.map(row => row.length))
  if (width < 2) return ''
  const normalized = rows.map(row => {
    const next = row.slice()
    while (next.length < width) next.push('')
    return next.slice(0, width)
  })
  const header = normalized[0]
  const body = normalized.slice(1)
  const out = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  body.forEach(row => out.push(`| ${row.join(' | ')} |`))
  return out.join('\n')
}

function unwrapWebBridgeCapturedTables(text = '') {
  return String(text || '').replace(/```([^\n]*)\n([\s\S]*?)```/g, (full, info, body) => {
    const lang = String(info || '').trim().toLowerCase()
    const trimmed = String(body || '').trim()
    if (looksLikeWebBridgeHtmlTableOnly(trimmed) && (!lang || /^(html|xml|markdown|md|text|txt)?$/.test(lang))) {
      const md = htmlTableStringToMarkdown(trimmed.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
      if (md) return md
    }
    if (looksLikeWebBridgePipeTableText(trimmed) && (!lang || /^(markdown|md|text|txt|csv)?$/.test(lang))) {
      return trimmed
    }
    return full
  })
}

function normalizeWebBridgeFinalBody(text = '') {
  const lines = unwrapWebBridgeCapturedTables(stripWebBridgeStageMarkers(String(text || '')).replace(/\r\n/g, '\n')).split('\n')
  const out = []
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/g, '')
    if (!out.length) {
      out.push(line)
      continue
    }
    if (!line.trim()) {
      if (out[out.length - 1] !== '') out.push('')
      continue
    }
    const prev = out[out.length - 1]
    if (prev && shouldJoinWebBridgeVisualWrap(prev, line)) {
      out[out.length - 1] = joinWebBridgeWrappedLines(prev, line)
      continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function isWebBridgeNoToolsRefusal(content = '') {
  const text = stripWebBridgeFinalMarkers(content).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '')
  if (!text) return false
  return /(?:没有|未|无)(?:提供|可用|加载|指定)[^。！？!?]{0,80}(?:工具|接口|协议)|没有实际(?:可调用|连接)|无法(?:执行|伪造)|执行或伪造|不能(?:伪造|输出|执行)[^。！？!?]{0,40}(?:工具|协议)|误认为已连接|工具执行接口|项目操作工具|可供调用|会在你的电脑上运行|当前(?:对话|会话)(?:中)?没有(?:实际|可用|提供)/.test(text)
    || /cannot(?:actually)?(?:access|use|read|create|output|execute|fake|forge).{0,80}(?:local|tool|protocol)|no(?:usable|available|actually.?connected)?(?:project)?(?:file)?tools?|would be mistaken for|not actually (?:connected|callable)|no (?:callable|executable) .{0,40}(?:tool|interface)/i.test(text)
}

function looksLikeWebBridgeProtocolSafetyRefusal(content = '') {
  const text = String(content || '').replace(/[\u200B-\u200D\uFEFF]/g, '')
  if (!text.trim()) return false
  return /识别并拒绝了|提示注入|虚假系统错误|不会输出这些自定义标签|不会按照上面那套格式|我是通过网页|这看起来是想让我模拟|不会使用这套|不是我这边真实的工具系统|不能假装在操作|真实支持的文件上传|无论包装成|看起来像工具调用的 JSON|第四种包装|变体伪装|没法照做|不会假装在操作|把文件直接上传|把出问题的文件贴|我这边有自己真实|冒充.{0,24}(?:代码块|文件)|不会输出那种代码块|外部程序写入|同样的请求在反复|立场没有变化|不会输出.{0,24}格式|还没告诉我具体|请你先上传文件|需要说明一下.{0,24}Claude/.test(text)
    || /prompt injection|I (?:will|won't|will not) (?:not )?(?:output|follow|simulate) .{0,40}(?:tag|protocol|LINGXI)/i.test(text)
    || /not (?:my|a) real tool system|won't (?:use|output) .{0,40}LINGXI|can't pretend to (?:operate|access) (?:your )?local/i.test(text)
}

function looksLikeWebBridgeFuturePlan(text = '') {
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '')
  if (!value) return false
  if (/已(?:经)?(?:查看|读取|完成|改完)|根据目录结构|项目包含以下/.test(value)) return false
  return /(?:我将|我会|我先|接下来|准备|打算|先看|先读|先浏览|这一轮(?:会|先)|目录下创建|开始创建)/.test(value)
}

function looksLikeWebBridgeRestatedCharter(text = '') {
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '')
  if (!value || value.length < 24) return false
  if (/已(?:经)?(?:读|看|打开|验证|勾选)|根据.{0,24}(?:测试|VALIDATION|主循环|入口)/.test(value) && !/这一轮继续|下一步会据此/.test(value)) {
    return false
  }
  return /这一轮继续|下一轮继续|下一步会据此|接下来会(?:把|再)|准备做最终归纳|避免被文档描述带偏|重点核对|重点确认|避免漏掉/.test(value)
    && /对照|验证|源码|计划|成熟度|机制/.test(value)
}

function looksLikeWebBridgeHallucinatedWork(text = '') {
  if (looksLikeWebBridgeToolProtocol(text)) return false
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  if (value.length < 36) return false
  if (looksLikeWebBridgeFuturePlan(value)) return false
  return /已(?:经)?(?:查看|读取|浏览|打开|列出|搜索|改完|完成|执行|帮你)|根据(?:目录|文件)结构|项目包含以下|主要文件有|我刚才(?:看|读|改了)|无需再(?:看|读|打开)/.test(value)
    || /当前项目[（(]位于|根据目录结构.{0,24}包含|存放小说的整体/.test(value)
}

function needsWebBridgeToolEvidence(userText = '') {
  if (looksLikeWebBridgeChitchat(userText)) return false
  if (looksLikeWebBridgeInspectQuestion(userText) || looksLikeWebBridgeDirectEditTask(userText)) return true
  if (extractWebBridgeProjectPath(userText)) return true
  return /这个项目|当前项目|项目里|可改进|优化|升级页面|看看项目/.test(String(userText || ''))
}

function shouldNudgeWebBridgeForMissingTools({ userText = '', content = '', dialect = '' } = {}) {
  if (isWebPasteFilesDialect(dialect)) return false
  if (looksLikeWebBridgeChitchat(userText)) return false
  if (looksLikeWebBridgeProtocolSafetyRefusal(content)) return false
  if (extractWebBridgeFinalReply(content).done) return false
  if (looksLikeWebBridgeToolProtocol(content)) return false
  if (isWebBridgeNoToolsRefusal(content)) return true
  if (looksLikeWebBridgeFileWrite(content)) return true
  if (looksLikeWebBridgeMangledFileDump(content)) return true
  if (looksLikeWebBridgeBareToolDump(content)) return true
  if (!needsWebBridgeToolEvidence(userText)) return false
  if (looksLikeWebBridgeHallucinatedWork(content)) return true
  if (looksLikeWebBridgeRestatedCharter(content)) return true
  if (looksLikeWebBridgeFuturePlan(content)) return true
  return looksLikeWebBridgeInspectQuestion(userText) && looksLikeWebBridgeAnsweredInspect(content)
}

function shouldRetryWebBridgeToolProtocol({ userText = '', answer = '', dialect = '' } = {}) {
  if (isWebPasteFilesDialect(dialect)) return false
  if (looksLikeWebBridgeChitchat(userText)) return false
  if (looksLikeWebBridgeProtocolSafetyRefusal(answer)) return false
  return true
}

function extractWebBridgeFinalReply(content = '') {
  const staged = extractWebBridgeStageNote(decodeWebBridgeCipherEntities(content))
  const original = staged.found ? staged.rest : decodeWebBridgeCipherEntities(content)
  let from = 0
  while (from < original.length) {
    const match = nextClosedWebBridgeFinalMatch(original, from)
    if (!match) {
      return { done: false, body: '', visible: original, noToolsRefusal: isWebBridgeNoToolsRefusal(original) }
    }
    if (match.instructional) {
      from = match.nextFrom
      continue
    }
    const body = normalizeWebBridgeFinalBody(String(match.inner || '').replace(/[\u200B-\u200D\uFEFF]/g, ''))
    const visible = normalizeWebBridgeFinalBody(`${original.slice(0, match.openAt)}\n${match.afterClose}`.replace(/[\u200B-\u200D\uFEFF]/g, ''))
    const noToolsRefusal = isWebBridgeNoToolsRefusal(body || original)
    if (noToolsRefusal) {
      return { done: false, body: '', visible: stripWebBridgeFinalMarkers(original), noToolsRefusal: true }
    }
    return { done: true, body: body || visible, visible, noToolsRefusal: false }
  }
  return { done: false, body: '', visible: original, noToolsRefusal: isWebBridgeNoToolsRefusal(original) }
}

function extractWebBridgeProjectPath(text = '') {
  const match = String(text || '').match(/当前项目路径：\s*([^\n\r]+)/)
  if (!match) return ''
  const projectPath = match[1].trim()
  if (!projectPath || projectPath === '未指定') return ''
  return projectPath
}

function extractProjectPathLine(text) {
  const projectPath = extractWebBridgeProjectPath(text)
  if (!projectPath) return ''
  return `当前项目路径：${projectPath.replace(/\\/g, '/')}`
}

function slashWebProjectPath(value = '') {
  return String(value || '').trim().replace(/\\/g, '/')
}

function isWebBridgeDemoExamplePath(value = '') {
  const text = slashWebProjectPath(value)
  return /^[a-z]:\/demo\/?$/i.test(text) || /^\{?当前项目路径\}?$/i.test(text)
}

function collectWebBridgeProjectPath(messages = []) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const found = extractWebBridgeProjectPath(list[index]?.content)
    if (found && !isWebBridgeDemoExamplePath(found)) return slashWebProjectPath(found)
    if (found) return slashWebProjectPath(found)
  }
  return ''
}

function rewriteWebBridgeExamplePath(value, projectPath = '') {
  const raw = String(value || '').trim()
  const root = slashWebProjectPath(projectPath)
  if (!raw) return root
  const normalized = slashWebProjectPath(raw)
  if (/^\{?当前项目路径\}?$/i.test(raw) || /^[a-z]:\/demo\/?$/i.test(normalized)) return root
  if (root && /^[a-z]:\/demo\//i.test(normalized)) {
    return `${root}${normalized.replace(/^[a-z]:\/demo/i, '')}`
  }
  return raw
}

function rewriteWebBridgeDemoPaths(args = {}, projectPath = '') {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const next = { ...args }
  for (const key of ['path', 'old_path', 'new_path', 'target', 'destination', 'source', 'cwd']) {
    if (typeof next[key] !== 'string') continue
    if (!isWebBridgeDemoExamplePath(next[key]) && !/^[a-z]:\/demo(?:\/|$)/i.test(slashWebProjectPath(next[key]))) continue
    const rewritten = rewriteWebBridgeExamplePath(next[key], projectPath)
    if (rewritten) next[key] = rewritten
  }
  return next
}

function fenceLangForPath(filePath = '') {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.css') return 'css'
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript'
  if (ext === '.json') return 'json'
  if (ext === '.md') return 'markdown'
  if (ext === '.svg' || ext === '.xml') return 'xml'
  return 'text'
}

function listWebBridgePasteCandidates(root = '') {
  const found = []
  const walk = (dir, depth) => {
    if (found.length >= 40 || depth > PASTE_FILE_MAX_DEPTH) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= 40) break
      const full = path.join(dir, entry.name)
      if (PASTE_FILE_SKIP.test(full)) continue
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (PASTE_FILE_EXTS.has(path.extname(entry.name).toLowerCase())) found.push(full)
    }
  }
  walk(root, 0)
  return found
}

function rankWebBridgePasteFile(filePath, root) {
  const rel = path.relative(root, filePath).replace(/\\/g, '/')
  const base = path.basename(filePath).toLowerCase()
  const preferred = PASTE_FILE_PREFERRED.indexOf(base)
  return [preferred >= 0 ? preferred : 80, rel.split('/').length, rel.length]
}

function gatherWebBridgeProjectFiles(projectPath, options = {}) {
  const root = String(projectPath || '').trim()
  if (!root) return []
  let stat = null
  try {
    stat = fs.statSync(root)
  } catch {
    return []
  }
  if (!stat.isDirectory()) return []
  const maxFiles = Number(options.maxFiles || PASTE_FILE_MAX_FILES)
  const maxBytes = Number(options.maxBytes || PASTE_FILE_MAX_BYTES)
  const maxFileBytes = Number(options.maxFileBytes || PASTE_FILE_MAX_FILE_BYTES)
  const ranked = listWebBridgePasteCandidates(root)
    .sort((a, b) => {
      const ra = rankWebBridgePasteFile(a, root)
      const rb = rankWebBridgePasteFile(b, root)
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
    })
  const files = []
  let used = 0
  for (const filePath of ranked) {
    if (files.length >= maxFiles || used >= maxBytes) break
    let size = 0
    try {
      size = fs.statSync(filePath).size
    } catch {
      continue
    }
    if (size > maxFileBytes || size + used > maxBytes) continue
    let content = ''
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    files.push({
      path: filePath.replace(/\\/g, '/'),
      content
    })
    used += content.length
  }
  return files
}

function formatWebBridgePastedFiles(files = []) {
  if (!Array.isArray(files) || !files.length) return ''
  const blocks = files.map(file => {
    const filePath = String(file.path || '').replace(/\\/g, '/')
    const lang = fenceLangForPath(filePath)
    const body = String(file.content || '').replace(/\s+$/g, '')
    return `### ${filePath}\n\`\`\`${lang}\n${body}\n\`\`\``
  })
  return ['当前项目文件：', ...blocks].join('\n\n')
}

function looksLikeWebBridgePathToken(value = '') {
  const text = String(value || '').trim()
    .replace(/^["'`<]+/, '')
    .replace(/["'`>]+$/, '')
    .replace(/--+>$/, '')
    .replace(/\*\/$/, '')
    .trim()
  if (!text || text.length > 360 || /\s/.test(text)) return false
  if (/^(https?:|data:|javascript:)/i.test(text)) return false
  return /\.\w{1,12}$/.test(text.replace(/[\\/]+$/, ''))
}

function resolveWebBridgeWritePath(filePath, projectPath = '') {
  let next = String(filePath || '').trim().replace(/\\/g, '/')
  if (!next) return ''
  const root = String(projectPath || '').trim().replace(/\\/g, '/')
  if (root && !/^[A-Za-z]:\//.test(next) && !next.startsWith('/')) {
    next = `${root.replace(/\/+$/, '')}/${next.replace(/^\/+/, '')}`
  }
  return next
}

function normalizeWebBridgeWritePath(filePath, projectPath = '') {
  const resolved = resolveWebBridgeWritePath(filePath, projectPath)
  if (!resolved) return ''
  if (/^[A-Za-z]:\//.test(resolved)) return resolved
  return ''
}

function stripWebBridgeFencePathHeader(body = '') {
  const lines = String(body || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  if (!lines.length) return String(body || '')
  const first = lines[0].trim()
  const labeled = /^(?:<!--\s*|\/\*\s*|\/\/\s*|#\s*)?(?:file|path|文件|filepath)\s*[:=：]/i.test(first)
  const token = first
    .replace(/^(?:<!--|\/\*|\/\/|#)\s*/, '')
    .replace(/\s*(?:-->|\*\/)\s*$/, '')
    .replace(/^(?:file|path|文件|filepath)\s*[:=：]\s*/i, '')
    .trim()
  if (labeled || looksLikeWebBridgePathToken(token)) {
    return lines.slice(1).join('\n').replace(/^\n/, '')
  }
  const second = String(lines[1] || '').trim()
  if (/^(html|htm|css|js|javascript|json|svg|xml|text|txt|markdown|md|vue|ts|tsx|jsx)$/i.test(first)
    && looksLikeWebBridgePathToken(second)) {
    return lines.slice(2).join('\n').replace(/^\n/, '')
  }
  return String(body || '')
}

function extractPathFromFenceMeta(info = '', body = '', before = '') {
  const infoRest = String(info || '').replace(/^(html|htm|css|js|javascript|json|svg|xml|text|txt|markdown|md|vue|ts|tsx|jsx)\b\s*:?\s*/i, '').trim()
  const infoToken = (infoRest.split(/\s+/)[0] || '').trim()
  if (looksLikeWebBridgePathToken(infoToken)) return infoToken
  const absInInfo = String(info || '').match(/[A-Za-z]:[\\/][^\s]+/)
  if (absInInfo && looksLikeWebBridgePathToken(absInInfo[0])) return absInInfo[0]
  const bodyLines = String(body || '').split(/\r?\n/)
  const firstLine = bodyLines[0] || ''
  const labeled = firstLine.match(/(?:file|path|文件)\s*[:=：]\s*([^\s*]+)/i)
  if (labeled) {
    const token = labeled[1].replace(/--+>/, '').replace(/\*\/$/, '')
    if (looksLikeWebBridgePathToken(token)) return token
  }
  const firstToken = firstLine
    .replace(/^(?:<!--|\/\*|\/\/|#)\s*/, '')
    .replace(/\s*(?:-->|\*\/)\s*$/, '')
    .trim()
  if (looksLikeWebBridgePathToken(firstToken)) return firstToken
  const secondLine = String(bodyLines[1] || '').trim()
  if (/^(html|htm|css|js|javascript|json|svg|xml|text|txt|markdown|md|vue|ts|tsx|jsx)$/i.test(firstToken) && looksLikeWebBridgePathToken(secondLine)) {
    return secondLine
  }
  const heading = String(before || '').trimEnd().split('\n').pop() || ''
  const cleaned = heading
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/^`+|`+$/g, '')
    .replace(/^(?:文件|file)\s*[：:]\s*/i, '')
    .trim()
  if (looksLikeWebBridgePathToken(cleaned)) return cleaned
  const headingPath = cleaned.match(/[A-Za-z]:[\\/][^\s]+|(?:[\w.-]+[\\/])+[\w.-]+\.\w{1,12}|[\w.-]+\.(?:html?|css|js|mjs|cjs|json|md|txt|svg)/i)
  if (headingPath && looksLikeWebBridgePathToken(headingPath[0])) return headingPath[0]
  return ''
}

function extractWebBridgeFileFenceWrites(text = '', { projectPath = '', maxCalls = 4 } = {}) {
  const value = String(text || '')
  if (looksLikeWebBridgeProtocolSafetyRefusal(value)) return []
  const writes = []
  const seen = new Set()
  const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g
  let match
  while ((match = fenceRe.exec(value))) {
    const info = String(match[1] || '').trim()
    let body = String(match[2] || '').replace(/\s+$/g, '')
    if (/"calls"\s*:\s*\[/.test(body)) continue
    const before = value.slice(Math.max(0, match.index - 240), match.index)
    const rawPath = extractPathFromFenceMeta(info, body, before)
    if (!rawPath) continue
    const filePath = normalizeWebBridgeWritePath(rawPath, projectPath)
    if (!filePath) continue
    body = stripWebBridgeFencePathHeader(body).replace(/\s+$/g, '')
    if (body.trim().length < 8) continue
    const key = filePath.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    writes.push({ name: 'write_file', arguments: { path: filePath, content: body } })
    if (writes.length >= Number(maxCalls || 4)) break
  }
  return writes
}

function looksLikeWebBridgeFileWrite(text = '') {
  return extractWebBridgeFileFenceWrites(text).length > 0
}

function looksLikeWebBridgeMangledFileDump(text = '') {
  const value = String(text || '')
  if (!value || looksLikeWebBridgeToolProtocol(value)) return false
  const paths = value.match(/[A-Za-z]:[\\/][^\s"'<>]+/g) || []
  const uniquePaths = Array.from(new Set(paths.map(item => item.replace(/\\/g, '/'))))
  const jammed = /[A-Za-z]:[\\/][^\s]*create_directory[A-Za-z]:/i.test(value)
    || /<\/[a-zA-Z]+>\s*js[A-Za-z]:/.test(value)
    || /[A-Za-z]:[\\/][^\s]+\.(?:css|js|mjs)(?:const|let|:root|\*)/.test(value)
  const hasCss = /:root\s*\{|--[a-zA-Z-]+:/.test(value)
  const hasHtml = /<section[\s>]|<footer[\s>]|<html[\s>]|<!DOCTYPE html/i.test(value)
  const hasJs = /document\.getElementById|addEventListener\s*\(/.test(value)
  const hasLineNumbers = /(?:^|\n)\s*1\s*\n\s*2\s*\n\s*3\s*\n/.test(value)
  return jammed || (uniquePaths.length >= 2 && (hasCss || hasHtml || hasJs)) || (hasLineNumbers && (hasHtml || hasCss))
}

function slugWebBridgeChoiceValue(label = '', index = 0) {
  const text = String(label || '').trim()
  if (!text) return `choice_${index + 1}`
  return text
}

function tryParseWebBridgeAskChoice(text = '') {
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  if (!value || looksLikeWebBridgeProtocolSafetyRefusal(value)) return null
  if (/"name"\s*:\s*"ask_user_choice"/i.test(value) && /"options"\s*:/.test(value)) return null
  if (!/请用户选择|请让用户选择|ask_user_choice/i.test(value)) return null
  const header = value.search(/请用户选择|请让用户选择/i)
  const body = header >= 0 ? value.slice(header) : value
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  let question = ''
  const questionLine = lines.find(line => /^(?:问题|question)\s*[：:]/i.test(line))
  if (questionLine) {
    question = questionLine.replace(/^(?:问题|question)\s*[：:]\s*/i, '').trim()
  } else {
    const headerLine = lines.find(line => /请用户选择|请让用户选择/i.test(line)) || ''
    question = headerLine.replace(/^请(?:用户|让用户)?选择[：:]?\s*/i, '').trim()
  }
  if (!question) {
    const next = lines.find(line => (
      !/请用户选择|请让用户选择/i.test(line)
      && !/^(?:[-*•]|\d+[.)、])/.test(line)
      && !/^(?:问题|question)\s*[：:]/i.test(line)
    ))
    question = String(next || '').trim()
  }
  if (!question) question = '请选择一个方案'
  const options = []
  const optionRe = /^(?:[-*•]|\d+[.)、]|（\d+）)\s*(?:\*\*)?(.+?)(?:\*\*)?\s*[：:]\s*(.+)$/
  for (const line of lines) {
    const match = line.match(optionRe)
    if (!match) continue
    const label = String(match[1] || '').trim()
    const desc = String(match[2] || '').trim()
    if (!label || /^(?:问题|question)$/i.test(label) || /^(?:选项|方案)\s*\d+$/i.test(label)) continue
    if (desc.length < 6) continue
    options.push({
      label,
      value: slugWebBridgeChoiceValue(label, options.length),
      desc
    })
    if (options.length >= 3) break
  }
  if (options.length < 2) return null
  return { question, options }
}

function extractWebBridgeAskUserChoiceCalls(text = '') {
  const args = tryParseWebBridgeAskChoice(text)
  if (!args) return []
  return [{ name: 'ask_user_choice', arguments: args }]
}

function parseWebBridgeAskChoiceFallback(text = '', tools = []) {
  const allowed = new Set((Array.isArray(tools) ? tools : []).map(tool => {
    const fn = tool?.function || tool || {}
    return String(fn.name || '').trim()
  }).filter(Boolean))
  if (!allowed.has('ask_user_choice')) return []
  const calls = extractWebBridgeAskUserChoiceCalls(text)
  if (!calls.length) return []
  return calls.map((call, index) => {
    const args = call.arguments || {}
    assertWebToolArguments('ask_user_choice', args)
    const serialized = JSON.stringify(args)
    if (serialized.length > 400000) {
      throw Object.assign(new Error('工具“ask_user_choice”的参数过大，已拒绝执行。'), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
    }
    return {
      id: `call_${crypto.randomBytes(12).toString('hex')}`,
      type: 'function',
      function: { name: 'ask_user_choice', arguments: serialized },
      index
    }
  })
}

function compactWebTranscriptContent(role, content, options = {}) {
  let text = String(content || '')
  if (options.passthrough) {
    const systemKeep = Number(options.systemKeep) > 0 ? Number(options.systemKeep) : PASSTHROUGH_SYSTEM_KEEP
    if (role === 'system' || role === 'developer') return compactLongText(text, systemKeep)
    if (role === 'tool') return compactLongText(text, TOOL_RESULT_KEEP)
    return text
  }
  if (role === 'system' || role === 'developer') {
    if (/内部工作流指令|执行控制指令/.test(text)) {
      if (/阶段性说明|打算怎么做|可勾选计划|对照已经冻结/.test(text)) return ''
      if (/只填写调用标签|继续同一任务/.test(text)) return '继续同一任务。已经能回答就直接写给用户看。'
      return ''
    }
    if (text.length > 500 || /show_thinking_note|start_final_reply|Agent 运行时|confirm_plan|lxweb|本轮动态执行上下文|ProductAgent/.test(text)) {
      return getWebBridgeSystemStandin(options)
    }
    return text
  }
  if (role === 'user') {
    const pathLine = extractProjectPathLine(text)
    const cut = text.indexOf(RUNTIME_MARK)
    if (cut >= 0) text = text.slice(0, cut).trim()
    const dumpIdx = text.search(/===== 当前运行上下文|===== 本轮任务锚点|===== 本轮 Agent 角色路由/)
    if (dumpIdx > 0 && text.length > 400) text = text.slice(0, dumpIdx).trim()
    if (pathLine && !text.includes('当前项目路径：')) {
      text = text ? `${text}\n${pathLine}` : pathLine
    }
    return compactLongText(text, 2000)
  }
  if (role === 'tool') return compactLongText(text, TOOL_RESULT_KEEP)
  if (extractWebBridgeFinalReply(text).done) return ''
  const stripped = stripWebBridgeFinalMarkers(text)
  if (isWebBridgeNoToolsRefusal(stripped)) {
    if (isWebPasteFilesDialect(options.dialect) || isWebJsonFenceDialect(options.dialect)) return stripped
    return '请按格式输出调用标签，不要讨论有没有工具。'
  }
  return stripped
}

function normalizePassthroughWebTools(tools = []) {
  if (!Array.isArray(tools)) return []
  return tools.slice(0, PASSTHROUGH_MAX_TOOLS).map(tool => {
    const nested = tool?.function && typeof tool.function === 'object' ? tool.function : null
    const fn = nested || tool || {}
    const name = String(fn.name || tool?.name || '').trim()
    if (!name || !/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) return null
    const parameters = (fn.parameters && typeof fn.parameters === 'object' && !Array.isArray(fn.parameters))
      ? fn.parameters
      : { type: 'object', properties: {} }
    return {
      name,
      description: String(fn.description || tool?.description || '').replace(/\s+/g, ' ').slice(0, 120),
      parameters
    }
  }).filter(Boolean)
}

function hasPassthroughRunCodeTool(tools = []) {
  return normalizePassthroughWebTools(tools).some(tool => tool.name === 'run_code')
}

function isPassthroughRunCodeOnly(tools = []) {
  const list = normalizePassthroughWebTools(tools)
  return list.length === 1 && list[0].name === 'run_code'
}

function formatPassthroughWebChatTranscript(messages = [], options = {}) {
  const labels = {
    system: 'system',
    developer: 'developer',
    user: 'user',
    assistant: 'assistant',
    tool: 'tool'
  }
  const systemKeep = hasPassthroughRunCodeTool(options.tools)
    ? PASSTHROUGH_RUN_CODE_SYSTEM_KEEP
    : PASSTHROUGH_SYSTEM_KEEP
  return (Array.isArray(messages) ? messages : []).map((message, index) => {
    const details = []
    if (message.content) {
      details.push(compactWebTranscriptContent(message.role, message.content, { passthrough: true, systemKeep }))
    }
    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        details.push(`[tool_call id=${call.id || ''} name=${call.name}]\n${compactWebToolCallArgs(call.name, call.arguments)}`)
      }
    }
    if (message.role === 'tool' && message.callId) {
      details.unshift(`[tool_result call_id=${message.callId}${message.name ? ` name=${message.name}` : ''}]`)
    }
    return `--- ${labels[message.role] || message.role} ${index + 1} ---\n${details.join('\n')}`
  }).join('\n\n')
}

function formatPassthroughToolList(tools = []) {
  return normalizePassthroughWebTools(tools).map(tool => {
    const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required.filter(Boolean) : []
    const props = tool.parameters?.properties && typeof tool.parameters.properties === 'object'
      ? Object.keys(tool.parameters.properties).slice(0, 8)
      : []
    const keys = (required.length ? required : props).join(', ')
    const hint = String(tool.description || '').replace(/\s+/g, ' ').slice(0, 100)
    return `- ${tool.name}(${keys})${hint ? `: ${hint}` : ''}`
  }).join('\n')
}

function assemblePassthroughRunCodeProtocol(list = []) {
  const others = list.filter(tool => tool.name !== 'run_code')
  const lines = [
    '这是网页聊天转发。你本人不执行工具；本地调用方会执行 run_code 并把结果贴回来。',
    '需要查看或修改项目时，不要把程序写进 json 字符串，也不要写 LINGXI 标签。按下面格式只写一个程序：',
    'run_code: 五到十字说明这段程序做什么',
    '```ts',
    "const files = await tools.glob({ pattern: '**/*' })",
    'console.log(files)',
    '```',
    '用系统提示里的 TypeScript SDK：顶层可以 await，用 await tools.xxx(...) 调用能力。'
  ]
  if (others.length) {
    lines.push('其他短工具仍可用 json 短参数；只有 run_code 把程序写在 ts 代码块里。')
    lines.push(formatPassthroughToolList(list))
  }
  lines.push('能直接回答就用普通文字。一次只写一个 run_code。')
  return lines.join('\n')
}

function unwrapSinglePassthroughUserTranscript(transcript = '') {
  const text = String(transcript || '').trim()
  const match = /^--- user 1 ---\n([\s\S]+)$/.exec(text)
  if (!match) return ''
  const body = match[1].trim()
  if (!body || /^--- \w+ \d+ ---/m.test(body)) return ''
  return body
}

function assemblePassthroughPagePrompt({ transcript = '', tools = [], maxToolCalls = 8 } = {}) {
  const list = normalizePassthroughWebTools(tools)
  const body = String(transcript || '').trim()
  if (!list.length) {
    const plain = unwrapSinglePassthroughUserTranscript(body)
    if (plain) return plain
    return body ? `${body}\n\n直接用普通文字回答。` : '直接用普通文字回答。'
  }
  const protocol = hasPassthroughRunCodeTool(list)
      ? assemblePassthroughRunCodeProtocol(list)
      : [
        '这是网页聊天转发。你本人不执行工具；本地调用方会执行并把结果贴回来。',
        `需要工具时，只输出一个 json 代码块，本轮最多 ${Number(maxToolCalls || 8)} 条。`,
        'json 里只放短参数（路径、开关、一两句话）。长代码、长文本不要写进 json 字符串，紧跟一个普通代码块。',
        '```json',
        '{"calls":[{"name":"ToolName","arguments":{"description":"做什么"}}]}',
        '```',
        '```',
        '长内容放这里，不要做 json 转义',
        '```',
        '名称必须与下面列表一致：',
        formatPassthroughToolList(list),
        '能直接回答就用普通文字。不要写 LINGXI 标签。'
      ].join('\n')
  return body ? `${body}\n\n${protocol}` : protocol
}

function repairPassthroughLooseJson(text = '') {
  const src = String(text || '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inString) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        const next = src[i + 1]
        if (next && '"\\/bfnrtu'.includes(next)) {
          out += ch
          escaped = true
        } else {
          out += '\\\\'
        }
        continue
      }
      if (ch === '"') {
        let j = i + 1
        while (j < src.length && /[ \t\r\n]/.test(src[j])) j += 1
        const next = src[j] || ''
        if (!next || ',:}]}'.includes(next)) {
          inString = false
          out += ch
        } else {
          out += '\\"'
        }
        continue
      }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
      out += ch
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    out += ch
  }
  return out
}

function sliceBalancedJsonObject(text = '', from = 0) {
  const src = String(text || '')
  let braces = 0
  let inString = false
  let escaped = false
  const start = Math.max(0, Number(from) || 0)
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') braces += 1
    else if (ch === '}') {
      braces -= 1
      if (braces === 0) return src.slice(start, i + 1)
    }
  }
  return src.slice(start).trim()
}

function extractPassthroughToolJsonSlice(text = '') {
  const value = String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^[ \t]*(?:Copy code|复制代码|Copy|复制)\s*$/gim, '')
  const fenceRe = /```(?:json|javascript|js)?\s*\r?\n([\s\S]*?)```/gi
  let match
  while ((match = fenceRe.exec(value))) {
    const inner = String(match[1] || '').trim()
    if (/"calls"\s*:\s*\[/.test(inner) || /"name"\s*:\s*"/.test(inner)) {
      return repairPassthroughLooseJson(inner)
    }
  }
  const start = value.search(/\{\s*"calls"\s*:\s*\[/)
  if (start >= 0) {
    const repaired = repairPassthroughLooseJson(value.slice(start))
    return sliceBalancedJsonObject(repaired, 0)
  }
  const named = value.search(/\{\s*"name"\s*:\s*"/)
  if (named >= 0) {
    const repaired = repairPassthroughLooseJson(value.slice(named))
    return sliceBalancedJsonObject(repaired, 0)
  }
  return ''
}

function parsePassthroughJson(text = '') {
  const raw = String(text || '').trim()
  if (!raw) return null
  const candidates = [
    raw,
    canonicalizeWebBridgeToolJson(raw),
    repairPassthroughLooseJson(raw),
    canonicalizeWebBridgeToolJson(repairPassthroughLooseJson(raw)),
    repairPassthroughLooseJson(canonicalizeWebBridgeToolJson(raw))
  ]
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch (_) { /* try next */ }
  }
  return null
}

function passthroughBodyKeysForTool(tool) {
  const preferred = ['code', 'command', 'content', 'contents', 'script', 'source', 'patch', 'input', 'text', 'prompt', 'query']
  const props = tool?.parameters?.properties && typeof tool.parameters.properties === 'object'
    ? Object.keys(tool.parameters.properties)
    : []
  const required = Array.isArray(tool?.parameters?.required) ? tool.parameters.required : []
  const ordered = [...required, ...props, ...preferred]
  const seen = new Set()
  return ordered.filter(key => {
    if (!key || seen.has(key)) return false
    seen.add(key)
    return preferred.includes(key) || /code|command|content|script|source|patch|text|input|prompt/i.test(key)
  })
}

function extractPassthroughBodyFences(text = '') {
  const value = String(text || '')
  const fences = []
  const fenceRe = /```([^\n]*)\n([\s\S]*?)```/g
  let match
  while ((match = fenceRe.exec(value))) {
    const info = String(match[1] || '').trim().toLowerCase()
    const body = String(match[2] || '').replace(/\s+$/g, '')
    if (!body.trim()) continue
    if (/"calls"\s*:\s*\[/.test(body)) continue
    if ((info === 'json' || info === 'javascript' || info === 'js') && /"name"\s*:/.test(body)) continue
    fences.push(body)
  }
  return fences
}

function attachPassthroughFenceBodies(calls = [], text = '', tools = []) {
  const fences = extractPassthroughBodyFences(text)
  if (!fences.length) return calls
  const toolMap = new Map(normalizePassthroughWebTools(tools).map(tool => [tool.name, tool]))
  let fenceIndex = 0
  return calls.map(call => {
    const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
      ? { ...call.arguments }
      : {}
    const keys = passthroughBodyKeysForTool(toolMap.get(call.name))
    const hasBody = keys.some(key => String(args[key] || '').trim().length >= 8)
    if (hasBody || fenceIndex >= fences.length) {
      return { ...call, arguments: args }
    }
    const key = keys[0] || 'code'
    if (args[key] == null || String(args[key]).trim().length < 8) {
      args[key] = fences[fenceIndex]
      fenceIndex += 1
    }
    return { ...call, arguments: args }
  })
}

function looksLikePassthroughRunCodeAttempt(text = '') {
  const value = String(text || '')
  return /(?:^|\n)\s*(?:run_code|调用\s*run_code)\s*[:：]/i.test(value)
    || /```(?:ts|tsx|typescript)\b/i.test(value)
    || /(?:await\s+)?tools\.\w+\s*\(/.test(value)
}

function looksLikePassthroughToolsSdkProgram(text = '') {
  return /(?:await\s+)?tools\.\w+\s*\(/.test(String(text || ''))
}

function clipPassthroughRunCodeDescription(text = '') {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return 'Run the requested TypeScript program'
  return value.length > 80 ? value.slice(0, 80).trim() : value
}

function extractPassthroughRunCodeDescription(text = '', fenceIndex = 0) {
  const before = String(text || '').slice(0, Math.max(0, fenceIndex))
  const header = /(?:^|\n)\s*(?:run_code|调用\s*run_code)\s*[:：]\s*(.+)\s*$/im.exec(before)
  if (header && String(header[1] || '').trim()) return clipPassthroughRunCodeDescription(header[1])
  const lines = before.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(/^[-*]\s+/, '')
    if (/^```/.test(line) || /"calls"\s*:/.test(line) || /LINGXI|tool_call/i.test(line)) continue
    if (/我们需要|正在思考|深度思考|The user wants|^I'll |^I will |^Let me /i.test(line)) continue
    if (line.length >= 4 && line.length <= 80) return clipPassthroughRunCodeDescription(line)
  }
  return 'Run the requested TypeScript program'
}

function stripPassthroughRunCodeChrome(code = '') {
  return String(code || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/^(?:Copy code|复制代码|Copy|复制|Download|下载)\s*\r?\n/gim, '')
    .replace(/^(?:ts|tsx|typescript|js|javascript|mjs|cjs)\s*\r?\n/i, '')
    .replace(/^\s+/g, '')
    .replace(/\s+$/g, '')
}

function looksLikePassthroughRunCodeProgram(text = '') {
  return /(await\s+tools\.|import\s+|export\s+|async\s+function\s+|console\.log\s*\(|\bconst\s+|\blet\s+|\bvar\s+)/.test(String(text || ''))
}

function isPassthroughRunCodeProseLine(line = '') {
  const value = String(line || '').trim()
  if (!value) return false
  if (/^(?:ts|tsx|typescript|js|javascript|mjs|cjs)$/i.test(value)) return false
  if (/^(?:Copy code|复制代码|Copy|复制|Download|下载)$/i.test(value)) return false
  if (/^```/.test(value)) return false
  return /[\u4e00-\u9fff]/.test(value)
    && !/[`{}()=<>]|await\s+|const\s+|let\s+|import\s+|export\s+|function\s+|console\./.test(value)
}

function isPassthroughRunCodeFence(info = '', body = '', { hasHeader = false, runCodeOnly = false } = {}) {
  const lang = String(info || '').split(/\s+/)[0].toLowerCase()
  if (lang === 'json' || lang === 'xml' || lang === 'html' || lang === 'css' || lang === 'md' || lang === 'markdown') return false
  const trimmed = stripPassthroughRunCodeChrome(body)
  if (trimmed.length < 12 || /"calls"\s*:\s*\[/.test(body)) return false
  const langOk = /^(ts|tsx|typescript|js|javascript|mjs|cjs)$/.test(lang)
  const looksProgram = looksLikePassthroughRunCodeProgram(trimmed)
  if (hasHeader && (langOk || !lang || looksProgram)) return true
  if (langOk && looksProgram) return true
  if (runCodeOnly && langOk) return true
  if (runCodeOnly && !lang && looksProgram) return true
  return false
}

function extractPassthroughCodeFences(text = '') {
  const value = String(text || '')
  const fences = []
  const fenceRe = /```([^\n]*)\r?\n([\s\S]*?)```/g
  let match
  while ((match = fenceRe.exec(value))) {
    fences.push({
      info: String(match[1] || '').trim(),
      body: String(match[2] || '').replace(/\s+$/g, ''),
      index: match.index
    })
  }
  if (!fences.length) {
    const open = /```([^\n]*)\r?\n([\s\S]+)$/.exec(value)
    if (open && String(open[2] || '').trim().length >= 12) {
      fences.push({
        info: String(open[1] || '').trim(),
        body: String(open[2] || '').replace(/\s+$/g, ''),
        index: open.index
      })
    }
  }
  return fences
}

function extractPassthroughUnfencedRunCode(text = '') {
  const value = String(text || '')
  const headerRe = /(?:^|\n)\s*(?:run_code|调用\s*run_code)\s*[:：][ \t]*(.*)/i
  const header = headerRe.exec(value)
  const after = header ? value.slice(header.index + header[0].length) : value
  const lines = after.split(/\r?\n/)
  const body = []
  let started = false
  let startOffset = header ? header.index + header[0].length : 0
  let scanned = 0
  for (const raw of lines) {
    const line = String(raw || '').replace(/\u00a0/g, ' ')
    const trimmed = line.trim()
    const lineWidth = String(raw || '').length + 1
    if (!started) {
      scanned += lineWidth
      if (!trimmed) continue
      if (/^```/.test(trimmed)) continue
      if (/^(?:ts|tsx|typescript|js|javascript|mjs|cjs)$/i.test(trimmed)) continue
      if (/^(?:Copy code|复制代码|Copy|复制|Download|下载)$/i.test(trimmed)) continue
      if (isPassthroughRunCodeProseLine(trimmed)) continue
      startOffset = (header ? header.index + header[0].length : 0) + scanned - lineWidth
    } else if (/^```/.test(trimmed) || isPassthroughRunCodeProseLine(trimmed)) {
      break
    }
    started = true
    body.push(line.replace(/\s+$/g, ''))
  }
  const code = stripPassthroughRunCodeChrome(body.join('\n'))
  if (code.length < 12 || !looksLikePassthroughRunCodeProgram(code)) return null
  if (!header && !looksLikePassthroughToolsSdkProgram(code)) return null
  const description = header
    ? clipPassthroughRunCodeDescription(header[1])
    : extractPassthroughRunCodeDescription(value, Math.max(0, startOffset))
  return { code, description }
}

function extractPassthroughRunCodeCalls(text = '', tools = []) {
  if (!hasPassthroughRunCodeTool(tools)) return []
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '')
  if (!value.trim() || looksLikeWebBridgeProtocolSafetyRefusal(value)) return []
  const hasHeader = /(?:^|\n)\s*(?:run_code|调用\s*run_code)\s*[:：]/i.test(value)
  const runCodeOnly = isPassthroughRunCodeOnly(tools)
  const fences = extractPassthroughCodeFences(value).filter(item => (
    isPassthroughRunCodeFence(item.info, item.body, { hasHeader, runCodeOnly })
  ))
  if (fences.length) {
    const chosen = fences[fences.length - 1]
    return [{
      name: 'run_code',
      arguments: {
        code: stripPassthroughRunCodeChrome(chosen.body),
        description: extractPassthroughRunCodeDescription(value, chosen.index)
      }
    }]
  }
  const unfenced = extractPassthroughUnfencedRunCode(value)
  if (!unfenced) return []
  return [{
    name: 'run_code',
    arguments: {
      code: unfenced.code,
      description: unfenced.description
    }
  }]
}

function materializePassthroughToolCalls(calls = [], allowed, maxCalls = 8) {
  const limit = Math.max(1, Number(maxCalls || 8))
  if (!Array.isArray(calls) || calls.length < 1) {
    throw Object.assign(new Error('网页模型返回的工具调用不是有效 JSON，已拒绝执行。'), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
  }
  if (calls.length > limit) {
    throw Object.assign(new Error(`网页模型返回的工具调用数量无效（允许 1-${limit} 个），已拒绝执行。`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
  }
  return calls.map((call, index) => {
    const name = String(call?.name || '').trim()
    if (!allowed.has(name)) {
      throw Object.assign(new Error(`网页模型请求了未授权工具“${name || '(空)'}”，已拒绝执行。`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
    }
    let args = call.arguments
    if (typeof args === 'string') {
      args = parsePassthroughJson(args)
      if (args == null) {
        throw Object.assign(new Error(`工具“${name}”的参数不是有效 JSON，已拒绝执行。`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw Object.assign(new Error(`工具“${name}”的参数必须是 JSON 对象，已拒绝执行。`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
    }
    const serialized = JSON.stringify(args)
    if (serialized.length > 400000) {
      throw Object.assign(new Error(`工具“${name}”的参数过大，已拒绝执行。`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
    }
    return {
      id: `call_${crypto.randomBytes(12).toString('hex')}`,
      type: 'function',
      function: { name, arguments: serialized },
      index
    }
  })
}

function parsePassthroughJsonCalls(answer = '', tools = [], extracted = '') {
  let payload = normalizeWebBridgeToolPayload(parsePassthroughJson(extracted))
  if (Array.isArray(payload)) payload = { calls: payload }
  else if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.tool_calls) && !Array.isArray(payload.calls)) {
      payload = {
        calls: payload.tool_calls.map(item => {
          const fn = item?.function || item || {}
          return {
            name: String(fn.name || item?.name || ''),
            arguments: fn.arguments != null ? fn.arguments : (item?.arguments != null ? item.arguments : {})
          }
        })
      }
    } else if (!Array.isArray(payload.calls) && payload.name) {
      payload = { calls: [payload] }
    }
  }
  if (!payload || !Array.isArray(payload.calls) || payload.calls.length < 1) {
    throw Object.assign(new Error('网页模型返回的工具调用不是有效 JSON，已拒绝执行。'), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
  }
  payload.calls = attachPassthroughFenceBodies(payload.calls, answer, tools)
  return payload.calls
}

function parsePassthroughWebToolCalls(answer = '', tools = [], { maxCalls = 8 } = {}) {
  const original = String(answer || '')
  const allowed = new Set(normalizePassthroughWebTools(tools).map(tool => tool.name))
  if (!allowed.size || looksLikeWebBridgeProtocolSafetyRefusal(original)) return []
  const extracted = extractPassthroughToolJsonSlice(original) || extractWebBridgeToolJsonSlice(original)
  let jsonError = null
  if (extracted) {
    try {
      return materializePassthroughToolCalls(parsePassthroughJsonCalls(original, tools, extracted), allowed, maxCalls)
    } catch (error) {
      jsonError = error
      if (!hasPassthroughRunCodeTool(tools)) throw error
    }
  }
  const runCodeCalls = extractPassthroughRunCodeCalls(original, tools)
  if (runCodeCalls.length) {
    return materializePassthroughToolCalls(runCodeCalls, allowed, maxCalls)
  }
  if (jsonError) throw jsonError
  if (hasPassthroughRunCodeTool(tools) && looksLikePassthroughRunCodeAttempt(original)) {
    throw Object.assign(new Error('网页模型返回的 run_code 程序不完整，已拒绝执行。'), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
  }
  return []
}

function getResumePromptMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : []
  let lastUser = -1
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === 'user') {
      lastUser = index
      break
    }
  }
  const slice = lastUser < 0 ? list.slice(-6) : list.slice(lastUser)
  const last = slice[slice.length - 1]
  if (last?.role === 'tool') {
    let start = slice.length - 1
    while (start > 0 && slice[start - 1]?.role === 'tool') start -= 1
    if (start > 0) return slice.slice(start)
  }
  return slice
}

const MAX_SAVED_CONVERSATIONS = 40

function normalizeSavedConversations(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
  const next = {}
  for (const [key, value] of Object.entries(saved)) {
    if (!key) continue
    const url = typeof value === 'string' ? value.trim() : String(value?.url || '').trim()
    if (!url) continue
    next[key] = {
      url,
      projectId: typeof value === 'object' ? String(value.projectId || '') : '',
      lane: typeof value === 'object' ? String(value.lane || 'lingxi') : 'lingxi',
      updatedAt: typeof value === 'object' ? Number(value.updatedAt || 0) : 0
    }
  }
  return next
}

function getSavedConversationUrl(conversations, sessionKey, projectId = '', lane = '') {
  const map = normalizeSavedConversations(conversations)
  const bySession = map[sessionKey]
  if (bySession?.url) return bySession.url
  const pid = String(projectId || '')
  const wantLane = String(lane || 'lingxi')
  if (!pid) return ''
  return Object.values(map)
    .filter(item => item.projectId === pid && item.url && String(item.lane || 'lingxi') === wantLane)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0]?.url || ''
}

function rememberSavedConversation(conversations, sessionKey, url, projectId = '', lane = '') {
  const map = normalizeSavedConversations(conversations)
  if (!sessionKey || !url) return map
  map[sessionKey] = {
    url: String(url),
    projectId: String(projectId || ''),
    lane: String(lane || 'lingxi'),
    updatedAt: Date.now()
  }
  const entries = Object.entries(map).sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0))
  while (entries.length > MAX_SAVED_CONVERSATIONS) {
    const [oldKey] = entries.shift()
    delete map[oldKey]
  }
  return map
}

function forgetSavedConversation(conversations, { sessionKey = '', url = '' } = {}) {
  const map = normalizeSavedConversations(conversations)
  const wantKey = String(sessionKey || '').trim()
  const wantUrl = String(url || '').trim()
  if (!wantKey && !wantUrl) return map
  for (const [key, value] of Object.entries(map)) {
    if ((wantKey && key === wantKey) || (wantUrl && String(value?.url || '') === wantUrl)) {
      delete map[key]
    }
  }
  return map
}

function looksLikeMissingWebConversation(text = '') {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return false
  return /无法加载此对话|对话不存在或已被删除|对话不存在|已被删除|This conversation (?:does not exist|has been deleted|is unavailable)|Unable to load this conversation|Conversation (?:not found|deleted|no longer available)|chat (?:not found|deleted|no longer exists)/i.test(value)
}

async function readWebPageVisibleText(page, maxChars = 4000) {
  if (!page || page.isClosed?.()) return ''
  return page.evaluate((limit) => {
    const text = String(document.body?.innerText || document.body?.textContent || '')
    return text.replace(/\s+/g, ' ').trim().slice(0, Number(limit) || 4000)
  }, maxChars).catch(() => '')
}

async function pageLooksLikeMissingWebConversation(page) {
  return looksLikeMissingWebConversation(await readWebPageVisibleText(page))
}

function getLatestWebUserText(messages = []) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === 'user') return String(list[index].content || '')
  }
  return ''
}

function extractLatestUserFromTranscript(transcript = '') {
  const text = String(transcript || '')
  const blocks = [...text.matchAll(/--- 用户 \d+ ---\n([\s\S]*?)(?=\n--- |\s*$)/g)]
  if (blocks.length) return blocks[blocks.length - 1][1]
  return text
}

const WEB_BRIDGE_DUMPED_PROMPT_RE = /用户只是打招呼|这是闲聊[。.]|--- 用户 \d+ ---|--- 系统要求|--- 助手 \d+ ---|--- 灵犀工具结果|【内部工作流指令】|本地客户端会解析你回复里的标签|不要提工具、协议或项目文件|先根据用户需求写第一段阶段性说明|现在只写阶段性说明|现在(?:写|输出)这一轮的阶段性说明|写阶段性说明并调用 complete_step|已满 \d+ 个调用|阶段性说明只写|complete_step 的 step_index|阶段性说明已经记下|必须用.{0,16}LINGXI_STAGE|必须用.{0,16}LINGXI_FINAL|两套暗号不要混用|不要复述(?:本段)?指令|可勾选计划|对照已经冻结|不要重写总目标|续写同一任务|不要输出\s*<LINGXI|已经能回答用户就直接写|按用户最后一条消息回答/

function extractTrailingWebBridgeToolCalls(text = '') {
  const matches = String(text || '').match(/<LINGXI_TOOL_CALLS>[\s\S]*?<\/LINGXI_TOOL_CALLS>/gi)
  return matches && matches.length ? String(matches[matches.length - 1] || '').trim() : ''
}

function looksLikeWebBridgeDumpedPrompt(text = '') {
  const value = decodeWebBridgeCipherEntities(text)
  if (!value) return false
  if (hasClosedWebBridgeFinalCipher(value)) return false
  if (extractTrailingWebBridgeToolCalls(value) && !WEB_BRIDGE_DUMPED_PROMPT_RE.test(value.replace(/<LINGXI_TOOL_CALLS>[\s\S]*?<\/LINGXI_TOOL_CALLS>/gi, ''))) {
    return false
  }
  if (WEB_BRIDGE_DUMPED_PROMPT_RE.test(value)) return true
  return (value.match(/--- (?:用户|助手|系统要求|灵犀工具结果) \d+ ---/g) || []).length >= 2
}

function stripWebBridgeDumpedPrompt(text = '') {
  const value = String(text || '')
  const trailingTools = extractTrailingWebBridgeToolCalls(value)
  if (!looksLikeWebBridgeDumpedPrompt(value)) return value.trim()
  const markers = [
    '不要提工具、协议或项目文件。',
    '纯闲聊才直接回答。',
    '这是闲聊。直接用自然语言回复用户，不要提工具、协议或项目文件。',
    '写完即止。',
    '不要复述本段指令。',
    '已经能按计划收尾就直接写给用户看。',
    '不要为了调用而调用。'
  ]
  let cut = -1
  for (const marker of markers) {
    const index = value.lastIndexOf(marker)
    if (index >= 0) cut = Math.max(cut, index + marker.length)
  }
  if (cut >= 0) {
    const tail = value.slice(cut).replace(/^\s+/, '')
    if (tail && !looksLikeWebBridgeDumpedPrompt(tail)) return tail.trim()
  }
  return trailingTools
}

function looksLikeWebBridgeCapturedUserQuestion(text = '') {
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
  if (!value || value.length > 180) return false
  if (looksLikeWebBridgeToolProtocol(value) || looksLikeWebBridgeDumpedPrompt(value)) return false
  if (/已(?:经)?(?:看|读|改|完成|核对)|根据.{0,16}(?:代码|测试|文件|实验)|下一步按/.test(value)) return false
  return /^(?:当前项目|这个项目|项目里).{0,48}(?:为什么|怎么会|如何|为啥)/.test(value)
    || (/[？?]$/.test(value) && /(?:当前项目|这个项目|首屏启动动画)/.test(value) && value.length < 80)
}

function sanitizeWebBridgeCapturedReply(text = '') {
  const value = decodeWebBridgeCipherEntities(text)
  if (!value.trim()) return ''
  const dumped = looksLikeWebBridgeDumpedPrompt(value)
  const working = dumped ? (stripWebBridgeDumpedPrompt(value) || '') : value
  if (!working.trim()) return ''
  if (hasClosedWebBridgeFinalCipher(working) || extractWebBridgeStageNote(working).found) return working.trim()
  const trailingTools = extractTrailingWebBridgeToolCalls(working)
  if (trailingTools) return (stripWebBridgeDumpedPrompt(working) || trailingTools || working).trim()
  const stripped = dumped ? working : stripWebBridgeDumpedPrompt(working)
  const candidate = stripped || (looksLikeWebBridgeDumpedPrompt(working) ? '' : working)
  if (!candidate) return ''
  if (looksLikeWebBridgeCapturedUserQuestion(candidate) && !looksLikeWebBridgeToolProtocol(candidate)) return ''
  return candidate.trim()
}

function slimWebBridgeChitchatTranscript(text = '') {
  let value = String(text || '')
  const cut = value.indexOf(RUNTIME_MARK)
  if (cut >= 0) value = value.slice(0, cut)
  return value.replace(/当前项目路径：\s*[^\n\r]+/g, '').replace(/\s+/g, ' ').trim()
}

function looksLikeWebBridgeChitchat(text = '') {
  let value = String(text || '')
  const cut = value.indexOf(RUNTIME_MARK)
  if (cut >= 0) value = value.slice(0, cut)
  value = value.replace(/当前项目路径：\s*[^\n\r]+/g, '').replace(/\s+/g, ' ').trim()
  if (!value || value.length > 24) return false
  if (/(?:改|修|实现|优化|升级|重写|删除|新建|创建|文件|代码|页面|样式|脚本|报错|bug)/i.test(value)) return false
  return /^(你好|您好|嗨|哈喽|在吗|在不在|在么|还在吗|你在吗|早上好|中午好|晚上好|晚安|早安|午安|你好吗|你还好吗|你好呀|你好啊|怎么样|最近好吗|忙吗|吃饭了吗|谢谢|thanks|thank you|hello|hi|hey|yo|how are you|what'?s up|sup)([！!？?。.~～\s]*)$/i.test(value)
}

function looksLikeWebBridgeDirectEditTask(text = '') {
  let value = String(text || '')
  const cut = value.indexOf(RUNTIME_MARK)
  if (cut >= 0) value = value.slice(0, cut)
  value = value.replace(/当前项目路径：\s*[^\n\r]+/g, '').replace(/\s+/g, ' ').trim()
  if (!value || looksLikeWebBridgeInspectQuestion(value)) return false
  if (/(?:先看|先了解|先别删|不要删|只看|只是看|先确认再|先别改)/.test(value)) return false
  if (/(?:删除|去掉|移除|卸载|清掉|删掉|废除|禁用|拿掉)/.test(value)) return true
  return /(?:新建|创建|写成|做成|做一下|做一个|做个|生成).{0,40}(?:文件|页面|网页|网站|html|css|js|个人(?:介绍|主页|站)|作品集|落地页)/i.test(value)
    || /(?:写|做|建).{0,12}(?:个人(?:介绍|主页|站)|作品集|落地页|电影感)/.test(value)
}

function looksLikeWebBridgeConfirmStall(text = '') {
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '')
  if (value.length < 20) return false
  if (/(?:已经(?:删|改|移除|去掉)|已删除|已移除|改完|删完)/.test(value)) return false
  return /(?:继续确认|最后核对|最终确认|删除前确认|下一步不再|先把.{0,24}摸清|再确认|依赖确认|逐一核清|反复排查|先确认哪些|确认这些|确认没有被|就可以直接移除|下一步会直接|下一步不再继续|做删除前|压到最核心)/.test(value)
}

function looksLikeWebBridgeReadOnlyToolName(name = '') {
  return /^(file_search|file_read|read_file|code_inspect|project_history)$/.test(String(name || '').trim())
}

function isWebBridgeReadOnlyToolBatch(toolCalls = []) {
  const list = Array.isArray(toolCalls) ? toolCalls : []
  if (!list.length) return false
  return list.every(item => looksLikeWebBridgeReadOnlyToolName(item?.name || item?.function?.name))
}

function shouldSkipWebBridgeStageForExecute({ userText = '', stageText = '', readOnlyBatches = 0 } = {}) {
  if (looksLikeWebBridgeConfirmStall(stageText)) return true
  return looksLikeWebBridgeDirectEditTask(userText) && Number(readOnlyBatches || 0) >= 1
}

function looksLikeWebBridgeInspectQuestion(text = '') {
  let value = String(text || '')
  const cut = value.indexOf(RUNTIME_MARK)
  if (cut >= 0) value = value.slice(0, cut)
  return looksLikeProjectInspectIntent(value)
}

function looksLikeWebBridgeAnsweredInspect(text = '') {
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  if (value.length < 40) return false
  if (looksLikeWebBridgeCapturedUserQuestion(value) || looksLikeWebBridgeDumpedPrompt(value)) return false
  if (/误写成|用错了路径|接下来需要|重新查看目录|之后才能/.test(value) && !/作品集|portfolio|首屏|hero/i.test(value)) return false
  const sourceFiles = (value.match(/\b[\w.-]+\.(html|htm|css|js|mjs|cjs|ts|tsx|jsx|vue|py|go|rs)\b/gi) || []).length
  const docOnly = /\b(readme(?:\.md)?|[\w.-]+\.md)\b/i.test(value) && sourceFiles === 0
  if (docOnly) return false
  if (sourceFiles >= 2) return true
  if (sourceFiles >= 1 && /当前状态|文件结构|主要文件|项目|入口|实现/.test(value)) return true
  return false
}

function looksLikeWebBridgeWaitingOrDone(text = '') {
  const value = String(text || '').replace(/\s+/g, '')
  return /暂不(?:调用|进行)(?:文件)?|没有新的文件(?:查看|修改|操作)|等待下一步|保持现有项目状态|可继续等待/.test(value)
}

function shouldPromoteWebBridgeTextToFinal({ userText = '', text = '', toolCalls = null } = {}) {
  if (Array.isArray(toolCalls) && webBridgeInspectNeedsMore(userText, toolCalls)) return false
  if (extractWebBridgeStageNote(text).found) return false
  if (looksLikeWebBridgeDumpedPrompt(text) || looksLikeWebBridgeCapturedUserQuestion(text)) return false
  if (looksLikeWebBridgeWaitingOrDone(text) && looksLikeWebBridgeAnsweredInspect(text)) return true
  return looksLikeWebBridgeInspectQuestion(userText) && looksLikeWebBridgeAnsweredInspect(text)
}

function looksLikeWebBridgeChitchatReply(text = '') {
  const value = String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
  if (!value || value.length > 280) return false
  if (looksLikeWebBridgeToolProtocol(value) || isWebBridgeNoToolsRefusal(value)) return false
  if (/[\\/][\w.-]+\.\w+|apply_patch|file_search|LINGXI_TOOL_CALLS/.test(value)) return false
  if (/(?:我先看|先读|再改|补丁|已经改|正在改)/.test(value)) return false
  return /^(你好|您好|嗨|哈喽|hello|hi|hey|我很好|i(?:['’]?m)? fine|在的|在呢|谢谢)/i.test(value)
    || /今天怎么样|有什么(?:我)?(?:可以)?帮|需要我做/.test(value)
    || (/(?:闲聊|先不(?:碰|改|动)文件|只是打招呼)/.test(value) && !/(?:写入|补丁|apply_patch)/.test(value))
}

function isWebBridgeStageTurn(messages = []) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null
  return /现在只写阶段性说明|现在(?:写|输出)这一轮的阶段性说明|写阶段性说明并调用 complete_step|已满 \d+ 个调用|阶段性说明只写|先用三到五句写计划|先用几句话说明这一轮|先根据用户需求写第一段阶段性说明/.test(String(last?.content || ''))
}

function isWebBridgeCompleteStepTurn(messages = []) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null
  return /阶段性说明已经记下|现在只调用 complete_step|继续执行当前计划步骤|先判断当前计划步骤/.test(String(last?.content || ''))
}

function isWebBridgeKeepGoingTurn(messages = []) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null
  return /只填写调用标签|立刻输出|继续同一任务|你不执行任何电脑操作|再写一个 json 代码块|json 代码块|继续用代码块给出完整新内容|用中文说明改了什么|不要再确认|下一句必须是(?:调用标签|改文件)|写阶段性计划|按已冻结的开场计划|未勾选|已确认的 confirm_plan/.test(String(last?.content || ''))
}

function isWebBridgeResumePromptMode(mode = '') {
  return mode === 'continuation' || mode === 'stage' || mode === 'complete_step'
}

function canSendWebChatPromptMessages(messages = [], mode = 'initial') {
  const list = Array.isArray(messages) ? messages : []
  if (!list.length) return false
  if (list.some(item => item?.role === 'user' || item?.role === 'developer')) return true
  if (list.some(item => item?.role === 'tool' || (Array.isArray(item?.toolCalls) && item.toolCalls.length > 0))) return true
  if (isWebBridgeResumePromptMode(mode)) return true
  return isWebBridgeStageTurn(list) || isWebBridgeCompleteStepTurn(list) || isWebBridgeKeepGoingTurn(list)
    || /【内部工作流指令】|执行控制指令/.test(String(list[list.length - 1]?.content || ''))
}

function hasWebBridgeSendableSourceMessage(messages = []) {
  return canSendWebChatPromptMessages(messages, 'initial')
}

function hasWebBridgeToolTail(messages = []) {
  return (Array.isArray(messages) ? messages : []).some(item => (
    item?.role === 'tool' || (Array.isArray(item?.toolCalls) && item.toolCalls.length > 0)
  ))
}

function takeTrailingWebBridgeToolMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : []
  let start = list.length
  while (start > 0 && list[start - 1]?.role === 'tool') start -= 1
  return start < list.length ? list.slice(start) : []
}

function slimWebBridgeResumeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length <= 1) return list
  const last = list[list.length - 1]
  if (isWebBridgeStageTurn([last]) || isWebBridgeCompleteStepTurn([last]) || isWebBridgeKeepGoingTurn([last])) {
    const tools = takeTrailingWebBridgeToolMessages(list.slice(0, -1))
    return tools.length ? [...tools, last] : [last]
  }
  if (last?.role === 'tool') {
    const toolsOnly = takeTrailingWebBridgeToolMessages(list)
    const lastUser = [...list].reverse().find(item => item?.role === 'user')
    if (lastUser && looksLikeWebBridgeInspectQuestion(lastUser.content) && toolsOnly[0] !== lastUser) {
      return [lastUser, ...toolsOnly]
    }
    return toolsOnly
  }
  if (last?.role === 'user' || last?.role === 'system') return [last]
  return list.length <= 2 ? list : list.slice(-2)
}

function resolveWebChatPromptPlan({ resumedThread = false, inputMessages = [], continuation = null } = {}) {
  const incoming = Array.isArray(inputMessages) ? inputMessages : []
  if (!resumedThread) {
    return { promptMode: 'initial', promptMessages: incoming }
  }
  const rawMessages = Array.isArray(continuation) && continuation.length > 0
    ? continuation
    : getResumePromptMessages(incoming)
  if (isWebBridgeStageTurn(rawMessages)) {
    return { promptMode: 'stage', promptMessages: slimWebBridgeResumeMessages(rawMessages) }
  }
  if (isWebBridgeCompleteStepTurn(rawMessages)) {
    return { promptMode: 'complete_step', promptMessages: slimWebBridgeResumeMessages(rawMessages) }
  }
  if (isWebBridgeKeepGoingTurn(rawMessages)) {
    return { promptMode: 'continuation', promptMessages: slimWebBridgeResumeMessages(rawMessages) }
  }
  if (/【内部工作流指令】|执行控制指令/.test(String(rawMessages[rawMessages.length - 1]?.content || ''))) {
    return { promptMode: 'continuation', promptMessages: slimWebBridgeResumeMessages(rawMessages) }
  }
  if (!hasWebBridgeToolTail(rawMessages)) {
    return { promptMode: 'initial', promptMessages: slimWebBridgeResumeMessages(rawMessages) }
  }
  return { promptMode: 'continuation', promptMessages: slimWebBridgeResumeMessages(rawMessages) }
}

function compactWebToolCallArgs(name, argumentsStr) {
  const text = String(argumentsStr || '')
  if (text.length <= TOOL_CALL_KEEP) return text
  try {
    const parsed = JSON.parse(text)
    const pathVal = parsed.path || parsed.cwd || ''
    const pathBit = pathVal ? `\npath: ${String(pathVal).replace(/\\/g, '/')}` : ''
    return `${compactLongText(text, TOOL_CALL_KEEP)}${pathBit}`
  } catch {
    return compactLongText(text, TOOL_CALL_KEEP)
  }
}

const WEB_INSPECT_TOOL_NAMES = new Set(['file_search', 'file_read', 'code_inspect', 'read_file', 'confirm_plan', 'complete_step', 'enter_plan_mode'])

function slimWebInspectTools(tools = []) {
  const list = Array.isArray(tools) ? tools : []
  const slim = list.filter(tool => {
    const name = String(tool?.name || tool?.function?.name || '')
    return WEB_INSPECT_TOOL_NAMES.has(name)
  })
  return slim.length ? slim : list
}

const WEB_TRANSCRIPT_ROLE_LABELS = {
  system: '系统要求',
  developer: '开发者要求',
  user: '用户',
  assistant: '助手',
  tool: '灵犀工具结果'
}

function formatLingxiWebChatTranscript(messages = [], options = {}) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => {
    const details = []
    const compacted = compactWebTranscriptContent(message.role, message.content, options)
    if (compacted) details.push(compacted)
    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        details.push(`[工具调用 call_id=${call.id} name=${call.name}]\n${compactWebToolCallArgs(call.name, call.arguments)}`)
      }
    }
    if (message.role === 'tool' && message.callId) {
      details.unshift(`[对应 call_id=${message.callId}${message.name ? ` name=${message.name}` : ''}]`)
    }
    if (!details.length) return ''
    return `--- ${WEB_TRANSCRIPT_ROLE_LABELS[message.role] || message.role} ${index + 1} ---\n${details.join('\n')}`
  }).filter(Boolean).join('\n\n')
}

function hasWebTool(tools = [], name = '') {
  return (tools || []).some(tool => String(tool?.name || tool?.function?.name || '').trim() === name)
}

function buildWebMusicProtocolLine(tools = []) {
  if (!hasWebTool(tools, 'generate_music')) return ''
  return '生成音乐时调用 generate_music：lyrics 用 [Intro]/[Verse]/[Chorus]/[Bridge]/[Outro] 分段，最多 3500 字；prompt 填风格最多 2000 字；title 歌曲名；n 一次几首。纯音乐设 is_instrumental=true，不要填歌词。不要自己去任何音乐网站点按钮。'
}

function formatCompactWebToolList(tools = []) {
  return tools.map(tool => {
    const name = tool.name || tool.function?.name
    const parameters = tool.parameters || tool.function?.parameters || {}
    const required = Array.isArray(parameters.required) ? parameters.required.filter(Boolean) : []
    const props = parameters.properties && typeof parameters.properties === 'object'
      ? Object.keys(parameters.properties).slice(0, 6)
      : []
    const keys = (required.length ? required : props).join(', ')
    const hint = WEB_TOOL_HINTS[name] || String(tool.description || tool.function?.description || '').replace(/\s+/g, ' ').slice(0, 36)
    return `- ${name}(${keys}): ${hint}`
  }).join('\n')
}

function buildWebToolExampleCalls(projectPath = '') {
  const examplePath = slashWebProjectPath(projectPath)
  if (!examplePath) {
    return `${TOOL_CALL_OPEN}{"calls":[{"name":"file_search","arguments":{"action":"directory","recursive":false}}]}${TOOL_CALL_CLOSE}`
  }
  return `${TOOL_CALL_OPEN}{"calls":[{"name":"file_search","arguments":{"action":"directory","path":"${examplePath}","recursive":false}}]}${TOOL_CALL_CLOSE}`
}

function buildWebToolProtocol(tools = [], { maxToolCalls = 8, reminder = false, chitchat = false, stage = false, opening = false, inspect = false, dialect = '', projectPath = '' } = {}) {
  const jsonFence = isWebJsonFenceDialect(dialect)
  const pasteFiles = isWebPasteFilesDialect(dialect)
  if (chitchat) {
    return '这是闲聊。直接用自然语言回复用户，不要提工具、协议或项目文件。'
  }
  if (opening) {
    return buildWebBridgeStageReplyPrompt({ opening: true, dialect })
  }
  if (inspect) {
    if (reminder) {
      if (pasteFiles) return '上面是工具结果。如果还只看到 README/Markdown 或目录名，继续读入口和实现代码；已经根据源码能介绍项目再写给用户看。不要把文档当实现，不要再发完整文件，不要重写总目标。'
      if (jsonFence) {
        return [
          '上面是工具结果。已经有文件列表时禁止再次 file_search，尤其禁止 query **/* 或 recursive:true。',
          'package.json、README、Markdown 和目录名都不是实现。还没读到入口和真实源码（js/ts/html 等）时，必须继续写 json 代码块 file_read。',
          '用户要求深入查看时，至少读 2 个实现文件后再总结。不要把配置文件或文档复述当结论。',
          '只有根据真实源码能说明项目时，才把最终回答包在 <LINGXI_FINAL> 里。'
        ].join('')
      }
      return '上面是工具结果。对照用户已确认的 confirm_plan：已经有文件列表时禁止再次 file_search，尤其禁止 **/*。package.json、README、Markdown 和目录名都不是实现。还没读到入口和真实源码时，继续 file_read。用户要求深入查看时至少读 2 个实现文件。已经根据源码能按计划回答再写给用户看。不要把文档当实现。' + buildWebBridgePlanProgressRule() + '不要对同一路径重复搜索，不要重写总目标。'
    }
    const inspectTools = slimWebInspectTools(tools)
    const names = inspectTools.map(tool => tool.name || tool.function?.name).filter(Boolean).join('、') || 'file_search、file_read'
    if (pasteFiles) {
      return '这是查看项目内容。先看目录找到入口，再读实际代码。README/Markdown 只是线索，不能当结论。不用改文件。'
    }
    if (jsonFence) {
      return [
        '这是查看项目内容。先看目录找到入口，再读实际代码。README/Markdown 只是线索，不能当结论。',
        `需要看文件时只写 json 代码块，可用：${names}。看目录用 action=directory，禁止 query **/*。`,
        '```json',
        `{"calls":[{"name":"file_search","arguments":{"action":"directory"${slashWebProjectPath(projectPath) ? `,"path":"${slashWebProjectPath(projectPath)}"` : ''},"recursive":false}}]}`,
        '```',
        '路径必须用当前项目路径，禁止 E:/demo。只看过目录、README 或 package.json 不要总结。用户要求深入查看时至少读 2 个实现文件。只有根据真实源码能说明项目，才把最终回答包在 <LINGXI_FINAL> 里。阶段性说明用 <LINGXI_STAGE>，不要和最终暗号混用。'
      ].join('\n')
    }
    return [
      '这是查看项目内容。先按用户已确认的 confirm_plan 看目录找到入口，再 file_read 实际代码。README/Markdown 只是线索，不能当结论。',
      `需要看文件时只可用 ${names}。看目录用 file_search。只做计划里当前未完成步骤。${buildWebBridgePlanProgressRule()}不要对同一路径重复搜索。`,
      '调用示例：',
      buildWebToolExampleCalls(projectPath),
      '路径必须用当前项目路径，禁止 E:/demo。已经根据源码能按计划回答再写给用户看；只看过文档不要总结。不要输出整套工具清单，不要重写总目标。'
    ].join('\n')
  }
  if (stage) {
    return buildWebBridgeStageReplyPrompt({ opening: false, dialect })
  }
  if (!tools.length) {
    if (pasteFiles) return '直接用中文回答用户即可。'
    return jsonFence
      ? '直接回答用户即可。'
      : `本次没有可用工具。直接回答用户。不要输出 ${TOOL_CALL_OPEN}。`
  }
  if (reminder) {
    const names = tools.map(tool => tool.name).filter(Boolean).join(', ')
    if (pasteFiles) {
      return [
        '上面是刚处理完的结果。',
        '若还要改文件，直接给出修改后的完整内容，用代码块包住，代码块开头写上路径。',
        '需要用户再选时写成“请用户选择”，不要把选择题当最终回答。',
        '若已经改完，用中文说明改了什么，不要再发代码。'
      ].join('\n')
    }
    if (jsonFence) {
      return [
        '编辑器已经把上次请求的结果贴在上面。',
        `若还要看或改文件，再写一个 json 代码块，字段是 calls。本轮可用：${names || 'file_read, file_search, file_manage'}。一次最多 ${maxToolCalls || 4} 条。`,
        '禁止再次 file_search 同一路径，尤其禁止 query **/*。',
        '需要用户选择时 name 用 ask_user_choice，确认计划用 confirm_plan。',
        '改完项目可 record_ai_operation_memo。查旧备忘录用 project_history action=search_memos/read_memo。',
        buildWebMusicProtocolLine(tools),
        '若工具结果含 HTML 结构错误、blocking 或 requires_fix，必须先修复，禁止输出 <LINGXI_FINAL>。',
        '若还只看到目录、README 或 package.json，必须再写 json 代码块 file_read 入口和源码，禁止输出 <LINGXI_FINAL>。',
        '只有根据真实源码已经能回答时，才把最终回答包在 <LINGXI_FINAL> 里，不要再写 json 代码块。阶段性说明只用 <LINGXI_STAGE>，两套暗号不要混用。'
      ].join('\n')
    }
    return [
      '同一件事继续，不要重读整段历史。',
      '按用户已确认的 confirm_plan 继续当前未完成步骤。不要重写计划或总目标，不要对同一路径重复搜索。',
      '如果已经能按计划回答用户的问题，把最终回答整段包在 <LINGXI_FINAL> 与 </LINGXI_FINAL> 里，不要用 <LINGXI_STAGE>，不要再调工具，不要写“等待下一步”。',
      buildWebBridgePlanProgressRule(),
      `还要看或改文件时，只填写调用标签，本地客户端负责解析。本轮可用：${names || 'file_read, file_search, file_manage'}。看目录用 file_search；新建目录用 file_manage，action 为 create_directory。这一批最多 ${maxToolCalls || 4} 个。`,
      '需要用户做选择时调用 ask_user_choice，确认执行计划用 confirm_plan，不要把选择题或确认写进最终说明。',
      '改完项目可 record_ai_operation_memo。查旧备忘录用 project_history action=search_memos/read_memo。',
      buildWebMusicProtocolLine(tools),
      'write_file 字段是 content，新建和覆盖已有文件都可以。text_edit 可按行覆盖；apply_patch 缺 End Patch 也可以。',
      buildWebBridgeSourceQualityRule({ compact: true }),
      '不要讨论有没有工具。不要为了调用而调用。'
    ].join('\n')
  }
  if (pasteFiles) {
    return [
      '请按用户要求处理上面的项目文件。',
      '若要修改，直接给出修改后文件的完整内容，用代码块包住，代码块开头写上对应路径。',
      '路径用正斜杠。CSS 注释必须是 /* ... */。不用改文件时，直接用中文回答。',
      '需要用户选择时，不要把选择题当最终回答。写成：',
      '请用户选择',
      '问题：……',
      '- 方案名：做法、影响和取舍',
      '- 方案名：做法、影响和取舍',
      '用户选完后会把结果贴回来，再继续改文件。'
    ].join('\n')
  }
  if (jsonFence) {
    return [
      '这是桌面编辑器里的对话。需要看或改项目文件时，写一个 json 代码块，编辑器会据此读写文件并把结果贴回来。',
      formatCompactWebToolList(tools),
      '写法：',
      '```json',
      `{"calls":[{"name":"file_search","arguments":{"action":"directory"${slashWebProjectPath(projectPath) ? `,"path":"${slashWebProjectPath(projectPath)}"` : ''},"recursive":false}}]}`,
      '```',
      '路径用 /，必须用用户消息里的当前项目路径，禁止 E:/demo。write_file 的字段是 content，可以新建或覆盖。一次最多 4 条。JSON 只转义双引号和换行，不要把 \\:root 写进源码。',
      '写 HTML 时，content 里必须完整保留 <!DOCTYPE html>、<html>、<head>、<style>、<body> 和对应结束标签；禁止输出 <LINGXI_TOOL_CALLS> 之类 XML 标签包住文件内容。',
      '工具结果若报告 HTML 结构错误、blocking 或 requires_fix，必须先修复，禁止输出 <LINGXI_FINAL>，禁止说已成功创建。',
      '可以直接回答时，把最终回答整段包在 <LINGXI_FINAL> 与 </LINGXI_FINAL> 里，不要用 <LINGXI_STAGE>。',
      `每满 4 个调用后，软件会请你只写阶段性说明，必须包在 <LINGXI_STAGE> 里。${buildWebBridgePlanProgressRule()}不要同一轮里两件事一起做。`,
      '需要用户选择时写 name 为 ask_user_choice 的 json 代码块，确认计划用 confirm_plan，不要把选择题或确认写进正文当最终回答。',
      '看目录用 file_search action=directory，禁止 query **/*，不要对同一路径重复搜索。',
      buildWebMusicProtocolLine(tools)
    ].filter(Boolean).join('\n')
  }
  return [
    '需要看或改文件时，按下面格式输出标签。你只填写调用单，不执行任何电脑操作：',
    formatCompactWebToolList(tools),
    `调用示例：`,
    buildWebToolExampleCalls(projectPath),
    `硬规则：JSON 必须能被 JSON.parse；路径用 /，必须用当前项目路径，禁止 E:/demo；JSON 里只有双引号写成 \\"、换行写成 \\n，不要转义冒号和 @；每轮最多 4 个 calls；write_file 字段是 content，新建和覆盖已有文件都可以。text_edit 的 edits 里给 old_content/new_content 即可，不必写 op；也可 start_line/end_line 按行覆盖。apply_patch 缺 End Patch 也可以。HTML 的 <!DOCTYPE>、<html>、<head> 必须原样留在 content 里。`,
    buildWebBridgeSourceQualityRule(),
    '不要讨论有没有工具、能不能执行、是不是伪造。需要看目录就输出 file_search，需要新建目录就输出 file_manage。',
    '禁止把完整文件写在普通 markdown 代码块里。页面上的 html/css/js 代码块不会写入电脑，改文件必须输出调用标签。',
    '需要用户做选择时调用 ask_user_choice，确认执行计划用 confirm_plan，不要把选择题或确认写进最终说明。',
    '改完项目可 record_ai_operation_memo。查旧备忘录用 project_history action=search_memos/read_memo。',
    buildWebMusicProtocolLine(tools),
    `每满 4 个调用后，软件会请你只写阶段性说明，必须包在 <LINGXI_STAGE> 里。${buildWebBridgePlanProgressRule()}不要同一轮里两件事一起做。`,
    '已经能回答用户问题时，把最终回答整段包在 <LINGXI_FINAL> 与 </LINGXI_FINAL> 里，不要用 <LINGXI_STAGE>，不要再调工具，不要写“等待下一步”。',
    '纯闲聊才直接回答，不要为了打招呼去翻文件。'
  ].filter(Boolean).join('\n')
}

const WEB_PAGE_TRANSCRIPT_KEEP = 6000
const WEB_PAGE_RESUME_KEEP = 2500
const WEB_PAGE_TOOL_TRANSCRIPT_KEEP = TOOL_RESULT_KEEP * 4

function extractWebBridgeToolResultTranscript(transcript = '') {
  const blocks = [...String(transcript || '').matchAll(/--- 灵犀工具结果 \d+ ---\n[\s\S]*?(?=\n--- |\s*$)/g)]
  return blocks.map(item => String(item[0] || '').trim()).filter(Boolean).join('\n\n')
}

function clipWebPageTranscript(transcript = '', mode = 'initial') {
  const text = String(transcript || '')
  if (/--- 灵犀工具结果 \d+ ---/.test(text)) return compactLongText(text, WEB_PAGE_TOOL_TRANSCRIPT_KEEP)
  const keep = isWebBridgeResumePromptMode(mode) ? WEB_PAGE_RESUME_KEEP : WEB_PAGE_TRANSCRIPT_KEEP
  return compactLongText(text, keep)
}

function buildWebBridgeFollowupPagePrompt(instruction, transcript = '', mode = 'continuation') {
  const toolsText = extractWebBridgeToolResultTranscript(transcript)
  if (!toolsText) return instruction
  return [clipWebPageTranscript(toolsText, mode), instruction].filter(Boolean).join('\n\n')
}

function assembleWebPagePrompt({ mode = 'initial', transcript = '', tools = [], maxToolCalls = 8, dialect = '', projectPath = '' } = {}) {
  const jsonFence = isWebJsonFenceDialect(dialect)
  const pasteFiles = isWebPasteFilesDialect(dialect)
  const latestUser = extractLatestUserFromTranscript(transcript)
  const chitchat = !isWebBridgeResumePromptMode(mode) && looksLikeWebBridgeChitchat(latestUser)
  if (chitchat) return slimWebBridgeChitchatTranscript(latestUser) || '你好'
  if (mode === 'stage') {
    return buildWebBridgeFollowupPagePrompt(
      buildWebToolProtocol(tools, { stage: true, dialect, projectPath: slashWebProjectPath(projectPath) }),
      transcript,
      'stage'
    )
  }
  if (mode === 'complete_step') {
    return buildWebBridgeFollowupPagePrompt(
      buildWebBridgeCompleteStepPrompt({ dialect }),
      transcript,
      'complete_step'
    )
  }
  const inspect = looksLikeWebBridgeInspectQuestion(latestUser)
  const directEdit = looksLikeWebBridgeDirectEditTask(latestUser)
  const openingFirst = (mode === 'initial' || mode === 'opening') && Array.isArray(tools) && tools.length > 0 && !directEdit
  const resolvedPath = slashWebProjectPath(projectPath || extractWebBridgeProjectPath(transcript))
  transcript = clipWebPageTranscript(transcript, mode)
  const pathLine = resolvedPath && !String(transcript || '').includes('当前项目路径：')
    ? `当前项目路径：${resolvedPath}`
    : ''
  if (directEdit) {
    if (mode === 'continuation') {
      return [
        '不要再确认、排查或写下一步计划。下一句必须是创建/修改/删除的调用标签；已经改完就直接向用户交代结果。不要重复搜索同一批路径。',
        pathLine,
        transcript
      ].filter(Boolean).join('\n\n')
    }
    return [
      '这是明确的改文件任务。直接改或删、或创建已点名的内容，不要先写一长段计划当最终回复。',
      pathLine,
      transcript,
      buildWebToolProtocol(tools, {
        maxToolCalls,
        dialect,
        projectPath: resolvedPath
      })
    ].filter(Boolean).join('\n\n')
  }
  if (inspect && !openingFirst) {
    return [
      pathLine,
      transcript,
      buildWebToolProtocol(slimWebInspectTools(tools), {
        maxToolCalls,
        reminder: mode === 'continuation',
        inspect: true,
        dialect,
        projectPath: resolvedPath
      })
    ].filter(Boolean).join('\n\n')
  }
  const modeLine = openingFirst
        ? '先调用 confirm_plan，把待办步骤交给用户确认。不要用普通正文代替计划。确认后按步骤执行。阶段性说明不等于完成步骤，不要和 complete_step 写在同一轮。'
        : mode === 'continuation'
        ? (pasteFiles
          ? '同一件事继续。能答就直接用中文写给用户；还要改文件就直接给出修改后的完整内容，用代码块包住并写上路径。'
          : jsonFence
            ? '同一件事继续。若还只看到目录、README 或 package.json，必须再写 json 代码块 file_read 入口和源码。只有根据真实源码能回答才把最终回答包在 <LINGXI_FINAL> 里。禁止再次 file_search 同一路径或 **/*。不要为了调用而调用。'
            : '续写同一任务。已经能回答用户就把最终回答包在 <LINGXI_FINAL> 里；还要看或改文件才填写调用标签。不要为了调用而调用。')
        : mode === 'resync'
          ? (pasteFiles
            ? '以下方完整历史为准。需要改文件时用代码块给出修改后的完整内容，代码块开头写路径。'
            : jsonFence
              ? '以下方完整历史为准。需要项目文件时写 json 代码块。'
              : '以下方完整历史为准，忽略网页里更早的旧内容。需要看或改文件时直接输出标签。')
          : (pasteFiles
            ? '按用户最后一条消息处理。上面若贴了项目文件，直接给出修改后文件的完整内容，用代码块包住并写上路径；能直接答就直接答。'
            : jsonFence
              ? '按用户最后一条消息处理。需要项目文件时写 json 代码块；能直接答就直接答。'
              : '按用户最后一条消息回答。需要看或改文件时，直接输出调用标签；闲聊则直接说话。')
  return [
    modeLine,
    pathLine,
    transcript,
    buildWebToolProtocol(tools, {
      maxToolCalls,
      reminder: mode === 'continuation',
      chitchat,
      opening: openingFirst,
      dialect,
      projectPath: resolvedPath
    })
  ].filter(Boolean).join('\n\n')
}

function buildWebToolProtocolRetryPrompt(errorMessage = '', options = {}) {
  if (options.passthrough) {
    if (hasPassthroughRunCodeTool(options.tools)) {
      return [
        '刚才那段没法当成 run_code 执行。请不要把程序写进 json 字符串。改成：',
        'run_code: 五到十字说明这段程序做什么',
        '```ts',
        '这里写 TypeScript 函数体，可顶层 await，用 await tools.xxx(...)',
        '```',
        '能直接回答就用普通文字。不要写 LINGXI 标签。'
      ].join('\n')
    }
    return [
      '刚才那段没法解析。请改成：json 代码块只写工具名和短参数；长代码放在后面的普通代码块里，不要塞进 json 字符串。',
      '```json',
      '{"calls":[{"name":"ToolName","arguments":{"description":"做什么"}}]}',
      '```',
      '```',
      '长内容放这里',
      '```',
      '名称必须是本次可用工具之一。能直接回答就用普通文字。'
    ].join('\n')
  }
  if (options.fileFence) {
    const examplePath = slashWebProjectPath(options.projectPath) || '当前项目路径/index.html'
    if (isWebJsonFenceDialect(options.dialect)) {
      return [
        '刚才那段普通代码块不会写入电脑。不要再用 html/css/js 代码块交文件。',
        '立刻只输出一个 json 代码块，例如：',
        '```json',
        `{"calls":[{"name":"write_file","arguments":{"path":"${examplePath}","content":"完整文件内容"}}]}`,
        '```',
        '可以一次写多个文件。禁止解释，禁止再输出普通代码块，禁止 <LINGXI_TOOL_CALLS>。'
      ].join('\n')
    }
    return [
      '刚才那段普通代码块不会写入电脑。不要再用 html/css/js 代码块交文件。',
      '立刻只输出调用标签，例如：',
      `${TOOL_CALL_OPEN}{"calls":[{"name":"write_file","arguments":{"path":"${examplePath}","content":"完整文件内容"}}]}${TOOL_CALL_CLOSE}`,
      '可以一次写多个文件。禁止解释，禁止再输出普通代码块。'
    ].join('\n')
  }
  if (isWebPasteFilesDialect(options.dialect)) {
    return '请把要改的文件给出修改后的完整内容，用代码块包住，代码块开头写上路径。不用改就直接用中文说明。'
  }
  if (isWebJsonFenceDialect(options.dialect)) {
    return [
      '刚才那段 json 没法解析。请只再发一个 json 代码块，例如：',
      '```json',
      `{"calls":[{"name":"file_read","arguments":{"path":"${slashWebProjectPath(options.projectPath) || '当前项目路径'}/index.html"}}]}`,
      '```'
    ].join('\n')
  }
  const exampleName = collectWebBridgeToolNames(options.tools).includes('file_read')
    ? 'file_read'
    : (collectWebBridgeToolNames(options.tools)[0] || 'file_search')
  const examplePath = slashWebProjectPath(options.projectPath) || '当前项目路径/index.html'
  return [
    '格式无效，未执行任何操作。',
    String(errorMessage || 'JSON 无法解析').slice(0, 200),
    '立刻只输出真实工具名，例如：',
    `${TOOL_CALL_OPEN}{"calls":[{"name":"${exampleName}","arguments":{"path":"${examplePath}"}}]}${TOOL_CALL_CLOSE}`,
    '禁止把“工具名”三个字填进 name。路径用 /。write_file 字段是 content，可以覆盖已有文件。'
  ].join('\n')
}

function assertWebToolArguments(name, args) {
  const payload = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const missing = []
  if (name === 'write_file') {
    if (!payload.path) missing.push('path')
    if (payload.content == null) missing.push('content')
    if (!missing.length) assertWebBridgeHtmlDocument(payload.path, payload.content)
  } else if (name === 'apply_patch') {
    if (!payload.patch) missing.push('patch')
  } else if (name === 'text_edit') {
    if (!payload.path) missing.push('path')
    const hasEdits = Array.isArray(payload.edits)
      ? payload.edits.length >= 1
      : !!(payload.edits && typeof payload.edits === 'object')
    const hasReplace = payload.old_content != null && payload.new_content != null
    const hasContent = payload.content != null || payload.contents != null
    const hasLineReplace = payload.start_line != null || payload.startLine != null
    if (!hasEdits && !hasReplace && !hasContent && !hasLineReplace) missing.push('edits')
  } else if (name === 'edit_file') {
    if (!payload.path) missing.push('path')
    if (payload.old_content == null) missing.push('old_content')
    if (payload.new_content == null) missing.push('new_content')
    if (!missing.length) assertWebBridgeHtmlDocument(payload.path, payload.new_content)
  } else if (name === 'json_edit') {
    if (!payload.path) missing.push('path')
    if (!Array.isArray(payload.operations) || payload.operations.length < 1) missing.push('operations')
  } else if (name === 'file_manage') {
    const action = String(payload.action || '')
    if (!action) missing.push('action')
    if ((action === 'create_directory' || action === 'delete') && !payload.path) missing.push('path')
    if ((action === 'copy' || action === 'move') && !payload.source) missing.push('source')
    if ((action === 'copy' || action === 'move') && !payload.destination) missing.push('destination')
  } else if (name === 'ask_user_choice') {
    if (!String(payload.question || '').trim()) missing.push('question')
    if (!Array.isArray(payload.options) || payload.options.length < 2) missing.push('options')
  } else if (name === 'enter_plan_mode') {
    if (!String(payload.reason || '').trim()) missing.push('reason')
  } else if (name === 'confirm_plan') {
    if (!Array.isArray(payload.plan) || payload.plan.length < 1) missing.push('plan')
  } else if (name === 'complete_step') {
    if (!Array.isArray(payload.steps) || payload.steps.length < 1) missing.push('steps')
    if (payload.step_index == null && payload.stepIndex == null) missing.push('step_index')
    if (!String(payload.status || '').trim()) missing.push('status')
  } else if (name === 'record_ai_operation_memo') {
    if (!String(payload.title || '').trim()) missing.push('title')
    if (!String(payload.summary || '').trim()) missing.push('summary')
    if (!Array.isArray(payload.changes) || payload.changes.length < 1) missing.push('changes')
  } else if (name === 'project_history') {
    if (!String(payload.action || '').trim()) missing.push('action')
    const action = String(payload.action || '').trim()
    if ((action === 'search_memos' || action === 'recall') && !String(payload.query || '').trim()) missing.push('query')
    if (action === 'read_memo' && !String(payload.memo_id || payload.memoId || payload.id || '').trim()) missing.push('memo_id')
  } else if (name === 'shell_run') {
    const action = String(payload.action || 'run')
    if (action === 'run' && !payload.command) missing.push('command')
  } else if (name === 'generate_music') {
    const prompt = String(payload.prompt || payload.style || payload.description || '').trim()
    const instrumental = !!(payload.is_instrumental ?? payload.instrumental)
    const lyrics = String(payload.lyrics || payload.lyric || '').trim()
    if (!prompt) missing.push('prompt')
    if (!instrumental && !lyrics) missing.push('lyrics')
  }
  if (missing.length) {
    throw Object.assign(new Error(`工具“${name}”缺少必填字段：${missing.join(', ')}`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
  }
}

function normalizeWebToolPathArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const next = { ...args }
  for (const key of ['path', 'old_path', 'new_path', 'target', 'destination', 'source', 'cwd']) {
    if (typeof next[key] === 'string' && next[key].includes('\\')) {
      next[key] = next[key].replace(/\\/g, '/')
    }
  }
  return next
}

function unescapeWebJsonStringish(value) {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function buildWebBridgeSourceQualityRule({ compact = false } = {}) {
  if (compact) {
    return '源码必须是浏览器能直接解析的 CSS/HTML。JSON 只转义双引号和换行，不要转义冒号和 @。禁止 \\:root、\\@media、===== /。不要用 shell_run 洗转义，写完 file_read 核对源码。'
  }
  return [
    '源码质量：先读后改，最小正确改动；写完 file_read 看源码本身，不要根据 JSON 字符串判断文件。',
    'JSON 只转义双引号和换行；不要转义冒号、@、空格。:root、@media、:nth-child、/* */ 必须原样进文件。',
    '禁止 \\:root、\\@media、===== /。不要用 shell_run 或 sed 清洗转义，写错了直接 text_edit 改正文。'
  ].join('\n')
}

function sanitizeWebBridgeSourceText(text = '', filePath = '') {
  let next = String(text || '')
  if (!next) return next
  const ext = path.extname(String(filePath || '')).toLowerCase()
  const looksLeaked = /\\:root\b|\\@media\b|\\:nth-child\b|\\:hover\b|\/\*[^\n]*=====\s+\/(?!\*)/.test(next)
  const treatAsMarkup = looksLeaked || /\.(?:css|scss|less|html?|svg|js|mjs|cjs|jsx|ts|tsx|vue)$/i.test(ext)
  if (!treatAsMarkup) return next
  next = next.replace(/\\+:root\b/g, ':root')
  next = next.replace(/\\+@(media|keyframes|import|font-face|supports|charset|layer|scope)\b/gi, '@$1')
  next = next.replace(/\\+:(nth-child|nth-of-type|not|is|where|has|hover|focus|focus-visible|focus-within|active|visited|disabled|checked|first-child|last-child|first-of-type|last-of-type|before|after|root|empty|target)\b/g, ':$1')
  next = next.replace(/(\/\*[^\n]*=====)\s+\/(?!\*)/g, '$1 */')
  next = next.replace(/^(\s*\/\*(?![^*]*\*\/)[^\n]*?)\s+\/(\s*)$/gm, '$1 */$2')
  if (/\.(?:css|scss|less|html?|svg)$/i.test(ext) || !ext) {
    next = next.replace(/url\(\s*\\"/g, 'url("').replace(/\\"\s*\)/g, '")')
    next = next.replace(/=\\"/g, '="').replace(/\\"([ \t>])/g, '"$1')
  }
  return next
}

function sanitizeWebBridgePatch(patch = '') {
  return String(patch || '').split('\n').map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return `+${sanitizeWebBridgeSourceText(line.slice(1), '.css')}`
    }
    return line
  }).join('\n')
}

function findLooseWebJsonStringEnd(rest = '') {
  const text = String(rest || '')
  if (text.startsWith('"')) return 0
  const patterns = [
    /"\s*\}\s*\}\s*,\s*\{\s*"name"/,
    /"\s*\}\s*\}\s*\]\s*\}/,
    /"\s*\}\s*\}\s*\]/,
    /"\s*,\s*"(?:path|content|contents|patch|name|arguments|cwd|action|edits|old_content|new_content|command|start_line|end_line)"/,
    /"\s*\}\s*,\s*"/,
    /"\s*\}/
  ]
  let best = -1
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match && (best < 0 || match.index < best)) best = match.index
  }
  return best
}

function extractBalancedWebJsonSlice(text = '', start = 0) {
  const open = text[start]
  const close = open === '{' ? '}' : open === '[' ? ']' : ''
  if (!close) return ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return text.slice(start)
}

function extractWebToolArgumentsFromChunk(chunk = '') {
  const text = String(chunk || '')
  const args = {}
  for (const key of ['path', 'cwd', 'action', 'command', 'content', 'contents', 'patch', 'new_content', 'old_content', 'pattern', 'replacement', 'op']) {
    const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(text)
    if (!match) continue
    const rest = text.slice(match.index + match[0].length)
    const end = findLooseWebJsonStringEnd(rest)
    if (end < 0) continue
    const value = unescapeWebJsonStringish(rest.slice(0, end))
    args[key === 'contents' ? 'content' : key] = value
  }
  const startLine = /"start_line"\s*:\s*(\d+)/i.exec(text)
  const endLine = /"end_line"\s*:\s*(\d+)/i.exec(text)
  if (startLine) args.start_line = Number(startLine[1])
  if (endLine) args.end_line = Number(endLine[1])
  const editsKey = /"edits"\s*:\s*\[/.exec(text)
  if (editsKey) {
    const slice = extractBalancedWebJsonSlice(text, editsKey.index + editsKey[0].length - 1)
    try {
      args.edits = JSON.parse(slice)
    } catch (_) { /* 页面端 edits 里常有未转义引号，下面用 start_line 兜底 */ }
  }
  if ((!Array.isArray(args.edits) || !args.edits.length) && args.start_line != null) {
    args.edits = [{
      op: 'replace_lines',
      start_line: args.start_line,
      end_line: args.end_line ?? args.start_line,
      new_content: args.new_content ?? args.content ?? ''
    }]
  }
  if ((!Array.isArray(args.edits) || !args.edits.length) && args.pattern && (args.replacement != null || args.new_content != null)) {
    args.edits = [{
      op: 'replace_regex',
      pattern: args.pattern,
      new_content: args.replacement ?? args.new_content ?? '',
      replacement: args.replacement ?? args.new_content ?? ''
    }]
  }
  return Object.keys(args).length ? args : null
}

function tryExtractLingxiCallsLoose(raw = '') {
  const text = String(raw || '')
  if (!/"name"\s*:\s*"/.test(text) || !/"arguments"\s*:\s*\{/.test(text)) return null
  const starts = []
  const nameRe = /"name"\s*:\s*"([A-Za-z0-9_.:-]+)"/g
  let match
  while ((match = nameRe.exec(text))) {
    starts.push({ name: match[1], index: match.index })
  }
  if (!starts.length) return null
  const calls = []
  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i]
    const chunk = text.slice(current.index, i + 1 < starts.length ? starts[i + 1].index : text.length)
    if (!/"arguments"\s*:\s*\{/.test(chunk)) continue
    const args = extractWebToolArgumentsFromChunk(chunk)
    if (!args) continue
    calls.push({ name: current.name, arguments: args })
  }
  return calls.length ? { calls } : null
}

function sanitizeWebBridgeWriteArgs(name, args = {}) {
  const next = { ...args }
  const filePath = String(next.path || next.file_path || '')
  if (name === 'write_file' && typeof next.content === 'string') {
    next.content = sanitizeWebBridgeSourceText(next.content, filePath)
  }
  if (name === 'apply_patch' && typeof next.patch === 'string') {
    next.patch = sanitizeWebBridgePatch(next.patch)
  }
  if (name === 'edit_file') {
    if (typeof next.new_content === 'string') next.new_content = sanitizeWebBridgeSourceText(next.new_content, filePath)
    if (typeof next.new_string === 'string') next.new_string = sanitizeWebBridgeSourceText(next.new_string, filePath)
  }
  if (name === 'text_edit') {
    if (typeof next.new_content === 'string') next.new_content = sanitizeWebBridgeSourceText(next.new_content, filePath)
    if (Array.isArray(next.edits)) {
      next.edits = next.edits.map(edit => {
        if (!edit || typeof edit !== 'object') return edit
        const item = { ...edit }
        if (typeof item.new_content === 'string') item.new_content = sanitizeWebBridgeSourceText(item.new_content, filePath)
        if (typeof item.replacement === 'string') item.replacement = sanitizeWebBridgeSourceText(item.replacement, filePath)
        return item
      })
    }
  }
  return next
}

function normalizeWebAskUserChoiceArgs(args = {}) {
  const next = { ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) }
  if (!String(next.question || '').trim()) {
    for (const key of ['prompt', 'title', 'message', 'text', 'query', 'ask', 'content', 'header', 'q']) {
      if (String(next[key] || '').trim()) {
        next.question = String(next[key]).trim()
        break
      }
    }
  }
  if (!Array.isArray(next.options)) {
    for (const key of ['choices', 'items', 'answers', 'candidates', 'opts']) {
      if (Array.isArray(next[key])) {
        next.options = next[key]
        break
      }
    }
  }
  if (typeof next.options === 'string') {
    next.options = String(next.options)
      .split(/\r?\n/)
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
      .filter(Boolean)
  }
  if (Array.isArray(next.options)) {
    next.options = next.options.map((item, index) => {
      if (typeof item === 'string') {
        const label = item.trim()
        const desc = label.length >= 6 ? label : `${label}。请确认是否采用这个方案。`
        return { label, value: slugWebBridgeChoiceValue(label, index), desc }
      }
      if (!item || typeof item !== 'object') return item
      const label = String(item.label || item.name || item.title || item.text || '').trim()
      const value = String(item.value || item.id || item.key || slugWebBridgeChoiceValue(label, index)).trim()
      let desc = String(item.desc || item.description || item.detail || item.reason || '').trim()
      if (label && desc.length < 6) desc = desc ? `${desc}。请确认是否采用。` : `${label}。请确认是否采用这个方案。`
      return { ...item, label: label || item.label, value: value || item.value, desc: desc || item.desc }
    })
  }
  if (!String(next.question || '').trim() && Array.isArray(next.options) && next.options.length >= 2) {
    next.question = '请选择一个方案'
  }
  return next
}

function splitWebBridgePlanLines(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean)
  }
  if (typeof value !== 'string') return []
  return String(value)
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean)
}

function normalizeWebCompleteStepArgs(args = {}) {
  const next = { ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) }
  if (next.step_index == null && next.stepIndex != null) next.step_index = next.stepIndex
  if (next.total_steps == null && next.totalSteps != null) next.total_steps = next.totalSteps
  if (!Array.isArray(next.steps) || !next.steps.length) {
    const lines = splitWebBridgePlanLines(next.plan || next.items || next.todos)
    if (lines.length) next.steps = lines
  }
  if (Array.isArray(next.steps)) next.steps = next.steps.map(item => String(item || '').trim()).filter(Boolean)
  if (!String(next.status || '').trim()) next.status = 'completed'
  if (next.total_steps == null && Array.isArray(next.steps)) next.total_steps = next.steps.length
  return next
}

function normalizeWebConfirmPlanArgs(args = {}) {
  const next = { ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) }
  if (!Array.isArray(next.plan) || !next.plan.length) {
    for (const key of ['steps', 'items', 'todos', 'tasks', 'initial_plan']) {
      const lines = splitWebBridgePlanLines(next[key])
      if (lines.length) {
        next.plan = lines
        break
      }
    }
  }
  if (typeof next.plan === 'string') next.plan = splitWebBridgePlanLines(next.plan)
  if (Array.isArray(next.plan)) next.plan = next.plan.map(item => String(item || '').trim()).filter(Boolean)
  if (!String(next.summary || '').trim()) {
    for (const key of ['title', 'reason', 'description', 'desc']) {
      if (String(next[key] || '').trim()) {
        next.summary = String(next[key]).trim()
        break
      }
    }
  }
  return next
}

function normalizeWebEnterPlanArgs(args = {}) {
  const next = { ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) }
  if (!String(next.reason || '').trim()) {
    for (const key of ['title', 'summary', 'why', 'description']) {
      if (String(next[key] || '').trim()) {
        next.reason = String(next[key]).trim()
        break
      }
    }
  }
  if (!Array.isArray(next.initial_plan) || !next.initial_plan.length) {
    for (const key of ['plan', 'plans', 'steps', 'options']) {
      const lines = splitWebBridgePlanLines(next[key])
      if (lines.length) {
        next.initial_plan = lines
        break
      }
    }
  }
  return next
}

function normalizeWebMemoRecordArgs(args = {}) {
  const next = { ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) }
  if (!String(next.title || '').trim()) {
    for (const key of ['name', 'heading', 'topic']) {
      if (String(next[key] || '').trim()) {
        next.title = String(next[key]).trim()
        break
      }
    }
  }
  if (!String(next.summary || '').trim()) {
    for (const key of ['description', 'desc', 'note', 'intent']) {
      if (String(next[key] || '').trim()) {
        next.summary = String(next[key]).trim()
        break
      }
    }
  }
  if (!Array.isArray(next.changes) || !next.changes.length) {
    if (Array.isArray(next.files)) {
      next.changes = next.files.map(item => {
        if (typeof item === 'string') return { path: item, purpose: next.summary || next.title || '本轮相关改动' }
        if (!item || typeof item !== 'object') return null
        return {
          path: String(item.path || item.file || '').trim(),
          purpose: String(item.purpose || item.desc || item.description || next.summary || '').trim() || '本轮相关改动'
        }
      }).filter(item => item && item.path)
    } else if (typeof next.path === 'string' && next.path.trim()) {
      next.changes = [{ path: next.path.trim(), purpose: next.summary || next.title || '本轮相关改动' }]
    }
  }
  return next
}

function normalizeWebProjectHistoryArgs(args = {}) {
  const next = { ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}) }
  if (!String(next.memo_id || '').trim()) {
    for (const key of ['memoId', 'id', 'memo']) {
      if (String(next[key] || '').trim() && key !== 'memo') {
        next.memo_id = String(next[key]).trim()
        break
      }
    }
  }
  if (!String(next.query || '').trim()) {
    for (const key of ['q', 'keyword', 'text', 'search']) {
      if (String(next[key] || '').trim()) {
        next.query = String(next[key]).trim()
        break
      }
    }
  }
  const act = String(next.action || '').trim().toLowerCase()
  const map = {
    search: 'recall',
    history: 'recall',
    memo: 'search_memos',
    memos: 'search_memos',
    search_memo: 'search_memos',
    read: 'read_memo',
    read_memos: 'read_memo',
    latest: 'latest_change',
    rollback: 'rollback_latest_change',
    undo: 'rollback_latest_change'
  }
  if (map[act]) next.action = map[act]
  if (!String(next.action || '').trim()) {
    if (next.memo_id) next.action = 'read_memo'
    else if (next.query) next.action = 'search_memos'
    else next.action = 'latest_change'
  }
  return next
}

function peelMashedWebBridgeValue(value) {
  const extras = {}
  const text = String(value || '')
  const first = text.match(/^(.*?)"\s*,\s*"([A-Za-z_][\w]*)"\s*:\s*"([\s\S]*)$/)
  if (!first) return { head: text, extras }
  let head = first[1].replace(/\\+$/, '').replace(/"+$/, '').trim()
  let restKey = first[2]
  let restVal = first[3]
  for (let i = 0; i < 6; i += 1) {
    const next = restVal.match(/^(.*?)"\s*,\s*"([A-Za-z_][\w]*)"\s*:\s*"([\s\S]*)$/)
    if (!next) {
      extras[restKey] = restVal.replace(/"$/, '')
      break
    }
    extras[restKey] = next[1].replace(/\\+$/, '').replace(/"+$/, '').trim()
    restKey = next[2]
    restVal = next[3]
  }
  return { head, extras }
}

function unmashWebBridgeToolArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const next = { ...args }
  for (const [key, value] of Object.entries(next)) {
    if (typeof value !== 'string' || !/"\s*,\s*"[A-Za-z_]/.test(value)) continue
    const peeled = peelMashedWebBridgeValue(value)
    if (peeled.head === value && !Object.keys(peeled.extras).length) continue
    next[key] = peeled.head
    for (const [extraKey, extraVal] of Object.entries(peeled.extras)) {
      if (next[extraKey] == null || next[extraKey] === '') next[extraKey] = extraVal
    }
  }
  return next
}

function isBroadWebBridgeSearchQuery(args = {}) {
  const query = String(args.query || args.glob || args.pattern || '').replace(/\\/g, '/').trim()
  return !query || query === '**/*' || query === '**' || query === '*' || query === '*.*' || query === './**/*' || query === '**/*.*'
}

function parseWebBridgeCallArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function webBridgeSearchCallKey(call = {}) {
  const name = String(call?.function?.name || call?.name || '').trim()
  if (name !== 'file_search' && name !== 'code_inspect') return ''
  const args = parseWebBridgeCallArguments(call?.function?.arguments != null ? call.function.arguments : call.arguments)
  const pathVal = String(args.path || args.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const query = String(args.query || args.glob || args.pattern || '').replace(/\\/g, '/').trim()
  const action = String(args.action || '').trim().toLowerCase()
  const broad = isBroadWebBridgeSearchQuery({ query, glob: query, pattern: query }) || action === 'directory'
  if (broad) return `${name}|broad|${pathVal}`
  return `${name}|${action}|${pathVal}|${query}|${args.recursive === true ? '1' : '0'}`
}

function collectSeenWebBridgeSearchKeys(messages = []) {
  const seen = new Set()
  for (const message of Array.isArray(messages) ? messages : []) {
    const calls = [
      ...(Array.isArray(message?.toolCalls) ? message.toolCalls : []),
      ...(Array.isArray(message?.tool_calls) ? message.tool_calls : [])
    ]
    for (const call of calls) {
      const key = webBridgeSearchCallKey(call)
      if (key) seen.add(key)
    }
  }
  return seen
}

function dropRepeatedWebBridgeSearchCalls(toolCalls = [], messages = []) {
  const seen = collectSeenWebBridgeSearchKeys(messages)
  const out = []
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const key = webBridgeSearchCallKey(call)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(call)
  }
  return out
}

function normalizeWebToolCallArgs(name, args = {}, options = {}) {
  let next = rewriteWebBridgeDemoPaths(normalizeWebToolPathArgs(unmashWebBridgeToolArgs(args)), options.projectPath)
  if (options.direct && options.projectPath) {
    const root = slashWebProjectPath(options.projectPath).replace(/\/+$/, '')
    const rootName = root.split('/').filter(Boolean).pop() || ''
    for (const key of ['path', 'old_path', 'new_path', 'target', 'destination', 'source', 'cwd']) {
      const value = slashWebProjectPath(next[key])
      if (!value || /^[a-z]:\//i.test(value) || !rootName) continue
      const prefix = `${rootName}/`
      if (value.toLowerCase().startsWith(prefix.toLowerCase())) {
        next[key] = value.slice(prefix.length)
      }
    }
  }
  if ((name === 'file_search' || name === 'file_read' || name === 'code_inspect') && !String(next.path || '').trim() && options.projectPath) {
    next.path = slashWebProjectPath(options.projectPath)
  }
  if (name === 'file_search') {
    const action = String(next.action || '').trim().toLowerCase()
    const pathValue = String(next.path || '').trim()
    if (options.direct && (action === 'glob' || action === 'search' || action === 'find') && /[*?\[\]{}]/.test(pathValue) && !next.pattern && !next.query && !next.glob) {
      next.pattern = slashWebProjectPath(pathValue)
      next.path = slashWebProjectPath(options.projectPath)
    }
    if (isBroadWebBridgeSearchQuery(next) && (!action || action === 'glob' || action === 'search' || action === 'find')) {
      next.action = 'directory'
      next.recursive = false
      delete next.query
      delete next.glob
      delete next.pattern
    }
  }
  if (name === 'ask_user_choice') next = normalizeWebAskUserChoiceArgs(next)
  else if (name === 'confirm_plan') next = normalizeWebConfirmPlanArgs(next)
  else if (name === 'complete_step') next = normalizeWebCompleteStepArgs(next)
  else if (name === 'enter_plan_mode') next = normalizeWebEnterPlanArgs(next)
  else if (name === 'record_ai_operation_memo') next = normalizeWebMemoRecordArgs(next)
  else if (name === 'project_history') next = normalizeWebProjectHistoryArgs(next)
  if (name === 'file_manage') {
    const act = String(next.action || '').trim().toLowerCase()
    if (['delete_file', 'remove_file', 'rm', 'remove', 'unlink', 'del'].includes(act)) next.action = 'delete'
  }
  if (name === 'text_edit') {
    if ((!Array.isArray(next.edits) || !next.edits.length) && (next.start_line != null || next.startLine != null)) {
      next.edits = [{
        op: 'replace_lines',
        start_line: next.start_line ?? next.startLine,
        end_line: next.end_line ?? next.endLine ?? next.start_line ?? next.startLine,
        new_content: next.new_content ?? next.content ?? ''
      }]
    }
  }
  if (name === 'shell_run') {
    if (typeof next.action === 'string') {
      const known = String(next.action).trim().match(/^(run|status|stop)\b/i)
      if (known) next.action = known[1].toLowerCase()
    }
    if (typeof next.command === 'string') {
      const mashed = String(next.command).match(/^(.*?)\s*"\s*,\s*"cwd"\s*:\s*"([^"]+)"\s*$/s)
      if (mashed) {
        next.command = mashed[1].replace(/\\+$/, '').replace(/"+$/, '')
        if (!next.cwd) next.cwd = mashed[2]
      }
    }
  }
  if (name === 'code_inspect' && !String(next.action || '').trim()) {
    if (next.query || (Array.isArray(next.terms) && next.terms.length)) next.action = 'locate'
    else if (next.pattern || (Array.isArray(next.patterns) && next.patterns.length)) next.action = 'grep'
    else if (next.path) next.action = 'navigate'
  }
  return sanitizeWebBridgeWriteArgs(name, next)
}

function materializeWebBridgeToolCalls(rawCalls = [], {
  allowedNames = [],
  parseJson,
  maxArgumentChars = 0,
  projectPath = ''
} = {}) {
  const allowed = allowedNames instanceof Set ? allowedNames : new Set(allowedNames)
  const out = []
  let firstError = null
  for (let index = 0; index < rawCalls.length; index += 1) {
    const call = rawCalls[index] || {}
    const rawName = String(call?.name || '').trim()
    try {
      let args = call.arguments
      if (typeof args === 'string') {
        args = typeof parseJson === 'function' ? parseJson(args) : null
        if (args == null) {
          throw Object.assign(new Error(`工具“${rawName || '(空)'}”的参数不是有效 JSON，已拒绝执行。`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
        }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        args = {}
      }
      const name = resolveWebBridgeToolName(rawName, args, allowed)
      if (!name) {
        if (isPlaceholderWebBridgeToolName(rawName) || !rawName) continue
        throw Object.assign(new Error(`网页模型请求了未授权工具“${rawName}”，已拒绝执行。`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
      }
      if (name === 'write_file' && args.contents != null && args.content == null) {
        args = { ...args, content: args.contents }
        delete args.contents
      }
      if (name === 'file_manage' && !args.action && /mkdir|create_directory/i.test(rawName)) {
        args = { ...args, action: 'create_directory' }
      }
      args = normalizeWebToolCallArgs(name, args, { projectPath })
      assertWebToolArguments(name, args)
      const serialized = JSON.stringify(args)
      if (Number(maxArgumentChars) > 0 && serialized.length > Number(maxArgumentChars)) {
        throw Object.assign(new Error(`工具“${name}”的参数过大，已拒绝执行。`), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
      }
      out.push({
        id: `call_${crypto.randomBytes(12).toString('hex')}`,
        type: 'function',
        function: { name, arguments: serialized },
        index: out.length
      })
    } catch (error) {
      if (!firstError) firstError = error
    }
  }
  if (!out.length) {
    throw firstError || Object.assign(new Error('网页模型返回的灵犀工具调用不是有效 JSON，已拒绝执行。'), { code: 'INVALID_TOOL_CALL_PROTOCOL' })
  }
  return out
}

function nextWebGenerationIdleTicks(state = {}, idleTicks = 0) {
  return state && state.generating === false ? Number(idleTicks || 0) + 1 : 0
}

function noteWebGenerationStarted(state = {}, sawGenerating = false) {
  if (state?.stale) return !!sawGenerating
  return !!(sawGenerating || (state && state.generating === true))
}

function shouldAcceptStoppedWebReply(idleTicks = 0, minIdleTicks = 2, sawGenerating = false) {
  return !!sawGenerating && Number(idleTicks || 0) >= Number(minIdleTicks || 2)
}

function throwIfWebChatAborted(signal) {
  if (!signal?.aborted) return
  throw Object.assign(new Error('本轮网页聊天已取消。'), { code: 'CHAT_ABORTED' })
}

function looksLikeIncompleteWebToolCall(text = '') {
  const value = String(text || '')
  const open = value.includes(TOOL_CALL_OPEN) || /LINGXI_TOOL_CALLS>/i.test(value)
  const close = /<\/LINGXI_TOOL_CALLS>/i.test(value)
  return open && !close
}

function normalizeWebBridgeHarvestText(text = '') {
  return String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
}

function isWebBridgeHarvestChromeSuffix(extra = '') {
  return /^(?:copy(?:\s*code)?|copied|复制(?:代码)?|已复制)$/i.test(String(extra || '').trim())
}

function isStaleWebBridgeHarvest(candidate = {}, baseline = {}) {
  const cand = normalizeWebBridgeHarvestText(candidate?.markdown || candidate?.innerText || candidate || '')
  const base = normalizeWebBridgeHarvestText(baseline?.markdown || baseline?.innerText || '')
  if (!cand) return true
  if (!base) return false
  if (cand === base) return true
  if (base.startsWith(cand) && cand.length >= 40) return true
  if (cand.startsWith(base) && isWebBridgeHarvestChromeSuffix(cand.slice(base.length))) return true
  const candFinal = extractWebBridgeFinalReply(String(candidate?.markdown || candidate?.innerText || ''))
  const baseFinal = extractWebBridgeFinalReply(String(baseline?.markdown || baseline?.innerText || ''))
  if (candFinal.done && baseFinal.done) {
    return normalizeWebBridgeHarvestText(candFinal.body) === normalizeWebBridgeHarvestText(baseFinal.body)
  }
  return false
}

function extractWebBridgeReplyDelta(state = {}, baseline = {}) {
  const text = String(state?.markdown || '')
  const innerText = String(state?.innerText || '')
  const baselineText = String(baseline.markdown || '')
  const baselineCount = Number(baseline.count || 0)
  if (!text && !innerText) return { markdown: '', innerText: '' }
  const next = { markdown: text, innerText }
  if (Number(state.count || 0) > baselineCount) {
    return isStaleWebBridgeHarvest(next, baseline) ? { markdown: '', innerText: '' } : next
  }
  if (isStaleWebBridgeHarvest(next, baseline)) return { markdown: '', innerText: '' }
  if (baselineText && text.startsWith(baselineText)) {
    const deltaInner = innerText.startsWith(String(baseline.innerText || ''))
      ? innerText.slice(String(baseline.innerText || '').length)
      : innerText
    const sliced = { markdown: text.slice(baselineText.length), innerText: deltaInner }
    return isStaleWebBridgeHarvest(sliced, baseline) ? { markdown: '', innerText: '' } : sliced
  }
  return next
}

function pickUsableCapturedWebReply(...candidates) {
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue
    const markdown = String(item.markdown || '').trim()
    const innerText = String(item.innerText || '').trim()
    const text = (markdown.length >= innerText.length ? markdown : innerText)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
    if (text.length < 80) continue
    if (isWebThinkingPlaceholder(text)) continue
    if (looksLikeIncompleteWebToolCall(text)) continue
    return {
      markdown: markdown || innerText,
      innerText: innerText || markdown
    }
  }
  return null
}

async function harvestCapturedWebReply({ latestDelta, page, baseline, readAssistantState, extractReplyDelta } = {}) {
  const base = baseline && typeof baseline === 'object' ? baseline : {}
  const first = pickUsableCapturedWebReply(latestDelta)
  if (first && !isStaleWebBridgeHarvest(first, base)) return first
  if (!page || typeof readAssistantState !== 'function') return null
  const state = await readAssistantState(page).catch(() => null)
  if (!state) return null
  const delta = typeof extractReplyDelta === 'function' ? extractReplyDelta(state, base) : extractWebBridgeReplyDelta(state, base)
  const picked = pickUsableCapturedWebReply(latestDelta, delta)
  if (picked && !isStaleWebBridgeHarvest(picked, base)) return picked
  return null
}

async function takeUsableWebReplyIfAborted({
  signal,
  page,
  latestDelta,
  baseline,
  readAssistantState,
  extractReplyDelta,
  stopPage
} = {}) {
  if (!signal?.aborted) return null
  const harvested = await harvestCapturedWebReply({
    latestDelta,
    page,
    baseline,
    readAssistantState,
    extractReplyDelta
  })
  if (harvested) return harvested
  if (typeof stopPage === 'function') await stopPage(page).catch(() => {})
  throwIfWebChatAborted(signal)
  return null
}

function shouldSettleWebReply({
  incomplete = false,
  thinkingOnly = false,
  stableCount = 0,
  generating = false,
  textLength = 0,
  minStableIdle = 2,
  minStableGenerating = 4
} = {}) {
  if (incomplete || thinkingOnly) return false
  const stable = Number(stableCount || 0)
  const minIdle = Number(minStableIdle || 2)
  if (stable < minIdle) return false
  if (!generating) return true
  if (stable >= Number(minStableGenerating || 4)) return true
  return Number(textLength || 0) >= 240
}

const WEB_BRIDGE_KEEP_GOING_MAX = 8
const WEB_BRIDGE_STAGE_EVERY = 4

function extractWebBridgeJsonFenceSlice(text = '') {
  const value = String(text || '')
  const fenceRe = /```(?:json|javascript|js)?\s*\r?\n([\s\S]*?)```/gi
  let match
  while ((match = fenceRe.exec(value))) {
    const inner = String(match[1] || '').trim()
    if (/"calls"\s*:\s*\[/.test(inner)) return inner
  }
  const bare = value.match(/\{\s*"calls"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
  if (bare && /"name"\s*:\s*"(?:file_|write_|apply_|text_|json_|shell_|code_|edit_)/.test(bare[0])) {
    return bare[0].trim()
  }
  return ''
}

const WEB_XML_TOOL_TAG_RE = 'write_file|file_manage|file_read|file_search|apply_patch|text_edit|edit_file|json_edit|ask_user_choice|confirm_plan|complete_step|record_ai_operation_memo|project_history|shell_run|generate_music'

function parseXmlStyleWebToolArgs(raw = '') {
  const value = String(raw || '').trim()
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch (_) { /* nested XML next */ }
  try {
    const parsed = JSON.parse(canonicalizeWebBridgeToolJson(value))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch (_) { /* nested XML next */ }
  const args = {}
  const fieldRe = /<([A-Za-z_][\w]*)>([\s\S]*?)<\/\1>/gi
  let field
  let found = false
  while ((field = fieldRe.exec(value))) {
    const key = String(field[1] || '').trim()
    if (!key || new RegExp(`^(?:${WEB_XML_TOOL_TAG_RE})$`, 'i').test(key)) continue
    args[key] = String(field[2] || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .trim()
    found = true
  }
  return found ? args : null
}

function extractXmlStyleWebToolCallsFromText(text = '') {
  const value = String(text || '')
  const re = new RegExp(`<(${WEB_XML_TOOL_TAG_RE})>\\s*([\\s\\S]*?)\\s*</\\1>`, 'gi')
  const calls = []
  let match
  while ((match = re.exec(value))) {
    const name = String(match[1] || '').trim()
    const raw = String(match[2] || '').trim()
    if (!name || !raw) continue
    const args = parseXmlStyleWebToolArgs(raw)
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue
    calls.push({ name, arguments: args })
  }
  return calls
}

function looksLikeWebBridgeXmlToolProtocol(text = '') {
  const value = String(text || '')
  if (extractXmlStyleWebToolCallsFromText(value).length) return true
  return new RegExp(`<(?:${WEB_XML_TOOL_TAG_RE})>\\s*(?:\\{|<)`, 'i').test(value)
}

function looksLikeWebBridgeBareToolDump(text = '') {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value || value.length > 800) return false
  if (looksLikeWebBridgeToolProtocol(value)) return false
  return /create_directory|write_file|file_manage|file_read/.test(value) && /[A-Za-z]:[\\/]/.test(value)
}

function looksLikeWebBridgeToolProtocol(text = '') {
  const value = String(text || '')
  if (looksLikeWebBridgeProtocolSafetyRefusal(value)) return false
  if (/LINGXI_TOOL_CALLS/i.test(value) && /LINGXI_TOOL_CALLS>?\s*\{[\s\S]{0,240}["']?calls["']?\s*:/i.test(value)) {
    return true
  }
  if (looksLikeWebBridgeXmlToolProtocol(value)) return true
  return !!extractWebBridgeJsonFenceSlice(value)
}

function stripWebBridgeToolCallMarkers(text = '') {
  let value = String(text || '')
    .replace(/<\/?LINGXI_TOOL_CALLS>?/gi, '')
    .replace(/LINGXI_TOOL_CALLS>/gi, '')
    .replace(/<\/LINGXI[_A-Z]{0,32}[^>\n]{0,12}>?/gi, '')
    .replace(/```(?:json|javascript|js)?\s*\r?\n[\s\S]*?"calls"\s*:\s*\[[\s\S]*?```/gi, '')
    .replace(new RegExp(`<(${WEB_XML_TOOL_TAG_RE})>[\\s\\S]*?</\\1>`, 'gi'), '')
  if (extractWebBridgeFileFenceWrites(value).length) {
    let out = ''
    let last = 0
    const fenceRe = /```[^\n]*\n[\s\S]*?```/g
    let match
    while ((match = fenceRe.exec(value))) {
      const before = value.slice(Math.max(0, match.index - 240), match.index)
      const found = extractWebBridgeFileFenceWrites(`${before}\n${match[0]}`)
      out += value.slice(last, match.index)
      if (!found.length) out += match[0]
      last = match.index + match[0].length
    }
    value = out + value.slice(last)
  }
  if (extractWebBridgeAskUserChoiceCalls(value).length) {
    value = value.replace(/(?:请用户选择|请让用户选择)[\s\S]*$/i, '').trim()
  }
  return value.replace(/\n{3,}/g, '\n\n').trim()
}

function quoteBareWebBridgeJson(text = '') {
  const src = String(text || '')
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1
      while (end < src.length && /[A-Za-z0-9_]/.test(src[end])) end += 1
      const word = src.slice(i, end)
      let nextIndex = end
      while (nextIndex < src.length && /[ \t\r\n]/.test(src[nextIndex])) nextIndex += 1
      const next = src[nextIndex] || ''
      const prev = out.replace(/\s+$/g, '').slice(-1)
      if (next === ':' && (!prev || '{,'.includes(prev))) {
        out += `"${word}"`
        i = end - 1
        continue
      }
      if (prev === ':' && (next === ',' || next === '}' || next === ']' || !next) && !['true', 'false', 'null'].includes(word)) {
        out += `"${word}"`
        i = end - 1
        continue
      }
      out += word
      i = end - 1
      continue
    }
    out += ch
  }
  return out
}

function closeTruncatedJson(text = '') {
  const src = String(text || '').replace(/[\s_)\]]+$/g, match => match.replace(/[_)]/g, ''))
  let inString = false
  let escaped = false
  let braces = 0
  let brackets = 0
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') braces += 1
    else if (ch === '}') braces = Math.max(0, braces - 1)
    else if (ch === '[') brackets += 1
    else if (ch === ']') brackets = Math.max(0, brackets - 1)
  }
  return `${inString ? `${src}"` : src}${']'.repeat(brackets)}${'}'.repeat(braces)}`
}

function canonicalizeWebBridgeToolJson(text = '') {
  return closeTruncatedJson(quoteBareWebBridgeJson(String(text || '').trim()))
}

function extractWebBridgeToolJsonSlice(text = '') {
  const value = String(text || '')
  if (looksLikeWebBridgeProtocolSafetyRefusal(value)) return ''
  const xmlCalls = extractXmlStyleWebToolCallsFromText(value)
  if (xmlCalls.length) return JSON.stringify({ calls: xmlCalls })
  const fenced = extractWebBridgeJsonFenceSlice(value)
  if (fenced) return fenced
  const open = value.indexOf(TOOL_CALL_OPEN)
  const close = value.lastIndexOf(TOOL_CALL_CLOSE)
  if (open >= 0 && close > open) {
    return value.slice(open + TOOL_CALL_OPEN.length, close).trim()
  }
  const marker = value.search(/LINGXI_TOOL_CALLS>?/i)
  if (marker >= 0) {
    const from = value.indexOf('{', marker)
    if (from >= 0) {
      const closeAt = value.slice(from).search(/<\/LINGXI/i)
      const slice = closeAt >= 0 ? value.slice(from, from + closeAt) : value.slice(from)
      const trimmed = slice.replace(/[\s_)\]]+$/g, match => match.replace(/[_)]/g, '')).trim()
      if (/"?calls"?\s*:/i.test(trimmed)) return trimmed
    }
  }
  if (looksLikeWebBridgeToolProtocol(value)) {
    const from = value.indexOf('{')
    if (from >= 0) return value.slice(from).replace(/[\s_)\]]+$/g, match => match.replace(/[_)]/g, '')).trim()
  }
  return ''
}

function normalizeWebBridgeToolPayload(payload) {
  if (Array.isArray(payload)) return { calls: payload }
  if (!payload || typeof payload !== 'object') return payload
  if (Array.isArray(payload.calls)) return payload
  if (payload.calls && typeof payload.calls === 'object') return { calls: [payload.calls] }
  if (payload.name) return { calls: [payload] }
  return payload
}

function clipWebBridgeThinkingNote(text = '', maxChars = 0) {
  const staged = extractWebBridgeStageNote(text)
  if (staged.found) {
    const value = staged.note.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
    if (!value || isWebThinkingPlaceholder(value)) return ''
    const limit = Number(maxChars || 0)
    if (!limit || value.length <= limit) return value
    return `${value.slice(0, Math.max(40, limit - 1)).trim()}…`
  }
  if (looksLikeWebBridgeDumpedPrompt(text) || looksLikeWebBridgeCapturedUserQuestion(text)) {
    const cleaned = sanitizeWebBridgeCapturedReply(text)
    if (!cleaned || looksLikeWebBridgeToolProtocol(cleaned)) return ''
    text = cleaned
  }
  if (looksLikeWebBridgeToolProtocol(text)) {
    const leftover = stripWebBridgeToolCallMarkers(stripWebBridgeFinalMarkers(text))
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
    if (!leftover || /^[\{\[]/.test(leftover)) return ''
  }
  const value = stripWebBridgeToolCallMarkers(stripWebBridgeFinalMarkers(text)).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
  if (!value || looksLikeWebBridgeToolProtocol(value)) return ''
  if (looksLikeWebBridgeRestatedCharter(value) || looksLikeWebBridgeDumpedPrompt(value) || looksLikeWebBridgeCapturedUserQuestion(value)) return ''
  const limit = Number(maxChars || 0)
  if (!limit || value.length <= limit) return value
  return `${value.slice(0, Math.max(40, limit - 1)).trim()}…`
}

function shouldRequestWebBridgeStage(toolsSinceStage = 0, every = WEB_BRIDGE_STAGE_EVERY) {
  return Number(toolsSinceStage || 0) >= Number(every || WEB_BRIDGE_STAGE_EVERY)
}

function didWebPromptLeaveComposer({
  generating = false,
  messageCount = 0,
  baselineCount = 0,
  composerEmpty = false,
  hadComposerText = false
} = {}) {
  if (generating) return true
  if (Number(messageCount || 0) > Number(baselineCount || 0)) return true
  return !!(hadComposerText && composerEmpty)
}

function looksLikeWebBridgePlanToolName(name = '') {
  return /^(confirm_plan|enter_plan_mode)$/.test(String(name || '').trim())
}

function isWebBridgePlanToolBatch(toolCalls = []) {
  const list = Array.isArray(toolCalls) ? toolCalls : []
  if (!list.length) return false
  return list.every(item => looksLikeWebBridgePlanToolName(item?.name || item?.function?.name))
}

function partitionWebBridgeOpeningToolCalls(toolCalls = []) {
  const list = Array.isArray(toolCalls) ? toolCalls : []
  const plan = []
  const rest = []
  for (const item of list) {
    if (looksLikeWebBridgePlanToolName(item?.name || item?.function?.name)) plan.push(item)
    else rest.push(item)
  }
  return { plan, rest }
}

function shouldHoldWebBridgeToolsForOpeningStage({
  openedStage = false,
  hasToolCalls = false,
  chitchat = false,
  inspect = false,
  directEdit = false,
  planOnly = false
} = {}) {
  if (chitchat || directEdit || openedStage || planOnly) return false
  return !!hasToolCalls
}

function shouldParkWebBridgeOpeningStageFromText({
  openedStage = false,
  hasToolCalls = false,
  hasFinal = false,
  text = '',
  userText = ''
} = {}) {
  if (openedStage || hasToolCalls || hasFinal) return false
  if (looksLikeWebBridgeMangledFileDump(text) || looksLikeWebBridgeFileWrite(text) || looksLikeWebBridgeBareToolDump(text)) return false
  if (shouldPromoteWebBridgeTextToFinal({ userText, text })) return false
  if (looksLikeWebBridgeHallucinatedWork(text)) return false
  if (looksLikeWebBridgeChitchat(userText) || looksLikeWebBridgeChitchatReply(text)) return false
  if (looksLikeWebBridgeToolProtocol(text) || isWebBridgeNoToolsRefusal(text)) return false
  if (looksLikeWebBridgeFuturePlan(text) || looksLikeWebBridgeRestatedCharter(text)) return false
  const note = clipWebBridgeThinkingNote(text)
  return !!(note && !isWebThinkingPlaceholder(note))
}

function classifyWebBridgeAssistantReply(content = '', {
  hadToolsThisTurn = false,
  keepGoingAttempts = 0,
  userText = '',
  dialect = '',
  stageTurn = false,
  blockingWrites = false,
  inspectNeedsMore = false
} = {}) {
  if (looksLikeWebBridgeChitchat(userText) || looksLikeWebBridgeChitchatReply(content) || looksLikeWebBridgeProtocolSafetyRefusal(content)) return 'final'
  const hasFinal = extractWebBridgeFinalReply(content).done
  if (hasFinal && !shouldAcceptWebBridgeFinalReply({ stageTurn, blockingWrites, inspectNeedsMore })) return 'continue'
  if (hasFinal) return 'final'
  if (isWebBridgeNoToolsRefusal(content)) return 'continue'
  if (looksLikeWebBridgeDumpedPrompt(content) || looksLikeWebBridgeCapturedUserQuestion(content)) return 'continue'
  const staged = extractWebBridgeStageNote(content)
  if (staged.found) {
    content = staged.rest
    if (!String(content || '').trim()) return 'continue'
  }
  if (stageTurn) return 'continue'
  if (blockingWrites) return 'continue'
  if (inspectNeedsMore) return 'continue'
  if (!hadToolsThisTurn) {
    if (shouldNudgeWebBridgeForMissingTools({ userText, content, dialect })) return 'continue'
    return 'final'
  }
  if (isWebPasteFilesDialect(dialect)) {
    if (extractWebBridgeAskUserChoiceCalls(content).length) return 'continue'
    if (!extractWebBridgeFileFenceWrites(content).length) return 'final'
    const leftover = stripWebBridgeToolCallMarkers(content)
    if (leftover.trim().length >= 12) return 'final'
    if (Number(keepGoingAttempts || 0) >= WEB_BRIDGE_KEEP_GOING_MAX) return 'final'
    return 'continue'
  }
  if (isWebJsonFenceDialect(dialect) && !looksLikeWebBridgeToolProtocol(content)) return 'final'
  if (shouldPromoteWebBridgeTextToFinal({ userText, text: content })) return 'final'
  if (looksLikeWebBridgeWaitingOrDone(content)) return 'final'
  const leftover = stripWebBridgeStageMarkers(stripWebBridgeFinalMarkers(stripWebBridgeToolCallMarkers(content))).replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  if (looksLikeWebBridgeDumpedPrompt(leftover) || looksLikeWebBridgeCapturedUserQuestion(leftover)) return 'continue'
  if (leftover.length >= 12 && !looksLikeWebBridgeToolProtocol(leftover) && !isWebBridgeNoToolsRefusal(leftover)) return 'final'
  if (Number(keepGoingAttempts || 0) >= WEB_BRIDGE_KEEP_GOING_MAX) return 'final'
  return 'continue'
}

function buildWebBridgeStageReplyPrompt({ opening = false, dialect = '' } = {}) {
  const confirmExample = `${TOOL_CALL_OPEN}{"calls":[{"name":"confirm_plan","arguments":{"summary":"按用户需求推进","plan":["定位入口","核对关键证据","给出结论"]}}]}${TOOL_CALL_CLOSE}`
  if (isWebPasteFilesDialect(dialect)) {
    return opening
      ? '先调用 confirm_plan，把 3 到 7 步待办交给用户确认。plan 写短步骤，summary 写一句话。不要用普通正文代替计划。用户确认前不要改文件。确认后阶段性说明用 <LINGXI_STAGE> 包住，最终回答直接写。'
      : '现在只写阶段性说明，必须整段包在 <LINGXI_STAGE> 和 </LINGXI_STAGE> 里：当前正在处理哪一步、已经获得哪些证据、还缺什么、下一步准备做什么。不要调工具，不要写 complete_step，不要复述指令，不要重写总目标。不必再发完整文件。'
  }
  if (isWebJsonFenceDialect(dialect)) {
    return opening
      ? [
        '先调用 confirm_plan，把 3 到 7 步待办交给用户确认。不要用普通正文代替计划。',
        '```json',
        '{"calls":[{"name":"confirm_plan","arguments":{"summary":"按用户需求推进","plan":["定位入口","核对关键证据","给出结论"]}}]}',
        '```',
        '确认后阶段性说明用 <LINGXI_STAGE> 包住，最终回答用 <LINGXI_FINAL> 包住，两套暗号不要混用。'
      ].join('\n')
      : '现在只写阶段性说明，必须整段包在 <LINGXI_STAGE> 和 </LINGXI_STAGE> 里：当前正在处理哪一步、已经获得哪些证据、还缺什么、下一步准备做什么。不要调工具，不要写 complete_step，不要复述指令，不要重写总目标。不要再写 json 代码块。只有页面已经能在浏览器里正常显示、工具结果没有结构错误时，才改用 <LINGXI_FINAL>。'
  }
  if (opening) {
    return [
      '复杂任务先调用 confirm_plan，把 3 到 7 步待办交给用户确认。不要用普通正文代替计划。',
      '调用示例：',
      confirmExample,
      '用户确认前不要 file_search、读文件或改文件。',
      `确认后按步骤执行。阶段性说明必须包在 <LINGXI_STAGE> 里给人看。${buildWebBridgePlanProgressRule()}给用户的最终回答必须包在 <LINGXI_FINAL> 里。两套暗号不要混用。`,
      '阶段性说明不能代替 confirm_plan。不要讨论有没有工具。'
    ].join('\n')
  }
  return '现在只写阶段性说明，必须整段包在 <LINGXI_STAGE> 和 </LINGXI_STAGE> 里：当前正在处理哪一步、已经获得哪些证据、还缺什么、下一步准备做什么。不要调工具，不要写 complete_step，不要复述指令，不要重写总目标。已经能回答用户就改用 <LINGXI_FINAL>，不要用阶段性暗号。'
}

function buildWebBridgePlanProgressRule() {
  return '阶段性说明不等于完成计划步骤。尚未完成则继续当前步骤，不要调用 complete_step；当前步骤目标已被证据充分满足时，本轮必须调用 complete_step 勾掉该步，不要空转搜索。'
}

function buildWebBridgeCompleteStepPrompt(options = {}) {
  if (isWebPasteFilesDialect(options.dialect)) {
    return '阶段性说明已经记下。先判断当前计划步骤：目标已被证据满足时只调用 complete_step；尚未满足则不要调用 complete_step，继续改文件。不要因为刚写过阶段性说明就默认完成。不要再写阶段性说明。'
  }
  if (isWebJsonFenceDialect(options.dialect)) {
    return '阶段性说明已经记下。先判断当前计划步骤：目标已被证据满足时只调用 complete_step；尚未满足则不要调用 complete_step，继续当前步骤。不要因为刚写过阶段性说明就默认完成。不要再写阶段性说明。'
  }
  return '阶段性说明已经记下。先判断当前计划步骤：目标已被证据满足时，本轮只调用 complete_step（step_index=刚完成步骤，从0开始，带上 steps、total_steps、status=completed）；尚未满足则不要调用 complete_step，继续当前步骤。不要因为刚写过阶段性说明就默认完成，也不要在证据已经够了时继续空转搜索。不要再写阶段性说明。'
}

function buildWebBridgeOpeningStagePrompt(options = {}) {
  return buildWebBridgeStageReplyPrompt({ opening: true, dialect: options.dialect })
}

function buildWebBridgeKeepGoingPrompt(options = {}) {
  if (options.executeNow) {
    if (isWebPasteFilesDialect(options.dialect)) {
      return '不要再确认或排查。直接给出要改文件的完整内容，用代码块包住并写上路径；已经改完就用中文交代结果。'
    }
    if (isWebJsonFenceDialect(options.dialect)) {
      return '不要再确认或排查。下一句必须是改文件的 json 代码块。工具结果若报告 HTML 结构错误或 blocking，必须先 file_read 再修复，禁止输出 <LINGXI_FINAL>。只有页面结构完整后才直接写给用户看。'
    }
    return [
      '不要再确认、排查或写阶段性计划。',
      '目标已经明确时，下一句必须是调用标签：直接删除或修改已定位的文件和引用。',
      '不要再 file_search 同一批路径。已经能向用户交代结果就把最终回答包在 <LINGXI_FINAL> 里。'
    ].join('\n')
  }
  if (isWebPasteFilesDialect(options.dialect)) {
    return [
      '若已经改完，用中文说明改了什么。',
      '还要改文件时，直接给出修改后的完整内容，用代码块包住，代码块开头写路径。',
      '需要用户选择时写成“请用户选择”，不要把选择题当最终回答。'
    ].join('\n')
  }
  if (isWebJsonFenceDialect(options.dialect)) {
    if (webBridgeInspectNeedsMore(options.userText, options.toolCalls)) {
      return buildWebBridgeInspectKeepGoingPrompt(options)
    }
    return [
      '若还只看到目录、README 或 package.json，再写一个 json 代码块 file_read 入口和源码，禁止输出 <LINGXI_FINAL>。',
      '只有根据真实源码已经能回答，才把最终回答包在 <LINGXI_FINAL> 里。',
      '还要看或改文件时，再写一个 json 代码块，字段是 calls。禁止再次 file_search 同一路径，尤其禁止 **/*。',
      '需要用户选择时 name 用 ask_user_choice，确认计划用 confirm_plan。阶段性说明只用 <LINGXI_STAGE>，不要和最终暗号混用。'
    ].join('\n')
  }
  return [
    '按用户已确认的 confirm_plan 继续当前未完成步骤。不要重写计划或总目标，不要对同一路径重复搜索。',
    '如果已经能按计划回答用户的问题，把最终回答整段包在 <LINGXI_FINAL> 与 </LINGXI_FINAL> 里，不要用 <LINGXI_STAGE>。',
    buildWebBridgePlanProgressRule(),
    '还要看或改文件时，只填写调用标签，本地客户端会解析。不要为了调用而调用。',
    '需要用户做选择时调用 ask_user_choice，确认执行计划用 confirm_plan，不要把选择题或确认写进最终说明。',
    'write_file 字段是 content，新建和覆盖已有文件都可以。',
    buildWebBridgeSourceQualityRule({ compact: true }),
    '不要讨论有没有工具。不要写“等待下一步”。'
  ].join('\n')
}

function buildWebBridgeNoToolsNudgePrompt(options = {}) {
  if (isWebPasteFilesDialect(options.dialect)) {
    return '若要改文件，给出修改后的完整内容，用代码块包住，代码块开头写路径。不用改就直接用中文回答。'
  }
  if (isWebJsonFenceDialect(options.dialect)) {
    return [
      '若需要项目文件，请写一个 json 代码块，例如：',
      '```json',
      buildWebToolExampleCalls(options.projectPath).replace(TOOL_CALL_OPEN, '').replace(TOOL_CALL_CLOSE, ''),
      '```'
    ].join('\n')
  }
  return [
    '本地没有收到调用标签，因此没有读取或修改任何文件。不要凭记忆或幻觉写项目内容和“已完成”。',
    '复杂任务先输出 confirm_plan 让用户确认步骤，不要把计划写成普通正文。',
    '不要把完整文件写在普通 markdown 代码块里，那不会写入电脑。',
    '你不执行任何电脑操作，只把下面标签原样输出给本地解析器。不要解释。path 必须用当前项目路径，禁止 E:/demo。',
    buildWebToolExampleCalls(options.projectPath)
  ].join('\n')
}

function attachWebChatAbort(req, res, abortController) {
  const abortIfClientGone = () => {
    if (res.writableEnded) return
    abortController.abort()
  }
  // 只听请求被客户端中止，以及响应连接断开。
  // 不能听 req.close：读完 POST body 后 Node 也会发 close，会把第一次发送立刻误杀。
  req.once('aborted', abortIfClientGone)
  res.once('close', abortIfClientGone)
}

module.exports = {
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
  FINAL_OPEN,
  FINAL_CLOSE,
  STAGE_OPEN,
  STAGE_CLOSE,
  getWebBridgeSystemStandin,
  compactWebTranscriptContent,
  formatLingxiWebChatTranscript,
  compactWebToolCallArgs,
  getLatestWebUserText,
  getResumePromptMessages,
  normalizeSavedConversations,
  getSavedConversationUrl,
  rememberSavedConversation,
  forgetSavedConversation,
  looksLikeMissingWebConversation,
  readWebPageVisibleText,
  pageLooksLikeMissingWebConversation,
  resolveWebChatPromptPlan,
  slimWebBridgeResumeMessages,
  looksLikeWebBridgeChitchat,
  looksLikeWebBridgeChitchatReply,
  looksLikeWebBridgeDumpedPrompt,
  stripWebBridgeDumpedPrompt,
  sanitizeWebBridgeCapturedReply,
  looksLikeWebBridgeCapturedUserQuestion,
  decodeWebBridgeCipherEntities,
  hasClosedWebBridgeFinalCipher,
  slimWebBridgeChitchatTranscript,
  looksLikeWebBridgeProtocolSafetyRefusal,
  shouldNudgeWebBridgeForMissingTools,
  looksLikeWebBridgeHallucinatedWork,
  looksLikeWebBridgeFuturePlan,
  looksLikeWebBridgeRestatedCharter,
  looksLikeWebBridgePlanToolName,
  isWebBridgePlanToolBatch,
  needsWebBridgeToolEvidence,
  shouldRetryWebBridgeToolProtocol,
  looksLikeWebBridgeInspectQuestion,
  looksLikeWebBridgeDirectEditTask,
  looksLikeWebBridgeConfirmStall,
  isWebBridgeReadOnlyToolBatch,
  shouldSkipWebBridgeStageForExecute,
  shouldPromoteWebBridgeTextToFinal,
  canSendWebChatPromptMessages,
  hasWebBridgeSendableSourceMessage,
  isWebThinkingPlaceholder,
  formatCompactWebToolList,
  buildWebToolProtocol,
  assembleWebPagePrompt,
  buildWebToolProtocolRetryPrompt,
  assertWebToolArguments,
  normalizeWebToolPathArgs,
  normalizeWebToolCallArgs,
  unmashWebBridgeToolArgs,
  sanitizeWebBridgeSourceText,
  sanitizeWebBridgePatch,
  buildWebBridgeSourceQualityRule,
  inspectWebBridgeHtmlDocument,
  assertWebBridgeHtmlDocument,
  extractWebBridgeWriteDiagnostics,
  hasBlockingWebBridgeWriteDiagnostics,
  collectBlockingWebBridgeWriteDiagnostics,
  collectUnresolvedBlockingWebBridgeWriteDiagnostics,
  buildWebBridgeBlockingWriteFixPrompt,
  shouldAcceptWebBridgeFinalReply,
  webBridgeInspectNeedsMore,
  buildWebBridgeInspectKeepGoingPrompt,
  buildWebBridgeStageFinalRejectPrompt,
  materializeWebBridgeToolCalls,
  resolveWebBridgeToolName,
  tryExtractLingxiCallsLoose,
  nextWebGenerationIdleTicks,
  noteWebGenerationStarted,
  shouldAcceptStoppedWebReply,
  throwIfWebChatAborted,
  pickUsableCapturedWebReply,
  isStaleWebBridgeHarvest,
  extractWebBridgeReplyDelta,
  harvestCapturedWebReply,
  takeUsableWebReplyIfAborted,
  shouldSettleWebReply,
  attachWebChatAbort,
  WEB_BRIDGE_DIALECT_JSON_FENCE,
  WEB_BRIDGE_DIALECT_PASTE_FILES,
  WEB_BRIDGE_MODE_LINGXI,
  WEB_BRIDGE_MODE_PASSTHROUGH,
  isWebPasteFilesDialect,
  isWebBridgePassthroughMode,
  resolveWebBridgeApiMode,
  looksLikeLingxiWebToolset,
  looksLikeLingxiWebRequest,
  getWebBridgeAgentLane,
  buildWebChatSessionKey,
  buildWebChatSessionKeyFromRequest,
  pickReusableWebChatPage,
  clickWebBridgeNewChatButton,
  normalizePassthroughWebTools,
  formatPassthroughWebChatTranscript,
  assemblePassthroughPagePrompt,
  hasPassthroughRunCodeTool,
  parsePassthroughWebToolCalls,
  extractWebBridgeProjectPath,
  collectWebBridgeProjectPath,
  isWebBridgeDemoExamplePath,
  rewriteWebBridgeDemoPaths,
  gatherWebBridgeProjectFiles,
  formatWebBridgePastedFiles,
  extractWebBridgeFileFenceWrites,
  looksLikeWebBridgeFileWrite,
  looksLikeWebBridgeMangledFileDump,
  tryParseWebBridgeAskChoice,
  extractWebBridgeAskUserChoiceCalls,
  parseWebBridgeAskChoiceFallback,
  WEB_BRIDGE_KEEP_GOING_MAX,
  WEB_BRIDGE_STAGE_EVERY,
  clipWebBridgeThinkingNote,
  looksLikeWebBridgeToolProtocol,
  looksLikeWebBridgeXmlToolProtocol,
  looksLikeWebBridgeBareToolDump,
  extractXmlStyleWebToolCallsFromText,
  parseXmlStyleWebToolArgs,
  stripWebBridgeToolCallMarkers,
  extractWebBridgeToolJsonSlice,
  canonicalizeWebBridgeToolJson,
  normalizeWebBridgeToolPayload,
  shouldRequestWebBridgeStage,
  didWebPromptLeaveComposer,
  shouldHoldWebBridgeToolsForOpeningStage,
  isWebBridgePlanToolBatch,
  partitionWebBridgeOpeningToolCalls,
  shouldParkWebBridgeOpeningStageFromText,
  extractWebBridgeFinalReply,
  extractWebBridgeStageNote,
  stripWebBridgeStageMarkers,
  looksLikeWebBridgeStageNote,
  stripWebBridgeFinalMarkers,
  buildWebBridgeFinalReplyConstraint,
  normalizeWebBridgeFinalBody,
  isWebBridgeNoToolsRefusal,
  classifyWebBridgeAssistantReply,
  buildWebBridgeStageReplyPrompt,
  buildWebBridgeOpeningStagePrompt,
  buildWebBridgeCompleteStepPrompt,
  buildWebBridgeKeepGoingPrompt,
  buildWebBridgePlanProgressRule,
  buildWebBridgeNoToolsNudgePrompt,
  isBroadWebBridgeSearchQuery,
  webBridgeSearchCallKey,
  dropRepeatedWebBridgeSearchCalls
}
