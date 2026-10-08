/**
 * 通用确认框 / 列表选择。危险删除类操作仍走 LingxiDangerDialog。
 */
(function () {
  function escapeHtml(value) {
    if (window.HtmlUtils?.escapeHtml) return window.HtmlUtils.escapeHtml(value)
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function restoreFocus() {
    try {
      const inputEl = document.getElementById('inputBox')
      if (inputEl && !inputEl.disabled && !inputEl.readOnly) {
        requestAnimationFrame(() => {
          try { inputEl.focus({ preventScroll: true }) } catch (_) {
            try { inputEl.focus?.() } catch (_) {}
          }
        })
        return
      }
      try { document.body?.focus?.() } catch (_) {}
    } catch (_) {}
  }

  function infoIcon() {
    return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 10v6"/><path d="M12 7h.01"/></svg>`
  }

  function dangerIcon() {
    return `<svg viewBox="0 0 24 24"><path d="M12 3 3 21h18L12 3Z"/><path d="M12 9v6"/><path d="M12 18h.01"/></svg>`
  }

  function show(options = {}) {
    const variant = options.variant === 'list-picker' ? 'list-picker' : 'confirm'
    const tone = options.tone === 'danger' ? 'danger' : 'info'
    const title = String(options.title || (variant === 'list-picker' ? '请选择' : '请确认'))
    const message = String(options.message || '')
    const confirmText = String(options.confirmText || '确定')
    const cancelText = String(options.cancelText || '取消')
    const items = Array.isArray(options.items) ? options.items : []

    if (variant === 'list-picker' && !items.length) return Promise.resolve(null)

    return new Promise(resolve => {
      document.querySelector('.lingxi-dialog-backdrop')?.remove()
      const backdrop = document.createElement('div')
      backdrop.className = 'branch-danger-backdrop lingxi-dialog-backdrop'

      const bodyHtml = variant === 'list-picker'
        ? `${message ? `<div class="lingxi-dialog-message">${escapeHtml(message)}</div>` : ''}
           <div class="lingxi-dialog-list">
             ${items.map((item, index) => `
               <button class="lingxi-dialog-item" type="button" data-action="pick" data-index="${index}">
                 <span class="lingxi-dialog-item-text">
                   <span class="lingxi-dialog-item-label">${escapeHtml(item.label || '')}</span>
                   ${item.sublabel ? `<span class="lingxi-dialog-item-sub">${escapeHtml(item.sublabel)}</span>` : ''}
                 </span>
               </button>`).join('')}
           </div>`
        : `<div class="lingxi-dialog-message">${escapeHtml(message)}</div>`

      const actionsHtml = variant === 'list-picker'
        ? `<button class="branch-danger-btn" type="button" data-action="cancel">${escapeHtml(cancelText)}</button>`
        : `<button class="branch-danger-btn" type="button" data-action="cancel">${escapeHtml(cancelText)}</button>
           <button class="branch-danger-btn ${tone === 'danger' ? 'danger' : 'primary'}" type="button" data-action="confirm">${escapeHtml(confirmText)}</button>`

      backdrop.innerHTML = `
        <div class="branch-danger-dialog ${tone === 'info' ? 'info' : ''} lingxi-dialog" role="dialog" aria-modal="true" aria-labelledby="lingxiDialogTitle">
          <div class="branch-danger-head">
            <span class="branch-danger-icon" aria-hidden="true">${tone === 'danger' ? dangerIcon() : infoIcon()}</span>
            <div class="branch-danger-title-group">
              <div class="branch-danger-title" id="lingxiDialogTitle">${escapeHtml(title)}</div>
            </div>
            <button class="branch-danger-close" type="button" data-action="cancel" title="取消">
              <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
          <div class="branch-danger-body">${bodyHtml}</div>
          <div class="branch-danger-actions">${actionsHtml}</div>
        </div>
      `

      const finish = value => {
        backdrop.remove()
        document.removeEventListener('keydown', onKeydown, true)
        restoreFocus()
        resolve(value)
      }

      const pickIndex = index => {
        const item = items[index]
        if (!item) return finish(null)
        finish(Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : item)
      }

      const onKeydown = event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish(variant === 'list-picker' ? null : false)
          return
        }
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        const focused = document.activeElement
        const action = focused?.closest?.('[data-action]')?.dataset?.action
        if (action === 'cancel') {
          finish(variant === 'list-picker' ? null : false)
          return
        }
        if (action === 'pick') {
          pickIndex(Number(focused.closest('[data-action="pick"]')?.dataset?.index))
          return
        }
        if (variant === 'confirm') finish(true)
      }

      backdrop.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset?.action
        if (event.target === backdrop || action === 'cancel') {
          finish(variant === 'list-picker' ? null : false)
          return
        }
        if (action === 'confirm') {
          finish(true)
          return
        }
        if (action === 'pick') {
          pickIndex(Number(event.target.closest('[data-action="pick"]')?.dataset?.index))
        }
      })

      document.body.appendChild(backdrop)
      requestAnimationFrame(() => {
        const focusTarget = variant === 'list-picker'
          ? backdrop.querySelector('[data-action="pick"]')
          : backdrop.querySelector('[data-action="confirm"]')
        focusTarget?.focus()
      })
      requestAnimationFrame(() => {
        document.addEventListener('keydown', onKeydown, true)
      })
    })
  }

  window.LingxiDialog = { show }
})()
