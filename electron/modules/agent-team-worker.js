/**
 * 标准模式队员：同进程、同项目的一轮工具循环。
 * 不创建临时聊天实例；事件只写进 execution.agents，由投影推到前端。
 */

const crypto = require('crypto')
const {
  getApiFormat,
  buildApiEndpoint,
  buildApiHeaders,
  buildApiFetchOptions,
  buildModelRequestBody,
  extractContentText
} = require('./model-api-adapter')
const { stableJsonStringify } = require('./prompt-stability')
const { buildCompactAgentRuntimePrompt } = require('./agent-runtime')
const { parseToolArgsSafe, sanitizeFinalContent } = require('./chat-helpers')

const TEAM_TOOL_NAME = 'delegate_agents'

const MAX_WORKER_LOOPS = 16
const CALL_TIMEOUT_MS = 120000

function compactText(value, limit = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function harvestThink(text) {
  const thinks = []
  let rest = String(text || '')
  rest = rest.replace(/<think\b[^>]*>([\s\S]*?)<\/think>/gi, (_, inner) => {
    const note = String(inner || '').trim()
    if (note) thinks.push(note)
    return '\n'
  })
  rest = rest.replace(/```(?:think|thinking|reasoning)\b[\s\S]*?```/gi, '')
  let cleaned = sanitizeFinalContent(rest)
  if (!cleaned && thinks.length) {
    const fallback = thinks[thinks.length - 1]
    if (/[#*\-]|结论|项目|发现|建议|摘要|本质/.test(fallback)) {
      cleaned = sanitizeFinalContent(fallback)
    }
  }
  return { thinks, text: cleaned }
}

function extractAssistantTurn(data, apiFormat = 'openai') {
  if (apiFormat === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : []
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text || '').join('')
    const reasoning = blocks.filter(block => block?.type === 'thinking').map(block => block.thinking || '').join('')
    const toolCalls = blocks.filter(block => block?.type === 'tool_use').map((block, index) => ({
      id: block.id || `call_${index}`,
      type: 'function',
      function: {
        name: block.name || '',
        arguments: JSON.stringify(block.input || {})
      }
    }))
    return { content: text, reasoning, tool_calls: toolCalls }
  }
  if (apiFormat === 'gemini') {
    const parts = data?.candidates?.[0]?.content?.parts || []
    const text = parts.filter(part => part?.text).map(part => part.text).join('')
    const toolCalls = parts
      .map((part, index) => part.functionCall || part.function_call
        ? {
          id: `call_${index}_${part.functionCall?.name || part.function_call?.name || 'tool'}`,
          type: 'function',
          function: {
            name: part.functionCall?.name || part.function_call?.name || '',
            arguments: JSON.stringify(part.functionCall?.args || part.function_call?.args || part.functionCall?.arguments || {})
          }
        }
        : null)
      .filter(Boolean)
    return { content: text, reasoning: '', tool_calls: toolCalls }
  }
  if (apiFormat === 'openai-responses') {
    const output = Array.isArray(data?.output) ? data.output : []
    const textParts = []
    const toolCalls = []
    for (const item of output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.text) textParts.push(part.text)
        }
      }
      if (item?.type === 'function_call' || item?.type === 'tool_call') {
        toolCalls.push({
          id: item.call_id || item.id || `call_${toolCalls.length}`,
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
          }
        })
      }
    }
    return {
      content: textParts.join('') || String(data?.output_text || ''),
      reasoning: '',
      tool_calls: toolCalls
    }
  }
  const message = data?.choices?.[0]?.message || {}
  let content = message.content
  if (Array.isArray(content)) content = content.map(part => part?.text || '').join('')
  else if (content && typeof content === 'object') content = extractContentText(content) || ''
  return {
    content: String(content || ''),
    reasoning: String(message.reasoning_content || message.reasoning || ''),
    tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : []
  }
}

async function fetchWithAbort(url, options, timeoutMs, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs || CALL_TIMEOUT_MS)
  const onParentAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    signal.addEventListener('abort', onParentAbort, { once: true })
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onParentAbort)
  }
}

