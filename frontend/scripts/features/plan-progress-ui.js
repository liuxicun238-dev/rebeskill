// 输入框上方执行计划待办面板
// 样式依赖 styles/input-area.css 中的 .plan-progress-* 规则

(function () {
  function escapeHtml(value) {
    if (window.HtmlUtils?.escapeHtml) return window.HtmlUtils.escapeHtml(String(value ?? ''))
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function stepTitle(step) {
    if (typeof step === 'string') return step
    if (!step || typeof step !== 'object') return String(step || '')
    return step.title || step.name || step.task || String(step)
  }

  function ensureDock() {
    let dock = document.getElementById('planProgressDock')
    if (dock) return dock

    const inputArea = document.querySelector('.chat-input-area')
    if (!inputArea) return null

    dock = document.createElement('div')
    dock.id = 'planProgressDock'
    dock.className = 'plan-progress-dock'
    dock.hidden = true

    const strip = document.getElementById('cacheUsageStrip')
    const wrapper = document.getElementById('inputWrapper')
    if (strip && strip.parentElement === inputArea) {
      strip.insertAdjacentElement('afterend', dock)
    } else if (wrapper && wrapper.parentElement === inputArea) {
      inputArea.insertBefore(dock, wrapper)
    } else {
      inputArea.appendChild(dock)
    }
    return dock
  }

  function clear() {
    const dock = document.getElementById('planProgressDock')
    if (!dock) return
    dock.hidden = true
    dock.innerHTML = ''
  }

  function render(options = {}) {
    const steps = Array.isArray(options.steps) ? options.steps : []
    if (!steps.length) {
      clear()
      return
    }

    const dock = ensureDock()
    if (!dock) return

    const total = steps.length
    const rawIndex = Number(options.currentStepIndex)
    const idx = Number.isFinite(rawIndex) ? Math.max(0, Math.min(rawIndex, total)) : 0
    const allDone = idx >= total
    const activeIndex = allDone ? Math.max(0, total - 1) : idx
    const rawPhase = String(options.phase || '').trim().replace(/[.。…]+$/g, '')
    const currentTitle = allDone
      ? (!rawPhase || rawPhase === '执行中' || rawPhase === '计划确认' ? '已完成' : rawPhase)
      : (rawPhase && rawPhase !== '执行中' && rawPhase !== '计划确认' && rawPhase !== '已完成'
        ? rawPhase
        : stepTitle(steps[activeIndex]))
    const doneCount = allDone ? total : idx
    const meta = `${Math.min(doneCount, total)}/${total}`
    const expanded = !!options.expanded

    const stepsHtml = steps.map((step, index) => {
      let status = index < idx ? 'done' : (index === idx ? 'active' : 'pending')
      if (allDone) status = 'done'
      if (typeof step === 'object' && step?.status === 'blocked') status = 'blocked'
      if (typeof step === 'object' && step?.status === 'failed' && index === idx) status = 'failed'
      const icon = status === 'done' ? '✓' : (status === 'active' || status === 'failed' ? '●' : '○')
      return `<div class="plan-progress-step ${status}"><span class="plan-progress-step-icon">${icon}</span><span class="plan-progress-step-text">${escapeHtml(stepTitle(step))}</span></div>`
    }).join('')

    dock.hidden = false
    dock.innerHTML = `
      <div class="plan-progress-card${expanded ? ' expanded' : ''}${allDone ? ' is-done' : ''}">
        <button type="button" class="plan-progress-current" id="planProgressToggle" aria-expanded="${expanded ? 'true' : 'false'}">
          <span class="plan-progress-dot${allDone ? ' is-done' : ''}"></span>
          <span class="plan-progress-title">${escapeHtml(currentTitle)}</span>
          <span class="plan-progress-meta">
            <span>${escapeHtml(meta)}</span>
            <svg class="plan-progress-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
        </button>
        <div class="plan-progress-list">${stepsHtml}</div>
      </div>
    `

    const toggle = dock.querySelector('#planProgressToggle')
    if (toggle && typeof options.onToggleExpand === 'function') {
      toggle.addEventListener('click', options.onToggleExpand)
    }
  }

  function normalizeMessageSteps(steps = []) {
    return (Array.isArray(steps) ? steps : [])
      .map((step, index) => {
        if (typeof step === 'string') return { title: step, status: index === 0 ? 'active' : 'pending' }
        return {
          title: step.title || step.name || step.task || `步骤 ${index + 1}`,
          detail: step.detail || step.description || '',
          status: step.status || (index === 0 ? 'active' : 'pending')
        }
      })
      .filter(step => String(step.title || '').trim())
  }

  function renderInMessage(steps = [], title = '计划', messageEl = null) {
    const msg = messageEl || document.querySelector('.ai-msg.current, .ai-message.current')
    if (!msg || !Array.isArray(steps) || steps.length === 0) return
    const normalized = normalizeMessageSteps(steps)
    if (!normalized.length) return
    const dynamicArea = msg.querySelector('.ai-dynamic-area')
    if (!dynamicArea) return
    dynamicArea.classList.remove('collapsed')
    let panel = dynamicArea.querySelector('[data-main-plan-panel]')
    if (!panel) {
      panel = document.createElement('div')
      panel.dataset.mainPlanPanel = '1'
      dynamicArea.appendChild(panel)
    }
    const current = [...normalized].reverse().find(step => step.status === 'active') ||
      normalized.find(step => step.status !== 'done') ||
      normalized[normalized.length - 1]
    panel.innerHTML = `
      <div class="ai-plan-panel" data-plan-panel>
        <div class="ai-plan-header" data-plan-toggle>
          <span class="ai-plan-title">${escapeHtml(title || '计划')}</span>
          <span class="ai-plan-current">${escapeHtml(current?.title || '')}</span>
          <span class="ai-plan-count">${normalized.length} 步</span>
        </div>
        <div class="ai-plan-list collapsed">
          ${normalized.map((step, index) => `
            <div class="ai-plan-step ${escapeHtml(step.status || 'pending')}">
              <span>${index + 1}.</span>
              <span>${escapeHtml(step.title)}${step.detail ? `<br><small>${escapeHtml(step.detail)}</small>` : ''}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `
    panel.querySelectorAll('[data-plan-toggle]').forEach(header => {
      if (header.dataset.bound === '1') return
      header.dataset.bound = '1'
      header.addEventListener('click', () => {
        header.closest('[data-plan-panel]')?.querySelector('.ai-plan-list')?.classList.toggle('collapsed')
      })
    })
  }

  window.PlanProgressUI = {
    clear,
    render,
    renderInMessage,
    ensureDock
  }
})()
