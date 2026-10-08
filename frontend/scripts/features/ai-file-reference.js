// AI 回复里的文件路径点击：预览或用系统打开。
(function () {
  'use strict'

  let deps = {}

  const fileReferenceLineSuffixRe = /(\.(?:js|jsx|ts|tsx|mjs|cjs|vue|svelte|css|scss|sass|less|html|htm|json|jsonc|md|markdown|py|java|c|h|cpp|hpp|cs|go|rs|php|rb|swift|kt|kts|sh|bash|zsh|ps1|bat|cmd|yml|yaml|toml|ini|env|txt|log|csv|xml|svg|png|jpe?g|webp|gif|bmp|ico|avif|pdf|docx?|xlsx?|pptx?|glb|gltf|blend))(?:[:：]\d+(?:[:：]\d+)?)$/i

  function decodeDataPath(el) {
    const raw = String(el?.getAttribute?.('data-path') || '')
    try {
      return decodeURIComponent(raw)
    } catch (_) {
      return raw
    }
  }

  function normalizeOpenablePath(rawPath = '') {
    return String(rawPath || '').trim().replace(fileReferenceLineSuffixRe, '$1')
  }

  function resolvePathForSystemOpen(rawPath = '') {
    const cleanPath = normalizeOpenablePath(rawPath)
    const projectPath = String(deps.getActiveProject?.()?.path || '').trim()
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(cleanPath) || /^\\\\/.test(cleanPath) || /^\//.test(cleanPath)
    return isAbsolute || !projectPath
      ? cleanPath
      : `${projectPath.replace(/[\\/]+$/, '')}\\${cleanPath.replace(/^[\\/]+/, '').replace(/\//g, '\\')}`
  }

  function openFilePreviewFromData(el) {
    const showToast = deps.showToast
    if (el?.getAttribute?.('data-open-mode') === 'system') {
      const targetPath = resolvePathForSystemOpen(decodeDataPath(el))
      const opener = window.api?.showItemInFolder || window.api?.openProjectFolder
      if (opener && targetPath) {
        opener(targetPath).then(result => {
          if (result?.error) showToast?.(result.error, 'error')
        }).catch(error => showToast?.(error.message || String(error), 'error'))
        return
      }
    }
    const filePreview = deps.getFilePreview?.()
    if (filePreview) {
      return filePreview.openFromData(el)
    }
    const rawPath = normalizeOpenablePath(decodeDataPath(el))
    if (rawPath) {
      const opener = window.api?.showItemInFolder || window.api?.openProjectFolder
      opener?.(rawPath)
    }
  }

  function openFilePreview(path) {
    return deps.getFilePreview?.()?.open(path)
  }

  function openImagePreviewFromData(el) {
    return deps.getFilePreview?.()?.openImageFromData?.(el)
  }

  function bindAiFileReferenceClicks() {
    const chatMessages = deps.getChatMessages?.()
    if (!chatMessages || chatMessages.dataset.aiFileReferenceClicksBound === 'true') return
    chatMessages.dataset.aiFileReferenceClicksBound = 'true'
    chatMessages.addEventListener('click', event => {
      const more = event.target?.closest?.('.ai-file-ref-cluster-more')
      if (more && chatMessages.contains(more)) {
        event.preventDefault()
        event.stopPropagation()
        window.AiFileRefCluster?.toggleCluster?.(more)
        return
      }
      const target = event.target?.closest?.('.ai-file-ref-path[data-path]')
      if (!target || !chatMessages.contains(target)) return
      event.preventDefault()
      event.stopPropagation()
      openFilePreviewFromData(target)
    })
  }

  function bind(depsObj = {}) {
    deps = depsObj
    window.openFilePreviewFromData = openFilePreviewFromData
    window.openImagePreviewFromData = openImagePreviewFromData
    window.openFilePreview = openFilePreview
    bindAiFileReferenceClicks()
  }

  window.AiFileReference = {
    bind,
    openFilePreviewFromData,
    openFilePreview,
    openImagePreviewFromData,
    bindAiFileReferenceClicks
  }
})()
