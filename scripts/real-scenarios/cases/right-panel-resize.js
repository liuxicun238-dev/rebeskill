const fs = require('fs')
const path = require('path')
const vm = require('vm')

function loadLayoutUI(root) {
  const source = fs.readFileSync(path.join(root, 'frontend/scripts/features/layout-ui.js'), 'utf8')
  const windowObj = {
    innerWidth: 1295,
    localStorage: {
      store: Object.create(null),
      getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null },
      setItem(key, value) { this.store[key] = String(value) },
      removeItem(key) { delete this.store[key] }
    },
    addEventListener() {}
  }
  const sandbox = {
    window: windowObj,
    document: {
      documentElement: {
        style: { setProperty() {}, removeProperty() {} },
        classList: { add() {}, remove() {}, contains() { return false }, toggle() {} }
      },
      addEventListener() {}
    },
    requestAnimationFrame() { return 0 },
    cancelAnimationFrame() {}
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return sandbox.window.LayoutUI
}

module.exports = {
  id: 'right-panel-resize',
  title: 'Right preview panel can be dragged and remembers width',
  tags: ['frontend', 'layout', 'webview'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/layout-ui\.js$/i,
    /^frontend\/styles\/layout\.css$/i,
    /^frontend\/scripts\/app\.js$/i,
    /^frontend\/index\.html$/i,
    /^frontend\/i18n\/modules\/zh\/auto\.js$/i,
    /^frontend\/i18n\/modules\/en\/auto\.js$/i
  ],

  async run(ctx) {
    const read = rel => fs.readFileSync(path.join(ctx.root, rel), 'utf8')
    const layoutUi = read('frontend/scripts/features/layout-ui.js')
    const app = read('frontend/scripts/app.js')
    const css = read('frontend/styles/layout.css')
    const html = read('frontend/index.html')
    const zh = read('frontend/i18n/modules/zh/auto.js')
    const en = read('frontend/i18n/modules/en/auto.js')
    const LayoutUI = loadLayoutUI(ctx.root)

    ctx.assert.equal(
      LayoutUI.widthFromRightDividerDrag(760, 500, 400, 1295),
      860,
      'dragging the divider left must widen the right panel'
    )
    ctx.assert.equal(
      LayoutUI.widthFromRightDividerDrag(760, 500, 600, 1295),
      660,
      'dragging the divider right must narrow the right panel'
    )
    ctx.assert.equal(
      LayoutUI.clampRightPanelWidth(100, 1295),
      360,
      'panel width must not shrink below 360px'
    )
    ctx.assert.equal(
      LayoutUI.clampRightPanelWidth(2000, 1295),
      935,
      'panel width must leave at least 360px for chat'
    )

    ctx.assert.ok(!/fixedWidth:\s*760/.test(app), 'app.js must not lock the divider to 760px')
    ctx.assert.ok(
      /--lingxi-right-panel-width/.test(css) && /--lingxi-right-panel-width/.test(layoutUi),
      'CSS and layout-ui must share --lingxi-right-panel-width'
    )
    ctx.assert.ok(
      /html:not\(\.right-panel-custom-width\)/.test(css),
      'wide screens must not auto-grow a user-resized panel'
    )
    ctx.assert.ok(
      /\.webview-panel\.expand-left\s*\{[\s\S]*flex:\s*1 1 100%\s*!important/.test(css),
      'full-width expand must still override custom width'
    )
    ctx.assert.ok(
      /html\.is-resizing-right-panel/.test(css),
      'dragging must disable layout transitions'
    )
    ctx.assert.ok(
      /lingxi\.rightPanelWidth/.test(layoutUi) && /persistRightPanelWidth/.test(layoutUi),
      'resized width must be remembered'
    )
    ctx.assert.ok(
      /DRAG_THRESHOLD_PX/.test(layoutUi),
      'a click without dragging must not lock the current width'
    )

    ctx.assert.match(html, /data-i18n="auto\.l258">预览</)
    ctx.assert.match(zh, /"auto\.l258":\s*"预览"/)
    ctx.assert.match(en, /"auto\.l258":\s*"Preview"/)
  }
}
