/**
 * LingXi-native Agent Harness
 * ---------------------------
 *
 * 这是灵犀自己的 Agent Runtime 边界，不是把 Codex 的实现直接搬进来。
 * 当前先承接最稳定、最底层的 Turn 生命周期：
 *
 *   startTurn -> Turn/Item journal -> finishTurn
 *
 * 上层 ai-chat 仍然负责模型协议、流式解析和具体工具策略；后续会把
 * context fabric、capability planner、model broker、tool executor 逐步
 * 接到这里。先用兼容适配层建立单一入口，避免一次性重写整个聊天主循环。
 */

const taskRuns = require('../task-runs')
const turnItemStore = require('../chat/turn-item-store')
const { planCapabilities, buildCapabilityPlanPrompt } = require('./capability-planner')
const {
  planModelRoutes,
  getConfiguredModels,
  resolveCapabilityModel
} = require('./model-broker')
const capabilityCatalog = require('./capability-catalog')

const RUNTIME_VERSION = 'lingxi-harness-v1'

function clip(value, maxChars) {
  const text = String(value ?? '')
  return text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - 3)) + '...'
}

function normalizeTurnMetadata(options = {}) {
  const modelConfig = options.modelConfig || {}
  return {
    messagePreview: clip(options.message || '', 300),
    userMessage: clip(options.message || '', 1200),
    modelName: clip(modelConfig.modelName || '', 160),
    modelId: clip(options.effectiveModelId || modelConfig.modelId || '', 160),
    executionMode: clip(options.executionMode || 'auto', 80),
    projectMode: clip(options.projectMode || 'standard', 80),
    hidden: options.hidden === true,
    hasImages: Array.isArray(options.imageDataList) && options.imageDataList.length > 0,
    chatSessionId: clip(options.chatSessionId || '', 120)
  }
}

/**
 * 开始一轮灵犀任务。
 *
 * 返回对象而不是只返回 runRef，是为了给后续 Runtime 承载：
 * capabilityPlan、modelRoute、contextProfile 和 task graph 等运行态。
 */
function startTurn(options = {}) {
  const metadata = normalizeTurnMetadata(options)
  const capabilityPlan = planCapabilities(options)
  const capabilityResolution = capabilityCatalog.resolveForTurn({
    message: options.message,
    modelConfig: options.modelConfig,
    availableModels: options.availableModels,
    enabledPacks: options.enabledPacks,
    enableToolPack: options.enableToolPack,
    autoPrepare: options.autoPrepareCapabilities !== false
  })
  const modelRoute = planModelRoutes(capabilityPlan, {
    currentModel: options.modelConfig,
    availableModels: options.availableModels
  })
  const runRef = taskRuns.startRun(options.projectId, options.requestId, {
    ...metadata,
    runtime: RUNTIME_VERSION,
    capabilityPlan,
    modelRoute,
    capabilityResolution
  })

  turnItemStore.beginTurn(runRef, {
    userMessage: metadata.userMessage,
    modelName: metadata.modelName,
    modelId: metadata.modelId
  })
  taskRuns.event(runRef, 'capability_plan_created', {
    planner: capabilityPlan.planner,
    primaryIntent: capabilityPlan.primaryIntent,
    intents: capabilityPlan.intents,
    stableTools: capabilityPlan.stableTools,
    routeRequired: capabilityPlan.routeRequired
  })
  taskRuns.event(runRef, 'model_route_planned', modelRoute)
  taskRuns.event(runRef, 'capability_prepared', {
    planner: capabilityResolution.planner,
    stableTools: capabilityResolution.stable_tools,
    enabledPacks: capabilityResolution.enabled_packs,
    preparedPacks: capabilityResolution.prepared_packs,
    confirmations: capabilityResolution.confirmations
  })
  for (const prepared of capabilityResolution.prepared_packs || []) {
    taskRuns.event(runRef, 'capability_pack_auto_enabled', prepared)
  }

  return {
    runtime: RUNTIME_VERSION,
    runRef,
    turnId: String(runRef?.runId || ''),
    projectId: String(options.projectId || ''),
    requestId: String(options.requestId || ''),
    metadata,
    capabilityPlan,
    modelRoute,
    capabilityResolution
  }
}

/**
 * 统一收束一轮任务。
 *
 * 事实顺序固定为：
 *   1. Turn/Item 完成
 *   2. task run 完成
 *   3. 由调用方发送 UI done 事件
 *
 * 这样新一轮请求或项目切换读取时，journal 已经是最终状态。
 */
function finishTurn(turnRuntime, status = 'completed', details = {}) {
  const runRef = turnRuntime?.runRef || turnRuntime
  if (!runRef?.projectId || !runRef?.runId) return null

  const turn = turnItemStore.finishTurn(runRef, status, details)
  const run = taskRuns.finishRun(runRef, status, details)
  return {
    runtime: RUNTIME_VERSION,
    runRef,
    turn,
    run
  }
}

function event(turnRuntime, type, payload = {}) {
  const runRef = turnRuntime?.runRef || turnRuntime
  return taskRuns.event(runRef, type, payload)
}

function addAgentMessage(turnRuntime, content, options = {}) {
  const runRef = turnRuntime?.runRef || turnRuntime
  return turnItemStore.addAgentMessage(runRef, content, options)
}

function createItem(turnRuntime, item = {}) {
  const runRef = turnRuntime?.runRef || turnRuntime
  return turnItemStore.createItem(runRef, item)
}

function updateItem(turnRuntime, itemId, patch = {}) {
  const runRef = turnRuntime?.runRef || turnRuntime
  return turnItemStore.updateItem(runRef, itemId, patch)
}

function completeItem(turnRuntime, itemId, result, options = {}) {
  const runRef = turnRuntime?.runRef || turnRuntime
  return turnItemStore.completeItem(runRef, itemId, result, options)
}

module.exports = {
  RUNTIME_VERSION,
  normalizeTurnMetadata,
  buildCapabilityPlanPrompt,
  buildCapabilityCatalogPrompt: capabilityCatalog.buildPrompt,
  resolveCapabilitiesForTurn: capabilityCatalog.resolveForTurn,
  planModelRoutes,
  getConfiguredModels,
  resolveCapabilityModel,
  capabilityCatalog,
  startTurn,
  finishTurn,
  event,
  addAgentMessage,
  createItem,
  updateItem,
  completeItem
}
