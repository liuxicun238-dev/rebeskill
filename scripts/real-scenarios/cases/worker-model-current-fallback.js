const path = require('path')

module.exports = {
  id: 'worker-model.current-model-fallback',
  title: 'An unavailable organizer falls back to the model executing the current task',
  tags: ['worker-model', 'context-compression', 'fallback'],
  changedFilePatterns: [
    /^electron\/modules\/worker-model\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/modules\/memory-organizer\.js$/i
  ],

  async run(ctx) {
    const storageConfig = require(path.join(ctx.root, 'electron/modules/storage-config'))
    const workerModel = require(path.join(ctx.root, 'electron/modules/worker-model'))
    const originalWorkerConfig = storageConfig.getWorkerModelConfig
    const originalApiConfig = storageConfig.getApiConfig
    const originalFetch = global.fetch
    const calls = []

    storageConfig.getWorkerModelConfig = () => ({
      enabled: true,
      timeoutMs: 30000,
      local: { enabled: false },
      cloud: { enabled: true, modelKey: 'organizer-model' },
      tasks: { ledger: true, memory: true, summary: true }
    })
    storageConfig.getApiConfig = () => ({
      success: true,
      data: {
        models: [{
          modelKey: 'organizer-model',
          modelId: 'organizer',
          modelName: 'Organizer',
          apiUrl: 'https://organizer.invalid/v1',
          apiKey: 'organizer-key'
        }]
      }
    })
    global.fetch = async (url) => {
      const target = String(url)
      calls.push(target)
      const content = target.includes('organizer.invalid')
        ? 'This response is not JSON.'
        : '<think>整理中，示例 {not-json}</think>\n{"completed":["used-current-model"],"findings":[],"decisions":[],"rejected":[],"constraints":[],"openQuestions":[],"unfinished":[]}'
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content } }]
        }),
        text: async () => ''
      }
    }

    try {
      const result = await workerModel.summarizeLedger({
        userRequest: 'continue the task',
        finalSummary: 'organize this turn',
        evidence: {},
        projectId: 'scenario-project',
        currentModel: {
          modelKey: 'current-model',
          modelId: 'current',
          modelName: 'Current',
          apiUrl: 'https://current.invalid/v1',
          apiKey: 'current-key',
          apiFormat: 'openai'
        }
      })

      ctx.assert.equal(result.success, true)
      ctx.assert.equal(result.provider, 'current-model')
      ctx.assert.equal(result.fallback, true)
      ctx.assert.deepEqual(result.facts.completed, ['used-current-model'])
      ctx.assert.equal(calls.some(url => url.includes('organizer.invalid')), true)
      ctx.assert.equal(calls.some(url => url.includes('current.invalid')), true)
    } finally {
      storageConfig.getWorkerModelConfig = originalWorkerConfig
      storageConfig.getApiConfig = originalApiConfig
      global.fetch = originalFetch
    }
  }
}
