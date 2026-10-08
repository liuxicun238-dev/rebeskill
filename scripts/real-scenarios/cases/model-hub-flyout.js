const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'model-hub-flyout',
  title: 'Model hub keeps reasoning on the left and vendor-grouped models on the right',
  tags: ['frontend', 'models', 'layout'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/quick-model-settings\.js$/i,
    /^frontend\/styles\/modals\.css$/i,
    /^frontend\/styles\/input-area\.css$/i,
    /^frontend\/index\.html$/i
  ],

  async run(ctx) {
    const read = rel => fs.readFileSync(path.join(ctx.root, rel), 'utf8')
    const js = read('frontend/scripts/features/quick-model-settings.js')
    const css = read('frontend/styles/modals.css')
    const inputCss = read('frontend/styles/input-area.css')
    const html = read('frontend/index.html')

    ctx.assert.equal(
      (js.match(/renderModelSelect = function/g) || []).length,
      1,
      'only the hub renderer should own the model menu'
    )
    ctx.assert.ok(
      /activeFlyout === 'reasoning'[\s\S]*model-hub-flyout model-flyout-left/.test(js),
      'reasoning list must render as a left flyout'
    )
    ctx.assert.ok(
      /activeFlyout === 'models'[\s\S]*model-hub-flyout model-flyout-right/.test(js),
      'model vendor list must render as a right flyout'
    )
    ctx.assert.ok(
      /function getHubVendor\(/.test(js) && /function groupModelsByVendor\(/.test(js),
      'models must be grouped by vendor before they are listed'
    )
    ctx.assert.ok(
      /model-vendor-row/.test(js) && /model-vendor-models/.test(js),
      'hovering a vendor must reveal that vendor\'s models in a nested panel'
    )
    ctx.assert.ok(
      /activeFlyout = null\s+activeVendor = null\s+vendorListScrollTop = 0\s+renderModelSelect\(\)/.test(js),
      'opening the capsule must start from the compact master menu'
    )
    ctx.assert.ok(
      /function refreshVendorModelsPanel\(/.test(js) && /id="modelVendorList"/.test(js),
      'hovering a vendor must swap the nested model panel without rebuilding the vendor list'
    )
    ctx.assert.ok(
      /restoreVendorListScroll\(/.test(js),
      'full rerender must restore the vendor list scroll position'
    )
    ctx.assert.ok(
      /model-flyout-left\s*\{[\s\S]*right:\s*calc\(100% \+ 8px\)/.test(css),
      'left flyout must sit to the left of the master menu'
    )
    ctx.assert.ok(
      /model-flyout-right\s*\{[\s\S]*left:\s*calc\(100% \+ 8px\)/.test(css),
      'right flyout must sit to the right of the master menu'
    )
    ctx.assert.ok(
      /max-width:\s*228px/.test(css) && !/min-width:\s*360px/.test(css),
      'master menu must stay compact instead of stretching to wrap the list'
    )
    ctx.assert.ok(
      /\.model-menu-search\s*\{[\s\S]*line-height:\s*32px/.test(css),
      'search text must share the input height so placeholder glyphs are not sliced'
    )
    ctx.assert.ok(!/model-hub-row[\s\S]{0,80}速度/.test(js), 'speed row must stay removed')
    ctx.assert.ok(
      /模型管理/.test(js) && /function openModelSettingsPage\(/.test(js) && /settingsTabModel/.test(js),
      'master footer must be 模型管理 and open the model settings page'
    )
    ctx.assert.ok(
      /id="modelHubManage">\s*<span class="model-hub-row-label">模型管理<\/span>\s*<\/div>/.test(js),
      '模型管理 must not show a chevron'
    )
    ctx.assert.ok(
      /--hub-bg:\s*var\(--bg-elevated\)/.test(css) &&
      /background:\s*var\(--hub-bg\)/.test(css) &&
      !/\.model-hub-flyout[\s\S]{0,280}background:\s*#2c2c2e/.test(css),
      'hub surfaces must follow theme tokens instead of a fixed dark gray'
    )
    ctx.assert.ok(
      /placeholder="搜索模型\.\.\."/.test(js) && !/新增自定义模型/.test(js),
      'model flyout must keep search and drop add-custom-model'
    )
    ctx.assert.ok(
      /getHubReasoningItems\(\)[\s\S]*轻度[\s\S]*极高/.test(js),
      'reasoning flyout must match 轻度/中/高/极高'
    )
    ctx.assert.ok(
      /\.model-hub-row:hover[\s\S]*--hub-hover/.test(css),
      'hover state must use the reference gray pill, not a blue border'
    )
    ctx.assert.ok(
      /::-webkit-scrollbar-button\s*\{[\s\S]*display:\s*none/.test(css),
      'native scrollbar buttons must not poke into the search field'
    )
    ctx.assert.ok(
      /max-height:\s*calc\(var\(--hub-row-h\) \* 5\)/.test(css),
      'lists must show about five rows before scrolling'
    )
    ctx.assert.ok(
      /\.chat-input-footer\s*\{[\s\S]*overflow:\s*visible/.test(inputCss),
      'footer must not clip the side flyout'
    )
    ctx.assert.match(html, /modals\.css\?v=20260829-hub-theme/)
    ctx.assert.match(html, /quick-model-settings\.js\?v=20260829-hub-theme/)
  }
}
