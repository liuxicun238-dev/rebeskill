const path = require('path')

module.exports = {
  id: 'context.tool-result-history-prune',
  title: 'Oversized historical tool results are pruned for the model without mutating persisted chat',
  tags: ['context', 'history', 'tools', 'spill'],
  changedFilePatterns: [
    /^electron\/modules\/chat\/context-overflow-recovery\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i
  ],

  async run(ctx) {
    const {
      PRUNE_MARKER,
      pruneHistoricalToolResults,
      pruneToolResultText,
      recoverContextOverflow
    } = require(path.join(ctx.root, 'electron/modules/chat/context-overflow-recovery'))

    const long = 'X'.repeat(12000)
    const prunedText = pruneToolResultText(long)
    ctx.assert.equal(prunedText.pruned, true)
    ctx.assert.ok(prunedText.text.includes(PRUNE_MARKER))
    ctx.assert.ok(prunedText.text.length < long.length)

    const persisted = { role: 'tool', tool_call_id: 'old', content: long }
    const recent = { role: 'tool', tool_call_id: 'new', content: long }
    const spilledFull = {
      role: 'tool',
      tool_call_id: 'spill',
      content: JSON.stringify({
        success: true,
        spilled: true,
        stdout: long,
        spill_path: 'E:/proj/.lingxi/tool-spills/call-spill-shell_run.txt',
        retrieval_hint: '用 file_read 读取 spill_path'
      })
    }
    const history = [
      { role: 'user', content: 'old task' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'old' }] },
      persisted,
      { role: 'user', content: 'new task' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'new' }, { id: 'spill' }] },
      recent,
      spilledFull
    ]

    const result = pruneHistoricalToolResults(history, { keepRecentToolMessages: 2 })
    ctx.assert.equal(result.changed, true)
    ctx.assert.ok(result.prunedCount >= 2)
    ctx.assert.ok(result.spilledCount >= 1)
    ctx.assert.ok(history[2].content.includes(PRUNE_MARKER), 'older tool results should be pruned')
    ctx.assert.ok(history[2] !== persisted, 'pruned history entries must be cloned')
    ctx.assert.equal(persisted.content, long, 'persisted chat objects must keep full tool output')
    ctx.assert.equal(history[5].content, long, 'the most recent non-spilled tool results stay intact')
    ctx.assert.ok(!String(history[6].content).includes(long), 'spilled results compact to a pointer even if recent')
    ctx.assert.ok(String(history[6].content).includes('spill_path'))

    const overflowMessages = [
      { role: 'assistant', tool_calls: [{ id: 'c1' }] },
      { role: 'tool', tool_call_id: 'c1', content: long }
    ]
    const recovered = recoverContextOverflow(overflowMessages)
    ctx.assert.equal(recovered.advanced, true)
    ctx.assert.ok(overflowMessages[1].content.includes(PRUNE_MARKER))
  }
}
