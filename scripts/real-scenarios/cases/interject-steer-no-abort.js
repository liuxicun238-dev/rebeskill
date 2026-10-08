const path = require('path')

module.exports = {
  id: 'interject.steer-no-abort',
  title: 'Message injection queues at the step boundary and does not abort the current run',
  tags: ['ai-chat', 'interject', 'steer'],
  changedFilePatterns: [
    /^electron\/modules\/interject-runner\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i
  ],

  async run(ctx) {
    const interject = require(path.join(ctx.root, 'electron/modules/interject-runner'))
    const projectId = `interject-steer-${Date.now()}`
    const abortCalls = []
    const fakeController = {
      signal: { aborted: false },
      abort(reason) {
        abortCalls.push(reason)
        this.signal.aborted = true
      }
    }

    interject.clearPendingInterjectMessages(projectId)
    interject.setRunState(projectId, 'tools')

    try {
      const result = interject.enqueueInterject({
        projectId,
        itemId: 'item-1',
        content: '改成只修报错，不要继续旧计划'
      })
      ctx.assert.equal(result.ok, true, 'enqueue should succeed')
      ctx.assert.equal(result.interrupted, false, 'injection must not abort the current run')
      ctx.assert.equal(result.absorbAt, 'step-boundary')
      ctx.assert.equal(abortCalls.length, 0, 'enqueue must not touch AbortController')
      ctx.assert.equal(fakeController.signal.aborted, false)
      ctx.assert.equal(interject.peekPendingInterjectMessages(projectId).length, 1)

      const taken = interject.takePendingInterjectMessages(projectId)
      ctx.assert.equal(taken.length, 1)
      ctx.assert.equal(taken[0].content, '改成只修报错，不要继续旧计划')
      ctx.assert.equal(interject.peekPendingInterjectMessages(projectId).length, 0)
      ctx.assert.equal(interject.isInterjectAbortReason('interject'), true)
      ctx.assert.equal(interject.isInterjectAbortReason(new Error('用户已中断本轮 AI 操作')), false)
    } finally {
      interject.clearPendingInterjectMessages(projectId)
      interject.setRunState(projectId, 'idle')
    }
  }
}
