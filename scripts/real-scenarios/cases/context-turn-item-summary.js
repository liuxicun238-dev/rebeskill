const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'context.turn-item-summary',
  title: 'Context status reads a compact Turn/Item summary instead of full tool results',
  tags: ['context', 'turn', 'performance'],
  changedFilePatterns: [
    /^electron\/modules\/chat\/turn-item-store\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/modules\/projects\.js$/i,
    /^frontend\/scripts\/features\/context-memory-ruler\.js$/i
  ],

  async run(ctx) {
    const workspace = ctx.createWorkspace('context-turn-item-summary')
    const store = require(path.join(ctx.root, 'electron/modules/chat/turn-item-store'))
    const runId = 'run-summary-test'
    const journalPath = path.join(workspace.storagePath, 'runs', `${runId}.jsonl`)
    const event = (type, payload, time) => ({
      projectId: 'summary-project',
      runId,
      type,
      time,
      payload
    })

    try {
      const lines = [
        event('run_started', {
          metadata: { userMessage: '请把上一轮工作展开说明' }
        }, '2026-08-23T10:00:00.000Z'),
        event('turn_started', {
          turnId: runId,
          metadata: { modelName: 'test-model' }
        }, '2026-08-23T10:00:00.001Z'),
        event('turn_item_created', {
          turnId: runId,
          item: {
            id: 'tool-1',
            type: 'tool_call',
            toolName: 'read_file',
            status: 'in_progress',
            result: { huge: 'this should not be exposed by the summary' }
          }
        }, '2026-08-23T10:00:00.002Z'),
        event('turn_item_updated', {
          turnId: runId,
          itemId: 'tool-1',
          patch: {
            status: 'completed',
            result: { success: true, content: 'large tool result' },
            completedAt: '2026-08-23T10:00:00.003Z'
          }
        }, '2026-08-23T10:00:00.003Z'),
        event('turn_item_created', {
          turnId: runId,
          item: {
            id: 'message-1',
            type: 'agent_message',
            status: 'completed',
            message: '最终说明'
          }
        }, '2026-08-23T10:00:00.004Z'),
        event('turn_completed', {
          turnId: runId,
          status: 'completed',
          itemCount: 2,
          durationMs: 4
        }, '2026-08-23T10:00:00.005Z'),
        event('run_finished', { status: 'completed' }, '2026-08-23T10:00:00.006Z')
      ]
      ctx.writeText(journalPath, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)

      const summary = store.readTurnSummaryFromJournal(workspace.storagePath, runId)
      ctx.assert.equal(summary.status, 'completed')
      ctx.assert.equal(summary.itemCount, 2)
      ctx.assert.equal(summary.toolCount, 1)
      ctx.assert.equal(summary.evidenceAvailable, true)
      ctx.assert.equal(summary.latestItem.id, 'message-1')
      ctx.assert.equal(Object.prototype.hasOwnProperty.call(summary, 'items'), false,
        'summary endpoint must not expose full item/result payloads')
      const fullTurn = store.readTurnFromJournal(workspace.storagePath, runId)
      const handoff = store.formatTurnForFollowupContext(fullTurn, { maxChars: 4000 })
      ctx.assert.match(handoff, /上一轮持久化执行证据/)
      ctx.assert.match(handoff, /工具：read_file/)
      ctx.assert.match(handoff, /large tool result/)
      ctx.assert.match(handoff, /不要无理由重复执行同一轮已经完成的搜索和读取/)

      const cached = store.readTurnSummaryFromJournal(workspace.storagePath, runId)
      ctx.assert.equal(cached, summary, 'unchanged journals should reuse the cached summary object')

      fs.appendFileSync(journalPath, `${JSON.stringify(event('turn_item_updated', {
        turnId: runId,
        itemId: 'tool-1',
        patch: { status: 'failed', completedAt: '2026-08-23T10:00:01.000Z' }
      }, '2026-08-23T10:00:01.000Z'))}\n`, 'utf8')
      const refreshed = store.readTurnSummaryFromJournal(workspace.storagePath, runId)
      ctx.assert.notEqual(refreshed, summary, 'journal changes should invalidate the summary cache')
      ctx.assert.equal(refreshed.toolCount, 1)
      ctx.assert.equal(refreshed.latestItem.id, 'tool-1')
      ctx.assert.equal(refreshed.latestItem.status, 'failed')

      const compactRunId = 'run-state-summary-test'
      const compactJournalPath = path.join(workspace.storagePath, 'runs', `${compactRunId}.jsonl`)
      const compactStatePath = path.join(workspace.storagePath, 'runs', `${compactRunId}.state.json`)
      ctx.writeText(compactJournalPath, JSON.stringify({
        runId: compactRunId,
        projectId: 'summary-project',
        type: 'turn_item_created',
        payload: {
          item: {
            id: 'large-tool',
            type: 'tool_call',
            toolName: 'read_file',
            result: { content: 'x'.repeat(200000) }
          }
        }
      }))
      ctx.writeText(compactStatePath, JSON.stringify({
        runId: compactRunId,
        projectId: 'summary-project',
        status: 'completed',
        turnId: compactRunId,
        turnStatus: 'completed',
        turnItemCount: 1,
        turnToolCount: 1,
        turnEvidenceAvailable: true,
        turnCompletedAt: '2026-08-23T10:01:00.000Z'
      }))
      const stateSummary = store.readTurnSummaryFromJournal(workspace.storagePath, compactRunId)
      ctx.assert.equal(stateSummary.itemCount, 1)
      ctx.assert.equal(stateSummary.toolCount, 1)
      ctx.assert.equal(stateSummary.latestItem, null,
        'state projection should avoid parsing and returning the large tool item')
    } finally {
      workspace.cleanup()
    }
  }
}
