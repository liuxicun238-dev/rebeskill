const path = require('path')
const root = path.join(__dirname, '..')
const toolPairing = require(path.join(root, 'electron/modules/chat/tool-pairing'))
const compression = require(path.join(root, 'electron/modules/context-compression'))
const workerModel = require(path.join(root, 'electron/modules/worker-model'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const completePair = [
  { role: 'user', content: '修这个' },
  { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{"path":"a.js"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
  { role: 'assistant', content: '已读完' }
]

assert(toolPairing.isPairingBalanced(completePair, 0, completePair.length), '完整配对应为 balanced')
assert(
  toolPairing.snapExclusiveEndToPairingBoundary(completePair, 0, completePair.length) === completePair.length,
  '完整配对的切开点应停在末尾'
)

const holeBeforeFinal = [
  { role: 'user', content: '修这个' },
  { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } }] },
  { role: 'assistant', content: '我先口头说一下' },
  { role: 'user', content: '继续' }
]
const snapped = toolPairing.snapExclusiveEndToPairingBoundary(holeBeforeFinal, 0, 3)
assert(snapped === 0, `未完成 tool 配对不得切进该轮，got ${snapped}`)
assert(toolPairing.isPairingBalanced(holeBeforeFinal, 0, 1), '只有丢掉未完成 tool_calls 后才配对完整')
assert(!toolPairing.isPairingBalanced(holeBeforeFinal, 0, 3), '缺 tool 结果的前缀不合法')

const twoTurnsSecondHole = [
  ...completePair,
  { role: 'user', content: '第二轮' },
  { role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'file_edit', arguments: '{}' } }] },
  { role: 'assistant', content: '写完了但结果没回来' },
  { role: 'user', content: '第三轮' }
]
const secondCut = toolPairing.snapExclusiveEndToPairingBoundary(twoTurnsSecondHole, 0, 8)
assert(secondCut === 4, `第二轮配对不完整时应停在第一轮结束后的用户边界，got ${secondCut}`)
assert(twoTurnsSecondHole[secondCut]?.role === 'user', '合法切开点应落在下一轮用户消息')

const prefix = compression.buildPrefixReusingCompactionMessages({
  leadingSystemMessages: [
    { role: 'system', content: '你是灵犀，稳定系统提示。' },
    { role: 'system', content: '【压缩摘要】旧摘要' }
  ],
  historySlice: completePair,
  prompt: '{"topic":"x"}'
})
assert(prefix[0]?.role === 'system' && prefix[0].content.includes('稳定系统提示'), '摘要请求应复用主对话 system 前缀')
assert(prefix[1]?.content.includes('【压缩摘要】'), '已有摘要块应跟在稳定 system 后面')
assert(prefix[prefix.length - 1]?.role === 'user', '压缩指令必须是最后一条 user')
assert(prefix[prefix.length - 1].content.includes('不要调用任何工具'), '压缩指令应禁止工具调用')
assert(!prefix[0].content.includes('你是上下文压缩整理员'), '复用前缀时不得把整理员 system 放到请求最前面')
const assistantWithTools = prefix.find(item => item.role === 'assistant' && Array.isArray(item.tool_calls))
assert(assistantWithTools?.tool_calls[0]?.id === 'c1', '前缀应原样回放 tool_calls，而不是拍成一段 transcript')
assert(!prefix.some(item => item._lingxiSource), '发给模型的前缀不应携带内部 source 字段')

const resolved = workerModel.resolveSummarizeJsonRequest({
  system: '你是上下文压缩整理员，只输出 JSON。',
  prompt: '请输出 JSON',
  prefixMessages: prefix
})
assert(resolved.workerMessages[0].content.includes('压缩整理员'), '独立 worker 仍用短提示')
assert(resolved.currentModelMessages === prefix, '当前任务模型回退应走复用前缀')
assert(resolved.reuseConversationPrefix && resolved.promptCache && resolved.includeTools, '复用前缀时应打开缓存并携带 tools')

const cold = workerModel.resolveSummarizeJsonRequest({
  system: '只输出 JSON。',
  prompt: 'x'
})
assert(cold.currentModelMessages === cold.workerMessages, '无前缀时回退短请求')
assert(!cold.reuseConversationPrefix && !cold.promptCache, '无前缀时不应假装命中缓存')

const evidence = toolPairing.collectCompletedToolEvidence([
  { role: 'assistant', tool_calls: [{ id: 'c3', function: { name: 'file_read', arguments: '{"path":"b.js"}' } }] },
  { role: 'tool', tool_call_id: 'c3', content: 'done' },
  { role: 'assistant', tool_calls: [{ id: 'c4', function: { name: 'file_edit', arguments: '{}' } }] }
])
assert(evidence.some(line => line.includes('file_read') && !line.includes('尚未返回')), '已返回的调用应记完整证据')
assert(evidence.some(line => line.includes('file_edit') && line.includes('尚未返回')), '未返回的调用不得写成已完成')

console.log('compaction-prefix: pairing cut + prefix reuse OK')
