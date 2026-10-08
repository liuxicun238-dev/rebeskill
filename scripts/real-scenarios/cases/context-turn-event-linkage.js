const path = require('path')

module.exports = {
  id: 'context.turn-event-linkage',
  title: 'Turn/Item changes notify the context component without shipping tool results',
  tags: ['context', 'turn', 'events'],
  changedFilePatterns: [
    /^electron\/modules\/chat\/turn-event-bus\.js$/i,
    /^electron\/modules\/chat\/turn-item-store\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/preload\.js$/i,
    /^frontend\/scripts\/features\/context-memory-ruler\.js$/i
  ],

  async run(ctx) {
    const store = require(path.join(ctx.root, 'electron/modules/chat/turn-item-store'))
    const bus = require(path.join(ctx.root, 'electron/modules/chat/turn-event-bus'))
    const config = require(path.join(ctx.root, 'electron/modules/config'))
    const workspace = ctx.createWorkspace('context-turn-event-linkage')
    const runRef = {
      projectId: `turn-event-${Date.now()}`,
      runId: `run-event-${Date.now()}`
    }
    config.setProjectInstance(runRef.projectId, { storagePath: workspace.storagePath })
    const events = []
    const unsubscribe = bus.onTurnEvent(event => events.push(event))

    try {
      store.beginTurn(runRef, { userMessage: '测试上下文实时刷新' })
      store.createItem(runRef, {
        id: 'tool-event-1',
        type: 'tool_call',
        toolName: 'file_read',
        result: { content: 'must stay out of renderer event' }
      })
      store.completeItem(runRef, 'tool-event-1', {
        success: true,
        content: 'large tool result'
      })
      store.finishTurn(runRef, 'completed')
      await new Promise(resolve => setTimeout(resolve, 100))

      ctx.assert.deepEqual(
        events.map(event => event.type),
        ['turn-started', 'turn-item-created', 'turn-item-updated', 'turn-completed']
      )
      const created = events.find(event => event.type === 'turn-item-created')
      ctx.assert.equal(created.projectId, runRef.projectId)
      ctx.assert.equal(created.item.toolName, 'file_read')
      ctx.assert.equal(Object.prototype.hasOwnProperty.call(created.item, 'result'), false)
      ctx.assert.equal(events.at(-1).evidenceAvailable, true)
      ctx.assert.equal(events.at(-1).toolCount, 1)
      const persistedSummary = store.readTurnSummaryFromJournal(workspace.storagePath, runRef.runId)
      ctx.assert.equal(persistedSummary.status, 'completed')
      ctx.assert.equal(persistedSummary.itemCount, 1)
      ctx.assert.equal(persistedSummary.toolCount, 1)
    } finally {
      unsubscribe()
      await new Promise(resolve => setTimeout(resolve, 120))
      config.deleteProjectInstance(runRef.projectId)
      workspace.cleanup()
    }
  }
}
