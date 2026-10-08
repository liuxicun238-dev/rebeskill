const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'ui.titlebar-no-file-edit-menu',
  title: 'Titlebar no longer shows File or Edit menus',
  tags: ['titlebar', 'ui'],
  changedFilePatterns: [
    /^frontend\/index\.html$/i
  ],

  async run(ctx) {
    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const titlebar = html.slice(html.indexOf('class="titlebar"'), html.indexOf('class="titlebar-controls"'))

    ctx.assert.ok(titlebar.includes('id="menuBrand"'), 'brand menu should remain')
    ctx.assert.ok(!titlebar.includes('id="menuFile"'), 'File menu must be removed from the titlebar')
    ctx.assert.ok(!titlebar.includes('id="menuEdit"'), 'Edit menu must be removed from the titlebar')
    ctx.assert.ok(!titlebar.includes('data-i18n="menu.file"'), 'File label must not remain in the titlebar')
    ctx.assert.ok(!titlebar.includes('data-i18n="menu.edit"'), 'Edit label must not remain in the titlebar')
    ctx.assert.ok(!html.includes('文件菜单支持导入和导出'), 'settings help must not still point at the File menu')
  }
}
