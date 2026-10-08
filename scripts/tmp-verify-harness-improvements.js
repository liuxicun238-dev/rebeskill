const { classifyHttpStatus, classifyLlmFailure, createLlmRequestError, withLlmRequestRetries, isEmptyModelCompletion, CODES } = require('../electron/modules/chat/llm-error-policy')
const { pruneToolResultText, recoverContextOverflow, PRUNE_MARKER } = require('../electron/modules/chat/context-overflow-recovery')
const { createRepeatToolReminderTracker, canonicalize, GENTLE_REMINDER } = require('../electron/modules/chat/repeat-tool-reminder')
const { hasInternalInstructionLeak } = require('../electron/modules/internal-instruction-filter')

async function main() {
  if (classifyHttpStatus(429, 'slow down').code !== CODES.RATE_LIMIT) {
    throw new Error('429 应分为 RATE_LIMIT')
  }
if (classifyHttpStatus(503, 'bad gateway').code !== CODES.SERVER) {
  throw new Error('5xx 应分为 SERVER')
}
if (classifyHttpStatus(401, 'nope').retryable) {
  throw new Error('401 不应重试')
}
if (classifyHttpStatus(400, 'context_length_exceeded').code !== CODES.CONTEXT_WINDOW_EXCEEDED) {
  throw new Error('超窗 400 应分为 CONTEXT_WINDOW_EXCEEDED')
}
if (classifyLlmFailure({ error: new Error('API错误 429: too many requests') }).code !== CODES.RATE_LIMIT) {
  throw new Error('应从 API错误 429 文案分码')
}

const abortErr = new Error('stop')
abortErr.name = 'AbortError'
if (classifyLlmFailure({ error: abortErr }).retryable) {
  throw new Error('用户取消不应重试')
}

let calls = 0
const retried = await withLlmRequestRetries(async () => {
  calls += 1
  if (calls < 3) {
    throw createLlmRequestError({
      code: CODES.SERVER,
      message: 'API错误 503: unavailable',
      status: 503
    })
  }
  return 'ok'
}, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 })
if (retried !== 'ok' || calls !== 3) {
  throw new Error(`瞬时 5xx 应重试到成功, calls=${calls}`)
}

calls = 0
try {
  await withLlmRequestRetries(async () => {
    calls += 1
    throw createLlmRequestError({
      code: CODES.AUTH,
      message: 'API错误 401: unauthorized',
      status: 401
    })
  }, { maxRetries: 2, initialDelayMs: 1 })
  throw new Error('AUTH 不应被重试吞掉')
} catch (error) {
  if (error.llmCode !== CODES.AUTH) throw error
}
if (calls !== 1) throw new Error('AUTH 只能请求一次')

if (!isEmptyModelCompletion({ content: '', toolCalls: [], reasoning: '' })) {
  throw new Error('空完成应被识别')
}
if (isEmptyModelCompletion({ content: '', toolCalls: [{ id: '1' }], reasoning: '' })) {
  throw new Error('有工具调用不算空完成')
}

const longTool = 'x'.repeat(12000)
const pruned = pruneToolResultText(longTool)
if (!pruned.pruned || !pruned.text.includes(PRUNE_MARKER) || pruned.text.length >= longTool.length) {
  throw new Error('超长工具结果应剪中间段')
}
const messages = [
  { role: 'assistant', tool_calls: [{ id: 'c1' }] },
  { role: 'tool', tool_call_id: 'c1', content: longTool }
]
const recovered = recoverContextOverflow(messages)
if (!recovered.advanced || messages[1].content.length >= longTool.length) {
  throw new Error('溢出恢复应剪工具结果且保留配对')
}
if (messages[0].tool_calls[0].id !== 'c1') {
  throw new Error('溢出恢复不得拆工具配对')
}

const tracker = createRepeatToolReminderTracker()
const args = { path: 'src/app.js' }
if (canonicalize({ b: 1, a: 2 }) !== canonicalize({ a: 2, b: 1 })) {
  throw new Error('参数规范化应忽略键顺序')
}
if (tracker.record('file_read', args).reminder) throw new Error('第 1 次不应提醒')
if (tracker.record('file_read', args).reminder) throw new Error('第 2 次不应提醒')
const third = tracker.record('file_read', args)
if (third.reminder !== GENTLE_REMINDER || third.count !== 3) {
  throw new Error('第 3 次应给轻提醒: ' + JSON.stringify(third))
}
tracker.record('file_read', args)
const fifth = tracker.record('file_read', args)
if (!fifth.reminder.includes('连续次数: 5') || fifth.source.plugin !== 'repeat-tool-reminder') {
  throw new Error('第 5 次应给带身份的详细提醒: ' + JSON.stringify(fifth))
}
if (tracker.record('file_search', args).reminder) {
  throw new Error('换工具应重置计数')
}

if (!hasInternalInstructionLeak(GENTLE_REMINDER)) {
    throw new Error('重复调用提醒泄漏到最终回复时应被滤掉')
  }

  console.log('harness-improvements: retry/overflow/repeat/source OK')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
