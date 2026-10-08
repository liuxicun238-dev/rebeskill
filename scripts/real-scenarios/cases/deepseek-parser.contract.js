const path = require('path')
const { spawn } = require('child_process')

/**
 * 运行 scripts/real-scenarios/fixtures/deepseek-parser-suite.js
 * （30+ 个真实场景的 DeepSeek 工具调用解析断言）
 * 纳入 real-scenarios 用例体系：以子进程方式运行，退出码非 0 或缺少 PASS 标记即失败。
 */
module.exports = {
  id: 'deepseek-parser.contract',
  title: 'DeepSeek tool-call parser regression suite (30+ real scenarios)',
  tags: ['deepseek', 'parser', 'tools', 'contract'],
  changedFilePatterns: [
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/modules\/web-bridge-coding-protocol\.js$/i,
    /^scripts\/real-scenarios\/fixtures\/deepseek-parser-suite\.js$/i
  ],

  async run(ctx) {
    const scriptPath = path.join(
      ctx.root,
      'scripts',
      'real-scenarios',
      'fixtures',
      'deepseek-parser-suite.js'
    )
    ctx.assert.ok(require('fs').existsSync(scriptPath), `parser suite script should exist: ${scriptPath}`)

    const child = spawn(process.execPath, [scriptPath], {
      cwd: ctx.root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let exitInfo = null
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.on('exit', (code, signal) => { exitInfo = { code, signal } })

    const deadline = Date.now() + 60000
    while (!exitInfo && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!exitInfo) {
      child.kill()
      ctx.assert.fail('parser suite should finish within 60 seconds')
    }

    ctx.assert.equal(exitInfo.code, 0, `parser suite should exit 0; output tail: ${output.slice(-2000)}`)
    ctx.assert.ok(output.includes('DeepSeek tool-call parser PASS'), `parser suite should report PASS; output tail: ${output.slice(-2000)}`)
  }
}
