/**
 * Send search-stage updates to the tool card. These events are UI-only and
 * never go back into the model transcript.
 */

function resolveWebContents(ctx = {}) {
  if (ctx.webContents && !ctx.webContents.isDestroyed?.()) return ctx.webContents
  const projectId = ctx.projectId
  if (!projectId) return null
  try {
    const projects = require('../projects')
    const webContents = projects.getWebContentsForProject(projectId)
    if (webContents && !webContents.isDestroyed?.()) return webContents
  } catch (_) { /* isolated tests */ }
  return null
}

function emitSearchProgress(ctx = {}, progress = {}) {
  const webContents = resolveWebContents(ctx)
  if (!webContents) return false
  try {
    webContents.send('tool-progress', {
      projectId: ctx.projectId || '',
      name: ctx.toolName || 'web_bridge_search',
      toolCallId: ctx.toolCallId || ctx.options?.toolCallId || '',
      kind: 'chatgpt-web-search',
      ...progress
    })
    return true
  } catch (_) {
    return false
  }
}

function createThrottledEmitter(ctx, minGapMs = 80) {
  let lastAt = 0
  let lastSignature = ''
  return (progress = {}, force = false) => {
    const signature = JSON.stringify({
      stage: progress.stage,
      queries: progress.queries,
      sourceCount: progress.sourceCount,
      groupCount: Array.isArray(progress.resultGroups) ? progress.resultGroups.length : 0,
      error: progress.error || ''
    })
    const now = Date.now()
    if (!force && signature === lastSignature) return false
    if (!force && now - lastAt < minGapMs && signature === lastSignature) return false
    lastAt = now
    lastSignature = signature
    return emitSearchProgress(ctx, progress)
  }
}

module.exports = {
  emitSearchProgress,
  createThrottledEmitter
}
