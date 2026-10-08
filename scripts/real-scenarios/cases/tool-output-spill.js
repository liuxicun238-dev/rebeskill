const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'tool-output.spill-oversize',
  title: 'Oversized tool output spills to a project file and keeps a head/tail preview',
  tags: ['tools', 'spill', 'context'],
  changedFilePatterns: [
    /^electron\/modules\/chat\/tool-output-spill\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/modules\/chat\/tool-result-summarizer\.js$/i
  ],

  async run(ctx) {
    const spill = require(path.join(ctx.root, 'electron/modules/chat/tool-output-spill'))
    const workspace = ctx.createWorkspace(this.id)
    const stdout = `${'line\n'.repeat(4000)}UNIQUE_TAIL_MARKER`

    try {
      const small = spill.applyToToolResult('shell_run', { success: true, stdout: 'ok' }, {
        projectPath: workspace.projectPath,
        callId: 'call-small'
      })
      ctx.assert.equal(small.spilled, undefined)
      ctx.assert.equal(small.stdout, 'ok')

      const spilled = spill.applyToToolResult('shell_run', { success: true, command: 'npm test', stdout }, {
        projectPath: workspace.projectPath,
        callId: 'call-big'
      })
      ctx.assert.equal(spilled.spilled, true)
      ctx.assert.ok(spilled.spill_path)
      ctx.assert.ok(fs.existsSync(spilled.spill_path), 'spill file should exist')
      ctx.assert.ok(String(spilled.stdout).length < stdout.length, 'inline stdout should be clipped')
      ctx.assert.ok(String(spilled.stdout).includes('truncated'), 'preview should mention truncation')
      ctx.assert.ok(String(spilled.retrieval_hint).includes('file_read'))
      const saved = fs.readFileSync(spilled.spill_path, 'utf8')
      ctx.assert.ok(saved.includes('UNIQUE_TAIL_MARKER'), 'spill file should keep the full tail')
      ctx.assert.ok(fs.existsSync(path.join(workspace.projectPath, '.lingxi', 'tool-spills', '.gitignore')))

      const clippedWithoutDir = spill.applyToToolResult('shell_run', { success: true, stdout }, { callId: 'no-dir' })
      ctx.assert.equal(!!clippedWithoutDir.spilled, false)
      ctx.assert.equal(clippedWithoutDir.truncated, true)
      ctx.assert.ok(String(clippedWithoutDir.stdout || clippedWithoutDir.preview).length < stdout.length)
    } finally {
      workspace.cleanup()
    }
  }
}
