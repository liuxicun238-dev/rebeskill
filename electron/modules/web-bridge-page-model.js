/**
 * 网页桥：在页面上切换模型 / 思考档，并把设置写进各桥自己的 json。
 * 点不到对应控件时不抛错，照常把提示词发进输入框。
 */

function pickAllowed(value, allowed, fallback) {
  const next = String(value || '').trim().toLowerCase()
  return allowed.includes(next) ? next : fallback
}

function asBool(value, fallback = false) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return fallback
}

function normalizeGeminiPagePrefs(raw = {}) {
  let pageModel = String(raw.pageModel || '').trim().toLowerCase()
  let thinkingEnabled = raw.thinkingEnabled
  if (pageModel === 'fast') pageModel = 'flash-lite'
  if (pageModel === 'flash') pageModel = 'flash-3.7'
  if (pageModel === 'thinking') {
    pageModel = 'flash-3.7'
    if (thinkingEnabled == null) thinkingEnabled = true
  }
  pageModel = pickAllowed(pageModel, ['flash-lite', 'flash-3.6', 'flash-3.7', 'pro'], 'flash-3.7')
  thinkingEnabled = asBool(thinkingEnabled, false)
  return { pageModel, thinkingEnabled, thinkingLevel: thinkingEnabled ? 'extended' : 'default' }
}

function normalizeChatGptPagePrefs(raw = {}) {
  let pageModel = String(raw.pageModel || '').trim().toLowerCase()
  let thinkingLevel = String(raw.thinkingLevel || '').trim().toLowerCase()
  if (pageModel === 'instant') {
    pageModel = 'gpt-5.6'
    if (!thinkingLevel) thinkingLevel = 'low'
  } else if (pageModel === 'thinking' || pageModel === 'auto') {
    pageModel = 'gpt-5.6'
    if (!thinkingLevel) thinkingLevel = 'medium'
  } else if (pageModel === 'pro') {
    pageModel = 'gpt-5.6'
    if (!thinkingLevel) thinkingLevel = 'high'
  }
  pageModel = pickAllowed(pageModel, ['gpt-5.6', 'gpt-5.5', 'o3'], 'gpt-5.6')
  thinkingLevel = pickAllowed(thinkingLevel, ['low', 'medium', 'high', 'xhigh'], 'high')
  if (thinkingLevel === 'xhigh') thinkingLevel = 'high'
  return { pageModel, thinkingEnabled: asBool(raw.thinkingEnabled, thinkingLevel !== 'low'), thinkingLevel }
}

function normalizeDeepSeekPagePrefs(raw = {}) {
  const pageModel = pickAllowed(raw.pageModel, ['fast', 'expert'], 'fast')
  const thinkingEnabled = asBool(raw.thinkingEnabled, pageModel === 'expert')
  const thinkingLevel = pickAllowed(raw.thinkingLevel, ['default', 'high'], 'default')
  return { pageModel, thinkingEnabled, thinkingLevel }
}

function fingerprintPagePrefs(prefs = {}) {
  return JSON.stringify(prefs || {})
}

function geminiSuggestedModelName(prefs = {}) {
  const model = { 'flash-lite': '3.5 Flash-Lite', 'flash-3.6': '3.6 Flash', 'flash-3.7': '3.7 Flash', pro: '3.1 Pro' }[prefs.pageModel] || '3.7 Flash'
  if (!prefs.thinkingEnabled) return `Gemini 网页版 ${model}`
  return `Gemini 网页版 ${model} · 扩展思考`
}

function chatgptSuggestedModelName(prefs = {}) {
  const model = { 'gpt-5.6': 'GPT-5.6', 'gpt-5.5': 'GPT-5.5', o3: 'o3' }[prefs.pageModel] || 'GPT-5.6'
  const level = { low: '低', medium: '中', high: '高' }[prefs.thinkingLevel] || '高'
  return `ChatGPT 网页版 ${model} · 推理${level}（本地 Chrome）`
}

function deepseekSuggestedModelName(prefs = {}) {
  const model = prefs.pageModel === 'expert' ? '专家' : '快速'
  if (!prefs.thinkingEnabled) return `DeepSeek 网页版 ${model}（本地 Chrome）`
  const level = prefs.thinkingLevel === 'high' ? '更长思考' : '深度思考'
  return `DeepSeek 网页版 ${model} · ${level}（本地 Chrome）`
}

function visibleClickables(document) {
  return Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="switch"], [role="tab"], a, label'))
    .filter(node => {
      const rect = node.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) return false
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
    })
}

function nodeLabel(node) {
  return String(
    node.getAttribute('aria-label')
    || node.getAttribute('title')
    || node.getAttribute('data-testid')
    || node.textContent
    || ''
  ).replace(/\s+/g, ' ').trim()
}

function labelMatches(label, needles) {
  const text = String(label || '').toLowerCase()
  if (!text || text.length > 96) return false
  return (needles || []).some(needle => {
    const want = String(needle || '').toLowerCase().trim()
    return want && (text === want || text.includes(want))
  })
}

async function clickMatchingControl(page, needles) {
  if (!page || page.isClosed()) return ''
  return page.evaluate((wanted) => {
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="switch"], [role="tab"], a, label'))
    const match = nodes.find(node => {
      const rect = node.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) return false
      const style = window.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      const label = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('data-testid') || node.textContent || '').replace(/\s+/g, ' ').trim()
      if (!label || label.length > 96) return false
      const text = label.toLowerCase()
      return wanted.some(needle => {
        const want = String(needle || '').toLowerCase().trim()
        return want && (text === want || text.includes(want))
      })
    })
    if (!match) return ''
    const target = match.closest('button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="switch"], [role="tab"]') || match
    target.click()
    return String(target.getAttribute('aria-label') || target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  }, needles).catch(() => '')
}

