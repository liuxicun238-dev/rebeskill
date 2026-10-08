const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'open-source.remote-control-removed',
  title: 'The open-source build contains no remote-control bridge',
  tags: ['open-source', 'remote-control', 'security'],
  changedFilePatterns: [
    /^electron\/main\.js$/i,
    /^electron\/preload\.js$/i,
    /^electron\/modules\/ipc\.js$/i,
    /^electron\/modules\/remote-bridge\//i,
    /^frontend\/.*remote-bridge/i
  ],

  async run(ctx) {
    const removedPaths = [
      'electron/modules/remote-bridge',
      'frontend/styles/remote-bridge.css',
      'frontend/scripts/features/remote-bridge-ui.js',
      'frontend/scripts/libs/qrcode.js'
    ]
    removedPaths.forEach(relativePath => {
      const target = path.join(ctx.root, relativePath)
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        const files = []
        const visit = directory => fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
          const fullPath = path.join(directory, entry.name)
          if (entry.isDirectory()) visit(fullPath)
          else files.push(fullPath)
        })
        visit(target)
        ctx.assert.deepEqual(files, [], `${relativePath} must contain no runtime files`)
      } else {
        ctx.assert.equal(fs.existsSync(target), false, `${relativePath} must be removed`)
      }
    })

    const runtimeFiles = [
      'electron/main.js',
      'electron/preload.js',
      'electron/modules/ipc.js',
      'electron/modules/ai-chat.js',
      'electron/modules/git.js',
      'electron/modules/projects.js',
      'frontend/index.html',
      'frontend/scripts/features/panel-manager.js',
      'frontend/scripts/features/project-switcher.js',
      'frontend/scripts/features/project-state-helpers.js'
    ]
    const forbidden = /remote-bridge|remoteBridge|remote-user-message|远程遥控|远程控制/i
    runtimeFiles.forEach(relativePath => {
      const content = fs.readFileSync(path.join(ctx.root, relativePath), 'utf8')
      ctx.assert.equal(forbidden.test(content), false, `${relativePath} still references remote control`)
    })
  }
}
