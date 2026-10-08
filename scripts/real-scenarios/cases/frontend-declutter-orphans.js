const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'frontend.declutter-orphans',
  title: 'Orphan settings shell is gone and workspace clutter stays out of source root',
  tags: ['frontend', 'settings', 'declutter'],
  changedFilePatterns: [
    /^frontend\/index\.html$/i,
    /^frontend\/scripts\/features\/desktop-pet-settings\.js$/i,
    /^frontend\/scripts\/features\/settings-v2-shell\.js$/i,
    /^frontend\/styles\/settings\.css$/i,
    /^\.gitignore$/i,
    /^开发指南\.md$/i,
    /^docs\/resource-center-design\.md$/i,
    /^docs\/design-qa\.md$/i,
    /^scripts\/diagnostics\//i,
    /^electron\/modules\/fs-helpers\.js$/i,
    /^electron\/modules\/logger\.js$/i,
    /^electron\/modules\/chatgpt-web-search\//i,
    /^frontend\/scripts\/app\.js$/i,
    /^frontend\/scripts\/ui\/dialog\.js$/i,
    /^frontend\/scripts\/features\/project-init\.js$/i,
    /^frontend\/scripts\/features\/ai-file-reference\.js$/i,
    /^frontend\/scripts\/features\/send-interrupt-queue\.js$/i,
    /^frontend\/scripts\/features\/change-session-actions\.js$/i,
    /^frontend\/scripts\/features\/ai-operation-memo-rail\.js$/i,
    /^frontend\/scripts\/features\/git-panel\.js$/i,
    /^frontend\/scripts\/features\/message-sender\.js$/i,
    /^frontend\/scripts\/features\/titlebar-actions\.js$/i,
    /^frontend\/scripts\/features\/window-tabs\.js$/i,
    /^frontend\/scripts\/features\/browser-settings\.js$/i,
    /^frontend\/scripts\/features\/feature-settings\.js$/i,
    /^frontend\/styles\/modals\.css$/i
  ],

  async run(ctx) {
    const indexSource = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const settingsCss = fs.readFileSync(path.join(ctx.root, 'frontend/styles/settings.css'), 'utf8')
    const gitignore = fs.readFileSync(path.join(ctx.root, '.gitignore'), 'utf8')
    const guide = fs.readFileSync(path.join(ctx.root, '开发指南.md'), 'utf8')
    const petPath = path.join(ctx.root, 'frontend/scripts/features/desktop-pet-settings.js')
    const v2Path = path.join(ctx.root, 'frontend/scripts/features/settings-v2-shell.js')

    ctx.assert.equal(fs.existsSync(v2Path), false, 'unwired settings-v2-shell.js must not remain in features')
    ctx.assert.equal(indexSource.includes('settings-v2-shell.js'), false, 'index.html must not load the deleted v2 shell')
    ctx.assert.equal(settingsCss.includes('settings-v2-nav-group'), false, 'settings CSS must not keep v2-only aliases')

    ctx.assert.ok(fs.existsSync(petPath), 'desktop pet settings module must remain')
    ctx.assert.ok(
      indexSource.includes('scripts/features/desktop-pet-settings.js'),
      'desktop pet settings UI must load because the theme pane already exposes the controls'
    )
    ctx.assert.ok(
      indexSource.includes('id="desktopPetEnabled"'),
      'desktop pet controls stay in the settings pane'
    )

    ctx.assert.ok(/\ndata\/\s*$/m.test(gitignore) || gitignore.includes('\ndata/\n'), 'runtime data/ must stay out of git')
    ctx.assert.ok(gitignore.includes('.aimap.json'), 'root MCP cache must stay out of git')
    ctx.assert.ok(
      !guide.includes('electron/                 # 后端') && guide.includes('README.md'),
      '开发指南.md must point at README instead of duplicating the architecture dump'
    )
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'DESIGN.md')), false, 'root DESIGN.md must move into docs/')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'design-qa.md')), false, 'root design-qa.md must move into docs/')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'docs/resource-center-design.md')), 'resource-center design notes live in docs/')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'docs/design-qa.md')), 'design QA notes live in docs/')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'cdp-test.js')), false, 'CDP probe must not stay in the source root')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'launch.bat')), false, 'redundant launch.bat must not stay in the source root')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'scripts/diagnostics/cdp-test.js')), 'CDP probe belongs under scripts/diagnostics/')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, '开发模式启动.bat')), 'the Chinese development launcher stays')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'electron/modules/fs-helpers.js')), false, 'unused electron fs-helpers.js must be gone')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'electron/modules/logger.js')), false, 'unused electron logger.js must be gone')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'electron/modules/chatgpt-web-search/in-page-runner.js')), false, 'legacy ChatGPT in-page runner must be gone')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'electron/modules/chatgpt-web-search/node-runner.js')), 'protocol-direct ChatGPT search runner stays')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'electron/modules/agent-workflow.js')), 'diagnostic agent-workflow.js stays for tests')

    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'frontend/scripts/ui/dialog.js')), 'LingxiDialog module must exist')
    ctx.assert.ok(
      /scripts\/ui\/dialog\.js/.test(indexSource) &&
      indexSource.indexOf('scripts/ui/dialog.js') < indexSource.indexOf('scripts/app.js'),
      'index.html must load LingxiDialog before app.js'
    )
    const dialogSource = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/ui/dialog.js'), 'utf8')
    ctx.assert.ok(dialogSource.includes('window.LingxiDialog = { show }'), 'LingxiDialog.show is the shared confirm/list-picker entry')
    ctx.assert.ok(dialogSource.includes("event.key === 'Escape'"), 'LingxiDialog must close on Escape')
    ctx.assert.ok(dialogSource.includes("event.key !== 'Enter'"), 'LingxiDialog must accept Enter')
    ctx.assert.ok(dialogSource.includes("getElementById('inputBox')"), 'closing a dialog must return focus to the composer')

    const productionJsRoot = path.join(ctx.root, 'frontend/scripts')
    const confirmHits = []
    const walkJs = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walkJs(full)
          continue
        }
        if (!entry.name.endsWith('.js')) continue
        const source = fs.readFileSync(full, 'utf8')
        if (source.includes('window.confirm(') || source.includes('window.confirm?.(')) {
          confirmHits.push(path.relative(ctx.root, full).replace(/\\/g, '/'))
        }
      }
    }
    walkJs(productionJsRoot)
    ctx.assert.deepEqual(confirmHits, [], 'production frontend scripts must use LingxiDialog instead of window.confirm')

    const changeSession = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/change-session-actions.js'), 'utf8')
    const memoRail = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/ai-operation-memo-rail.js'), 'utf8')
    const gitPanel = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/git-panel.js'), 'utf8')
    const titlebar = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/titlebar-actions.js'), 'utf8')
    const windowTabs = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/window-tabs.js'), 'utf8')
    const messageSender = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/message-sender.js'), 'utf8')
    const browserSettings = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/browser-settings.js'), 'utf8')
    ctx.assert.ok(changeSession.includes('确认仅撤销本次 AI 改动吗？'), 'rollback copy stays the original sentence')
    ctx.assert.ok(changeSession.includes('确认要硬重置整个工作区吗？'), 'hard-reset copy stays the original sentence')
    ctx.assert.ok(memoRail.includes('确认要回退本次改动吗？'), 'memo rollback copy stays the original sentence')
    ctx.assert.ok(gitPanel.includes('将把分支「${branch}」合并到当前所在分支。'), 'merge copy stays the original sentence')
    ctx.assert.ok(titlebar.includes('导入会覆盖当前项目的聊天记录。'), 'import copy stays the original sentence')
    ctx.assert.ok(windowTabs.includes('本地自动修复无法安全处理当前语法提示。'), 'syntax-repair copy stays the original sentence')
    ctx.assert.ok(messageSender.includes('未标注视觉理解能力'), 'vision confirm copy stays the original sentence')
    ctx.assert.ok(
      messageSender.includes("capabilityPolicies.visionConfirm !== 'always'") &&
      !messageSender.includes('window.confirm = () => true'),
      'visionConfirm skip must not monkey-patch window.confirm'
    )
    ctx.assert.ok(browserSettings.includes("title: '选择浏览器'"), 'browser cookie import still uses the original picker title')
    ctx.assert.ok(browserSettings.includes('profiles?.[0]'), 'browser settings picker still maps one browser to its first profile')
    ctx.assert.ok(windowTabs.includes("title: '选择导入来源'"), 'tab import picker still uses the original title')
    ctx.assert.ok(
      windowTabs.includes('browsers.length === 1 && browsers[0].profiles.length === 1'),
      'single browser + single profile still skips the picker'
    )
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'frontend/scripts/features/project-init.js')), 'project init was extracted from app.js')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'frontend/scripts/features/ai-file-reference.js')), 'file-reference clicks were extracted from app.js')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'frontend/scripts/features/send-interrupt-queue.js')), 'send/interrupt/queue was extracted from app.js')

    ctx.assert.equal(fs.existsSync(path.join(ctx.root, '数据009')), false, 'external chat dataset dump must not sit in the source root')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'dist/win-unpacked')), false, 'pack output must not remain inside the source tree')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'codex-harness')), false, 'codex harness sparse clone must not sit in the source tree')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'experiments')), false, 'local experiments must not sit in the source tree')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'website')), false, 'standalone marketing site is not part of the Electron source tree')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'ios')), false, 'removed remote-control iOS app must not remain in this repo')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, '音乐')), false, 'duplicate root music files must not remain')
    ctx.assert.equal(fs.existsSync(path.join(ctx.root, 'services/gemini-agent-api-gateway/data')), false, 'gateway browser profiles are runtime data, not source')
    ctx.assert.ok(gitignore.includes('数据009/'), 'dataset dump must stay out of git')
    ctx.assert.ok(gitignore.includes('website/'), 'marketing site folder must stay out of git')
    ctx.assert.ok(gitignore.includes('ios/'), 'removed iOS remote app must stay out of git')
    ctx.assert.ok(gitignore.includes('services/**/data/'), 'nested service runtime data must stay out of git')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, 'plugins')), 'marketplace plugin source stays')
    ctx.assert.ok(fs.existsSync(path.join(ctx.root, '开发模式启动.bat')), 'the Chinese development launcher stays')
  }
}
