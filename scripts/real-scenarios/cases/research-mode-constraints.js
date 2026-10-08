const fs = require('fs')
const path = require('path')
const vm = require('vm')

module.exports = {
  id: 'research-mode.constraints',
  title: 'Research mode persists strict project constraints and exposes the full request/audit chain',
  tags: ['research-mode', 'constraints', 'audit'],
  changedFilePatterns: [
    /^electron\/modules\/research-mode\.js$/i,
    /^electron\/modules\/ask-request-registry\.js$/i,
    /^electron\/modules\/ask-permission\.js$/i,
    /^electron\/modules\/tools\.js$/i,
    /^electron\/modules\/project-mode\.js$/i,
    /^electron\/modules\/ai-chat\.js$/i,
    /^electron\/preload\.js$/i,
    /^frontend\/scripts\/features\/(?:chat-toolbar-context|message-sender|project-actions|projects|project-state-helpers|titlebar-actions)\.js$/i
  ],

  async run(ctx) {
    const workspace = ctx.createWorkspace('research-mode-constraints')
    try {
      const researchMode = require(path.join(ctx.root, 'electron/modules/research-mode'))
      const projectModes = require(path.join(ctx.root, 'electron/modules/project-mode'))
      const askPermission = require(path.join(ctx.root, 'electron/modules/ask-permission'))
      const tools = require(path.join(ctx.root, 'electron/modules/tools'))
      const instance = { projectId: 'research-project', storagePath: workspace.storagePath, projectPath: workspace.projectPath }
      const otherStoragePath = path.join(workspace.storagePath, 'other-project')
      const other = { projectId: 'standard-project', storagePath: otherStoragePath, projectPath: workspace.projectPath }
      fs.mkdirSync(workspace.projectPath, { recursive: true })

      let askResponseHandler = null
      tools.registerToolAskIPC({
        on(channel, handler) {
          if (channel === 'ask-popup-response') askResponseHandler = handler
        }
      })
      const askRequestId = askPermission.createAskRequestId(instance.projectId, 'research_constraint')
      const askResponsePromise = askPermission.waitForAskResponse(instance.projectId, askRequestId, 1000)
      ctx.assert.equal(typeof askResponseHandler, 'function', 'the shared ask response IPC handler must be registered')
      askResponseHandler({ sender: { send() {} } }, {
        requestId: askRequestId,
        projectId: instance.projectId,
        value: 'adopt',
        answer: '采纳为研究约束'
      })
      const askResponse = await askResponsePromise
      ctx.assert.equal(askResponse.value, 'adopt', 'research asks and the IPC response handler must share one pending-request registry')

      ctx.assert.equal(projectModes.setProvisionalProjectMode(instance, 'research'), 'research', 'project mode selection should be provisional before the first request')
      ctx.assert.ok(!fs.existsSync(projectModes.getModePath(instance)), 'selecting a directory must not create the persistent mode lock')
      ctx.assert.equal(projectModes.setProvisionalProjectMode(instance, 'standard'), 'standard', 'project mode may change before the first request')
      ctx.assert.equal(projectModes.setProvisionalProjectMode(instance, 'research'), 'research', 'the last pre-send selection should be retained')
      ctx.assert.equal(projectModes.setProvisionalProjectMode(other, 'standard'), 'standard', 'another project must keep an independent provisional mode')
      ctx.assert.equal(projectModes.assertRequestMode(instance, 'research'), 'research', 'the first request must persistently lock the selected mode')
      ctx.assert.equal(projectModes.assertRequestMode(other, 'standard'), 'standard', 'another project must lock independently on its own first request')
      let modeConflict = null
      try {
        projectModes.assertRequestMode(instance, 'standard')
      } catch (error) {
        modeConflict = error
      }
      ctx.assert.equal(modeConflict?.code, 'PROJECT_MODE_CONFLICT', 'a locked project must reject later mode changes')
      let storageConflict = null
      try {
        projectModes.setProvisionalProjectMode({ projectId: 'foreign-project', storagePath: workspace.storagePath }, 'research')
      } catch (error) {
        storageConflict = error
      }
      ctx.assert.equal(storageConflict?.code, 'PROJECT_MODE_STORAGE_CONFLICT', 'two project ids must not share one project-mode store')

      ctx.assert.ok(researchMode.isResearchMode('research'), 'research mode must be recognized explicitly')
      ctx.assert.ok(!researchMode.isResearchMode('ask'), 'ordinary authorization modes must remain ordinary')

      const first = researchMode.addConstraint(instance, {
        text: '所有结论必须有可复核证据，失败结果不得隐藏。',
        reason: '防止把推测写成研究结论',
        sourceType: 'user'
      })
      ctx.assert.ok(first.added, 'first adopted constraint should be persisted')
      const duplicate = researchMode.addConstraint(instance, {
        text: '所有结论必须有可复核证据，失败结果不得隐藏。',
        reason: '重复条款',
        sourceType: 'assistant'
      })
      ctx.assert.ok(duplicate.duplicate, 'identical constraints should not be duplicated')

      const loaded = researchMode.loadStore(instance)
      ctx.assert.equal(loaded.constraints.length, 1, 'constraint store should retain one active canonical entry')
      ctx.assert.equal(researchMode.loadStore(other).constraints.length, 0, 'research constraints must not leak into another project')
      ctx.assert.match(researchMode.buildConstraintPrompt(loaded.constraints), /不得先做后报|停止相关执行/, 'runtime prompt should enforce fail-before-action behavior')
      ctx.assert.ok(researchMode.__test.parseAuditReport('VERDICT: PASS\n证据充分').pass, 'explicit PASS audit should pass')
      ctx.assert.ok(researchMode.__test.parseAuditReport('没有标准裁决行').violation, 'missing audit verdict must fail closed')

      const indexHtml = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')
      const projectStateHelpers = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/project-state-helpers.js'), 'utf8')
      const projectStore = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/projects.js'), 'utf8')
      const messageSender = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/message-sender.js'), 'utf8')
      const toolbarContext = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/chat-toolbar-context.js'), 'utf8')
      const preload = fs.readFileSync(path.join(ctx.root, 'electron/preload.js'), 'utf8')
      const aiChat = fs.readFileSync(path.join(ctx.root, 'electron/modules/ai-chat.js'), 'utf8')
      const researchModeSource = fs.readFileSync(path.join(ctx.root, 'electron/modules/research-mode.js'), 'utf8')
      const frontendContext = { window: {}, console }
      vm.runInNewContext(projectStore, frontendContext)
      const frontendProject = frontendContext.window.ProjectStore.createProject('C:\\research-project', { projectMode: 'research' })
      frontendProject.projectMode = 'standard'
      ctx.assert.equal(frontendProject.projectMode, 'standard', 'the frontend project record must allow mode changes before the first send')
      frontendProject.projectModeLocked = true
      frontendProject.projectMode = 'research'
      ctx.assert.equal(frontendProject.projectMode, 'standard', 'the frontend project record must reject mode changes after the first send')
      ctx.assert.match(projectStateHelpers, /data-welcome-project-mode="research"/, 'top new-project selector should expose research mode')
      ctx.assert.match(projectStateHelpers, /welcome-mode-option-desc/, 'every project mode should include a visible description')
      ctx.assert.ok(!/项目创建后不可更换|项目创建后固定/.test(projectStateHelpers), 'mode descriptions should explain capabilities without prominent lock wording')
      ctx.assert.ok(!/class="exec-mode-option" data-value="research"/.test(indexHtml), 'authorization selector must not expose research as an authorization mode')
      ctx.assert.match(indexHtml, /id="chatProjectMode"/, 'the session header must expose the locked project mode')
      ctx.assert.match(toolbarContext, /projectModeInfo/, 'the session header must render the active project mode label')
      ctx.assert.match(projectStore, /projectMode/, 'project mode must be persisted independently on the project record')
      ctx.assert.match(messageSender, /project\.projectMode/, 'each request must send the selected project mode')
      ctx.assert.match(preload, /projectMode = 'standard'/, 'IPC must carry project mode separately from execution mode')
      ctx.assert.match(aiChat, /researchMode\.isResearchMode\(projectMode\)/, 'research activation must depend on project mode, not authorization mode')
      ctx.assert.match(aiChat, /projectModes\.assertRequestMode/, 'the backend must reject a request whose mode differs from the project lock')
      ctx.assert.match(aiChat, /researchMode.prepareRequest/, 'main request must run research preflight')
      ctx.assert.match(aiChat, /changedFiles\.length > 0/, 'independent audit should only be offered after actual file changes')
      ctx.assert.match(aiChat, /researchMode\.askToAudit/, 'file-changing turns must ask before starting an independent audit')
      ctx.assert.match(aiChat, /researchMode.auditFinal/, 'approved file-changing turns must run the independent audit')
      ctx.assert.match(aiChat, /researchMode.considerFinalCandidate/, 'final reply must be reconsidered as a possible constraint')
      ctx.assert.ok(!/agent-sub-runner|runSubAgent/.test(researchModeSource), 'research audit must not spawn a sub-agent')
    } finally {
      workspace.cleanup()
    }
  }
}
