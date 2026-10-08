const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const COMPOSER_MAIN = '11111111-2222-4333-8444-555555555555'
const COMPOSER_LEGACY = '22222222-3333-4444-8555-666666666666'
const COMPOSER_SUB = '33333333-4444-4555-8666-777777777777'
const COMPOSER_DRAFT = 'empty-state-draft'
const TOOL_SECRET = 'TOOL_SECRET_SHOULD_NOT_IMPORT'
const AUTH_SECRET = 'AUTH_SECRET_SHOULD_NOT_IMPORT'
const REQUEST_SECRET = 'REQUEST_CONTEXT_SECRET_SHOULD_NOT_IMPORT'

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8')
}

function putKv(db, table, key, value) {
  db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value))
}

function createCursorHome(workspace, projectPath) {
  const home = path.join(workspace.dir, 'Cursor', 'User')
  const globalDir = path.join(home, 'globalStorage')
  const wsId = 'ws-demo'
  const wsDir = path.join(home, 'workspaceStorage', wsId)
  fs.mkdirSync(globalDir, { recursive: true })
  fs.mkdirSync(wsDir, { recursive: true })
  writeJson(path.join(home, 'storage.json'), { tokens: { secret: AUTH_SECRET } })
  writeJson(path.join(wsDir, 'workspace.json'), {
    folder: `file:///${String(projectPath).replace(/\\/g, '/')}`
  })

  const db = new DatabaseSync(path.join(globalDir, 'state.vscdb'))
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)')
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB)')
  db.exec(`CREATE TABLE composerHeaders (
    composerId TEXT PRIMARY KEY,
    workspaceId TEXT,
    createdAt INTEGER,
    lastUpdatedAt INTEGER,
    isArchived INTEGER,
    isSubagent INTEGER,
    recency INTEGER,
    checkpointAt INTEGER,
    value TEXT
  )`)

  const userBubbles = []
  const assistantBubbles = []
  const headers = []
  for (let index = 1; index <= 12; index++) {
    const userId = `user-${index}`
    const aiId = `ai-${index}`
    headers.push({ bubbleId: userId, type: 1 }, { bubbleId: aiId, type: 2 })
    userBubbles.push({
      id: userId,
      value: { type: 1, text: index === 1 ? '把 Cursor 会话接到灵犀里继续。' : `用户任务${index}` }
    })
    assistantBubbles.push({
      id: aiId,
      value: { type: 2, text: index === 1 ? '可以，只导入用户和助手正文。' : `助手回复${index}` }
    })
  }
  const toolId = 'tool-1'
  headers.splice(6, 0, { bubbleId: toolId, type: 2 })
  headers.push(
    { bubbleId: 'user-query-wrap', type: 1 },
    { bubbleId: 'ai-progress', type: 2 },
    { bubbleId: 'user-task-note', type: 1 },
    { bubbleId: 'ai-final-more', type: 2 }
  )
  userBubbles.push({
    id: 'user-query-wrap',
    value: {
      type: 1,
      text: '<timestamp>Saturday, Aug 22, 2026, 4:00 PM (UTC+8)</timestamp>\n<user_query>\n把最后一句话补完整。\n</user_query>'
    }
  })
  assistantBubbles.push({
    id: 'ai-progress',
    value: { type: 2, text: '先确认代理还在跑。' }
  })
  userBubbles.push({
    id: 'user-task-note',
    value: {
      type: 1,
      isSimulatedMsg: true,
      simulatedMsgReason: 3,
      text: [
        '<timestamp>Saturday, Aug 22, 2026, 4:22 PM (UTC+8)</timestamp>',
        '<system_notification>',
        'The following task has finished. If you were already aware, ignore this notification and do not restate prior responses.',
        '</system_notification>',
        '<task>',
        'kind: shell',
        'status: error',
        'task_id: 799875',
        'tool_call_id: call-5b04d194-69f0-4b8f-9638-153f7aa97147-131',
        '</task>'
      ].join('\n')
    }
  })
  assistantBubbles.push({
    id: 'ai-final-more',
    value: { type: 2, text: '当前活着的代理在 http://127.0.0.1:10102。' }
  })

  putKv(db, 'cursorDiskKV', `composerData:${COMPOSER_MAIN}`, {
    composerId: COMPOSER_MAIN,
    name: 'Cursor 导入演示',
    subtitle: '只导入正文',
    createdAt: 1787000000000,
    lastUpdatedAt: 1787000001000,
    unifiedMode: 'agent',
    modelConfig: { modelName: 'grok-4.6' },
    workspaceIdentifier: {
      id: wsId,
      uri: { scheme: 'file', fsPath: projectPath }
    },
    conversationMap: {},
    fullConversationHeadersOnly: headers
  })
  for (const item of [...userBubbles, ...assistantBubbles]) {
    putKv(db, 'cursorDiskKV', `bubbleId:${COMPOSER_MAIN}:${item.id}`, item.value)
  }
  putKv(db, 'cursorDiskKV', `bubbleId:${COMPOSER_MAIN}:${toolId}`, {
    type: 2,
    text: '',
    toolFormerData: { name: 'exec', args: TOOL_SECRET }
  })
  putKv(db, 'cursorDiskKV', `messageRequestContext:${COMPOSER_MAIN}:user-1`, {
    prompt: REQUEST_SECRET
  })

  db.prepare(`INSERT INTO composerHeaders
    (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)`).run(
    COMPOSER_MAIN,
    wsId,
    1787000000000,
    1787000001000,
    1787000001000,
    JSON.stringify({
      composerId: COMPOSER_MAIN,
      name: 'Cursor 导入演示',
      workspaceIdentifier: { id: wsId, uri: { fsPath: projectPath, scheme: 'file' } }
    })
  )
  db.prepare(`INSERT INTO composerHeaders
    (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value)
    VALUES (?, ?, ?, ?, 0, 1, ?, ?)`).run(
    COMPOSER_SUB,
    wsId,
    1787000002000,
    1787000002000,
    1787000002000,
    JSON.stringify({ composerId: COMPOSER_SUB, name: 'Explore something', isSubagent: true })
  )
  db.prepare(`INSERT INTO composerHeaders
    (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, value)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)`).run(
    COMPOSER_DRAFT,
    'empty-window',
    1787000003000,
    1787000003000,
    1787000003000,
    JSON.stringify({ composerId: COMPOSER_DRAFT, isDraft: true })
  )

  putKv(db, 'cursorDiskKV', `composerData:${COMPOSER_LEGACY}`, {
    composerId: COMPOSER_LEGACY,
    name: '旧版 conversationMap',
    createdAt: 1786000000000,
    lastUpdatedAt: 1786000000000,
    workspaceIdentifier: { id: wsId, uri: { fsPath: projectPath, scheme: 'file' } },
    fullConversationHeadersOnly: [
      { bubbleId: 'legacy-user', type: 1 },
      { bubbleId: 'legacy-ai', type: 2 }
    ],
    conversationMap: {
      'legacy-user': { type: 1, text: '这是旧格式用户话。' },
      'legacy-ai': { type: 2, text: '这是旧格式助手话。' }
    }
  })
  putKv(db, 'ItemTable', 'composer.composerHeaders', {
    allComposers: [{
      composerId: COMPOSER_LEGACY,
      name: '旧版 conversationMap',
      lastUpdatedAt: 1786000000000,
      workspaceIdentifier: { id: wsId, uri: { fsPath: projectPath, scheme: 'file' } }
    }]
  })

  putKv(db, 'cursorDiskKV', `composerData:${COMPOSER_SUB}`, {
    composerId: COMPOSER_SUB,
    name: 'Explore something',
    isSubagent: true,
    fullConversationHeadersOnly: [{ bubbleId: 'sub-user', type: 1 }],
    conversationMap: { 'sub-user': { type: 1, text: 'subagent only' } }
  })

  db.close()

  const wsDb = new DatabaseSync(path.join(wsDir, 'state.vscdb'))
  wsDb.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)')
  putKv(wsDb, 'ItemTable', 'composer.composerData', {
    selectedComposerIds: [COMPOSER_MAIN],
    lastFocusedComposerIds: [COMPOSER_MAIN],
    hasMigratedComposerData: true
  })
  wsDb.close()

  return home
}

