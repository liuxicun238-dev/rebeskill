/**
 * 每一步发给模型的可见视图：稳定前缀 + 用户消息尾部运行时 + 带来源的指令。
 * 新的催续/摘要/计划条从这里进请求，不在循环里另开一种前缀。
 */

const planProgress = require('../plan-progress')
const projectInspectEvidence = require('../project-inspect-evidence')
const searchAbsence = require('./search-absence')
const { buildExplorationStrategyNudge } = require('./exploration-strategy')

const TAIL_HEADING = '【本轮动态执行上下文】'
const INSTRUCTION_HEADING = '【内部工作流指令】'

function createSource(plugin, extra = null) {
  const source = extra && typeof extra === 'object' && extra.kind
    ? extra
    : { kind: 'plugin', plugin: String(plugin || 'workflow') }
  return source
}

function normalizeSection(item, fallbackPlugin = 'runtime') {
  if (!item) return null
  if (typeof item === 'string') {
    const content = item.trim()
    return content ? { plugin: fallbackPlugin, content } : null
  }
  const content = String(item.content || '').trim()
  if (!content) return null
  return {
    plugin: String(item.plugin || fallbackPlugin),
    content,
    source: item.source || createSource(item.plugin || fallbackPlugin)
  }
}

function buildRuntimeTailSections(parts = {}) {
  const sections = [
    { plugin: 'runtime-context', content: parts.runtimeContext },
    { plugin: 'plan-progress', content: parts.planProgress },
    { plugin: 'inspect-evidence', content: parts.inspectContext },
    { plugin: 'task-ledger', content: parts.ledgerIndex },
    ...(Array.isArray(parts.runtimeSystemMessages) ? parts.runtimeSystemMessages.map((content, index) => ({
      plugin: `runtime-system-${index + 1}`,
      content
    })) : []),
    { plugin: 'memory', content: parts.memoryContext },
    { plugin: 'design-style', content: parts.designStyleContext },
    { plugin: 'care-reminder', content: parts.careHint }
  ]
  return sections.map(item => normalizeSection(item)).filter(Boolean)
}

function appendGuidanceToLatestUserMessage(messages = [], guidance = '', options = {}) {
  const text = String(guidance || '').trim()
  if (!text || !Array.isArray(messages)) return false
  const source = options.source || createSource(options.plugin || 'runtime-tail')
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const existing = Array.isArray(message.content)
      ? message.content.map(part => String(part?.text || '')).join('\n')
      : String(message.content || '')
    if (existing.includes(text)) return false
    const suffix = options.heading === false
      ? `\n${text}`
      : `\n\n${TAIL_HEADING}\n${text}`
    if (Array.isArray(message.content)) {
      message.content = [...message.content, { type: 'text', text: suffix.trim() }]
    } else {
      message.content = `${String(message.content || '')}${suffix}`
    }
    message._lingxiSource = source
    return true
  }
  return false
}

function applyRuntimeTail(messages, sections = [], options = {}) {
  if (options.webBridge) {
    const projectPath = String(options.projectPath || '').trim()
    if (!projectPath) return { applied: false, text: '', sectionCount: 0, webBridge: true }
    const text = `当前项目路径：${projectPath.replace(/\\/g, '/')}`
    const applied = appendGuidanceToLatestUserMessage(messages, text, {
      heading: false,
      source: createSource('runtime-path')
    })
    return { applied, text, sectionCount: applied ? 1 : 0, webBridge: true }
  }
  const normalized = (Array.isArray(sections) ? sections : [])
    .map(item => normalizeSection(item))
    .filter(Boolean)
  const text = normalized.map(item => item.content).join('\n\n')
  const applied = appendGuidanceToLatestUserMessage(messages, text, {
    heading: options.heading !== false,
    source: createSource('runtime-tail')
  })
  return { applied, text, sectionCount: normalized.length, webBridge: false }
}

function assembleInitialStepView(options = {}) {
  const history = Array.isArray(options.requestHistory) ? options.requestHistory : []
  const sections = Array.isArray(options.runtimeSections)
    ? options.runtimeSections
    : buildRuntimeTailSections(options.runtimeParts || {})
  const tail = applyRuntimeTail(history, sections, {
    webBridge: options.webBridge === true,
    projectPath: options.projectPath,
    heading: options.heading
  })
  return {
    history,
    extraSystemMessages: (Array.isArray(options.extraSystemMessages) ? options.extraSystemMessages : []).filter(Boolean),
    prioritySystemMessages: (Array.isArray(options.prioritySystemMessages) ? options.prioritySystemMessages : []).filter(Boolean),
    tail,
    runtimeSections: sections
  }
}

