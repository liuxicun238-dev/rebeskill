/**
 * Universal Dynamic Search Pipeline UI (支持内置工具与搜索模型的统一动态流式与拟态呈现)
 * Mounted by ai-tool-renderer; provides state machine & pipeline view.
 */
(function () {
  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function isSearchTool(name = '') {
    const s = String(name || '').toLowerCase()
    return s === 'web_search' || s === 'web_bridge_search' || s === 'lxweb' || s === 'web_open' || s === 'chatgpt_web_search'
  }

  function displayText(key, fallback) {
    if (window.I18n?.t) {
      const text = window.I18n.t(key)
      if (text && text !== key) return text
    }
    return fallback
  }

  function extractDomain(urlStr = '') {
    try {
      if (!/^https?:\/\//i.test(urlStr)) return ''
      const parsed = new URL(urlStr)
      return parsed.hostname.replace(/^www\./i, '')
    } catch {
      return ''
    }
  }

  function stageLabel(stage) {
    const map = {
      connecting: displayText('toolDisplay.search.connecting', '正在连接搜索服务…'),
      searching: displayText('toolDisplay.search.searching', '正在检索网页…'),
      reading: displayText('toolDisplay.search.reading', '正在阅读网页来源…'),
      results: displayText('toolDisplay.search.results', '已收到证据'),
      done: displayText('toolDisplay.search.done', '联网检索完成'),
      error: displayText('toolDisplay.search.error', '检索未命中或失败')
    }
    return map[stage] || map.searching
  }

  function normalizeState(input = {}, args = {}, result = {}) {
    const queries = []
    const pushQuery = q => {
      const text = String(q || '').trim()
      if (text && !queries.includes(text)) queries.push(text)
    }

    if (Array.isArray(input.queries)) input.queries.forEach(pushQuery)
    pushQuery(input.query)
    pushQuery(args.query)
    pushQuery(args.pattern)
    pushQuery(args.url)
    if (Array.isArray(args.queries)) args.queries.forEach(pushQuery)
    if (Array.isArray(result.queries)) result.queries.forEach(pushQuery)
    pushQuery(result.query)
    pushQuery(result.url)

    const sources = []
    const pushSource = item => {
      if (!item) return
      if (typeof item === 'string') {
        const d = extractDomain(item)
        if (item.trim()) sources.push({ url: item, title: item, snippet: '', domain: d })
        return
      }
      const url = item.url || item.link || item.href || ''
      const title = item.title || item.name || url || ''
      const snippet = item.snippet || item.description || item.summary || item.content || ''
      const domain = item.domain || extractDomain(url)
      if (url || title || snippet) {
        sources.push({ url, title, snippet, domain })
      }
    }

    if (Array.isArray(input.sources)) input.sources.forEach(pushSource)
    if (Array.isArray(result.sources)) result.sources.forEach(pushSource)
    if (Array.isArray(result.results)) result.results.forEach(pushSource)
    if (Array.isArray(result.items)) result.items.forEach(pushSource)

    const groups = Array.isArray(input.resultGroups)
      ? input.resultGroups
      : (Array.isArray(result.result_groups) ? result.result_groups : (Array.isArray(result.resultGroups) ? result.resultGroups : []))

    if (groups.length && !sources.length) {
      groups.forEach(g => {
        const domain = g.domain || ''
        if (Array.isArray(g.entries)) {
          g.entries.forEach(e => pushSource({ ...e, domain: domain || extractDomain(e.url) }))
        }
      })
    }

    const sourceCount = Number(input.sourceCount) || sources.length
    const error = input.error || result.error || ''
    const stage = error
      ? 'error'
      : (input.stage || (result.success === false ? 'error' : (sourceCount > 0 || result.answer || result.text ? 'done' : 'connecting')))

    return { stage, queries, sources, resultGroups: groups, sourceCount, error, answer: result.answer || result.text || '' }
  }

  function buildSummaryHtml(state, isPending = false) {
    const query = state.queries[0] || (state.sources[0]?.title) || displayText('toolDisplay.text.searchDone', '联网检索')
    const bits = [`<span class=\"op-file\">${escapeHtml(query)}</span>`]

    if (state.queries.length > 1) {
      bits.push(`<span class=\"op-source\">+${state.queries.length - 1}个查询</span>`)
    }

    if (isPending || state.stage === 'connecting' || state.stage === 'searching' || state.stage === 'reading') {
      bits.push(`<span class=\"op-source dynamic-search-pulse\">${escapeHtml(stageLabel(state.stage))}</span>`)
    } else if (state.sourceCount > 0) {
      bits.push(`<span class=\"op-source\">→ 命中 ${state.sourceCount} 个网页证据</span>`)
    } else if (state.stage === 'done') {
      bits.push(`<span class=\"op-source\">→ 检索完成</span>`)
    } else if (state.stage === 'error') {
      bits.push(`<span class=\"op-source\">→ 检索未命中</span>`)
    }

    return bits.join(' ')
  }

  function buildDetailHtml(state) {
    const queriesHtml = state.queries.length > 1
      ? `<div class=\"cws-queries\"><span class=\"cws-queries-label\">检索词:</span>${state.queries.map(item => `<span class=\"cws-query\">${escapeHtml(item)}</span>`).join('')}</div>`
      : ''

    const sourcesHtml = (state.sources || []).map((entry, index) => {
      const title = escapeHtml(entry.title || entry.url || `网页来源 ${index + 1}`)
      const url = String(entry.url || '')
      const safeUrl = escapeHtml(url)
      const domain = escapeHtml(entry.domain || extractDomain(url) || '网页')
      const snippet = entry.snippet ? `<div class=\"cws-snippet\">${escapeHtml(entry.snippet)}</div>` : ''
      const faviconHtml = `<span class=\"cws-favicon\">🌐</span>`
      const link = /^https?:\/\//i.test(url)
        ? `<a class=\"cws-link\" href=\"${safeUrl}\" onclick=\"event.preventDefault();event.stopPropagation();openInWebview('${safeUrl}')\" title=\"点击在右侧打开预览\">${title}</a>`
        : `<span class=\"cws-link\">${title}</span>`

      return `<li class=\"cws-entry\">
        <div class=\"cws-entry-header\">
          ${faviconHtml}
          <span class=\"cws-domain-badge\">${domain}</span>
          ${link}
        </div>
        ${snippet}
      </li>`
    }).join('')

    const entriesListHtml = sourcesHtml ? `<ul class=\"cws-entries\">${sourcesHtml}</ul>` : ''
    const errorHtml = state.error ? `<pre class=\"tool-error\">${escapeHtml(state.error)}</pre>` : ''
    const emptyHtml = !entriesListHtml && !errorHtml ? `<div class=\"cws-status\">${escapeHtml(stageLabel(state.stage))}</div>` : ''

    return `<div class=\"chatgpt-web-search-stream\" data-stage=\"${escapeHtml(state.stage)}\">${queriesHtml}${entriesListHtml}${emptyHtml}${errorHtml}</div>`
  }

  function findCard(meta = {}, name = '') {
    const toolCallId = meta.toolCallId || ''
    if (toolCallId) {
      const match = document.querySelector(`.tool-call-card[data-tool-call-id=\"${CSS.escape(toolCallId)}\"]`)
      if (match) return match
    }
    const cards = [...document.querySelectorAll('.tool-call-card[data-tool-name^=\"web_\"], .tool-call-card[data-tool-name=\"lxweb\"], .tool-call-card.pending')]
    return cards.reverse().find(card => isSearchTool(card.dataset.toolName || name)) || null
  }

  function applyToCard(card, state, isPending = false) {
    if (!card) return null
    card.classList.add('chatgpt-web-search-card')
    card.dataset.searchStage = state.stage || ''

    const summaryEl = card.querySelector('.tool-card-summary')
    if (summaryEl) summaryEl.innerHTML = buildSummaryHtml(state, isPending)

    const detailEl = card.querySelector('.tool-card-detail')
    if (detailEl) {
      detailEl.innerHTML = buildDetailHtml(state)
    }

    const group = card.closest('.tool-call-group')
    const currentEl = group?.querySelector('.tool-group-current')
    const toolEl = card.querySelector('.tool-card-tool')
    const toolName = toolEl?.textContent || displayText('tool.web_bridge_search', '联网检索')
    if (currentEl && summaryEl) {
      currentEl.innerHTML = `<span class=\"tool-card-tool\">${escapeHtml(toolName)}</span> ${summaryEl.innerHTML}`
    }
    return card
  }

  // 拟态流式状态机：在后端快速拿到结果时，前台优雅过渡动画
  function playSimulatedSearchRhythm(card, state) {
    if (!card || !state.sourceCount) return
    // Phase 1: 正在阅读网页
    applyToCard(card, { ...state, stage: 'reading' }, true)
    setTimeout(() => {
      // Phase 2: 完成收拢
      applyToCard(card, state, false)
    }, 380)
  }

  window.ChatGptWebSearchToolUi = {
    isSearchTool,
    normalizeState,
    buildSummaryHtml,
    buildDetailHtml,
    applyToCard,
    playSimulatedSearchRhythm,
    update(name, progress = {}, meta = {}, args = {}, result = {}) {
      if (!isSearchTool(name) && progress.kind !== 'chatgpt-web-search') return null
      const state = normalizeState(progress, args, result)
      const card = meta.card || findCard(meta, name)
      return applyToCard(card, state, false)
    }
  }
})()

