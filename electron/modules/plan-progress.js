/**
 * API 模型计划进度：主进程记住已确认步骤，complete_step 可只传 step_index。
 * 不按工具次数推进；是否勾步由模型对照当前步骤目标判断。
 * 状态写入项目存储目录的 plan-progress.json，重启后仍能折回当前步。
 */

const fs = require('fs')
const path = require('path')
const config = require('./config')

const plansByProject = new Map()
const PLAN_FILE_NAME = 'plan-progress.json'

function normalizeSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map(item => String(item == null ? '' : item).trim())
    .filter(Boolean)
}

function getPlanKey(projectId) {
  const key = String(projectId || '').trim()
  return key || ''
}

function resolvePlanFile(projectId, storageDir = '') {
  const dir = String(storageDir || '').trim()
    || String(config.getProjectInstance?.(projectId)?.storagePath || '').trim()
    || String(config.getProjectInstance?.(projectId)?.rootStoragePath || '').trim()
  if (!dir) return ''
  return path.join(dir, PLAN_FILE_NAME)
}

function hydratePlan(raw, projectId = '') {
  const steps = normalizeSteps(raw?.steps)
  if (!steps.length) return null
  const totalSteps = Number(raw.totalSteps) || steps.length
  const currentStepIndex = Math.max(0, Math.min(Number(raw.currentStepIndex) || 0, totalSteps))
  return {
    steps,
    totalSteps,
    currentStepIndex,
    summary: String(raw.summary || '').trim(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    projectId: String(raw.projectId || projectId || '').trim()
  }
}

function loadPlanFromDisk(projectId, storageDir = '') {
  const filePath = resolvePlanFile(projectId, storageDir)
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return hydratePlan(parsed, projectId)
  } catch (error) {
    console.warn('[PlanProgress] 读取失败:', error.message)
    return null
  }
}

function persistPlan(projectId, state, storageDir = '') {
  const filePath = resolvePlanFile(projectId, storageDir)
  if (!filePath || !state?.steps?.length) return false
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify({
      ...state,
      projectId,
      schemaVersion: 1
    }, null, 2), 'utf8')
    try {
      fs.renameSync(tmpPath, filePath)
    } catch {
      fs.copyFileSync(tmpPath, filePath)
      try { fs.unlinkSync(tmpPath) } catch (_) { /* ignore */ }
    }
    return true
  } catch (error) {
    console.warn('[PlanProgress] 写入失败:', error.message)
    return false
  }
}

function removePlanFile(projectId, storageDir = '') {
  const filePath = resolvePlanFile(projectId, storageDir)
  if (!filePath) return false
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    return true
  } catch (error) {
    console.warn('[PlanProgress] 删除失败:', error.message)
    return false
  }
}

function getPlan(projectId, options = {}) {
  const key = getPlanKey(projectId)
  if (!key) return null
  const cached = plansByProject.get(key)
  if (cached) return cached
  const loaded = loadPlanFromDisk(key, options.storageDir)
  if (loaded) plansByProject.set(key, loaded)
  return loaded
}

function hasUnfinishedPlan(projectId) {
  const state = getPlan(projectId)
  if (!state?.steps?.length) return false
  const total = Number(state.totalSteps) || state.steps.length
  return Number(state.currentStepIndex || 0) < total
}

function rememberConfirmedPlan(projectId, steps, summary = '', options = {}) {
  const list = normalizeSteps(steps)
  const key = getPlanKey(projectId)
  if (!key || !list.length) return getPlan(projectId, options)
  const state = {
    steps: list,
    totalSteps: list.length,
    currentStepIndex: 0,
    summary: String(summary || '').trim(),
    updatedAt: Date.now(),
    projectId: key
  }
  plansByProject.set(key, state)
  persistPlan(key, state, options.storageDir)
  return state
}

function applyCompleteStep(projectId, args = {}, options = {}) {
  const state = getPlan(projectId, options)
  const incomingSteps = normalizeSteps(args.steps)
  const steps = incomingSteps.length ? incomingSteps : (state?.steps || [])
  const totalSteps = Number(args.total_steps) || steps.length || state?.totalSteps || 0
  let stepIndex = Number(args.step_index)
  if (!Number.isFinite(stepIndex) && state) {
    stepIndex = Number(state.currentStepIndex) || 0
  }
  const status = String(args.status || 'completed').trim() || 'completed'
  let currentStepIndex = Number.isFinite(stepIndex) ? stepIndex : 0
  if (status === 'completed' && Number.isFinite(stepIndex)) {
    currentStepIndex = stepIndex + 1
  } else if ((status === 'running' || status === 'failed') && Number.isFinite(stepIndex)) {
    currentStepIndex = stepIndex
  }
  if (totalSteps > 0) {
    currentStepIndex = Math.max(0, Math.min(currentStepIndex, totalSteps))
  }
  const allDone = totalSteps > 0 && currentStepIndex >= totalSteps
  const phase = String(args.phase || '').trim()
    || (allDone ? '已完成' : '执行中...')
  const next = {
    steps,
    totalSteps,
    currentStepIndex,
    summary: state?.summary || '',
    updatedAt: Date.now()
  }
  const key = getPlanKey(projectId)
  if (key && steps.length) {
    plansByProject.set(key, next)
    persistPlan(key, next, options.storageDir)
  }
  return {
    step_index: Number.isFinite(stepIndex) ? stepIndex : 0,
    steps,
    total_steps: totalSteps,
    status,
    phase,
    currentStepIndex
  }
}

