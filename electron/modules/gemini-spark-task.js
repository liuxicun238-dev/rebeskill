/**
 * Gemini Spark 远程 Agent 任务整形。
 * 只负责从灵犀请求里抽出用户任务，不注入工具协议，不解析 function_call。
 */

const LINGXI_INTERNAL_RE = /【内部工作流指令】[^\n]*|<LINGXI_TOOL_CALLS>[\s\S]*?<\/LINGXI_TOOL_CALLS>|<LINGXI_FINAL>[\s\S]*?<\/LINGXI_FINAL>/gi
const LINGXI_TOOL_XML_RE = /<\/?(?:write_file|file_manage|file_read|file_search|apply_patch|text_edit|shell_run)(?:\s[^>]*)?>/gi

function extractMessageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : String(content)
  return content.map(part => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    if (['text', 'input_text', 'output_text'].includes(part.type)) return String(part.text || '')
    if (part.type === 'image_url' || part.type === 'input_image') return '[图片：Spark 车道第一期不转发附件]'
    return String(part.text || part.content || '')
  }).filter(Boolean).join('\n')
}

function stripLingxiProtocol(text = '') {
  return String(text || '')
    .replace(LINGXI_INTERNAL_RE, '')
    .replace(LINGXI_TOOL_XML_RE, '')
    .replace(/```(?:json|javascript|js)?\s*\r?\n[\s\S]*?"calls"\s*:\s*\[[\s\S]*?```/gi, '')
    .replace(/^\s*【本轮执行检查点】[\s\S]*$/m, '')
    .trim()
}

function normalizeSparkMessages(body = {}) {
  const source = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : typeof body.input === 'string'
        ? [{ role: 'user', content: body.input }]
        : []
  return source.map(message => {
    if (!message || typeof message !== 'object') return null
    if (message.type === 'function_call' || message.type === 'function_call_output') return null
    const role = ['system', 'developer', 'user', 'assistant'].includes(message.role) ? message.role : 'user'
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) return null
    const content = stripLingxiProtocol(extractMessageText(message.content))
    if (!content) return null
    return { role, content }
  }).filter(Boolean)
}

function extractSparkUserTask(body = {}) {
  const messages = normalizeSparkMessages(body)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user' && messages[index].content) return messages[index].content
  }
  return ''
}

function looksLikeGoogleAccountValidation(text = '') {
  const value = String(text || '')
  return /无法验证我的信息|couldn't verify your information|could not verify your information|verify your account to continue|validation_required/i.test(value)
}

function isGoogleLoginUrl(url = '') {
  const value = String(url || '')
  try {
    const parsed = new URL(value)
    if (/accounts\.google\.com$/i.test(parsed.hostname)) return true
    if (/\/signin(?:\/|$)/i.test(parsed.pathname) && /google\.com$/i.test(parsed.hostname)) return true
  } catch (_) {
    if (/accounts\.google\.com/i.test(value) || /\/signin/i.test(value)) return true
  }
  return false
}

function classifySparkPageAccess({ url = '', composerFound = false, loginVisible = false, validationBlocked = false } = {}) {
  if (validationBlocked) return { code: 'ACCOUNT_VALIDATION', loggedIn: false }
  if (isGoogleLoginUrl(url)) return { code: 'LOGIN_REQUIRED', loggedIn: false }
  if (composerFound) return { code: '', loggedIn: true }
  if (/gemini\.google\.com/i.test(String(url || ''))) {
    return { code: 'COMPOSER_NOT_READY', loggedIn: null }
  }
  if (loginVisible) return { code: 'LOGIN_REQUIRED', loggedIn: false }
  return { code: 'COMPOSER_NOT_READY', loggedIn: null }
}

function encodeSparkProjectPathHeader(projectPath = '') {
  const text = String(projectPath || '').trim()
  return text ? encodeURIComponent(text) : ''
}

function decodeSparkProjectPathHeader(value = '') {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    return decodeURIComponent(text)
  } catch (_) {
    return text
  }
}

function resolveSparkProjectPath({ headerValue = '', metadataPath = '' } = {}) {
  const fromBody = String(metadataPath || '').trim()
  if (fromBody) return fromBody
  return decodeSparkProjectPathHeader(headerValue)
}

function isHttpHeaderByteString(value = '') {
  const text = String(value ?? '')
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 255) return false
  }
  return true
}

function buildSparkAgentPrompt({ userText = '', projectPath = '' } = {}) {
  const task = stripLingxiProtocol(userText)
  const lines = [
    '你是 Gemini Spark 编程 Agent。请用你自己的文件、Shell、浏览器和 MCP 工具完成下面的任务。',
    '不要尝试调用外部 IDE 或灵犀的 function_call / <LINGXI_TOOL_CALLS>。',
    '完成后用中文给出结果摘要。若你修改了代码，尽量附上 unified diff。'
  ]
  const project = String(projectPath || '').trim()
  if (project) {
    lines.push('')
    lines.push(`当前灵犀项目目录仅作说明，默认工作区仍是 Spark 远程环境：${project}`)
  }
  lines.push('')
  lines.push('任务：')
  lines.push(task)
  return lines.join('\n').trim()
}

module.exports = {
  extractMessageText,
  stripLingxiProtocol,
  normalizeSparkMessages,
  extractSparkUserTask,
  looksLikeGoogleAccountValidation,
  isGoogleLoginUrl,
  classifySparkPageAccess,
  encodeSparkProjectPathHeader,
  decodeSparkProjectPathHeader,
  resolveSparkProjectPath,
  isHttpHeaderByteString,
  buildSparkAgentPrompt
}
