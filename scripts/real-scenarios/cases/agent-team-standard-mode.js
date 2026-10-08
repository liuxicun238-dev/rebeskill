const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'agent-team.standard-mode',
  title: 'Standard mode can dispatch in-process teammates; research mode cannot',
  tags: ['agent', 'team', 'standard-mode', 'tools'],
  changedFilePatterns: [
    /^electron\/modules\/schemas\/delegate-agents\.js$/i,
    /^electron\/modules\/schemas\/index\.js$/i,
    /^electron\/modules\/agent-team-runtime\.js$/i,
    /^electron\/modules\/agent-team-worker\.js$/i,
    /^electron\/modules\/tool-handlers\/delegate-agents\.js$/i,
    /^electron\/modules\/tool-registry\.js$/i,
    /^electron\/modules\/capability-tiers\.js$/i,
    /^electron\/modules\/model-api-adapter\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/modules\/agent-runtime\.js$/i,
    /^electron\/modules\/chat-helpers\.js$/i,
    /^electron\/preload\.js$/i,
    /^frontend\/index\.html$/i,
    /^frontend\/scripts\/features\/agent-team-graph\.js$/i,
    /^frontend\/scripts\/canvas-view\.js$/i,
    /^frontend\/scripts\/features\/canvas-inspector\.js$/i,
    /^frontend\/styles\/agent-team-graph\.css$/i,
    /^frontend\/styles\/canvas-workflow\.css$/i,
    /^frontend\/styles\/chat\.css$/i,
    /^frontend\/scripts\/features\/ai-message-ui\.js$/i,
    /^frontend\/scripts\/features\/ai-tool-renderer\.js$/i,
    /^frontend\/scripts\/features\/chat-renderer\.js$/i,
    /^frontend\/scripts\/features\/window-tabs\.js$/i,
    /^frontend\/scripts\/features\/integration-market\.js$/i
  ],

  async run(ctx) {
    const schemas = require(path.join(ctx.root, 'electron/modules/schemas'))
    const registry = require(path.join(ctx.root, 'electron/modules/tool-registry'))
    const runtime = require(path.join(ctx.root, 'electron/modules/agent-team-runtime'))
    const adapter = require(path.join(ctx.root, 'electron/modules/model-api-adapter'))
    const helpers = require(path.join(ctx.root, 'electron/modules/chat-helpers'))
    const tiers = require(path.join(ctx.root, 'electron/modules/capability-tiers'))

    ctx.assert.ok(
      schemas.MODEL_TOOLS_SCHEMA.some(tool => tool.function?.name === 'delegate_agents'),
      'delegate_agents must be model-visible'
    )
    ctx.assert.ok(registry.hasToolHandler('delegate_agents'), 'delegate_agents must have a handler')
    ctx.assert.ok(tiers.TOOL_PACKS.always.has('delegate_agents'), 'delegate_agents belongs in the always-on pack')
    ctx.assert.ok(helpers.isInternalUiOnlyToolName('delegate_agents'), 'dispatch itself should not render as a tool card')

    const visible = adapter.filterModelToolsForRequest(
      [{ role: 'user', content: '帮我改这个函数' }],
      { projectMode: 'standard' }
    ).map(tool => tool.function?.name)
    ctx.assert.ok(visible.includes('delegate_agents'), 'standard mode can see delegate_agents')

    const research = adapter.filterModelToolsForRequest(
      [{ role: 'user', content: '帮我改这个函数' }],
      { projectMode: 'research' }
    ).map(tool => tool.function?.name)
    ctx.assert.equal(research.includes('delegate_agents'), false, 'research mode must not see delegate_agents')

    const workerView = adapter.filterModelToolsForRequest(
      [{ role: 'user', content: '完成你的任务' }],
      { projectMode: 'standard', teamWorker: true }
    ).map(tool => tool.function?.name)
    ctx.assert.equal(workerView.includes('delegate_agents'), false, 'teammates must not nested-dispatch')

    const parsed = runtime.parseDelegateArgs({
      team_brief: '先侦察再汇总',
      tasks: [
        { id: 'a', name: '侦察员A', role: '前端', task: '看页面入口' },
        { id: 'b', name: '侦察员B', role: '接口', task: '看 API', depends_on: ['a'] },
        { id: 'c', name: '侦察员C', role: '样式', task: '看样式' }
      ]
    })
    ctx.assert.equal(parsed.success, true, parsed.error || 'valid DAG should parse')
    ctx.assert.equal(parsed.waves.length, 2, 'A and C first, then B')
    ctx.assert.deepEqual(parsed.waves[0].map(item => item.id).sort(), ['a', 'c'])
    ctx.assert.deepEqual(parsed.waves[1].map(item => item.id), ['b'])

    const execution = {
      id: 'exec-test',
      task: '先侦察再汇总',
      teamBrief: '先侦察再汇总',
      notes: { coordination: '先侦察再汇总', convention: '', consensus: '' },
      waves: parsed.waves,
      agents: parsed.tasks.map(task => ({
        id: task.id,
        name: task.name,
        role: task.role,
        task: task.task,
        dependsOn: task.dependsOn,
        status: 'waiting',
        thinking: [],
        tools: []
      })),
      status: 'running'
    }
    const workflow = runtime.buildWorkflowFromAgents(execution)
    ctx.assert.ok(workflow.nodes.some(node => node.id === 'task' && node.name === '你的任务'), 'graph starts with 你的任务')
    ctx.assert.ok(workflow.nodes.some(node => node.id === 'ceo' && node.name === 'CEO 汇总'), 'graph ends with CEO 汇总')
    ctx.assert.equal(workflow.nodes.filter(node => node.type === 'work').length, 3, 'worker nodes stay in the middle')
    ctx.assert.ok(workflow.edges.some(edge => edge.source === 'task'), 'task fans out to workers')
    ctx.assert.ok(workflow.edges.some(edge => edge.target === 'ceo'), 'leaves converge on CEO')
    const projection = runtime.toProjection(execution)
    ctx.assert.equal(projection.totalCount, 4, 'progress denominator includes CEO')
    ctx.assert.ok(projection.teamNotes.some(note => note.kind === '协调'), 'team notes expose 主协调')

    const cyclic = runtime.parseDelegateArgs({
      tasks: [
        { id: 'a', task: 'A', depends_on: ['b'] },
        { id: 'b', task: 'B', depends_on: ['a'] }
      ]
    })
    ctx.assert.equal(cyclic.success, false, 'cycles must be rejected')

    const objectTasks = runtime.parseDelegateArgs({
      tasks: {
        a: { id: 'a', task: '看入口' },
        b: { id: 'b', task: '看接口' }
      }
    })
    ctx.assert.equal(objectTasks.success, true, objectTasks.error || 'object-shaped tasks should coerce to an array')
    ctx.assert.equal(objectTasks.tasks.length, 2, 'coerced object tasks should keep both members')

    const underfilled = runtime.parseDelegateArgs({
      team_brief: '下面派 4 个侦察员并行摸底',
      tasks: [{ id: 'a', name: '结构边界侦察员', task: '看目录' }]
    })
    ctx.assert.equal(underfilled.success, false, 'announcing 4 teammates while sending 1 task must be rejected')

    const prompt = runtime.buildStandardModePrompt()
    ctx.assert.ok(prompt.includes('delegate_agents'), 'standard-mode prompt should name the tool')
    ctx.assert.ok(prompt.includes('简单问答'), 'standard-mode prompt should skip trivial work')

    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    ctx.assert.equal(html.includes('chat-toolbar-canvas-btn'), false, 'chat toolbar must not keep a standing canvas button')
    ctx.assert.ok(html.includes('agent-team-graph.js'), 'inline team graph script should be loaded')
    ctx.assert.ok(html.includes('在画布打开') === false || html.includes('AgentTeamGraph') || html.includes('agent-team-graph.js'), 'open-in-canvas lives in the inline graph')

    const graph = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/agent-team-graph.js'), 'utf8')
    ctx.assert.ok(graph.includes('你的任务'), 'inline graph copies AgentCore task bookend')
    ctx.assert.ok(graph.includes('CEO 汇总'), 'inline graph copies AgentCore CEO bookend')
    ctx.assert.ok(graph.includes('团队便签'), 'inline graph copies AgentCore team notes wall')
    ctx.assert.ok(graph.includes('在画布打开'), 'open-in-canvas lives in the inline graph')
    ctx.assert.ok(graph.includes('EMBED_MAX_HEIGHT'), 'inline graph must cap height like AgentCore embed')
    ctx.assert.ok(graph.includes('fitWidthBox'), 'inline graph must shrink tall stacks to fit the chat column')
    ctx.assert.ok(graph.includes('last.after(el)'), 'graph should mount after existing thinking/tool segments')
    ctx.assert.equal(graph.includes('insertBefore(el, dynamicArea.firstChild)'), false, 'graph must not jump above the thinking block')
    ctx.assert.ok(graph.includes('ai-team-card-enter'), 'nodes should play an enter animation')
    ctx.assert.ok(graph.includes('animateMotion'), 'live edges should carry AgentCore flow particles')
    ctx.assert.ok(graph.includes('ai-team-card-face'), 'enter motion belongs on the inner face, not the positioned card')
    ctx.assert.ok(graph.includes('patchHost'), 'live updates must patch nodes instead of wiping the graph')

    const graphCss = fs.readFileSync(path.join(ctx.root, 'frontend/styles/agent-team-graph.css'), 'utf8')
    ctx.assert.ok(graphCss.includes('@keyframes ai-team-card-enter'), 'enter motion should match AgentCore scale-in')
    ctx.assert.ok(graphCss.includes('@keyframes ai-team-card-flash'), 'completion should flash instead of pulsing the whole card')
    ctx.assert.equal(graphCss.includes('ai-team-pulse'), false, 'captain card must not pulse opacity')

    const inspector = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/canvas-inspector.js'), 'utf8')
    ctx.assert.ok(inspector.includes('renderTeamRun'), 'team node click should open teammate detail')
    ctx.assert.ok(inspector.includes('收到的上下文'), 'teammate detail should list received context')
    ctx.assert.ok(inspector.includes('mergeTimeline'), 'thinking and tools should interleave by time')

    const tabs = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/window-tabs.js'), 'utf8')
    ctx.assert.ok(tabs.includes('teamInspectorTitle'), 'right-side tab should use the teammate name')
    ctx.assert.equal(/title:\s*'节点检查器'/.test(tabs), false, 'team tabs must not be hard-coded as 节点检查器')

    const market = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/integration-market.js'), 'utf8')
    ctx.assert.ok(market.includes("querySelector('[data-integration-tab=\"workflows\"]')?.remove()"), 'resource center should drop the workflow tab')
    ctx.assert.equal(/insertAdjacentHTML\([^)]*data-integration-tab="workflows"/.test(market), false, 'resource center must not recreate the workflow tab')

    const chat = fs.readFileSync(path.join(ctx.root, 'electron/modules/ai-chat.js'), 'utf8')
    ctx.assert.ok(chat.includes('buildStandardModePrompt'), 'standard mode should inject team dispatch prompt')
    ctx.assert.ok(chat.includes('projectMode,'), 'tool requests should carry projectMode so research can hide dispatch')

    const worker = fs.readFileSync(path.join(ctx.root, 'electron/modules/agent-team-worker.js'), 'utf8')
    ctx.assert.equal(worker.includes('createTemporaryAgentChatInstance'), false, 'workers must not recreate temporary chat instances')
    ctx.assert.ok(worker.includes('executeToolForProject'), 'workers run tools in-process')
    ctx.assert.ok(worker.includes('harvestThink'), 'worker output must peel think tags before saving the conclusion')

    const workerMod = require(path.join(ctx.root, 'electron/modules/agent-team-worker.js'))
    const harvested = workerMod.harvestThink('<think>I have enough. Now let me write the final response.</think>\n## 项目本质\n一句话说明')
    ctx.assert.equal(harvested.text.includes('<think>'), false, 'conclusion must not keep think tags')
    ctx.assert.ok(harvested.text.includes('项目本质'), 'conclusion body stays after stripping think')
    ctx.assert.equal(harvested.thinks.length, 1, 'embedded think should move into thinking events')

    ctx.assert.ok(graph.includes('ai-team-spin-track'), 'status spinner should keep a track circle like Loader2')
    ctx.assert.ok(graph.includes('lifeIcon'), 'strip and node badges share a lifecycle icon')
    ctx.assert.ok(graph.includes('return ICONS.ring'), 'waiting/cancelled presence must keep a visible ring instead of emptying')

    ctx.assert.ok(graphCss.includes('--team-live: #38bdf8'), 'running spinner must use light blue, not the gray accent token')
    ctx.assert.ok(graphCss.includes('.ai-team-presence.is-running'), 'node presence badge must have a running state')
    ctx.assert.equal(/\.ai-team-presence\.is-running \{[^}]*accent-primary/.test(graphCss), false, 'presence spinner must not inherit the gray accent-primary')
    ctx.assert.ok(graphCss.includes('transform-origin: 50%'), 'spinner must rotate around the SVG center')
    ctx.assert.ok(graphCss.includes('transform-box: fill-box'), 'spinner origin must use the SVG box, not the arc fill')

    ctx.assert.ok(inspector.includes('renderAiContent'), 'teammate conclusion should render through LingXi markdown')
    ctx.assert.ok(inspector.includes('team-run-conclusion'), 'completed teammate should keep a conclusion section')
    ctx.assert.ok(inspector.includes('applyCtxSectionFold'), 'context section header must fold the whole list')
    ctx.assert.ok(inspector.includes('is-folded'), 'folded context section uses an explicit class so flex layout cannot keep the list visible')
    ctx.assert.ok(inspector.includes('team-run-ctx-pill'), 'context cards should show the channel pill like AgentCore')
    ctx.assert.ok(inspector.includes('team-run-ctx-count'), 'character count sits on the right of the fold row')
    ctx.assert.ok(inspector.includes('formatCompactChars'), 'character counts should compact like AgentCore 1.9k')
    ctx.assert.ok(inspector.includes('patchTeamContext'), 'live inspector refresh must not rebuild unchanged context cards')
    ctx.assert.ok(inspector.includes('restoreTimelineFolds'), 'tool card fold state must survive live timeline patches')
    ctx.assert.ok(inspector.includes('pointerHold'), 'clicking inspector cards must pause live replace so fold clicks land')
    ctx.assert.equal(/compactText\(item\.output/.test(inspector), false, 'team position must not dump teammate output into the context card')
    ctx.assert.ok(inspector.includes("open ? '' : ' hidden'"), 'collapsed context body uses hidden, not CSS-only display')

    const preserved = runtime.clipText('## 项目本质\n\n一句话说明', 4000)
    ctx.assert.ok(preserved.includes('\n'), 'teammate output must keep markdown line breaks')
    const smashed = runtime.toProjection({
      id: 'exec-output',
      task: '摸底',
      agents: [{ id: 'a', name: '侦察员', role: '侦察', status: 'done', output: '## 标题\n\n正文第一段', thinking: [], tools: [] }],
      status: 'done'
    }).agents[0].output
    ctx.assert.ok(smashed.includes('\n'), 'projection must not flatten conclusion into one paragraph')

    ctx.assert.ok(graph.includes('restoreGraphs'), 'completed-turn reconcile must put the live team graph back into the rebuilt bubble')
    ctx.assert.ok(graph.includes('remountInto'), 'expanding the work header must remount a detached team graph')
    const chatRenderer = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/chat-renderer.js'), 'utf8')
    ctx.assert.ok(chatRenderer.includes('shouldKeepLiveProcess'), 'completed-turn reconcile must keep live tool cards when history projection is poorer')
    ctx.assert.ok(chatRenderer.includes('salvagedGraphs'), 'history reconcile must salvage .ai-team-graph before replacing the round')
    ctx.assert.ok(chatRenderer.includes('AgentTeamGraph?.restoreGraphs'), 'salvaged team graphs must be restored onto the rebuilt AI message')

    const messageUi = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/ai-message-ui.js'), 'utf8')
    ctx.assert.ok(messageUi.includes('collapseOpenDeepReasoningBlocks(aiMsg)'), 'a new thinking block should fold the current deep-reasoning body')
    const toolRenderer = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/ai-tool-renderer.js'), 'utf8')
    ctx.assert.ok(toolRenderer.includes('collapseOpenDeepReasoningBlocks'), 'a new tool card should fold the current deep-reasoning body')
  }
}
