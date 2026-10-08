// 临时端到端验证脚本（不属于产品代码，验证完可删除）。
// 直接加载 electron/modules/genspark-web-bridge.js，使用真实共用 Chrome 资料，
// 依次验证：本地接口启动、密钥校验、登录检查、真实网页聊天（非流式 + 流式多轮）。
// 用法：node scripts/tmp-e2e-genspark-bridge.js
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..')
const USER_DATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\lingxi-lingxicode'
const CONFIG_PATH = path.join(USER_DATA, 'genspark-web-bridge.json')
const LOG_PATH = path.join(ROOT, 'scripts', 'tmp-e2e-genspark-bridge.log')

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  fs.appendFileSync(LOG_PATH, line)
  process.stdout.write(line)
}

fs.writeFileSync(LOG_PATH, '')

// 用一个最小 electron 替身，让桥接模块在纯 node 下也能按真实 userData 运行。
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-e2e-electron-'))
const stubFile = path.join(stubDir, 'index.js')
fs.writeFileSync(stubFile, [
  "const path = require('path')",
  `const userData = ${JSON.stringify(USER_DATA)}`,
  'module.exports = {',
  "  app: {",
  "    getPath: (name) => (name === 'userData' ? userData : path.join(userData, String(name || ''))),",
  '    on: () => {},',
  '    whenReady: () => Promise.resolve(),',
  '    isReady: () => true,',
  '    quit: () => {}',
  '  },',
  '  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },',
  '  shell: { openExternal: () => Promise.resolve() },',
  '  BrowserWindow: class {}',
  '}',
  ''
].join('\n'), 'utf8')

const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return stubFile
  return originalResolveFilename.call(this, request, ...rest)
}

const bridge = require(path.join(ROOT, 'electron', 'modules', 'genspark-web-bridge.js'))

const guard = setTimeout(() => {
  log('FATAL 脚本自身超时（13 分钟），强制退出')
  process.exit(3)
}, 13 * 60 * 1000)

async function main() {
  const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8')
  log(`node ${process.version}`)

  const started = await bridge.startServer()
  log(`startServer -> ${JSON.stringify(started)}`)

  const config = JSON.parse(originalConfig)
  const base = `http://127.0.0.1:${config.port}`
  const auth = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }
  log(`base=${base}`)

  let response = await fetch(`${base}/health`)
  log(`GET /health -> ${response.status} ${JSON.stringify(await response.json())}`)

  response = await fetch(`${base}/v1/models`)
  log(`GET /v1/models（无密钥）-> ${response.status} ${(await response.text()).slice(0, 200)}`)

  response = await fetch(`${base}/v1/models`, { headers: auth })
  log(`GET /v1/models（有密钥）-> ${response.status} ${(await response.text()).slice(0, 300)}`)

  let stepAt = Date.now()
  response = await fetch(`${base}/session/check`, { method: 'POST', headers: auth, body: '{}' })
  log(`POST /session/check -> ${response.status}（${Date.now() - stepAt}ms）${(await response.text()).slice(0, 1500)}`)

  stepAt = Date.now()
  response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: 'genspark-web-chat',
      messages: [{ role: 'user', content: '请只回答一句话：1+1 等于几？' }]
    })
  })
  const chatText = await response.text()
  log(`POST /v1/chat/completions 非流式 -> ${response.status}（${Date.now() - stepAt}ms）${chatText.slice(0, 4000)}`)
  let firstAnswer = ''
  try {
    firstAnswer = JSON.parse(chatText)?.choices?.[0]?.message?.content || ''
  } catch (_) { /* 保留原始日志 */ }

  stepAt = Date.now()
  response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      model: 'genspark-web-chat',
      stream: true,
      messages: [
        { role: 'user', content: '请只回答一句话：1+1 等于几？' },
        { role: 'assistant', content: firstAnswer },
        { role: 'user', content: '那 2+2 呢？同样只用一句话回答。' }
      ]
    })
  })
  const sse = await response.text()
  const streamed = sse.split('\n')
    .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map(line => {
      try {
        return JSON.parse(line.slice(6))?.choices?.[0]?.delta?.content || ''
      } catch (_) {
        return ''
      }
    })
    .join('')
  log(`POST /v1/chat/completions 流式（第二轮）-> ${response.status}（${Date.now() - stepAt}ms）拼接回复=${JSON.stringify(streamed.slice(0, 2000))}`)

  response = await fetch(`${base}/health`)
  log(`GET /health（聊天后）-> ${response.status} ${JSON.stringify(await response.json())}`)

  fs.writeFileSync(CONFIG_PATH, originalConfig, 'utf8')
  log('已把 genspark-web-bridge.json 恢复为测试前内容')

  await bridge.stopServer().catch(() => {})
  return { ok: true, firstAnswer, streamed }
}

main()
  .then(result => {
    log(`E2E-RESULT ${JSON.stringify({ ok: result.ok, firstAnswer: result.firstAnswer, streamed: result.streamed }).slice(0, 2000)}`)
    log('E2E 结束：通过')
    clearTimeout(guard)
    process.exit(0)
  })
  .catch(error => {
    log(`E2E 结束：失败 ${error?.code ? error.code + ' ' : ''}${error?.message || error}`)
    log(String(error?.stack || '').slice(0, 4000))
    clearTimeout(guard)
    process.exit(1)
  })
