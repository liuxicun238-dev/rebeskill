const path = require('path')

module.exports = {
  id: 'request-history.fixed-window',
  title: 'AI request history is bounded by token weight without turn-count trimming',
  tags: ['ai-chat', 'history', 'performance'],
  changedFilePatterns: [
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/modules\/request-history-window\.js$/i,
    /^electron\/modules\/context-compression\.js$/i
  ],

  async run(ctx) {
    const windowing = require(path.join(ctx.root, 'electron/modules/request-history-window'))
    const contextCompression = require(path.join(ctx.root, 'electron/modules/context-compression'))

    const tinyHistory = []
    for (let index = 1; index <= 80; index++) {
      tinyHistory.push({ role: 'user', content: `u${index}` }, { role: 'assistant', content: `a${index}` })
    }
    const tiny = windowing.buildRequestHistoryWindow(tinyHistory, tinyHistory.length - 1, { tokenBudget: 10000 })
    ctx.assert.equal(tiny.startIndex, 0, 'many tiny messages must not be trimmed merely because there are many turns')

    const heavyHistory = [
      { role: 'user', content: 'A'.repeat(12000) },
      { role: 'assistant', content: 'B'.repeat(12000) },
      { role: 'user', content: 'current' }
    ]
    const heavy = windowing.buildRequestHistoryWindow(heavyHistory, 2, { tokenBudget: 1000 })
    ctx.assert.equal(heavy.history.at(-1)?.content, 'current', 'the current request must remain')
    ctx.assert.ok(heavy.trimmedCount > 0, 'a small number of heavy messages must be trimmed by weight')

    const epochHistory = [
      { messageId: 'm1', role: 'user', content: 'old' },
      { messageId: 'm2', role: 'assistant', content: 'done' },
      { messageId: 'm3', role: 'user', content: 'new' },
      { messageId: 'm4', role: 'assistant', content: 'working' }
    ]
    const epoch = windowing.buildCompressionEpochHistory(epochHistory, 3, {
      coveredMessageId: 'm2',
      summaryBlock: 'stable summary',
      tokenBudget: 10000
    })
    ctx.assert.equal(epoch.history[0].content, 'stable summary', 'summary should lead the new cache epoch')
    ctx.assert.equal(epoch.history[1].content, 'new', 'epoch must begin after the covered message cursor')
    ctx.assert.ok(epoch.epochTokens > 0, 'epoch should report token weight')

    const summaries = [{ id: 'summary-1', endMessageId: 'm2', endHistoryIndex: 2, summaryText: 's' }]
    const selected = contextCompression.selectCacheEpochSummaries(summaries)
    ctx.assert.equal(selected.coveredMessageId, 'm2', 'cache epoch should use a stable message cursor')
    ctx.assert.equal(selected.coveredMessageIndex, 1, 'message cursor index should be zero-based')
    ctx.assert.equal(windowing.DEFAULT_HISTORY_TOKEN_BUDGET, 80000, 'fallback history budget should be token based')

    const pagedHistory = [
      { messageId: 'keep-1', role: 'user', content: '继续改工作区' },
      { messageId: 'keep-2', role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } }] },
      { messageId: 'keep-3', role: 'tool', tool_call_id: 'c1', content: 'X'.repeat(8000) },
      { messageId: 'keep-4', role: 'assistant', content: '正在处理' }
    ]
    const staleCursor = {
      coveredMessageId: 'msg-from-old-full-history',
      coveredMessageIndex: 194,
      coveredRoundId: 'round-from-old-full-history',
      tokenBudget: 80000
    }
    const duringTurn = windowing.buildCompressionEpochHistory(pagedHistory, pagedHistory.length - 1, staleCursor)
    const afterDoneHistory = pagedHistory.concat([{ messageId: 'final', role: 'assistant', content: '改好了。' }])
    const afterDone = windowing.buildCompressionEpochHistory(afterDoneHistory, afterDoneHistory.length - 1, staleCursor)
    ctx.assert.equal(
      windowing.resolveCoveredMessageIndex(afterDoneHistory, staleCursor).coveredMessageIndex,
      -1,
      'a summary cursor that is not in the paged snapshot must not clamp onto the last message'
    )
    ctx.assert.equal(duringTurn.startIndex, 0, 'stale cursor must keep the loaded tail, not only the last tool message')
    ctx.assert.ok(duringTurn.epochTokens > 1000, 'in-progress tool output should still count')
    ctx.assert.ok(
      afterDone.epochTokens > 1000,
      'final reply must not drop the meter to only the short closing message'
    )
    ctx.assert.ok(
      afterDone.epochTokens + 50 >= duringTurn.epochTokens,
      'completing the final reply must not collapse estimated tokens when compression did not actually run'
    )

    const fs = require('fs')
    const os = require('os')
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-stale-cursor-'))
    const plan = await contextCompression.getCompressionPlan(
      { storagePath: planDir, contextStoragePath: planDir },
      afterDoneHistory,
      { triggerTokens: 80000, retainTokens: 36000 }
    )
    await contextCompression.saveSummaries(
      { storagePath: planDir, contextStoragePath: planDir },
      [{ id: 'summary-0001', schemaVersion: 4, endMessageId: 'msg-from-old-full-history', endHistoryIndex: 195, endTurn: 8, summaryText: 'old' }]
    )
    const stalePlan = await contextCompression.getCompressionPlan(
      { storagePath: planDir, contextStoragePath: planDir },
      afterDoneHistory,
      { triggerTokens: 80000, retainTokens: 36000 }
    )
    ctx.assert.equal(plan.coveredMessageIndex, -1, 'history without summaries should start from the beginning')
    ctx.assert.equal(stalePlan.cursorMatched, false, 'missing summary cursor must not pretend to match')
    ctx.assert.equal(stalePlan.coveredMessageIndex, -1, 'stale endHistoryIndex must not cover the entire paged snapshot')
    ctx.assert.ok(stalePlan.pendingTokens > 1000, 'pending tokens should still include the loaded tool tail')

    const rewrittenIds = afterDoneHistory.map((message, index) => ({ ...message, messageId: `rewritten-${index}` }))
    const regenerated = windowing.resolveCoveredMessageIndex(rewrittenIds, {
      coveredMessageId: 'keep-2',
      coveredMessageIndex: 1
    })
    ctx.assert.equal(regenerated.coveredMessageIndex, 1, 'complete history may still use the saved index after IDs are rewritten')
    ctx.assert.equal(regenerated.via, 'index', 'rewritten IDs should fall back to an in-range index, not discard coverage')
  }
}
