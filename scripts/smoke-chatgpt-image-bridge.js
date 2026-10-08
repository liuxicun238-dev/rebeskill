const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app } = require('electron')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-chatgpt-image-smoke-'))
process.env.LINGXI_CHATGPT_IMAGE_BRIDGE_PORT = process.env.LINGXI_CHATGPT_IMAGE_BRIDGE_PORT || '33217'
app.setPath('userData', tempRoot)

async function run() {
  const bridge = require('../electron/modules/chatgpt-image-bridge')

  try {
    const status = await bridge.startServer()
    assert.equal(status.running, true)
    assert.equal(status.host, '127.0.0.1')
    assert.ok(bridge.findBrowserExecutable(), 'system Chrome/Edge must be discoverable')

    const healthResponse = await fetch(`${status.apiUrl.replace(/\/v1$/, '')}/health`)
    assert.equal(healthResponse.status, 200)
    const health = await healthResponse.json()
    assert.equal(health.running, true)

    const unauthorized = await fetch(`${status.apiUrl}/models`)
    assert.equal(unauthorized.status, 401)

    const suggested = bridge.getSuggestedModel()
    const authorized = await fetch(`${status.apiUrl}/models`, {
      headers: { Authorization: `Bearer ${suggested.apiKey}` }
    })
    assert.equal(authorized.status, 200)
    const payload = await authorized.json()
    assert.ok(payload.data?.some(model => model.id === 'chatgpt-web-chat'))
    assert.ok(payload.data?.some(model => model.id === 'chatgpt-pro-web'))

    const chatModel = bridge.getSuggestedChatModel()
    assert.equal(chatModel.modelId, 'chatgpt-web-chat')
    assert.equal(chatModel.capabilities.text, true)
    assert.equal(chatModel.capabilities.toolCalling, true)
    const tools = [{
      type: 'function',
      function: {
        name: 'file_read',
        description: '读取项目文件',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      }
    }, {
      type: 'function',
      function: {
        name: 'generate_image',
        description: '不应进入网页 GPT 工具表',
        parameters: { type: 'object', properties: {} }
      }
    }]
    const chatPrompt = bridge.buildWebChatPrompt({
      messages: [
        { role: 'system', content: '回答要简洁。' },
        { role: 'user', content: '你好' }
      ],
      tools
    })
    assert.ok(chatPrompt.includes('回答要简洁。'))
    assert.ok(chatPrompt.includes('你好'))
    assert.ok(chatPrompt.includes('<LINGXI_TOOL_CALLS>'))
    assert.ok(chatPrompt.includes('file_read'))
    assert.ok(!chatPrompt.includes('generate_image'))

    const parsedCalls = bridge.parseLingxiToolCalls(
      '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_read","arguments":{"path":"README.md"}}]}</LINGXI_TOOL_CALLS>',
      tools
    )
    assert.equal(parsedCalls.length, 1)
    assert.equal(parsedCalls[0].function.name, 'file_read')
    assert.deepEqual(JSON.parse(parsedCalls[0].function.arguments), { path: 'README.md' })
    assert.equal(bridge.parseLingxiToolCalls(
      '```json\n<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_read","arguments":{"path":"README.md"}}]}</LINGXI_TOOL_CALLS>\n```',
      tools
    ).length, 1)
    assert.equal(bridge.parseLingxiToolCalls(
      'json\nCopy code\n<LINGXI_TOOL_CALLS>\n{\n  "calls": [\n    {\n      "name": "file_read",\n      "arguments": {\n        "path": "README.md",\n      }\n    }\n  ]\n}\n</LINGXI_TOOL_CALLS>',
      tools
    ).length, 1)
    assert.equal(bridge.parseLingxiToolCalls(
      '<LINGXI_TOOL_CALLS>[{"name":"file_read","arguments":{"path":"README.md"}}]</LINGXI_TOOL_CALLS>',
      tools
    )[0].function.name, 'file_read')
    assert.throws(() => bridge.parseLingxiToolCalls(
      '<LINGXI_TOOL_CALLS>{"calls":[{"name":"delete_everything","arguments":{}}]}</LINGXI_TOOL_CALLS>',
      tools
    ), error => error?.code === 'INVALID_TOOL_CALL_PROTOCOL')
    assert.throws(() => bridge.parseLingxiToolCalls(
      '先读一下文件\n<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_read","arguments":{"path":"README.md"}}]}</LINGXI_TOOL_CALLS>',
      tools
    ), error => error?.code === 'INVALID_TOOL_CALL_PROTOCOL')

    const previousResult = { content: '上一轮回答', toolCalls: [] }
    const previousMessages = [{ role: 'user', content: '第一问' }]
    assert.deepEqual(bridge.getContinuationMessages([
      ...previousMessages,
      { role: 'assistant', content: '上一轮回答' },
      { role: 'user', content: '第二问' }
    ], previousMessages, previousResult), [{ role: 'user', content: '第二问' }])
    assert.equal(bridge.getContinuationMessages([{ role: 'user', content: '另一段历史' }], previousMessages, previousResult), null)

    const sseWrites = []
    const fakeSseResponse = {
      writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; this.headersSent = true },
      write(chunk) { sseWrites.push(String(chunk)) },
      end() { this.ended = true }
    }
    bridge.sendWebChatResult(fakeSseResponse, '/v1/chat/completions', {
      stream: true,
      messages: [{ role: 'user', content: '你好' }]
    }, '网页回复正常')
    assert.equal(fakeSseResponse.statusCode, 200)
    assert.ok(sseWrites.join('').includes('网页回复正常'))
    assert.ok(sseWrites.join('').includes('data: [DONE]'))

    const toolSseWrites = []
    const fakeToolSseResponse = {
      writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; this.headersSent = true },
      write(chunk) { toolSseWrites.push(String(chunk)) },
      end() { this.ended = true }
    }
    bridge.sendWebChatResult(fakeToolSseResponse, '/v1/chat/completions', {
      stream: true,
      messages: [{ role: 'user', content: '读取文件' }]
    }, { content: '', rawAnswer: '', toolCalls: parsedCalls })
    const toolStream = toolSseWrites.join('')
    assert.ok(toolStream.includes('"tool_calls"'))
    assert.ok(toolStream.includes('file_read'))
    assert.ok(toolStream.includes('"finish_reason":"tool_calls"'))

    const invalidImageRequest = await fetch(`${status.apiUrl}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${suggested.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: suggested.modelId, prompt: '' })
    })
    assert.equal(invalidImageRequest.status, 400)
    const invalidPayload = await invalidImageRequest.json()
    assert.equal(invalidPayload.error?.code, 'MISSING_PROMPT')

    if (process.argv.includes('--external-browser') || process.env.LINGXI_SMOKE_EXTERNAL_BROWSER === '1') {
      const browserStatus = await bridge.openLoginWindow()
      assert.equal(browserStatus.browserOpen, true)
      assert.equal(browserStatus.browserMode, 'login')
      assert.equal(browserStatus.loginBrowserOpen, true)
      assert.ok(/Google Chrome|Microsoft Edge|Chromium/.test(browserStatus.browserName))
      await bridge.closeLoginBrowser()
      console.log(`Normal login browser check passed: ${browserStatus.browserName}`)
    }
    console.log('ChatGPT image bridge smoke check passed.')
  } finally {
    await bridge.closeLoginBrowser()
    await bridge.closeExternalBrowser()
    await bridge.stopServer()
  }
}

app.whenReady().then(async () => {
  let exitCode = 0
  try {
    await run()
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    const resolvedTemp = path.resolve(tempRoot)
    const resolvedSystemTemp = path.resolve(os.tmpdir())
    if (resolvedTemp.startsWith(`${resolvedSystemTemp}${path.sep}`) && path.basename(resolvedTemp).startsWith('lingxi-chatgpt-image-smoke-')) {
      try {
        fs.rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
      } catch (error) {
        console.warn(`Temporary browser profile cleanup deferred: ${error.message}`)
      }
    }
    app.exit(exitCode)
  }
})
