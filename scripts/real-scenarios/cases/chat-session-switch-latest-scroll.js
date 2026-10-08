const fs = require('fs')
const path = require('path')
const vm = require('vm')

module.exports = {
  id: 'chat-session-switch.latest-scroll',
  title: 'Completed chat session switches settle at the latest message',
  tags: ['chat-history', 'session-switch', 'frontend'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/chat-session-scroll-restorer\.js$/i,
    /^frontend\/scripts\/features\/project-switcher\.js$/i,
    /^frontend\/scripts\/features\/project-chat-session-handlers\.js$/i,
    /^frontend\/scripts\/app\.js$/i,
    /^frontend\/index\.html$/i
  ],

  async run(ctx) {
    const source = fs.readFileSync(
      path.join(ctx.root, 'frontend/scripts/features/chat-session-scroll-restorer.js'),
      'utf8'
    )
    const sessionHandlerSource = fs.readFileSync(
      path.join(ctx.root, 'frontend/scripts/features/project-chat-session-handlers.js'),
      'utf8'
    )
    const indexSource = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const rendererSource = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/chat-renderer.js'), 'utf8')
    const handlerScriptIndex = indexSource.indexOf('scripts/features/project-chat-session-handlers.js')
    const appScriptIndex = indexSource.indexOf('scripts/app.js')
    ctx.assert.ok(
      indexSource.includes('scripts/features/chat-session-scroll-restorer.js'),
      'the session scroll restorer must load before app initialization'
    )
    ctx.assert.ok(
      handlerScriptIndex >= 0 && appScriptIndex > handlerScriptIndex,
      'chat session handlers must load before app.js so bind can wire window.handle* helpers'
    )
    ctx.assert.ok(
      /handleSwitchProjectChatSession[\s\S]*ChatSessionScrollRestorer\?\.schedule/.test(sessionHandlerSource),
      'completed project chat session switches must invoke the scroll restorer'
    )
    const switchStart = sessionHandlerSource.indexOf('async function handleSwitchProjectChatSession')
    const switchEnd = sessionHandlerSource.indexOf('async function handleDeleteProjectChatSession', switchStart)
    const switchSource = sessionHandlerSource.slice(switchStart, switchEnd)
    ctx.assert.ok(
      switchSource.includes('isVisibleChatAlreadyOnSession') &&
        switchSource.indexOf('return') < switchSource.indexOf('window.api.switchProjectChatSession') &&
        switchSource.includes('ChatSessionScrollRestorer?.schedule'),
      'clicking the already-visible session must return before history reload; real switches still settle at latest'
    )
    const restoreStart = rendererSource.indexOf('function restoreChatHistory')
    const dividerStart = rendererSource.indexOf('if (round.divider)', restoreStart)
    const dividerOpen = rendererSource.indexOf('{', dividerStart)
    let dividerEnd = -1
    let braceDepth = 0
    for (let index = dividerOpen; index < rendererSource.length; index++) {
      if (rendererSource[index] === '{') braceDepth += 1
      if (rendererSource[index] === '}') braceDepth -= 1
      if (braceDepth === 0) {
        dividerEnd = index
        break
      }
    }
    const ordinaryUserRender = rendererSource.indexOf(
      'addUserMessage(round.user.displayContent || round.user.content',
      dividerStart
    )
    ctx.assert.ok(
      restoreStart >= 0 && dividerStart >= 0 && dividerEnd > dividerStart && ordinaryUserRender > dividerEnd,
      'paged history rendering must render ordinary user messages outside the divider branch'
    )
    const rafQueue = []
    const timeoutQueue = []
    const clearedTimers = new Set()
    let nextTimer = 1
    let activeProject = { id: 'project-a', chatSessionId: 'session-a', isRunning: false }
    const forceCalls = []
    const sandbox = {
      window: {
        ChatStickyBottom: {
          forceStick(container) {
            container.scrollTop = container.scrollHeight
            forceCalls.push({ sessionId: activeProject.chatSessionId, top: container.scrollTop })
          }
        }
      },
      requestAnimationFrame(callback) {
        rafQueue.push(callback)
      },
      setTimeout(callback) {
        const id = nextTimer++
        timeoutQueue.push({ id, callback })
        return id
      },
      clearTimeout(id) {
        clearedTimers.add(id)
      }
    }
    vm.createContext(sandbox)
    vm.runInContext(source, sandbox)

    const restorer = sandbox.window.ChatSessionScrollRestorer
    const container = { scrollTop: 0, scrollHeight: 1200 }
    restorer.schedule({
      container,
      projectId: 'project-a',
      sessionId: 'session-a',
      getActiveProject: () => activeProject,
      isProjectRunning: project => project.isRunning
    })
    ctx.assert.equal(container.scrollTop, 1200, 'session switch should immediately move to the latest message')

    container.scrollHeight = 1800
    while (rafQueue.length) rafQueue.shift()()
    ctx.assert.equal(container.scrollTop, 1800, 'layout-frame growth should be corrected back to the latest message')

    activeProject = { id: 'project-a', chatSessionId: 'session-b', isRunning: false }
    const callsBeforeStaleFrame = forceCalls.length
    rafQueue.push(() => restorer.schedule({
      container,
      projectId: 'project-a',
      sessionId: 'session-a',
      getActiveProject: () => activeProject,
      isProjectRunning: project => project.isRunning
    }))
    while (rafQueue.length) rafQueue.shift()()
    ctx.assert.equal(forceCalls.length, callsBeforeStaleFrame, 'a callback targeting an inactive session must not move the viewport')

    container.scrollHeight = 2400
    restorer.schedule({
      container,
      projectId: 'project-a',
      sessionId: 'session-b',
      getActiveProject: () => activeProject,
      isProjectRunning: project => project.isRunning
    })
    const callsAfterSecondSwitch = forceCalls.length
    for (const timer of timeoutQueue) {
      if (!clearedTimers.has(timer.id)) timer.callback()
    }
    ctx.assert.ok(forceCalls.length > callsAfterSecondSwitch, 'current session should keep settling after delayed content growth')
    ctx.assert.ok(forceCalls.slice(callsAfterSecondSwitch).every(call => call.sessionId === 'session-b'), 'stale session callbacks must not move the new session')

    activeProject.isRunning = true
    const callsBeforeRunningGuard = forceCalls.length
    restorer.schedule({
      container,
      projectId: 'project-a',
      sessionId: 'session-b',
      getActiveProject: () => activeProject,
      isProjectRunning: project => project.isRunning
    })
    ctx.assert.equal(forceCalls.length, callsBeforeRunningGuard, 'running sessions should retain their existing follow behavior')

    const switcherSource = fs.readFileSync(
      path.join(ctx.root, 'frontend/scripts/features/project-switcher.js'),
      'utf8'
    )
    const switcherSandbox = {
      window: {
        RunningUiRestore: {
          currentSessionId(project) { return String(project?.chatSessionId || 'main') },
          findLiveRunningAiMsg() { return null }
        },
        ChatVirtualScroller: { isActive() { return false } }
      },
      document: {},
      requestAnimationFrame(callback) { callback() },
      console
    }
    vm.createContext(switcherSandbox)
    vm.runInContext(switcherSource, switcherSandbox)
    const chatEl = {
      dataset: { projectId: 'project-a', chatSessionId: 'session-a' },
      childElementCount: 2,
      querySelector() { return null }
    }
    switcherSandbox.window.ProjectSwitcher.bind({ getChatMessages: () => chatEl })
    const already = switcherSandbox.window.ProjectSwitcher.isVisibleChatAlreadyOnSession
    ctx.assert.equal(
      already({ id: 'project-a', chatSessionId: 'session-a', messagesHistory: [{ role: 'user' }] }, 'session-a'),
      true,
      'visible matching session should be treated as already on screen'
    )
    ctx.assert.equal(
      already({ id: 'project-a', chatSessionId: 'session-a', messagesHistory: [{ role: 'user' }] }, 'session-b'),
      false,
      'a different session must still go through history reload'
    )
    chatEl.childElementCount = 0
    ctx.assert.equal(
      already({ id: 'project-a', chatSessionId: 'session-a', messagesHistory: [{ role: 'user' }] }, 'session-a'),
      false,
      'matching identity with history but empty chat DOM must reload to recover'
    )
  }
}
