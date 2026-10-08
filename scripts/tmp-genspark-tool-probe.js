/**
 * 临时验证（可删除）：同一会话内发两次带 tools 的请求，打印 Genspark 原始回答，
 * 分别用“自然语言请求”和“强制协议请求”，用于判断工具调用能力真实情况。
 */
const path = require('path')
const { app } = require('electron')

app.setPath('userData', process.env.LINGXI_E2E_USER_DATA
  || 'C:\\Users\\Administrator\\AppData\\Roaming\\lingxi-lingxicode')

const tools = [{
  type: 'function',
  function: {
    name: 'file_read',
    description: '读取项目文件内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
}]

const prompts = [
  ['natural', '帮我看看项目根目录的 README.md 开头写了什么。'],
  ['explicit', '请调用 file_read 工具读取 README.md，只输出工具调用协议本身，不要解释。']
]

async function send(apiUrl, apiKey, prompt) {
  const startedAt = Date.now()
  const res = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'genspark-web-chat',
      messages: [{ role: 'user', content: prompt }],
      tools
    })
  })
  const text = await res.text()
  console.log(`PROBE | status=${res.status} ms=${Date.now() - startedAt} prompt=${prompt.slice(0, 20)}`)
  console.log('PROBE_RAW | ' + text.slice(0, 1200))
}

async function run() {
  const bridge = require(path.join(__dirname, '..', 'electron', 'modules', 'genspark-web-bridge'))
  const model = bridge.getSuggestedChatModel()
  const started = await bridge.startServer()
  console.log(`PROBE | apiUrl=${started.apiUrl} profile=${bridge.getBrowserProfileDir()}`)
  for (const [, prompt] of prompts) {
    await send(started.apiUrl, model.apiKey, prompt)
  }
  return 0
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await run()
  } catch (error) {
    console.log('PROBE_FATAL | ' + (error?.message || String(error)))
  } finally {
    try {
      const bridge = require(path.join(__dirname, '..', 'electron', 'modules', 'genspark-web-bridge'))
      await bridge.closeLoginBrowser().catch(() => {})
      await bridge.closeExternalBrowser().catch(() => {})
      await bridge.stopServer().catch(() => {})
    } catch (_) { /* best effort */ }
    app.exit(code)
  }
})
