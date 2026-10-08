const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'settings.window-size-personalization',
  title: 'Personalization exposes default and wide main-window size presets',
  tags: ['settings', 'window', 'personalization'],
  changedFilePatterns: [
    /^electron\/modules\/windows\.js$/i,
    /^electron\/modules\/storage-config\.js$/i,
    /^electron\/preload\.js$/i,
    /^frontend\/index\.html$/i,
    /^frontend\/scripts\/features\/window-size-settings\.js$/i,
    /^frontend\/styles\/settings\.css$/i
  ],

  async run(ctx) {
    const storage = require(path.join(ctx.root, 'electron/modules/storage-config'))
    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const preload = fs.readFileSync(path.join(ctx.root, 'electron/preload.js'), 'utf8')
    const windowsSource = fs.readFileSync(path.join(ctx.root, 'electron/modules/windows.js'), 'utf8')
    const storageSource = fs.readFileSync(path.join(ctx.root, 'electron/modules/storage-config.js'), 'utf8')
    const settingsJs = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/window-size-settings.js'), 'utf8')
    const settingsCss = fs.readFileSync(path.join(ctx.root, 'frontend/styles/settings.css'), 'utf8')

    ctx.assert.match(windowsSource, /MAIN_WINDOW_DEFAULT_WIDTH = 1295/)
    ctx.assert.match(windowsSource, /MAIN_WINDOW_DEFAULT_HEIGHT = 918/)
    ctx.assert.match(windowsSource, /MAIN_WINDOW_WIDE_WIDTH = 1280/)
    ctx.assert.match(windowsSource, /MAIN_WINDOW_WIDE_HEIGHT = 800/)
    ctx.assert.match(windowsSource, /id: 'default'/)
    ctx.assert.match(windowsSource, /id: 'wide'/)
    ctx.assert.match(windowsSource, /MAIN_WINDOW_SIZE_PRESETS\[id\] \|\| MAIN_WINDOW_SIZE_PRESETS\.default/)

    ctx.assert.equal(storage.normalizeWindowSizeConfig({}).preset, 'default')
    ctx.assert.equal(storage.normalizeWindowSizeConfig({ preset: 'wide' }).preset, 'wide')
    ctx.assert.equal(storage.normalizeWindowSizeConfig({ preset: 'huge' }).preset, 'default')

    ctx.assert.match(html, /id="windowSizeGrid"/)
    ctx.assert.match(html, /data-window-size="default"/)
    ctx.assert.match(html, /data-window-size="wide"/)
    ctx.assert.match(html, /window-size-heading/)
    ctx.assert.match(html, /window-size-settings\.js\?v=20260828-window-size/)
    ctx.assert.match(settingsCss, /\.window-size-grid\s*\{/)
    ctx.assert.match(settingsCss, /\.window-size-card\.active\s*\{/)
    ctx.assert.match(preload, /getWindowSizeConfig:\s*\(\) => ipcRenderer\.invoke\('window:get-size-config'\)/)
    ctx.assert.match(preload, /setWindowSizePreset:\s*\(presetId\) => ipcRenderer\.invoke\('window:set-size-preset', presetId\)/)
    ctx.assert.match(windowsSource, /ipcMain\.handle\('window:set-size-preset'/)
    ctx.assert.match(windowsSource, /getStoredWindowSizePreset\(\)/)
    ctx.assert.match(storageSource, /function saveWindowSizeConfig/)
    ctx.assert.match(settingsJs, /setWindowSizePreset\(preset\)/)
  }
}
