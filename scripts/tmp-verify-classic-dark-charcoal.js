const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')
const themeJs = fs.readFileSync(path.join(root, 'frontend/scripts/features/theme-settings.js'), 'utf8')
const tokens = fs.readFileSync(path.join(root, 'frontend/styles/tokens.css'), 'utf8')
const index = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8')
const sidebar = fs.readFileSync(path.join(root, 'frontend/styles/sidebar.css'), 'utf8')

if (!themeJs.includes('THEME_SCHEMA_VERSION = 5')) {
  throw new Error('主题 schema 应为 5')
}
if (themeJs.includes("accentPrimary: '#6366f1'") || themeJs.includes("bgBase: '#09090b'")) {
  throw new Error('经典深色不应再使用旧紫/纯黑配色')
}
if (!themeJs.includes("bgBase: '#181818'") || !themeJs.includes("userMessageBg: '#2f2f2f'")) {
  throw new Error('经典深色应为深炭灰分层灰')
}
if (!themeJs.includes('isLegacyClassicDark')) {
  throw new Error('应迁移已保存的旧经典深色')
}
if (!tokens.includes('--bg-base: #181818') || tokens.includes('--accent-primary: #06b6d4')) {
  throw new Error('tokens.css 首屏应变为炭灰，不能再闪青绿')
}
if (!index.includes('background:#181818') || index.includes('background:#09090b')) {
  throw new Error('设置页经典深色色卡应更新')
}
if (!sidebar.includes('.sidebar-theme-dot.default { background: #333333; }')) {
  throw new Error('侧栏主题圆点应为炭灰')
}

const cssVars = {}
const rootEl = {
  style: {
    setProperty(key, value) { cssVars[key] = value },
    removeProperty(key) { delete cssVars[key] }
  },
  classList: { add() {}, remove() {} },
  setAttribute() {},
  getAttribute() { return '' }
}

function createSandbox(stored) {
  Object.keys(cssVars).forEach(key => delete cssVars[key])
  const localStorage = {
    getItem() { return stored == null ? null : JSON.stringify(stored) },
    setItem() {},
    removeItem() {}
  }
  const documentRef = {
    documentElement: rootEl,
    querySelectorAll() { return [] },
    getElementById() { return null },
    dispatchEvent() {}
  }
  const sandbox = {
    window: { dispatchEvent() {} },
    document: documentRef,
    localStorage,
    requestAnimationFrame(cb) { cb() },
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail }
    }
  }
  sandbox.window.window = sandbox.window
  sandbox.window.document = documentRef
  sandbox.window.localStorage = localStorage
  sandbox.globalThis = sandbox
  vm.runInNewContext(themeJs, sandbox)
  return sandbox.window.ThemeSettings
}

const ThemeSettings = createSandbox(null)
const dark = ThemeSettings.presets.default
const expected = {
  bgBase: '#181818',
  bgPrimary: '#1e1e1e',
  bgSecondary: '#242424',
  sidebarBg: '#161616',
  sidebarActive: '#333333',
  accentPrimary: '#d0d0d0',
  userMessageBg: '#2f2f2f',
  inputBg: '#151515',
  textPrimary: '#e4e4e4'
}
for (const [key, value] of Object.entries(expected)) {
  if (String(dark[key]).toLowerCase() !== value) {
    throw new Error(`经典深色 ${key} 应为 ${value}，实际 ${dark[key]}`)
  }
}

ThemeSettings.applyTheme(dark)
if (cssVars['--bg-base'] !== '#181818') throw new Error('applyTheme 未写入炭灰背景')
if (cssVars['--accent-foreground'] !== '#181818') throw new Error('浅灰强调色上的文字应为深色')
if (!String(cssVars['--accent-gradient'] || '').includes('#d0d0d0')) {
  throw new Error('accent-gradient 应跟随炭灰强调色')
}
if (String(cssVars['--accent-secondary'] || '').toLowerCase() === '#8b5cf6') {
  throw new Error('经典深色不应残留紫色 secondary')
}

const graphite = ThemeSettings.presets.graphite
ThemeSettings.applyTheme({ ...graphite, _version: 4 })
if (cssVars['--bg-base'] !== graphite.bgBase) throw new Error('石墨青不应被经典深色迁移覆盖')
if (cssVars['--accent-primary'] !== graphite.accentPrimary) throw new Error('石墨青强调色应保持青绿')

ThemeSettings.applyTheme({
  _version: 4,
  bgBase: '#09090b',
  bgPrimary: '#111113',
  bgSecondary: '#18181b',
  bgTertiary: '#1f1f23',
  accentPrimary: '#6366f1',
  accentLight: '#818cf8',
  textPrimary: '#fafafa',
  textSecondary: '#a1a1aa',
  userMessageBg: '#6366f1',
  userMessageText: '#ffffff'
})
if (cssVars['--bg-base'] !== '#181818') throw new Error('旧经典深色应迁移到炭灰')
if (cssVars['--accent-primary'] !== '#d0d0d0') throw new Error('旧靛蓝强调色应迁移到浅灰')
if (cssVars['--user-message-bg'] !== '#2f2f2f') throw new Error('旧用户气泡应迁移到深灰胶囊')

ThemeSettings.applyTheme(ThemeSettings.presets.clean)
if (cssVars['--bg-base'] !== '#ffffff') throw new Error('清爽白不应被本次改动影响')

console.log('classic-dark-charcoal: palette/migrate/tokens OK')