function pushStepInstruction(messages, content, options = {}) {
  const text = String(content || '').trim()
  if (!text || !Array.isArray(messages)) return false
  const origin = createSource(options.plugin, options.source)
  const apiFormat = String(options.apiFormat || '')
  if (apiFormat === 'anthropic') {
    const wrapped = [
      INSTRUCTION_HEADING,
      '这是系统给你的执行控制指令，不是用户发言。最终回复里禁止提到内部机制。',
      text
    ].join('\n')
    const last = messages[messages.length - 1]
    if (last && last.role === 'tool') {
      try {
        const payload = JSON.parse(String(last.content || '{}'))
        last.content = JSON.stringify({ ...payload, internal_next_instruction: text })
      } catch {
        last.content = `${String(last.content || '')}\n\ninternal_next_instruction: ${text}`.trim()
      }
      last._lingxiSource = origin
      return true
    }
    const lastHasToolResult = last && last.role === 'user' && Array.isArray(last.content) && last.content.some(part => part?.type === 'tool_result')
    if (last && last.role === 'user' && !lastHasToolResult) {
      if (Array.isArray(last.content)) {
        last.content.push({ type: 'text', text: wrapped })
      } else {
        last.content = `${String(last.content || '')}\n\n${wrapped}`.trim()
      }
      last._lingxiSource = origin
      return true
    }
    messages.push({ role: 'user', content: wrapped, _lingxiSource: origin })
    return true
  }
  messages.push({
    role: 'system',
    content: [
      INSTRUCTION_HEADING,
      '这是系统给你的执行控制指令，不是用户发言。',
      '最终回复里禁止提到“用户指出”“最终质检未通过”“统一工程工作流”“内部指令”等内部机制。',
      text
    ].join('\n'),
    _lingxiSource: origin
  })
  return true
}

function applyStepInstructions(messages, instructions = [], options = {}) {
  const applied = []
  for (const item of Array.isArray(instructions) ? instructions : []) {
    const content = String(item?.content || '').trim()
    if (!content) continue
    pushStepInstruction(messages, content, {
      apiFormat: options.apiFormat,
      plugin: item.plugin,
      source: item.source
    })
    applied.push(item)
    options.onApply?.(item)
  }
  return applied
}

