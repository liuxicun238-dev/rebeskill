const fs = require('fs')
const path = require('path')

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, records.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8')
}

function sessionLines(cwd, imagePath) {
  const request = [
    '# Files mentioned by the user:',
    '',
    `- ${imagePath}`,
    '',
    '## My request:',
    '分组不可用的不要展示，能用的要能建组。'
  ].join('\n')
  const tableReply = [
    '路由结果如下：',
    '',
    '| 分组 | 模型 | 状态 |',
    '| - | - | - |',
    '| Cursor Claude GPT | **grok-4.5** | 服务暂时不可用&#x20;|',
    '',
    '没有一个模型可用。'
  ].join('\n')
  const lines = [
    { timestamp: '2026-08-21T10:00:00.000Z', type: 'session_meta', payload: { id: '11111111-2222-4333-8444-555555555555', cwd, originator: 'codex_cli_rs', cli_version: '0.40.0', source: 'cli' } },
    {
      timestamp: '2026-08-21T10:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n打包规范\n</INSTRUCTIONS>` }]
      }
    },
    {
      timestamp: '2026-08-21T10:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n- Airtable (airtable@openai-curated-remote)\n</recommended_plugins>' }]
      }
    },
    {
      timestamp: '2026-08-21T10:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `<environment_context>\n<cwd>${cwd}</cwd>\n</environment_context>` }]
      }
    }
  ]
  for (let index = 1; index <= 12; index++) {
    const userText = index === 1 ? request : `用户任务${index}`
    lines.push({
      timestamp: `2026-08-21T10:${String(index).padStart(2, '0')}:00.000Z`,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] }
    })
    lines.push({
      timestamp: `2026-08-21T10:${String(index).padStart(2, '0')}:05.000Z`,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: index === 1 ? tableReply : `助手回复${index}` }]
      }
    })
    if (index === 3) {
      lines.push({
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec', arguments: '{"cmd":"secret"}' }
      })
      lines.push({
        type: 'response_item',
        payload: { type: 'function_call_output', output: 'TOOL_SECRET_SHOULD_NOT_IMPORT' }
      })
    }
    if (index === 4) {
      lines.push({
        type: 'compacted',
        payload: { message: '已完成前几轮目录梳理，下一步继续改导入入口。' }
      })
    }
  }
  return lines
}

