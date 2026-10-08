const fs = require('fs')
const path = require('path')
const vm = require('vm')

function createClassList(el) {
  return {
    contains(name) {
      return String(el.className || '').split(/\s+/).includes(name)
    },
    add(name) {
      const items = String(el.className || '').split(/\s+/).filter(Boolean)
      if (!items.includes(name)) items.push(name)
      el.className = items.join(' ')
    }
  }
}

function createNode(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    style: {},
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 480,
    offsetHeight: 200,
    _top: 0,
    setAttribute(name, value) {
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())
        this.dataset[key] = String(value)
      }
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      const nodes = child.tagName === 'FRAGMENT' ? [...child.children] : [child]
      for (const node of nodes) {
        node.parentNode?.removeChild?.(node)
        node.parentNode = this
        this.children.push(node)
      }
      this.firstChild = this.children[0] || null
      this.lastChild = this.children[this.children.length - 1] || null
      return child
    },
    insertBefore(child, before) {
      const nodes = child.tagName === 'FRAGMENT' ? [...child.children] : [child]
      const index = this.children.indexOf(before)
      for (const node of nodes) {
        node.parentNode?.removeChild?.(node)
        node.parentNode = this
        if (index < 0) this.children.push(node)
        else this.children.splice(this.children.indexOf(before), 0, node)
      }
      this.firstChild = this.children[0] || null
      this.lastChild = this.children[this.children.length - 1] || null
      return child
    },
    removeChild(child) {
      this.children = this.children.filter(item => item !== child)
      child.parentNode = null
      this.firstChild = this.children[0] || null
      this.lastChild = this.children[this.children.length - 1] || null
      return child
    },
    replaceChild(next, prev) {
      const index = this.children.indexOf(prev)
      next.parentNode = this
      prev.parentNode = null
      if (index < 0) this.children.push(next)
      else this.children[index] = next
      this.firstChild = this.children[0] || null
      this.lastChild = this.children[this.children.length - 1] || null
      return prev
    },
    querySelector(selector) {
      if (selector === '.message.user') {
        return this.children.find(child => String(child.className || '').includes('message') && String(child.className || '').includes('user')) || null
      }
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-turn-id]') {
        return this.children.filter(child => child.dataset && child.dataset.turnId != null)
      }
      return []
    },
    getBoundingClientRect() {
      let top = 0
      if (this.parentNode && Array.isArray(this.parentNode.children)) {
        for (const sibling of this.parentNode.children) {
          if (sibling === this) break
          const height = Number(String(sibling.style?.height || '').replace('px', '')) || sibling.offsetHeight || 200
          top += height
        }
        top -= this.parentNode.scrollTop || 0
      } else {
        top = this._top
      }
      const height = Number(String(this.style?.height || '').replace('px', '')) || this.offsetHeight || 200
      return { top, bottom: top + height, height }
    }
  }
  node.classList = createClassList(node)
  return node
}

function layout(container) {
  let top = 0
  for (const child of container.children) {
    child._top = top - container.scrollTop
    child.offsetHeight = Number(String(child.style.height || '').replace('px', '')) || child.offsetHeight || 200
    top += child.offsetHeight
  }
  container.scrollHeight = top
}

function loadScripts(root) {
  const rafQueue = []
  const timeouts = []
  const document = {
    createElement: createNode,
    createDocumentFragment() {
      const fragment = createNode('fragment')
      fragment.appendChild = function appendChild(child) {
        child.parentNode = this
        this.children.push(child)
        return child
      }
      return fragment
    }
  }
  const sandbox = {
    window: { ChatHistoryRanges: null, ChatVirtualScroller: null },
    document,
    console,
    requestAnimationFrame: callback => rafQueue.push(callback),
    cancelAnimationFrame() {},
    setTimeout: callback => {
      timeouts.push(callback)
      return timeouts.length
    },
    clearTimeout() {},
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  sandbox.window = Object.assign(sandbox.window, sandbox)
  vm.createContext(sandbox)
  for (const file of [
    'frontend/scripts/features/chat-history-ranges.js',
    'frontend/scripts/features/chat-virtual-scroller.js'
  ]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox)
  }
  return { sandbox, rafQueue, timeouts }
}

module.exports = {
  id: 'chat-history.virtual-scroller-sync',
  title: 'Virtual scroller prepends older rounds without wiping the current viewport',
  tags: ['chat-history', 'virtual-scroll', 'frontend'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/chat-virtual-scroller\.js$/i,
    /^frontend\/scripts\/features\/chat-history-ranges\.js$/i,
    /^frontend\/scripts\/features\/chat-history-paginator\.js$/i
  ],

  async run(ctx) {
    const source = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/chat-virtual-scroller.js'), 'utf8')
    ctx.assert.ok(
      /buildPlaceholdersInBatches\(generation, roundsData\.length, \(\) => \{\s*if \(isDestroyed \|\| generation !== resetGeneration\) return/.test(source),
      'stale virtual-scroller reset callbacks must not mount another project into the shared chat container'
    )
    const { sandbox, rafQueue } = loadScripts(ctx.root)
    const scroller = sandbox.window.ChatVirtualScroller
    const container = createNode()
    container.getBoundingClientRect = () => ({ top: 0, bottom: 480, height: 480 })

    const renderedKeys = []
    const renderer = {
      precomputeRounds(history) {
        return (history || []).filter(item => item.role === 'user').map((user, index) => ({
          isDivider: false,
          round: { user: { ...user, _historyIndex: index }, aiSteps: [] },
          interjectSteps: [],
          messageIndex: index,
          turnId: index + 1,
          hasAiContent: false
        }))
      },
      renderRound(roundData) {
        renderedKeys.push(sandbox.window.ChatHistoryRanges.getRoundKey(roundData))
        const frag = sandbox.document.createDocumentFragment()
        const user = createNode()
        user.className = 'message user'
        user.dataset.turnId = String(roundData.turnId)
        user.dataset.messageId = String(roundData.round.user.messageId || '')
        frag.appendChild(user)
        return frag
      }
    }

    const newerHistory = [
      { role: 'user', content: 'later-1', messageId: 'msg-2', time: '2' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'later-2', messageId: 'msg-3', time: '3' }
    ]
    scroller.reset({
      container,
      renderer,
      messagesHistory: newerHistory,
      scrollTo: 'bottom',
      eagerMountRounds: 2
    })
    while (rafQueue.length) rafQueue.shift()()
    layout(container)
    const childCountAfterReset = container.children.length
    const firstKeyAfterReset = container.children[0]?.dataset?.roundKey
    ctx.assert.ok(childCountAfterReset >= 2, 'initial virtual list should keep one node per loaded round')
    ctx.assert.equal(firstKeyAfterReset, 'user:msg-2', 'the newest loaded page should start at the first visible newer round')

    const fullHistory = [
      { role: 'user', content: 'old', messageId: 'msg-1', time: '1' },
      ...newerHistory
    ]
    const synced = scroller.syncHistory({
      messagesHistory: fullHistory,
      renderer
    })
    ctx.assert.equal(synced, true, 'prepending an older round should reuse the current virtual list')
    ctx.assert.equal(container.children.length, childCountAfterReset + 1, 'older history should insert one extra round instead of rebuilding')
    ctx.assert.equal(container.children[0].dataset.roundKey, 'user:msg-1', 'the older round should be inserted at the top')
    ctx.assert.equal(container.children[1].dataset.roundKey, 'user:msg-2', 'the previously visible round must keep the same identity')
    ctx.assert.ok(container.scrollTop > 0, 'scroll position should stay pinned to the previously visible round')

    scroller.destroy()
  }
}
