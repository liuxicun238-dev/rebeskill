const { test } = require('node:test')
const assert = require('node:assert')
const { parseToolArgs, parseToolCallArgs, buildToolArgsParseErrorResult } = require('../../electron/modules/tool-args-parser')

test('合法 JSON 字符串正常解析', () => {
  const result = parseToolArgs('{"path":"a.txt","content":"hi"}')
  assert.equal(result.ok, true)
  assert.equal(result.args.path, 'a.txt')
  assert.equal(result.error, null)
})

test('对象输入直接透传并序列化为 raw', () => {
  const result = parseToolArgs({ path: 'a.txt' })
  assert.equal(result.ok, true)
  assert.equal(result.args.path, 'a.txt')
  assert.deepEqual(JSON.parse(result.raw), { path: 'a.txt' })
})

test('空值统一归一为空对象', () => {
  for (const empty of [undefined, null, '']) {
    const result = parseToolArgs(empty)
    assert.equal(result.ok, true, `输入 ${JSON.stringify(empty)} 应成功`)
    assert.deepEqual(result.args, {})
  }
})

test('数组被拒绝：工具参数必须是 JSON 对象', () => {
  const result = parseToolArgs('[1,2,3]')
  assert.equal(result.ok, false)
  assert.match(result.error, /数组/)
})

test('截断的 JSON 被识别为 json_truncated（字符串未闭合）', () => {
  const raw = '{"path":"a.txt","content":" unfinished'
  const result = parseToolArgs(raw)
  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'json_truncated')
  assert.match(result.error.message, /截断/)
})

test('截断的 JSON 被识别为 json_truncated（括号未闭合）', () => {
  const result = parseToolArgs('{"a":{"b":1}')
  assert.equal(result.ok, false)
  assert.equal(result.error.reason, 'json_truncated')
})

test('字符串内的括号不误判为截断', () => {
  const result = parseToolArgs('{"code":"if (a) { return }"}')
  assert.equal(result.ok, true, '字符串里的花括号不该算进深度')
})

test('转义引号不破坏字符串边界判断', () => {
  const result = parseToolArgs('{"text":"他说：\\"你好\\""}')
  assert.equal(result.ok, true)
})

test('大文本风险标记：超长内容与 HTML 特征', () => {
  const longRaw = `{"a":"${'x'.repeat(8001)}` // 未闭合的超长 JSON
  assert.equal(parseToolArgs(longRaw).error.isLargeTextRisk, true)

  const parsed = parseToolArgs('{"html":"<!DOCTYPE html>"}')
  assert.equal(parsed.ok, true)
  const badHtml = '{"html":"<!DOCTYPE html><html>' // 未闭合且带 HTML 特征
  assert.equal(parseToolArgs(badHtml).error.isLargeTextRisk, true)
})

test('repairHint 按工具名给出针对性建议', () => {
  const bigText = `{"c":"${'y'.repeat(9000)}` // 未闭合的超长 JSON
  const writeHint = parseToolArgs(bigText, { toolName: 'write_file' }).error.repairHint
  assert.match(writeHint, /text_edit|拆成较小文件块/)

  const shellHint = parseToolArgs(bigText, { toolName: 'shell_run' }).error.repairHint
  assert.match(shellHint, /脚本文件/)

  const unknownHint = parseToolArgs('{"a":', { toolName: 'unknown_tool' }).error.repairHint
  assert.ok(unknownHint.length > 0)
})

test('parseToolCallArgs 兼容 OpenAI function.call 格式', () => {
  const call = { function: { arguments: '{"path":"x"}' } }
  const result = parseToolCallArgs(call)
  assert.equal(result.ok, true)
  assert.equal(result.args.path, 'x')
})

test('parseToolCallArgs 优先使用结构化 args', () => {
  const call = { args: { a: 1 }, function: { arguments: '{"a":2}' } }
  assert.equal(parseToolCallArgs(call).args.a, 1)
})

test('buildToolArgsParseErrorResult 兼容新旧两种 error 格式', () => {
  const structured = buildToolArgsParseErrorResult('write_file', parseToolArgs('{"a":', { toolName: 'write_file' }))
  assert.equal(structured.success, false)
  assert.equal(structured.code, 'invalid_tool_arguments')
  assert.equal(structured.tool_name, 'write_file')
  assert.ok(structured.next_action)

  const legacy = buildToolArgsParseErrorResult('edit_file', { raw: '{"broken":', error: 'not json' })
  assert.equal(legacy.success, false)
  assert.equal(legacy.code, 'invalid_tool_arguments')
  assert.match(legacy.message, /已拒绝执行/)

  const longRaw = 'z'.repeat(800)
  const preview = buildToolArgsParseErrorResult('t', { raw: longRaw, error: 'x' })
  assert.ok(preview.raw_arguments_preview.length < longRaw.length, '超长 raw 应截断为预览')
})