module.exports = {
  id: 'cursor.session-import',
  title: 'Cursor local composer chats import as Lingxi history',
  tags: ['cursor', 'import', 'welcome'],
  changedFilePatterns: [
    /^electron\/modules\/cursor-session-import\.js$/i,
    /^electron\/modules\/projects\.js$/i,
    /^frontend\/scripts\/features\/(?:cursor-import-ui|project-state-helpers|chat-renderer)\.js$/i
  ],

  async run(ctx) {
    const workspace = ctx.createWorkspace(this.id)
    const importer = require(path.join(ctx.root, 'electron/modules/cursor-session-import'))
    const renderer = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/chat-renderer.js'), 'utf8')
    const welcomeHelpers = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/project-state-helpers.js'), 'utf8')
    const welcomeCss = fs.readFileSync(path.join(ctx.root, 'frontend/styles/chat.css'), 'utf8')
    const indexHtml = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const cwd = workspace.projectPath
    fs.mkdirSync(cwd, { recursive: true })
    const home = createCursorHome(workspace, cwd)

    ctx.assert.ok(welcomeHelpers.includes('data-welcome-cursor-import'), 'welcome empty state should mount the Cursor transfer banner')
    ctx.assert.ok(welcomeHelpers.includes('assets/model-icons/lobe/cursor.svg'), 'welcome banner should use the Cursor brand mark')
    ctx.assert.ok(welcomeCss.includes('data-welcome-cursor-import') || welcomeCss.includes('.welcome-import-stack'), 'welcome CSS should stack Cursor next to Codex')
    ctx.assert.ok(indexHtml.includes('cursor-import-ui.js'), 'index.html should load the Cursor import UI')
    ctx.assert.ok(renderer.includes("importedFrom === 'cursor'"), 'history renderer should recognize Cursor imported turns')
    ctx.assert.ok(renderer.includes('is-cursor-import'), 'imported AI bubbles should keep a Cursor header divider')
    ctx.assert.ok(
      /importedFrom === 'codex' \|\| step\?\.importedFrom === 'cursor'/.test(renderer),
      'Cursor imports should reuse the Codex rule that hides the empty 已完成 work header'
    )
    ctx.assert.ok(welcomeCss.includes('.message.ai.is-cursor-import .ai-header'), 'Cursor import header should restore the separator line')

    let denied = false
    try {
      importer.assertCursorReadablePath(path.join(home, 'storage.json'), home)
    } catch (error) {
      denied = error?.code === 'CURSOR_PATH_DENIED'
    }
    ctx.assert.ok(denied, 'storage.json must not be readable as a session file')

    const listed = await importer.listCursorSessions({ cursorUserDir: home })
    ctx.assert.equal(listed.success, true, 'listing fake Cursor home should succeed')
    const ids = listed.sessions.map(item => item.composerId)
    ctx.assert.ok(ids.includes(COMPOSER_MAIN), '3.0 composerHeaders session should appear')
    ctx.assert.ok(ids.includes(COMPOSER_LEGACY), 'legacy conversationMap session should appear')
    ctx.assert.ok(!ids.includes(COMPOSER_SUB), 'subagent chats should stay out of the import list')
    ctx.assert.ok(!ids.includes(COMPOSER_DRAFT), 'draft chats should stay out of the import list')
    const main = listed.sessions.find(item => item.composerId === COMPOSER_MAIN)
    ctx.assert.equal(main.cwd, cwd, 'list item should keep the workspace folder')
    ctx.assert.equal(main.cwdExists, true, 'existing project folder should be marked present')
    ctx.assert.equal(main.title, 'Cursor 导入演示', 'list title should come from composer name')
    const listedText = JSON.stringify(listed)
    ctx.assert.ok(!listedText.includes(AUTH_SECRET), 'session list must not include storage.json secrets')
    ctx.assert.ok(!listedText.includes(TOOL_SECRET), 'session list must not include tool payload secrets')
    ctx.assert.ok(!listedText.includes(REQUEST_SECRET), 'session list must not include request-context secrets')

    const parsed = importer.parseCursorSession(COMPOSER_MAIN, { cursorUserDir: home })
    const payload = importer.buildLingxiImportPayload(parsed)
    ctx.assert.ok(payload.messages.length >= 20, 'imported history should keep user and assistant text')
    ctx.assert.equal(payload.userTurns, 13, 'should count real user turns and unwrap user_query')
    ctx.assert.ok(payload.skippedTools >= 2, 'Cursor tool bubbles and simulated task notices should be skipped')
    ctx.assert.ok(payload.summaries.length >= 1, 'older turns should land in a Lingxi compression summary')
    ctx.assert.ok(payload.messages.every(item => item.importedFrom === 'cursor'), 'imported messages should be tagged as cursor')
    ctx.assert.ok(payload.messages.every(item => item.role === 'user' || item.role === 'assistant'), 'imported messages must stay user/assistant text')
    ctx.assert.ok(payload.messages.some(item => item.content === '用户任务12'), 'earlier user turns should remain in history')
    ctx.assert.ok(payload.messages.some(item => item.content === '把最后一句话补完整。'), 'user_query wrappers should keep only the real request')
    const lastAssistant = [...payload.messages].reverse().find(item => item.role === 'assistant')
    ctx.assert.ok(lastAssistant?.content.includes('先确认代理还在跑'), 'assistant fragments before a task notice should stay')
    ctx.assert.ok(lastAssistant?.content.includes('10102'), 'later assistant fragments should merge into the same reply')
    ctx.assert.ok(!payload.messages.some(item => /<system_notification|<task\b|task_id:/i.test(item.content)), 'simulated Cursor task notices must not become user bubbles')
    ctx.assert.ok(payload.messages[0].messageId, 'imported messages should receive identities')
    const firstAssistant = payload.messages.find(item => item.role === 'assistant')
    ctx.assert.equal(firstAssistant.modelName, 'grok-4.6', 'imported assistant turns should keep the Cursor model label')
    const blob = JSON.stringify(payload)
    ctx.assert.ok(!blob.includes(TOOL_SECRET), 'toolFormerData must not enter Lingxi history or summaries')
    ctx.assert.ok(!blob.includes(AUTH_SECRET), 'auth secrets must not enter the import payload')
    ctx.assert.ok(!blob.includes(REQUEST_SECRET), 'messageRequestContext must not be read into the import payload')
    ctx.assert.ok(!blob.includes('speculativeSummarizationEncryptionKey'), 'composer encryption keys must not be copied')
    ctx.assert.ok(!blob.includes('The following task has finished'), 'task-finished notices must not enter the import payload')

    const legacy = importer.parseCursorSession(COMPOSER_LEGACY, { cursorUserDir: home })
    const legacyPayload = importer.buildLingxiImportPayload(legacy)
    ctx.assert.equal(legacyPayload.userTurns, 1, 'legacy conversationMap should import the user turn')
    ctx.assert.ok(legacyPayload.messages.some(item => item.content === '这是旧格式用户话。'), 'legacy map text should survive')
  }
}
