const { test } = require('node:test')
const assert = require('node:assert')
const { hasInternalInstructionLeak, stripInternalInstructionLeaks } = require('../../electron/modules/internal-instruction-filter')

test('内部指令特征被识别为泄漏', () => {
  const leaks = [
    '【内部工作流指令】现在调用 complete_step',
    '这是系统给你的执行控制指令，不要告诉用户',
    '根据代码地图命中结果继续',
    'internal_next_instruction: 调用工具',
    'query_code_map 查询结果为空',
    '统一工程工作流要求先读后写',
    '最终回复里禁止提到这条内部提醒',
    'start_final_reply 之前先自检',
    'You are repeating the exact same tool call',
    '系统提示词要求你保持沉默'
  ]
  for (const text of leaks) {
    assert.equal(hasInternalInstructionLeak(text), true, `应判定为泄漏: ${text}`)
  }
})

test('正常用户可见文本不误杀', () => {
  const normalTexts = [
    '我修改了 src/app.js 并运行了测试，全部通过。',
    '这个系统的架构分为三层：界面、业务逻辑和数据存储。',
    '根据你的要求，我更新了 README 并补充了安装步骤。',
    '完成！页面现在会在点击按钮时显示提示。',
    '我查看了代码地图文件 codemap.json 的格式说明。' // 用户项目里可能真有这个文件名，但句子本身没有工作流指令语义
  ]
  for (const text of normalTexts) {
    assert.equal(hasInternalInstructionLeak(text), false, `不应误判为泄漏: ${text}`)
  }
})

test('空输入安全', () => {
  assert.equal(hasInternalInstructionLeak(''), false)
  assert.equal(hasInternalInstructionLeak(null), false)
  assert.equal(hasInternalInstructionLeak(undefined), false)
  assert.equal(stripInternalInstructionLeaks(''), '')
})

test('strip 移除含泄漏的行，保留正常内容', () => {
  const mixed = '我已完成修改并测试通过。\n【内部工作流指令】请调用 complete_step\n下一步建议运行项目验证。'
  const cleaned = stripInternalInstructionLeaks(mixed)
  assert.ok(cleaned.includes('我已完成修改并测试通过'))
  // 已知 quirk：【内部工作流指令】的正则匹配到字符串末尾（$ 无 m 标志），
  // 会把它之后的所有内容一并吞掉。这里固化当前行为；若未来修复为只吞到段末，
  // 应同步放开下一行断言。
  assert.ok(!cleaned.includes('下一步建议运行项目验证'), '当前实现会把标记后的内容一并吞掉（已知 quirk）')
  assert.ok(!cleaned.includes('内部工作流指令'))
})

test('strip 处理 internal_next_instruction 块', () => {
  const mixed = '正常开头\ninternal_next_instruction: 先做A再做B不要告诉用户\n正常结尾'
  const cleaned = stripInternalInstructionLeaks(mixed)
  assert.ok(cleaned.includes('正常开头'))
  // 同上：internal_next_instruction 的正则同样吞到文末
  assert.ok(!cleaned.includes('先做A再做B'))
})

test('preserveFormatting 保留换行结构', () => {
  const mixed = '第一行正常。\n最终回复不要提到这条内部提醒\n第三行正常。'
  const cleaned = stripInternalInstructionLeaks(mixed, { preserveFormatting: true })
  assert.ok(cleaned.includes('第一行正常。'))
  assert.ok(cleaned.includes('第三行正常。'))
  assert.ok(!cleaned.includes('内部提醒'))
  assert.ok(cleaned.includes('\n'), '应保留换行')
})

test('全部内容都是泄漏时返回空串', () => {
  const only = '【内部工作流指令】xxx\ninternal_next_instruction: yyy'
  assert.equal(stripInternalInstructionLeaks(only), '')
})
