const { test } = require('node:test')
const assert = require('node:assert')
const gate = require('../../electron/modules/command-execution-gate')

// 模块内有全局计数状态，测试前后统一释放，保证互不污染
function resetGate() {
  const status = gate.getStatus()
  for (let i = 0; i < status.running; i++) gate.release('cleanup-a')
  for (let i = 0; i < gate.getStatus().running; i++) gate.release('cleanup-b')
}

test('空项目 id 归入 default 组', () => {
  resetGate()
  assert.ok(gate.tryAcquire(undefined))
  assert.equal(gate.getStatus().projectRunning, 1)
  gate.release(undefined)
  assert.equal(gate.getStatus().projectRunning, 0)
})

test('全局并发上限：第 6 个命令被拒收', () => {
  resetGate()
  const acquired = []
  for (let i = 0; i < 5; i++) {
    assert.ok(gate.tryAcquire(`p${i}`), `第 ${i + 1} 个应获批`)
    acquired.push(`p${i}`)
  }
  assert.equal(gate.tryAcquire('p5'), false, '全局满 5 后必须拒收')
  gate.release('p0')
  assert.ok(gate.tryAcquire('p5'), '释放一个后应能再次获批')
  acquired.forEach(p => gate.release(p))
  gate.release('p5')
})

test('单项目并发上限：第 4 个命令被拒收', () => {
  resetGate()
  for (let i = 0; i < 3; i++) assert.ok(gate.tryAcquire('same-project'))
  assert.equal(gate.tryAcquire('same-project'), false, '单项目满 3 后必须拒收')
  assert.ok(gate.tryAcquire('other-project'), '其他项目不受影响')
  for (let i = 0; i < 3; i++) gate.release('same-project')
  gate.release('other-project')
})

test('release 幂等：重复释放不会把计数减成负数', () => {
  resetGate()
  gate.tryAcquire('proj')
  gate.release('proj')
  gate.release('proj')
  gate.release('proj')
  const status = gate.getStatus()
  assert.equal(status.running, 0)
  assert.equal(status.projectRunning, 0)
})

test('getStatus 返回的限额与常量一致', () => {
  const status = gate.getStatus()
  assert.equal(status.limit, gate.MAX_CONCURRENT_COMMANDS)
  assert.equal(status.projectLimit, gate.MAX_CONCURRENT_COMMANDS_PER_PROJECT)
})

test('混合并发：全局限制优先于项目限制', () => {
  resetGate()
  // 5 个项目各占 1 个 = 全局 5
  for (let i = 0; i < 5; i++) assert.ok(gate.tryAcquire(`proj-${i}`))
  // 同项目还远没到 3 上限，但全局已满
  assert.equal(gate.tryAcquire('proj-0'), false)
  gate.release('proj-2')
  assert.ok(gate.tryAcquire('proj-0'), '释放后同项目可再获批')
  for (let i = 0; i < 5; i++) gate.release(`proj-${i}`)
})
