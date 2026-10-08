const http = require('http')
const path = require('path')

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

module.exports = {
  id: 'gemini-direct-routing',
  title: 'Gemini 3224 unified model routes direct mode to the generic Agent API gateway on 3410',
  tags: ['web-bridge', 'gemini', 'transport'],
  changedFilePatterns: [
    new RegExp('^electron/modules/gemini-(?:direct-gateway|web-bridge)\\.js$', 'i')
  ],

  async run(ctx) {
    const direct = require(path.join(ctx.root, 'electron/modules/gemini-direct-gateway'))
    let captured = null
    let capturedSession = null
    const upstream = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true,"service":"gemini-agent-api-gateway"}')
        return
      }
      const body = JSON.parse(await readBody(req))
      if (req.url === '/v1/gemini/session/import') {
        capturedSession = body.session
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true,"account_status":1000,"models":[{"id":"gemini-3.1-pro","name":"3.1 Pro"}]}')
        return
      }
      captured = { body, headers: req.headers }
      const answer = Buffer.from(JSON.stringify({
        id: 'chatcmpl-direct-test',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'direct ok' }, finish_reason: 'stop' }]
      }))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': answer.length })
      res.end(answer)
    })

    try {
      await listen(upstream, direct.DIRECT_PORT)
    } catch (error) {
      if (error.code === 'EADDRINUSE') return
      throw error
    }

    const bridge = http.createServer((req, res) => {
      direct.proxyChat({
        req,
        res,
        pathname: '/v1/chat/completions',
        body: { model: 'gemini-web-chat', messages: [{ role: 'user', content: 'hello' }] },
        apiKey: 'bridge-test-key',
        pagePrefs: { pageModel: 'pro', thinkingEnabled: true }
      }).catch(error => {
        if (!res.headersSent) res.writeHead(500)
        res.end(error.message)
      })
    })

    try {
      const address = await listen(bridge)
      const response = await fetch(`http://127.0.0.1:${address.port}/chat`, {
        method: 'POST',
        headers: {
          'X-Lingxi-Session-Id': 'session-test',
          'X-Lingxi-Project-Id': 'project-test'
        }
      })
      const json = await response.json()
      ctx.assert.equal(response.status, 200)
      ctx.assert.equal(json.choices[0].message.content, 'direct ok')
      ctx.assert.equal(captured.body.model, 'gemini-3.1-pro')
      ctx.assert.equal(captured.body.reasoning_effort, 'adaptive')
      ctx.assert.equal(captured.headers['x-session-id'], 'project-test:session-test')
      ctx.assert.equal(captured.headers['x-client-type'], 'lingxi')
      ctx.assert.equal(captured.headers['x-gemini-account'], 'lingxi-gemini-web')
      ctx.assert.equal(captured.headers.authorization, `Bearer ${direct.DIRECT_API_KEY}`)
      const imported = await direct.importBrowserSession({
        authUser: '1',
        pageUrl: 'https://gemini.google.com/u/1/app',
        cookies: [{ name: '__Secure-1PSID', value: 'test-only' }]
      })
      ctx.assert.equal(imported.account_status, 1000)
      ctx.assert.equal(capturedSession.authUser, '1')
      ctx.assert.equal(capturedSession.cookies[0].name, '__Secure-1PSID')
    } finally {
      await close(bridge).catch(() => {})
      await close(upstream).catch(() => {})
    }
  }
}
