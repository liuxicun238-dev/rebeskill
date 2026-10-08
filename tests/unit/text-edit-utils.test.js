const { test } = require('node:test')
const assert = require('node:assert')
const {
  countLines,
  countTextOccurrences,
  applyTextEditList,
  shouldBlockFullSourceRewrite,
  isLikelyTextBuffer,
  normalizeLineRange,
  clipTextByChars,
  compileTextEditRegex
} = require('../../electron/modules/text-edit-utils')

test('countLines：多平台换行与空值', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines(null), 0)
  assert.equal(countLines('a\nb'), 2)
  assert.equal(countLines('a\r\nb'), 2)
  assert.equal(countLines('a\rb'), 2)
  assert.equal(countLines('a'), 1)
})

test('countTextOccurrences：重叠不计、空 needle 返回 0', () => {
  assert.equal(countTextOccurrences('a.b.c', '.'), 2)
  assert.equal(countTextOccurrences('aaa', 'aa'), 1, '不重叠计数')
  assert.equal(countTextOccurrences('abc', ''), 0)
  assert.equal(countTextOccurrences('', 'x'), 0)
})

test('applyTextEditList：replace 精确替换', () => {
  const result = applyTextEditList('hello world', [{ op: 'replace', old_content: 'world', new_content: 'lingxi' }])
  assert.equal(result.content, 'hello lingxi')
  assert.equal(result.applied.length, 1)
})

test('applyTextEditList：replace_all 替换全部出现', () => {
  const result = applyTextEditList('a-b-a-b', [{ op: 'replace_all', old_content: 'a', new_content: 'X' }])
  assert.equal(result.content, 'X-b-X-b')
})

test('applyTextEditList：replace_lines 按行替换', () => {
  const source = ['line1', 'line2', 'line3'].join('\n')
  const result = applyTextEditList(source, [{ op: 'replace_lines', start_line: 2, end_line: 2, new_content: 'replaced' }])
  // 已知 quirk：replace_lines 的替换范围不含行尾换行符，新内容会与下一行直接拼接；
  // 想整行替换需要在 new_content 末尾自带 \n。这里固化当前行为。
  assert.equal(result.content, 'line1\nreplacedline3')
  assert.equal(result.applied[0].occurrences, 1)

  const clean = applyTextEditList(source, [{ op: 'replace_lines', start_line: 2, end_line: 2, new_content: 'replaced\n' }])
  assert.equal(clean.content, ['line1', 'replaced', 'line3'].join('\n'), '自带换行即整行替换')
})

test('applyTextEditList：delete 删除文本', () => {
  const result = applyTextEditList('keep REMOVE keep', [{ op: 'delete', old_content: ' REMOVE' }])
  assert.equal(result.content, 'keep keep')
})

test('applyTextEditList：replace 缺少 old_content 抛错', () => {
  assert.throws(() => applyTextEditList('content', [{ op: 'replace', new_content: 'x' }]), /old_content/)
})

test('applyTextEditList：空编辑列表抛错', () => {
  assert.throws(() => applyTextEditList('content', []), /at least one edit/)
})

test('applyTextEditList：未知操作抛错', () => {
  assert.throws(() => applyTextEditList('content', [{ op: 'definitely_not_an_op' }]), /Unsupported text_edit op/)
})

test('shouldBlockFullSourceRewrite：大文件整页重写被拦截', () => {
  // 守卫条件：行数≥80 且 字节数≥2000 两者都满足才拦截
  const bigOld = Array.from({ length: 100 }, (_, i) => `old line ${i} ${'x'.repeat(30)}`).join('\n')
  const bigNew = Array.from({ length: 100 }, (_, i) => `new line ${i} ${'y'.repeat(30)}`).join('\n')
  assert.ok(bigOld.length >= 2000, '测试数据需满足字节数条件')
  assert.equal(shouldBlockFullSourceRewrite('src/app.js', bigOld, bigNew), true, '大文件大改动应拦截')
})

test('shouldBlockFullSourceRewrite：小文件放行', () => {
  assert.equal(shouldBlockFullSourceRewrite('src/app.js', 'const a = 1', 'const a = 2'), false)
})

test('shouldBlockFullSourceRewrite：非守卫扩展名放行', () => {
  const bigOld = Array.from({ length: 100 }, (_, i) => `old ${i}`).join('\n')
  const bigNew = Array.from({ length: 100 }, (_, i) => `new ${i}`).join('\n')
  assert.equal(shouldBlockFullSourceRewrite('data/content.md', bigOld, bigNew), false, 'md 不在守卫扩展名内')
})

test('shouldBlockFullSourceRewrite：显式 allow_full_rewrite 豁免', () => {
  const bigOld = Array.from({ length: 100 }, (_, i) => `old ${i}`).join('\n')
  const bigNew = Array.from({ length: 100 }, (_, i) => `new ${i}`).join('\n')
  assert.equal(shouldBlockFullSourceRewrite('src/app.js', bigOld, bigNew, { allow_full_rewrite: true }), false)
})

test('isLikelyTextBuffer：文本判定为真，含 NUL 字节判定为假', () => {
  assert.equal(isLikelyTextBuffer(Buffer.from('plain text file')), true)
  assert.equal(isLikelyTextBuffer(Buffer.from('')), true, '空缓冲默认按文本处理')
  assert.equal(isLikelyTextBuffer(Buffer.from([0x50, 0x4b, 0x00, 0x01])), false, '含 0 字节视为二进制')
  assert.equal(isLikelyTextBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), true, '高位字节不算可疑')
})

test('normalizeLineRange：缺省、越界与反转修正', () => {
  assert.deepEqual(normalizeLineRange({}, 10), { startLine: 1, endLine: 10, hasRange: false })
  assert.deepEqual(normalizeLineRange({ start_line: 3 }, 10), { startLine: 3, endLine: 10, hasRange: true })
  assert.deepEqual(normalizeLineRange({ start_line: 8, end_line: 99 }, 10), { startLine: 8, endLine: 10, hasRange: true }, '越界裁剪到总行数')
  assert.deepEqual(normalizeLineRange({ start_line: 5, end_line: 2 }, 10), { startLine: 5, endLine: 5, hasRange: true }, 'end 小于 start 时收敛')
  assert.deepEqual(normalizeLineRange({ start_line: -4, end_line: 0 }, 10), { startLine: 1, endLine: 10, hasRange: true }, '负数 start 收敛到 1；falsy 的 end(0) 回退到总行数')
})

test('clipTextByChars：超长裁剪带提示，短文本原样', () => {
  const short = clipTextByChars('hello', 100)
  assert.equal(short.text, 'hello')
  assert.equal(short.truncated, false)

  const long = 'x'.repeat(1000)
  const clipped = clipTextByChars(long, 100)
  assert.equal(clipped.truncated, true)
  assert.ok(clipped.text.length < 200)
  assert.match(clipped.text, /truncated/)
  assert.match(clipped.text, /start_line\/end_line/)
})

test('clipTextByChars：非法 limit 不裁剪', () => {
  assert.equal(clipTextByChars('abc', 0).truncated, false)
  assert.equal(clipTextByChars('abc', -1).truncated, false)
  assert.equal(clipTextByChars('abc', NaN).truncated, false)
})

test('compileTextEditRegex：合法正则可编译并匹配，非法正则抛错', () => {
  const re = compileTextEditRegex('a\\.b', '')
  assert.ok(re.test('xa.by'))
  const withFlags = compileTextEditRegex('ABC', 'i')
  assert.ok(withFlags.test('abc'))
  assert.throws(() => compileTextEditRegex('([unclosed', ''), Error)
})
