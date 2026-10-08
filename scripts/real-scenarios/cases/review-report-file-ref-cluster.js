const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'chat.review-report-file-ref-cluster',
  title: 'Review reports group file lists and collapse dense file chips',
  tags: ['chat-ui', 'review', 'prompt', 'markdown'],
  changedFilePatterns: [
    /^electron\/modules\/agent-runtime\.js$/i,
    /^electron\/modules\/system-prompt-builder\.js$/i,
    /^electron\/modules\/agents\/agent-registry\.js$/i,
    /^frontend\/scripts\/features\/ai-file-ref-cluster\.js$/i,
    /^frontend\/scripts\/features\/ai-message-ui\.js$/i,
    /^frontend\/scripts\/features\/ai-file-reference\.js$/i,
    /^frontend\/styles\/chat\.css$/i,
    /^frontend\/index\.html$/i
  ],

  async run(ctx) {
    const runtime = require(path.join(ctx.root, 'electron/modules/agent-runtime'))
    const { AGENT_ROLES } = require(path.join(ctx.root, 'electron/modules/agents/agent-registry'))
    const cluster = require(path.join(ctx.root, 'frontend/scripts/features/ai-file-ref-cluster.js'))
    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
    const messageUi = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/ai-message-ui.js'), 'utf8')
    const fileRef = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/ai-file-reference.js'), 'utf8')
    const css = fs.readFileSync(path.join(ctx.root, 'frontend/styles/chat.css'), 'utf8')
    const promptSource = fs.readFileSync(path.join(ctx.root, 'electron/modules/system-prompt-builder.js'), 'utf8')

    ctx.assert.equal(runtime.detectTaskType('请审查这个项目'), 'review')
    const fullPrompt = runtime.buildAgentRuntimePrompt()
    ctx.assert.ok(fullPrompt.includes('检查范围按目录分组列点'), 'full runtime prompt must require grouped review scope')
    ctx.assert.ok(fullPrompt.includes('禁止把几十个路径堆进一段话'), 'full runtime prompt must forbid path walls')
    ctx.assert.ok(fullPrompt.includes('项目路径/类型/检查范围放最后'), 'review report must put inventory last')

    const focus = runtime.buildTaskFocusPrompt('请审查这个项目')
    ctx.assert.ok(focus.includes('不要用行内反引号堆文件墙'), 'compact review focus must include file-wall rule')

    ctx.assert.ok(promptSource.includes('行内反引号只用于 1～2 个短名字或符号'), 'system prompt must limit inline backticks')
    ctx.assert.ok(promptSource.includes('文件清单按目录分组列点'), 'system prompt must group file lists')

    ctx.assert.ok(AGENT_ROLES.projectReviewer.content.includes('最后才写检查范围'))
    ctx.assert.ok(AGENT_ROLES.projectReviewer.content.includes('每目录最多 3 个代表文件'))

    ctx.assert.equal(cluster.FILE_REF_CLUSTER_MIN, 4)
    ctx.assert.equal(cluster.FILE_REF_CLUSTER_PREVIEW, 8)
    ctx.assert.equal(cluster.looksLikeFilePathToken('src/router.ts'), true)
    ctx.assert.equal(cluster.looksLikeFilePathToken('AGENTS.md'), true)
    ctx.assert.equal(cluster.looksLikeFilePathToken('hello world'), false)
    ctx.assert.equal(cluster.looksLikeFilePathToken('https://example.com/a.ts'), false)
    ctx.assert.equal(cluster.isClusterGlueText(', '), true)
    ctx.assert.equal(cluster.isClusterGlueText(' and '), false)
    ctx.assert.equal(cluster.overflowLabel(16, false), '还有 16 个')
    ctx.assert.equal(cluster.overflowLabel(16, true), '收起')

    const dense = []
    for (let i = 0; i < 12; i++) {
      dense.push({ isRef: true })
      if (i < 11) dense.push({ isGlue: true })
    }
    const denseRuns = cluster.findFileRefRuns(dense)
    ctx.assert.equal(denseRuns.length, 1)
    ctx.assert.equal(denseRuns[0].length, 12)

    const shortRun = [{ isRef: true }, { isGlue: true }, { isRef: true }, { isGlue: true }, { isRef: true }]
    ctx.assert.equal(cluster.findFileRefRuns(shortRun).length, 0, 'fewer than 4 consecutive file chips must stay inline')

    const split = [
      { isRef: true }, { isGlue: true }, { isRef: true }, { isGlue: true }, { isRef: true }, { isGlue: true }, { isRef: true },
      { isOther: true },
      { isRef: true }, { isGlue: true }, { isRef: true }
    ]
    const splitRuns = cluster.findFileRefRuns(split)
    ctx.assert.equal(splitRuns.length, 1)
    ctx.assert.equal(splitRuns[0].length, 4)

    ctx.assert.ok(html.includes('ai-file-ref-cluster.js?v=20260828-file-ref-cluster'))
    ctx.assert.ok(
      html.indexOf('ai-file-ref-cluster.js') < html.indexOf('ai-message-ui.js'),
      'cluster helper must load before message rendering'
    )
    ctx.assert.ok(messageUi.includes('AiFileRefCluster?.collapseFileReferenceClusters?.(root)'))
    ctx.assert.ok(fileRef.includes("closest?.('.ai-file-ref-cluster-more')"))
    ctx.assert.ok(css.includes('.ai-file-ref-cluster:not(.is-expanded) .ai-file-ref-overflow'))
  }
}
