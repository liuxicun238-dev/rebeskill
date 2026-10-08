const fs = require('fs')
const path = require('path')
const planProgress = require('../electron/modules/plan-progress')
const { getSystemPrompt } = require('../electron/modules/system-prompt-builder')
const { buildCompactAgentRuntimePrompt } = require('../electron/modules/agent-runtime')

planProgress.resetAllForTests()

const projectId = 'plan-progress-test'
const steps = ['定位入口', '核对关键证据', '给出结论']

if (planProgress.buildPlanProgressContext(projectId)) {
  throw new Error('未确认计划时不应注入计划上下文')
}

planProgress.rememberConfirmedPlan(projectId, steps, '按用户需求推进')
const remembered = planProgress.getPlan(projectId)
if (!remembered || remembered.currentStepIndex !== 0 || remembered.totalSteps !== 3) {
  throw new Error('confirm_plan 确认后应记住步骤并从第 0 步开始')
}

const context = planProgress.buildPlanProgressContext(projectId)
if (!context.includes('当前计划 1/3 进行中：定位入口')) {
  throw new Error('动态上下文应提示当前计划步: ' + context)
}
if (!context.includes('complete_step(step_index=0)') || !context.includes('不必重传 steps')) {
  throw new Error('动态上下文应说明只需 step_index: ' + context)
}

const searchNudge = planProgress.buildPlanProgressNudge(projectId, {
  toolCallsThisBatch: [{ function: { name: 'file_search' } }]
})
if (!searchNudge.includes('对照当前计划步骤') || !searchNudge.includes('step_index=0')) {
  throw new Error('工具批次后应给出二选一催续: ' + searchNudge)
}
if (!searchNudge.includes('尚未满足则继续当前步骤')) {
  throw new Error('催续必须允许继续当前步骤，不能按工具次数勾步')
}

const skippedAfterComplete = planProgress.buildPlanProgressNudge(projectId, {
  toolCallsThisBatch: [
    { name: 'file_read' },
    { function: { name: 'complete_step' } }
  ]
})
if (skippedAfterComplete) {
  throw new Error('本批已调用 complete_step 时不应再催勾')
}

const skippedThinkingOnly = planProgress.buildPlanProgressNudge(projectId, {
  toolCallsThisBatch: [{ name: 'show_thinking_note' }]
})
if (skippedThinkingOnly) {
  throw new Error('只有过程说明工具时不应催勾')
}

const filled = planProgress.applyCompleteStep(projectId, { step_index: 0 })
if (filled.steps.join(',') !== steps.join(',')) {
  throw new Error('complete_step 应自补 steps，实际: ' + JSON.stringify(filled.steps))
}
if (filled.total_steps !== 3 || filled.status !== 'completed' || filled.currentStepIndex !== 1) {
  throw new Error('complete_step 应自补 total_steps/status 并推进到下一步: ' + JSON.stringify(filled))
}

const afterFirst = planProgress.buildPlanProgressContext(projectId)
if (!afterFirst.includes('当前计划 2/3 进行中：核对关键证据') || !afterFirst.includes('step_index=1')) {
  throw new Error('勾完第一步后上下文应指向第二步: ' + afterFirst)
}

planProgress.applyCompleteStep(projectId, { step_index: 1 })
planProgress.applyCompleteStep(projectId, { step_index: 2 })
const doneContext = planProgress.buildPlanProgressContext(projectId)
if (!doneContext.includes('已全部勾完')) {
  throw new Error('全部完成后应提示计划已勾完: ' + doneContext)
}
if (planProgress.buildPlanProgressNudge(projectId, { toolCallsThisBatch: [{ name: 'file_read' }] })) {
  throw new Error('计划完成后不应再催 complete_step')
}
if (planProgress.buildPlanFinalNudge(projectId)) {
  throw new Error('计划完成后收尾前不应再催勾')
}

planProgress.rememberConfirmedPlan(projectId, steps, '再开一轮')
const finalNudge = planProgress.buildPlanFinalNudge(projectId)
if (!finalNudge.includes('最终回复前先判断') || !finalNudge.includes('尚未满足也可以收尾')) {
  throw new Error('收尾催促应允许直接回答，不能卡死: ' + finalNudge)
}

const schemaPath = path.join(__dirname, '../electron/modules/schemas/plan-ask.js')
const schemaText = fs.readFileSync(schemaPath, 'utf8')
const completeStepBlock = schemaText.slice(schemaText.indexOf("name: 'complete_step'"))
if (!completeStepBlock.includes("required: ['step_index']")) {
  throw new Error('complete_step schema 应只强制 step_index')
}
if (completeStepBlock.includes("required: ['step_index', 'total_steps', 'steps', 'status']")) {
  throw new Error('complete_step 不应再强制 steps/total_steps/status')
}

const systemPrompt = getSystemPrompt('ask', '', false, 'zh-CN')
if (!systemPrompt.includes('软件会记住 steps') || !systemPrompt.includes('step_index')) {
  throw new Error('系统提示应说明软件记住步骤且通常只需 step_index')
}
const compact = buildCompactAgentRuntimePrompt()
if (!compact.includes('软件记住 steps') || !compact.includes('complete_step(step_index)')) {
  throw new Error('精简运行时应说明 complete_step 只需 step_index')
}

planProgress.resetAllForTests()

const os = require('os')
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-plan-progress-'))
planProgress.rememberConfirmedPlan(projectId, steps, '持久化', { storageDir: persistDir })
planProgress.resetAllForTests()
const restored = planProgress.getPlan(projectId, { storageDir: persistDir })
if (!restored || restored.currentStepIndex !== 0 || restored.steps.join(',') !== steps.join(',')) {
  throw new Error('计划应写入磁盘并在内存清空后恢复: ' + JSON.stringify(restored))
}
planProgress.applyCompleteStep(projectId, { step_index: 0 }, { storageDir: persistDir })
planProgress.resetAllForTests()
const afterStep = planProgress.getPlan(projectId, { storageDir: persistDir })
if (!afterStep || afterStep.currentStepIndex !== 1) {
  throw new Error('complete_step 后磁盘进度应推进: ' + JSON.stringify(afterStep))
}
planProgress.clearPlan(projectId, { storageDir: persistDir })
if (planProgress.getPlan(projectId, { storageDir: persistDir })) {
  throw new Error('clearPlan 应删除磁盘计划')
}
fs.rmSync(persistDir, { recursive: true, force: true })

console.log('plan-progress: remember/fill/context/nudge/schema/persist OK')