module.exports = {
  id: 'codex.session-import',
  title: 'Codex local sessions import as Lingxi chat history and compression summaries',
  tags: ['codex', 'import', 'welcome', 'compression'],
  changedFilePatterns: [
    /^electron\/modules\/codex-session-import\.js$/i,
    /^electron\/modules\/context-compression\.js$/i,
    /^electron\/modules\/projects\.js$/i,
    /^frontend\/scripts\/features\/(?:codex-import-ui|project-state-helpers|chat-renderer)\.js$/i
  ],

  async run(ctx) {
    const workspace = ctx.createWorkspace(this.id)
    const importer = require(path.join(ctx.root, 'electron/modules/codex-session-import'))
    const compression = require(path.join(ctx.root, 'electron/modules/context-compression'))
    const tableParser = require(path.join(ctx.root, 'frontend/scripts/features/markdown-table-parser.js'))
    const renderer = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/chat-renderer.js'), 'utf8')
    const welcomeHelpers = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/project-state-helpers.js'), 'utf8')
    const welcomeCss = fs.readFileSync(path.join(ctx.root, 'frontend/styles/chat.css'), 'utf8')
    const indexHtml = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const secret = 'AUTH_SECRET_SHOULD_NOT_IMPORT'
    const toolSecret = 'TOOL_SECRET_SHOULD_NOT_IMPORT'
    const cwd = workspace.projectPath
    fs.mkdirSync(cwd, { recursive: true })
    const imagePath = path.join(workspace.dir, 'codex-clipboard-demo.png')
    fs.writeFileSync(imagePath, PNG_1X1)
    const home = path.join(workspace.dir, 'codex-home')
    const sessionFile = path.join(home, 'sessions', '2026', '08', '21', 'rollout-2026-08-21T10-00-00-11111111-2222-4333-8444-555555555555.jsonl')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { secret } }), 'utf8')
    fs.writeFileSync(path.join(home, 'config.toml'), 'openai_api_key = "cfg-secret"\n', 'utf8')
    writeJsonl(sessionFile, sessionLines(cwd, imagePath))

    ctx.assert.ok(welcomeHelpers.includes('data-welcome-codex-import'), 'welcome empty state should mount the Codex transfer banner')
    ctx.assert.ok(welcomeHelpers.includes('assets/model-icons/lobe/codex-color.svg'), 'welcome banner should use the Codex brand mark, not a play-triangle icon')
    ctx.assert.ok(welcomeCss.includes('.welcome-codex-import'), 'welcome CSS should style the transfer banner')
    ctx.assert.ok(indexHtml.includes('codex-import-ui.js'), 'index.html should load the Codex import UI')
    ctx.assert.ok(renderer.includes("importedFrom === 'codex'"), 'history renderer should recognize Codex imported turns')
    ctx.assert.ok(renderer.includes('is-codex-import'), 'imported AI bubbles should keep a Codex header divider')
    ctx.assert.ok(welcomeCss.includes('.message.ai.is-codex-import .ai-header'), 'Codex import header should restore the separator line')
    ctx.assert.ok(!renderer.includes('codex-import-tool-note'), 'imported turns must not render a Codex tool summary card')
    ctx.assert.ok(!welcomeCss.includes('codex-import-tool-note'), 'tool summary card styles should stay removed')

    ctx.assert.ok(typeof compression.buildImportedCompressionSummary === 'function', 'compression module should build imported summaries')

    let denied = false
    try {
      importer.assertSessionFilePath(path.join(home, 'auth.json'), home)
    } catch (error) {
      denied = error?.code === 'SESSION_PATH_DENIED'
    }
    ctx.assert.ok(denied, 'auth.json must not be readable as a session file')

    const listed = await importer.listCodexSessions({ codexHome: home })
    ctx.assert.equal(listed.success, true, 'listing fake Codex home should succeed')
    ctx.assert.equal(listed.sessions.length, 1, 'should find the synthetic rollout')
    ctx.assert.equal(listed.sessions[0].cwd, cwd, 'list item should keep the session cwd')
    ctx.assert.equal(listed.sessions[0].cwdExists, true, 'existing project folder should be marked present')
    ctx.assert.ok(!listed.sessions[0].title.includes('Files mentioned'), 'session title should use the request, not the file envelope')
    ctx.assert.ok(!listed.sessions[0].title.includes('AGENTS.md'), 'session title should skip injected AGENTS.md context')
    ctx.assert.ok(!listed.sessions[0].title.includes('recommended_plugins'), 'session title should skip injected plugin lists')
    ctx.assert.ok(listed.sessions[0].title.includes('分组不可用'), 'session title should use the first real user request')
    ctx.assert.equal(listed.sessions[0].userTurns, 12, 'list should not count injected AGENTS.md/plugin turns')

    fs.writeFileSync(
      path.join(home, 'session_index.jsonl'),
      `${JSON.stringify({ id: '11111111-2222-4333-8444-555555555555', thread_name: '分组能力筛选' })}\n`,
      'utf8'
    )
    const named = await importer.listCodexSessions({ codexHome: home })
    ctx.assert.equal(named.sessions[0].title, '分组能力筛选', 'session_index thread_name should win as the list title')
    const listedText = JSON.stringify(listed)
    ctx.assert.ok(!listedText.includes(secret), 'session list must not include auth.json secrets')
    ctx.assert.ok(!listedText.includes(toolSecret), 'session list head should not include tool output secrets')

    const parsed = await importer.parseCodexSessionFile(sessionFile, { codexHome: home })
    const payload = importer.buildLingxiImportPayload(parsed)
    ctx.assert.ok(payload.messages.length >= 20, 'imported history should keep user and assistant text')
    ctx.assert.equal(payload.userTurns, 12, 'should count 12 user turns')
    ctx.assert.ok(payload.skippedTools >= 2, 'Codex tool calls should be counted and skipped')
    ctx.assert.ok(payload.summaries.length >= 1, 'older turns should land in a Lingxi compression summary')
    ctx.assert.equal(payload.summaries[0].schemaVersion, 4, 'imported summary must use schema v4')
    ctx.assert.ok(payload.messages.every(item => !item.codexToolSummary && !item.tool_calls), 'import must not attach tool summary cards or replay tool_calls')
    const blob = JSON.stringify(payload)
    ctx.assert.ok(!blob.includes(toolSecret), 'function_call_output must not enter Lingxi history or summaries')
    ctx.assert.ok(!blob.includes(secret), 'auth secrets must not enter the import payload')
    ctx.assert.ok(payload.messages.every(item => item.role === 'user' || item.role === 'assistant'), 'imported messages must stay user/assistant text')
    ctx.assert.ok(payload.messages.some(item => item.content === '用户任务12'), 'latest user turn should remain in live history')
    ctx.assert.ok(payload.messages[0].messageId, 'imported messages should receive identities')

    const firstUser = payload.messages.find(item => item.role === 'user')
    ctx.assert.ok(firstUser.displayContent.includes('分组不可用的不要展示'), 'user bubble should keep the real request')
    ctx.assert.ok(!firstUser.displayContent.includes('Files mentioned by the user'), 'file envelope must be stripped from display text')
    ctx.assert.ok(!firstUser.displayContent.includes('AGENTS.md'), 'imported history must not start with AGENTS.md instructions')
    ctx.assert.ok(!payload.messages.some(item => /recommended_plugins|#\s*AGENTS\.md/i.test(item.content || '')), 'injected Codex context must not enter Lingxi history')
    ctx.assert.ok(!firstUser.displayContent.includes(imagePath), 'clipboard image paths must not stay in the user bubble text')
    ctx.assert.equal(firstUser.attachments?.[0]?.kind, 'image', 'clipboard images should become Lingxi attachments')
    ctx.assert.equal(firstUser.attachments?.[0]?.path, imagePath, 'attachment should point at the source image before copy')

    const destDir = path.join(workspace.storagePath, 'imported-attachments')
    await importer.materializeImportedAttachments(payload.messages, destDir)
    const copied = firstUser.attachments[0].path
    ctx.assert.ok(copied.startsWith(destDir), 'import should copy images into Lingxi storage')
    ctx.assert.ok(fs.existsSync(copied), 'copied image file should exist')
    ctx.assert.ok(copied !== imagePath, 'copied image must not keep the Codex temp path')

    const firstAssistant = payload.messages.find(item => item.role === 'assistant')
    ctx.assert.equal(firstAssistant.modelName, 'Codex', 'imported assistant turns should be labeled Codex, not AI')
    ctx.assert.ok(firstAssistant.content.includes('\n'), 'assistant markdown newlines must be preserved')
    ctx.assert.ok(firstAssistant.content.includes('| --- |'), 'short table separators should be expanded to GFM')
    ctx.assert.ok(!firstAssistant.content.includes('&#x20;'), 'HTML entities in assistant text should be decoded')
    const tables = tableParser.extractTables(firstAssistant.content)
    ctx.assert.equal(tables.tables.length, 1, 'normalized Codex table should be recognized by the existing parser')
    ctx.assert.ok(String(tables.tables[0].rows?.[0]?.join(' ')).includes('grok-4.5'), 'table cells should keep the model name')
  }
}
