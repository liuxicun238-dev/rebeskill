const path = require('path')

module.exports = {
  id: 'tool-batch.read-parallel-write-exclusive',
  title: 'Read-only tool calls group into parallel waves; writes are exclusive barriers',
  tags: ['tools', 'scheduler', 'safety'],
  changedFilePatterns: [
    /^electron\/modules\/chat\/tool-batch-scheduler\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i
  ],

  async run(ctx) {
    const {
      isConcurrencySafeToolName,
      partitionToolWaves
    } = require(path.join(ctx.root, 'electron/modules/chat/tool-batch-scheduler'))

    ctx.assert.equal(isConcurrencySafeToolName('read_file'), true)
    ctx.assert.equal(isConcurrencySafeToolName('code_inspect'), true)
    ctx.assert.equal(isConcurrencySafeToolName('write_file'), false)
    ctx.assert.equal(isConcurrencySafeToolName('text_edit'), false)
    ctx.assert.equal(isConcurrencySafeToolName('shell_run'), false)
    ctx.assert.equal(isConcurrencySafeToolName('ask_user_choice'), false)
    ctx.assert.equal(isConcurrencySafeToolName('mystery_tool'), false)

    const call = (id, name) => ({ id, function: { name, arguments: '{}' } })
    const waves = partitionToolWaves([
      call('a', 'read_file'),
      call('b', 'grep_code'),
      call('c', 'write_file'),
      call('d', 'read_file'),
      call('e', 'shell_run'),
      call('f', 'list_files')
    ])

    ctx.assert.equal(waves.length, 5)
    ctx.assert.deepEqual(waves[0].map(item => item.id), ['a', 'b'])
    ctx.assert.deepEqual(waves[1].map(item => item.id), ['c'])
    ctx.assert.deepEqual(waves[2].map(item => item.id), ['d'])
    ctx.assert.deepEqual(waves[3].map(item => item.id), ['e'])
    ctx.assert.deepEqual(waves[4].map(item => item.id), ['f'])

    const readsOnly = partitionToolWaves([call('r1', 'read_file'), call('r2', 'find_in_file')])
    ctx.assert.equal(readsOnly.length, 1)
    ctx.assert.equal(readsOnly[0].length, 2)
  }
}
