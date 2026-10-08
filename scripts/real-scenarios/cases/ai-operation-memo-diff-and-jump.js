const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'chat.memo-diff-and-jump',
  title: 'Memo rail keeps category color, locates distant turns, and opens real change-session diffs',
  tags: ['chat', 'memo', 'diff', 'change-session'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/ai-operation-memo-rail\.js$/i,
    /^frontend\/styles\/ai-operation-memo\.css$/i,
    /^frontend\/scripts\/features\/window-tabs\.js$/i,
    /^frontend\/scripts\/app\.js$/i,
    /^electron\/modules\/tool-handlers\/ai-operation-memo\.js$/i,
    /^electron\/modules\/ai-operation-memos\/collector\.js$/i,
    /^electron\/modules\/projects\.js$/i,
    /^electron\/preload\.js$/i
  ],

  async run(ctx) {
    const read = rel => fs.readFileSync(path.join(ctx.root, rel), 'utf8')
    const rail = read('frontend/scripts/features/ai-operation-memo-rail.js')
    const css = read('frontend/styles/ai-operation-memo.css')
    const tabs = read('frontend/scripts/features/window-tabs.js')
    const app = read('frontend/scripts/app.js')
    const handler = read('electron/modules/tool-handlers/ai-operation-memo.js')
    const collector = read('electron/modules/ai-operation-memos/collector.js')
    const projects = read('electron/modules/projects.js')
    const preload = read('electron/preload.js')

    ctx.assert.match(css, /--memo-tick-color/)
    ctx.assert.match(css, /\.ai-memo-chat-rail:hover \.ai-memo-chat-tick/)
    ctx.assert.ok(
      !/\.ai-memo-chat-tick\.category-feat\s*\{[^}]*--memo-tick-color:\s*#3b82f6/.test(css),
      'category colors should stay hidden until the rail is hovered'
    )
    ctx.assert.ok(
      !/\.ai-memo-chat-rail-list\.is-wave-active \.ai-memo-chat-node::before[\s\S]{0,120}--text-primary/.test(css),
      'hover/wave must not wash memo ticks to the primary text color'
    )
    ctx.assert.match(rail, /center\.insertBefore\(rail, chatMessages\)/)
    ctx.assert.match(rail, /async function openItemDiff/)
    ctx.assert.match(rail, /window\.api\.getChangeSession/)
    ctx.assert.ok(
      !/window\.openSummaryFileDiff/.test(rail),
      'memo diffs must not open a fake summary element that drops snapshot text'
    )
    ctx.assert.match(rail, /async function jumpToChatSession/)
    ctx.assert.match(rail, /locateChatHistoryTurn/)
    ctx.assert.ok(
      !/该对话轮次可能已被折叠或在更远历史中/.test(rail),
      'distant turns must be looked up in chat history instead of showing a false folded-turn toast'
    )
    ctx.assert.match(handler, /getChangeSession\(ctx\.projectId, sessionId, \{ includeContent: true \}\)/)
    ctx.assert.match(collector, /file\.additions \|\| file\.added/)
    ctx.assert.match(projects, /locate-chat-history-turn/)
    ctx.assert.match(preload, /locateChatHistoryTurn/)
    ctx.assert.match(app, /window\.jumpToChatHistoryEntry = jumpToHistoryEntry/)
    ctx.assert.match(tabs, /暂无改动对比/)
    ctx.assert.ok(!/Diff text is not available/.test(tabs), 'empty diffs should use Chinese fallback copy')
  }
}
