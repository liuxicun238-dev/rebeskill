const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'workspace-instructions.agents-md-chain',
  title: 'Workspace AGENTS.md loads from repo root to cwd with a byte budget',
  tags: ['context', 'agents-md', 'workspace'],
  changedFilePatterns: [
    /^electron\/modules\/workspace-instructions\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i
  ],

  async run(ctx) {
    const instructions = require(path.join(ctx.root, 'electron/modules/workspace-instructions'))
    const workspace = ctx.createWorkspace(this.id)
    const nested = path.join(workspace.projectPath, 'apps', 'web')

    try {
      fs.mkdirSync(path.join(workspace.projectPath, '.git'), { recursive: true })
      fs.mkdirSync(nested, { recursive: true })
      ctx.writeText(path.join(workspace.projectPath, 'AGENTS.md'), 'ROOT_RULE keep tests green\n')
      ctx.writeText(path.join(workspace.projectPath, 'CLAUDE.md'), 'SHOULD_NOT_LOAD because AGENTS.md wins\n')
      ctx.writeText(path.join(nested, 'AGENTS.md'), 'NESTED_RULE prefer CSS modules\n')
      ctx.writeText(path.join(nested, 'AGENTS.local.md'), 'LOCAL_RULE do not commit secrets\n')

      const prompt = instructions.buildWorkspaceInstructionPrompt(nested)
      ctx.assert.equal(prompt.enabled, true)
      ctx.assert.ok(prompt.prompt.includes('ROOT_RULE'))
      ctx.assert.ok(prompt.prompt.includes('NESTED_RULE'))
      ctx.assert.ok(prompt.prompt.includes('LOCAL_RULE'))
      ctx.assert.ok(!prompt.prompt.includes('SHOULD_NOT_LOAD'))
      ctx.assert.ok(prompt.files.some(item => item.endsWith('AGENTS.md')))

      const hugeRoot = `${'ROOT_PAD '.repeat(8000)}KEEP_ROOT\n`
      ctx.writeText(path.join(workspace.projectPath, 'AGENTS.md'), hugeRoot)
      const budgeted = instructions.buildWorkspaceInstructionPrompt(nested, { maxBytes: 2000 })
      ctx.assert.equal(budgeted.enabled, true)
      ctx.assert.ok(budgeted.prompt.includes('NESTED_RULE'), 'specific files should survive the budget')
      ctx.assert.ok(budgeted.omitted.length >= 1)
      ctx.assert.equal(budgeted.prompt.includes('KEEP_ROOT'), false)

      const missing = instructions.buildWorkspaceInstructionPrompt(path.join(workspace.projectPath, 'nope'))
      ctx.assert.equal(missing.enabled, false)
    } finally {
      workspace.cleanup()
    }
  }
}
