/**
 * 顺序污染二分器：单进程内按 runner 顺序执行用例前缀 + 受害者，
 * 找出最小污染前缀。用法：
 *   node scripts/real-scenarios/bisect-pollution.js <victimCaseId> <prefixEndIndex>
 */
const path = require('path')
const assert = require('./helpers/assert')
const { createScenarioWorkspace, writeText } = require('./helpers/temp-project')
const { loadCases } = require('./registry')

const root = path.resolve(__dirname, '../..')
const victimId = process.argv[2] || 'capability.stable-entrypoints'
const prefixEnd = Number.parseInt(process.argv[3] || '0', 10)

async function runCase(testCase) {
  const ctx = {
    root,
    assert,
    createWorkspace: scenarioId => createScenarioWorkspace(root, scenarioId),
    writeText
  }
  await testCase.run(ctx)
}

async function main() {
  const cases = loadCases()
  const victimIndex = cases.findIndex(c => c.id === victimId)
  if (victimIndex < 0) { console.error('victim not found'); process.exit(2) }
  const end = prefixEnd > 0 ? Math.min(prefixEnd, victimIndex) : victimIndex
  process.stderr.write(`running prefix [0..${end}) + victim "${victimId}" (index ${victimIndex})\n`)
  for (let i = 0; i < end; i++) {
    try { await runCase(cases[i]); process.stderr.write(`  ok  ${cases[i].id}\n`) }
    catch (e) { process.stderr.write(`  ERR ${cases[i].id}: ${e.message}\n`) }
  }
  try {
    await runCase(cases[victimIndex])
    console.log(`RESULT: PASS (prefix ${end})`)
  } catch (e) {
    console.log(`RESULT: FAIL (prefix ${end}) -> ${e.message}`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