async function currentMatchingLabel(page, needles) {
  if (!page || page.isClosed()) return ''
  return page.evaluate((wanted) => {
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [aria-pressed="true"], [aria-checked="true"], [aria-current="true"]'))
    for (const node of nodes) {
      const rect = node.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) continue
      const label = String(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').replace(/\s+/g, ' ').trim()
      const text = label.toLowerCase()
      if (!label || label.length > 96) continue
      if (wanted.some(needle => text.includes(String(needle || '').toLowerCase()))) return label.slice(0, 80)
    }
    return ''
  }, needles).catch(() => '')
}

async function applyGeminiPageModel(page, prefs = {}) {
  const next = normalizeGeminiPagePrefs(prefs)
  const modelNeedles = next.pageModel === 'pro'
    ? ['3.1 pro', 'gemini pro', 'pro']
    : next.pageModel === 'flash-lite'
      ? ['flash-lite', '3.5', '极速']
      : next.pageModel === 'flash-3.6'
        ? ['3.6 flash', '3.6']
        : ['3.7 flash', '3.7']
  const already = await currentMatchingLabel(page, modelNeedles)
  if (!already) {
    const opened = await clickMatchingControl(page, ['gemini flash', 'flash', 'pro', '模型', 'model', '3.7', '3.5'])
    if (opened) await page.waitForTimeout(280).catch(() => {})
    await clickMatchingControl(page, modelNeedles)
    await page.waitForTimeout(200).catch(() => {})
  }
  const thinkingOn = await currentMatchingLabel(page, ['扩展思考', 'extended thinking'])
  if (next.thinkingEnabled && !thinkingOn) {
    await clickMatchingControl(page, ['扩展思考', 'extended thinking'])
  } else if (!next.thinkingEnabled && thinkingOn) {
    await clickMatchingControl(page, ['扩展思考', 'extended thinking'])
  }
  return fingerprintPagePrefs(next)
}

async function applyChatGptPageModel(page, prefs = {}) {
  const next = normalizeChatGptPagePrefs(prefs)
  const switcher = page.locator('[data-testid="model-switcher-dropdown-button"], button[aria-haspopup="menu"]').first()
  if (await switcher.count().catch(() => 0)) {
    const current = String(await switcher.textContent().catch(() => '') || '').toLowerCase()
    const want = next.pageModel
    const already = (
      (want === 'gpt-5.6' && /5\.6/.test(current))
      || (want === 'gpt-5.5' && /5\.5/.test(current))
      || (want === 'o3' && /\bo3\b/.test(current))
    )
    if (!already) {
      await switcher.click({ timeout: 2000 }).catch(() => {})
      await page.waitForTimeout(250).catch(() => {})
      const optionNeedles = want === 'o3'
        ? ['o3']
        : want === 'gpt-5.5'
          ? ['gpt-5.5', '5.5']
          : ['gpt-5.6', '5.6']
      await clickMatchingControl(page, optionNeedles)
      await page.waitForTimeout(200).catch(() => {})
    }
  }
  await clickMatchingControl(page, ['推理强度', 'reasoning'])
  const levelNeedles = {
    low: ['低', 'low'],
    medium: ['中', 'medium', '标准'],
    high: ['高', 'high']
  }[next.thinkingLevel] || ['高', 'high']
  await clickMatchingControl(page, levelNeedles)
  return fingerprintPagePrefs(next)
}

async function applyDeepSeekPageModel(page, prefs = {}) {
  const next = normalizeDeepSeekPagePrefs(prefs)
  if (next.pageModel === 'expert') {
    await clickMatchingControl(page, ['专家', 'expert', 'r1', 'reasoner', '深度思考'])
  } else {
    await clickMatchingControl(page, ['快速', 'fast', 'v3', 'chat'])
  }
  await page.waitForTimeout(180).catch(() => {})
  const thinkingOn = await currentMatchingLabel(page, ['深度思考', 'deepthink', 'thinking'])
  if (next.thinkingEnabled && !thinkingOn) {
    await clickMatchingControl(page, ['深度思考', 'deepthink', 'thinking'])
  } else if (!next.thinkingEnabled && thinkingOn && next.pageModel === 'fast') {
    await clickMatchingControl(page, ['深度思考', 'deepthink', 'thinking'])
  }
  if (next.thinkingEnabled && next.thinkingLevel === 'high') {
    await clickMatchingControl(page, ['更长', 'high', '高'])
  }
  return fingerprintPagePrefs(next)
}

async function applyPagePrefsIfNeeded(page, session, prefs, applyFn) {
  const fingerprint = fingerprintPagePrefs(prefs)
  if (!page || page.isClosed()) return fingerprint
  if (session?.appliedPagePrefs === fingerprint) return fingerprint
  try {
    await applyFn(page, prefs)
    if (session) session.appliedPagePrefs = fingerprint
  } catch (_) { /* 页面控件变动时仍发送提示词 */ }
  return fingerprint
}

module.exports = {
  normalizeGeminiPagePrefs,
  normalizeChatGptPagePrefs,
  normalizeDeepSeekPagePrefs,
  fingerprintPagePrefs,
  geminiSuggestedModelName,
  chatgptSuggestedModelName,
  deepseekSuggestedModelName,
  applyGeminiPageModel,
  applyChatGptPageModel,
  applyDeepSeekPageModel,
  applyPagePrefsIfNeeded,
  visibleClickables,
  nodeLabel,
  labelMatches
}
