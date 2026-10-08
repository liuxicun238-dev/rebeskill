/**
 * 标准模式团队图：外观抄 AgentCore 协作图（状态条 + 你的任务/队员/CEO 汇总 + 团队便签）。
 * 点节点后的思考块、工具卡仍走灵犀自己的检查器。
 */
(function () {
  'use strict'

  const TASK_ID = 'task'
  const CEO_ID = 'ceo'
  const NODE_W = 210
  const NODE_H = 110
  const LAYER_GAP = 80
  const ROW_GAP = 56
  const LAYOUT_PAD = 24
  const EMBED_MIN_HEIGHT = 180
  const EMBED_MAX_HEIGHT = 520
  const EMBED_DEFAULT_COL_WIDTH = 718
  const AGENT_PALETTE = 8

  const TERMINAL = new Set(['done', 'completed', 'cancelled', 'interrupted', 'completed_with_errors', 'error', 'failed'])
  const ERROR = new Set(['error', 'failed', 'timeout'])
  const RUNNING = new Set(['queued', 'thinking', 'streaming', 'using_tools', 'running', 'active', 'working', 'running_with_errors'])
  const DONE = new Set(['done', 'completed'])

  const hosts = new Map()
  let timer = 0
  let pending = null

  const ICONS = {
    spinner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" class="ai-team-spin" aria-hidden="true"><circle class="ai-team-spin-track" cx="12" cy="12" r="9" opacity="0.22"></circle><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke-linecap="round"></path></svg>',
    ring: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle></svg>',
    checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.6 2.5L16 9.5"></path></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5L19 7"></path></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
    chevronUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 15l6-6 6 6"></path></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"></path></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"></path></svg>',
    maximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"></path><path d="M9 21H3v-6"></path><path d="M21 3l-7 7"></path><path d="M3 21l7-7"></path></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="7" r="4"></circle></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 7.2L21 11l-7.4 1.8L12 20l-1.6-7.2L3 11l7.4-1.8z"></path></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M15 3v5h5"></path></svg>',
    square: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"></rect></svg>'
  }

  function escapeHtml(value) {
    if (window.HtmlUtils?.escapeHtml) return window.HtmlUtils.escapeHtml(value)
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function stripThink(value) {
    return String(value || '')
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
      .replace(/<\/?think\b[^>]*>/gi, '')
      .replace(/```(?:think|thinking|reasoning)[\s\S]*?```/gi, '')
  }

  function compactText(value, limit) {
    const text = stripThink(value).replace(/\s+/g, ' ').trim()
    if (!text) return ''
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text
  }

  function hashRole(role) {
    let h = 0x811c9dc5
    const key = String(role || '')
    for (let i = 0; i < key.length; i += 1) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
  }

  function agentColorIndex(role) {
    const key = String(role || '').trim()
    if (!key) return 1
    return (hashRole(key) % AGENT_PALETTE) + 1
  }

  function agentGlyph(role) {
    const key = String(role || '').trim()
    if (!key) return '?'
    return Array.from(key)[0]
  }

  function statusType(status) {
    const value = String(status || '')
    if (ERROR.has(value) || value === 'failed') return 'error'
    if (DONE.has(value) || value === 'completed_with_errors') return 'done'
    if (value === 'cancelled' || value === 'interrupted' || value === 'skipped') return 'cancelled'
    if (RUNNING.has(value)) return 'running'
    return 'waiting'
  }

  function formatDuration(ms) {
    const totalSec = Math.max(0, Math.round(Number(ms || 0) / 1000))
    if (totalSec < 60) return totalSec + 's'
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return h + 'h' + m + 'm'
    return m + 'm' + s + 's'
  }

  function elapsedMs(startedAt, finishedAt, live) {
    const started = Number(startedAt || 0)
    if (!started) return 0
    const ended = Number(finishedAt || 0) || (live ? Date.now() : started)
    return Math.max(0, ended - started)
  }

  function workerStatusText(agent) {
    const type = statusType(agent.status)
    const live = type === 'running'
    const ms = elapsedMs(agent.startedAt, agent.finishedAt, live)
    const clock = ms > 0 ? ' · ' + formatDuration(ms) : ''
    if (type === 'error') return '失败'
    if (type === 'cancelled') return '已停止'
    if (type === 'done') return '已完成' + clock
    if (String(agent.status) === 'thinking') return '思考中' + (live ? clock : '')
    if (String(agent.status) === 'using_tools') return '调用工具' + clock
    if (type === 'running') return '执行中' + clock
    if (String(agent.status) === 'queued') return '排队中'
    return '等待中'
  }

  function captainStatusText(execution) {
    const captain = execution?.captain || {}
    const type = statusType(captain.status || execution?.status)
    if (type === 'error') return '失败'
    if (type === 'cancelled') return '已停止'
    if (type === 'done') return '已汇总'
    if (type === 'running') return '正在生成汇总…'
    if ((execution?.agents || []).length) return '正在生成汇总…'
    return '待汇总'
  }

  function latestText(list, keys) {
    const items = Array.isArray(list) ? list : []
    const last = items.length ? items[items.length - 1] : null
    if (!last) return ''
    if (typeof last === 'string') return last
    for (const key of keys) {
      const value = compactText(last[key], 120)
      if (value) return value
    }
    return ''
  }

  function workerPreview(agent) {
    const type = statusType(agent.status)
    if (type === 'error') return compactText((agent.error && agent.error.message) || agent.statusText || '失败', 90)
    const tools = Array.isArray(agent.tools) ? agent.tools : []
    const latestTool = tools.length ? tools[tools.length - 1] : null
    if (latestTool && statusType(latestTool.status) === 'running') {
      return '正在生成 ' + compactText(latestTool.name || latestTool.title || '工具', 72)
    }
    if (type === 'running') {
      const thinking = latestText(agent.thinking, ['content', 'text', 'message'])
      if (thinking) return thinking
      if (agent.statusText) return compactText(agent.statusText, 90)
    }
    if (agent.output) return compactText(agent.output, 90)
    return compactText(agent.task || agent.statusText || '', 90)
  }

  function wavesFromAgents(agents) {
    const list = Array.isArray(agents) ? agents : []
    const remaining = new Set(list.map(agent => agent.id))
    const byId = new Map(list.map(agent => [agent.id, agent]))
    const waves = []
    while (remaining.size) {
      const ready = [...remaining].filter(id => {
        const deps = byId.get(id)?.dependsOn || []
        return deps.every(dep => !remaining.has(dep))
      })
      if (!ready.length) {
        waves.push([...remaining].map(id => byId.get(id)).filter(Boolean))
        break
      }
      waves.push(ready.map(id => byId.get(id)).filter(Boolean))
      ready.forEach(id => remaining.delete(id))
    }
    return waves
  }

  function layoutColumns(columns) {
    const cols = columns.filter(col => col.length)
    const heights = cols.map(col => col.length * NODE_H + Math.max(0, col.length - 1) * ROW_GAP)
    const maxH = Math.max(NODE_H, ...heights, 0)
    cols.forEach((col, index) => {
      const y0 = LAYOUT_PAD + (maxH - heights[index]) / 2
      col.forEach((node, row) => {
        node.x = LAYOUT_PAD + index * (NODE_W + LAYER_GAP)
        node.y = y0 + row * (NODE_H + ROW_GAP)
      })
    })
    return {
      width: LAYOUT_PAD * 2 + cols.length * NODE_W + Math.max(0, cols.length - 1) * LAYER_GAP,
      height: LAYOUT_PAD * 2 + maxH
    }
  }

  function buildGraphModel(execution, options = {}) {
    const agents = Array.isArray(execution?.agents) ? execution.agents : []
    const waves = Array.isArray(execution?.waves) && execution.waves.length
      ? execution.waves.map(wave => {
        const list = Array.isArray(wave) ? wave : []
        return list.map(item => agents.find(agent => agent.id === (item.id || item)) || item).filter(Boolean)
      })
      : wavesFromAgents(agents)
    const names = agents.map(agent => agent.name || agent.role).filter(Boolean)
    const taskPreview = names.length ? names.join('、') : compactText(execution?.task || execution?.teamBrief || '', 90)
    const taskNode = {
      id: TASK_ID,
      kind: 'input',
      name: '你的任务',
      statusText: '对话发起',
      preview: taskPreview,
      status: 'completed'
    }
    const workerNodes = waves.map(wave => wave.map(agent => ({
      id: agent.id,
      kind: 'work',
      name: agent.name || agent.role || '队员',
      role: agent.role || agent.name || '队员',
      status: agent.status,
      statusText: workerStatusText(agent),
      preview: workerPreview(agent),
      live: statusType(agent.status) === 'running',
      startedAt: agent.startedAt || 0,
      finishedAt: agent.finishedAt || 0
    })))
    const captain = execution?.captain || {}
    const captainState = captain.status || (TERMINAL.has(String(execution?.status || '')) ? 'completed' : 'pending')
    const ceoNode = {
      id: CEO_ID,
      kind: 'captain',
      name: 'CEO 汇总',
      status: captainState,
      statusText: captainStatusText(execution),
      preview: compactText(captain.statusCaption || captain.preview || execution?.notes?.consensus || '', 90),
      live: statusType(captainState) === 'running'
    }
    const columns = [[taskNode], ...workerNodes, [ceoNode]]
    const size = layoutColumns(columns)
    const nodes = columns.flat()
    nodes.forEach((node, index) => { node.enterIndex = index })
    const edges = []
    agents.forEach(agent => {
      const deps = Array.isArray(agent.dependsOn) ? agent.dependsOn : []
      if (!deps.length) edges.push({ source: TASK_ID, target: agent.id })
      else deps.forEach(dep => edges.push({ source: dep, target: agent.id }))
    })
    const leaves = agents.filter(agent => !agents.some(other => (other.dependsOn || []).includes(agent.id)))
    leaves.forEach(agent => edges.push({ source: agent.id, target: CEO_ID }))
    const byId = new Map(nodes.map(node => [node.id, node]))
    return {
      ...size,
      nodes,
      edges: edges.filter(edge => byId.has(edge.source) && byId.has(edge.target)),
      selectedId: options.selectedId || ''
    }
  }

  function smoothStep(x1, y1, x2, y2) {
    if (Math.abs(y2 - y1) < 1.5) return `M ${x1} ${y1} L ${x2} ${y2}`
    const midX = (x1 + x2) / 2
    const r = Math.min(12, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2)
    const dir = y2 >= y1 ? 1 : -1
    return [
      `M ${x1} ${y1}`,
      `L ${midX - r} ${y1}`,
      `Q ${midX} ${y1} ${midX} ${y1 + dir * r}`,
      `L ${midX} ${y2 - dir * r}`,
      `Q ${midX} ${y2} ${midX + r} ${y2}`,
      `L ${x2} ${y2}`
    ].join(' ')
  }

  function edgeDomId(source, target) {
    return 'e-' + String(source).replace(/[^a-zA-Z0-9_-]/g, '_') + '-' + String(target).replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  function renderEdges(model) {
    const pos = new Map(model.nodes.map(node => [node.id, node]))
    return model.edges.map(edge => {
      const from = pos.get(edge.source)
      const to = pos.get(edge.target)
      if (!from || !to) return ''
      const x1 = from.x + NODE_W
      const y1 = from.y + NODE_H / 2
      const x2 = to.x
      const y2 = to.y + NODE_H / 2
      const toType = statusType(to.status)
      const fromType = statusType(from.status)
      const live = toType === 'running' || (fromType === 'done' && toType === 'running')
      const cls = live ? ' is-live' : fromType === 'done' && toType === 'done' ? ' is-done' : ''
      const id = edgeDomId(edge.source, edge.target)
      const d = smoothStep(x1, y1, x2, y2)
      const particles = live ? [0, 0.5, 1].map(begin => `
        <circle r="3" class="ai-team-particle" fill="currentColor">
          <animateMotion dur="1.5s" begin="${begin}s" repeatCount="indefinite" path="${d}"></animateMotion>
        </circle>`).join('') : ''
      return `
        <g class="ai-team-edge-group${cls}" data-edge-id="${escapeHtml(id)}">
          <path id="${escapeHtml(id)}" class="ai-team-edge${cls}" d="${d}" fill="none"></path>
          <circle class="ai-team-port${cls}" cx="${x1}" cy="${y1}" r="3.5"></circle>
          <circle class="ai-team-port${cls}" cx="${x2}" cy="${y2}" r="3.5"></circle>
          ${particles}
        </g>`
    }).join('')
  }

  function presenceIcon(type) {
    if (type === 'running') return ICONS.spinner
    if (type === 'done') return ICONS.check
    if (type === 'error') return ICONS.close
    if (type === 'cancelled') return ICONS.square
    return ICONS.ring
  }

  function lifeIcon(type) {
    if (type === 'error') return ICONS.close
    if (type === 'cancelled') return ICONS.square
    if (type === 'done') return ICONS.checkCircle
    if (type === 'running') return ICONS.spinner
    return ICONS.ring
  }

  function endpointIcon(node) {
    if (node.kind === 'input') return ICONS.user
    const type = statusType(node.status)
    if (type === 'running') return ICONS.spinner
    if (type === 'done') return ICONS.checkCircle
    if (type === 'error' || type === 'cancelled') return ICONS.close
    return ICONS.spark
  }

  function renderNode(node, options = {}) {
    const type = statusType(node.status)
    const selected = options.selectedId && options.selectedId === node.id ? ' is-selected' : ''
    const enter = options.playEnter ? ' ai-team-card-enter' : ''
    const flash = options.flashIds && options.flashIds.has(node.id) ? ' ai-team-card-flash' : ''
    const delay = options.playEnter ? `animation-delay:${Math.min((node.enterIndex || 0) * 35, 280)}ms;` : ''
    const face = (inner) => `<span class="ai-team-card-face${enter}" style="${delay}">${inner}</span>`
    if (node.kind === 'work') {
      const color = `var(--agent-${agentColorIndex(node.role)})`
      return `
        <button type="button" class="ai-team-card is-work is-${type}${selected}${flash}${node.live ? ' is-live' : ''}" data-team-node="${escapeHtml(node.id)}" data-node-id="${escapeHtml(node.id)}" data-started-at="${Number(node.startedAt || 0)}" data-status="${escapeHtml(node.status || '')}" style="left:${node.x}px;top:${node.y}px">
          ${face(`
          <div class="ai-team-card-head">
            <span class="ai-team-avatar-wrap">
              <span class="ai-team-avatar" style="color:${color};background:color-mix(in oklab, ${color} 18%, transparent)">${escapeHtml(agentGlyph(node.role))}</span>
              <span class="ai-team-presence is-${type}">${presenceIcon(type)}</span>
            </span>
            <strong>${escapeHtml(node.name)}</strong>
          </div>
          <span class="ai-team-card-status" data-team-status>${escapeHtml(node.statusText)}</span>
          <em class="ai-team-card-preview${node.live ? ' is-live' : ''}">${escapeHtml(node.preview || '')}${node.live ? '<i class="ai-team-caret">▋</i>' : ''}</em>`)}
        </button>`
    }
    const interactive = node.kind === 'captain' || node.kind === 'input'
    const tag = interactive ? 'button' : 'div'
    const attrs = interactive
      ? `type="button" data-team-node="${escapeHtml(node.id)}" data-node-id="${escapeHtml(node.id)}"`
      : `data-team-node="${escapeHtml(node.id)}" data-node-id="${escapeHtml(node.id)}"`
    const statusClass = node.kind === 'input' ? '' : ` is-${type}`
    return `
      <${tag} ${attrs} class="ai-team-card is-${node.kind}${statusClass}${selected}${flash}${node.live ? ' is-live' : ''}" data-started-at="${Number(node.startedAt || 0)}" data-status="${escapeHtml(node.status || '')}" style="left:${node.x}px;top:${node.y}px">
        ${face(`
        <div class="ai-team-card-head">
          <span class="ai-team-avatar is-endpoint">${endpointIcon(node)}</span>
          <strong>${escapeHtml(node.name)}</strong>
        </div>
        <span class="ai-team-card-status" data-team-status>${escapeHtml(node.statusText)}</span>
        <em class="ai-team-card-preview">${escapeHtml(node.preview || '')}</em>`)}
      </${tag}>`
  }

  function renderDag(execution, options = {}) {
    const model = buildGraphModel(execution, options)
    if (!model.nodes.length) return { html: '<div class="ai-team-empty">还没有队员</div>', width: 240, height: 80 }
    return {
      width: model.width,
      height: model.height,
      html: `
        <div class="ai-team-dag" style="width:${model.width}px;height:${model.height}px">
          <svg class="ai-team-edges" width="${model.width}" height="${model.height}" aria-hidden="true">${renderEdges(model)}</svg>
          ${model.nodes.map(node => renderNode(node, options)).join('')}
        </div>`
    }
  }

  function teamNotes(execution) {
    if (Array.isArray(execution.teamNotes) && execution.teamNotes.length) return execution.teamNotes
    const notes = execution.notes || {}
    return [
      notes.coordination && { id: 'coordination', author: '主', kind: '协调', source: 'ceo', text: notes.coordination },
      notes.convention && { id: 'convention', author: '主', kind: '约定', text: notes.convention },
      notes.consensus && { id: 'consensus', author: '主', kind: '团队共识', source: 'ceo', text: notes.consensus }
    ].filter(Boolean)
  }

  function renderNotes(execution, expanded) {
    const notes = teamNotes(execution)
    if (!notes.length) return ''
    return `
      <section class="ai-team-notes">
        <button type="button" class="ai-team-notes-toggle" data-team-notes-toggle aria-expanded="${expanded ? 'true' : 'false'}">
          ${expanded ? ICONS.chevronDown : ICONS.chevronRight}
          ${ICONS.note}
          <span>团队便签</span>
          <b>${notes.length}</b>
        </button>
        ${expanded ? `<ul class="ai-team-note-list">${notes.map(note => {
          const color = `var(--agent-${agentColorIndex(note.author || '主')})`
          const badges = [note.kind, note.source === 'ceo' && note.kind !== '团队共识' ? '团队共识' : '']
            .filter(Boolean)
            .map(label => `<span class="ai-team-note-badge">${escapeHtml(label)}</span>`)
            .join('')
          return `
            <li class="ai-team-note">
              <span class="ai-team-avatar" style="color:${color};background:color-mix(in oklab, ${color} 18%, transparent)">${escapeHtml(agentGlyph(note.author || '主'))}</span>
              <div>
                <div class="ai-team-note-meta">
                  <strong>${escapeHtml(note.author || '主')}</strong>
                  ${badges}
                </div>
                <p>${escapeHtml(note.text || '')}</p>
              </div>
            </li>`
        }).join('')}</ul>` : ''}
      </section>`
  }

  function progressLabel(execution) {
    const done = Number(execution.progress?.completed ?? execution.doneCount ?? 0)
    const total = Number(execution.progress?.total ?? execution.totalCount ?? ((execution.agents || []).length + 1))
    return `${done}/${total || 0}`
  }

  function stripElapsed(execution) {
    const live = !TERMINAL.has(String(execution.status || ''))
    const ms = elapsedMs(execution.startedAt || execution.createdAt, execution.finishedAt, live)
    return ms > 0 ? formatDuration(ms) : ''
  }

  function renderStrip(execution, collapsed) {
    const type = statusType(execution.status)
    const elapsed = stripElapsed(execution)
    return `
      <div class="ai-team-strip is-${type}">
        <span class="ai-team-life is-${type}" aria-hidden="true">${lifeIcon(type)}</span>
        <span class="ai-team-meta">${escapeHtml(progressLabel(execution))}${elapsed ? ` · 用时 ${elapsed}` : ''}</span>
        <button type="button" class="ai-team-icon-btn" data-team-fold title="${collapsed ? '展开协作图' : '收起协作图'}">${collapsed ? ICONS.chevronDown : ICONS.chevronUp}</button>
        <button type="button" class="ai-team-open-canvas" data-team-open-canvas>${ICONS.maximize}<span>在画布打开</span></button>
      </div>`
  }

  function bindGraph(el, execution) {
    ensureBound({ el, execution })
  }

  function ensureBound(record) {
    if (record.el.dataset.teamBound === 'true') return
    record.el.dataset.teamBound = 'true'
    record.el.addEventListener('click', event => {
      const execution = hosts.get(record.el.dataset.teamGraph)?.execution || record.execution
      if (!execution) return
      if (event.target.closest('[data-team-fold]')) {
        event.preventDefault()
        const item = hosts.get(execution.id)
        if (!item) return
        item.collapsed = !item.collapsed
        renderHost(item)
        return
      }
      if (event.target.closest('[data-team-notes-toggle]')) {
        event.preventDefault()
        const item = hosts.get(execution.id)
        if (!item) return
        item.notesExpanded = !item.notesExpanded
        renderHost(item)
        return
      }
      if (event.target.closest('[data-team-open-canvas]')) {
        event.preventDefault()
        openCanvas(execution)
        return
      }
      const nodeBtn = event.target.closest('[data-team-node]')
      if (nodeBtn) {
        event.preventDefault()
        openNode(execution, nodeBtn.dataset.teamNode)
      }
    })
  }

  function embedColWidth(el) {
    const area = el?.closest('.ai-dynamic-area')
    const measured = Number(area?.clientWidth || el?.clientWidth || 0)
    if (measured > 40) return Math.max(280, measured)
    return EMBED_DEFAULT_COL_WIDTH
  }

  function fitWidthBox(bboxWidth, bboxHeight, colWidth) {
    const widthZoom = bboxWidth > 0 ? Math.min(1, colWidth / bboxWidth) : 1
    const heightZoom = bboxHeight > 0 ? Math.min(1, EMBED_MAX_HEIGHT / bboxHeight) : 1
    const zoom = Math.min(widthZoom, heightZoom)
    const renderedHeight = bboxHeight * zoom
    const height = Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, renderedHeight))
    return {
      zoom,
      width: Math.round(bboxWidth * zoom),
      height: Math.round(height),
      overflowing: renderedHeight > height + 1
    }
  }

  function collectFlashIds(record, execution) {
    const prev = record.statusMap || {}
    const next = {}
    const flashIds = new Set()
    ;(execution.agents || []).forEach(agent => {
      next[agent.id] = agent.status
      const was = prev[agent.id]
      if (was && was !== agent.status && (DONE.has(String(agent.status)) || ERROR.has(String(agent.status)))) {
        flashIds.add(agent.id)
      }
    })
    const captainStatusValue = execution.captain?.status || execution.status
    next[CEO_ID] = captainStatusValue
    if (prev[CEO_ID] && prev[CEO_ID] !== captainStatusValue && (statusType(captainStatusValue) === 'done' || statusType(captainStatusValue) === 'error')) {
      flashIds.add(CEO_ID)
    }
    record.statusMap = next
    return flashIds
  }

  function cardShellClass(node, options = {}) {
    const type = statusType(node.status)
    const selected = options.selectedId && options.selectedId === node.id ? ' is-selected' : ''
    const flash = options.flashIds && options.flashIds.has(node.id) ? ' ai-team-card-flash' : ''
    const statusClass = node.kind === 'input' ? '' : ` is-${type}`
    return `ai-team-card is-${node.kind}${statusClass}${selected}${flash}${node.live ? ' is-live' : ''}`
  }

  function syncCard(card, node, options = {}) {
    const type = statusType(node.status)
    card.className = cardShellClass(node, options)
    card.style.left = node.x + 'px'
    card.style.top = node.y + 'px'
    card.dataset.status = node.status || ''
    card.dataset.startedAt = String(Number(node.startedAt || 0))
    const statusEl = card.querySelector('[data-team-status]')
    if (statusEl) statusEl.textContent = node.statusText
    const preview = card.querySelector('.ai-team-card-preview')
    if (preview) {
      preview.classList.toggle('is-live', !!node.live)
      preview.innerHTML = escapeHtml(node.preview || '') + (node.live ? '<i class="ai-team-caret">▋</i>' : '')
    }
    const presence = card.querySelector('.ai-team-presence')
    if (presence) {
      presence.className = `ai-team-presence is-${type}`
      presence.innerHTML = presenceIcon(type)
    }
    const endpoint = card.querySelector('.ai-team-avatar.is-endpoint')
    if (endpoint) endpoint.innerHTML = endpointIcon(node)
    if (options.flashIds && options.flashIds.has(node.id)) {
      card.classList.add('ai-team-card-flash')
      const onEnd = () => card.classList.remove('ai-team-card-flash')
      card.addEventListener('animationend', onEnd, { once: true })
    }
  }

  function paintHost(record, dag, fit, execution, collapsed, playEnter, flashIds) {
    record.el.innerHTML = `
      ${renderStrip(execution, collapsed)}
      <div class="ai-team-body${collapsed ? ' is-collapsed' : ''}">
        <div class="ai-team-board" style="height:${fit.height}px">
          <div class="ai-team-fit" style="width:${fit.width}px;height:${fit.height}px">
            <div class="ai-team-dag-scale" style="width:${dag.width}px;height:${dag.height}px;transform:scale(${fit.zoom});transform-origin:top left">${dag.html}</div>
          </div>
          ${fit.overflowing ? '<div class="ai-team-overflow" aria-hidden="true"></div>' : ''}
        </div>
        ${renderNotes(execution, record.notesExpanded !== false)}
      </div>`
    ensureBound(record)
    observeHost(record)
    if (playEnter) record.playedEnter = true
  }

  function patchHost(record, dag, fit, model, flashIds) {
    const execution = record.execution
    const meta = record.el.querySelector('.ai-team-meta')
    if (meta) {
      const elapsed = stripElapsed(execution)
      meta.textContent = progressLabel(execution) + (elapsed ? ` · 用时 ${elapsed}` : '')
    }
    const life = record.el.querySelector('.ai-team-life')
    if (life) {
      const type = statusType(execution.status)
      life.className = `ai-team-life is-${type}`
      life.innerHTML = lifeIcon(type)
    }
    const board = record.el.querySelector('.ai-team-board')
    const fitEl = record.el.querySelector('.ai-team-fit')
    const scale = record.el.querySelector('.ai-team-dag-scale')
    if (board) board.style.height = fit.height + 'px'
    if (fitEl) {
      fitEl.style.width = fit.width + 'px'
      fitEl.style.height = fit.height + 'px'
    }
    if (scale) {
      scale.style.width = dag.width + 'px'
      scale.style.height = dag.height + 'px'
      scale.style.transform = `scale(${fit.zoom})`
    }
    model.nodes.forEach(node => {
      const card = record.el.querySelector(`[data-team-node="${node.id}"]`)
      if (card) syncCard(card, node, { flashIds, selectedId: model.selectedId })
    })
    const svg = record.el.querySelector('.ai-team-edges')
    const nextEdgeLive = (model.edges || []).map(edge => {
      const from = model.nodes.find(node => node.id === edge.source)
      const to = model.nodes.find(node => node.id === edge.target)
      return statusType(to?.status) === 'running' || (statusType(from?.status) === 'done' && statusType(to?.status) === 'running') ? '1' : '0'
    }).join('')
    if (svg && (record.edgeKey !== edgeKey(model) || record.edgeLive !== nextEdgeLive)) {
      svg.innerHTML = renderEdges(model)
      record.edgeKey = edgeKey(model)
      record.edgeLive = nextEdgeLive
    }
  }

  function edgeKey(model) {
    return (model.edges || []).map(edge => edge.source + '>' + edge.target).join('|')
  }

  function renderHost(record) {
    const execution = record.execution
    const live = !TERMINAL.has(String(execution.status || ''))
    if (record.notesExpanded == null) record.notesExpanded = live
    const collapsed = record.collapsed === true
    const playEnter = record.playedEnter !== true
    const flashIds = collectFlashIds(record, execution)
    const model = buildGraphModel(execution)
    const dag = renderDag(execution, { playEnter, flashIds, selectedId: model.selectedId })
    const colWidth = embedColWidth(record.el)
    const fit = fitWidthBox(dag.width, dag.height, colWidth)
    record.colWidth = colWidth
    const structureKey = model.nodes.map(node => node.id).join('|') + `@${model.width}x${model.height}`
    const canPatch = record.el.querySelector('.ai-team-dag')
      && record.structureKey === structureKey
      && record.collapsedPainted === collapsed
      && record.notesPainted === (record.notesExpanded !== false)
    if (canPatch) {
      patchHost(record, dag, fit, model, flashIds)
      return
    }
    record.structureKey = structureKey
    record.collapsedPainted = collapsed
    record.notesPainted = record.notesExpanded !== false
    record.edgeKey = edgeKey(model)
    paintHost(record, dag, fit, execution, collapsed, playEnter, flashIds)
  }

  function tickElapsed() {
    let live = false
    hosts.forEach(item => {
      const execution = item.execution
      if (TERMINAL.has(String(execution?.status || ''))) return
      live = true
      const meta = item.el.querySelector('.ai-team-meta')
      if (meta) {
        const elapsed = stripElapsed(execution)
        meta.textContent = progressLabel(execution) + (elapsed ? ` · 用时 ${elapsed}` : '')
      }
      const byId = new Map((execution.agents || []).map(agent => [agent.id, agent]))
      item.el.querySelectorAll('[data-team-node]').forEach(card => {
        const agent = byId.get(card.dataset.teamNode)
        if (!agent) return
        const statusEl = card.querySelector('[data-team-status]')
        if (statusEl) statusEl.textContent = workerStatusText(agent)
      })
    })
    return live
  }

  function observeHost(record) {
    if (record.ro || typeof ResizeObserver === 'undefined') return
    record.ro = new ResizeObserver(() => {
      const width = embedColWidth(record.el)
      if (Math.abs(width - (record.colWidth || 0)) < 4) return
      renderHost(record)
    })
    record.ro.observe(record.el)
  }

  function renderStage(host, execution, options = {}) {
    if (!host) return { width: 0, height: 0 }
    const dag = renderDag(execution, options)
    const pad = 48
    host.classList.add('ai-team-canvas-host')
    host.innerHTML = `
      <div class="ai-team-board is-stage" style="width:${dag.width + pad * 2}px;height:${dag.height + pad * 2}px">
        <div class="ai-team-stage-offset" style="left:${pad}px;top:${pad}px">${dag.html}</div>
      </div>`
    host.querySelectorAll('[data-team-node]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        if (typeof options.onNodeSelect === 'function') options.onNodeSelect(button.dataset.teamNode)
        else openNode(execution, button.dataset.teamNode)
      })
    })
    return { width: dag.width + pad * 2, height: dag.height + pad * 2 }
  }

  function findHostMessage(execution) {
    const executionId = String(execution?.id || '')
    if (executionId) {
      const marked = document.querySelector(`#chatMessages .message.ai[data-team-execution-id="${window.CSS?.escape?.(executionId) || executionId}"]`)
      if (marked && document.contains(marked)) return marked
      const existingGraph = document.querySelector(`#chatMessages [data-team-graph="${executionId}"]`)
      if (existingGraph) return existingGraph.closest('.message.ai')
    }
    const live = document.querySelector('#chatMessages .message.ai.thinking')
    if (live && document.contains(live)) return live
    const all = document.querySelectorAll('#chatMessages .message.ai')
    return all.length ? all[all.length - 1] : null
  }

  function placeGraph(dynamicArea, el) {
    if (!dynamicArea || !el) return
    const segments = dynamicArea.querySelectorAll(':scope > .ai-work-segment')
    const last = segments[segments.length - 1]
    if (el.parentNode === dynamicArea && (!last || last.nextElementSibling === el || !last.nextElementSibling)) return
    if (last) last.after(el)
    else dynamicArea.appendChild(el)
  }

  function attachRecord(record, message) {
    const execution = record?.execution
    const dynamicArea = message?.querySelector('.ai-dynamic-area')
    if (!execution || !dynamicArea) return null
    if (message.dataset.workDone !== 'true') dynamicArea.classList.remove('collapsed')
    message.dataset.teamExecutionId = execution.id
    let el = (record.el && record.el.dataset.teamGraph === execution.id) ? record.el : null
    if (!el || (el.parentNode && !dynamicArea.contains(el) && document.contains(el))) {
      el = dynamicArea.querySelector(`[data-team-graph="${execution.id}"]`)
    }
    if (!el) {
      el = document.createElement('div')
      el.className = 'ai-team-graph'
      el.dataset.teamGraph = execution.id
    }
    placeGraph(dynamicArea, el)
    record.el = el
    record.execution = execution
    hosts.set(execution.id, record)
    return record
  }

  function ensureHost(execution) {
    const existing = hosts.get(execution.id)
    if (existing?.el && document.contains(existing.el)) return existing
    const message = findHostMessage(execution)
    if (!message) return null
    const record = existing || { execution }
    return attachRecord(record, message)
  }

  function restoreGraphs(nodes, message) {
    const list = Array.isArray(nodes) ? nodes.filter(Boolean) : []
    if (!message || !list.length) return
    list.forEach(el => {
      const id = el.dataset.teamGraph
      const record = (id && hosts.get(id)) || { execution: { id }, el }
      if (!record.execution) record.execution = { id }
      record.el = el
      if (id) hosts.set(id, record)
      attachRecord(record, message)
      if (record.execution && record.execution.agents) renderHost(record)
    })
  }

  function remountInto(message) {
    if (!message) return
    hosts.forEach(record => {
      if (!record?.execution) return
      if (record.el && document.contains(record.el) && !message.contains(record.el)) return
      attachRecord(record, message)
      if (record.execution.agents) renderHost(record)
    })
  }

  function openCanvas(execution) {
    window.openCanvasView?.()
    window.CanvasView?.updateSession?.(execution)
  }

  function openNode(execution, nodeId) {
    window.showCanvasInspector?.({ nodeId, session: execution })
  }

  function apply(payload = {}) {
    const execution = payload.execution || payload
    if (!execution?.id) return
    const record = ensureHost(execution)
    if (!record) {
      pending = payload
      window.setTimeout(() => {
        if (pending && pending.execution?.id === execution.id) apply(pending)
      }, 80)
      return
    }
    pending = null
    record.execution = execution
    renderHost(record)
    if (window.CanvasView?.getSession?.()?.id === execution.id) {
      window.CanvasView.updateSession(execution)
    }
    window.CanvasInspector?.refresh?.(execution)
    if (!TERMINAL.has(String(execution.status || '')) && !timer) {
      timer = window.setInterval(() => {
        if (!tickElapsed()) {
          window.clearInterval(timer)
          timer = 0
        }
      }, 1000)
    }
  }

  function register() {
    if (window.api?.onAgentTeamUpdate) {
      window.api.onAgentTeamUpdate(data => apply(data || {}))
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', register)
  } else {
    register()
  }

  window.AgentTeamGraph = {
    apply,
    openCanvas,
    openNode,
    renderStage,
    buildGraphModel,
    restoreGraphs,
    remountInto,
    inspectorTitle(execution, nodeId) {
      if (nodeId === 'task') return '你的任务'
      if (nodeId === 'ceo') return 'CEO 汇总'
      const agent = (execution?.agents || []).find(item => item.id === nodeId || item.nodeId === nodeId)
      return agent?.name || agent?.role || '队员'
    }
  }
})()
