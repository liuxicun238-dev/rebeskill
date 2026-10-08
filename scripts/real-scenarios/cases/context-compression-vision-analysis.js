const path = require('path')

module.exports = {
  id: 'context-compression.vision-analysis',
  title: 'Compression and later turns keep image analysis facts after pixels expire',
  tags: ['context-compression', 'vision', 'history'],
  changedFilePatterns: [
    /^electron\/modules\/context-compression\.js$/i,
    /^electron\/modules\/chat\/history-normalizer\.js$/i,
    /^electron\/modules\/chat\/vision-analysis-context\.js$/i
  ],

  async run(ctx) {
    const workspace = ctx.createWorkspace(this.id)
    const identity = require(path.join(ctx.root, 'electron/modules/chat-message-identity'))
    const compression = require(path.join(ctx.root, 'electron/modules/context-compression'))
    const historyNormalizer = require(path.join(ctx.root, 'electron/modules/chat/history-normalizer'))
    const fact = '设置页有询问授权、智能授权、完整授权三张卡片'

    try {
      const expired = {
        role: 'user',
        content: '看这张图改权限卡片',
        attachments: [{
          kind: 'image',
          name: 'permission.png',
          path: 'C:\\tmp\\permission.png',
          dataUrl: 'data:image/png;base64,AAAA',
          visionAnalysis: {
            model: 'gpt-4o',
            summary: fact,
            imageNames: ['permission.png']
          }
        }]
      }
      const history = [expired]
      for (let index = 0; index < 4; index++) {
        history.push({ role: 'assistant', content: `回复${index}` })
        history.push({ role: 'user', content: `继续${index}` })
      }
      historyNormalizer.pruneExpiredImageAttachments(history, 4)
      ctx.assert.equal(expired.content, '看这张图改权限卡片', 'prune must not rewrite the visible user text')
      ctx.assert.ok(!expired.attachments[0].dataUrl, 'expired pixels must not stay in attachments')
      ctx.assert.ok(expired.attachments[0].visionAnalysis?.summary.includes('询问授权'), 'prune must keep a compact image analysis')

      const requestHistory = [expired, { role: 'assistant', content: '收到' }, { role: 'user', content: '然后按第二张卡片做' }]
      const originalContent = expired.content
      historyNormalizer.normalizeFullHistoryForModel(requestHistory, false, 2)
      ctx.assert.equal(expired.content, originalContent, 'model-facing injection must not mutate persisted history')
      ctx.assert.notEqual(requestHistory[0], expired, 'request history should clone the injected user message')
      ctx.assert.ok(String(requestHistory[0].content).includes(fact), 'later turns must still see the image analysis')

      const heavy = [
        {
          role: 'user',
          content: '看图改权限'.repeat(4000),
          attachments: [{
            kind: 'image',
            name: 'permission.png',
            visionAnalysis: {
              model: 'gpt-4o',
              summary: fact,
              imageNames: ['permission.png']
            }
          }]
        },
        { role: 'assistant', content: '可以按三档权限改'.repeat(4000) },
        { role: 'user', content: '第二个需求'.repeat(4000) },
        { role: 'assistant', content: '第二个结果'.repeat(4000) },
        { role: 'user', content: '继续' }
      ]
      identity.assignMessageIdentity(heavy, { sessionId: 'vision-compress', deterministic: true })

      const forgetfulInstance = { storagePath: workspace.storagePath + '-forgetful' }
      let captured = null
      const forgetful = await compression.createCompressionSummary(forgetfulInstance, heavy, {
        triggerTokens: 8000,
        retainTokens: 4000,
        summarizeWithWorker: async (payload) => {
          captured = payload
          return {
            success: true,
            provider: 'test',
            data: {
              topic: '看图改权限',
              aiDid: ['看了截图'],
              keyInfo: ['用户发了图片']
            }
          }
        }
      })
      ctx.assert.ok(forgetful.created, 'image history should still compress')
      ctx.assert.ok(
        Array.isArray(captured?.rounds?.[0]?.imageAnalyses) && captured.rounds[0].imageAnalyses.some(item => String(item).includes('询问授权')),
        'worker payload must include the image analysis, not just [图片]'
      )
      ctx.assert.ok(forgetful.summary.summaryText.includes('询问授权'), 'summary text must keep the image analysis after a forgetful worker')
      ctx.assert.ok(
        (forgetful.summary.summary.imageAnalyses || []).some(item => String(item).includes('询问授权')),
        'summary.imageAnalyses must be filled from history when the worker omits it'
      )

      const localInstance = { storagePath: workspace.storagePath + '-local' }
      const local = await compression.createCompressionSummary(localInstance, heavy, {
        triggerTokens: 8000,
        retainTokens: 4000
      })
      ctx.assert.ok(local.created, 'local rebuild should compress image history')
      ctx.assert.ok(local.summary.summaryText.includes('图片分析'), 'local summary should expose an image analysis section')
      ctx.assert.ok(local.summary.summaryText.includes('询问授权'), 'local summary must keep the visual facts')
    } finally {
      workspace.cleanup()
    }
  }
}
