(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.AiFileRefCluster = api
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FILE_REF_CLUSTER_MIN = 4
  const FILE_REF_CLUSTER_PREVIEW = 8
  const GLUE_RE = /^[\s,;、，|/]+$/
  const FILE_EXT = 'js|jsx|ts|tsx|mjs|cjs|vue|svelte|css|scss|sass|less|html|htm|json|jsonc|md|markdown|py|java|c|h|cpp|hpp|cs|go|rs|php|rb|swift|kt|kts|sh|bash|zsh|ps1|bat|cmd|yml|yaml|toml|ini|env|txt|log|csv|xml|svg|png|jpe?g|webp|gif|bmp|ico|avif'

  function isClusterGlueText(text) {
    return GLUE_RE.test(String(text || ''))
  }

  function looksLikeFilePathToken(text) {
    const value = String(text || '').trim()
    if (!value || value.length > 180 || /\s/.test(value)) return false
    if (/^(https?:|file:|mailto:)/i.test(value)) return false
    if (/[\\/]/.test(value)) return true
    return new RegExp(`\\.(?:${FILE_EXT})(?:[:：]\\d+(?:[:：]\\d+)?)?$`, 'i').test(value)
  }

  function isFileRefToken(node) {
    if (!node || node.nodeType !== 1) return false
    if (node.classList?.contains('ai-file-ref')) return true
    if (node.matches?.('code.ai-inline-code') && looksLikeFilePathToken(node.textContent)) return true
    return false
  }

  function isGlueNode(node) {
    if (!node) return false
    if (node.nodeType === 3) return isClusterGlueText(node.nodeValue)
    if (node.nodeType === 1 && String(node.tagName || '').toUpperCase() === 'BR') return true
    return false
  }

  function findFileRefRuns(nodes = [], options = {}) {
    const list = Array.from(nodes || [])
    const minCount = Math.max(2, Number(options.minCount) || FILE_REF_CLUSTER_MIN)
    const isRef = typeof options.isRef === 'function' ? options.isRef : (item => !!(item && item.isRef))
    const isGlue = typeof options.isGlue === 'function' ? options.isGlue : (item => !!(item && item.isGlue))
    const runs = []
    let current = []
    for (let i = 0; i < list.length; i++) {
      const node = list[i]
      if (isRef(node)) {
        current.push(node)
        continue
      }
      if (current.length && isGlue(node) && isRef(list[i + 1])) continue
      if (current.length) {
        runs.push(current)
        current = []
      }
    }
    if (current.length) runs.push(current)
    return runs.filter(run => run.length >= minCount)
  }

  function overflowLabel(hiddenCount, expanded) {
    if (expanded) return '收起'
    return `还有 ${Math.max(0, Number(hiddenCount) || 0)} 个`
  }

  function wrapFileRefRun(refs, documentRef) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null)
    if (!doc || !refs.length) return null
    const first = refs[0]
    const last = refs[refs.length - 1]
    const parent = first.parentNode
    if (!parent) return null

    const cluster = doc.createElement('span')
    cluster.className = 'ai-file-ref-cluster'
    cluster.setAttribute('data-count', String(refs.length))
    cluster.setAttribute('data-preview', String(FILE_REF_CLUSTER_PREVIEW))

    const items = doc.createElement('span')
    items.className = 'ai-file-ref-cluster-items'
    cluster.appendChild(items)
    parent.insertBefore(cluster, first)

    let node = first
    while (node) {
      const next = node.nextSibling
      const isLast = node === last
      if (refs.includes(node)) items.appendChild(node)
      else parent.removeChild(node)
      if (isLast) break
      node = next
    }

    refs.forEach((el, index) => {
      if (index >= FILE_REF_CLUSTER_PREVIEW) el.classList.add('ai-file-ref-overflow')
    })

    if (refs.length > FILE_REF_CLUSTER_PREVIEW) {
      const more = doc.createElement('button')
      more.type = 'button'
      more.className = 'ai-file-ref-cluster-more'
      more.setAttribute('aria-expanded', 'false')
      more.textContent = overflowLabel(refs.length - FILE_REF_CLUSTER_PREVIEW, false)
      cluster.appendChild(more)
    }
    return cluster
  }

  function collapseFileReferenceClusters(root, documentRef) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null)
    if (!root || !doc) return root
    const tokens = root.querySelectorAll('.ai-file-ref, code.ai-inline-code')
    const parents = []
    tokens.forEach(el => {
      if (!el.classList.contains('ai-file-ref') && !looksLikeFilePathToken(el.textContent)) return
      const parent = el.parentElement
      if (!parent) return
      if (parent.closest('.ai-file-ref-cluster, pre, .ai-code-wrapper, .tool-card, .ai-artifact-card, a, button')) return
      if (!parents.includes(parent)) parents.push(parent)
    })
    parents.forEach(parent => {
      const runs = findFileRefRuns(parent.childNodes, {
        minCount: FILE_REF_CLUSTER_MIN,
        isRef: isFileRefToken,
        isGlue: isGlueNode
      })
      for (let i = runs.length - 1; i >= 0; i--) wrapFileRefRun(runs[i], doc)
    })
    return root
  }

  function toggleCluster(buttonEl) {
    const cluster = buttonEl?.closest?.('.ai-file-ref-cluster')
    if (!cluster || !buttonEl) return false
    const expanded = cluster.classList.toggle('is-expanded')
    buttonEl.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    const total = Number(cluster.getAttribute('data-count') || '0')
    const preview = Number(cluster.getAttribute('data-preview') || FILE_REF_CLUSTER_PREVIEW)
    buttonEl.textContent = overflowLabel(total - preview, expanded)
    return expanded
  }

  return {
    FILE_REF_CLUSTER_MIN,
    FILE_REF_CLUSTER_PREVIEW,
    isClusterGlueText,
    looksLikeFilePathToken,
    isFileRefToken,
    isGlueNode,
    findFileRefRuns,
    wrapFileRefRun,
    collapseFileReferenceClusters,
    toggleCluster,
    overflowLabel
  }
})
