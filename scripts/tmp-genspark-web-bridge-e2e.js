/**
 * 临时端到端验证（可删除）：用真实 userData 与真实 Genspark 登录资料启动网页桥，
 * 走本机 HTTP 接口完成“登录检查 + 真实发消息”，并打印结果。
 *
 * 运行：node_modules\\electron\\dist\\electron.exe scripts\\tmp-genspark-web-bridge-e2e.js
 * 保活：设 LINGXI_E2E_KEEP_OPEN=1 时保留浏览器与本地服务。
 */
const path = require('path')
const { app } = require('electron')

const USER_DATA = process.env.LINGXI_E2E_USER_DATA
  || 'C:\\Users\\Administrator\\AppData\\Roaming\\lingxi-lingxicode'
app.setPath('userData', USER_DATA)

const WATCHDOG_MS = Number(process.env.LINGXI_E2E_TIMEOUT_MS || 600000)
const CHAT_TIMEOUT_MS = Number(process.env.LINGXI_E2E_CHAT_TIMEOUT_MS || 240000)
const DEBUG_PORT = Number(process.env.LINGXI_E2E_DEBUG_PORT || 19336)
const RAND = String(process.hrtime.bigint()).slice(-6)

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).replace(/\s+/g, ' ').slice(0, 600) })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${results.at(-1).detail}`)
}

function summary() {
  const failed = results.filter(item => !item.ok).length
  console.log(`SUMMARY | total=${results.length} passed=${results.length - failed} failed=${failed}`)
  return failed
}

const watchdog = setTimeout(() => {
  console.log('WATCHDOG_TIMEOUT | 端到端验证超时，以下为当前进度')
  summary()
  app.exit(3)
}, WATCHDOG_MS)
watchdog.unref?.()

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function callApi(baseUrl, apiKey, apiPath, body, timeoutMs) {
  const startedAt = Date.now()
  const res = await fetchWithTimeout(`${baseUrl}${apiPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }, timeoutMs)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch (_) { /* SSE 或纯文本错误 */ }
  return { status: res.status, text, json, elapsedMs: Date.now() - startedAt }
}

function pickAnswer(payload) {
  return String(payload?.choices?.[0]?.message?.content || payload?.output_text || '')
}

function streamContent(raw) {
  let out = ''
  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload)
      out += String(parsed?.choices?.[0]?.delta?.content || '')
    } catch (_) { /* heartbeat或非 JSON 行 */ }
  }
  return out
}

