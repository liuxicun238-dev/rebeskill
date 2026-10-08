const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'chat.same-project-completed-turn-reconcile',
  title: 'Completed replies reconcile persisted Turn/Item tools without a project switch',
  tags: ['chat', 'history', 'turn', 'tools'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/chat-renderer\.js$/i,
    /^frontend\/scripts\/features\/ipc-reply-listener\.js$/i,
    /^frontend\/scripts\/features\/message-sender\.js$/i,
    /^frontend\/scripts\/features\/ai-stream-renderer\.js$/i,
    /^frontend\/styles\/chat\.css$/i,
    /^frontend\/scripts\/app\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i
  ],

  async run(ctx) {
    const rendererSource = fs.readFileSync(
      path.join(ctx.root, 'frontend/scripts/features/chat-renderer.js'),
      'utf8'
    )
    const replySource = fs.readFileSync(
      path.join(ctx.root, 'frontend/scripts/features/ipc-reply-listener.js'),
      'utf8'
    )
    const appSource = fs.readFileSync(
      path.join(ctx.root, 'frontend/scripts/app.js'),
      'utf8'
    )
    const senderSource = fs.readFileSync(
      path.join(ctx.root, 'frontend/scripts/features/message-sender.js'),
      'utf8'
    )
    const aiChatSource = fs.readFileSync(
      path.join(ctx.root, 'electron/modules/ai-chat.js'),
      'utf8'
    )
    const streamSource = fs.readFileSync(
      path.join(ctx.root, 'frontend/scripts/features/ai-stream-renderer.js'),
      'utf8'
    )
    const chatCss = fs.readFileSync(
      path.join(ctx.root, 'frontend/styles/chat.css'),
      'utf8'
    )

    ctx.assert.match(
      rendererSource,
      /function projectTurnEvidenceIntoHistory\(messagesHistory, turn = null\)/
    )
    ctx.assert.match(
      rendererSource,
      /const missingToolItems = toolItems\.filter/
    )
    ctx.assert.match(
      rendererSource,
      /targetHistoryIndex[\s\S]*dataset\?\.historyIndex/
    )
    ctx.assert.match(
      rendererSource,
      /turnMetadata[\s\S]*modelName/
    )
    ctx.assert.match(
      rendererSource,
      /function reconcileHistoricalTurn\(messagesHistory, turn = null, projectPath = '', options = \{\}\)/
    )
    ctx.assert.match(
      rendererSource,
      /reconcileHistoricalTurn,\s*setHistoricalTurn/
    )
    ctx.assert.match(
      rendererSource,
      /historicalTurn = turn[\s\S]*renderRound\(latestRound, projectPath\)/
    )
    ctx.assert.match(
      rendererSource,
      /salvagedGraphs[\s\S]*AgentTeamGraph\?\.restoreGraphs/
    )
    ctx.assert.match(
      rendererSource,
      /function shouldKeepLiveProcess\(oldAi, newAi\)/
    )
    ctx.assert.match(
      rendererSource,
      /if \(shouldKeepLiveProcess\(oldAi, newAi\)\)/
    )
    ctx.assert.match(
      rendererSource,
      /patchCompletedAiShell\(oldAi, newAi\)/
    )
    ctx.assert.match(
      rendererSource,
      /adoptLiveProcess\(newAi, salvagedArea\)/
    )
    ctx.assert.match(
      rendererSource,
      /takeLiveDynamicArea\(virtualRound\)/
    )
    ctx.assert.match(
      rendererSource,
      /countLiveToolCards\(oldAi\) >= countLiveToolCards\(newAi\)/
    )
    ctx.assert.ok(
      /const history = Array\.isArray\(messagesHistory\) \? messagesHistory : \[\]/.test(rendererSource),
      'completed-turn tool projection must write back into the live messagesHistory'
    )
    ctx.assert.ok(
      !/messagesHistory\.slice\(\)/.test(rendererSource.split('function projectTurnEvidenceIntoHistory')[1]?.split('function countLiveToolCards')[0] || 'messagesHistory.slice()'),
      'completed-turn tool projection must not copy messagesHistory into a throwaway array'
    )
    ctx.assert.match(
      replySource,
      /function applyReplyModelMetadata\(aiMsg, data = \{\}\)/
    )
    ctx.assert.match(
      replySource,
      /if \(data\.modelName\) historyEntry\.modelName = String\(data\.modelName\)/
    )
    ctx.assert.match(
      replySource,
      /applyReplyModelMetadata\(currentAiMsg, data\)/
    )
    ctx.assert.match(
      replySource,
      /async function reconcileCompletedTurn\(project, options = \{\}\)/
    )
    ctx.assert.match(
      replySource,
      /window\.api\.getTaskTurn\(project\.id, runId \|\| null\)/
    )
    ctx.assert.match(
      replySource,
      /deps\.getChatRenderer\?\.\(\)\?\.reconcileHistoricalTurn\?\.\(/
    )
    ctx.assert.match(
      replySource,
      /const completedRunId = String\(data\.runId \|\| data\.turnId \|\| ''\)\.trim\(\)/
    )
    ctx.assert.match(
      replySource,
      /replyProject\.latestCompletedRunId = String\(data\.runId \|\| data\.turnId\)/
    )
    ctx.assert.match(
      replySource,
      /async function recoverTurnFromCompletionEvent\(data = \{\}\)/
    )
    ctx.assert.match(
      replySource,
      /function isVisibleChatTarget\(project, data = \{\}\)/
    )
    ctx.assert.match(
      replySource,
      /const originatingSessionId = normalizeSessionId/
    )
    ctx.assert.match(
      replySource,
      /if \(!isVisibleChatTarget\(project, options\)\) return 'skipped'/
    )
    ctx.assert.match(
      replySource,
      /const replyProject = data\.projectId \? projects\.find\(p => p\.id === data\.projectId\) : null/
    )
    ctx.assert.match(
      rendererSource,
      /function visibleChatMatches\(identity = \{\}\)/
    )
    ctx.assert.match(
      rendererSource,
      /querySelectorAll\?\.?\('\.message\.user:not\(\.message-user-interject\)'\)/
    )
    ctx.assert.match(
      rendererSource,
      /const layoutShift = Math\.abs\(heightDelta\) > 1/
    )
    ctx.assert.match(
      rendererSource,
      /if \(followLatest\) window\.ChatStickyBottom\?\.holdFollow\?\.\(chatMessages\)/
    )
    ctx.assert.match(
      rendererSource,
      /const holdFollowToBottom = \(\) => \{/
    )
    ctx.assert.match(
      streamSource,
      /if \(followLatest\) window\.ChatStickyBottom\?\.holdFollow\?\.\(chatMessages\)/
    )
    ctx.assert.match(
      streamSource,
      /if \(followLatest\) window\.ChatStickyBottom\?\.noteProgrammatic\?\.\(chatMessages, 400\)/
    )
    ctx.assert.match(
      chatCss,
      /\.chat-messages \{[\s\S]*overflow-anchor:\s*none/
    )
    ctx.assert.ok(
      !/if \(!firstUser\) \{\s*restoreChatHistory\(projectedHistory/.test(rendererSource),
      'completed-turn reconcile must not wipe the whole chat back to older history'
    )
    ctx.assert.match(
      replySource,
      /data\?\.type !== 'turn-completed'/
    )
    ctx.assert.match(
      replySource,
      /window\.api\.onTurnEvent\(data => \{/
    )
    ctx.assert.match(
      replySource,
      /TURN_RECOVERY_RETRY_DELAYS/
    )
    ctx.assert.match(
      appSource,
      /getChatRenderer:\s*\(\) => chatRenderer/
    )
    ctx.assert.match(
      senderSource,
      /async function reconcileLatestCompletedTurn\(project\)/
    )
    ctx.assert.match(
      senderSource,
      /await reconcileLatestCompletedTurn\(project\)/
    )
    ctx.assert.match(
      senderSource,
      /window\.api\.getTaskTurn\(project\.id, runId \|\| null\)/
    )
    ctx.assert.match(
      senderSource,
      /先把上一轮已持久化的 Turn\/Item 工具链补回 DOM/
    )
    const finishIndex = aiChatSource.indexOf("lingxiHarness.finishTurn(turnRuntime, 'completed'")
    const replyIndex = aiChatSource.indexOf("webContents?.send('message-reply'", finishIndex)
    ctx.assert.ok(finishIndex >= 0 && replyIndex > finishIndex, 'successful replies must notify renderer only after Turn/Run persistence finishes')
    ctx.assert.match(
      aiChatSource,
      /modelName,\s*modelId,\s*toolCallCount: toolCallsRecord\.length/
    )
    ctx.assert.match(
      aiChatSource,
      /runId: runRef\.runId,\s*turnId: runRef\.runId,\s*content: refusalContent/
    )
    ctx.assert.match(
      aiChatSource,
      /runId: runRef\.runId,\s*turnId: runRef\.runId,\s*error: err\.message,\s*done: true,\s*changeSession: finalizedChangeSession/
    )
  }
}
