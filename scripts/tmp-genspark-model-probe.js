// 临时诊断脚本（不属于产品代码）：打开 Genspark 自动化页面，输出输入框附近的模型选择器结构。
// 设置 LINGXI_PROBE_MODEL 时会点击模型选择器并打印下拉选项，用于确认网页端当前模型与可选模型。
// 运行：node_modules\\electron\\dist\\electron.exe scripts\\tmp-genspark-model-probe.js
'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const USER_DATA = process.env.LINGXI_E2E_USER_DATA || 'C:\\Users\\Administrator\\AppData\\Roaming\\lingxi-lingxicode'
const DEBUG_PORT = Number(process.env.LINGXI_E2E_DEBUG_PORT || 19336)
const WANT_MODEL = String(process.env.LINGXI_PROBE_MODEL || '').trim()
const LOG_PATH = path.join(__dirname, 'tmp-genspark-model-probe.log')

app.setPath('userData', USER_DATA)

function out(text) {
  const line = `[${new Date().toISOString()}] ${text}\n`
  try { process.stdout.write(line) } catch (_) { /* 控制台可能不可用 */ }
  try { fs.appendFileSync(LOG_PATH, line) } catch (_) { /* 日志写失败不影响主流程 */ }
}

async function withPage(fn) {
  const { chromium } = require('playwright-core')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`, { timeout: 20000 })
  try {
    const pages = browser.contexts().flatMap(context => context.pages())
    const page = pages.find(item => /genspark\.ai/.test(item.url())) || pages[0]
    if (!page) throw new Error('没有找到 Genspark 页面')
    return await fn(page)
  } finally {
    await browser.close().catch(() => {})
  }
}

async function main() {
  fs.writeFileSync(LOG_PATH, '')
  const bridge = require(path.join(__dirname, '..', 'electron', 'modules', 'genspark-web-bridge.js'))
  const model = bridge.getSuggestedChatModel()
  const started = await bridge.startServer()
  const base = String(started.apiUrl || '').replace(/\/v1$/, '')
  out('START ' + JSON.stringify({ apiUrl: started.apiUrl, profile: bridge.getBrowserProfileDir() }))

  const res = await fetch(`${base}/session/check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${model.apiKey}`, 'Content-Type': 'application/json' },
    body: '{}'
  })
  out('SESSION ' + res.status + ' ' + (await res.text()).slice(0, 1200))

  const snapshot = await withPage(page => page.evaluate(() => {
    const modelWord = /(claude|gpt|gemini|grok|deepseek|qwen|opus|sonnet|sol|luna|terra|模型|model)/i
    const composer = document.querySelector('textarea, div[contenteditable="true"], [contenteditable="true"]')
    const composerRect = composer ? composer.getBoundingClientRect() : null
    const candidates = []
    for (const el of document.querySelectorAll('button,[role="button"],[role="combobox"],[aria-haspopup]')) {
      const text = String(el.innerText || '').trim()
      if (!text || text.length > 40 || !modelWord.test(text)) continue
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      candidates.push({
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 60),
        cls: String(el.className || '').slice(0, 90),
        aria: String(el.getAttribute('aria-label') || '').slice(0, 60),
        hasPopup: !!el.getAttribute('aria-haspopup'),
        expanded: el.getAttribute('aria-expanded'),
        bottomGap: composerRect ? Math.round(composerRect.bottom - rect.bottom) : null,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
      })
    }
    return {
      url: location.href,
      title: document.title,
      composerTag: composer ? composer.tagName.toLowerCase() : '',
      composerPlaceholder: composer ? String(composer.getAttribute('placeholder') || '').slice(0, 80) : '',
      candidates: candidates.slice(0, 25),
      bodyHead: String(document.body ? document.body.innerText : '').slice(0, 700)
    }
  }))
  out('SNAPSHOT ' + JSON.stringify(snapshot).slice(0, 4500))

  if (WANT_MODEL) {
    const menu = await withPage(async page => {
      const clicked = await page.evaluate(() => {
        const modelWord = /(claude|gpt|gemini|grok|opus|sonnet|sol|luna|terra|模型|model)/i
        const composer = document.querySelector('textarea, div[contenteditable="true"]')
        const composerRect = composer ? composer.getBoundingClientRect() : null
        const nodes = Array.from(document.querySelectorAll('button,[role="button"],[role="combobox"],[aria-haspopup]'))
        const chip = nodes.find(el => {
          const text = String(el.innerText || '').trim()
          if (!text || text.length > 40 || !modelWord.test(text)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          return composerRect ? Math.abs(composerRect.bottom - rect.bottom) < 220 : true
        })
        if (!chip) return { ok: false, reason: 'chip-not-found' }
        chip.click()
        return { ok: true, chipText: String(chip.innerText || '').trim().slice(0, 60) }
      })
      if (!clicked.ok) return clicked
      await new Promise(resolve => setTimeout(resolve, 1500))
      const options = await page.evaluate(() => {
        const items = []
        for (const el of document.querySelectorAll('[role="option"],[role="menuitem"],li,button,div[class*=item],div[class*=option]')) {
          const text = String(el.innerText || '').trim()
          if (!text || text.length > 80) continue
          const rect = el.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) continue
          items.push({ text: text.slice(0, 80), cls: String(el.className || '').slice(0, 70), y: Math.round(rect.y) })
        }
        return items.slice(0, 40)
      })
      return { ok: true, chipText: clicked.chipText, options }
    })
    out('MODEL_MENU ' + JSON.stringify(menu).slice(0, 4500))
  }

  out('DONE')
}

app.whenReady().then(async () => {
  let code = 0
  try {
    await main()
  } catch (error) {
    code = 1
    out('FATAL ' + (error && error.stack ? error.stack : String(error)))
  }
  app.exit(code)
})