async function dumpDiagnostics() {
  console.log('DIAG | 连接自动化浏览器抓取页面结构')
  try {
    const { chromium } = require('playwright-core')
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`, { timeout: 15000 })
    const context = browser.contexts()[0]
    const pages = context.pages().slice(0, 6)
    if (!pages.length) console.log('DIAG | 没有可用页面')
    for (const [index, page] of pages.entries()) {
      const info = await page.evaluate(() => {
        const composer = document.querySelector('textarea, div[contenteditable="true"], [contenteditable="true"]')
        const replies = Array.from(document.querySelectorAll('[class*="markdown"], [class*="prose"], [class*="assistant"]'))
          .map(node => String(node.innerText || '').trim())
          .filter(Boolean)
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'))
          .filter(node => {
            const rect = node.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          })
          .slice(0, 12)
          .map(node => ({
            tag: node.tagName.toLowerCase(),
            cls: String(node.className || '').slice(0, 100),
            aria: String(node.getAttribute('aria-label') || '').slice(0, 40)
          }))
        return {
          url: location.href,
          title: document.title,
          bodyHead: String(document.body?.innerText || '').slice(0, 400),
          composerTag: composer ? composer.tagName.toLowerCase() : '',
          composerPlaceholder: composer ? String(composer.getAttribute('placeholder') || '').slice(0, 60) : '',
          replyCount: replies.length,
          replies: replies.slice(-3).map(text => text.slice(0, 300)),
          buttons
        }
      }).catch(error => ({ error: error.message }))
      console.log(`DIAG_PAGE[${index}] | ` + JSON.stringify(info).slice(0, 3000))
    }
    await browser.close().catch(() => {})
  } catch (error) {
    console.log('DIAG | 失败：' + error.message)
  }
}

async function run() {
  const bridge = require(path.join(__dirname, '..', 'electron', 'modules', 'genspark-web-bridge'))
  const model = bridge.getSuggestedChatModel()
  const profileDir = bridge.getBrowserProfileDir()
  console.log(`ENV | userData=${USER_DATA}`)
  console.log(`ENV | profile=${profileDir}`)

  const started = await bridge.startServer()
  const baseUrl = started.apiUrl.replace(/\/v1$/, '')
  record('server/start', started.running === true, `apiUrl=${started.apiUrl} port=${started.port} browser=${started.browserName} exe=${started.browserExecutable}`)

  const health = await fetchWithTimeout(`${baseUrl}/health`, {}, 10000)
  record('http/health', health.status === 200, `status=${health.status}`)

  const unauthorized = await fetchWithTimeout(`${started.apiUrl}/models`, {}, 10000)
  record('http/models-unauthorized', unauthorized.status === 401, `status=${unauthorized.status}`)

  const models = await fetchWithTimeout(`${started.apiUrl}/models`, { headers: { Authorization: `Bearer ${model.apiKey}` } }, 10000)
  const modelsJson = await models.json().catch(() => null)
  record('http/models-authorized', models.status === 200 && modelsJson?.data?.some(item => item.id === 'genspark-web-chat'), `status=${models.status} ids=${(modelsJson?.data || []).map(item => item.id).join(',')}`)
  record('model/entry', model.provider === 'genspark-web-bridge' && model.apiUrl.endsWith('/v1') && model.modelId === 'genspark-web-chat', `provider=${model.provider} apiUrl=${model.apiUrl} toolCalling=${model.capabilities.toolCalling}`)
  record('model/toolCalling-declared', model.capabilities.toolCalling === false, `toolCalling=${model.capabilities.toolCalling}`)

  const check = await callApi(baseUrl, model.apiKey, '/session/check', {}, 120000)
  const page = check.json?.page || {}
  record('login/check(第2步)', check.status === 200 && page.composerFound === true, `status=${check.status} ms=${check.elapsedMs} composerFound=${page.composerFound} url=${page.url || ''} title=${page.title || ''} instruction=${check.json?.instruction || ''}`)
  if (page.composerFound !== true) {
    await dumpDiagnostics()
    return summary()
  }

  const plain = await callApi(baseUrl, model.apiKey, '/v1/chat/completions', {
    model: 'genspark-web-chat',
    messages: [{ role: 'user', content: `你好，请用一句话回答：现在能正常对话吗？回答里请包含 ${RAND} 这串数字。` }]
  }, CHAT_TIMEOUT_MS)
  const plainAnswer = pickAnswer(plain.json)
  record('chat/plain', plain.status === 200 && plainAnswer.trim().length >= 8, `status=${plain.status} ms=${plain.elapsedMs} len=${plainAnswer.trim().length} answer=${plainAnswer.slice(0, 300) || plain.text.slice(0, 300)}`)

  const stream = await callApi(baseUrl, model.apiKey, '/v1/chat/completions', {
    model: 'genspark-web-chat',
    stream: true,
    messages: [{ role: 'user', content: '谢谢，请再用一句话说明你能帮我做哪些事情。' }]
  }, CHAT_TIMEOUT_MS)
  const streamText = streamContent(stream.text)
  record('chat/stream', stream.status === 200 && stream.text.includes('[DONE]') && streamText.trim().length >= 6, `status=${stream.status} ms=${stream.elapsedMs} len=${streamText.trim().length} chunks=${(stream.text.match(/data:/g) || []).length} content=${streamText.slice(0, 300)}`)

  const finalStatus = bridge.getStatus()
  console.log('STATUS | ' + JSON.stringify({
    loggedIn: finalStatus.loggedIn,
    browserMode: finalStatus.browserMode,
    chatSessionCount: finalStatus.chatSessionCount,
    waitDiagnostics: finalStatus.waitDiagnostics,
    lastError: finalStatus.lastError
  }))

  if (results.some(item => !item.ok)) await dumpDiagnostics()
  return summary()
}

app.whenReady().then(async () => {
  let failed = 1
  try {
    failed = await run()
  } catch (error) {
    console.log('FATAL | ' + (error?.stack || error?.message || String(error)))
  } finally {
    try {
      const bridge = require(path.join(__dirname, '..', 'electron', 'modules', 'genspark-web-bridge'))
      if (!process.env.LINGXI_E2E_KEEP_OPEN) {
        await bridge.closeLoginBrowser().catch(() => {})
        await bridge.closeExternalBrowser().catch(() => {})
        await bridge.stopServer().catch(() => {})
      } else {
        console.log('KEEP_OPEN | 保留浏览器与本地服务')
      }
    } catch (_) { /* best effort */ }
    app.exit(failed ? 1 : 0)
  }
})
