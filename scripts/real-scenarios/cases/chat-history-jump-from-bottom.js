const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'chat-history.jump-from-bottom',
  title: 'History jump must unstick from bottom so the viewport stays on the target',
  tags: ['chat-history', 'scroll', 'frontend'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/chat-renderer\.js$/i,
    /^frontend\/scripts\/features\/chat-virtual-scroller\.js$/i,
    /^frontend\/scripts\/features\/chat-history\.js$/i,
    /^frontend\/scripts\/app\.js$/i
  ],

  async run(ctx) {
    const read = rel => fs.readFileSync(path.join(ctx.root, rel), 'utf8')
    const renderer = read('frontend/scripts/features/chat-renderer.js')
    const scroller = read('frontend/scripts/features/chat-virtual-scroller.js')
    const history = read('frontend/scripts/features/chat-history.js')
    const app = read('frontend/scripts/app.js')

    ctx.assert.ok(
      /const markEscaped = \(\) => \{[\s\S]*escaped = true/.test(renderer),
      'sticky tracker must expose an explicit unstick for history jumps'
    )
    ctx.assert.ok(
      /markEscaped\(container\) \{[\s\S]*container\.__stickyBottom\?\.markEscaped/.test(renderer),
      'ChatStickyBottom.markEscaped must reach the container tracker'
    )

    const jumpFn = app.slice(
      app.indexOf('function jumpToTurnByUserIndex'),
      app.indexOf('async function jumpToHistoryEntry')
    )
    ctx.assert.ok(
      /ChatStickyBottom\?\.markEscaped\?\.\(chatMessages\)/.test(jumpFn),
      'history panel jumps must unstick before rebuilding the virtual list'
    )

    const jumpTarget = scroller.slice(
      scroller.indexOf('function jumpToTarget'),
      scroller.indexOf('function appendMessage')
    )
    ctx.assert.ok(
      /ChatStickyBottom\?\.markEscaped\?\.\(container\)/.test(jumpTarget),
      'virtual scroller target jump must unstick before scrollIntoView'
    )

    ctx.assert.ok(
      /ChatStickyBottom\?\.markEscaped/.test(history),
      'fallback highlight scroll must also unstick so a bottom viewport cannot snap back'
    )
  }
}
