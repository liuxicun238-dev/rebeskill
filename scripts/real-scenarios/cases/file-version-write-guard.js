const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'file-version.write-guard',
  title: 'Write/edit tools refuse unread or stale file overwrites',
  tags: ['tools', 'write', 'version-guard', 'safety'],
  changedFilePatterns: [
    /^electron\/modules\/chat\/file-version-guard\.js$/i,
    /^electron\/modules\/tool-handlers\/file-ops\.js$/i,
    /^electron\/modules\/tool-handlers\/text-edit\.js$/i
  ],

  async run(ctx) {
    const guard = require(path.join(ctx.root, 'electron/modules/chat/file-version-guard'))
    const tools = require(path.join(ctx.root, 'electron/modules/tools'))
    const workspace = ctx.createWorkspace(this.id)
    const projectId = `file-version-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const resolvePath = item => path.resolve(workspace.projectPath, item || '')

    const call = (name, args, extra = {}) => tools.executeToolForProject(
      name,
      args,
      workspace.projectPath,
      resolvePath,
      null,
      extra.projectId === undefined ? projectId : extra.projectId,
      null,
      { userMessage: extra.userMessage || `scenario ${this.id}` }
    )

    try {
      fs.mkdirSync(path.join(workspace.projectPath, 'src'), { recursive: true })
      const unitPath = path.join(workspace.projectPath, 'src', 'unit.txt')
      ctx.writeText(unitPath, 'alpha\n')

      const unreadWrite = await guard.assertFileVersion(projectId, unitPath, { mode: 'write', toolName: 'write_file' })
      ctx.assert.equal(unreadWrite.ok, false, 'unseen existing file should fail closed on write')
      ctx.assert.equal(unreadWrite.error_type, 'must_read_before_write')

      await guard.recordPresentObservation(projectId, unitPath)
      const freshWrite = await guard.assertFileVersion(projectId, unitPath, { mode: 'write' })
      ctx.assert.equal(freshWrite.ok, true, 'fresh observation should allow replaceIfVersion')
      ctx.assert.equal(freshWrite.intent, 'replaceIfVersion')

      ctx.writeText(unitPath, 'beta\n')
      const staleWrite = await guard.assertFileVersion(projectId, unitPath, { mode: 'write' })
      ctx.assert.equal(staleWrite.ok, false)
      ctx.assert.equal(staleWrite.error_type, 'stale_file_version')

      const missingPath = path.join(workspace.projectPath, 'src', 'missing.txt')
      const createOk = await guard.assertFileVersion(projectId, missingPath, { mode: 'write' })
      ctx.assert.equal(createOk.ok, true)
      ctx.assert.equal(createOk.intent, 'createIfAbsent')

      guard.recordAbsentObservation(projectId, missingPath)
      ctx.writeText(missingPath, 'appeared\n')
      const appeared = await guard.assertFileVersion(projectId, missingPath, { mode: 'write' })
      ctx.assert.equal(appeared.ok, false)
      ctx.assert.equal(appeared.error_type, 'stale_file_version')

      const unobservedEdit = await guard.assertFileVersion('other-project', unitPath, { mode: 'edit' })
      ctx.assert.equal(unobservedEdit.ok, true)
      ctx.assert.equal(unobservedEdit.intent, 'unobservedEditAllowed')

      const existingPath = path.join(workspace.projectPath, 'src', 'app.js')
      ctx.writeText(existingPath, [
        'const title = "hello world"',
        'const keep = true',
        'const other = "hello world"',
        ''
      ].join('\n'))

      const blindOverwrite = await call('write_file', {
        path: 'src/app.js',
        content: 'const title = "overwritten"\n'
      })
      ctx.assert.equal(blindOverwrite.success, false, 'existing file must be read before write_file')
      ctx.assert.equal(blindOverwrite.error_type, 'must_read_before_write')
      ctx.assert.ok(fs.readFileSync(existingPath, 'utf8').includes('hello world'), 'unread overwrite must not land')

      const created = await call('write_file', {
        path: 'src/created.js',
        content: 'module.exports = 1\n'
      })
      ctx.assert.ok(created.success, created.error || created.message || 'new files can be created without a prior read')

      const secondWrite = await call('write_file', {
        path: 'src/created.js',
        content: 'module.exports = 2\n'
      })
      ctx.assert.ok(secondWrite.success, secondWrite.error || secondWrite.message || 'own successful write should refresh the observed version')
      ctx.assert.equal(fs.readFileSync(path.join(workspace.projectPath, 'src', 'created.js'), 'utf8'), 'module.exports = 2\n')

      const readExisting = await call('read_file', { path: 'src/app.js' })
      ctx.assert.ok(readExisting.success, readExisting.error || 'read_file should observe the current hash')

      ctx.writeText(existingPath, [
        'const title = "hello world"',
        'const keep = true',
        'const other = "hello earth"',
        ''
      ].join('\n'))

      const staleOverwrite = await call('write_file', {
        path: 'src/app.js',
        content: 'const title = "stale overwrite"\n'
      })
      ctx.assert.equal(staleOverwrite.success, false)
      ctx.assert.equal(staleOverwrite.error_type, 'stale_file_version')
      ctx.assert.ok(fs.readFileSync(existingPath, 'utf8').includes('hello earth'), 'stale write_file must not land')

      const staleEdit = await call('text_edit', {
        path: 'src/app.js',
        edits: [{
          op: 'replace',
          old_content: 'const title = "hello world"',
          new_content: 'const title = "patched from stale read"'
        }]
      })
      ctx.assert.equal(staleEdit.success, false, 'text_edit should refuse after an external change even if a leftover snippet still matches')
      ctx.assert.equal(staleEdit.error_type, 'stale_file_version')
      ctx.assert.ok(fs.readFileSync(existingPath, 'utf8').includes('hello earth'))

      const reread = await call('read_file', { path: 'src/app.js' })
      ctx.assert.ok(reread.success)
      const freshEdit = await call('text_edit', {
        path: 'src/app.js',
        edits: [{
          op: 'replace',
          old_content: 'const title = "hello world"',
          new_content: 'const title = "hello fresh"'
        }]
      })
      ctx.assert.ok(freshEdit.success, freshEdit.error || freshEdit.message || 'text_edit should succeed on a fresh observation')
      ctx.assert.ok(fs.readFileSync(existingPath, 'utf8').includes('hello fresh'))
    } finally {
      guard.clearProjectReadRecords(projectId)
      workspace.cleanup()
    }
  }
}
