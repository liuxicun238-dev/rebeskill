const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8')
const css = fs.readFileSync(path.join(root, 'frontend/styles/layout.css'), 'utf8')
const js = fs.readFileSync(path.join(root, 'frontend/scripts/features/chat-toolbar-context.js'), 'utf8')
const app = fs.readFileSync(path.join(root, 'frontend/scripts/app.js'), 'utf8')

const left = html.slice(html.indexOf('id="chatToolbarContext"'), html.indexOf('id="canvasToolbarTitle"'))
const right = html.slice(html.indexOf('class="chat-toolbar-right"'), html.indexOf('id="toolbarBrowserBtn"'))

if (left.includes('data-tab="work"')) throw new Error('画布入口不应再留在聊天顶栏左侧')
if (!left.includes('id="chatSessionTitle"') || !left.includes('id="chatProjectPill"') || !left.includes('id="chatToolbarExplorerBtn"')) {
  throw new Error('左侧应包含会话标题、项目胶囊和资源管理器入口')
}
if (right.includes('data-tab="work"') || right.includes('chat-toolbar-canvas-btn')) {
  throw new Error('聊天顶栏不应再常驻画布入口，画布只从气泡里的「在画布打开」进入')
}
if (!css.includes('.chat-project-pill') || !css.includes('.chat-explorer-btn') || !css.includes('.chat-session-title')) {
  throw new Error('layout.css 缺少顶栏新组件样式')
}
if (!app.includes('ChatToolbarContext?.refresh')) {
  throw new Error('项目切换/列表刷新应同步聊天顶栏')
}

const sandbox = { window: {}, document: { readyState: 'complete', addEventListener() {}, getElementById() { return null } } }
sandbox.window.window = sandbox.window
sandbox.window.document = sandbox.document
vm.runInNewContext(js, sandbox)
const api = sandbox.window.ChatToolbarContext
if (!api || api.TITLE_MAX !== 14) throw new Error('标题截断长度应为十几个字符')

const long = '这是一段很长的用户对话内容用来测试截断显示是否生效'
const truncated = api.truncateTitle(long)
if (truncated !== '这是一段很长的用户对话内容用...' || truncated.replace('...', '').length !== 14) {
  throw new Error('长标题应截断为前 14 个字符: ' + truncated)
}

const title = api.sessionTitle({
  history: [
    { role: 'assistant', content: '先忽略助手' },
    { role: 'user', hidden: true, content: '隐藏消息' },
    { role: 'user', content: '  请给此项目增加一个如图所示的主题配色  ' }
  ],
  name: '灵犀-05'
})
if (title !== '请给此项目增加一个如图所示的主题配色') {
  throw new Error('标题应取当前会话第一条可见用户消息: ' + title)
}

console.log('chat-toolbar-context: layout/title/explorer OK')
