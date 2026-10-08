const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'chat.completed-turn-visible-session-only',
  title: 'Final reply completion must not paint another project or session into the visible chat',
  tags: ['chat', 'project-switch', 'turn', 'session'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/ipc-reply-listener\.js$/i,
    /^frontend\/scripts\/features\/chat-renderer\.js$/i,
    /^frontend\/scripts\/features\/message-sender\.js$/i,
    /^frontend\/scripts\/features\/project-switcher\.js$/i,
    /^frontend\/scripts\/features\/project-list\.js$/i,
    /^frontend\/scripts\/features\/chat-history-paginator\.js$/i,
    /^frontend\/scripts\/features\/chat-virtual-scroller\.js$/i,
    /^frontend\/scripts\/features\/ai-stream-renderer\.js$/i,
    /^frontend\/scripts\/app\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/modules\/chat\/turn-item-store\.js$/i
  ],

  async run(ctx) {
    const read = rel => fs.readFileSync(path.join(ctx.root, rel), 'utf8')
    const replySource = read('frontend/scripts/features/ipc-reply-listener.js')
    const rendererSource = read('frontend/scripts/features/chat-renderer.js')
    const senderSource = read('frontend/scripts/features/message-sender.js')
    const switcherSource = read('frontend/scripts/features/project-switcher.js')
    const listSource = read('frontend/scripts/features/project-list.js')
    const paginatorSource = read('frontend/scripts/features/chat-history-paginator.js')
    const scrollerSource = read('frontend/scripts/features/chat-virtual-scroller.js')
    const appSource = read('frontend/scripts/app.js')
    const aiChatSource = read('electron/modules/ai-chat.js')
    const turnStoreSource = read('electron/modules/chat/turn-item-store.js')

    ctx.assert.ok(
      replySource.includes('function isVisibleChatTarget(project, data = {})') &&
        replySource.includes("if (!isVisibleChatTarget(project, options)) return 'skipped'") &&
        replySource.includes('const originatingSessionId = normalizeSessionId'),
      'turn completion recovery must skip DOM reconcile when the visible chat is no longer that project/session'
    )
    ctx.assert.ok(
      replySource.includes('const replyProject = data.projectId ? projects.find(p => p.id === data.projectId) : null') &&
        !replySource.includes('data.projectId ? projects.find(p => p.id === data.projectId) : deps.getActiveProject()'),
      'a reply without projectId must not fall back to the currently active project'
    )
    ctx.assert.ok(
      rendererSource.includes('function visibleChatMatches(identity = {})') &&
        rendererSource.includes('if (!visibleChatMatches(identity)) return false') &&
        rendererSource.includes('function stampVisibleChatIdentity(container, identity = {})'),
      'historical turn projection must refuse to mutate another project\'s visible chat'
    )
    ctx.assert.ok(
      switcherSource.includes('function markVisibleChatIdentity(project, container)') &&
        switcherSource.includes('markVisibleChatIdentity(project, chatMessages)'),
      'switching projects must stamp the shared chat container with the visible project identity'
    )
    ctx.assert.ok(
      senderSource.includes('if (project.id !== deps.getActiveProjectId?.()) return'),
      'sending a new message must not project a previous turn onto a chat the user already left'
    )
    ctx.assert.ok(
      listSource.includes('const isChatSessionCurrent = !!session.current || (!!sessionId && sessionId === String(project.chatSessionId || \'\').trim())'),
      'the project list selected state must follow the visible chatSessionId, not only a stale current flag'
    )
    ctx.assert.ok(
      /if \(!state \|\| state\.generation !== scheduledGeneration \|\| state\.projectId !== scheduledProjectId\) return/.test(paginatorSource),
      'paginator delayed afterRender must not fire for a previous project'
    )
    ctx.assert.ok(
      /buildPlaceholdersInBatches\(generation, roundsData\.length, \(\) => \{\s*if \(isDestroyed \|\| generation !== resetGeneration\) return/.test(scrollerSource),
      'virtual scroller reset completion must ignore a superseded generation'
    )
    ctx.assert.ok(
      appSource.includes('getVisibleProjectId: () => activeProjectId'),
      'the main chat renderer must know which project is currently visible'
    )
    ctx.assert.match(
      rendererSource,
      /const layoutShift = Math\.abs\(heightDelta\) > 1/
    )
    ctx.assert.match(
      rendererSource,
      /holdFollow\(container\)/
    )
    const streamSource = read('frontend/scripts/features/ai-stream-renderer.js')
    ctx.assert.match(
      streamSource,
      /if \(followLatest\) window\.ChatStickyBottom\?\.holdFollow\?\.\(chatMessages\)/
    )
    ctx.assert.ok(
      turnStoreSource.includes("chatSessionId: String(runRef?.chatSessionId || payload.chatSessionId || '')") &&
        aiChatSource.includes('chatSessionId: instance?.chatSessionId || instance?.collaborationSessionId || \'\'') &&
        /webContents\?\.send\('message-reply', \{\s*projectId,\s*runId: runRef\.runId,\s*turnId: runRef\.runId,\s*chatSessionId:/.test(aiChatSource),
      'completed turn events and done replies must carry the originating chat session'
    )
  }
}
