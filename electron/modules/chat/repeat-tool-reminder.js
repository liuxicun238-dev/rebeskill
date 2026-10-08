/**
 * 同名同参连续成功调用提醒。只注入带身份的上下文，不否决当前这次调用。
 */

const DEFAULT_THRESHOLDS = Object.freeze([3, 5, 8])
const DEFAULT_PREVIEW_CHARS = 500
const SKIP_TOOLS = new Set([
  'show_thinking_note',
  'report_progress',
  'start_final_reply',
  'complete_step',
  'confirm_plan',
  'enter_plan_mode',
  'ask_user_choice',
  'record_ai_operation_memo'
])

const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: 'repeat-tool-reminder' })

const GENTLE_REMINDER = '同一工具调用（相同参数）已连续重复。请先分析上一次结果：若任务未完成，换参数或换方法，不要原样再调一次。'

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJsonValue(value[key])
    }
    return sorted
  }
  return value
}

function canonicalize(argumentsValue) {
  if (typeof argumentsValue === 'string') {
    const text = argumentsValue.trim()
    try {
      return JSON.stringify(sortJsonValue(JSON.parse(text)))
    } catch {
      return text
    }
  }
  try {
    return JSON.stringify(sortJsonValue(argumentsValue ?? {}))
  } catch {
    return String(argumentsValue || '')
  }
}

function previewArguments(canonical, cap) {
  const text = String(canonical || '')
  const limit = Math.max(40, Number(cap) || DEFAULT_PREVIEW_CHARS)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… (+${text.length - limit} more chars)`
}

function detailedReminder(toolName, count, canonicalArguments, previewChars) {
  return [
    '检测到重复工具调用：',
    `- 工具: ${toolName}`,
    `- 连续次数: ${count}`,
    `- 参数: ${previewArguments(canonicalArguments, previewChars)}`,
    '这些重复没有推进任务。不要再用完全相同的参数调用该工具。检查最近一次结果，改用不同动作、不同参数，或在证据已够时收尾。'
  ].join('\n')
}

function createRepeatToolReminderTracker(options = {}) {
  const thresholds = (Array.isArray(options.thresholds) && options.thresholds.length
    ? options.thresholds
    : DEFAULT_THRESHOLDS)
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value >= 2)
  const uniqueThresholds = [...new Set(thresholds)].sort((a, b) => a - b)
  const activeThresholds = uniqueThresholds.length ? uniqueThresholds : [...DEFAULT_THRESHOLDS]
  const previewChars = Math.max(40, Number(options.argumentsPreviewChars) || DEFAULT_PREVIEW_CHARS)

  let chainKey = ''
  let count = 0

  function record(toolName, args) {
    const name = String(toolName || '').trim()
    if (!name || SKIP_TOOLS.has(name)) {
      return { count: 0, reminder: '', source: PLUGIN_SOURCE }
    }
    const key = `${name}::${canonicalize(args)}`
    if (key === chainKey) count += 1
    else {
      chainKey = key
      count = 1
    }
    if (!activeThresholds.includes(count)) {
      return { count, reminder: '', source: PLUGIN_SOURCE, toolName: name }
    }
    const reminder = count === activeThresholds[0]
      ? GENTLE_REMINDER
      : detailedReminder(name, count, canonicalize(args), previewChars)
    return { count, reminder, source: PLUGIN_SOURCE, toolName: name }
  }

  function reset() {
    chainKey = ''
    count = 0
  }

  return { record, reset }
}

module.exports = {
  PLUGIN_SOURCE,
  GENTLE_REMINDER,
  SKIP_TOOLS,
  canonicalize,
  createRepeatToolReminderTracker
}
