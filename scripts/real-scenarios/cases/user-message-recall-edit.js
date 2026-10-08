const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'chat.user-message-recall-edit',
  title: 'Unstarted interrupt recalls the draft; user bubbles get edit instead of branch',
  tags: ['chat', 'interrupt', 'edit'],
  changedFilePatterns: [
    /^electron\/modules\/chat\/unstarted-turn-recall\.js$/i,
    /^electron\/modules\/chat\/user-message-edit\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/modules\/(?:projects|ai-chat|chat-chunk-store)\.js$/i,
    /^frontend\/scripts\/(?:app|message-copy|features\/user-message-(?:draft|edit)|features\/message-sender|features\/attachments|features\/text-input-ui)\.js$/i
  ],

  async run(ctx) {
    const recall = require(path.join(ctx.root, 'electron/modules/chat/unstarted-turn-recall'))
    const editor = require(path.join(ctx.root, 'electron/modules/chat/user-message-edit'))
    const frontendDraft = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/user-message-draft.js'), 'utf8')
    const frontendEdit = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/user-message-edit.js'), 'utf8')
    const messageCopy = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/message-copy.js'), 'utf8')
    const sender = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/message-sender.js'), 'utf8')
    const appJs = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/app.js'), 'utf8')
    const indexHtml = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const copyCss = fs.readFileSync(path.join(ctx.root, 'frontend/styles/message-copy.css'), 'utf8')
    const aiChat = fs.readFileSync(path.join(ctx.root, 'electron/modules/ai-chat.js'), 'utf8')
    const preload = fs.readFileSync(path.join(ctx.root, 'electron/preload.js'), 'utf8')

    ctx.assert.ok(indexHtml.includes('user-message-draft.js'), 'index.html should load draft recall helper')
    ctx.assert.ok(indexHtml.includes('user-message-edit.js'), 'index.html should load user message editor')
    ctx.assert.ok(messageCopy.includes('message-inline-edit-btn'), 'user bubbles should get an edit button')
    ctx.assert.ok(messageCopy.includes('isUser'), 'inline actions should treat user and AI bubbles differently')
    ctx.assert.ok(messageCopy.includes("actionsEl.querySelector('.message-inline-branch-btn')?.remove()"), 'user bubbles should drop the branch button')
    ctx.assert.ok(copyCss.includes('.message-inline-edit-btn'), 'edit button should be styled next to copy')
    ctx.assert.ok(frontendEdit.includes('user-message-edit-send'), 'inline editor should have a send action')
    ctx.assert.ok(frontendEdit.includes('user-message-edit-cancel'), 'inline editor should have a cancel action')
    ctx.assert.ok(frontendEdit.includes('confirmEditResend'), 'edit send must ask before replacing the original turn')
    ctx.assert.ok(frontendEdit.includes('这不是再发一条新消息'), 'confirm copy should say this is not a new message')
    ctx.assert.ok(frontendEdit.includes('editUserMessageAndTruncate'), 'edit send should replace that user turn and drop later replies')
    ctx.assert.ok(frontendEdit.includes('editResend: true'), 'after confirm, send should reuse the truncated turn')
    ctx.assert.ok(frontendEdit.includes('allowWhileRunning: true'), 'edit resend must not wait on history rebuild or a stale running flag')
    ctx.assert.ok(frontendEdit.includes('applyEditedMessageDom'), 'edit resend should update the bubble in place before requesting the model')
    ctx.assert.ok(sender.includes('if (!isEditResend && sendEpoch'), 'edit resend must not drop the request when the send epoch changes')
    ctx.assert.ok(sender.includes('editResend'), 'sender should accept an in-place edit resend')
    ctx.assert.ok(sender.includes('skipUserPersist: isEditResend'), 'edit resend must not persist a second user row')
    ctx.assert.ok(messageCopy.includes('data-lingxi-user-copy'), 'user copy should carry attachments in a lingxi clipboard marker')
    ctx.assert.ok(messageCopy.includes('collectUserAttachments'), 'user copy should collect images and files from the bubble')
    ctx.assert.ok(appJs.includes('onInsertText'), 'composer paste should be able to restore copied user text')
    const attachmentsJs = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/attachments.js'), 'utf8')
    ctx.assert.ok(attachmentsJs.includes('restoreFiles(copiedAttachments'), 'composer paste should restore copied user attachments')
    ctx.assert.ok(appJs.includes('recallUnstartedTurn'), 'interrupt should recall an unstarted turn into the composer')
    ctx.assert.ok(appJs.includes('recallUnstarted: true'), 'frontend interrupt should tell the backend this is a recall')
    ctx.assert.ok(aiChat.includes('recallUnstarted'), 'backend abort path should recognize unstarted recall')
    ctx.assert.ok(frontendDraft.includes('canRecallUnstartedTurn'), 'draft helper should decide when a turn is still recallable')

    const history = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '刚发出去', attachments: [{ name: 'a.png', path: 'C:/tmp/a.png' }] }
    ]
    ctx.assert.equal(recall.hasDurableWorkAfter(history, 2), false, 'a lone pending user turn has no durable assistant work')
    const popped = recall.popUnstartedUserMessage(history, 2)
    ctx.assert.equal(popped.popped, true, 'unstarted user turn should be removable')
    ctx.assert.equal(popped.history.length, 2, 'recall should keep earlier completed turns')
    ctx.assert.equal(recall.popUnstartedUserMessage(history, 0).popped, false, 'completed turns with later assistant work must stay')

    const started = [
      { role: 'user', content: '改代码' },
      { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'text_edit' } }] }
    ]
    ctx.assert.equal(recall.hasDurableWorkAfter(started, 0), true, 'tool calls mean the turn already started')

    const before = [
      { role: 'user', content: '你好', messageId: 'u1' },
      { role: 'assistant', content: '你好，需要什么帮助？', messageId: 'a1' },
      { role: 'user', content: '后面还有一轮', messageId: 'u2' }
    ]
    const edited = editor.applyEditAndTruncate(before, {
      messageId: 'u1',
      content: '你好，帮我看看',
      attachments: [{ name: 'shot.png', path: 'D:/shot.png', type: 'image/png' }]
    })
    ctx.assert.equal(before.length, 3, 'source history used by truncate helper must stay intact')
    ctx.assert.equal(edited.ok, true, 'editing an earlier user turn should succeed')
    ctx.assert.equal(edited.history.length, 1, 'later turns must be dropped after edit-and-truncate')
    ctx.assert.equal(edited.history[0].content, '你好，帮我看看', 'the edited user text should replace the original turn')
    ctx.assert.equal(edited.history[0].attachments?.[0]?.name, 'shot.png', 'edited attachments should stay on that user turn')
    ctx.assert.equal(edited.removed.length, 2, 'the following user and assistant turns should be removed')
    ctx.assert.ok(frontendEdit.includes('cancel(false)'), 'after confirm, the inline editor should not restore the old bubble')
    ctx.assert.ok(copyCss.includes('message-delete-confirm-btn.primary') || copyCss.includes('.message-delete-confirm-btn.primary'), 'edit confirm should reuse the existing dialog style')
    ctx.assert.ok(preload.includes('editUserMessageAndTruncate'), 'preload should expose the truncate IPC')
    const projectsJs = fs.readFileSync(path.join(ctx.root, 'electron/modules/projects.js'), 'utf8')
    ctx.assert.ok(projectsJs.includes('loadFullChatHistoryForEdit'), 'edit must load the full history, not just the latest page')
    ctx.assert.ok(projectsJs.includes('chatChunkStore.replaceAll(instance.chatHistoryPath, result.history'), 'edit must rewrite persisted history, not append-only snapshot')
    ctx.assert.ok(appJs.includes('onReady: finish'), 'edit resend must wait until history DOM is ready before creating the AI block')
    ctx.assert.ok(sender.includes('editedAt: Date.now()'), 'edit resend should patch the existing user turn instead of leaving the old text')
  }
}
