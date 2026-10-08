const path = require('path')

module.exports = {
  id: 'chat.turn-lifecycle-observer',
  title: 'Turn lifecycle observes send, inject, gate, and interrupt without replacing them',
  tags: ['ai-chat', 'turn', 'interject', 'gate'],
  changedFilePatterns: [
    /^electron\/modules\/chat\/turn-lifecycle\.js$/i,
    /^electron\/modules\/task-runs\.js$/i,
    /^electron\/modules\/interject-runner\.js$/i,
    /^electron\/modules\/ask-permission\.js$/i,
    /^electron\/modules\/tools\.js$/i
  ],

  async run(ctx) {
    const turnLifecycle = require(path.join(ctx.root, 'electron/modules/chat/turn-lifecycle'))
    const interject = require(path.join(ctx.root, 'electron/modules/interject-runner'))
    const projectId = `turn-lifecycle-${Date.now()}`

    turnLifecycle.reset(projectId)
    interject.clearPendingInterjectMessages(projectId)

    try {
      const started = turnLifecycle.beginTurn(projectId, { requestId: 'req-1', runId: 'run-1' })
      ctx.assert.equal(started.phase, 'running', 'a new turn should start as running')
      ctx.assert.equal(started.requestId, 'req-1')
      ctx.assert.equal(started.runId, 'run-1')

      const queued = interject.enqueueInterject({
        projectId,
        itemId: 'item-steer',
        content: '先别改测试'
      })
      ctx.assert.equal(queued.interrupted, false, 'inject must keep using the existing steer path')
      const afterInject = turnLifecycle.getSnapshot(projectId)
      ctx.assert.equal(afterInject.phase, 'running', 'inject must not invent a second running flag')
      ctx.assert.equal(afterInject.pendingInjectCount, 1)
      ctx.assert.equal(afterInject.lastInjectItemId, 'item-steer')
      ctx.assert.equal(afterInject.lastAction, 'inject')

      interject.takePendingInterjectMessages(projectId)
      ctx.assert.equal(turnLifecycle.getSnapshot(projectId).pendingInjectCount, 0)

      const gatePromise = turnLifecycle.observeGate(
        projectId,
        'ask-1',
        'path_permission',
        Promise.resolve({ value: 'allow_once' })
      )
      ctx.assert.equal(turnLifecycle.getSnapshot(projectId).phase, 'awaiting_gate')
      ctx.assert.equal(turnLifecycle.getSnapshot(projectId).gate.type, 'path_permission')
      const gateResult = await gatePromise
      ctx.assert.equal(gateResult.value, 'allow_once', 'observeGate must not rewrite the ask result')
      ctx.assert.equal(turnLifecycle.getSnapshot(projectId).phase, 'running', 'settled gate should return to the previous phase')

      turnLifecycle.noteInterrupt(projectId, { recallUnstarted: false })
      const interrupting = turnLifecycle.getSnapshot(projectId)
      ctx.assert.equal(interrupting.interruptRequested, true)
      ctx.assert.equal(interrupting.phase, 'running', 'interrupt is recorded immediately, finish still belongs to the old abort path')

      turnLifecycle.finishTurn(projectId, 'interrupted', { runId: 'run-1' })
      ctx.assert.equal(turnLifecycle.getSnapshot(projectId).phase, 'interrupted')

      turnLifecycle.finishTurn(projectId, 'completed', { runId: 'run-other' })
      ctx.assert.equal(turnLifecycle.getSnapshot(projectId).phase, 'interrupted', 'a stale finish from another run must not overwrite this turn')
    } finally {
      interject.clearPendingInterjectMessages(projectId)
      turnLifecycle.reset(projectId)
    }
  }
}
