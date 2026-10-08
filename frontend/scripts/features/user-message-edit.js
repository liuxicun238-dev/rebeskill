(function () {
  let deps = {}
  let activeEdit = null

  function bind(depsObj = {}) {
    deps = depsObj || {}
  }

  function escapeHtml(value) {
    if (window.HtmlUtils?.escapeHtml) return window.HtmlUtils.escapeHtml(value)
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function toast(message, type = 'info') {
    if (deps.showToast) deps.showToast(message, type)
    else window.ToastUI?.show?.(message, type)
  }

  function getProject() {
    return deps.getActiveProject?.() || window.LingxiProjectState?.getActiveProject?.() || null
  }

  function findHistoryEntry(msgEl) {
    const project = getProject()
    const history = Array.isArray(project?.messagesHistory) ? project.messagesHistory : []
    const messageId = String(msgEl?.dataset?.messageId || '').trim()
    if (messageId) {
      const index = history.findIndex(item => String(item?.messageId || '') === messageId)
      if (index >= 0) return { entry: history[index], index }
    }
    const historyIndex = Number(msgEl?.dataset?.historyIndex)
    if (Number.isInteger(historyIndex) && historyIndex >= 0 && history[historyIndex]?.role === 'user') {
      return { entry: history[historyIndex], index: historyIndex }
    }
    return { entry: null, index: -1 }
  }

  function visibleTextFrom(msgEl, entry) {
    const strip = deps.stripMentionDirectives || window.WorkbenchMention?.stripMentionDirectives || (value => String(value || '').trim())
    if (entry) {
      const raw = String(entry.displayContent || entry.content || '')
      return strip(raw.replace(/^【引用：[^\n]*】\n?/gm, '').trim())
    }
    const full = msgEl.querySelector('.user-message-full')?.textContent
    if (full) return strip(full)
    return strip(msgEl.querySelector('.user-message-text')?.textContent || msgEl.querySelector('.message-bubble')?.textContent || '')
  }

  function isEditing() {
    return !!activeEdit
  }

  function cancel(restore = true) {
    if (!activeEdit) return
    const session = activeEdit
    activeEdit = null
    session.msgEl.classList.remove('is-editing')
    if (restore && session.originalHtml != null) {
      session.msgEl.innerHTML = session.originalHtml
      window.CopyButton?.refresh?.(session.msgEl)
    }
  }

  function attachmentChip(item, index) {
    const name = escapeHtml(item.name || '附件')
    const pathValue = item.path ? ` data-path="${escapeHtml(item.path)}"` : ''
    const thumb = item.thumb
      ? `<img class="user-message-image-thumb" src="${escapeHtml(item.thumb)}" alt="${name}">`
      : ''
    return `<span class="user-message-edit-file" data-edit-file="${index}"${pathValue}>${thumb}<span>${name}</span><button type="button" class="user-message-edit-file-remove" data-edit-remove="${index}" aria-label="移除附件">×</button></span>`
  }

  function renderAttachments(session) {
    const host = session.msgEl.querySelector('[data-edit-attachments]')
    if (!host) return
    host.innerHTML = session.attachments.map((item, index) => attachmentChip(item, index)).join('')
    host.querySelectorAll('[data-edit-remove]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        const index = Number(button.getAttribute('data-edit-remove'))
        if (!Number.isInteger(index)) return
        session.attachments.splice(index, 1)
        renderAttachments(session)
      })
    })
  }

  async function addFilesToEdit(files) {
    if (!activeEdit || !files?.length) return
    const api = window.api
    for (const file of Array.from(files)) {
      if (!file) continue
      try {
        const dataUrl = await readFileAsDataUrl(file)
        const saved = file.type?.startsWith('image/')
          ? await api?.savePastedImage?.({ data: dataUrl, type: file.type || 'image/png', name: file.name || 'pasted-image.png' })
          : await api?.saveUploadedFile?.({ data: dataUrl, type: file.type || 'application/octet-stream', name: file.name || 'attachment' })
        if (!saved?.success || !saved.path) continue
        activeEdit.attachments.push({
          name: saved.name || file.name || 'attachment',
          path: saved.path,
          type: saved.type || file.type || '',
          size: file.size || 0,
          thumb: file.type?.startsWith('image/') ? dataUrl : ''
        })
      } catch (error) {
        console.warn('[UserMessageEdit] add file failed:', error)
      }
    }
    renderAttachments(activeEdit)
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('读取附件失败'))
      reader.readAsDataURL(file)
    })
  }

  function followingCount(project, historyIndex) {
    const history = Array.isArray(project?.messagesHistory) ? project.messagesHistory : []
    if (!Number.isInteger(historyIndex) || historyIndex < 0) return 0
    return history.slice(historyIndex + 1).filter(item => item && !item.hidden).length
  }

  function confirmEditResend(following) {
    return new Promise(resolve => {
      let resolved = false
      const overlay = document.createElement('div')
      overlay.className = 'message-delete-confirm'
      overlay.innerHTML = `
        <div class="message-delete-confirm-panel message-edit-confirm-panel" role="dialog" aria-modal="true" aria-labelledby="userMessageEditConfirmTitle">
          <div class="message-delete-confirm-icon message-edit-confirm-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
            </svg>
          </div>
          <div class="message-delete-confirm-main">
            <div class="message-delete-confirm-title" id="userMessageEditConfirmTitle">确认用这次编辑重新发送？</div>
            <div class="message-delete-confirm-text">${
              following > 0
                ? `发送后会用你现在改的内容替换这条用户消息，并删除它后面的 ${following} 条对话，然后重新请求。这不是再发一条新消息。`
                : '发送后会用你现在改的内容替换这条用户消息，然后重新请求。这不是再发一条新消息。'
            }</div>
            <div class="message-delete-confirm-actions">
              <button type="button" class="message-delete-confirm-btn secondary" data-action="cancel">取消</button>
              <button type="button" class="message-delete-confirm-btn primary" data-action="confirm">确认发送</button>
            </div>
          </div>
        </div>
      `
      function close(value) {
        if (resolved) return
        resolved = true
        document.removeEventListener('keydown', onKeydown, true)
        overlay.remove()
        resolve(value)
      }
      function onKeydown(event) {
        if (event.key === 'Escape') close(false)
        if (event.key === 'Enter') close(true)
      }
      overlay.addEventListener('click', event => {
        const action = event.target.closest('[data-action]')?.dataset.action
        if (action === 'confirm') close(true)
        if (action === 'cancel' || event.target === overlay) close(false)
      })
      document.addEventListener('keydown', onKeydown, true)
      document.body.appendChild(overlay)
      overlay.querySelector('[data-action="confirm"]')?.focus()
    })
  }

  function applyLocalHistory(project, messages) {
    if (!project || !Array.isArray(messages)) return
    project.messagesHistory = messages
    if (Array.isArray(project.history)) {
      project.history = messages.filter(item => item && !item.hidden)
    }
  }

  function applyEditedMessageDom(msgEl, payload) {
    if (!msgEl) return
    msgEl.classList.remove('is-editing')
    let sibling = msgEl.nextSibling
    while (sibling) {
      const next = sibling.nextSibling
      if (sibling.nodeType === 1) sibling.remove()
      sibling = next
    }
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : []
    const attachmentHtml = attachments.map(item => {
      const name = escapeHtml(item.name || '附件')
      const pathValue = item.path ? ` data-path="${escapeHtml(item.path)}"` : ''
      const isImage = (item.type && String(item.type).startsWith('image/'))
        || /\.(png|jpe?g|gif|bmp|webp|svg|ico)$/i.test(String(item.name || item.path || ''))
      if (isImage) {
        const thumb = item.thumb
          ? `<img class="user-message-image-thumb" src="${escapeHtml(item.thumb)}" alt="${name}">`
          : '<span class="image-preview-lazy-text">图片</span>'
        return `<button type="button" class="user-message-image"${pathValue} title="${name}">${thumb}</button>`
      }
      return `<div class="user-message-file"${pathValue} title="${name}">${name}</div>`
    }).join('')
    const bubble = msgEl.querySelector('.message-bubble') || msgEl
    bubble.innerHTML = `${attachmentHtml ? `<div class="user-message-attachments">${attachmentHtml}</div>` : ''}<div class="user-message-text"></div>`
    const textEl = bubble.querySelector('.user-message-text')
    if (textEl) textEl.textContent = payload.text || ''
    window.CopyButton?.refresh?.(msgEl)
    try {
      window.ChatHistoryPaginator?.destroy?.()
      window.ChatVirtualScroller?.destroy?.(document.getElementById('chatMessages'))
    } catch (_) { /* keep the trimmed DOM */ }
  }

  function collectPayload(session) {
    const textarea = session.msgEl.querySelector('[data-edit-input]')
    const text = String(textarea?.value || '').trim()
    return {
      text,
      attachments: session.attachments.slice(),
      references: session.references.slice(),
      directiveBadges: session.directiveBadges.slice(),
      messageId: session.messageId,
      historyIndex: session.historyIndex
    }
  }

  async function submit() {
    if (!activeEdit) return
    const project = getProject()
    if (!project) return
    if (project.isRunning) {
      toast('AI 正在处理，请等本轮完成后再编辑发送。', 'error')
      return
    }
    const payload = collectPayload(activeEdit)
    if (!payload.text && payload.attachments.length === 0 && payload.references.length === 0) {
      toast('编辑后的消息不能为空', 'info')
      return
    }
    const confirmed = await confirmEditResend(followingCount(project, payload.historyIndex))
    if (!confirmed || !activeEdit) return
    if (!window.api?.editUserMessageAndTruncate) {
      toast('当前客户端还不支持编辑消息', 'error')
      return
    }
    const result = await window.api.editUserMessageAndTruncate({
      projectId: project.id,
      messageId: payload.messageId,
      historyIndex: payload.historyIndex,
      fallbackLastUser: !payload.messageId && !Number.isInteger(payload.historyIndex),
      content: payload.text,
      displayContent: payload.text,
      attachments: payload.attachments,
      references: payload.references,
      directiveBadges: payload.directiveBadges
    })
    if (!result?.success) {
      toast(result?.error || '编辑失败', 'error')
      return
    }
    const msgEl = activeEdit.msgEl
    const messages = result.messages || result.messagesHistory
    applyLocalHistory(project, Array.isArray(messages) && messages.length ? messages : null)
    if (!Array.isArray(project.history)) {
      project.history = Array.isArray(project.messagesHistory) ? project.messagesHistory : []
    }
    cancel(false)
    applyEditedMessageDom(msgEl, payload)
    if (typeof deps.sendMessage !== 'function') {
      toast('发送接口不可用，编辑已保存但没有重新请求模型', 'error')
      return
    }
    try {
      const sent = deps.sendMessage({
        editResend: true,
        allowWhileRunning: true,
        displayMessage: payload.text,
        attachments: payload.attachments,
        references: payload.references,
        directiveBadges: payload.directiveBadges
      })
      if (sent && typeof sent.catch === 'function') {
        sent.catch(error => {
          toast(error?.message || '重新请求失败', 'error')
        })
      }
    } catch (error) {
      toast(error?.message || '重新请求失败', 'error')
    }
  }

  function begin(msgEl) {
    if (!msgEl?.classList?.contains('user')) return
    if (msgEl.classList.contains('message-user-interject')) {
      toast('注入消息不能编辑', 'info')
      return
    }
    const project = getProject()
    if (project?.isRunning) {
      toast('AI 正在处理，请等本轮完成后再编辑。', 'error')
      return
    }
    const located = findHistoryEntry(msgEl)
    if (!located.entry && !msgEl.dataset.historyIndex && !msgEl.dataset.messageId) {
      toast('这条消息还不能编辑', 'info')
      return
    }
    if (activeEdit && activeEdit.msgEl !== msgEl) cancel(true)
    if (activeEdit?.msgEl === msgEl) return

    const entry = located.entry || {}
    const attachments = Array.isArray(entry.attachments)
      ? entry.attachments.map(item => ({ ...item }))
      : []
    const references = Array.isArray(entry.references)
      ? entry.references.map(item => ({ ...item }))
      : []
    const directiveBadges = Array.isArray(entry.directiveBadges)
      ? entry.directiveBadges.map(item => ({ ...item }))
      : []

    activeEdit = {
      msgEl,
      originalHtml: msgEl.innerHTML,
      attachments,
      references,
      directiveBadges,
      messageId: String(msgEl.dataset.messageId || entry.messageId || ''),
      historyIndex: Number.isInteger(located.index) ? located.index : Number(msgEl.dataset.historyIndex)
    }

    msgEl.classList.add('is-editing')
    const text = visibleTextFrom(msgEl, entry)
    const bubble = msgEl.querySelector('.message-bubble') || msgEl
    bubble.innerHTML = `
      <div class="user-message-edit-attachments" data-edit-attachments></div>
      <textarea class="user-message-edit-input" data-edit-input rows="3">${escapeHtml(text)}</textarea>
      <div class="user-message-edit-actions">
        <button type="button" class="user-message-edit-cancel" data-edit-cancel>取消</button>
        <button type="button" class="user-message-edit-send" data-edit-send>发送</button>
      </div>
    `
    renderAttachments(activeEdit)
    Promise.all((activeEdit.attachments || []).map(async item => {
      if (!item.path || item.thumb || !window.api?.readImageDataUrl) return
      try {
        const result = await window.api.readImageDataUrl(item.path)
        if (result?.dataUrl) item.thumb = result.dataUrl
      } catch (_) { /* keep name chip */ }
    })).then(() => {
      if (activeEdit?.msgEl === msgEl) renderAttachments(activeEdit)
    })
    const textarea = bubble.querySelector('[data-edit-input]')
    textarea?.focus()
    textarea?.setSelectionRange?.(textarea.value.length, textarea.value.length)
    bubble.querySelector('[data-edit-cancel]')?.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      cancel(true)
    })
    bubble.querySelector('[data-edit-send]')?.addEventListener('click', event => {
      event.preventDefault()
      event.stopPropagation()
      void submit()
    })
    textarea?.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel(true)
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        void submit()
      }
    })
    const onPaste = event => {
      const files = Array.from(event.clipboardData?.files || [])
      if (!files.length) return
      event.preventDefault()
      void addFilesToEdit(files)
    }
    const onDrop = event => {
      const files = Array.from(event.dataTransfer?.files || [])
      if (!files.length) return
      event.preventDefault()
      event.stopPropagation()
      void addFilesToEdit(files)
    }
    bubble.addEventListener('paste', onPaste)
    bubble.addEventListener('drop', onDrop)
    bubble.addEventListener('dragover', event => {
      if (event.dataTransfer?.files?.length) event.preventDefault()
    })
  }

  window.UserMessageEdit = {
    bind,
    begin,
    cancel,
    isEditing
  }
})()
