const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'change-session.interrupt-residue',
  title: 'Interrupted mutating sessions expose a compact residue prompt for the next turn',
  tags: ['change-session', 'interrupt', 'residue'],
  changedFilePatterns: [
    /^electron\/modules\/change-sessions\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i
  ],

  async run(ctx) {
    const workspace = ctx.createWorkspace(this.id)
    const config = require(path.join(ctx.root, 'electron/modules/config'))
    const changeSessions = require(path.join(ctx.root, 'electron/modules/change-sessions'))
    const projectId = `residue-${Date.now()}-${Math.random().toString(16).slice(2)}`

    fs.mkdirSync(workspace.projectPath, { recursive: true })
    fs.mkdirSync(workspace.storagePath, { recursive: true })
    config.setProjectInstance(projectId, { storagePath: workspace.storagePath })

    const filePath = path.join(workspace.projectPath, 'src', 'app.js')
    try {
      const session = changeSessions.startChangeSession(projectId, workspace.projectPath, { scenario: this.id })
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      ctx.writeText(filePath, 'const a = 1\n')
      changeSessions.recordFileBefore(projectId, filePath, 'modify')
      ctx.writeText(filePath, 'const a = 2\n')
      changeSessions.recordFileAfter(projectId, filePath, 'modify')
      changeSessions.finalizeChangeSession(projectId, session.id, 'interrupted')

      const instance = config.getProjectInstance(projectId)
      ctx.assert.equal(instance.lastInterruptedChangeSessionId, session.id, 'interrupted mutating sessions should be remembered')

      const residue = changeSessions.buildInterruptResiduePrompt(projectId, '你好')
      ctx.assert.equal(residue.enabled, true)
      ctx.assert.ok(residue.prompt.includes('【上一轮中断残留】'))
      ctx.assert.ok(residue.prompt.includes('app.js'))
      ctx.assert.ok(residue.prompt.includes('不要把旧计划做完'))
      ctx.assert.ok(residue.prompt.includes('闲聊'))
      ctx.assert.ok(residue.changedPaths.some(item => String(item).endsWith('app.js')))

      const latest = changeSessions.getLatestChangeSessionForTool(projectId)
      ctx.assert.equal(latest.success, true)
      ctx.assert.equal(latest.session.id, session.id)
      ctx.assert.equal(latest.session.status, 'interrupted')

      const greetingOnly = changeSessions.buildInterruptResiduePromptFromSession({
        id: 'empty',
        status: 'interrupted',
        files: {},
        commands: []
      }, '你好')
      ctx.assert.equal(greetingOnly.enabled, false)

      const laterFile = path.join(workspace.projectPath, 'src', 'later.js')
      const later = changeSessions.startChangeSession(projectId, workspace.projectPath, { scenario: `${this.id}-later` })
      ctx.writeText(laterFile, 'const later = 1\n')
      changeSessions.recordFileBefore(projectId, laterFile, 'add')
      ctx.writeText(laterFile, 'const later = 2\n')
      changeSessions.recordFileAfter(projectId, laterFile, 'add')
      changeSessions.finalizeChangeSession(projectId, later.id, 'completed')
      ctx.assert.equal(changeSessions.buildInterruptResiduePrompt(projectId, '你好').enabled, false)
      ctx.assert.equal(changeSessions.getLatestChangeSessionForTool(projectId).session.id, later.id)

      const rolledBack = await changeSessions.rollbackChangeSession(projectId, session.id)
      ctx.assert.equal(rolledBack.success, true)
      ctx.assert.equal(config.getProjectInstance(projectId).lastInterruptedChangeSessionId, null)
      ctx.assert.equal(changeSessions.buildInterruptResiduePrompt(projectId, '你好').enabled, false)
    } finally {
      await changeSessions.flushPendingSessionWrites()
      config.deleteProjectInstance(projectId)
      workspace.cleanup()
    }
  }
}
