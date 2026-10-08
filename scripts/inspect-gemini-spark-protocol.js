/**
 * 只读：接入已登录的灵犀网页桥 Chrome，抓 Spark/Gemini 页面协议。
 * 不关闭浏览器，不导出 Cookie / Authorization / SAPISID。
 */

const fs = require('fs')
const path = require('path')
const net = require('net')
const { chromium } = require('playwright-core')

const DEBUG_PORTS = [19335, 19334, 19333, 19332, 19331, 19330, 19329, 19328, 19327]
const SPARK_URL = 'https://gemini.google.com/u/1/spark?pli=1'
const OUTPUT = path.join(__dirname, 'output', 'gemini-spark-protocol.json')
const INTERESTING = /streamgenerate|bardchatui|spark|agent|assistant\.lamda|batchexecute|GenerateContent|websocket|event-stream|text\/plain/i
const SECRET_HEADER = /cookie|authorization|sapisid|x-goog-authuser|x-client-data|set-cookie/i
const JS_HINT = /StreamGenerate|BardFrontendService|SparkFrontend|AssistantService|spark.?agent|CreateTask|agentId/i

function isTcpPortOpen(port, timeoutMs = 400) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
    setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
  })
}

function sanitizeHeaders(headers = {}) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (SECRET_HEADER.test(key)) out[key] = '[redacted]'
    else out[key] = String(value || '').slice(0, 180)
  }
  return out
}

function summarizeBody(text = '') {
  const value = String(text || '')
  return {
    bytes: Buffer.byteLength(value),
    looksJson: /^\s*[\[{]/.test(value),
    looksSse: /^(\s*|:)[^\n]*\ndata:/m.test(value) || value.includes('data: '),
    looksWrb: value.includes(")]}'") || value.includes('wrb.fr'),
    head: value.slice(0, 240).replace(/[^\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff]/g, '.')
  }
}

function shouldRecord(url = '', method = '') {
  if (!/gemini\.google\.com/i.test(String(url || ''))) return false
  if (/\/_\//.test(url)) return true
  if (INTERESTING.test(url)) return true
  return method === 'POST' || method === 'PUT'
}

function isSparkUrl(url = '') {
  return /gemini\.google\.com\/(?:u\/\d+\/)?spark/i.test(String(url || ''))
}

function isGeminiUrl(url = '') {
  return /gemini\.google\.com/i.test(String(url || ''))
}

async function listScriptHints(page) {
  const scripts = await page.evaluate(() => [...document.querySelectorAll('script[src]')]
    .map(node => node.src)
    .filter(Boolean)
    .slice(0, 80)).catch(() => [])
  const hints = []
  for (const src of scripts.slice(0, 24)) {
    try {
      const response = await page.request.get(src, { timeout: 8000 })
      const text = await response.text()
      const matches = [...text.matchAll(JS_HINT)].slice(0, 12).map(item => item[0])
      const paths = [...text.matchAll(/\/_\/[A-Za-z0-9./_-]{8,80}/g)].slice(0, 20).map(item => item[0])
      if (matches.length || paths.some(item => INTERESTING.test(item))) {
        hints.push({
          src: src.slice(0, 180),
          matches: [...new Set(matches)],
          paths: [...new Set(paths.filter(item => INTERESTING.test(item)))].slice(0, 20)
        })
      }
    } catch (_) { /* skip */ }
  }
  return { scriptCount: scripts.length, hints }
}

async function main() {
  const report = {
    capturedAt: new Date().toISOString(),
    connectedPort: 0,
    pages: [],
    openedSparkTab: false,
    requests: [],
    scriptHints: null,
    note: 'Cookie and auth header values are redacted. Browser is not closed.'
  }

  let endpoint = ''
  for (const port of DEBUG_PORTS) {
    if (await isTcpPortOpen(port)) {
      endpoint = `http://127.0.0.1:${port}`
      report.connectedPort = port
      break
    }
  }
  if (!endpoint) {
    report.error = '没有找到灵犀网页桥调试端口。请先在设置里打开 Gemini/Spark 登录检查，保持专用 Chrome 开着。'
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
    fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2))
    console.error(report.error)
    process.exit(2)
  }

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 })
  try {
    const context = browser.contexts()[0]
    if (!context) throw new Error('没有浏览器上下文。')
    const pages = context.pages().filter(page => !page.isClosed())
    report.pages = pages.map(page => ({ url: page.url().split('#')[0], title: '' }))
    for (let index = 0; index < pages.length; index += 1) {
      report.pages[index].title = await pages[index].title().catch(() => '')
    }

    let page = pages.find(item => isSparkUrl(item.url()))
      || pages.find(item => isGeminiUrl(item.url()))
      || pages[0]
    if (!page) throw new Error('没有可检查的页面。')

    if (!isSparkUrl(page.url())) {
      page = await context.newPage()
      report.openedSparkTab = true
      await page.goto(SPARK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
      await page.waitForTimeout(2500)
    }

    report.activeUrl = page.url().split('#')[0]
    report.activeTitle = await page.title().catch(() => '')
    report.scriptHints = await listScriptHints(page)

    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    const seen = []
    const onRequest = ({ request }) => {
      const url = String(request?.url || '')
      if (!shouldRecord(url, request.method)) return
      seen.push({
        id: request.requestId,
        method: request.method,
        url: url.replace(/([?&](token|at|bl|f\.sid)=)[^&]+/gi, '$1[redacted]'),
        type: request.type,
        hasPostData: Boolean(request.postDataEntries?.length || request.hasPostData)
      })
    }
    const onResponse = async ({ response, requestId }) => {
      const item = seen.find(entry => entry.id === requestId)
      if (!item) return
      item.status = response.status
      item.mimeType = response.mimeType
      item.responseHeaders = sanitizeHeaders(Object.fromEntries(
        (response.headers || []).map(header => [header.name, header.value])
      ))
    }
    cdp.on('Network.requestWillBeSent', onRequest)
    cdp.on('Network.responseReceived', onResponse)
    await page.waitForTimeout(6000)
    report.requests = seen.slice(0, 80)
    await cdp.detach().catch(() => {})
  } finally {
    // 只断开本探针的 CDP，不关用户正在用的专用 Chrome。
  }

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2), 'utf8')
  console.log(`wrote ${OUTPUT}`)
  console.log(`port=${report.connectedPort} url=${report.activeUrl || ''} requests=${report.requests.length} hints=${report.scriptHints?.hints?.length || 0}`)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
