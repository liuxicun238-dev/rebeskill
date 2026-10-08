const { test } = require('node:test')
const assert = require('node:assert')
const {
  messageFingerprint,
  assignMessageIdentity,
  groupByRound,
  applyStoredIdentityOverlap,
  findPersistedPrefixLength
} = require('../../electron/modules/chat-message-identity')

test('messageFingerprint：相同内容指纹一致，内容变化指纹变化', () => {
  const a = { role: 'user', content: '你好' }
  const b = { role: 'user', content: '你好' }
  const c = { role: 'user', content: '再见' }
  assert.equal(messageFingerprint(a), messageFingerprint(b))
  assert.notEqual(messageFingerprint(a), messageFingerprint(c))
})

test('messageFingerprint：role 与 tool_call_id 参与指纹', () => {
  const base = { content: 'x' }
  const withRole = { role: 'assistant', content: 'x' }
  const withToolCallId = { role: 'assistant', content: 'x', tool_call_id: 'call-1' }
  assert.notEqual(messageFingerprint(base), messageFingerprint(withRole))
  assert.notEqual(messageFingerprint(withRole), messageFingerprint(withToolCallId))
})

test('assignMessageIdentity：每条消息都拿到 roundId 和 messageId', () => {
  const messages = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: '追问' }
  ]
  const assigned = assignMessageIdentity(messages)
  assert.equal(assigned.length, 3)
  for (const m of assigned) {
    assert.ok(m.roundId, 'roundId 应被赋值')
    assert.ok(m.messageId, 'messageId 应被赋值')
  }
})

test('assignMessageIdentity：同一轮的消息共享 roundId', () => {
  const assigned = assignMessageIdentity([
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答一' },
    { role: 'assistant', content: '回答二' }
  ])
  assert.equal(assigned[0].roundId, assigned[1].roundId)
  assert.equal(assigned[1].roundId, assigned[2].roundId)
  assert.equal(assigned[0].roundId, assigned[2].roundId, '三条都在同一轮')
})

test('assignMessageIdentity：deterministic 模式下相同输入得到相同 id', () => {
  const input = [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '回答' }
  ]
  const a = assignMessageIdentity(structuredClone(input), { deterministic: true, sessionId: 's1' })
  const b = assignMessageIdentity(structuredClone(input), { deterministic: true, sessionId: 's1' })
  assert.deepEqual(a.map(m => m.messageId), b.map(m => m.messageId))
  assert.deepEqual(a.map(m => m.roundId), b.map(m => m.roundId))
})

test('assignMessageIdentity：hidden 用户消息不开新轮', () => {
  const assigned = assignMessageIdentity([
    { role: 'user', content: '第一轮' },
    { role: 'user', content: '隐藏注入', hidden: true },
    { role: 'assistant', content: '回复' }
  ])
  assert.equal(assigned[1].roundId, assigned[0].roundId, 'hidden 消息沿用当前轮')
})

test('assignMessageIdentity：非数组与字符串元素容错', () => {
  const assigned = assignMessageIdentity('not-an-array')
  assert.deepEqual(assigned, [])
  const assigned2 = assignMessageIdentity(['纯字符串消息'])
  assert.equal(assigned2[0].role, 'assistant')
  assert.equal(assigned2[0].content, '纯字符串消息')
})

test('groupByRound：按 roundId 分组且保持顺序', () => {
  const grouped = groupByRound([
    { roundId: 'r1', content: 'a' },
    { roundId: 'r1', content: 'b' },
    { roundId: 'r2', content: 'c' },
    { roundId: 'r1', content: 'd' } // 不同位置相同 roundId 形成新组
  ])
  assert.equal(grouped.length, 3)
  assert.deepEqual(grouped.map(g => g.roundId), ['r1', 'r2', 'r1'])
  assert.deepEqual(grouped[0].messages.map(m => m.content), ['a', 'b'])
})

test('applyStoredIdentityOverlap：快照尾部与存储头部重叠时继承 id', () => {
  const stored = assignMessageIdentity([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }
  ], { deterministic: true, sessionId: 's' })
  const snapshot = assignMessageIdentity([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' }
  ], { deterministic: true, sessionId: 's-other' })
  const overlap = applyStoredIdentityOverlap(stored, snapshot)
  assert.equal(overlap, 3)
  assert.equal(snapshot[0].messageId, stored[0].messageId)
  assert.equal(snapshot[2].roundId, stored[2].roundId)
  assert.ok(snapshot[3].messageId, '新增消息仍应有自己的 id')
})

test('findPersistedPrefixLength：无重叠时按最后存储消息定位', () => {
  const stored = assignMessageIdentity([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' }
  ], { deterministic: true, sessionId: 's2' })
  // 快照从中间开始（存储的前缀被裁掉了一部分）
  const snapshot = [
    { role: 'user', content: 'q0' },
    { role: 'assistant', content: 'a0' },
    stored[1] // 最后一条存储消息在快照 index 2
  ]
  const prefix = findPersistedPrefixLength(stored, snapshot)
  assert.equal(prefix, 3)
})