function buildPlanProgressContext(projectId) {
  const state = getPlan(projectId)
  if (!state?.steps?.length) return ''
  const totalSteps = Number(state.totalSteps) || state.steps.length
  const currentStepIndex = Number(state.currentStepIndex) || 0
  if (currentStepIndex >= totalSteps) {
    return `当前计划 ${totalSteps}/${totalSteps} 已全部勾完。不要重写计划。`
  }
  const current = state.steps[currentStepIndex] || `步骤 ${currentStepIndex + 1}`
  const preview = state.steps.map((title, index) => {
    const mark = index < currentStepIndex ? '✓' : (index === currentStepIndex ? '→' : '○')
    return `${mark} ${index}. ${title}`
  }).join('；')
  return [
    `当前计划 ${currentStepIndex + 1}/${totalSteps} 进行中：${current}。尚未满足则继续当前步骤，不要调用 complete_step；目标已被证据充分满足时，本轮必须 complete_step(step_index=${currentStepIndex})。不要空转同一搜索。不必重传 steps。`,
    `步骤：${preview}`
  ].join('\n')
}

function getToolName(call = {}) {
  return String(call?.name || call?.function?.name || '').trim()
}

function buildPlanProgressNudge(projectId, { toolCallsThisBatch = [] } = {}) {
  if (!hasUnfinishedPlan(projectId)) return ''
  const names = (Array.isArray(toolCallsThisBatch) ? toolCallsThisBatch : []).map(getToolName)
  if (names.includes('complete_step') || names.includes('confirm_plan')) return ''
  const hasWork = names.some(name => (
    name
    && name !== 'show_thinking_note'
    && name !== 'report_progress'
    && name !== 'start_final_reply'
    && name !== 'record_ai_operation_memo'
  ))
  if (!hasWork) return ''
  const state = getPlan(projectId)
  const totalSteps = Number(state.totalSteps) || state.steps.length
  const currentStepIndex = Number(state.currentStepIndex) || 0
  const current = state.steps[currentStepIndex] || `步骤 ${currentStepIndex + 1}`
  return [
    `对照当前计划步骤（${currentStepIndex + 1}/${totalSteps}：${current}）。`,
    `这批工具结果若已经充分满足该步骤目标，本轮必须 complete_step(step_index=${currentStepIndex})；尚未满足则继续当前步骤，不要调用 complete_step。`,
    '不要因为刚工作过就默认完成，也不要在证据已经够了时继续空转同一搜索。不必重传 steps。'
  ].join('')
}

function buildPlanFinalNudge(projectId) {
  if (!hasUnfinishedPlan(projectId)) return ''
  const state = getPlan(projectId)
  const totalSteps = Number(state.totalSteps) || state.steps.length
  const currentStepIndex = Number(state.currentStepIndex) || 0
  const current = state.steps[currentStepIndex] || `步骤 ${currentStepIndex + 1}`
  return [
    `最终回复前先判断：当前计划还有未勾步骤（进行中：${currentStepIndex + 1}/${totalSteps} ${current}）。`,
    `若该步目标已被证据满足，先 complete_step(step_index=${currentStepIndex}) 再写最终回复；尚未满足也可以收尾，但不要把未完成步骤说成已完成。不必重传 steps。`
  ].join('')
}

function clearPlan(projectId, options = {}) {
  const key = getPlanKey(projectId)
  if (!key) return false
  const deleted = plansByProject.delete(key)
  removePlanFile(key, options.storageDir)
  return deleted
}

function resetAllForTests() {
  plansByProject.clear()
}

module.exports = {
  PLAN_FILE_NAME,
  rememberConfirmedPlan,
  getPlan,
  hasUnfinishedPlan,
  applyCompleteStep,
  buildPlanProgressContext,
  buildPlanProgressNudge,
  buildPlanFinalNudge,
  clearPlan,
  resetAllForTests,
  resolvePlanFile
}