function buildWorkerPrompt(spec) {
  const agent = spec.agent
  const upstream = Array.isArray(spec.upstream) ? spec.upstream : []
  const upstreamBlock = upstream.length
    ? `前置队员结果：\n${upstream.map(item => `- ${item.name}（${item.role}）${item.error ? '失败: ' + item.error : ''}\n${item.output || '（无正文）'}`).join('\n\n')}`
    : '没有前置队员结果。'
  return `${buildCompactAgentRuntimePrompt()}

===== 你是团队队员，不是主会话 =====
你的短名：${agent.name}
你的职责：${agent.role}
只做自己的 task，不要派工，不要调用 ${TEAM_TOOL_NAME}，不要进入计划模式。
主协调（全队共享）：
${spec.teamBrief || '（无）'}

${upstreamBlock}

当前项目路径：${spec.ctx.projectPath || '未指定'}
完成后直接写结论正文，不必套大标题。需要过程说明时用 show_thinking_note。`
}

async function callTeamModelOnce(spec, messages) {
  const modelConfig = spec.ctx.modelConfig || {}
  const modelId = String(modelConfig.modelId || modelConfig.modelName || modelConfig.model || '').trim()
  let endpoint = buildApiEndpoint(modelConfig)
  if (!endpoint || !modelId) throw new Error('队员模型配置不完整')
  const apiFormat = getApiFormat(modelConfig, endpoint)
  if (apiFormat === 'gemini') endpoint = endpoint.replace(/:streamGenerateContent$/i, ':generateContent')
  const parentOptions = spec.ctx.options || {}
  const body = buildModelRequestBody(modelConfig, modelId, messages, {
    stream: false,
    includeTools: true,
    promptCache: false,
    disableReasoningOptions: true,
    endpoint,
    projectId: spec.ctx.projectId || '',
    sessionId: spec.execution.id,
    userMessage: spec.agent.task,
    enabledPacks: parentOptions.enabledPacks,
    projectMode: 'standard',
    teamWorker: true,
    disabledTools: [...(parentOptions.disabledTools || []), TEAM_TOOL_NAME, 'enter_plan_mode', 'confirm_plan', 'complete_step']
  })
  const headers = buildApiHeaders(modelConfig, endpoint, {
    stream: false,
    modelId,
    promptCache: false,
    projectId: spec.ctx.projectId || '',
    sessionId: spec.execution.id
  })
  const response = await fetchWithAbort(endpoint, buildApiFetchOptions(modelConfig, endpoint, {
    method: 'POST',
    headers,
    body: stableJsonStringify(body),
    modelId,
    promptCache: false
  }), CALL_TIMEOUT_MS, spec.ctx.signal || parentOptions.signal)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`队员模型 ${response.status}: ${text.slice(0, 400)}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (_) {
    throw new Error('队员模型返回了无法解析的内容')
  }
  return { apiFormat, turn: extractAssistantTurn(data, apiFormat), raw: data }
}

function compactToolResult(result) {
  if (result == null) return { success: false, error: 'empty tool result' }
  if (typeof result !== 'object') return { success: true, message: compactText(result, 4000) }
  const next = {
    success: result.success !== false,
    message: compactText(result.message || result.error || '', 1200)
  }
  if (result.error) next.error = compactText(result.error, 800)
  if (result.path) next.path = result.path
  if (Array.isArray(result.files)) next.files = result.files.slice(0, 20)
  if (result.stdout) next.stdout = compactText(result.stdout, 6000)
  if (result.content) next.content = compactText(result.content, 8000)
  if (result.matches) next.matches = Array.isArray(result.matches) ? result.matches.slice(0, 30) : result.matches
  return next
}

function modelVisibleToolResult(result) {
  try {
    const text = JSON.stringify(result)
    if (text.length <= 14000) return result
  } catch (_) {}
  return compactToolResult(result)
}

async function runTeamWorker(spec) {
  const { executeToolForProject } = require('./tools')
  const agent = spec.agent
  const ctx = spec.ctx
  const options = ctx.options || {}
  const signal = ctx.signal || options.signal
  const messages = [
    { role: 'system', content: buildWorkerPrompt(spec) },
    { role: 'user', content: agent.task }
  ]
  const pushThink = (content) => {
    const text = String(content || '').trim()
    if (!text) return
    agent.thinking = Array.isArray(agent.thinking) ? agent.thinking : []
    agent.thinking.push({
      id: `think-${crypto.randomUUID().slice(0, 8)}`,
      type: 'note',
      content: compactText(text, 800),
      createdAt: Date.now()
    })
    agent.statusText = compactText(text, 96)
  }
  const pushTool = (patch) => {
    agent.tools = Array.isArray(agent.tools) ? agent.tools : []
    const toolCallId = String(patch.toolCallId || '')
    let item = toolCallId ? agent.tools.find(entry => String(entry.toolCallId || '') === toolCallId) : null
    if (!item) {
      item = {
        id: toolCallId || `tool-${crypto.randomUUID().slice(0, 8)}`,
        toolCallId,
        name: patch.name || 'tool',
        args: patch.args || {},
        result: null,
        status: 'running',
        createdAt: Date.now()
      }
      agent.tools.push(item)
    }
    Object.assign(item, patch, { updatedAt: Date.now() })
    return item
  }

  let output = ''
  for (let loop = 0; loop < MAX_WORKER_LOOPS; loop += 1) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    agent.status = 'thinking'
    spec.onUpdate?.()
    const { turn } = await callTeamModelOnce(spec, messages)
    const harvested = harvestThink(turn.content)
    harvested.thinks.forEach(pushThink)
    if (turn.reasoning) pushThink(turn.reasoning)
    const visibleContent = harvested.text
    const toolCalls = Array.isArray(turn.tool_calls) ? turn.tool_calls.filter(item => item?.function?.name) : []
    const assistantMessage = {
      role: 'assistant',
      content: visibleContent || (toolCalls.length ? '' : ''),
      tool_calls: toolCalls.length ? toolCalls : undefined
    }
    messages.push(assistantMessage)

    if (!toolCalls.length) {
      output = visibleContent
      agent.output = output
      return { success: true, output }
    }

    agent.status = 'using_tools'
    spec.onUpdate?.()
    for (const toolCall of toolCalls) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const toolName = String(toolCall.function?.name || '')
      const toolCallId = String(toolCall.id || `call-${crypto.randomUUID().slice(0, 8)}`)
      const toolArgs = toolCall.function?.arguments && typeof toolCall.function.arguments === 'object'
        ? toolCall.function.arguments
        : parseToolArgsSafe(toolCall)
      if (toolName === TEAM_TOOL_NAME) {
        const blocked = {
          success: false,
          error: '队员不能再派工。请自己完成当前任务。'
        }
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify(blocked)
        })
        continue
      }
      if (toolName === 'show_thinking_note' || toolName === 'report_progress') {
        pushThink(toolArgs.content || toolArgs.message || toolArgs.status || toolArgs.note || '')
        spec.onUpdate?.()
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify({ success: true, internal: true, thinkingNote: true })
        })
        continue
      }
      if (toolName === 'start_final_reply') {
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify({ success: true, internal: true, message: '可以写最终结论了。' })
        })
        continue
      }
      pushTool({ toolCallId, name: toolName, args: toolArgs, status: 'running' })
      spec.onUpdate?.()
      let result
      try {
        result = await executeToolForProject(
          toolName,
          toolArgs,
          ctx.projectPath,
          ctx.resolvePath,
          ctx.contextManager,
          ctx.projectId,
          ctx.modelConfig,
          {
            ...options,
            signal,
            teamWorker: true,
            teamAgentId: agent.id,
            teamExecutionId: spec.execution.id,
            collaborationSessionId: spec.execution.id,
            collaborationAgentId: agent.id,
            collaborationAgentName: agent.name,
            toolCallId,
            webContents: ctx.webContents,
            userMessage: agent.task,
            projectMode: 'standard'
          }
        )
      } catch (error) {
        result = {
          success: false,
          error: error?.message || String(error),
          aborted: error?.name === 'AbortError'
        }
      }
      pushTool({
        toolCallId,
        name: toolName,
        args: toolArgs,
        status: result?.success === false ? 'error' : 'done',
        result: compactToolResult(result)
      })
      spec.onUpdate?.()
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: JSON.stringify(modelVisibleToolResult(result))
      })
    }
  }

  output = sanitizeFinalContent(agent.output || compactText(messages.filter(item => item.role === 'assistant').map(item => item.content).filter(Boolean).pop(), 2000))
  agent.output = output || '达到队员步数上限，已停止。'
  return { success: Boolean(output), output: agent.output, error: output ? '' : '达到队员步数上限' }
}

module.exports = {
  MAX_WORKER_LOOPS,
  harvestThink,
  runTeamWorker
}
