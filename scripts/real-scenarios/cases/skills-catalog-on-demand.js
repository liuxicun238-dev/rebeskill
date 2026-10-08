const path = require('path')

module.exports = {
  id: 'skills.catalog-on-demand-load',
  title: 'Skill catalog injects summaries only; load_skill returns the full body',
  tags: ['skills', 'catalog', 'tools', 'prompt'],
  changedFilePatterns: [
    /^electron\/modules\/skills\.js$/i,
    /^electron\/modules\/feature-settings\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/modules\/tool-handlers\/tool-system\.js$/i,
    /^electron\/modules\/schemas\/command\.js$/i,
    /^electron\/modules\/capability-tiers\.js$/i
  ],

  async run(ctx) {
    const skills = require(path.join(ctx.root, 'electron/modules/skills'))
    const config = require(path.join(ctx.root, 'electron/modules/config'))
    const featureSettings = require(path.join(ctx.root, 'electron/modules/feature-settings'))
    const { MODEL_TOOLS_SCHEMA } = require(path.join(ctx.root, 'electron/modules/schemas'))
    const spill = require(path.join(ctx.root, 'electron/modules/chat/tool-output-spill'))
    const { isConcurrencySafeToolName } = require(path.join(ctx.root, 'electron/modules/chat/tool-batch-scheduler'))
    const originalGetEnabled = config.getEnabledSkills
    const originalIsFeatureEnabled = featureSettings.isFeatureEnabled

    try {
      config.getEnabledSkills = () => []
      featureSettings.isFeatureEnabled = () => false

      ctx.assert.equal(skills.parseSelectedSkillName('web-design'), 'web-design')
      ctx.assert.equal(
        skills.parseSelectedSkillName('===== 当前选用技能：Web Design（web-design）[builtin] =====\n\n# body'),
        'web-design'
      )

      const catalog = skills.buildSkillCatalogPrompt({
        selectedName: 'web-design',
        userMessage: '随便问一句',
        skillContent: 'web-design'
      })
      ctx.assert.ok(catalog.includes('当前选用技能') || catalog.includes('可用技能目录'))
      ctx.assert.ok(catalog.includes('`web-design`'))
      ctx.assert.ok(catalog.includes('当前选用'))
      ctx.assert.ok(catalog.includes('load_skill'))
      ctx.assert.equal(catalog.includes('Phase A'), false, 'catalog must not include the full web-design body')
      ctx.assert.equal(catalog.includes('handoff'), false, 'closed dynamic catalog must not list unselected skills')
      ctx.assert.ok(catalog.length < 4000, 'a single selected skill catalog should stay compact')

      const loadedSelected = skills.loadSkillBody('web-design', '', { selectedName: 'web-design' })
      ctx.assert.ok(loadedSelected.success, loadedSelected.error || 'selected skill should still load when the catalog switch is off')
      ctx.assert.ok(String(loadedSelected.content).includes('Phase A'), 'loaded body should include the full instructions')

      const blocked = skills.loadSkillBody('handoff', '', { selectedName: 'web-design' })
      ctx.assert.equal(blocked.success, false)
      ctx.assert.equal(blocked.error_type, 'skill_dynamic_catalog_disabled')

      const loaded = skills.loadSkillBody('web-design', '', { selectedName: 'web-design' })
      ctx.assert.ok(loaded.success, loaded.error || 'load_skill should resolve builtin skills')

      const missing = skills.loadSkillBody('not-a-real-skill', '', { selectedName: 'not-a-real-skill' })
      ctx.assert.equal(missing.success, false)
      ctx.assert.equal(missing.error_type, 'skill_not_found')

      const hiddenPool = skills.buildSkillCatalogPrompt({
        selectedName: '',
        userMessage: '随便改个 bug',
        dynamicCatalogEnabled: false
      })
      ctx.assert.equal(hiddenPool, '', 'no dropdown skill and closed switch should inject no catalog')

      config.getEnabledSkills = () => ['handoff', 'to-prd', 'web-design']
      const dumped = skills.buildSkillCatalogPrompt({
        selectedName: '',
        userMessage: '随便改个 bug',
        dynamicCatalogEnabled: true
      })
      ctx.assert.ok(dumped.includes('可用技能目录'))
      ctx.assert.ok(dumped.includes('handoff'), 'open switch should list enabled pool skills')

      featureSettings.isFeatureEnabled = id => id === 'inline_visualize' || id === 'skill_dynamic_catalog'
      const relevant = skills.buildSkillCatalogPrompt({
        selectedName: '',
        userMessage: '请简单回答今天星期几',
        dynamicCatalogEnabled: true
      })
      ctx.assert.ok(relevant.includes('inline-visual'))
      ctx.assert.ok(relevant.includes('本轮相关'))
      ctx.assert.equal(relevant.includes('不得为了填满正文空白'), false)

      const modelToolNames = MODEL_TOOLS_SCHEMA.map(item => item.function?.name)
      ctx.assert.ok(modelToolNames.includes('load_skill'), 'load_skill must be model-visible')
      ctx.assert.equal(isConcurrencySafeToolName('load_skill'), true)

      const huge = spill.applyToToolResult('load_skill', {
        success: true,
        name: 'web-design',
        content: `${'x'.repeat(20000)}KEEP`
      }, { callId: 'skill-spill' })
      ctx.assert.equal(huge.spilled, undefined)
      ctx.assert.ok(String(huge.content).includes('KEEP'), 'loaded skill bodies should not be spilled')
    } finally {
      config.getEnabledSkills = originalGetEnabled
      featureSettings.isFeatureEnabled = originalIsFeatureEnabled
    }
  }
}