function collectPostToolInstructions(input = {}) {
  if (input.webBridge) return []
  const instructions = []
  const toolResults = Array.isArray(input.toolResults) ? input.toolResults : []

  for (const { toolName, result } of toolResults) {
    if (result?.status === 'user_rejected') {
      instructions.push({
        plugin: 'permission',
        content: [
          `工具 ${toolName} 被用户拒绝或取消：${result.message || '用户未授权执行。'}`,
          '这不是最终回复。请基于已完成的真实工具结果继续处理或收尾。',
          '如果本轮已经修改了文件，最终回复必须简洁说明改了什么；不要只复述这个工具状态。'
        ].join('\n')
      })
    } else if (result?.executionMode && typeof input.getExecutionModeDesc === 'function') {
      const rules = typeof input.getExecutionModeRules === 'function'
        ? input.getExecutionModeRules(result.executionMode)
        : ''
      instructions.push({
        plugin: 'execution-mode',
        content: `用户已将后续执行模式切换为：${input.getExecutionModeDesc(result.executionMode)}。后续必须遵守以下规则：\n${rules}`
      })
    }
  }

  if (input.stopInstruction) {
    instructions.push({
      plugin: 'tool-failure-recovery',
      content: String(input.stopInstruction)
    })
  }

  const explorationNudge = buildExplorationStrategyNudge({
    userMessage: input.userMessage,
    toolCallsRecord: input.toolCallsRecord,
    emittedKeys: input.explorationNudgeKeys
  })
  if (explorationNudge?.content) {
    instructions.push({
      plugin: 'exploration-strategy',
      content: explorationNudge.content,
      key: explorationNudge.key,
      keepLoop: true,
      event: 'exploration_strategy_nudge',
      eventPayload: { key: explorationNudge.key }
    })
  }

  const planCheckpoint = planProgress.buildPlanProgressNudge(input.projectId, {
    toolCallsThisBatch: input.toolCallsThisBatch
  })
  if (planCheckpoint) {
    instructions.push({
      plugin: 'plan-progress',
      content: planCheckpoint,
      event: 'plan_progress_nudge',
      eventPayload: {
        currentStepIndex: planProgress.getPlan(input.projectId)?.currentStepIndex ?? null
      }
    })
  }

  if (!input.inspectDocsNudgeUsed) {
    const inspectNudge = projectInspectEvidence.buildDocsOnlyInspectNudge(input.userMessage, input.toolCallsRecord)
    if (inspectNudge) {
      instructions.push({
        plugin: 'inspect-evidence',
        content: inspectNudge,
        markInspectUsed: true,
        event: 'inspect_docs_only_nudge',
        eventPayload: {
          implReadCount: projectInspectEvidence.collectInspectEvidence(input.toolCallsRecord).implReadCount
        }
      })
    }
  }

  if (!input.wiringNudgeUsed) {
    const wiringNudge = searchAbsence.buildWiringNudge(input.userMessage, input.toolCallsRecord, input.projectPath)
    if (wiringNudge) {
      instructions.push({
        plugin: 'search-absence',
        content: wiringNudge,
        source: searchAbsence.PLUGIN_SOURCE,
        markWiringUsed: true,
        event: 'search_absence_wiring_nudge'
      })
    }
  }

  if (input.repeatTracker && typeof input.repeatTracker.record === 'function') {
    let repeatReminder = null
    for (const { toolName, toolArgs, result } of toolResults) {
      if (result?.internal || result?.aborted) continue
      const observed = input.repeatTracker.record(toolName, toolArgs)
      if (observed.reminder) repeatReminder = observed
    }
    if (repeatReminder?.reminder) {
      instructions.push({
        plugin: 'repeat-tool-reminder',
        content: repeatReminder.reminder,
        source: repeatReminder.source,
        event: 'repeat_tool_reminder',
        eventPayload: {
          toolName: repeatReminder.toolName,
          count: repeatReminder.count
        }
      })
    }
  }

  return instructions
}

function collectPreFinalInstructions(input = {}) {
  if (input.webBridge) return []

  if (!input.inspectDocsNudgeUsed) {
    const inspectFinalNudge = projectInspectEvidence.buildInspectFinalNudge(input.userMessage, input.toolCallsRecord)
    if (inspectFinalNudge) {
      return [{
        plugin: 'inspect-evidence',
        content: inspectFinalNudge,
        markInspectUsed: true,
        keepLoop: true,
        resetFinal: true,
        event: 'inspect_docs_only_final_nudge',
        eventPayload: {
          implReadCount: projectInspectEvidence.collectInspectEvidence(input.toolCallsRecord).implReadCount
        }
      }]
    }
  }

  if (!input.wiringNudgeUsed) {
    const wiringFinalNudge = searchAbsence.buildWiringFinalNudge(input.userMessage, input.toolCallsRecord, input.projectPath)
    if (wiringFinalNudge) {
      return [{
        plugin: 'search-absence',
        content: wiringFinalNudge,
        source: searchAbsence.PLUGIN_SOURCE,
        markWiringUsed: true,
        keepLoop: true,
        resetFinal: true,
        event: 'search_absence_wiring_final_nudge'
      }]
    }
  }

  if (!input.planFinalNudgeUsed && Array.isArray(input.toolCallsRecord) && input.toolCallsRecord.length > 0) {
    const planFinalNudge = planProgress.buildPlanFinalNudge(input.projectId)
    if (planFinalNudge) {
      return [{
        plugin: 'plan-progress',
        content: planFinalNudge,
        markPlanFinalUsed: true,
        keepLoop: true,
        resetFinal: true,
        event: 'plan_progress_final_nudge',
        eventPayload: {
          currentStepIndex: planProgress.getPlan(input.projectId)?.currentStepIndex ?? null
        }
      }]
    }
  }

  return []
}

module.exports = {
  TAIL_HEADING,
  INSTRUCTION_HEADING,
  createSource,
  buildRuntimeTailSections,
  appendGuidanceToLatestUserMessage,
  applyRuntimeTail,
  assembleInitialStepView,
  pushStepInstruction,
  applyStepInstructions,
  collectPostToolInstructions,
  collectPreFinalInstructions
}
