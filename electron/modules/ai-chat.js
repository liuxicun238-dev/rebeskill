/**
 * AI对话处理模块
 * 负责系统提示生成、消息处理、工具调用循环
 *
 * 多会话窗口仅支持用户手动对话，不向主聊天 AI 暴露任务指派能力。
 *
 * 上下文管理优化：
 * - 大部分工具结果按类型压缩；命令输出保留完整结果
 * - 发送给API时按工具类型控制上下文体积
 */

const fs = require('fs')
const path = require('path')
const config = require('./config')
const projects = require('./projects')
const { executeToolForProject } = require('./tools')
const { parseToolArgs, buildToolArgsParseErrorResult } = require('./tool-args-parser')
const { createToolFailureRecoveryTracker } = require('./tool-failure-recovery')
const { createRepeatToolReminderTracker } = require('./chat/repeat-tool-reminder')
const {
  classifyLlmFailure,
  createLlmRequestError,
  parseRetryAfterMs,
  isEmptyModelCompletion,
  waitForLlmRetry,
  withLlmRequestRetries,
  resolveRetryDelayMs
} = require('./chat/llm-error-policy')
const { recoverContextOverflow, pruneHistoricalToolResults } = require('./chat/context-overflow-recovery')
const { collectCompletedToolEvidence } = require('./chat/tool-pairing')
const stepAssembly = require('./chat/step-assembly')
const { buildContextPayload } = require('../tools/context-builder')
const changeSessions = require('./change-sessions')
const {
  buildTaskFocusPrompt,
  isWebUiTask,
  detectTaskType
} = require('./agent-runtime')
const { buildPrimaryRolePrompt } = require('./agents/agent-router')
const { hasCapability, normalizeModel } = require('./model-capabilities')
const { analyzeImagesWithVisionModel, buildImageMetadataNote, prepareImages, probeImageDimensions } = require('./vision-relay')
const artifacts = require('./artifacts')
const taskRuns = require('./task-runs')
const contextCompression = require('./context-compression')
const requestHistoryWindow = require('./request-history-window')
const {
  resolveConfiguredModelContextLimit,
  resolveModelContextLimit,
  buildContextBudget
} = require('./model-context-policy')
const taskLedger = require('./task-ledger')
const workerModel = require('./worker-model')
const researchMode = require('./research-mode')
const projectModes = require('./project-mode')
const agentTeamRuntime = require('./agent-team-runtime')
const capabilityState = require('./capability-state')
const memoryOrganizer = require('./memory-organizer')
const designStyleMemory = require('./design-style-memory')
const storageConfig = require('./storage-config')
const { hasApiKey } = require('./api-key')
const observability = require('./observability')
const careReminder = require('./care-reminder')
const backgroundReplySound = require('./background-reply-sound')
const aiOperationMemos = require('./ai-operation-memos')
const { stableJsonStringify, observePromptStability } = require('./prompt-stability')
const {
  estimateModelCost: estimateModelCostForUsage,
  getModelCostProfile: getModelCostProfileForUsage
} = require('./model-cost-estimator')
const cloudTokenUsage = require('./cloud-token-usage')
const {
  isMiniMaxM3Model,
  expectsNativeReasoningStream,
  getApiFormat,
  buildApiEndpoint,
  buildApiHeaders,
  buildApiFetchOptions,
  shouldAvoidPersistentModelConnection,
  isPreResponseSocketCloseError,
  retryPreResponseSocketClose,
  buildModelRequestBody,
  formatModelTransportError,
  createAnthropicStreamState,
  parseGeminiStreamPayload,
  parseModelStreamEvent,
  extractModelResponseContent,
  stopLocalOllamaModelAfterReply
} = require('./model-api-adapter')
const interjectRunner = require('./interject-runner')
const turnLifecycle = require('./chat/turn-lifecycle')
const turnItemStore = require('./chat/turn-item-store')
const lingxiHarness = require('./lingxi-harness')
const turnEventBus = require('./chat/turn-event-bus')
const { normalizePromptCacheUsage, getPromptCacheCapability, calculatePromptCacheRate } = require('./prompt-cache-capabilities')
const systemPromptBuilder = require('./system-prompt-builder')
const {
  getExecutionModeDesc,
  getExecutionModeRules,
  setUserLanguage,
  getUserLanguage,
  buildBehaviorStylePrompt,
  detectWorkbenchMentions,
  getDisabledWorkbenchTools,
  formatPromptCacheTimeBucket,
  getRuntimeContextPrompt,
  getSystemPrompt,
  WORKBENCH_TOOL_NAMES
} = systemPromptBuilder
const { buildTurnWorkflowPrompt } = require('./workflow-playbooks')
const { hasInternalInstructionLeak, stripInternalInstructionLeaks } = require('./internal-instruction-filter')
const progressNarration = require('./progress-narration')
const { sendThinkingEvent } = require('./thinking-event-sender')
const { isChatGptWebBridgeModel, isClaudeWebBridgeModel, isGeminiWebBridgeModel, isGeminiSparkAgentModel, isChatGptWebChatVisionModel } = require('./capability-tiers')
const {
  isWebThinkingPlaceholder,
  classifyWebBridgeAssistantReply,
  clipWebBridgeThinkingNote,
  extractWebBridgeFinalReply,
  extractWebBridgeStageNote,
  normalizeWebBridgeFinalBody,
  isWebBridgeNoToolsRefusal,
  shouldNudgeWebBridgeForMissingTools,
  buildWebBridgeKeepGoingPrompt,
  buildWebBridgeStageReplyPrompt,
  buildWebBridgeOpeningStagePrompt,
  buildWebBridgeCompleteStepPrompt,
  buildWebBridgeNoToolsNudgePrompt,
  shouldRequestWebBridgeStage,
  shouldHoldWebBridgeToolsForOpeningStage,
  shouldParkWebBridgeOpeningStageFromText,
  shouldPromoteWebBridgeTextToFinal,
  looksLikeWebBridgeChitchat,
  looksLikeWebBridgeInspectQuestion,
  looksLikeWebBridgeDirectEditTask,
  looksLikeWebBridgeConfirmStall,
  looksLikeWebBridgeFuturePlan,
  looksLikeWebBridgeDumpedPrompt,
  needsWebBridgeToolEvidence,
  isWebBridgePlanToolBatch,
  partitionWebBridgeOpeningToolCalls,
  isWebBridgeReadOnlyToolBatch,
  shouldSkipWebBridgeStageForExecute,
  extractWebBridgeProjectPath,
  collectUnresolvedBlockingWebBridgeWriteDiagnostics,
  buildWebBridgeBlockingWriteFixPrompt,
  shouldAcceptWebBridgeFinalReply,
  buildWebBridgeStageFinalRejectPrompt,
  buildWebBridgeInspectKeepGoingPrompt,
  webBridgeInspectNeedsMore,
  normalizeWebToolCallArgs,
  WEB_BRIDGE_KEEP_GOING_MAX,
  WEB_BRIDGE_DIALECT_JSON_FENCE
} = require('./web-bridge-coding-protocol')

const CONTEXT_STATUS_CACHE_TTL_MS = 30000
// 默认关闭高频日志，避免长跑时主进程日志拖慢事件循环。需要时设 LINGXI_AI_CHAT_VERBOSE=1
const AI_CHAT_VERBOSE = process.env.LINGXI_AI_CHAT_VERBOSE === '1'
let turnEventBridgeBound = false
function chatVerboseLog(...args) {
  if (AI_CHAT_VERBOSE) console.log(...args)
}

function estimateChars(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return value.length
  try {
    return stableJsonStringify(value).length
  } catch {
    try {
      return JSON.stringify(value).length
    } catch {
      return String(value).length
    }
  }
}

function countRequestTools(body = {}) {
  if (Array.isArray(body.tools)) return body.tools.length
  if (Array.isArray(body.tool_config?.tools)) return body.tool_config.tools.length
  return 0
}

function buildRequestBodyProfile(body = {}) {
  const requestChars = estimateChars(body)
  const toolChars = estimateChars(body.tools || body.tool_config?.tools || [])
  const requestMessages = Array.isArray(body.messages) ? body.messages : []
  const reasoningReplayMessages = requestMessages.filter(item => typeof item?.reasoning_content === 'string' && item.reasoning_content).length
  const reasoningReplayChars = requestMessages.reduce((sum, item) => sum + String(item?.reasoning_content || '').length, 0)
  return {
    requestChars,
    requestEstTokens: Math.ceil(requestChars / 4),
    toolCount: countRequestTools(body),
    toolSchemaChars: toolChars,
    toolSchemaEstTokens: Math.ceil(toolChars / 4),
    reasoningReplayMessages,
    reasoningReplayChars
  }
}

function waitForCacheSettle(delayMs = 0, signal = null) {
  const waitMs = Math.max(0, Number(delayMs) || 0)
  if (!waitMs) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, waitMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(createAbortError())
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function getDeepSeekCacheSettleTargetMs(modelConfig = {}, cacheRate = null) {
  const configuredBase = Number(modelConfig.deepSeekCacheSettleMs ?? modelConfig.deepseek_cache_settle_ms)
  const configuredLowHit = Number(modelConfig.deepSeekLowHitCacheSettleMs ?? modelConfig.deepseek_low_hit_cache_settle_ms)
  const baseMs = Number.isFinite(configuredBase)
    ? Math.max(0, Math.min(15000, configuredBase))
    : 3000
  if (!baseMs) return 0

  const lowHitMs = Number.isFinite(configuredLowHit)
    ? Math.max(baseMs, Math.min(15000, configuredLowHit))
    : Math.max(baseMs, 5000)
  const rate = Number(cacheRate)
  return Number.isFinite(rate) && rate < 90 ? lowHitMs : baseMs
}

function shouldBridgeDeepSeekMultiToolBatch(modelConfig = {}, endpoint = '', modelId = '', toolCalls = []) {
  const explicit = modelConfig.deepSeekMultiToolCacheBridge ?? modelConfig.deepseek_multi_tool_cache_bridge
  if (explicit === false || explicit === 'false' || explicit === 'off' || explicit === 'disabled') return false
  return getPromptCacheCapability(modelConfig, endpoint, modelId).id === 'deepseek' &&
    Array.isArray(toolCalls) && toolCalls.length > 1
}

function clipDeepSeekToolBatchItem(value, maxChars = 12000) {
  const text = JSON.stringify(value)
  if (text.length <= maxChars) return text
  const tailChars = 2400
  const headChars = maxChars - tailChars - 80
  return `${text.slice(0, headChars)}\n...[tool result clipped ${text.length - headChars - tailChars} chars]...\n${text.slice(-tailChars)}`
}

function buildDeepSeekMultiToolCacheBridge(items = []) {
  const batch = Array.isArray(items) ? items.filter(Boolean) : []
  // hidden: never show in chat UI / history panel as user text.
  // _deepseekBridge: keep in model context for DeepSeek prefix cache continuity.
  return [
    {
      role: 'assistant',
      content: `Lingxi executed ${batch.length} requested tools in parallel and consolidated their results for continuation.`,
      hidden: true,
      _deepseekBridge: true
    },
    {
      role: 'user',
      content: [
        '[Lingxi internal parallel tool batch results]',
        'These are actual tool results from the current task. Continue from them without repeating completed calls.',
        ...batch.map((item, index) => clipDeepSeekToolBatchItem({ index, ...item }))
      ].join('\n'),
      hidden: true,
      _deepseekBridge: true
    }
  ]
}

// 提问信号识别：低信号/纯寒暄/能力问询类消息不需要加载项目上下文。
const NAVIGATION_NEEDED_RE = /查看|看看|检查|定位|搜索|查找|找出|修复|改进|优化|实现|增加|接入|清理|删除|重构|构建|打包|测试|验证|运行|启动|报错|错误|失败|崩溃|卡死|白屏|项目|代码|文件|函数|调用链|工具|前端|UI|界面|设置|模型|diff|history|render|bug|error|crash|build|test|verify|code|file|tool|frontend|setting|model/i
const LOW_SIGNAL_RE = /^(你好|您好|谢谢|感谢|继续|好的|嗯|行|可以|为什么|是什么|区别|大白话说|你觉得呢|是真的吗|对吗|上下文容量是多少|官方.*上下文|how much|what is|why)$/i

function shouldSkipNavigation(userMessage = '') {
  const text = String(userMessage || '').trim()
  if (!text) return true
  if (NAVIGATION_NEEDED_RE.test(text)) return false
  if (text.length <= 24 && LOW_SIGNAL_RE.test(text)) return true
  if (text.length <= 100 && /上下文容量|官方.*上下文|轮和条.*区别|条和轮.*区别/.test(text)) return true
  if (text.length <= 80 && /^(为什么|是什么|区别|怎么理解|大白话|你觉得|是真的吗|对吗)/.test(text)) return true
  return false
}

function shouldUseProjectContext(userMessage = '') {
  if (shouldSkipNavigation(userMessage)) return false
  return true
}

// 会话级上下文加载粘性：一旦某会话加载过设计风格/历史项目上下文，后续请求保持加载，
// 避免关键词变化导致前缀波动、prefix cache 失效。
const sessionContextStickyFlags = new WeakMap()

function getStickyFlags(instance) {
  if (!instance || typeof instance !== 'object') return null
  let flags = sessionContextStickyFlags.get(instance)
  if (!flags) {
    flags = { designStyle: false, historicalProject: false }
    sessionContextStickyFlags.set(instance, flags)
  }
  return flags
}

function shouldUseDesignStyleContext(userMessage = '', instance = null) {
  const text = String(userMessage || '')
  const matched = /UI|界面|前端|网页|网站|页面|样式|设计|美化|布局|主题|暗色|浅色|颜色|视觉|复刻|资源中心|资产|缩略图|website|frontend|design|style|layout|theme|visual/i.test(text)
  // 粘性：一旦本会话命中过设计风格关键词，后续保持加载
  const sticky = getStickyFlags(instance)
  if (sticky) {
    if (matched) sticky.designStyle = true
    return sticky.designStyle
  }
  return matched
}

function shouldProbeStreamUsageByDefault(modelConfig = {}, endpoint = '', modelId = '', apiFormat = '') {
  const explicit = modelConfig.streamUsage ?? modelConfig.stream_usage ?? modelConfig.includeUsage ?? modelConfig.include_usage
  if (explicit === false || explicit === 'false' || explicit === 'off' || explicit === 'disabled') return false
  if (explicit === true || explicit === 'true' || explicit === 'on' || explicit === 'enabled') return true
  if (apiFormat && apiFormat !== 'openai') return true
  const capability = getPromptCacheCapability(modelConfig, endpoint, modelId)
  return [
    'openai',
    'deepseek',
    'qwen',
    'glm',
    'volcengine',
    'moonshot',
    'minimax',
    'mimo',
    'anthropic',
    'tencent-tokenhub',
    'apikey-fun',
    'xai'
  ].includes(capability.id)
}

const contextStatusCache = new Map()

function getContextStatusCacheKey(projectId, modelName, instance) {
  const history = Array.isArray(instance?.messagesHistory) ? instance.messagesHistory : []
  const last = history[history.length - 1] || null
  const lastStamp = [
    history.length,
    last?.role || '',
    last?.time || last?.completedAt || last?.createdAt || '',
    String(last?.content || last?.displayContent || '').length
  ].join(':')
  return `${projectId || ''}|${modelName || ''}|${lastStamp}`
}

function clearContextStatusCache(projectId) {
  if (!projectId) {
    contextStatusCache.clear()
    return
  }
  const prefix = `${projectId}|`
  for (const key of contextStatusCache.keys()) {
    if (key.startsWith(prefix)) contextStatusCache.delete(key)
  }
}

function resolveStatusModelDescriptor(projectId, modelDescriptor = null) {
  const descriptor = modelDescriptor && typeof modelDescriptor === 'object'
    ? modelDescriptor
    : { modelName: String(modelDescriptor || '') }
  const directLimit = resolveConfiguredModelContextLimit(descriptor)
  if (directLimit > 0) {
    return { ...descriptor, contextWindow: directLimit }
  }
  let models = []
  let projectRef = {}
  try {
    const apiConfig = storageConfig.getApiConfig()
    models = Array.isArray(apiConfig?.data?.models) ? apiConfig.data.models : []
    const projectsList = storageConfig.getProjectsList()
    projectRef = Array.isArray(projectsList?.data)
      ? projectsList.data.find(project => String(project?.id || '') === String(projectId || '')) || {}
      : {}
  } catch (error) {
    console.warn('[AIChat] resolve persisted model context failed:', error.message)
  }
  const configuredLimit = resolveConfiguredModelContextLimit(descriptor, models, projectRef)
  const persistedModel = configuredLimit > 0
    ? models.find(model => {
      const wantedKey = String(descriptor.modelKey || projectRef.modelKey || '').trim()
      if (wantedKey && String(model?.modelKey || '').trim() === wantedKey) return true
      const wantedNames = [descriptor.modelName, descriptor.modelId]
        .map(value => String(value || '').trim().toLowerCase())
        .filter(Boolean)
      const modelNames = [model?.modelName, model?.modelId]
        .map(value => String(value || '').trim().toLowerCase())
        .filter(Boolean)
      return wantedNames.some(name => modelNames.includes(name))
    })
    : null
  return {
    ...descriptor,
    modelKey: descriptor.modelKey || projectRef.modelKey || persistedModel?.modelKey || '',
    modelName: descriptor.modelName || persistedModel?.modelName || '',
    modelId: descriptor.modelId || persistedModel?.modelId || '',
    contextWindow: configuredLimit
  }
}

const {
  isUserRequestRestatement,
  isNonProgressNarration,
  normalizeProgressStatus,
  normalizeProgressNarration,
  summarizeProgressText,
  createProgressStatusParser,
  createProgressNarrationTracker,
  createToolArgumentProgressTracker,
  isProcessOnlyContinuationText
} = progressNarration
const {
  sanitizeFinalContent,
  normalizeCacheUsage,
  PLAN_CONTROL_TOOLS,
  parseToolArgsSafe,
  isProgressToolCall,
  getProgressToolStatus,
  emitProgressToolStatus,
  isInternalUiOnlyToolName
} = require('./chat-helpers')

// 拆分到 chat/ 目录的子模块
const {
  createAbortError, createApiTimeoutError, isApiTimeoutError, isAbortError,
  throwIfAborted, stripHtmlErrorBody, formatApiHttpError, clampTimeoutMs,
  getApiTimeouts, formatTimeoutSeconds, createApiTimeoutWatchdog
} = require('./chat/api-error-timeout')
const { runBackgroundTask } = require('./chat/background-tasks')
const {
  isToolStatusOnlyFinalContent, isReviewOnlyFinalContent, actionLabel,
  fileBaseName, buildChangeSessionFinalFallback, ensureUsableFinalContent
} = require('./chat/change-session-fallback')
const {
  normalizeReferences, clipReferenceText, buildReferencedContextBlock, sanitizeUserVisibleContent
} = require('./chat/reference-context')
const { pruneExpiredImageAttachments, normalizeFullHistoryForModel } = require('./chat/history-normalizer')
const unstartedTurnRecall = require('./chat/unstarted-turn-recall')
const {
  getToolTargetText, hasTouchedPreviousChangeDomain,
  summarizePostEditDiagnostics
} = require('./chat/diagnostics-summarizer')
const {
  summarizeToolResult, summarizeToolResultForHistory, summarizeToolResultForModel
} = require('./chat/tool-result-summarizer')
const toolOutputSpill = require('./chat/tool-output-spill')
const { partitionToolWaves } = require('./chat/tool-batch-scheduler')
const { buildCurrentModelCapabilityPrompt } = require('./chat/model-capability-prompt')
const {
  normalizeToolPath, getToolTargetPath, isCrossFileSearchCall, isWriteLikeToolCall,
  isLargeEntryRead, isEntryOrAssemblyPath, getReadContentSample, hasAssemblyLayerSignals,
  getRecentEntryAssemblyDrift, getRecentRepeatedReadTarget, isFailedPreciseEdit,
  getRecentPreciseEditFailure, extractSearchLiteral, getRecentFragmentedSearch
} = require('./chat/exploration-strategy')
const {
  safeJsonStringify, summarizeToolArgsForRunLog, readFiniteNumber
} = require('./chat/json-utils')
const {
  getLedgerContextMaxItems, shouldIncludeHistoricalProjectContext, isFollowupExpansionIntent, createAiSafetySnapshot
} = require('./chat/intent-safety')
const {
  NAVIGATION_FIRST_TOOLS, MANUAL_LOCATION_TOOLS, WRITE_LIKE_TOOLS,
  PRECISE_MODIFICATION_TOOLS, EDIT_GROUNDING_TOOLS,
  hasWriteToolCall, getToolCallName, parseToolCallArgs, hasExplicitSingleFileTarget,
  shouldRerouteManualLocationFirst,
  buildNavigationFirstRerouteInstruction,
  isSourceLikePath, collectToolArgPaths, getModificationTargetPaths,
  hasPriorEditGrounding, hasDirectUserProvidedEdit, shouldReroutePrematureModification,
  shouldSplitLargeToolBatch, shouldSplitToolSectionBatch,
  shouldRerouteToolStatusMismatch
} = require('./chat/modification-reroute')
const {
  uniqueRouteList, normalizeRoutePathValue, collectRoutePaths, getChangeSessionFiles,
  isSearchCommandText, isVerificationCommandText, buildTaskRouteRecord
} = require('./chat/task-route-tracker')
const {
  isExplicitBlenderPathIntent, hasBlenderToolPath, hasNoRelayIntent, hasNoBlenderIntent,
  get3DWorkflowRoute
} = require('./chat/workflow-3d-router')
const {
  getToolCallNames, hasSuccessfulToolCall, getLastSuccessfulToolResult, getLastToolCall,
  extractImagePathsFromImageData, isLocalImageReferencePath, extractGeneratedImagePath
} = require('./chat/tool-call-helpers')
const { registerFileIpcHandlers } = require('./chat/file-ipc-handlers')
const runtimeVerificationGate = require('./runtime-verification-gate')
const featureSettings = require('./feature-settings')
const planProgress = require('./plan-progress')
const workspaceInstructions = require('./workspace-instructions')
const projectInspectEvidence = require('./project-inspect-evidence')

const unsupportedStreamUsageKeys = new Set()
const POST_WRITE_VERIFY_TOOLS = new Set(['check_syntax', 'check_project_syntax', 'post_change_verify', 'code_verify', 'dev_workflow'])
const POST_WRITE_VERIFY_EXEMPT_TOOLS = new Set(['create_directory', 'render_svg_asset', 'file_manage', 'media_process'])
const PROGRESS_PANEL_TOOLS = new Set(['complete_step'])

function createStreamPayloadError(json = {}) {
  const payload = json?.error || (json?.type === 'error' ? json.error : null)
  if (!payload) return null
  const code = String(payload.code || payload.type || json.code || 'MODEL_STREAM_ERROR').trim()
  const message = String(payload.message || payload.error || json.message || '模型上游返回流式错误').trim()
  const error = new Error(code ? `模型上游错误 (${code}): ${message}` : `模型上游错误: ${message}`)
  error.name = 'ModelStreamPayloadError'
  error.code = code || 'MODEL_STREAM_ERROR'
  error.isModelStreamPayloadError = true
  const classified = classifyLlmFailure({ error, body: `${code} ${message}` })
  error.llmCode = classified.code
  return error
}

function isProjectReviewIntent(message = '') {
  return /(审查项目|项目审查|扫描项目|整体审查|全项目|工程审查|代码库|仓库|repo|架构|模块化|安全审查|敏感信息|测试覆盖|自动测试)/i.test(String(message || ''))
}

function isBusinessToolName(name = '') {
  return name && !isInternalUiOnlyToolName(name) && !PROGRESS_PANEL_TOOLS.has(String(name || ''))
}

function hasPostWriteVerification(toolCalls = []) {
  let sawWrite = false
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = String(call?.name || '')
    if (!sawWrite && hasWriteToolCall([call])) {
      sawWrite = true
      if (hasSuccessfulInlinePostEditDiagnostics(call)) return true
      continue
    }
    if (!sawWrite) continue
    if (hasWriteToolCall([call]) && hasSuccessfulInlinePostEditDiagnostics(call)) return true
    if (POST_WRITE_VERIFY_TOOLS.has(name)) {
      if (name === 'code_verify') {
        const action = String(call?.args?.action || call?.result?._tool_route?.action || '').toLowerCase()
        if (!action || /file|project|changes|verify|syntax/.test(action)) return true
        continue
      }
      if (name !== 'dev_workflow') return true
      const mode = String(call?.args?.mode || call?.result?.mode || '').toLowerCase()
      if (!mode || /verify|syntax|review|triage/.test(mode)) return true
    }
    if (name === 'shell_run' || name === 'run_command') {
      const command = String(call?.args?.command || call?.args?.cmd || '')
      if (/\bnode\s+--check\b|\bnpm\s+(?:run\s+)?(?:test|build|check|verify)\b|\btsc\b|\beslint\b|\bvitest\b|\bjest\b|\bpytest\b|\bpython\s+-m\s+py_compile\b/i.test(command)) return true
    }
  }
  return false
}

function hasSuccessfulInlinePostEditDiagnostics(call = {}) {
  const diagnostics = call?.result?.postEditDiagnostics
  if (!diagnostics || typeof diagnostics !== 'object') return false
  if (diagnostics.ok !== true) return false
  if (call?.result?.requires_fix === true || call?.result?.requires_runtime_review === true) return false
  if (Number(diagnostics.failed_count || 0) > 0) return false
  if (Array.isArray(diagnostics.failed_files) && diagnostics.failed_files.length > 0) return false
  if (Array.isArray(diagnostics.unknown_files) && diagnostics.unknown_files.length > 0) return false
  return true
}

function hasWriteToolNeedingPostVerification(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).some(call => {
    if (!hasWriteToolCall([call])) return false
    const name = String(call?.name || '')
    return !POST_WRITE_VERIFY_EXEMPT_TOOLS.has(name)
  })
}

function hasSuccessfulGeminiDirectWrite(toolCalls = []) {
  return (Array.isArray(toolCalls) ? toolCalls : []).some(call => (
    hasWriteToolCall([call]) && call?.result?.success !== false && !call?.result?.error
  ))
}

function hasSuccessfulGeminiDirectPostWriteVerification(toolCalls = []) {
  let latestWriteIndex = -1
  const calls = Array.isArray(toolCalls) ? toolCalls : []
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]
    if (hasWriteToolCall([call]) && call?.result?.success !== false && !call?.result?.error) {
      latestWriteIndex = index
    }
  }
  if (latestWriteIndex < 0) return false
  return calls.slice(latestWriteIndex + 1).some(call => {
    if (call?.result?.success === false || call?.result?.error) return false
    const name = String(call?.name || '')
    if (POST_WRITE_VERIFY_TOOLS.has(name)) return true
    if (name !== 'shell_run' && name !== 'run_command') return false
    const command = String(call?.args?.command || call?.args?.cmd || '')
    return /\bnode\s+--check\b|\bnpm\s+(?:run\s+)?(?:test|build|check|verify)\b|\btsc\b|\beslint\b|\bvitest\b|\bjest\b|\bpytest\b|\bpython\s+-m\s+py_compile\b/i.test(command)
  })
}

function normalizeGeminiDirectToolResultForModel(toolName = '', result = {}) {
  const name = String(toolName || '')
  if (name !== 'shell_run' && name !== 'run_command') return result
  if (!result || typeof result !== 'object' || result.internal || result.aborted) return result

  const exitCode = Number(result.exit_code)
  const hasExitCode = Number.isFinite(exitCode)
  const errorType = String(result.error_type || '').toLowerCase()
  const completedWithNonZeroExit = result.success === false && hasExitCode &&
    (errorType === 'command_failed' || errorType === 'command_nonzero_exit')
  const completedSuccessfully = result.success !== false && (!hasExitCode || exitCode === 0)

  if (completedWithNonZeroExit) {
    return {
      ...result,
      // 对 Gemini 直连的模型侧协议，success 表示工具基础设施是否成功执行。
      // 测试失败由 command_passed 单独表达；原始 result 仍用于 UI 和完成门禁。
      success: true,
      process_completed: true,
      command_passed: false,
      diagnostic_failure: true,
      result_type: 'process_exit'
    }
  }
  if (completedSuccessfully) {
    return {
      ...result,
      process_completed: true,
      command_passed: true,
      result_type: result.result_type || 'process_exit'
    }
  }
  return result
}

function looksLikeGeminiDirectMutationTask(text = '') {
  const value = String(text || '').replace(/当前项目路径：\s*[^\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!value) return false
  if (looksLikeWebBridgeDirectEditTask(value)) return true
  if (/(?:只读|只看|只检查|仅检查|不要修改|无需修改|禁止修改|别改|先别改|不改文件)/i.test(value)) return false
  return /修改|改掉|改成|替换|修复|实现|新增|添加|删除|移除|重构|写入|创建|开发|补齐|接入|迁移|优化|edit|modify|fix|implement|add|remove|refactor|create|write/i.test(value)
}

function buildGeminiDirectCompletionGatePrompt(userMessage = '', toolCalls = []) {
  if (!looksLikeGeminiDirectMutationTask(userMessage)) return ''
  if (!hasSuccessfulGeminiDirectWrite(toolCalls)) {
    return [
      '原始用户目标是修改/修复项目，但目前只有定位或读取证据，还没有任何成功的写入。',
      '这不是可收口状态。禁止最终回复，也不要再汇报目录或重复搜索。',
      '现在必须根据已读取的真实源码调用 text_edit、apply_patch 或 file_manage 完成最小正确修改；apply_patch 必须使用 *** Begin Patch / *** End Patch 格式。'
    ].join('\n')
  }
  if (!hasSuccessfulGeminiDirectPostWriteVerification(toolCalls)) {
    return [
      '项目已经发生写入，但最新写入之后还没有成功的类型检查、测试或构建证据。',
      '这不是可收口状态。禁止最终回复。',
      '现在调用 shell_run 执行用户要求的最窄验证；验证失败就继续读错误位置并修复，直到验证成功。shell_run 只用于诊断和验证，禁止写源码。'
    ].join('\n')
  }
  return ''
}

function buildPostWriteVerifyNudge(toolCalls = []) {
  const changedPaths = getModificationTargetPaths(toolCalls)
  return [
    '改后复查要求：本轮已经写入或修改了文件，但还没有看到改后验证。',
    changedPaths.length ? `只验证这些改动目标：${changedPaths.slice(0, 8).join('、')}。` : '',
    '请只调用一次最窄的 code_verify（action=file/project/changes）或 dev_workflow mode=verify。',
    '不要重新理解需求、不要扩大搜索、不要重读无关文件；验证失败时才 file_read 错误行或 code_inspect action=git_diff。'
  ].filter(Boolean).join('\n')
}

function getRuntimeGateFeatureFlags() {
  try {
    return {
      runtime_verify: featureSettings.isFeatureEnabled('runtime_verify'),
      runtime_verify_hard_gate: featureSettings.isFeatureEnabled('runtime_verify_hard_gate')
    }
  } catch {
    return { runtime_verify: true, runtime_verify_hard_gate: true }
  }
}

function evaluateRuntimeGateForChat({
  taskType = '',
  userMessage = '',
  toolCalls = [],
  recoveryAttempts = 0
} = {}) {
  let webUi = false
  let resolvedTaskType = cleanTaskType(taskType)
  try {
    webUi = isWebUiTask(userMessage || '', '')
  } catch {
    webUi = false
  }
  if (!resolvedTaskType) {
    try {
      resolvedTaskType = detectTaskType(userMessage || '') || ''
    } catch {
      resolvedTaskType = ''
    }
  }
  return runtimeVerificationGate.classifyRuntimeGate({
    taskType: resolvedTaskType,
    userMessage,
    toolCalls,
    featureFlags: getRuntimeGateFeatureFlags(),
    isWebUiTask: webUi,
    recoveryAttempts
  })
}

function cleanTaskType(value = '') {
  return String(value == null ? '' : value).trim().toLowerCase()
}

// 工具失败时生成针对性修复引导，写入 tool 结果的 next_action 字段
// 避免模型盲目重试同一失败工具或直接放弃
function buildToolFailureGuidance(toolName, result) {
  if (!result || result.success !== false) return ''
  if (result.next_action) return String(result.next_action)
  const errorType = result.error_type || ''
  const errorMsg = String(result.error || result.message || '')

  // 超时类：引导改用 shell_run 缩小范围
  if (errorType === 'command_timeout' || /timeout|timed out|ETIMEDOUT/i.test(errorMsg)) {
    return `${toolName} 超时。若是长任务（dev/build/test），用 shell_run 缩小命令范围或拆分步骤；不要原样重试。`
  }
  // 命令不存在：引导改用项目内搜索工具
  if (errorType === 'command_not_available' || /not recognized|command not found|ENOENT|不是内部或外部命令/i.test(errorMsg)) {
    return `${toolName} 命令不存在。改用 code_inspect action=grep/locate 或 file_search action=glob 完成事实定位，不要重试该命令。`
  }
  // 路径无效：引导先定位
  if (errorType === 'not_a_file' || errorType === 'not_found' || errorType === 'path_not_found' || /path not found|no such file|not a file|不存在|无法找到/i.test(errorMsg)) {
    const projectRoot = String(result.project_root || '').replace(/\\/g, '/').trim()
    if (/[a-z]:\/demo(?=$|\/)/i.test(String(result.requested_path || result.resolved_path || errorMsg).replace(/\\/g, '/'))) {
      return projectRoot
        ? `${toolName} 不要再搜 E:/demo。这是示例路径。立刻用当前项目路径 ${projectRoot} 重新 file_search。`
        : `${toolName} 不要再搜 E:/demo。这是示例路径，必须用用户消息里的当前项目路径。`
    }
    return projectRoot
      ? `${toolName} 路径无效。改用当前项目路径 ${projectRoot}，不要重试刚才那个错误路径。`
      : `${toolName} 路径无效。先用当前项目路径重新 file_search，不要重试刚才那个错误路径。`
  }
  // 精确编辑匹配失败：引导先读取当前内容
  if (['edit_file', 'text_edit', 'apply_patch', 'json_edit'].includes(toolName) ||
      /old_content|not\s+found|no\s+match|does\s+not\s+contain|未找到|找不到|不包含|没有找到/i.test(errorMsg)) {
    return `${toolName} 匹配失败。先用 file_read action=one 读取目标文件当前内容（按行段），用最新内容重新构造 old_content，再重试。不要用记忆中的旧片段。`
  }
  // 验证工具错误：引导改用正确验证工具
  if (errorType === 'wrong_verification_tool') {
    return result.recommended_tool
      ? `改用 ${result.recommended_tool.name} 验证这些文件。`
      : '改用 code_verify action=file 按文件扩展名路由验证。'
  }
  // 权限拒绝：引导说明而非重试
  if (errorType === 'permission_denied' || /permission|denied|EACCES|权限/i.test(errorMsg)) {
    return `${toolName} 权限不足。不要重试；在最终回复里说明权限阻塞，建议用户手动授权或调整路径。`
  }
  // 用户拒绝：不重试
  if (result.status === 'user_rejected') {
    return `${toolName} 被用户拒绝。不要重试；基于已有结果继续处理或收尾。`
  }
  // 通用：建议换策略而非重试
  if (errorMsg) {
    return `${toolName} 失败：${errorMsg.slice(0, 200)}。请分析错误原因后调整参数或换用替代工具，不要原样重试。`
  }
  return ''
}

function isOperationMemoBackfillMessage(message = '') {
  return String(message || '').includes('【AI操作备忘录补录任务】')
}

/**
 * 注册AI对话 IPC handlers
 */
function registerChatIPC(ipcMain) {
  if (!turnEventBridgeBound) {
    turnEventBridgeBound = true
    turnEventBus.onTurnEvent(payload => {
      if (!payload?.projectId) return
      try {
        projects.getWebContentsForProject(payload.projectId)?.send('turn-event', payload)
      } catch (_) {
        // Renderer may be closing during project switches; persistence remains authoritative.
      }
    })
  }

  // 发送消息（支持多项目并行，支持图片）
  ipcMain.on('send-message', async (event, requestId, projectId, message, modelConfig, history = [], skillContent = null, executionMode = 'auto', agentMode = false, imageDataList = [], displayContent = null, hidden = false, visionRelayConfig = null, references = [], directiveBadges = [], projectMode = 'standard', sendFlags = {}) => {
    chatVerboseLog('[AIChat] 收到消息请求, projectId:', projectId, 'message:', message?.substring(0, 50), 'skill:', skillContent ? '有' : '无', 'mode:', executionMode, 'agentMode:', agentMode, 'images:', imageDataList.length)
    
    // 后端防重入：检查是否已有正在运行的会话
    const existingController = config.getAbortController(projectId)
    if (existingController && !existingController.signal.aborted) {
      console.warn('[AIChat] ⚠️ 防重入：项目已有运行中的会话，先中断旧的再启动新的, projectId:', projectId)
      try {
        existingController.abort(createAbortError('被新的会话请求替换'))
      } catch { /* AbortController 已中止 */ }
    }
    
    // 详细输出技能内容（便于调试）
    if (skillContent) {
      chatVerboseLog('[AIChat] 技能内容预览 (前500字符):')
      chatVerboseLog(skillContent.substring(0, 500))
      chatVerboseLog('[AIChat] 技能总长度:', skillContent.length, '字符')
    }

    // 获取项目实例
    const instance = await projects.ensureProjectBranchSession(projectId) || projects.getProjectInstance(projectId)
    const webContents = projects.getWebContentsForProject(projectId)
    if (!instance) {
      console.log('[AIChat] 项目不存在:', projectId)
      webContents?.send('ai-status', { projectId, status: 'error' })
      webContents?.send('message-reply', { projectId, error: `项目不存在 (ID: ${projectId})，请重新选择项目`, done: true })
      event.reply('send-message-response', { requestId, projectId, error: '项目不存在' })
      return
    }

    let authoritativeProjectMode
    try {
      authoritativeProjectMode = projectModes.assertRequestMode(instance, projectMode)
    } catch (error) {
      const errorMessage = '项目模式校验失败：' + (error?.message || error) + '。为防止项目模式交叉污染，本次请求已拒绝。'
      webContents?.send('ai-status', { projectId, status: 'error' })
      webContents?.send('message-reply', { projectId, error: errorMessage, done: true })
      event.reply('send-message-response', {
        requestId,
        projectId,
        error: errorMessage,
        code: error?.code || 'PROJECT_MODE_CONFLICT'
      })
      return
    }

    const { contextManager, projectPath } = instance

    // 使用 modelId 发送API请求（如果没有 modelId 则使用 modelName）
    const effectiveModelId = modelConfig?.modelId || modelConfig?.modelName
    const hasModelCredential = hasApiKey(modelConfig?.apiKey)
    if (!modelConfig?.apiUrl || !hasModelCredential || !effectiveModelId) {
      webContents?.send('ai-status', { projectId, status: 'error' })
      const errorMessage = '请先配置API'
      webContents?.send('message-reply', { projectId, error: errorMessage, done: true })
      event.reply('send-message-response', { requestId, projectId, error: errorMessage })
      return
    }

    // 异步处理，不阻塞其他项目的请求。必须兜底捕获，否则 handleSendMessage
    // 在内部 try 之前抛错时，前端会一直停在“正在思考中”。
    runTrackedSendMessage(event, requestId, projectId, message, modelConfig, history, skillContent, executionMode, agentMode, instance, webContents, contextManager, projectPath, effectiveModelId, imageDataList, displayContent, hidden, visionRelayConfig, references, directiveBadges, authoritativeProjectMode, sendFlags)
      .catch(error => {
        const messageText = error?.message || String(error || '未知错误')
        console.error('[AIChat] ⚠️ handleSendMessage outer catch 诊断:',
          '\n  err.name:', error?.name,
          '\n  err.message:', error?.message,
          '\n  err.code:', error?.code,
          '\n  stack:', error?.stack?.split('\n').slice(0, 5).join('\n    ')
        )
        const timedOut = isApiTimeoutError(error)
        const aborted = !timedOut && isAbortError(error)
        if (aborted) {
          webContents?.send('ai-status', { projectId, status: 'interrupted' })
          event.reply('send-message-response', { requestId, projectId, success: true, interrupted: true })
          return
        }
        webContents?.send('ai-status', { projectId, status: 'error', error: messageText })
        webContents?.send('message-reply', {
          projectId,
          error: messageText,
          done: true,
          completedAt: Date.now()
        })
        event.reply('send-message-response', { requestId, projectId, error: messageText })
      })
  })

  // 中断AI操作
  ipcMain.on('interrupt-ai', (event, projectId, options = {}) => {
    console.log('[AIChat] interrupt-ai IPC 收到, projectId:', projectId, '来源:', event.sender?.getURL?.() || 'unknown')
    const controller = config.getAbortController(projectId)
    const webContents = projects.getWebContentsForProject(projectId)
    const recallUnstarted = !!options?.recallUnstarted
    if (controller) {
      try {
        turnLifecycle.noteInterrupt(projectId, { recallUnstarted })
      } catch (_) { /* 观察台失败不挡中断 */ }
      if (!controller.signal.aborted) {
        controller.abort(createAbortError(
          recallUnstarted ? '用户撤回未发出的消息' : '用户已中断本轮 AI 操作',
          { recallUnstarted }
        ))
      }
      webContents?.send('ai-status', { projectId, status: 'interrupted', recalled: recallUnstarted })
      console.log('[AIChat] AI操作已中断:', projectId, recallUnstarted ? '(recall)' : '')
    }
  })

  // 文件相关 IPC handlers（选择文件、保存粘贴图片、删除临时文件）
  registerFileIpcHandlers(ipcMain)

  // 上下文管理 IPC
  // ===== 上下文状态（修复：返回压缩后的实际大小） =====
  ipcMain.handle('context-status', (event, projectId, modelDescriptor = null) => {
    const descriptor = resolveStatusModelDescriptor(projectId, modelDescriptor)
    const modelName = String(descriptor.modelName || descriptor.modelId || '').trim()
    const configuredLimit = descriptor.contextWindow || descriptor.contextLength || descriptor.maxContextTokens || 0
    try {
      const instance = projects.getProjectInstance(projectId)
      if (!instance) {
        return { error: '项目不存在' }
      }

      const cacheIdentity = `${modelName}|${Number(configuredLimit) || 0}`
      const cacheKey = getContextStatusCacheKey(projectId, cacheIdentity, instance)
      const cached = contextStatusCache.get(cacheKey)
      if (cached && Date.now() - cached.createdAt < CONTEXT_STATUS_CACHE_TTL_MS) {
        return { ...cached.status, cached: true }
      }

      // 增量 token 估算：避免每次遍历整个 messagesHistory
      const messagesHistory = instance.messagesHistory || []
      const contextManager = instance.contextManager

      const estimatedTokens = projects.estimateTokensIncremental(instance)
      const limit = resolveModelContextLimit(modelName, configuredLimit)
      const contextRatio = Math.min(estimatedTokens / limit, 1)

      // 记忆系统状态（完整历史统计）
      const memoryStatus = contextManager.memory.getStatus()
      const summaryStatus = contextManager.summary.getStatus()

      const status = {
        // ===== 实际上下文（发送给API的大小） =====
        estimatedTokens: Math.round(estimatedTokens),
        contextRatio: contextRatio,
        modelLimit: limit,
        historyLength: messagesHistory.length,

        // ===== 对话轮数统计 =====
        tapeLength: messagesHistory.filter(m => m.role === 'user').length,  // 用户消息数 = 对话轮数
        indexSize: memoryStatus.indexSize,  // 关键词数

        // ===== 摘要状态 =====
        summaryCount: summaryStatus.completedCount + summaryStatus.inProgressCount + summaryStatus.pendingCount,

        // ===== 压缩策略说明 =====
        compressionStrategy: '按模型真实窗口和请求 Token 重量自动整理，完整历史保留',

        // 项目路径
        projectPath: instance.projectPath,
        storagePath: instance.storagePath
      }
      contextStatusCache.set(cacheKey, { createdAt: Date.now(), status })
      return status
    } catch (error) {
      console.error('[AIChat] context-status failed:', error)
      return {
        estimatedTokens: 0,
        contextRatio: 0,
        modelLimit: resolveModelContextLimit(modelName, configuredLimit),
        historyLength: 0,
        tapeLength: 0,
        indexSize: 0,
        summaryCount: 0,
        compressionStrategy: '上下文状态读取失败，已降级显示',
        error: error.message
      }
    }
  })

  ipcMain.handle('context-clear', (event, projectId) => {
    const instance = projects.getProjectInstance(projectId)
    if (!instance) {
      return { error: '项目不存在' }
    }
    instance.contextManager.clear()
    instance.messagesHistory = []  // 同时清空后端维护的完整消息历史
    instance._chatHistoryDirty = true
    instance._cachedTokenCount = 0
    instance._lastTokenCalcLength = 0
    clearContextStatusCache(projectId)
    contextCompression.clearSummaries(instance).catch(e => console.warn('[AIChat] clearSummaries failed:', e.message))
    if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(projectId)
    else projects.saveProjectChatHistory(projectId)
    return { success: true }
  })

  ipcMain.handle('context-compression-stack', async (event, projectId, modelDescriptor = null) => {
    try {
      const instance = projects.getProjectInstance(projectId)
      if (!instance) return { success: false, error: '项目不存在' }

      const history = Array.isArray(instance.messagesHistory) ? instance.messagesHistory : []
      const latestRun = taskRuns.listRuns(projectId, { limit: 1 })[0] || null
      const latestTurn = latestRun?.runId
        ? turnItemStore.readTurnSummaryFromJournal(instance.storagePath, latestRun.runId)
        : null
      const latestTurnItemCount = Math.max(0, Number(latestTurn?.itemCount) || 0)
      const latestTurnToolCount = Math.max(0, Number(latestTurn?.toolCount) || 0)
      const latestTurnEvidenceAvailable = latestTurn?.evidenceAvailable === true
      const descriptor = resolveStatusModelDescriptor(projectId, modelDescriptor)
      const lastAuthoredMessage = [...history].reverse().find(message => (
        message?.role === 'assistant' && (message.modelName || message.modelId || message.modelCacheIdentity)
      )) || null
      const modelName = String(
        descriptor.modelName || descriptor.displayName || descriptor.modelId ||
        instance.currentModelName || lastAuthoredMessage?.modelName || lastAuthoredMessage?.modelId || ''
      ).trim()
      const modelId = String(descriptor.modelId || descriptor.model || modelName).trim()
      const latestUserMessage = [...history].reverse().find(message =>
        requestHistoryWindow.isUserTurnMessage(message) && !message.interject
      )
      const followupExpansionIntent = isFollowupExpansionIntent(
        latestUserMessage?.displayContent || latestUserMessage?.content || ''
      )
      const configuredLimit = descriptor.contextWindow || descriptor.contextLength || descriptor.maxContextTokens || 0
      const budget = buildContextBudget(modelName || modelId, configuredLimit)
      const apiEndpoint = descriptor.apiUrl ? buildApiEndpoint(descriptor) : ''
      const apiFormat = getApiFormat(descriptor, apiEndpoint)
      const modelCacheIdentity = requestHistoryWindow.buildModelCacheIdentity({
        provider: descriptor.provider || descriptor.platform || descriptor.source,
        apiEndpoint,
        apiFormat,
        modelId,
        modelName
      })
      const projectionOptions = {
        collapseAll: false,
        preserveLatestCompletedTurn: followupExpansionIntent,
        currentIdentity: modelCacheIdentity,
        currentAliases: [modelId, modelName, descriptor.modelId, descriptor.modelName]
      }
      const rawProjection = requestHistoryWindow.projectCompletedTurnsForModel(history, projectionOptions)
      const modelScopedProjectionNeeded = rawProjection.collapsedTurns > 0
      const rawVisibleTokens = history
        .filter(requestHistoryWindow.isVisibleMessage)
        .reduce((sum, message) => sum + requestHistoryWindow.estimateMessageTokens(message), 0)
      const modelProjectedTokens = rawProjection.history
        .reduce((sum, message) => sum + requestHistoryWindow.estimateMessageTokens(message), 0)

      const stack = await contextCompression.getUiCompressionStack(instance, history, {
        triggerTokens: Math.floor(budget.inputBudgetTokens * 0.75),
        retainTokens: Math.floor(budget.inputBudgetTokens * 0.35)
      })

      let epochContext = null
      let requestWindow = null
      try {
        epochContext = await contextCompression.buildCacheEpochContext(instance, {
          summariesPerEpoch: contextCompression.DEFAULT_CACHE_EPOCH_SUMMARIES,
          maxItems: contextCompression.DEFAULT_CONTEXT_SUMMARY_ITEMS
        })
        const windowOptions = {
          coveredMessageId: epochContext.coveredMessageId,
          coveredMessageIndex: epochContext.coveredMessageIndex,
          coveredRoundId: epochContext.coveredRoundId,
          summaryBlock: epochContext.summaryBlock,
          tokenBudget: budget.inputBudgetTokens,
          projectionOptions
        }
        requestWindow = modelScopedProjectionNeeded
          ? requestHistoryWindow.buildModelSwitchHistory(history, Math.max(0, history.length - 1), windowOptions)
          : requestHistoryWindow.buildCompressionEpochHistory(history, Math.max(0, history.length - 1), windowOptions)
      } catch (error) {
        requestWindow = modelScopedProjectionNeeded
          ? requestHistoryWindow.buildModelSwitchHistory(history, Math.max(0, history.length - 1), {
              tokenBudget: budget.inputBudgetTokens,
              projectionOptions
            })
          : requestHistoryWindow.buildRequestHistoryWindow(history, Math.max(0, history.length - 1), {
              tokenBudget: budget.inputBudgetTokens
            })
      }

      const visibleRequestHistory = Array.isArray(requestWindow?.history) ? requestWindow.history : []
      const estimatedInputTokens = visibleRequestHistory
        .reduce((sum, message) => sum + requestHistoryWindow.estimateMessageTokens(message), 0)
      let latestTurnStart = -1
      visibleRequestHistory.forEach((message, index) => {
        if (requestHistoryWindow.isUserTurnMessage(message) && !message.interject) latestTurnStart = index
      })
      const latestTurnTokens = latestTurnStart >= 0
        ? visibleRequestHistory.slice(latestTurnStart)
          .reduce((sum, message) => sum + requestHistoryWindow.estimateMessageTokens(message), 0)
        : 0
      const usageRatio = budget.inputBudgetTokens > 0 ? estimatedInputTokens / budget.inputBudgetTokens : 0
      // 与真正发送路径保持一致：切换模型后，如果“用户需求 + 最终正文”投影已经足够小，
      // 指示器不能继续拿旧模型的完整工具链假报即将压缩。
      const effectivePendingTokens = modelScopedProjectionNeeded
        ? modelProjectedTokens
        : Math.max(0, Number(stack.pendingTokens) || 0)
      const compressionRatio = stack.triggerTokens > 0
        ? Math.min(1, Math.max(0, effectivePendingTokens / stack.triggerTokens))
        : 0
      const status = usageRatio >= 0.9
        ? 'urgent'
        : usageRatio >= 0.75
          ? 'compressing'
          : usageRatio >= 0.6
            ? 'watch'
            : 'safe'
      const summariesPerEpoch = Math.max(1, Number(contextCompression.DEFAULT_CACHE_EPOCH_SUMMARIES) || 1)
      const compressionEpoch = stack.summaryCount > 0
        ? Math.floor((stack.summaryCount - 1) / summariesPerEpoch) + 1
        : 1

      return {
        ...stack,
        pendingTokens: effectivePendingTokens,
        modelName: modelName || modelId || '默认模型',
        modelId,
        maxContextTokens: budget.maxContextTokens,
        inputBudgetTokens: budget.inputBudgetTokens,
        hardInputTokens: budget.hardInputTokens,
        outputReserveTokens: budget.outputReserveTokens,
        safetyTokens: budget.safetyTokens,
        estimatedInputTokens,
        latestTurnTokens,
        rawVisibleTokens,
        modelProjectedTokens,
        crossModelSavedTokens: Math.max(0, rawVisibleTokens - modelProjectedTokens),
        epochSavedTokens: Math.max(0, rawVisibleTokens - estimatedInputTokens),
        collapsedForeignTurns: rawProjection.collapsedTurns || 0,
        removedToolMessages: rawProjection.removedToolMessages || 0,
        removedReasoningChars: rawProjection.removedReasoningChars || 0,
        modelScopedProjectionNeeded,
        latestRunId: String(latestRun?.runId || latestTurn?.runId || ''),
        latestTurnId: String(latestTurn?.id || latestRun?.runId || ''),
        latestRunStatus: String(latestTurn?.status || latestRun?.status || 'unknown'),
        latestTurnItemCount,
        latestTurnToolCount,
        latestTurnEvidenceAvailable,
        latestTurnCompletedAt: latestTurn?.completedAt || latestRun?.finishedAt || null,
        followupExpansionIntent,
        usageRatio,
        compressionRatio,
        status,
        compressionEpoch,
        summariesPerEpoch
      }
    } catch (error) {
      console.error('[AIChat] context-compression-stack failed:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('execute-relay-task', async (event, projectId, userMessage, modelConfig) => {
    return {
      success: false,
      disabled: true,
      status: 'disabled',
      error: '接力工作流已停用。请使用普通聊天/Agent 工具流程继续。'
    }
  })

  ipcMain.handle('get-relay-status', async (event, projectId) => {
    return { status: 'disabled', disabled: true }
  })

  ipcMain.on('interrupt-relay', (event, projectId) => {
    console.log('[AIChat] 接力工作流已停用，忽略中断:', projectId)
  })
}

const MUTATING_TOOL_NAMES = new Set([
  ...WRITE_LIKE_TOOLS,
  'file_manage',
  'shell_run',
  'create_file_session'
])

function isMutatingToolName(name = '') {
  return MUTATING_TOOL_NAMES.has(String(name || ''))
}

function buildSyntheticToolResultContent(toolName, options = {}) {
  const aborted = options.aborted === true
  const name = String(toolName || '')
  if (aborted && isMutatingToolName(name)) {
    return JSON.stringify({
      success: false,
      aborted: true,
      error_type: 'TOOL_OUTCOME_UNKNOWN',
      synthetic: true,
      error: '操作已中断，该写操作是否已经落盘未知。请读取当前文件确认实际内容；不要用中断前的参数重放这次写操作。'
    })
  }
  if (aborted) {
    return JSON.stringify({
      success: false,
      aborted: true,
      error_type: 'TOOL_NOT_STARTED',
      synthetic: true,
      error: '操作已中断，该只读工具未执行完成。需要时可以重新读取，不要假设已有结果。'
    })
  }
  return JSON.stringify({
    success: false,
    error: options.error || '工具调用未正常返回，已写入合成失败结果以修复历史结构',
    aborted: false,
    synthetic: true
  })
}

/**
 * Repair persisted chat history so every assistant tool_call is immediately
 * followed by its tool result. API providers reject histories with orphan or
 * misplaced tool messages.
 */
function repairToolCallAdjacency(historyList, options = {}) {
  if (!Array.isArray(historyList) || historyList.length === 0) return false
  const tailOnly = options.tailOnly === true
  let scanStart = 0
  if (tailOnly) {
    scanStart = historyList.length
    while (scanStart > 0 && historyList[scanStart - 1]?.role === 'tool') scanStart--
    if (scanStart > 0 && historyList[scanStart - 1]?.role === 'assistant' && Array.isArray(historyList[scanStart - 1].tool_calls)) {
      scanStart--
    } else {
      return false
    }
  }
  const toolResultsById = new Map()
  for (let i = scanStart; i < historyList.length; i++) {
    const msg = historyList[i]
    if (msg?.role !== 'tool' || !msg.tool_call_id) continue
    const id = String(msg.tool_call_id)
    if (!toolResultsById.has(id)) toolResultsById.set(id, msg)
  }

  const repaired = tailOnly ? historyList.slice(0, scanStart) : []
  let changed = false
  const syntheticError = options.error || '工具调用未正常返回，已写入合成失败结果以修复历史结构'

  for (let i = scanStart; i < historyList.length; i += 1) {
    const msg = historyList[i]
    if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      if (msg?.role === 'tool') {
        changed = true
        continue
      }
      repaired.push(msg)
      continue
    }

    repaired.push(msg)

    for (const tc of msg.tool_calls) {
      const id = String(tc?.id || '')
      if (!id) continue
      const existingToolResult = toolResultsById.get(id)
      if (existingToolResult) {
        repaired.push(existingToolResult)
      } else {
        const toolName = tc?.function?.name || tc?.name || ''
        changed = true
        repaired.push({
          role: 'tool',
          tool_call_id: id,
          content: buildSyntheticToolResultContent(toolName, {
            error: syntheticError,
            aborted: !!options.aborted
          })
        })
      }
    }
  }

  if (repaired.length !== historyList.length) changed = true
  for (let i = scanStart; !changed && i < historyList.length; i += 1) {
    if (historyList[i] !== repaired[i]) changed = true
  }
  if (!changed) return false
  historyList.splice(scanStart, historyList.length - scanStart, ...repaired.slice(scanStart))
  return true
}

/**
 * 消息处理核心逻辑（异步）
 */
async function runTrackedSendMessage(...args) {
  const projectId = args[2]
  const sourceInstance = args[9]
  // 一轮请求固定绑定它开始时的 chat-session。新建/切换同项目会话会修改全局实例，
  // 但不能把正在运行的 A 会话历史、路径和上下文一起切到 B 会话。
  const instance = sourceInstance
    ? Object.assign(Object.create(Object.getPrototypeOf(sourceInstance)), sourceInstance, {
      messagesHistory: sourceInstance.messagesHistory
    })
    : null
  if (instance) args[9] = instance
  if (instance) instance._activeChatRequestCount = Number(instance._activeChatRequestCount || 0) + 1
  try {
    return await handleSendMessage(...args)
  } finally {
    if (instance) {
      instance._activeChatRequestCount = Math.max(0, Number(instance._activeChatRequestCount || 1) - 1)
      if (instance._activeChatRequestCount === 0) {
        await projects.saveProjectChatHistory(instance).catch(error => {
          console.warn('[AIChat] final history cache compaction save failed:', error.message)
        })
      }
    }
  }
}

async function handleSendMessage(event, requestId, projectId, message, modelConfig, history, skillContent, executionMode, agentMode, instance, webContents, contextManager, projectPath, effectiveModelId, imageDataList = [], displayContent = null, hidden = false, visionRelayConfig = null, references = [], directiveBadges = [], projectMode = 'standard', sendFlags = {}) {
  // 新用户回合：清除桌面操控 Esc 中断标记与上一轮叠加态
  try {
    require('./desktop-control').onUserTurnStart()
  } catch (_) { /* optional */ }
  chatVerboseLog('[AIChat] handleSendMessage 开始, agentMode:', agentMode, 'images:', imageDataList.length)
  chatVerboseLog('[AIChat] projectId:', projectId)
  chatVerboseLog('[AIChat] instance:', instance ? '存在' : '不存在')
  chatVerboseLog('[AIChat] contextManager:', contextManager ? '存在' : '不存在')
  chatVerboseLog('[AIChat] contextManager.memory:', contextManager?.memory ? '存在' : '不存在')
  chatVerboseLog('[AIChat] memory tape length:', contextManager?.memory?.getLength())
  const requestStartedAt = Date.now()
  let persistedUserIndex = -1
  const modelName = modelConfig.modelName
  const modelId = effectiveModelId
  const apiEndpoint = buildApiEndpoint(modelConfig)
  const apiFormat = getApiFormat(modelConfig, apiEndpoint)
  let geminiDirectTransport = false
  if (isGeminiWebBridgeModel(modelConfig, effectiveModelId)) {
    try {
      geminiDirectTransport = require('./gemini-web-bridge').getStatus().transportMode === 'direct'
    } catch (_) { /* keep browser transport semantics if status is unavailable */ }
  }
  const modelCacheIdentity = requestHistoryWindow.buildModelCacheIdentity({
    provider: modelConfig.provider || modelConfig.platform || modelConfig.source,
    apiEndpoint,
    apiFormat,
    modelId,
    modelName
  })
  const assistantModelMetadata = { modelName, modelId, modelCacheIdentity }
  const perfProfile = {
    requestId,
    projectId,
    startedAt: requestStartedAt,
    navigationMs: 0,
    contextBuildMs: 0,
    initialRequestProfile: null,
    initialHeadersMs: 0,
    initialFirstChunkMs: 0,
    continueProfiles: []
  }
  const finishAiObservation = observability.recordAiRequestStart({
    projectId,
    modelId: effectiveModelId,
    modelName: modelConfig?.modelName || modelConfig?.modelId || effectiveModelId,
    executionMode,
    agentMode,
    imageCount: imageDataList.length
  })

  let changeSession = null
  let finalizedChangeSession = null
  let reviewChangeSession = null
  try {
    changeSession = changeSessions.startChangeSession(projectId, projectPath, {
      requestId,
      messagePreview: typeof message === 'string' ? message.substring(0, 200) : '',
      startedBy: 'ai-chat'
    })
  } catch (error) {
    console.error('[ChangeSession] 启动本轮修改记录失败:', error.message)
  }

  const previousChangeDiagnostic = changeSessions.buildPreviousChangeDiagnosticPrompt(projectId, message)
  const interruptResidue = previousChangeDiagnostic.enabled
    ? { enabled: false, reason: 'diagnostic-already-attached' }
    : changeSessions.buildInterruptResiduePrompt(projectId, message)

  function finishChangeSession(status) {
    if (!changeSession) return null
    try {
      return changeSessions.finalizeChangeSession(projectId, changeSession.id, status)
    } catch (error) {
      console.error('[ChangeSession] 结束本轮修改记录失败:', error.message)
      return null
    }
  }

  // Codex-style deferred tool state: keep discovered packs across turns in
  // this project instead of resetting them at the beginning of every request.
  capabilityState.loadForInstance(instance)

  const abortController = new AbortController()
  config.setAbortController(projectId, abortController)
  const signal = abortController.signal
  const requestIsCurrent = () => config.getAbortController(projectId) === abortController
  const deleteAbortControllerIfCurrent = () => {
    if (requestIsCurrent()) config.deleteAbortController(projectId)
  }
  const abortWithReason = (reason) => {
    const reasonText = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
    console.log('[AIChat] abortWithReason 被调用:', reasonText, 'projectId:', projectId, new Error().stack?.split('\n').slice(1, 4).join(' | '))
    try {
      abortController.abort(reason instanceof Error ? reason : createAbortError(reason))
    } catch {
      abortController.abort()
    }
  }
  const apiTimeouts = getApiTimeouts(modelConfig)
  let activeApiWatchdog = null
  const startApiWatchdog = (label) => {
    if (activeApiWatchdog) activeApiWatchdog.stop()
    activeApiWatchdog = createApiTimeoutWatchdog({
      webContents,
      projectId,
      abortWithReason,
      label,
      firstResponseMs: apiTimeouts.firstResponseMs,
      streamIdleMs: apiTimeouts.streamIdleMs
    })
    return activeApiWatchdog
  }
  const stopApiWatchdog = (watchdog = activeApiWatchdog) => {
    if (!watchdog) return
    watchdog.stop()
    if (watchdog === activeApiWatchdog) activeApiWatchdog = null
  }

  const previewedToolCallIds = new Set()
  const visibleProgressHeartbeatMs = 12000
  const visibleProgressHeartbeatGapMs = 15000
  let lastVisibleProgressAt = Date.now()
  let lastStreamActivityAt = Date.now()
  let lastVisibleHeartbeatAt = 0

  const visibleProgressHeartbeatTimers = new Set()
  let visibleProgressHeartbeatAbortBound = false

  function markStreamActivity() {
    lastStreamActivityAt = Date.now()
  }

  function markVisibleProgress() {
    lastVisibleProgressAt = Date.now()
  }

  function normalizePublicThinkingNote(content) {
    let text = String(content || '').replace(/\r\n/g, '\n').trim()
    if (!text) return ''
    if (hasInternalInstructionLeak(text)) {
      text = stripInternalInstructionLeaks(text, { preserveFormatting: true })
    }
    text = text
      .split('\n')
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .filter(line => line && !/LINGXI_TOOL_CALLS/i.test(line) && !/\bcalls\s*[:=]\s*[\[{]/.test(line))
      .join('\n')
      .trim()
    if (!text || hasInternalInstructionLeak(text)) return ''
    return text
  }

  function sendVisibleProgressStatus(content, extra = {}) {
    const status = extra.preserveContent ? normalizePublicThinkingNote(content) : normalizeProgressStatus(content)
    if (!status) return false
    webContents?.send('ai-thinking', {
      projectId,
      content: status,
      append: extra.startNewBlock ? false : !!extra.append,
      startNewBlock: !!extra.startNewBlock,
      isStatus: true,
      isProgressNarration: true,
      reuseOpenSegment: extra.startNewBlock ? false : true,
      forceUpdate: !!extra.forceUpdate,
      forceShortThinking: !!extra.forceShortThinking,
      isHeartbeat: !!extra.isHeartbeat
    })
    markVisibleProgress()
    return true
  }

  function hasMeaningfulToolCallDelta(toolCalls) {
    return Array.isArray(toolCalls) && toolCalls.some(tc => {
      if (!tc || typeof tc !== 'object') return false
      return Boolean(
        tc.id ||
        tc.type ||
        tc.function?.name ||
        tc.function?.arguments
      )
    })
  }

  let nativeReasoningStreamActive = false
  let holdNativeReasoningForLengthRouting = false

  function sendNativeReasoningDelta(content) {
    const text = String(content || '')
    if (!text.trim()) return false
    // Gemini 直连的人工阶段说明需要等整段结束后按可见字符数分流：
    // 200 字内走短思考块，超过 200 字才走深度思考。若在这里按原生
    // reasoning 流直接发送，前端会把它无条件标记成深度思考。
    if (holdNativeReasoningForLengthRouting) return false
    if (!nativeReasoningStreamActive) {
      nativeReasoningStreamActive = true
      sendThinkingEvent(webContents, projectId, {
        kind: 'reasoning',
        eventType: 'reasoning-start',
        content: text,
        append: false,
        reuseOpenSegment: true,
        forceUpdate: true
      })
      markVisibleProgress()
      return true
    }
    sendThinkingEvent(webContents, projectId, {
      kind: 'reasoning',
      eventType: 'reasoning-delta',
      content: text,
      append: true,
      reuseOpenSegment: true,
      forceUpdate: true
    })
    markVisibleProgress()
    return true
  }

  function finishNativeReasoningStream() {
    if (!nativeReasoningStreamActive) return false
    nativeReasoningStreamActive = false
    webContents?.send('ai-thinking', {
      projectId,
      eventType: 'reasoning-end',
      type: 'reasoning-end',
      isReasoningSummary: true
    })
    return true
  }


  // 同一 signal 只绑一次 abort 清理，避免重复 addEventListener
  if (signal && !visibleProgressHeartbeatAbortBound) {
    visibleProgressHeartbeatAbortBound = true
    try {
      signal.addEventListener('abort', () => {
        stopAllVisibleProgressHeartbeats()
      }, { once: true })
    } catch (_) { /* ignore */ }
  }

  function startVisibleProgressHeartbeat(label = '') {
    const timer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(timer)
        visibleProgressHeartbeatTimers.delete(timer)
        return
      }
      const now = Date.now()
      if (now - lastVisibleProgressAt < visibleProgressHeartbeatMs) return
      if (now - lastVisibleHeartbeatAt < visibleProgressHeartbeatGapMs) return
      lastVisibleHeartbeatAt = now
      const recentlyStreaming = now - lastStreamActivityAt < visibleProgressHeartbeatGapMs
      // Runtime heartbeats intentionally do not create thinking blocks.
      webContents?.send('ai-status', {
        projectId,
        status: recentlyStreaming ? 'streaming' : 'thinking',
        heartbeat: true,
        label
      })
    }, 1000)
    timer.unref?.() // 不阻止进程退出
    visibleProgressHeartbeatTimers.add(timer)
    return timer
  }

  function stopVisibleProgressHeartbeat(timer) {
    if (!timer) return
    clearInterval(timer)
    visibleProgressHeartbeatTimers.delete(timer)
  }

  function stopAllVisibleProgressHeartbeats() {
    for (const timer of visibleProgressHeartbeatTimers) clearInterval(timer)
    visibleProgressHeartbeatTimers.clear()
  }

  function isVisibleToolName(name = '') {
    const value = String(name || '')
    return !!value && !isInternalUiOnlyToolName(value)
  }

  function previewStreamingToolCall(toolCall) {
    const toolName = toolCall?.function?.name || ''
    const toolCallId = toolCall?.id || ''
    if (!isVisibleToolName(toolName) || !toolCallId || previewedToolCallIds.has(toolCallId)) return
    previewedToolCallIds.add(toolCallId)
    // Stream assembly only records the previewed id; real tool-start is sent during execution.
    // Visible thinking is driven by show_thinking_note.
    previewedToolCallIds.add(toolCallId)
    markVisibleProgress()
  }

  webContents?.send('ai-status', { projectId, status: 'thinking' })

  // ===== 构建用户消息（支持多模态） =====
  let userMessageContent
  let effectiveMessage = message
  const originalMessage = message
  // 全部图片元数据（含 forHistoryOnly：只为历史缩略图落盘，不参与视觉/多模态）
  const allImageDataList = Array.isArray(imageDataList) ? imageDataList : []
  let effectiveImageDataList = allImageDataList.filter(img => !img?.forHistoryOnly)
  const originalImageDataList = effectiveImageDataList.slice()
   const turnRuntime = lingxiHarness.startTurn({
     projectId,
     requestId,
     message,
     modelConfig,
     effectiveModelId,
     executionMode,
     projectMode,
     hidden: !!hidden,
     imageDataList: effectiveImageDataList,
     chatSessionId: instance?.chatSessionId || instance?.collaborationSessionId || '',
     enabledPacks: capabilityState.getLoadedPacks(instance),
     enableToolPack: packId => capabilityState.enableToolPack(instance, packId)
   })
   const runRef = turnRuntime.runRef
   clearContextStatusCache(projectId)
  // 历史消息和 Turn/Item 之间使用稳定的内部关联键。字段以下划线开头，
  // 仅用于本地恢复/上下文诊断；model-api-adapter 的消息规范化不会把它们
  // 发送给外部模型。
  const turnMessageMetadata = {
    _lingxiRunId: String(runRef.runId || ''),
    _lingxiTurnId: String(runRef.runId || '')
  }
  let researchContext = null
  if (researchMode.isResearchMode(projectMode)) {
    const rejectResearchRequest = (content, details = []) => {
      const completedAt = Date.now()
      const userEntry = { role: 'user', content: sanitizeUserVisibleContent(String(displayContent || originalMessage || '')), time: new Date(requestStartedAt).toISOString() }
      const detailText = details.length
        ? `\n\n冲突明细：\n${details.map((item, index) => `${index + 1}. ${item.constraintId ? `[${item.constraintId}] ` : ''}${item.reason}`).join('\n')}`
        : ''
      const refusalContent = `${content}${detailText}`
      const assistantEntry = {
        role: 'assistant',
        content: refusalContent,
        ...turnMessageMetadata,
        ...assistantModelMetadata,
        startedAt: requestStartedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - requestStartedAt),
        time: new Date(completedAt).toISOString(),
        researchConstraintRefusal: true
      }
      instance.messagesHistory.push(userEntry, assistantEntry)
      instance._chatHistoryDirty = true
      if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
      else projects.saveProjectChatHistory(instance)
      finalizedChangeSession = finishChangeSession('completed')
       lingxiHarness.addAgentMessage(turnRuntime, refusalContent, {
        id: `agent-${runRef.runId}-refusal`,
        startedAt: requestStartedAt,
        completedAt,
        durationMs: Math.max(0, completedAt - requestStartedAt)
      })
       lingxiHarness.finishTurn(turnRuntime, 'completed', {
         researchConstraintRefusal: true,
         violations: details
       })
      clearContextStatusCache(projectId)
      deleteAbortControllerIfCurrent()
      webContents?.send('ai-status', { projectId, status: 'done' })
       webContents?.send('message-reply', { projectId, runId: runRef.runId, turnId: runRef.runId, content: refusalContent, done: true, startedAt: requestStartedAt, completedAt, durationMs: assistantEntry.durationMs })
      event.reply('send-message-response', { requestId, projectId, success: true, researchConstraintRefusal: true })
    }
    try {
      webContents?.send('ai-status', { projectId, status: 'thinking', label: '正在核对研究约束' })
      researchContext = await researchMode.prepareRequest({
        instance,
        projectId,
        projectPath: instance.projectPath || projectPath || '',
        webContents,
        message: originalMessage,
        modelConfig,
        signal
      })
      if (researchContext.blocked) {
        rejectResearchRequest(researchContext.refusal, researchContext.violations)
        return
      }
    } catch (error) {
      rejectResearchRequest(`研究模式拒绝继续：本轮约束预检未能完成（${error.message || error}）。为避免在未核对约束的情况下执行，当前任务未开始。`)
      return
    }
  }
  if (previousChangeDiagnostic.enabled) {
    taskRuns.event(runRef, 'previous_change_diagnostic_attached', {
      sessionId: previousChangeDiagnostic.sessionId,
      changedPaths: previousChangeDiagnostic.changedPaths
    })
  }
  if (interruptResidue.enabled) {
    taskRuns.event(runRef, 'interrupt_residue_attached', {
      sessionId: interruptResidue.sessionId,
      changedPaths: interruptResidue.changedPaths
    })
  }
  const normalizedReferences = normalizeReferences(references)
  const referencedContextBlock = buildReferencedContextBlock(instance, normalizedReferences)
  if (referencedContextBlock) {
    effectiveMessage = [
      effectiveMessage,
      '',
      referencedContextBlock
    ].join('\n\n')
  }
  const currentModelConfig = normalizeModel(modelConfig)
  const currentModelHasVision = hasCapability(currentModelConfig, 'vision')
    || isChatGptWebChatVisionModel(modelConfig, effectiveModelId)

  let visionResultForHistory = null
  let visionRelayToolUi = null
  try {
    throwIfAborted(signal)
    if (effectiveImageDataList.length > 0 && !currentModelHasVision) {
      if (visionRelayConfig?.approved && visionRelayConfig?.visionModelConfig) {
        const firstVisionImage = effectiveImageDataList[0] || {}
        const firstVisionPath = String(firstVisionImage.path || '')
        const firstVisionData = String(firstVisionImage.data || firstVisionImage.url || '')
        const firstVisionMime = String(firstVisionImage.type || 'image/png')
        const firstVisionPreview = firstVisionData
          ? (firstVisionData.startsWith('data:image/')
              ? firstVisionData
              : `data:${firstVisionMime};base64,${firstVisionData}`)
          : null
        const firstVisionDims = await probeImageDimensions({
          path: firstVisionPath,
          data: firstVisionData,
          url: firstVisionPreview
        }).catch(() => ({ width: null, height: null }))
        visionRelayToolUi = {
          id: `vision-relay-${requestId}`,
          args: {
            path: firstVisionPath,
            question: message,
            image_count: effectiveImageDataList.length,
            // P4 · pending 舞台可直接用 dataUrl 渲染源图（粘贴图无 path 时不再 360×360 空盒）
            dataUrl: firstVisionPreview || undefined,
            width: firstVisionDims.width || undefined,
            height: firstVisionDims.height || undefined
          },
          preview: firstVisionPreview,
          width: firstVisionDims.width,
          height: firstVisionDims.height
        }
        webContents?.send('tool-start', {
          projectId,
          name: 'inspect_image',
          args: visionRelayToolUi.args,
          toolCallId: visionRelayToolUi.id
        })
        const visionResult = await analyzeImagesWithVisionModel({
          visionModelConfig: normalizeModel(visionRelayConfig.visionModelConfig),
          imageDataList: effectiveImageDataList,
          userMessage: researchContext ? `${researchContext.prompt}\n\n===== 当前图片任务 =====\n${message}` : message,
          signal
        })
        visionResultForHistory = visionResult
        webContents?.send('tool-result', {
          projectId,
          name: 'inspect_image',
          args: visionRelayToolUi.args,
          toolCallId: visionRelayToolUi.id,
          result: {
            success: true,
            file_type: 'image_analysis',
            kind: 'vision_inspection',
            path: firstVisionPath,
            modelName: visionResult.modelName,
            imageNames: visionResult.imageNames,
            summary: visionResult.summary,
            thumbnailDataUrl: visionRelayToolUi.preview,
            width: visionRelayToolUi.width || null,
            height: visionRelayToolUi.height || null,
            message: '视觉分析完成'
          }
        })
        visionRelayToolUi.completed = true
        effectiveMessage = [
          message,
          '',
          '【视觉模型分析结果】',
          `分析模型：${visionResult.modelName}`,
          `图片：${visionResult.imageNames.join('、')}`,
          visionResult.summary,
          '',
          '请基于以上图片分析和用户需求回答；不要声称当前模型直接看到了图片。'
        ].join('\n')
        effectiveImageDataList = []
      } else {
        const metadataNote = buildImageMetadataNote(effectiveImageDataList)
        effectiveMessage = `${message}\n\n${metadataNote}`
        effectiveImageDataList = []
      }
    }
  } catch (err) {
    if (visionRelayToolUi && !visionRelayToolUi.completed) {
      webContents?.send('tool-result', {
        projectId,
        name: 'inspect_image',
        args: visionRelayToolUi.args,
        toolCallId: visionRelayToolUi.id,
        result: {
          success: false,
          error: err.message || '视觉分析失败'
        }
      })
    }
    stopApiWatchdog()
    const requestWasCurrent = requestIsCurrent()
    deleteAbortControllerIfCurrent()
    const timedOut = isApiTimeoutError(err, signal)
    const aborted = !timedOut && isAbortError(err, signal)
    console.error('[AIChat] ⚠️ 视觉/附件准备 catch 诊断:',
      '\n  err.name:', err?.name, '\n  err.message:', err?.message,
      '\n  signal.aborted:', signal?.aborted, '\n  timedOut:', timedOut, '\n  aborted:', aborted
    )
    finalizedChangeSession = finishChangeSession(aborted ? 'interrupted' : 'error')
    if (aborted) {
      const recallUnstarted = unstartedTurnRecall.isRecallUnstartedReason(err, signal)
      lingxiHarness.addAgentMessage(turnRuntime, err.message || '视觉/附件准备已中断', {
        id: `agent-${runRef.runId}-vision-interrupted`,
        status: 'failed',
        startedAt: requestStartedAt,
        completedAt: Date.now()
      })
      lingxiHarness.finishTurn(turnRuntime, 'interrupted', {
        stage: 'vision_or_attachment_prepare',
        error: err.message
      })
      clearContextStatusCache(projectId)
      if (requestWasCurrent) webContents?.send('ai-status', { projectId, status: 'interrupted', recalled: recallUnstarted })
      event.reply('send-message-response', { requestId, projectId, success: true, interrupted: true, recalled: recallUnstarted, changeSession: finalizedChangeSession })
    } else {
      lingxiHarness.addAgentMessage(turnRuntime, err.message || '视觉/附件准备失败', {
        id: `agent-${runRef.runId}-vision-failed`,
        status: 'failed',
        startedAt: requestStartedAt,
        completedAt: Date.now()
      })
      lingxiHarness.finishTurn(turnRuntime, 'failed', {
        stage: 'vision_or_attachment_prepare',
        error: err.message,
        changeSessionId: finalizedChangeSession?.id || null
      })
      clearContextStatusCache(projectId)
      if (requestWasCurrent) {
        webContents?.send('ai-status', { projectId, status: 'error' })
         webContents?.send('message-reply', { projectId, runId: runRef.runId, turnId: runRef.runId, error: err.message, done: true, changeSession: finalizedChangeSession })
      }
      event.reply('send-message-response', { requestId, projectId, error: err.message, changeSession: finalizedChangeSession })
    }
    stopLocalOllamaModelAfterReply(modelConfig, effectiveModelId)
    return
  }

  if (effectiveImageDataList && effectiveImageDataList.length > 0) {
    // 有图片：构建多模态内容（OpenAI格式）
    const preparedImages = await prepareImages(effectiveImageDataList)
    const validImages = preparedImages.filter(item => item.url)
    const failedImages = preparedImages.filter(item => item.error)
    if (validImages.length === 0) {
      const failureNote = failedImages.length
        ? '\n\n【图片读取失败】' + failedImages.map(item => `\n- ${item.name}: ${item.error}`).join('')
        : ''
      userMessageContent = `${effectiveMessage}\n\n${buildImageMetadataNote(effectiveImageDataList)}${failureNote}`
      chatVerboseLog('[AIChat] 图片读取失败，已降级为元数据')
    } else {
      userMessageContent = []
      // 添加文本部分
      if (effectiveMessage) {
        userMessageContent.push({ type: 'text', text: effectiveMessage })
      }
      if (failedImages.length > 0) {
        userMessageContent.push({
          type: 'text',
          text: '以下图片读取失败，未参与视觉分析：' + failedImages.map(item => `${item.name}: ${item.error}`).join('；')
        })
      }
      // 添加图片部分（OpenAI格式：data URI）
      for (const img of validImages) {
        userMessageContent.push({
          type: 'image_url',
          image_url: {
            url: img.url
          }
        })
      }
      chatVerboseLog('[AIChat] 多模态消息: 文本 +', validImages.length, '张图片')
    }
  } else {
    // 无图片：纯文本
    userMessageContent = effectiveMessage
  }

  // ===== 核心修复：使用后端完整历史，而非前端传来的 =====
  // 前端传来的 history 可能不完整或不正确
  // 使用 instance.messagesHistory 作为真实历史源

  const requestUserMessageContent = userMessageContent
  const visibleUserMessageContent = sanitizeUserVisibleContent(
    typeof displayContent === 'string' && displayContent.trim()
      ? displayContent
      : originalMessage
  )
  let historyUserMessageContent
  if (Array.isArray(userMessageContent)) {
    historyUserMessageContent = userMessageContent.map(part => {
      if (part && part.type === 'text') return { ...part, text: visibleUserMessageContent }
      return part
    })
  } else if (typeof userMessageContent === 'string') {
    historyUserMessageContent = visibleUserMessageContent
  } else {
    historyUserMessageContent = visibleUserMessageContent || userMessageContent
  }

  // 当前用户消息每次都追加；持久历史只保存原始消息与引用 ID，不保存引用详情全文。
  const userHistoryEntry = {
    role: 'user',
    content: historyUserMessageContent,
    ...turnMessageMetadata,
    time: new Date().toISOString()
  }
  // UI 回显用轻量附件：path/name/type only。来源：imageDataList（含 forHistoryOnly）+ 消息里的「路径:」行。
  // 不写 base64，避免历史膨胀；切项目后靠 path 懒加载缩略图。
  const uiImageAttachments = []
  const pushUiAttachment = (raw = {}) => {
    const filePath = String(raw.path || '').trim()
    const name = String(raw.name || (filePath ? path.basename(filePath) : '')).trim()
    if (!name && !filePath) return
    const ext = filePath ? path.extname(filePath).slice(1).toLowerCase() : ''
    const looksImage = raw.type
      ? String(raw.type).startsWith('image/')
      : /\.(png|jpe?g|gif|bmp|webp|svg|ico)$/i.test(name || filePath)
    if (!looksImage) return
    const baseKey = (name || path.basename(filePath)).toLowerCase()
    const pathKey = filePath.toLowerCase()
    // 同文件去重：优先保留带 path 的那条，避免「缩略图 + 文件名大圆占位」双显示
    const existing = uiImageAttachments.find(item => {
      if (pathKey && item.path && String(item.path).toLowerCase() === pathKey) return true
      return String(item.name || '').toLowerCase() === baseKey
    })
    if (existing) {
      if (!existing.path && filePath) existing.path = filePath
      if (!existing.type && raw.type) existing.type = String(raw.type)
      return
    }
    uiImageAttachments.push({
      kind: 'image',
      name: name || (filePath ? path.basename(filePath) : 'image'),
      path: filePath,
      type: String(raw.type || '').trim() || (ext ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'image/*')
    })
  }
  for (const img of allImageDataList) pushUiAttachment(img)
  // 无视觉 payload 时 imageDataList 可能为空，从正文「路径:」恢复（不要单独加无 path 的【文件】名，易重复占位）
  {
    const textForPaths = String(originalMessage || '')
    const pathRe = /路径:\s*([^\r\n]+)/g
    let m
    while ((m = pathRe.exec(textForPaths)) !== null) {
      const filePath = String(m[1] || '').trim()
      if (!filePath) continue
      pushUiAttachment({ path: filePath, name: path.basename(filePath) })
    }
  }
  if (uiImageAttachments.length > 0) {
    if (visionResultForHistory && visionResultForHistory.summary) {
      uiImageAttachments[0].visionAnalysis = {
        model: visionResultForHistory.modelName || '',
        summary: visionResultForHistory.summary,
        imageNames: Array.isArray(visionResultForHistory.imageNames) ? visionResultForHistory.imageNames : [],
        analyzedAt: Date.now()
      }
    }
    userHistoryEntry.attachments = uiImageAttachments
  } else if (visionResultForHistory && visionResultForHistory.summary) {
    userHistoryEntry.attachments = [{
      kind: 'image',
      visionAnalysis: {
        model: visionResultForHistory.modelName || '',
        summary: visionResultForHistory.summary,
        imageNames: Array.isArray(visionResultForHistory.imageNames) ? visionResultForHistory.imageNames : [],
        analyzedAt: Date.now()
      }
    }]
  }
  if (hidden) userHistoryEntry.hidden = true
  if (displayContent) userHistoryEntry.displayContent = displayContent
  if (Array.isArray(directiveBadges) && directiveBadges.length > 0) {
    userHistoryEntry.directiveBadges = directiveBadges
      .filter(item => item && (item.token || item.label))
      .map(item => ({
        token: String(item.token || item.label || '').slice(0, 120),
        label: String(item.label || item.token || '').slice(0, 120),
        desc: String(item.desc || '').slice(0, 240),
        kind: String(item.kind || '').slice(0, 80)
      }))
  }
  if (normalizedReferences.length > 0) {
    userHistoryEntry.references = normalizedReferences
  }
  instance._imagePruneState = instance._imagePruneState || {}
  const prunedImages = pruneExpiredImageAttachments(instance.messagesHistory, 4, instance._imagePruneState)
  if (repairToolCallAdjacency(instance.messagesHistory, { tailOnly: true }) || prunedImages) {
    if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
    else projects.saveProjectChatHistory(instance)
  }
  let currentHistoryIndex
  if (sendFlags?.skipUserPersist) {
    currentHistoryIndex = unstartedTurnRecall.findLastVisibleUserIndex(instance.messagesHistory)
    if (currentHistoryIndex < 0) currentHistoryIndex = Math.max(0, instance.messagesHistory.length - 1)
    persistedUserIndex = currentHistoryIndex
    const existing = instance.messagesHistory[currentHistoryIndex]
    if (existing && existing.role === 'user') {
      instance.messagesHistory[currentHistoryIndex] = {
        ...existing,
        ...userHistoryEntry,
        messageId: existing.messageId,
        time: existing.time || userHistoryEntry.time,
        editedAt: Date.now()
      }
    }
  } else {
    currentHistoryIndex = instance.messagesHistory.length
    instance.messagesHistory.push(userHistoryEntry)
    persistedUserIndex = currentHistoryIndex
    instance._chatHistoryDirty = true
    if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
    else projects.saveProjectChatHistory(instance)
  }

  taskRuns.event(runRef, 'user_message_saved', {
    historyIndex: currentHistoryIndex,
    hasImages: Array.isArray(originalImageDataList) && originalImageDataList.length > 0,
    references: userHistoryEntry.references || []
  })

  // 获取完整历史。当前请求使用带引用全文的临时消息，持久历史仍只保存原始消息。
  function isUnfinishedAssistantTail(message) {
    if (!message || message.role !== 'assistant') return false
    const content = String(message.content || '')
    return !!(
      message.interrupted ||
      message.error ||
      message.timeout ||
      /模型接口超过\s*\d+\s*秒没有返回响应|任务未完整完成|未收到模型的有效最终回复|operation aborted|aborted/i.test(content)
    )
  }

  function isExplicitContinuationRequest(text = '') {
    const value = String(text || '').trim()
    if (!value) return false
    return /^(继续|接着|继续吧|接着来|恢复|继续执行|继续处理|按刚才|按上面|上一个|刚才那个|继续刚才|接着刚才|resume\b|continue\b)/i.test(value)
  }

  function toContinuationSnippet(content = '', maxChars = 900) {
    const text = sanitizeUserVisibleContent(content).replace(/\s+/g, ' ').trim()
    if (!text) return ''
    return text.length > maxChars ? `${text.slice(0, maxChars - 3).trim()}...` : text
  }

  function isLowSignalContinuationText(text = '') {
    return /^(继续|接着|继续吧|接着来|继续执行|继续处理|恢复|resume|continue)$/i.test(String(text || '').trim())
  }

  function findContinuationTarget(historyList, currentIndex) {
    if (!Array.isArray(historyList) || currentIndex <= 0) return null
    const lowerBound = Math.max(0, currentIndex - 12)
    let assistantIndex = -1

    for (let i = currentIndex - 1; i >= lowerBound; i--) {
      const item = historyList[i]
      if (!item) continue
      if (isUnfinishedAssistantTail(item)) {
        assistantIndex = i
        break
      }
      if (item.role === 'assistant' && item.content && !isUnfinishedAssistantTail(item)) {
        const content = String(item.content || '')
        if (/完成了|已完成|解决了|可以了|成功|最终回复|验证通过/.test(content)) break
      }
    }

    if (assistantIndex < 0) return null

    let userIndex = -1
    for (let i = assistantIndex - 1; i >= lowerBound; i--) {
      const item = historyList[i]
      if (!item || item.role !== 'user') continue
      const content = sanitizeUserVisibleContent(item.content)
      if (isLowSignalContinuationText(content)) continue
      userIndex = i
      break
    }

    const failedAssistant = historyList[assistantIndex]
    const originalUser = userIndex >= 0 ? historyList[userIndex] : null
    return {
      assistantIndex,
      userIndex,
      originalUserText: toContinuationSnippet(originalUser?.content || ''),
      failedAssistantText: toContinuationSnippet(failedAssistant?.content || '', 700)
    }
  }

  function buildContinuationTargetPrompt(target) {
    if (!target) return ''
    const lines = [
      '===== 继续任务恢复线索 =====',
      '用户本轮是在说“继续/接着处理”。下面是系统从最近历史中提取的未完成任务线索，优先据此恢复旧任务，不要回答“不确定你要继续什么”。'
    ]
    if (target.originalUserText) {
      lines.push('', '最近未完成任务的原始用户请求：', target.originalUserText)
    }
    if (target.failedAssistantText) {
      lines.push('', '最近一次中断/失败的 AI 输出摘要：', target.failedAssistantText)
    }
    lines.push('', '处理要求：先承接这个任务；如果线索仍不足，再只问一个最关键的问题。')
    return lines.join('\n')
  }

  const previousHistoryEntry = instance.messagesHistory[currentHistoryIndex - 1] || null
  const previousRunWasUnfinished = isUnfinishedAssistantTail(previousHistoryEntry)
  const currentMessageContinuesPreviousRun = isExplicitContinuationRequest(requestUserMessageContent || message)
  const continuationTarget = currentMessageContinuesPreviousRun
    ? findContinuationTarget(instance.messagesHistory, currentHistoryIndex)
    : null
  let fullHistory = []

  let compressionResult = null
  const followupExpansionIntent = isFollowupExpansionIntent(message)
  const previousCompletedRun = followupExpansionIntent
    ? taskRuns.listRuns(projectId, { limit: 20 }).find(run => (
      run?.runId &&
      String(run.runId) !== String(runRef?.runId || '') &&
      ['completed', 'failed', 'interrupted', 'abandoned', 'recoverable'].includes(String(run.status || '').toLowerCase())
    ))
    : null
  const previousCompletedTurn = previousCompletedRun?.runId
    ? turnItemStore.readTurnFromJournal(instance.storagePath, previousCompletedRun.runId)
    : null
  const turnEvidenceHandoffContext = followupExpansionIntent
    ? turnItemStore.formatTurnForFollowupContext(previousCompletedTurn, { maxChars: 7000 })
    : ''
  const modelTransition = requestHistoryWindow.detectModelTransition(
    instance.messagesHistory,
    currentHistoryIndex,
    {
      identity: modelCacheIdentity,
      aliases: [modelId, modelName, modelConfig.modelId, modelConfig.modelName]
    }
  )
  const modelProjectionOptions = {
    collapseAll: false,
    preserveLatestCompletedTurn: followupExpansionIntent,
    currentIdentity: modelCacheIdentity,
    currentAliases: [modelId, modelName, modelConfig.modelId, modelConfig.modelName]
  }
  const requestContextBudget = buildContextBudget(
    modelConfig.modelName || effectiveModelId || modelId,
    modelConfig.contextWindow || modelConfig.contextLength || modelConfig.maxContextTokens
  )
  const modelSwitchProjectionPreview = requestHistoryWindow.projectCompletedTurnsForModel(
    instance.messagesHistory,
    modelProjectionOptions
  )
  const modelScopedProjectionNeeded = modelSwitchProjectionPreview.collapsedTurns > 0
  const modelSwitchProjectedTokens = modelSwitchProjectionPreview
    ? modelSwitchProjectionPreview.history.reduce((sum, item) => sum + requestHistoryWindow.estimateMessageTokens(item), 0)
    : 0
  try {
    throwIfAborted(signal)
    const compressionOptions = {
      triggerTokens: Math.floor(requestContextBudget.inputBudgetTokens * 0.75),
      retainTokens: Math.floor(requestContextBudget.inputBudgetTokens * 0.35)
    }
    // 换模型后先按“用户需求 + 最终正文”估算；投影已经足够小时，不为旧模型的
    // 工具链和深度思考额外创建压缩摘要。投影本身仍不会修改完整历史。
    const skipCompressionForModelSwitch = modelScopedProjectionNeeded && modelSwitchProjectedTokens < compressionOptions.triggerTokens
    let compressionPlan = skipCompressionForModelSwitch
      ? { shouldCreate: false, coveredMessageIndex: -1, pendingTokens: modelSwitchProjectedTokens }
      : await contextCompression.getCompressionPlan(instance, instance.messagesHistory, compressionOptions)
    if (compressionPlan.shouldCreate) {
      webContents?.send('context-compression-start', {
        projectId,
        status: 'running',
        message: '正在进行上下文压缩'
      })
      compressionResult = await contextCompression.createCompressionSummary(instance, instance.messagesHistory, {
        ...compressionOptions,
        userRequest: message,
        leadingSystemMessages: instance._lastRoutedCompactionPrefix?.leadingSystemMessages,
        conversationSystem: (instance._lastRoutedCompactionPrefix?.leadingSystemMessages || []).length
          ? ''
          : (() => {
            try {
              return getSystemPrompt(executionMode, projectPath, agentMode, 'zh-CN', {
                blender: true,
                ppt: true,
                music: true,
                any: true,
                cacheStableGate: true,
                mcp: { aidev: false, any: false, cacheStableGate: true },
                compactRuntimePrompt: true
              })
            } catch {
              return ''
            }
          })(),
        summarizeWithWorker: async ({ prompt, prefixMessages }) => workerModel.summarizeJson({
          system: researchContext ? `${researchContext.prompt}\n\n你是上下文压缩整理员，只输出 JSON。` : '你是上下文压缩整理员，只输出 JSON。',
          prompt: researchContext ? `${researchContext.prompt}\n\n${prompt}` : prompt,
          prefixMessages: researchContext
            ? [{ role: 'system', content: researchContext.prompt }, ...(Array.isArray(prefixMessages) ? prefixMessages : [])]
            : prefixMessages,
          currentModel: modelConfig,
          projectId,
          sessionId: instance?.chatSessionId || instance?.collaborationSessionId || '',
          task: 'context_compression',
          disabledTools: instance._lastRoutedCompactionPrefix?.disabledTools,
          toolGateUserMessage: instance._lastRoutedCompactionPrefix?.userMessage || message,
          userMessage: instance._lastRoutedCompactionPrefix?.userMessage || message
        })
      })
      throwIfAborted(signal)
    } else {
      compressionResult = {
        created: false,
        coveredMessageIndex: compressionPlan.coveredMessageIndex,
        pendingTokens: compressionPlan.pendingTokens
      }
    }
    throwIfAborted(signal)
    if (compressionResult?.created) {
      const dividerInsertIndex = Number.isInteger(compressionResult.summary?.endHistoryIndex)
        ? compressionResult.summary.endHistoryIndex
        : instance.messagesHistory.length
      instance.messagesHistory = contextCompression.ensureDividerInHistory(instance.messagesHistory, compressionResult.summary)
      if (dividerInsertIndex <= currentHistoryIndex) currentHistoryIndex += 1
      instance._chatHistoryDirty = true
      projects.saveProjectChatHistory(instance)
      webContents?.send('context-split', {
        projectId,
        splitIndex: compressionResult.splitTurn,
        summary: compressionResult.summary?.summaryText || '',
        estimatedTokens: 0,
        budgetTokens: 0,
        oversizedRefs: [],
        coveredTokens: compressionResult.sourceTokenEstimate || 0,
        compressionSummaryId: compressionResult.summary?.id || null
      })
      webContents?.send('context-compression-start', {
        projectId,
        status: 'done',
        message: '上下文压缩完成',
        compressionSummaryId: compressionResult.summary?.id || null
      })
    }
  } catch (error) {
    throwIfAborted(signal)
    console.error('[ContextCompression] 创建滑动摘要失败:', error.message)
    webContents?.send('context-compression-start', {
      projectId,
      status: 'failed',
      message: '上下文压缩失败'
    })
  }

  // 压缩纪元内只追加消息，不滑动删除最旧轮次。缓存前缀仅在新摘要生成时重建。
  let epochWindow = null
  let cacheEpochContext = null
  let historyProjection = {
    applied: false,
    reason: 'same-model-or-unknown',
    collapsedTurns: 0,
    removedMessages: 0,
    removedToolMessages: 0,
    removedReasoningChars: 0
  }
  try {
    cacheEpochContext = await contextCompression.buildCacheEpochContext(instance, {
      summariesPerEpoch: contextCompression.DEFAULT_CACHE_EPOCH_SUMMARIES,
      maxItems: 3
    })
    const historyWindowOptions = {
      coveredMessageId: cacheEpochContext.coveredMessageId,
      coveredMessageIndex: cacheEpochContext.coveredMessageIndex,
      coveredRoundId: cacheEpochContext.coveredRoundId,
      summaryBlock: cacheEpochContext.summaryBlock,
      tokenBudget: requestContextBudget.inputBudgetTokens,
      projectionOptions: modelProjectionOptions
    }
    epochWindow = modelScopedProjectionNeeded
      ? requestHistoryWindow.buildModelSwitchHistory(instance.messagesHistory, currentHistoryIndex, historyWindowOptions)
      : requestHistoryWindow.buildCompressionEpochHistory(instance.messagesHistory, currentHistoryIndex, historyWindowOptions)
    fullHistory = epochWindow.history
    if (modelScopedProjectionNeeded) {
      historyProjection = {
        applied: true,
        reason: modelTransition.switched ? 'model-switch' : 'foreign-model-history',
        collapsedTurns: epochWindow.collapsedTurns || 0,
        removedMessages: epochWindow.removedMessages || 0,
        removedToolMessages: epochWindow.removedToolMessages || 0,
        removedReasoningChars: epochWindow.removedReasoningChars || 0
      }
    }
  } catch (trimError) {
    epochWindow = modelScopedProjectionNeeded
      ? requestHistoryWindow.buildModelSwitchHistory(instance.messagesHistory, currentHistoryIndex, {
          tokenBudget: requestContextBudget.inputBudgetTokens,
          projectionOptions: modelProjectionOptions
        })
      : requestHistoryWindow.buildRequestHistoryWindow(instance.messagesHistory, currentHistoryIndex, { tokenBudget: requestContextBudget.inputBudgetTokens })
    fullHistory = epochWindow.history
    if (modelScopedProjectionNeeded) {
      historyProjection = {
        applied: true,
        reason: modelTransition.switched ? 'model-switch-fallback' : 'foreign-model-history-fallback',
        collapsedTurns: epochWindow.collapsedTurns || 0,
        removedMessages: epochWindow.removedMessages || 0,
        removedToolMessages: epochWindow.removedToolMessages || 0,
        removedReasoningChars: epochWindow.removedReasoningChars || 0
      }
    }
    console.warn('[ContextTrim] 压缩纪元读取失败，安全降级为近期窗口:', trimError.message)
  }
  const requestCurrentHistoryIndex = fullHistory.length - 1
  fullHistory[requestCurrentHistoryIndex] = {
    ...fullHistory[requestCurrentHistoryIndex],
    content: requestUserMessageContent
  }
  // 按当前模型能力规范化历史中的图片上下文：视觉模型直读图片，非视觉模型用持久化的分析摘要
  normalizeFullHistoryForModel(fullHistory, currentModelHasVision, requestCurrentHistoryIndex)
  const historyToolPrune = pruneHistoricalToolResults(fullHistory, {
    // 详细追问时，上一轮工具证据本身就是回答依据；不要因为普通请求的
    // “只保留最近 8 条工具结果”策略把它再次剪掉。Turn/Item 账本是磁盘事实，
    // 这里保留模型可直接读取的那一份完整配对，超大结果仍由 spill 机制兜底。
    keepRecentToolMessages: followupExpansionIntent ? 100000 : undefined
  })
  if (historyToolPrune.changed) {
    taskRuns.event(runRef, 'tool_result_history_pruned', {
      prunedCount: historyToolPrune.prunedCount,
      spilledCount: historyToolPrune.spilledCount,
      savedChars: historyToolPrune.savedChars
    })
    chatVerboseLog('[ContextTrim] 历史工具结果剪枝:', historyToolPrune.prunedCount, '条, 节省', historyToolPrune.savedChars, '字符')
  }
  chatVerboseLog(`[ContextTrim] 压缩纪元保留约 ${epochWindow?.epochTokens || 0} tokens、${fullHistory.length} 条，跳过 ${epochWindow?.trimmedCount || 0} 条旧历史`)

  // 按当前模型的真实窗口和安全余量构建 API 消息。
  const requestHistory = fullHistory
  const promptCacheScope = {
    projectId,
    branchId: instance?.branchKey || instance?.parentBranchKey || instance?.branchName || instance?.parentBranchName || '',
    // 项目内聊天会话必须拥有独立的缓存命名空间。
    // sessionId 不得回退到 branchKey，否则同项目同分支的多个 chat-sessions 会共用 cache key，
    // 交替请求时互相冲掉前缀。如果没有 chatSessionId，使用 instance 引用的稳定 hash 作为兜底。
    sessionId: instance?.chatSessionId || instance?.collaborationSessionId || '',
    grokCacheLayoutVersion: 'v2'
  }
  // 兜底：如果 sessionId 为空，基于 instance 对象生成稳定唯一 ID（不回退到 branchKey）
  if (!promptCacheScope.sessionId && instance) {
    const instanceStableKey = require('crypto').createHash('sha256')
      .update([projectId, instance?.branchKey || '', String(instance?.createdAt || instance?.startedAt || Date.now())].join(':'))
      .digest('hex').slice(0, 16)
    promptCacheScope.sessionId = instanceStableKey
  }

  // 构建系统提示
  const workbenchFeatures = detectWorkbenchMentions(message)
  const disabledWorkbenchTools = getDisabledWorkbenchTools(workbenchFeatures)
  // Codex-aligned: lean always-on system (compact runtime + progressive disclosure).
  // Domain packs / task focus / playbook short-chain inject per turn, not into stable system.
  const stablePromptFeatures = {
    blender: true,
    ppt: true,
    music: true,
    any: true,
    cacheStableGate: true,
    mcp: { aidev: false, any: false, cacheStableGate: true },
    compactRuntimePrompt: true
  }
  let baseSystemPrompt = getSystemPrompt(executionMode, projectPath, agentMode, 'zh-CN', {
    ...stablePromptFeatures
  })
  const isDeepSeekPromptCacheTarget = getPromptCacheCapability(modelConfig, apiEndpoint, modelId).id === 'deepseek'
  if (isDeepSeekPromptCacheTarget) {
    baseSystemPrompt = `${baseSystemPrompt}

===== DeepSeek 工具调用策略 =====
- 每轮只发起一个原生工具调用。多个互不依赖的只读任务（读取已知文件、文件内查找、rg 文本搜索）必须合并为一次 parallel_research 调用。
- parallel_research 的子任务不得彼此依赖，结果按 tasks 输入顺序返回；不要把写入、删除、构建、启动服务、网络副作用或“先搜索再读取搜索结果”放入其中。
- 需要修改工程、运行构建或依赖前一步结果时，继续使用普通工具调用，拿到结果后再决定下一步。`
  }

  let systemPrompt = baseSystemPrompt
  try {
    const skills = require('./skills')
    const catalogPrompt = skills.buildSkillCatalogPrompt({
      projectPath,
      userMessage: message,
      skillContent,
      selectedName: instance?.skillName || skills.parseSelectedSkillName(skillContent)
    })
    if (catalogPrompt) {
      systemPrompt = `${baseSystemPrompt}

${catalogPrompt}
`
      chatVerboseLog('[AIChat] 技能目录已注入, 长度:', catalogPrompt.length)
    } else {
      chatVerboseLog('[AIChat] 无技能目录')
    }
  } catch (e) {
    console.warn('[AIChat] skill catalog attach failed:', e.message)
    chatVerboseLog('[AIChat] 无技能内容')
  }

  systemPrompt = `${systemPrompt}

${buildCurrentModelCapabilityPrompt(modelConfig)}`

  if (expectsNativeReasoningStream(modelConfig, effectiveModelId)) {
    systemPrompt = `${systemPrompt}

===== 原生深度思考展示约束 =====
原生 reasoning/thinking 会展示给用户：
- 用自己的话写当前判断即可，不必套“目标一句 / 下一步”的固定模板。
- 大约 200 字内进短思考块，超过 200 字进深度思考；需要时可以写文件、原因和下一步。
- 同一判断不要换措辞空转；信息不够就去调工具。思考是给自己指路的，最终交付靠正文与工具结果。`
  }

  const selectedSkillName = (() => {
    try {
      return require('./skills').parseSelectedSkillName(skillContent) || instance?.skillName || ''
    } catch (_) {
      return instance?.skillName || ''
    }
  })()
  if (instance && selectedSkillName) instance.skillName = selectedSkillName
  const turnWorkflowPrompt = buildTurnWorkflowPrompt(message, {
    skillHint: selectedSkillName,
    compact: true
  })
  let taskAnchorPrompt = ''
  let intentDisclosurePrompt = ''
  try {
    const disclosure = require('./prompt-disclosure')
    taskAnchorPrompt = disclosure.buildTaskAnchorPrompt(message, { projectPath })
    intentDisclosurePrompt = disclosure.buildIntentDisclosurePrompt(message)
  } catch (e) {
    console.warn('[AIChat] prompt disclosure failed:', e.message)
  }
  const runtimeSystemMessages = [
    taskAnchorPrompt,
    buildTaskFocusPrompt(message, { projectPath, compact: true, maxBullets: 5 }),
    turnWorkflowPrompt,
    intentDisclosurePrompt,
    lingxiHarness.buildCapabilityPlanPrompt(
      turnRuntime.capabilityPlan,
      turnRuntime.modelRoute
    ),
    lingxiHarness.buildCapabilityCatalogPrompt({
      query: message,
      modelConfig,
      enabledPacks: capabilityState.getLoadedPacks(instance),
      capabilityResolution: turnRuntime.capabilityResolution
    })
  ].filter(Boolean)
  if (researchContext?.prompt) runtimeSystemMessages.unshift(researchContext.prompt)
  if (!researchMode.isResearchMode(projectMode)) {
    runtimeSystemMessages.push(agentTeamRuntime.buildStandardModePrompt())
  }
  if (!instance.stateless && projectPath) {
    try {
      const workspaceInstruction = workspaceInstructions.buildWorkspaceInstructionPrompt(projectPath)
      if (workspaceInstruction.enabled) {
        runtimeSystemMessages.unshift(workspaceInstruction.prompt)
        taskRuns.event(runRef, 'workspace_instructions_attached', {
          files: workspaceInstruction.files,
          omitted: workspaceInstruction.omitted,
          root: workspaceInstruction.root
        })
      }
    } catch (error) {
      console.warn('[AIChat] workspace instructions failed:', error.message)
    }
  }

  if (instance.stateless) {
    runtimeSystemMessages.push(`===== 无项目会话规则 =====
当前会话尚未绑定工作目录。普通问答和方案讨论直接回复，不要为了聊天创建目录。
- 查看已有文件或目录：工具参数必须使用用户明确提供的绝对路径；只读操作不会创建或绑定工作区。
- 修改已有目录：先使用该目录的绝对路径调用工具。系统会在首次写入前把现有目录绑定到当前项目 ID。
- 创建新成果：不要先用相对路径执行只读扫描，直接以相对路径发起首个写入操作；系统会在剩余空间最大的可写磁盘创建工作区并绑定当前项目 ID。
- 不得猜测或虚构已有路径。用户只要求查看而路径不明确时，应请用户提供或选择目录。`)
  }

  if (interruptResidue.enabled) {
    runtimeSystemMessages.push(interruptResidue.prompt)
    if (currentMessageContinuesPreviousRun) {
      runtimeSystemMessages.push('用户本轮明确要求继续。先读取残留文件的当前内容再承接，不要重放中断前的写参数。')
    }
  } else if (previousRunWasUnfinished || continuationTarget) {
    runtimeSystemMessages.push(currentMessageContinuesPreviousRun
      ? '上一轮任务被中断或失败，但用户本轮明确要求继续/接着处理。你可以参考上一轮上下文继续完成旧任务，同时仍以本轮用户补充要求为最高优先级。'
      : '上一轮任务被中断或失败，只能作为背景信息。除非用户本轮明确要求继续，否则不要自动续做上一轮未完成任务；必须以本轮最新用户消息为最高优先级。如果本轮只是问候或新问题，就直接回应本轮消息。')
  }

  const continuationTargetPrompt = currentMessageContinuesPreviousRun
    ? buildContinuationTargetPrompt(continuationTarget)
    : ''
  if (continuationTargetPrompt) {
    runtimeSystemMessages.push(continuationTargetPrompt)
  }

  if (previousChangeDiagnostic.enabled) {
    runtimeSystemMessages.push(previousChangeDiagnostic.prompt)
  }

  const primaryRolePrompt = buildPrimaryRolePrompt(message)
  if (primaryRolePrompt) {
    runtimeSystemMessages.push(primaryRolePrompt)
  }

  perfProfile.navigationMs = 0

  chatVerboseLog('[AIChat] 系统提示总长度:', systemPrompt.length, '字符')

  const includeProjectContext = shouldUseProjectContext(message)
  const includeDesignStyleContext = includeProjectContext && shouldUseDesignStyleContext(message, instance)
  const includeHistoricalProjectContext = shouldIncludeHistoricalProjectContext(message)
  const stableLedgerIndexContext = includeHistoricalProjectContext
    ? taskLedger.formatIndexForContext(instance, { maxItems: getLedgerContextMaxItems(message) })
    : ''
  const followupHandoffContext = followupExpansionIntent
    ? (
      taskLedger.formatLatestEntryForFollowupContext(instance, { maxChars: 9000 })
      || taskLedger.formatRecentHistoryForFollowupContext(
        instance.messagesHistory.slice(0, Math.max(0, currentHistoryIndex)),
        { maxChars: 7000 }
      )
    )
    : ''
  const combinedFollowupContext = [turnEvidenceHandoffContext, followupHandoffContext]
    .filter(Boolean)
    .join('\n\n')
  if (combinedFollowupContext) {
    runtimeSystemMessages.unshift(combinedFollowupContext)
    taskRuns.event(runRef, 'historical_followup_context_attached', {
      intent: 'followup_expand',
      ledgerIndexAttached: !!stableLedgerIndexContext,
      turnEvidenceAttached: !!turnEvidenceHandoffContext,
      handoffChars: combinedFollowupContext.length
    })
  }
  const memoryContext = includeProjectContext
    ? memoryOrganizer.formatForContext(memoryOrganizer.load(instance), { query: message })
    : ''
  const designStyleContext = includeDesignStyleContext
    ? designStyleMemory.formatForContext({ query: message, maxItems: 2, maxChars: 2600 })
    : ''
  let compressionSummaryBlock = ''
  if (includeProjectContext) {
    try {
      compressionSummaryBlock = await contextCompression.buildContextSummaryBlock(instance, { maxItems: 3 })
    } catch (e) {
      chatVerboseLog('[AIChat] buildContextSummaryBlock 失败:', e.message)
    }
  }
  const assembledStep = stepAssembly.assembleInitialStepView({
    requestHistory,
    webBridge: isChatGptWebBridgeModel(modelConfig, effectiveModelId) && !geminiDirectTransport,
    projectPath,
    runtimeSections: stepAssembly.buildRuntimeTailSections({
      runtimeContext: getRuntimeContextPrompt(projectPath),
      planProgress: planProgress.buildPlanProgressContext(projectId),
      inspectContext: projectInspectEvidence.buildProjectInspectContext(message),
      ledgerIndex: stableLedgerIndexContext,
      runtimeSystemMessages,
      memoryContext,
      designStyleContext,
      careHint: careReminder.buildCareSituationHint(careReminder.getCareContext({ userMessage: message, now: Date.now() }))
    }),
    extraSystemMessages: [compressionSummaryBlock].filter(Boolean),
    prioritySystemMessages: [buildBehaviorStylePrompt()].filter(Boolean)
  })
  const contextTailGuidance = assembledStep.tail.text
  const contextExtraSystemMessages = assembledStep.extraSystemMessages
  const contextPrioritySystemMessages = assembledStep.prioritySystemMessages
  const dynamicRuntimeMessages = assembledStep.runtimeSections

  const contextBuildStartedAt = Date.now()
  const contextPayload = buildContextPayload({
    contextManager,
    systemPrompt,
    history: requestHistory,
    policy: {
      ...requestContextBudget,
      includeDynamicCompressedHistory: false,
      includeBehaviorSummary: false,
      preserveCachePrefix: true,
      behaviorSummaryMaxChars: 2400
    },
    prioritySystemMessages: contextPrioritySystemMessages,
    extraSystemMessages: contextExtraSystemMessages
  })
  perfProfile.contextBuildMs = Date.now() - contextBuildStartedAt

  const messages = contextPayload.messages
  if (instance) {
    instance._lastRoutedCompactionPrefix = {
      leadingSystemMessages: contextCompression.takeLeadingSystemMessages(messages),
      disabledTools: Array.isArray(disabledWorkbenchTools) ? [...disabledWorkbenchTools] : [],
      userMessage: message
    }
  }

  if (contextPayload.compressed) {
    webContents?.send('context-split', {
      projectId,
      splitIndex: contextPayload.splitIndex,
      summary: contextPayload.summary,
      estimatedTokens: contextPayload.estimatedTokens,
      budgetTokens: contextPayload.budgetTokens,
      oversizedRefs: contextPayload.oversizedRefs || [],
      coveredTokens: compressionResult?.sourceTokenEstimate || 0,
      compressionSummaryId: compressionResult?.summary?.id || null
    })
  }

  chatVerboseLog('[AIChat] 最终消息数:', messages.length, '预估tokens:', contextManager.estimateHistoryTokens(messages), '上下文构建:', perfProfile.contextBuildMs, 'ms')
  taskRuns.event(runRef, 'model_context_profile', {
    messageCount: messages.length,
    estimatedTokens: contextManager.estimateHistoryTokens(messages),
    contextBuildMs: perfProfile.contextBuildMs,
    systemPromptChars: systemPrompt.length,
    extraSystemCount: contextExtraSystemMessages.length,
    runtimePromptMode: 'stable-full',
    includeProjectContext,
    includeDesignStyleContext,
    promptCacheLayout: 'stable-system-tail-runtime',
    cachePrefixPreserved: contextPayload.policy?.preserveCachePrefix === true,
    cachePrefixFallback: contextPayload.policy?.cachePrefixFallback === true,
    historyWindowMode: 'compression-epoch',
    historyEpochTokens: epochWindow?.epochTokens || 0,
    historyCoveredMessageIndex: epochWindow?.coveredMessageIndex ?? -1,
    historyCacheEpochSummaryId: cacheEpochContext?.anchorSummary?.id || null,
    historyCacheEpochSummaryCount: cacheEpochContext?.summaryCount || 0,
    historyTrimmedMessages: epochWindow?.trimmedCount || 0,
    completedTurnProjectionApplied: historyProjection.applied,
    completedTurnProjectionReason: historyProjection.reason,
    modelTransitionDetected: modelTransition.detected,
    modelTransitionSwitched: modelTransition.switched,
    previousModel: modelTransition.previousModel || '',
    currentModel: modelId || modelName || '',
    completedTurnsCollapsed: historyProjection.collapsedTurns,
    completedTurnMessagesRemoved: historyProjection.removedMessages,
    completedTurnToolMessagesRemoved: historyProjection.removedToolMessages,
    completedTurnReasoningCharsRemoved: historyProjection.removedReasoningChars,
    followupExpansionIntent,
    historicalFollowupContextAttached: !!followupHandoffContext,
    tailGuidanceCount: dynamicRuntimeMessages.length,
    extraSystemChars: 0,
    tailGuidanceChars: contextTailGuidance.length
  })

  // 记录工具调用
  const toolCallsRecord = []
  let modelAuthoredOperationMemo = null
  const explorationNudgeKeys = new Set()
  let planFinalNudgeUsed = false
  let inspectDocsNudgeUsed = false
  let wiringNudgeUsed = false
  let activeApiFormat = apiFormat
  function pushInternalInstruction(messages, content, source = null) {
    return stepAssembly.pushStepInstruction(messages, content, {
      apiFormat,
      plugin: source?.plugin,
      source
    })
  }

  function consumeInterjectBeforeContinue() {
    const interjectItems = interjectRunner.takePendingInterjectMessages(projectId)
    if (!interjectItems.length) return false
    const contentLines = interjectItems
      .map(item => String(item.content || '').trim())
      .filter(Boolean)
    if (!contentLines.length) return false
    const injectedContent = [
      '【消息注入】用户在当前 AI 执行过程中追加了新的指令。',
      '当前这批已完成的工具结果仍然有效。不要重启整轮任务，也不要中止已经落盘的改动。',
      '从下一步开始吸收这些指令，必要时调整后续工具选择、修改范围和最终回复。',
      ...contentLines.map((text, index) => `注入消息 ${index + 1}：${text}`)
    ].join('\n')
    const oldestCreatedAt = interjectItems.reduce((earliest, item) => {
      const t = Number(item.createdAt || 0)
      return t > 0 && t < earliest ? t : earliest
    }, Date.now())
    const entry = {
      role: 'user',
      content: injectedContent,
      ...turnMessageMetadata,
      interject: true,
      itemIds: interjectItems.map(item => item.itemId),
      enqueuedAt: Date.now(),
      time: oldestCreatedAt
    }
    messages.push(entry)
    instance.messagesHistory.push(entry)
    instance._chatHistoryDirty = true
    if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
    else projects.saveProjectChatHistory(instance)
    try {
      const mainWindow = config.getMainWindow?.() || config.mainWindow
      mainWindow?.webContents?.send('interject-consumed', {
        projectId,
        itemIds: interjectItems.map(item => item.itemId)
      })
    } catch (_) { /* 主窗口发送插队消费通知失败 */ }
    taskRuns.event(runRef, 'interject_consumed_before_continue', {
      count: interjectItems.length,
      itemIds: interjectItems.map(item => item.itemId)
    })
    console.log(`[AIChat] interject consumed before continue project=${projectId}, count=${interjectItems.length}`)
    return true
  }

  function resetAutoExecContinuationState() {
    instance.autoExecContinuationKey = ''
    instance.autoExecContinuationCount = 0
  }

  function normalizeChoiceOption(option, index) {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return null
    const label = String(option.label ?? '').trim()
    const value = String(option.value ?? '').trim()
    const desc = String(option.desc ?? option.description ?? '').trim()
    const isGeneric = value => /^(?:选项|方案)\s*[#：:]?\s*\d+$|^choice[_-]?\d+$/i.test(String(value || '').trim())
    if (!label || isGeneric(label) || !value || desc.length < 6) return null
    return {
      ...option,
      label,
      value,
      desc
    }
  }

  /** 只透传模型明确给出的完整选项，不从 value 猜标题或说明。 */
  function normalizeWebUiChoiceArgs(args = {}) {
    if (!args || typeof args !== 'object') return args
    if (!Array.isArray(args.options)) {
      return { ...args, options: [], _choiceValidation: { valid: false, reason: 'options 必须是数组' } }
    }
    const normalized = args.options.map(normalizeChoiceOption)
    const invalidIndexes = normalized.map((item, index) => item ? -1 : index).filter(index => index >= 0)
    const options = normalized.filter(Boolean)
    const valid = args._choiceValidation?.valid !== false && invalidIndexes.length === 0 && options.length >= 2 && options.length <= 3
    return {
      ...args,
      options,
      _choiceValidation: {
        valid,
        invalidIndexes,
        reason: valid ? '' : '每个选项都必须由模型提供非占位 label、value，以及至少 6 个字的 desc（做什么、影响或取舍理由）；选项总数必须为 2 到 3 个。'
      }
    }
  }

  function normalizeWebUiPlanArgs(args = {}) {
    return args
  }

  function normalizeToolCallForPlanWorkflow(tc) {
    const toolName = tc?.function?.name || ''
    if (toolName !== 'ask_user_choice' && toolName !== 'confirm_plan') return tc
    const toolArgs = parseToolArgs(tc?.function?.arguments, { fallback: {} }).args
    const normalizedArgs = toolName === 'ask_user_choice'
      ? normalizeWebUiChoiceArgs(toolArgs)
      : normalizeWebUiPlanArgs(toolArgs)
    return {
      ...tc,
      function: {
        ...tc.function,
        arguments: JSON.stringify(normalizedArgs)
      }
    }
  }

  let latestPromptStability = null

  function createCacheUsageTracker() {
    const total = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      cacheMissTokens: 0
    }
    let current = null
    let latest = null

    function makePayload(phase, extra = {}) {
      const currentUsage = extra.current && typeof extra.current === 'object' ? extra.current : {}
      const currentRequestRate = calculatePromptCacheRate(currentUsage)
      const latestRequestRate = currentRequestRate === null ? latest?.cacheRate : currentRequestRate
      const effective = { ...total }
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'cacheWriteTokens', 'cacheMissTokens']) {
        effective[key] += Number(currentUsage[key] || 0)
      }
      const calculatedCacheRate = calculatePromptCacheRate(effective)
      const cacheRate = calculatedCacheRate === null ? null : Math.round(calculatedCacheRate)
      const costEstimate = estimateModelCostForUsage(effective, modelConfig, modelId)
      return {
        projectId,
        phase,
        ...total,
        cacheRate,
        latestRequestCacheRate: Number.isFinite(latestRequestRate) ? Math.round(latestRequestRate) : null,
        latestRequestCachedTokens: Number(currentUsage.cachedTokens || latest?.cachedTokens || 0),
        latestRequestInputTokens: Number(currentUsage.inputTokens || latest?.inputTokens || 0),
        costEstimate,
        costSupported: !!getModelCostProfileForUsage(modelConfig, modelId, effective),
        supported: total.cachedTokens > 0 || total.cacheWriteTokens > 0 || total.cacheMissTokens > 0,
        ...extra
      }
    }

    function send(phase, extra = {}) {
      webContents?.send('ai-cache-usage', makePayload(phase, extra))
    }

    return {
      start(label = '') {
        current = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          cacheMissTokens: 0
        }
        send('request-start', { label })
      },
      record(rawUsage, label = '') {
        const normalized = normalizeCacheUsage(rawUsage)
        if (!normalized || !current) return
        for (const key of Object.keys(current)) {
          current[key] = Math.max(current[key], normalized[key] || 0)
        }
        send('request-usage', { label, current: { ...current } })
      },
      finish(label = '') {
        if (!current) return
        const inputTokens = Number(current.inputTokens || 0)
        const cachedTokens = Number(current.cachedTokens || 0)
        const requestCacheRate = calculatePromptCacheRate(current)
        taskRuns.event(runRef, 'model_cache_usage', {
          label,
          ...current,
          cacheRate: requestCacheRate === null ? null : Number(requestCacheRate.toFixed(2))
        })
        const localPrefixRate = Number(latestPromptStability?.cachePrefix?.reusablePercent)
        if (
          Number.isFinite(localPrefixRate) &&
          localPrefixRate >= 90 &&
          Number.isFinite(requestCacheRate) &&
          requestCacheRate < 30
        ) {
          taskRuns.event(runRef, 'prompt_cache_route_anomaly', {
            label,
            localPrefixRate: Number(localPrefixRate.toFixed(2)),
            upstreamCacheRate: Number(requestCacheRate.toFixed(2)),
            inputTokens,
            cachedTokens,
            diagnosis: 'stable_local_prefix_but_low_upstream_cache'
          })
        }
        latest = {
          label,
          inputTokens,
          cachedTokens,
          cacheRate: requestCacheRate,
          observedAt: Date.now()
        }
        try {
          cloudTokenUsage.recordUsage({
            usage: current,
            modelConfig,
            modelId,
            projectId,
            requestId,
            taskType: label === 'tool-loop' ? 'tool_loop' : 'chat',
            source: 'ai-chat'
          })
        } catch (error) {
          console.warn('[AIChat] cloud token usage record failed:', error.message)
        }
        total.requests += 1
        for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'cacheWriteTokens', 'cacheMissTokens']) {
          total[key] += current[key] || 0
        }
        current = null
        send('request-done', { label })
      },
      getLatest() {
        return latest ? { ...latest } : null
      },
      final() {
        send('done')
      },
      fail(error = '') {
        send('error', { error })
      }
    }
  }

  const cacheUsageTracker = createCacheUsageTracker()
  const toolFailureRecovery = createToolFailureRecoveryTracker()
  const repeatToolReminder = createRepeatToolReminderTracker()
  let emptyCompletionRetries = 0
  let contextOverflowRecovered = false

  function buildStreamRequestBody(includeUsage = true, includePromptCache = true) {
    return buildModelRequestBody(modelConfig, modelId, messages, {
      stream: true,
      // 工具表属于缓存前缀。连续失败后如果把 tools 整段删除，会让下一次
      // 请求从前部发生变化，直接击穿已经建立的前缀缓存。
      // 停止执行由运行时拦截和末尾恢复指令负责，工具 schema 始终保持稳定。
      // Spark Agent 车道不注入灵犀 tools，由远程 Spark 自己完成任务。
      includeTools: !isGeminiSparkAgentModel(modelConfig, effectiveModelId),
      endpoint: apiEndpoint,
      disabledTools: disabledWorkbenchTools,
      enabledPacks: capabilityState.getLoadedPacks(instance),
      includeUsage,
      promptCache: includePromptCache,
      userMessage: message,
      projectPath,
      projectMode,
      skipWebBridgeToolFilter: geminiDirectTransport,
      ...promptCacheScope
    })
  }

  function estimateRequestBodyTokens(body) {
    const serialized = stableJsonStringify(body)
    return contextManager?.estimateTokens
      ? contextManager.estimateTokens(serialized)
      : Math.ceil(serialized.length / 4)
  }

  function compactSameTurnForBudget(label = '') {
    const beforeBody = buildStreamRequestBody(false, true)
    const beforeTokens = estimateRequestBodyTokens(beforeBody)
    if (beforeTokens <= requestContextBudget.hardInputTokens) return { compacted: false, beforeTokens }

    let latestUserIndex = -1
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role === 'user' && !messages[index]?._deepseekBridge) {
        latestUserIndex = index
        break
      }
    }
    if (latestUserIndex < 0) return { compacted: false, beforeTokens }

    const stablePrefix = messages.slice(0, latestUserIndex).filter(item => item?.role === 'system')
    const currentUser = messages[latestUserIndex]
    const ledger = collectCompletedToolEvidence(messages.slice(latestUserIndex + 1), { maxLines: 40 })
    const checkpoint = {
      role: 'system',
      content: [
        '【本轮执行检查点】',
        '请求已接近当前模型的上下文硬上限。系统只压缩发给模型的执行过程，完整聊天和工具记录仍保存在本地。',
        '继续完成最新用户任务；以下为本轮已执行证据，不要重复已成功的操作：',
        ...ledger.map(line => `- ${line}`)
      ].join('\n')
    }
    messages.splice(0, messages.length, ...stablePrefix, currentUser, checkpoint)
    const afterTokens = estimateRequestBodyTokens(buildStreamRequestBody(false, true))
    taskRuns.event(runRef, 'model_context_checkpoint', {
      label,
      modelContextTokens: requestContextBudget.maxContextTokens,
      hardInputTokens: requestContextBudget.hardInputTokens,
      beforeTokens,
      afterTokens,
      toolEvidenceCount: ledger.length
    })
    chatVerboseLog('[ContextBudget] 本轮执行检查点:', label, beforeTokens, '->', afterTokens)
    return { compacted: true, beforeTokens, afterTokens }
  }

  function buildChatCompletionsFallbackEndpoint() {
    if (!/\/responses\/?$/i.test(apiEndpoint)) return ''
    return apiEndpoint.replace(/\/responses\/?$/i, '/chat/completions')
  }

  function isUnsupportedResponsesEndpointError(text = '') {
    return /\/responses|responses api|response endpoint|unsupported endpoint|not found|404|unknown url|unknown path|invalid endpoint/i.test(String(text || ''))
  }

  // 会话级 fallback 记忆：一旦某端点+模型组合触发了 responses -> openai 的 fallback，
  // 后续请求直接使用 openai 格式，避免每次都先尝试 responses 再 fallback 导致 cache 完全失效。
  const responsesFallbackMemory = new Map()
  function shouldSkipResponsesFormat() {
    const key = `${apiEndpoint}|${modelId || modelConfig?.modelId || modelConfig?.modelName || ''}`
    return responsesFallbackMemory.get(key) === true
  }
  function rememberResponsesFallback() {
    const key = `${apiEndpoint}|${modelId || modelConfig?.modelId || modelConfig?.modelName || ''}`
    responsesFallbackMemory.set(key, true)
  }

  function getStreamUsageSupportKey() {
    return [
      String(apiEndpoint || '').replace(/[?#].*$/, '').toLowerCase(),
      String(modelId || modelConfig?.modelId || modelConfig?.modelName || '').toLowerCase()
    ].join('|')
  }

  function getPromptStabilityScopeKey() {
    return [
      String(apiEndpoint || '').replace(/[?#].*$/, '').toLowerCase(),
      String(modelId || modelConfig?.modelId || modelConfig?.modelName || '').toLowerCase(),
      String(promptCacheScope.projectId || ''),
      String(promptCacheScope.branchId || ''),
      String(promptCacheScope.sessionId || '')
    ].join('|')
  }

  function emitPromptStability(body, label = '') {
    try {
      const stability = observePromptStability(body, {
        scopeKey: getPromptStabilityScopeKey(),
        label
      })
      latestPromptStability = stability
      taskRuns.event(runRef, 'prompt_stability', {
        label,
        firstSeen: stability.firstSeen,
        stable: stability.stable,
        changedSegments: stability.changedSegments,
        cachePrefix: stability.cachePrefix
      })
      webContents?.send('ai-cache-usage', {
        projectId,
        phase: 'stability',
        label,
        stability
      })
    } catch (error) {
      console.warn('[PromptStability] observe failed:', error.message)
    }
  }

  async function fetchModelStream(label = '') {
    compactSameTurnForBudget(label)
    const usageSupportKey = getStreamUsageSupportKey()
    activeApiFormat = apiFormat
    async function request(includeUsage, includePromptCache = true, override = {}) {
      const endpoint = override.endpoint || apiEndpoint
      const body = override.body || buildStreamRequestBody(includeUsage, includePromptCache)
      const bodyProfile = buildRequestBodyProfile(body)
      if (label === 'initial' && !perfProfile.initialRequestProfile) {
        perfProfile.initialRequestProfile = bodyProfile
      } else if (label && label.startsWith('continue-')) {
        perfProfile.continueProfiles.push({ label, ...bodyProfile })
      }
      taskRuns.event(runRef, 'model_request_body_profile', {
        label,
        endpointFormat: activeApiFormat,
        includeUsage,
        includePromptCache,
        ...bodyProfile
      })
      emitPromptStability(body, label)
      const serializedBody = stableJsonStringify(body)
      const avoidPersistentConnection = shouldAvoidPersistentModelConnection(modelConfig, endpoint, modelId)
      try {
        return await retryPreResponseSocketClose(async ({ attempt, connectionClose }) => {
          const headers = buildApiHeaders(modelConfig, endpoint, {
            stream: true,
            modelId,
            promptCache: includePromptCache,
            projectPath,
            ...promptCacheScope
          })
          if (avoidPersistentConnection || connectionClose) headers.connection = 'close'
          return fetch(endpoint, buildApiFetchOptions(modelConfig, endpoint, {
            method: 'POST',
            headers,
            body: serializedBody,
            connectionScope: getPromptStabilityScopeKey(),
            modelId,
            promptCache: includePromptCache,
            signal
          }))
        }, {
          delayMs: 150,
          maxAttempts: avoidPersistentConnection ? 3 : 2,
          connectionClose: avoidPersistentConnection,
          onRetry: (error, retry) => {
            taskRuns.event(runRef, 'model_pre_response_socket_retry', {
              label,
              endpointFormat: activeApiFormat,
              attempt: retry.attempt,
              maxAttempts: retry.maxAttempts,
              requestProfile: bodyProfile
            })
          }
        })
      } catch (error) {
        throwIfAborted(signal)
        throw new Error(formatModelTransportError(error, endpoint, modelConfig), { cause: error })
      }
    }
    async function requestChatFallback(includeUsage, includePromptCache = true) {
      const fallbackEndpoint = buildChatCompletionsFallbackEndpoint()
      if (!fallbackEndpoint) return null
      const body = buildModelRequestBody(modelConfig, modelId, messages, {
        stream: true,
        includeTools: !isGeminiSparkAgentModel(modelConfig, effectiveModelId),
        endpoint: fallbackEndpoint,
        disabledTools: disabledWorkbenchTools,
        enabledPacks: capabilityState.getLoadedPacks(instance),
        includeUsage,
        promptCache: includePromptCache,
        userMessage: message,
        forceChatCompletions: true,
        disableReasoningOptions: true,
        projectPath,
        projectMode,
        skipWebBridgeToolFilter: geminiDirectTransport,
        ...promptCacheScope
      })
      return request(includeUsage, includePromptCache, { endpoint: fallbackEndpoint, body })
    }
    const usageProbeEnabled = shouldProbeStreamUsageByDefault(modelConfig, apiEndpoint, modelId, apiFormat)
    const shouldProbeUsage = usageProbeEnabled && !unsupportedStreamUsageKeys.has(usageSupportKey)
    taskRuns.event(runRef, 'model_stream_usage_probe', {
      label,
      usageProbeEnabled,
      shouldProbeUsage,
      usageSupportKey
    })
    if (!shouldProbeUsage) {
      webContents?.send('ai-cache-usage', {
        projectId,
        phase: 'unsupported',
        label,
        supported: false,
        message: '当前模型接口未返回缓存用量'
      })
    }
    const throwHttpError = (status, errorText, responseLike, cause) => {
      const headers = responseLike?.headers
      const classified = classifyLlmFailure({ status, body: errorText, headers, signal })
      throw createLlmRequestError({
        code: classified.code,
        message: formatApiHttpError(status, errorText, modelConfig),
        status,
        retryAfterMs: classified.retryAfterMs || parseRetryAfterMs(headers, errorText),
        body: errorText,
        cause
      })
    }

    const attemptOnce = async () => {
      let res
      try {
        // 如果之前已触发过 responses -> openai fallback，直接使用 chat completions 格式
        if (apiFormat === 'openai-responses' && shouldSkipResponsesFormat()) {
          const preFallbackRes = await requestChatFallback(shouldProbeUsage, true)
          if (preFallbackRes?.ok) {
            activeApiFormat = 'openai'
            taskRuns.event(runRef, 'model_responses_preemptive_chat_fallback', {
              label,
              endpointFormat: 'openai-responses',
              fallbackFormat: 'openai',
              reason: 'remembered_fallback'
            })
            return preFallbackRes
          }
        }
        res = await request(shouldProbeUsage, true)
      } catch (requestError) {
        if (apiFormat === 'openai-responses' && isPreResponseSocketCloseError(requestError)) {
          const fallbackRes = await requestChatFallback(shouldProbeUsage, true)
          if (fallbackRes?.ok) {
            activeApiFormat = 'openai'
            rememberResponsesFallback()
            taskRuns.event(runRef, 'model_responses_socket_chat_fallback', {
              label,
              endpointFormat: 'openai-responses',
              fallbackFormat: 'openai',
              requestProfile: label === 'initial'
                ? perfProfile.initialRequestProfile
                : (perfProfile.continueProfiles.at(-1) || null)
            })
            return fallbackRes
          }
          if (fallbackRes) {
            const fallbackErrorText = await fallbackRes.text()
            throwHttpError(fallbackRes.status, fallbackErrorText, fallbackRes, requestError)
          }
        }
        throw requestError
      }
      if (!res.ok) {
        const errorText = await res.text()
        if (apiFormat === 'openai-responses' && isUnsupportedResponsesEndpointError(errorText)) {
          const fallbackRes = await requestChatFallback(shouldProbeUsage, true)
          if (fallbackRes?.ok) {
            activeApiFormat = 'openai'
            rememberResponsesFallback()
            return fallbackRes
          }
          if (fallbackRes) {
            const fallbackErrorText = await fallbackRes.text()
            throwHttpError(fallbackRes.status, fallbackErrorText, fallbackRes)
          }
        }
        if (shouldProbeUsage && /stream_options|include_usage|unknown parameter|unsupported parameter|extra inputs/i.test(errorText)) {
          unsupportedStreamUsageKeys.add(usageSupportKey)
          res = await request(false, true)
          if (!res.ok) {
            const retryErrorText = await res.text()
            if (/prompt_cache_key|x-grok-conv-id|cache key|cache_key|unknown parameter|unsupported parameter|extra inputs/i.test(retryErrorText)) {
              res = await request(false, false)
              if (res.ok) return res
            }
            throwHttpError(res.status, retryErrorText, res)
          }
          webContents?.send('ai-cache-usage', {
            projectId,
            phase: 'unsupported',
            label,
            supported: false,
            message: '当前模型接口未返回缓存用量'
          })
          return res
        }
        if (/prompt_cache_key|x-grok-conv-id|cache key|cache_key/i.test(errorText)) {
          res = await request(shouldProbeUsage, false)
          if (res.ok) return res
        }
        // GLM / OpenAI 返回 400 InvalidParameter：可能是 tool_calls 与 tool 结果不配对导致。
        // 尝试清理 messages 中悬挂的 tool_calls 后重试一次。
        if (res.status === 400 && /InvalidParameter|invalid_parameter|tool_call|tool_calls/i.test(errorText)) {
          console.warn('[AIChat] 收到 400 InvalidParameter，尝试清理 tool_calls 配对后重试')
          try {
            repairToolCallAdjacency(instance.messagesHistory, {
              error: '模型接口返回 400，工具调用历史可能不配对，已自动修复',
              aborted: false
            })
            if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
            else projects.saveProjectChatHistory(instance)
            const retryRes = await request(shouldProbeUsage, true)
            if (retryRes.ok) return retryRes
            const retryErrorText = await retryRes.text()
            throwHttpError(retryRes.status, retryErrorText, retryRes)
          } catch (retryErr) {
            if (retryErr?.llmCode || (retryErr.message && retryErr.message.startsWith('API错误'))) throw retryErr
            console.warn('[AIChat] 400 重试失败:', retryErr.message)
          }
        }
        throwHttpError(res.status, errorText, res)
      }
      return res
    }

    return withLlmRequestRetries(async () => {
      try {
        return await attemptOnce()
      } catch (error) {
        const classified = classifyLlmFailure({ error, signal })
        if (classified.code === 'CONTEXT_WINDOW_EXCEEDED' && !contextOverflowRecovered) {
          contextOverflowRecovered = true
          const recovery = recoverContextOverflow(messages, {
            onCompact: () => compactSameTurnForBudget(`${label}-overflow`)
          })
          taskRuns.event(runRef, 'context_overflow_recovery', {
            label,
            method: recovery.method,
            advanced: recovery.advanced,
            prunedCount: recovery.prunedCount,
            savedChars: recovery.savedChars
          })
          if (recovery.advanced) return attemptOnce()
        }
        throw error
      }
    }, {
      signal,
      onRetry: (info) => {
        taskRuns.event(runRef, 'llm_retry', {
          label,
          attempt: info.attempt,
          maxRetries: info.maxRetries,
          code: info.code,
          status: info.status,
          delayMs: info.delayMs
        })
      }
    })
  }

  const resolvePath = (inputPath) => {
    if (!inputPath) return projectPath
    // 标准化路径：将正斜杠转为反斜杠（Windows）
    let normalizedPath = inputPath.replace(/\//g, '\\')
    chatVerboseLog('[AIChat] resolvePath 输入:', inputPath, '标准化:', normalizedPath)
    if (path.isAbsolute(normalizedPath)) return normalizedPath
    return path.join(projectPath, normalizedPath)
  }

  // 注入触发标志：catch 块里检测到 interject 中断 + 队列非空时置 true，
  // finally 正常清理后异步重启 handleSendMessage，让 consumeInterjectBeforeContinue 消费注入消息。
  let pendingInterjectRestart = false

  try {
    throwIfAborted(signal)
    // 构建 API URL
    // API endpoint is resolved before the request so Anthropic-compatible URLs are not forced into /chat/completions.

    // 初始请求前也消费待注入消息；避免 AI 在第一轮 thinking/工具时用户插队却等不到 continue。
    consumeInterjectBeforeContinue()
    interjectRunner.setRunState(projectId, 'streaming')
    // ===== 流式API请求 =====
    const initialApiWatchdog = startApiWatchdog('模型接口')
    const initialProgressHeartbeat = startVisibleProgressHeartbeat('initial')
    let response
    try {
      cacheUsageTracker.start('initial')
      response = await fetchModelStream('initial')
      perfProfile.initialHeadersMs = Date.now() - requestStartedAt
      taskRuns.event(runRef, 'model_initial_response_headers', {
        headersMs: perfProfile.initialHeadersMs,
        requestProfile: perfProfile.initialRequestProfile
      })
      initialApiWatchdog.touch('stream')
    } catch (error) {
      stopApiWatchdog(initialApiWatchdog)
      stopVisibleProgressHeartbeat(initialProgressHeartbeat)
      throwIfAborted(signal)
      cacheUsageTracker.fail(error.message)
      throw error
    }

    // 处理流式响应
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    let fullContent = ''
    let fullReasoningContent = ''
    let fullReasoningDetails = []
    let latestAnthropicContentBlocks = null
    let toolCallsData = []
    let buffer = ''
    let rawInitialGeminiStream = ''
    let hasToolCalls = false
    let streamState = createAnthropicStreamState()

    function commitVisibleAssistantTextBeforeSteer() {
      const text = String(fullContent || '').trim()
      if (!text) return
      if (hasToolCalls && Array.isArray(toolCallsData) && toolCallsData.length > 0) return
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant' && String(last.content || '') === String(fullContent || '')) return
      const assistantMsg = {
        role: 'assistant',
        content: fullContent,
        ...assistantModelMetadata,
        time: new Date().toISOString()
      }
      if (fullReasoningContent) assistantMsg.reasoning_content = fullReasoningContent
      messages.push(assistantMsg)
      instance.messagesHistory.push(assistantMsg)
      instance._chatHistoryDirty = true
      if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
      else projects.saveProjectChatHistory(instance)
      fullContent = ''
    }

    function absorbPendingInterjectAtStepBoundary() {
      if (!interjectRunner.peekPendingInterjectMessages(projectId).length) return false
      commitVisibleAssistantTextBeforeSteer()
      return consumeInterjectBeforeContinue()
    }
    const allowContentAsProgressNarration = false
    let progressParser = createProgressStatusParser(status => {
      sendVisibleProgressStatus(status)
    })
    let progressNarration = createProgressNarrationTracker(webContents, projectId)
    let toolArgumentProgress = createToolArgumentProgressTracker(webContents, projectId, {
      chatSessionId: instance?.chatSessionId || instance?.collaborationSessionId || ''
    })
    let finalReplyArmed = false
    let finalStreamActive = false
    let initialFirstChunkSeen = false

    function sendFinalDelta(content) {
      const text = String(content || '')
      if (!text) return
      finalStreamActive = true
      webContents?.send('ai-final-delta', { projectId, content: text })
    }

    function resetFinalDelta() {
      if (!finalStreamActive) return
      finalStreamActive = false
      webContents?.send('ai-final-delta', { projectId, reset: true })
    }

    function consumeVisibleContentForFinalStream(visibleContent = '') {
      const text = String(visibleContent || '')
      if (!text) return
      fullContent += text
      if (finalReplyArmed) sendFinalDelta(text)
    }

    webContents?.send('ai-status', { projectId, status: 'streaming' })
    try { require('./desktop-pet').notifyAiStatus('running') } catch (_) { /* ignore */ }

    while (true) {
      throwIfAborted(signal)
      const { done, value } = await reader.read()
      if (done) break
      markStreamActivity()
      initialApiWatchdog.touch('stream')
      if (!initialFirstChunkSeen) {
        initialFirstChunkSeen = true
        perfProfile.initialFirstChunkMs = Date.now() - requestStartedAt
        taskRuns.event(runRef, 'model_initial_first_chunk', {
          firstChunkMs: perfProfile.initialFirstChunkMs,
          headersMs: perfProfile.initialHeadersMs,
          requestProfile: perfProfile.initialRequestProfile
        })
      }

      const decodedInitialChunk = decoder.decode(value, { stream: true })
      if (activeApiFormat === 'gemini') rawInitialGeminiStream += decodedInitialChunk
      buffer += decodedInitialChunk

      // 处理 SSE 数据
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data:')) continue

        const data = line.slice(5).trim()
        if (data === '[DONE]') continue

        try {
          const json = JSON.parse(data)
          const streamError = createStreamPayloadError(json)
          if (streamError) throw streamError
          const delta = parseModelStreamEvent(json, streamState, activeApiFormat)

          if (!delta) continue
          markStreamActivity()
          if (delta.usage) cacheUsageTracker.record(delta.usage, 'initial')
          if (isMiniMaxM3Model(modelConfig, modelId) && Array.isArray(delta.reasoning_details)) {
            fullReasoningDetails.push(...delta.reasoning_details)
          }
          if (isMiniMaxM3Model(modelConfig, modelId) && Array.isArray(delta.content_blocks)) {
            latestAnthropicContentBlocks = delta.content_blocks
          }

          if (delta.reasoning_content) {
            fullReasoningContent += delta.reasoning_content
            sendNativeReasoningDelta(delta.reasoning_content)
          }

          // 流式发送正文内容
          if (delta.content) {
            const visibleContent = progressParser.process(delta.content)
            if (visibleContent) {
              consumeVisibleContentForFinalStream(visibleContent)
            }
          }

          // 处理工具调用（流式累积）
          if (hasMeaningfulToolCallDelta(delta.tool_calls)) {
            finishNativeReasoningStream()
            resetFinalDelta()
            finalReplyArmed = false
            if (!hasToolCalls) {
              progressNarration.flush({ discard: progressParser.hasEmittedStatus() })
              if (allowContentAsProgressNarration && !progressParser.hasEmittedStatus() && !progressNarration.hasProgress() && fullContent.trim()) {
                progressNarration.markFromText(fullContent)
                fullContent = ''
              }
            }
            hasToolCalls = true
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? toolCallsData.length
              while (toolCallsData.length <= idx) {
                toolCallsData.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
              }
              if (tc.id) toolCallsData[idx].id = tc.id
              if (tc.function?.name) toolCallsData[idx].function.name = tc.function.name
              if (tc.function?.arguments) {
                toolCallsData[idx].function.arguments += tc.function.arguments
                toolArgumentProgress.update(toolCallsData[idx])
              }
              previewStreamingToolCall(toolCallsData[idx])
            }
          }
        } catch (e) {
          if (e?.isModelStreamPayloadError) throw e
          // 忽略解析错误
        }
      }
    }
    if (activeApiFormat === 'gemini' && rawInitialGeminiStream.trim()) {
      for (const json of parseGeminiStreamPayload(rawInitialGeminiStream)) {
        const streamError = createStreamPayloadError(json)
        if (streamError) throw streamError
        const delta = parseModelStreamEvent(json, streamState, activeApiFormat)
        if (!delta) continue
        markStreamActivity()
        if (delta.usage) cacheUsageTracker.record(delta.usage, 'initial')
        if (delta.reasoning_content) {
          fullReasoningContent += delta.reasoning_content
          sendNativeReasoningDelta(delta.reasoning_content)
        }
        if (delta.content) {
          const visibleContent = progressParser.process(delta.content)
          if (visibleContent) consumeVisibleContentForFinalStream(visibleContent)
        }
      }
    }
    stopApiWatchdog(initialApiWatchdog)
    stopVisibleProgressHeartbeat(initialProgressHeartbeat)
    cacheUsageTracker.finish('initial')

    interjectRunner.setRunState(projectId, 'idle')
    // 工具轮间隙保持忙碌态，不在此把桌宠打回 idle
    try {
      require('./desktop-pet').notifyAiStatus(hasToolCalls ? 'tools' : 'streaming')
    } catch (_) { /* ignore */ }
    progressNarration.flush({ discard: progressParser.hasEmittedStatus() || !hasToolCalls })
    const remainingInitialContent = progressParser.flush()
    if (remainingInitialContent) {
      consumeVisibleContentForFinalStream(remainingInitialContent)
    }
    const webBridgeModel = isChatGptWebBridgeModel(modelConfig, effectiveModelId) && !geminiDirectTransport
    const webBridgePromptOpts = {
      ...(isClaudeWebBridgeModel(modelConfig, effectiveModelId)
        ? { dialect: 'paste-files' }
        : (isGeminiWebBridgeModel(modelConfig, effectiveModelId) ? { dialect: WEB_BRIDGE_DIALECT_JSON_FENCE } : {})),
      projectPath: extractWebBridgeProjectPath(message)
    }
    const normalizeGeminiDirectToolCalls = (calls = []) => {
      if (!geminiDirectTransport) return calls
      return (Array.isArray(calls) ? calls : []).map(call => {
        const name = String(call?.function?.name || '')
        const parsed = parseToolArgs(call?.function?.arguments, { fallback: {} }).args
        const normalized = normalizeWebToolCallArgs(name, parsed, {
          projectPath: webBridgePromptOpts.projectPath || projectPath,
          direct: true
        })
        return {
          ...call,
          function: {
            ...call.function,
            arguments: JSON.stringify(normalized)
          }
        }
      })
    }
    const pushWebBridgeFollowup = (content) => {
      if (String(webBridgePromptOpts.dialect || '') === 'paste-files') {
        messages.push({ role: 'user', content: String(content || '').trim() })
        return
      }
      pushInternalInstruction(messages, content)
    }
    let webBridgeFinalBody = ''
    let webBridgeFinalLocked = false
    let geminiDirectCompletionGateAttempts = 0
    let webBridgeKeepGoingAttempts = 0
    let webBridgeToolsSinceStage = 0
    let webBridgeReadOnlyBatches = 0
    let webBridgeExecuteNow = looksLikeWebBridgeDirectEditTask(message)
      || (geminiDirectTransport && looksLikeGeminiDirectMutationTask(message))
    let webBridgePhase = 'tools'
    let webBridgeResumeTools = false
    let webBridgeOpenedStage = false
    let webBridgeHeldToolCalls = []
    let webBridgeHasVisibleStageNote = false
    const getWebBridgeBlockingWrites = () => collectUnresolvedBlockingWebBridgeWriteDiagnostics(toolCallsRecord)
    const clearWebBridgeFinalLock = () => {
      webBridgeFinalBody = ''
      webBridgeFinalLocked = false
    }
    const rejectWebBridgeFinalReply = (reason = 'stage') => {
      clearWebBridgeFinalLock()
      resetFinalDelta()
      const blocking = getWebBridgeBlockingWrites()
      if (reason === 'blocking' || blocking.length) {
        webBridgePhase = 'tools'
        webBridgeExecuteNow = true
        webBridgeResumeTools = true
        pushWebBridgeFollowup(buildWebBridgeBlockingWriteFixPrompt(blocking))
        return 'reject-final-blocking'
      }
      if (reason === 'inspect') {
        webBridgePhase = 'tools'
        webBridgeResumeTools = true
        pushWebBridgeFollowup(buildWebBridgeInspectKeepGoingPrompt({
          userText: message,
          toolCalls: toolCallsRecord,
          dialect: webBridgePromptOpts.dialect
        }) || buildWebBridgeKeepGoingPrompt({
          ...webBridgePromptOpts,
          userText: message,
          toolCalls: toolCallsRecord
        }))
        return 'reject-final-inspect'
      }
      webBridgePhase = 'stage'
      webBridgeResumeTools = true
      pushWebBridgeFollowup(buildWebBridgeStageFinalRejectPrompt(webBridgePromptOpts))
      return 'reject-final-stage'
    }
    const tryLockWebBridgeFinalReply = (rawText) => {
      const extractedFinal = extractWebBridgeFinalReply(rawText)
      if (!(extractedFinal.done && extractedFinal.body)) return false
      const blocking = getWebBridgeBlockingWrites()
      const inspectNeedsMore = webBridgeKeepGoingAttempts < WEB_BRIDGE_KEEP_GOING_MAX
        && webBridgeInspectNeedsMore(message, toolCallsRecord)
      if (!shouldAcceptWebBridgeFinalReply({
        stageTurn: webBridgePhase === 'stage',
        blockingWrites: blocking.length > 0,
        inspectNeedsMore
      })) {
        return rejectWebBridgeFinalReply(blocking.length ? 'blocking' : (inspectNeedsMore ? 'inspect' : 'stage'))
      }
      webBridgeFinalBody = extractedFinal.body
      webBridgeFinalLocked = true
      webBridgeOpenedStage = true
      webBridgeToolsSinceStage = 0
      webBridgePhase = 'tools'
      return 'final'
    }
    const parkWebBridgeStageNote = (rawText) => {
      const locked = tryLockWebBridgeFinalReply(rawText)
      if (locked) return locked
      if (isWebBridgeNoToolsRefusal(rawText)) return false
      if (!(extractWebBridgeStageNote(rawText).found || webBridgePhase === 'stage')
        && shouldPromoteWebBridgeTextToFinal({ userText: message, text: rawText, toolCalls: toolCallsRecord })) {
        const blocking = getWebBridgeBlockingWrites()
        if (blocking.length || webBridgePhase === 'stage') {
          return rejectWebBridgeFinalReply(blocking.length ? 'blocking' : 'stage')
        }
        webBridgeFinalBody = normalizeWebBridgeFinalBody(String(rawText || '').replace(/[\u200B-\u200D\uFEFF]/g, ''))
        webBridgeOpenedStage = true
        webBridgeToolsSinceStage = 0
        webBridgePhase = 'tools'
        return 'final'
      }
      if (looksLikeWebBridgeConfirmStall(rawText)
        || looksLikeWebBridgeDirectEditTask(message)
        || (geminiDirectTransport && looksLikeGeminiDirectMutationTask(message))
        || (looksLikeWebBridgeFuturePlan(rawText) && needsWebBridgeToolEvidence(message) && !looksLikeWebBridgeInspectQuestion(message))) {
        webBridgeExecuteNow = true
      }
      const note = clipWebBridgeThinkingNote(rawText)
      if (!note || isWebThinkingPlaceholder(note)) return false
      if (!extractWebBridgeStageNote(rawText).found && looksLikeWebBridgeDumpedPrompt(note)) return false
      sendVisibleProgressStatus(note, {
        preserveContent: true,
        append: false,
        startNewBlock: true,
        forceUpdate: true
      })
      webBridgeOpenedStage = true
      webBridgeToolsSinceStage = 0
      webBridgePhase = 'tools'
      return true
    }
    const requestWebBridgeCompleteStep = () => {
      webBridgeHasVisibleStageNote = false
      webBridgePhase = 'tools'
      pushWebBridgeFollowup(buildWebBridgeCompleteStepPrompt(webBridgePromptOpts))
      webBridgeResumeTools = true
      toolCallsData = []
      hasToolCalls = false
      return 'fetch'
    }
    const resumeAfterWebBridgeStage = (options = {}) => {
      if (webBridgeHeldToolCalls.length) {
        toolCallsData = webBridgeHeldToolCalls
        hasToolCalls = true
        webBridgeHeldToolCalls = []
        return 'execute'
      }
      if (webBridgeExecuteNow || options.executeNow) {
        pushWebBridgeFollowup(buildWebBridgeKeepGoingPrompt({
          ...webBridgePromptOpts,
          executeNow: true
        }))
      } else {
        return requestWebBridgeCompleteStep()
      }
      webBridgeResumeTools = true
      toolCallsData = []
      hasToolCalls = false
      return 'fetch'
    }
    const liftGeminiDirectReasoningStage = () => {
      if (!geminiDirectTransport || webBridgePhase !== 'stage') return false
      const note = String(fullReasoningContent || '').trim()
      if (!note) return false
      // Gemini 直连知道当前请求就是阶段说明轮，直接使用 API reasoning_content
      // 承载内容，不再要求模型输出浏览器专用暗号。这里按 GPT 网页桥相同
      // 的公共阶段说明通道一次性发送，让前端按 200 可见字符阈值决定短块/深块。
      holdNativeReasoningForLengthRouting = false
      sendVisibleProgressStatus(note, {
        preserveContent: true,
        append: false,
        startNewBlock: true,
        forceUpdate: true,
        forceShortThinking: note.replace(/\s+/g, '').length <= 200
      })
      resetFinalDelta()
      fullContent = ''
      // reasoning_content 也是一次真实 assistant 响应。把它加入本轮 API 消息，
      // 让网关知道前一条一次性阶段指令已经被消费；否则下一次 continue 仍会
      // 被识别成 stage，再写一遍阶段说明，最终工具循环无法恢复。
      messages.push({ role: 'assistant', content: '', reasoning_content: note })
      webBridgeOpenedStage = true
      webBridgeHasVisibleStageNote = true
      webBridgeToolsSinceStage = 0
      webBridgePhase = 'tools'
      resumeAfterWebBridgeStage()
      return true
    }
    const liftWebBridgeStageNote = () => {
      const staged = extractWebBridgeStageNote(fullContent)
      if (!staged.found) return false
      const wasStage = webBridgePhase === 'stage'
      const parked = parkWebBridgeStageNote(fullContent)
      if (parked === 'final') {
        fullContent = webBridgeFinalBody
        return parked
      }
      if (typeof parked === 'string' && parked.startsWith('reject-final')) {
        fullContent = ''
        return parked
      }
      fullContent = staged.rest
      if (parked) {
        resetFinalDelta()
        if (wasStage && !webBridgeHeldToolCalls.length && !(hasToolCalls && toolCallsData.length > 0)) {
          resumeAfterWebBridgeStage()
        } else if (!isWebBridgePlanToolBatch(toolCallsData)) {
          webBridgeHasVisibleStageNote = true
        }
      }
      return parked
    }
    if (webBridgeModel) {
      toolCallsData = normalizeGeminiDirectToolCalls(toolCallsData)
      liftGeminiDirectReasoningStage()
      holdNativeReasoningForLengthRouting = false
      const lifted = liftWebBridgeStageNote()
      if (typeof lifted === 'string' && lifted.startsWith('reject-final')) {
        fullContent = ''
        webBridgeResumeTools = true
      } else {
        const extracted = extractWebBridgeFinalReply(fullContent)
        if (extracted.done) {
          const locked = tryLockWebBridgeFinalReply(fullContent)
          if (locked === 'final') {
            fullContent = extracted.visible
          } else if (typeof locked === 'string' && locked.startsWith('reject-final')) {
            fullContent = ''
            webBridgeResumeTools = true
          }
        }
      }
    }
    if (webBridgeModel && toolCallsData.length > 0) {
      const parked = parkWebBridgeStageNote(fullContent)
      if (parked === 'final') {
        resetFinalDelta()
        fullContent = webBridgeFinalBody
      } else if (typeof parked === 'string' && parked.startsWith('reject-final')) {
        resetFinalDelta()
        fullContent = ''
        webBridgeResumeTools = true
      } else if (parked) {
        resetFinalDelta()
        fullContent = ''
        if (!isWebBridgePlanToolBatch(toolCallsData)) webBridgeHasVisibleStageNote = true
      } else if (!webBridgeFinalBody && shouldHoldWebBridgeToolsForOpeningStage({
        openedStage: webBridgeOpenedStage,
        hasToolCalls: true,
        chitchat: looksLikeWebBridgeChitchat(message),
        inspect: looksLikeWebBridgeInspectQuestion(message),
        directEdit: looksLikeWebBridgeDirectEditTask(message)
          || (geminiDirectTransport && looksLikeGeminiDirectMutationTask(message)),
        planOnly: isWebBridgePlanToolBatch(toolCallsData)
      })) {
        const partitioned = partitionWebBridgeOpeningToolCalls(toolCallsData)
        if (partitioned.plan.length) {
          toolCallsData = partitioned.plan
          hasToolCalls = true
          webBridgeOpenedStage = true
          webBridgePhase = 'tools'
        } else {
          webBridgeHeldToolCalls = []
          toolCallsData = []
          hasToolCalls = false
          webBridgePhase = 'stage'
          pushWebBridgeFollowup(buildWebBridgeOpeningStagePrompt(webBridgePromptOpts))
        }
      }
      if (isWebBridgePlanToolBatch(toolCallsData)) {
        webBridgeOpenedStage = true
      }
    } else if (webBridgeModel && shouldParkWebBridgeOpeningStageFromText({
      openedStage: webBridgeOpenedStage,
      hasToolCalls: false,
      hasFinal: !!webBridgeFinalBody,
      text: fullContent,
      userText: message
    })) {
      const parked = parkWebBridgeStageNote(fullContent)
      if (parked === 'final') {
        fullContent = webBridgeFinalBody
      } else if (parked) {
        resetFinalDelta()
        fullContent = ''
        resumeAfterWebBridgeStage()
      }
    } else if (webBridgeModel && !webBridgeFinalLocked && shouldNudgeWebBridgeForMissingTools({
      userText: message,
      content: fullContent,
      dialect: webBridgePromptOpts.dialect
    })) {
      webBridgeFinalBody = ''
      resetFinalDelta()
      fullContent = ''
      webBridgeOpenedStage = true
      webBridgePhase = 'tools'
      if (webBridgeKeepGoingAttempts < WEB_BRIDGE_KEEP_GOING_MAX) {
        pushWebBridgeFollowup(buildWebBridgeNoToolsNudgePrompt(webBridgePromptOpts))
        webBridgeResumeTools = true
        webBridgeKeepGoingAttempts += 1
      }
    }
    if (webBridgeFinalBody && !(toolCallsData.length > 0)) {
      fullContent = webBridgeFinalBody
    }
    if (allowContentAsProgressNarration && toolCallsData.length > 0 && fullContent.trim() && !webBridgeFinalBody) {
      resetFinalDelta()
      finalReplyArmed = false
      progressNarration.markFromText(fullContent)
      fullContent = ''
    }
    toolCallsData.forEach(tc => toolArgumentProgress.complete(tc))
    chatVerboseLog('[AIChat] 流式结束, hasToolCalls:', hasToolCalls, 'content长度:', fullContent.length)

    // 循环处理工具调用（直到AI不再返回工具调用）
    const initialEmptyCompletion = isEmptyModelCompletion({
      content: fullContent,
      toolCalls: toolCallsData,
      reasoning: fullReasoningContent,
      webBridge: webBridgeModel
    })
    let continueLoop = (hasToolCalls && toolCallsData.length > 0) ||
      webBridgeResumeTools ||
      (webBridgeModel && webBridgePhase === 'stage') ||
      initialEmptyCompletion ||
      interjectRunner.peekPendingInterjectMessages(projectId).length > 0
    if (initialEmptyCompletion) {
      emptyCompletionRetries += 1
      taskRuns.event(runRef, 'llm_retry', {
        label: 'initial',
        code: 'EMPTY_RESPONSE',
        attempt: emptyCompletionRetries,
        delayMs: resolveRetryDelayMs({ code: 'EMPTY_RESPONSE' }, emptyCompletionRetries)
      })
    }
    let loopCount = 0
    let noToolQualityRetryCount = 0
    let lastModelReplyHadNoToolCalls = false
    let postWriteVerifyRetryUsed = false
    let runtimeGateContinuationUsed = false
    const projectReviewTask = isProjectReviewIntent(message)
    let currentToolSectionStatus = ''
    let currentToolSectionRealToolCount = 0
    while (true) {
    while (continueLoop) {
      throwIfAborted(signal)
      loopCount++
      chatVerboseLog('[AIChat] 工具调用循环第', loopCount, '次, 工具数量:', toolCallsData.length)

      // 每轮重置进度状态，确保强制校验不被旧状态蒙蔽
      progressParser.resetLastStatus()

      // 普通正文不提前发到展开区，避免最终正文重复显示。

      const progressStatusFromTool = emitProgressToolStatus(toolCallsData, progressParser)
      let progressStatusBeforeTools = progressStatusFromTool || progressParser.getLastStatus() || progressNarration.getLastNarration()
      const hasRealToolCallsInBatch = toolCallsData.some(tc => isBusinessToolName(tc?.function?.name || ''))
      if (progressStatusBeforeTools && progressStatusBeforeTools !== currentToolSectionStatus) {
        currentToolSectionStatus = progressStatusBeforeTools
        currentToolSectionRealToolCount = 0
      }

      const skipWebBridgeToolExec = webBridgeModel && webBridgePhase === 'stage'
        && !isWebBridgePlanToolBatch(toolCallsData)
      if (webBridgeModel && webBridgePhase === 'stage' && !skipWebBridgeToolExec && toolCallsData.length > 0) {
        webBridgeOpenedStage = true
        webBridgePhase = 'tools'
      }
      if (skipWebBridgeToolExec && toolCallsData.length > 0 && !webBridgeHeldToolCalls.length) {
        webBridgeHeldToolCalls = toolCallsData
        toolCallsData = []
        hasToolCalls = false
      }
      if (skipWebBridgeToolExec && webBridgeHeldToolCalls.length) {
        const parked = parkWebBridgeStageNote(fullContent)
        if (parked === 'final') {
          fullContent = webBridgeFinalBody
          continueLoop = false
          break
        }
        if (parked) {
          resetFinalDelta()
          fullContent = ''
        } else {
          webBridgePhase = 'tools'
        }
        toolCallsData = webBridgeHeldToolCalls
        hasToolCalls = true
        webBridgeHeldToolCalls = []
        continue
      }

      if (!skipWebBridgeToolExec && toolCallsData.length > 0 && hasRealToolCallsInBatch) {
        if (shouldRerouteToolStatusMismatch(toolCallsData, progressStatusBeforeTools)) {
          taskRuns.event(runRef, 'tool_status_mismatch_observed', {
            loopCount,
            progressStatus: progressStatusBeforeTools,
            tools: toolCallsData.map(tc => tc?.function?.name).filter(Boolean)
          })
        }
        if (shouldRerouteManualLocationFirst(toolCallsData, toolCallsRecord, message)) {
          taskRuns.event(runRef, 'navigation_first_observed', {
            loopCount,
            tools: toolCallsData.map(tc => tc?.function?.name).filter(Boolean)
          })
        }
        if (shouldReroutePrematureModification(toolCallsData, toolCallsRecord, message)) {
          taskRuns.event(runRef, 'modification_preflight_observed', {
            loopCount,
            tools: toolCallsData.map(tc => tc?.function?.name).filter(Boolean)
          })
        }
      }

      if (!skipWebBridgeToolExec && toolCallsData.length > 0) {
        const realToolCountInBatch = toolCallsData.filter(tc => {
          const name = tc?.function?.name || ''
          return isBusinessToolName(name)
        }).length
        noToolQualityRetryCount = 0
        lastModelReplyHadNoToolCalls = false
        if (realToolCountInBatch > 0) {
          webContents?.send('ai-status', { projectId, status: 'using_tools', count: realToolCountInBatch })
        }
        toolCallsData = toolCallsData.map(normalizeToolCallForPlanWorkflow)

        // 保存到历史消息时不包含正文片段（避免AI后续重复输出）
        const assistantMsg = {
          role: 'assistant',
          content: null,  // 正文片段已通过 ai-intermediate-content 显示，不保存到历史
          ...turnMessageMetadata,
          ...assistantModelMetadata,
          time: new Date().toISOString(),
          tool_calls: toolCallsData.filter(tc => tc.id).map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments }
          }))
        }
        if (fullReasoningContent) assistantMsg.reasoning_content = fullReasoningContent
        if (isMiniMaxM3Model(modelConfig, modelId) && fullReasoningDetails.length) assistantMsg.reasoning_details = fullReasoningDetails
        if (isMiniMaxM3Model(modelConfig, modelId) && activeApiFormat === 'anthropic' && latestAnthropicContentBlocks) assistantMsg.anthropic_content = latestAnthropicContentBlocks
        const progressStatus = progressParser.getLastStatus() || progressNarration.getLastNarration() || progressStatusBeforeTools
        if (progressStatus) assistantMsg.progressStatus = progressStatus
        const requestMessageCountBeforeToolBatch = messages.length
        const historyBaseLen = instance.messagesHistory.length
        const bridgeDeepSeekMultiToolBatch = shouldBridgeDeepSeekMultiToolBatch(
          modelConfig,
          apiEndpoint,
          modelId,
          assistantMsg.tool_calls
        )
        messages.push(assistantMsg)
        instance.messagesHistory.push(assistantMsg)
        instance._chatHistoryDirty = true
        if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
        else projects.saveProjectChatHistory(instance)
        taskRuns.event(runRef, 'assistant_tool_calls', {
          loopCount,
          toolCount: assistantMsg.tool_calls.length,
          tools: assistantMsg.tool_calls.map(tc => tc.function?.name).filter(Boolean),
          progressStatus,
          reasoningChars: String(assistantMsg.reasoning_content || '').length
        })

        // 只读工具可并行；写入/命令/询问等独占，作为顺序屏障。
        const executeOneTool = async (tc) => {
          const toolName = tc.function.name
          const toolArgsParseResult = parseToolArgs(tc.function.arguments, { fallback: {}, toolName })
          let toolArgs = toolArgsParseResult.args
          lingxiHarness.createItem(turnRuntime, {
            id: tc.id,
            type: toolName === 'shell_run' || toolName === 'run_command'
              ? 'command_execution'
              : (isMutatingToolName(toolName) ? 'file_change' : 'tool_call'),
            toolName,
            arguments: toolArgsParseResult.ok
              ? toolArgs
              : String(tc.function.arguments || ''),
            status: 'in_progress'
          })
          if (!toolArgsParseResult.ok) {
            const result = buildToolArgsParseErrorResult(toolName, toolArgsParseResult)
            // 尝试从原始参数中提取命令用于显示
            const rawStr = String(tc.function.arguments || '')
            let previewArgs = {}
            if (toolName === 'shell_run' || toolName === 'run_command') {
              // 尝试提取 command 字段
              const cmdMatch = rawStr.match(/"command"\s*:\s*"([^"]*)"/)
              if (cmdMatch) previewArgs = { command: cmdMatch[1] }
            }
            webContents?.send('tool-start', {
              projectId,
              name: toolName,
              args: previewArgs,
              toolCallId: tc.id,
              _parseError: true
            })
            taskRuns.event(runRef, 'tool_argument_parse_failed', {
              loopCount,
              toolCallId: tc.id,
              name: toolName,
              error: toolArgsParseResult.error,
              is_large_text_risk: result.is_large_text_risk || false
            })
            return { tc, toolName, toolArgs: {}, result, error: null }
          }
        if (toolName === 'ask_user_choice') toolArgs = normalizeWebUiChoiceArgs(toolArgs)
        if (toolName === 'confirm_plan') toolArgs = normalizeWebUiPlanArgs(toolArgs)

          if (geminiDirectTransport && toolName === 'shell_run') {
            const command = String(toolArgs?.command || '')
            const directShellWrite = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\(|\b(?:Set-Content|Add-Content|Out-File)\b|(?:^|[^>])>>?(?:[^=]|$)|\becho\b[\s\S]{0,120}>/i.test(command)
            if (directShellWrite) {
              const result = {
                success: false,
                error_type: 'gemini_direct_shell_write_blocked',
                error: 'Gemini 直连禁止通过 shell_run 写源码，以免绕过改动快照、诊断和计划进度。',
                next_action: '请改用 text_edit 或 apply_patch；apply_patch 必须以 *** Begin Patch 开头并以 *** End Patch 结尾。'
              }
              webContents?.send('tool-start', {
                projectId,
                name: toolName,
                args: toolArgs,
                toolCallId: tc.id,
                _recoveryBlocked: true
              })
              return { tc, toolName, toolArgs, result, error: null }
            }
          }

          // Gemini 网页直连只有文本模拟的 tool_calls。沿用普通 API 模型的硬停机会把
          // 一次参数错误永久变成本轮所有后续工具的内部失败，并被页面会话反复放大。
          // 直连只接收下面的恢复提示与重复调用提醒，允许模型换工具或换参数继续；
          // 普通 API 模型保留原有硬保护。
          if (!geminiDirectTransport && (toolFailureRecovery.isStopRequested() || toolFailureRecovery.shouldBlock(toolName))) {
            const result = toolFailureRecovery.isStopRequested()
              ? toolFailureRecovery.getStopBlockResult(toolName)
              : toolFailureRecovery.getBlockResult(toolName)
            webContents?.send('tool-start', {
              projectId,
              name: toolName,
              args: toolArgs,
              toolCallId: tc.id,
              _recoveryBlocked: true,
              _toolLoopStopped: toolFailureRecovery.isStopRequested()
            })
            return { tc, toolName, toolArgs, result, error: null }
          }

          if (shouldRerouteManualLocationFirst([tc], toolCallsRecord, message)) {
            taskRuns.event(runRef, 'tool_navigation_first_hint_skipped_block', {
              loopCount,
              toolCallId: tc.id,
              name: toolName
            })
          }

          try {
            if (signal?.aborted) {
              const timedOut = isApiTimeoutError(signal.reason, signal)
              return {
                tc,
                toolName,
                toolArgs,
                result: {
                  success: false,
                  aborted: !timedOut,
                  error_type: timedOut ? 'TIMEOUT' : 'ABORTED_BEFORE_DISPATCH',
                  error: timedOut
                    ? (signal.reason?.message || '工具调用超时')
                    : 'Error: tool call aborted before dispatch'
                },
                error: signal.reason || null
              }
            }
            throwIfAborted(signal)

            if (toolName === 'report_progress' || toolName === 'show_thinking_note') {
              const rawStatus = toolArgs.status || toolArgs.message || toolArgs.content || toolArgs.progress || toolArgs.note || ''
              const status = toolName === 'show_thinking_note'
                ? normalizePublicThinkingNote(rawStatus)
                : normalizeProgressStatus(rawStatus)
              if (status) {
                if (toolName === 'show_thinking_note') {
                  sendVisibleProgressStatus(status, {
                    preserveContent: true,
                    forceUpdate: true,
                    append: !!toolArgs.append,
                    startNewBlock: !toolArgs.append
                  })
                } else {
                  progressParser.emitStatus(status)
                }
              }
              return {
                tc,
                toolName,
                toolArgs,
                result: {
                  success: true,
                  internal: true,
                  thinkingNote: toolName === 'show_thinking_note',
                  progressStatus: status,
                  message: toolName === 'show_thinking_note' ? 'Thinking note displayed.' : 'Progress status accepted.'
                },
                error: null
              }
            }

            if (toolName === 'start_final_reply') {
              const gate = evaluateRuntimeGateForChat({
                taskType: instance.taskType || instance.inferredTaskType || '',
                userMessage: message,
                toolCalls: toolCallsRecord,
                recoveryAttempts: Number(instance.runtimeGateRecoveryAttempts || 0)
              })
              const decision = runtimeVerificationGate.assertStartFinalReplyAllowed(gate)
              if (!decision.allowed) {
                instance.runtimeGateRecoveryAttempts = Number(instance.runtimeGateRecoveryAttempts || 0) + 1
                instance.runtimeGateOutcome = gate
                console.log('[AIChat] runtime gate blocked start_final_reply:', gate.status, gate.reasons)
                return {
                  tc,
                  toolName,
                  toolArgs,
                  result: {
                    ...decision.resultPatch,
                    recovery_attempts: instance.runtimeGateRecoveryAttempts
                  },
                  error: null
                }
              }
              instance.runtimeGateOutcome = gate
              return {
                tc,
                toolName,
                toolArgs,
                result: {
                  success: true,
                  internal: true,
                  finalReplyArmed: true,
                  runtime_gate: gate.status,
                  blocked_reason: gate.blocked_reason || undefined,
                  claim_policy: decision.resultPatch?.claim_policy,
                  message: gate.status === 'blocked'
                    ? `Final reply armed under degradation: ${gate.blocked_reason || 'blocked'}`
                    : gate.status === 'failed'
                      ? 'Final reply armed after runtime_verify failed. Explain failures; do not claim the issue is fixed.'
                      : 'Final reply stream is armed. Continue with the final answer and do not call more tools.'
                },
                error: null
              }
            }

            // 发送 tool-start 事件（前端预显示）。
            // 流式阶段不再发送预览，统一在此处发送，确保 thinking 块先于工具块。
            webContents?.send('tool-start', {
              projectId,
              name: toolName,
              args: toolArgs,
              toolCallId: tc.id
            })
             lingxiHarness.event(turnRuntime, 'tool_started', {
            loopCount,
            toolCallId: tc.id,
            name: toolName,
            args: summarizeToolArgsForRunLog(toolArgs)
            })

            // 传递完整的 modelConfig 给工具执行
            const toolModelConfig = {
            apiUrl: modelConfig.apiUrl,
            apiKey: modelConfig.apiKey,
            modelName: modelConfig.modelName,
            modelId: effectiveModelId,
            modelKey: modelConfig.modelKey,
            provider: modelConfig.provider || modelConfig.platform || modelConfig.source,
            platform: modelConfig.platform,
            source: modelConfig.source,
            apiFormat: modelConfig.apiFormat || modelConfig.api_format || modelConfig.apiType,
            capabilities: modelConfig.capabilities
            }

            chatVerboseLog('[AIChat] 执行工具:', toolName, 'modelConfig:', JSON.stringify({
            apiUrl: toolModelConfig.apiUrl,
            apiKey: toolModelConfig.apiKey ? '有' : '无',
            modelName: toolModelConfig.modelName,
            modelId: toolModelConfig.modelId
            }))

            const activeProjectPath = instance.projectPath || projectPath
            const result = await executeToolForProject(toolName, toolArgs, activeProjectPath, resolvePath, instance.contextManager || contextManager, projectId, toolModelConfig, {
              signal,
              userMessage: message,
              assistantAnnouncement: [assistantMsg?.reasoning_content, assistantMsg?.content, assistantMsg?.progressStatus].filter(Boolean).join('\n'),
              selectedSkillName: selectedSkillName || instance?.skillName || '',
              geminiDirectTransport,
              collaborationSessionId: instance.collaborationSessionId || '',
              collaborationAgentId: instance.collaborationAgentId || '',
              collaborationAgentName: instance.collaborationAgentName || '',
              collaborationReportFilePath: instance.collaborationReportFilePath || '',
              projectMode,
              chatSessionId: instance?.chatSessionId || '',
              enabledPacks: capabilityState.getLoadedPacks(instance),
              requestId,
              toolCallId: tc.id,
              harnessRuntime: turnRuntime.runtime,
              harnessTurnId: turnRuntime.turnId,
              harnessModelRoute: turnRuntime.modelRoute,
              recordHarnessEvent: (type, payload = {}) => lingxiHarness.event(turnRuntime, type, payload),
              webContents,
              enableToolPack: (packId) => {
                const id = String(packId || '').trim()
                if (!id) return
                capabilityState.enableToolPack(instance, id)
              }
            })
            throwIfAborted(signal)
            if (result && (result.capability || result.routed_tool || result.modelName || result.modelId)) {
              lingxiHarness.event(turnRuntime, 'capability_route_observed', {
                toolCallId: tc.id,
                requestedTool: toolName,
                capability: result.capability || toolName,
                routedTool: result.routed_tool || toolName,
                modelName: result.modelName || result.modelId || result.route_model || '',
                routeMode: result.route_mode || '',
                status: result.status || (result.success === false ? 'failed' : 'completed')
              })
            }
            return { tc, toolName, toolArgs, result, error: null }
          } catch (err) {
            // 工具执行失败（异常 / 中断 / 资源缺失 / 超时 等）→ 返回合成失败结果，
            // 仍然推一条 tool 消息进 messages 和 messagesHistory，保证 assistant(tool_calls)
            // 不会留下悬挂 tool_call_id。
            const isAbort = err && err.name === 'AbortError' || (signal && signal.aborted)
            const timedOut = isApiTimeoutError(err, signal)
            const errorMessage = err && err.message ? String(err.message) : (err ? String(err) : '工具执行失败')
            const errorResult = {
              success: false,
              error: errorMessage,
              aborted: !!(isAbort && !timedOut),
              error_type: timedOut ? 'TIMEOUT' : (isAbort ? 'ABORTED' : 'TOOL_ERROR')
            }
            chatVerboseLog('[AIChat] 工具执行失败:', toolName, 'id:', tc.id, isAbort ? '(已中断)' : '', 'error:', errorMessage)
            return { tc, toolName, toolArgs, result: errorResult, error: err }
          }
        }

        interjectRunner.setRunState(projectId, 'tools')
        const executableCalls = toolCallsData.filter(tc => tc.id)
        const toolResults = []
        const cacheSafeBatchResults = []
        for (const wave of partitionToolWaves(executableCalls)) {
          const settled = await Promise.allSettled(wave.map(executeOneTool))
          for (const s of settled) {
            if (s.status === 'rejected') {
              console.error('[AIChat] 工具 promise rejected（异常）:', s.reason)
              continue
            }
            toolResults.push(s.value)
          }
        }
        // 注意：不在这里 throwIfAborted。即使已中断，也必须先把工具结果写入 messagesHistory，
        // 保证 assistant(tool_calls) 不会留下悬挂的 tool_call_id（Anthropic API 400 错误 2013）。

        // 处理所有结果
        let stopToolLoopForFailures = false
        for (const { tc, toolName, toolArgs, result } of toolResults) {
          lingxiHarness.completeItem(turnRuntime, tc.id, result, {
            status: result?.success === false ? 'failed' : 'completed'
          })
          if (toolName === 'start_final_reply' && result?.success !== false) {
            finalReplyArmed = true
          } else if (!isInternalUiOnlyToolName(toolName)) {
            finalReplyArmed = false
          }
          const recordEntry = { tool_call_id: tc.id, name: toolName, args: toolArgs, result }
          if (toolName === 'record_ai_operation_memo' && result?.success && !result?.skipped) {
            modelAuthoredOperationMemo = result
          }
          const modelResult = geminiDirectTransport
            ? normalizeGeminiDirectToolResultForModel(toolName, result)
            : result
          toolCallsRecord.push(recordEntry)

          const spillCtx = {
            projectPath,
            storagePath: instance.storagePath,
            projectId,
            callId: tc.id
          }
          const modelVisibleResult = toolOutputSpill.applyToToolResult(
            toolName,
            summarizeToolResultForModel(toolName, modelResult),
            spillCtx
          )
          const recovery = toolFailureRecovery.record(toolName, modelResult)
          if (recovery.guidance) {
            modelVisibleResult.recovery_guidance = recovery.guidance
          }
          if (recovery.writeRestricted) {
            modelVisibleResult.recovery_mode = 'write_restricted_until_successful_read'
          }
          if (recovery.stopRequested && !geminiDirectTransport) {
            stopToolLoopForFailures = true
          }
          // 工具失败时，在返回给模型的结果里追加修复引导，避免模型盲目重试或放弃
          if (modelResult?.success === false && !modelResult?.internal && !modelResult?.aborted) {
            const fixGuidance = buildToolFailureGuidance(toolName, modelResult)
            if (fixGuidance) {
              modelVisibleResult.next_action = fixGuidance
            }
          }
          cacheSafeBatchResults.push({
            tool_call_id: tc.id,
            name: toolName,
            arguments: toolArgs,
            result: modelVisibleResult
          })
          const toolMsg = {
            role: 'tool',
            ...turnMessageMetadata,
            tool_call_id: tc.id,
            content: JSON.stringify(modelVisibleResult)
          }
          messages.push(toolMsg)

          const summaryResult = toolOutputSpill.applyToToolResult(
            toolName,
            summarizeToolResultForHistory(toolName, result),
            spillCtx
          )
          const toolMsgForHistory = {
            role: 'tool',
            ...turnMessageMetadata,
            tool_call_id: tc.id,
            content: JSON.stringify(summaryResult)
          }
          instance.messagesHistory.push(toolMsgForHistory)
          instance._chatHistoryDirty = true
          interjectRunner.setRunState(projectId, 'idle')
          projects.saveProjectChatHistoryDeferred?.(projectId)
          if (result?.internal) {
            continue
          }
           lingxiHarness.event(turnRuntime, 'tool_finished', {
            loopCount,
            toolCallId: tc.id,
            name: toolName,
            success: result?.success !== false,
            result: summaryResult
          })

          webContents?.send('tool-result', { projectId, name: toolName, args: toolArgs, result, toolCallId: tc.id })
        }
        if (bridgeDeepSeekMultiToolBatch && cacheSafeBatchResults.length > 1) {
          const bridgeMessages = buildDeepSeekMultiToolCacheBridge(cacheSafeBatchResults)
          messages.splice(requestMessageCountBeforeToolBatch, messages.length - requestMessageCountBeforeToolBatch, ...bridgeMessages)
          // 同步替换 messagesHistory：把原始 assistant(tool_calls) + N 条 tool 消息
          // 替换成桥接后的两条消息，保证下一轮 buildContextPayload 重建前缀时
          // 与本轮发给 API 的消息逐字节一致，避免 DeepSeek 前缀缓存击穿。
          // 标记 hidden：前端不渲染为用户气泡；_deepseekBridge：上下文窗口仍保留给模型。
          const historyRemoveCount = instance.messagesHistory.length - historyBaseLen
          const bridgeMessagesForHistory = bridgeMessages.map(m => ({
            role: m.role,
            content: m.content,
            hidden: true,
            _deepseekBridge: true
          }))
          instance.messagesHistory.splice(historyBaseLen, historyRemoveCount, ...bridgeMessagesForHistory)
          instance._chatHistoryDirty = true
          projects.saveProjectChatHistoryDeferred?.(projectId)
          taskRuns.event(runRef, 'deepseek_multi_tool_cache_bridge', {
            loopCount,
            toolCount: cacheSafeBatchResults.length,
            tools: cacheSafeBatchResults.map(item => item.name),
            bridgeChars: bridgeMessages.reduce((sum, item) => sum + String(item.content || '').length, 0),
            historySynced: true,
            uiHidden: true
          })
        }
        // 工具结果已全部写入 messagesHistory，现在可以安全地检查中断
        throwIfAborted(signal)
        currentToolSectionRealToolCount += realToolCountInBatch
        if (webBridgeModel) {
          // Gemini 直连的失败工具结果会留在同一个 StreamGenerate 会话中。
          // 失败尝试不应累计成“阶段进展”，否则每几次失败就会生成一段
          // 重复的保护机制说明。浏览器桥仍保留原来的阶段节奏。
          const stageProgressToolCount = geminiDirectTransport
            ? toolResults.filter(({ toolName, result }) => (
                isBusinessToolName(toolName) && result?.success !== false && !result?.internal
              )).length
            : realToolCountInBatch
          webBridgeToolsSinceStage += stageProgressToolCount
          if (isWebBridgeReadOnlyToolBatch(toolCallsData)) {
            webBridgeReadOnlyBatches += 1
            if ((looksLikeWebBridgeDirectEditTask(message)
              || (geminiDirectTransport && looksLikeGeminiDirectMutationTask(message)))
              && webBridgeReadOnlyBatches >= 1) {
              webBridgeExecuteNow = true
            }
          } else if (realToolCountInBatch > 0) {
            webBridgeReadOnlyBatches = 0
          }
        }

        const postToolInstructions = stepAssembly.collectPostToolInstructions({
          webBridge: webBridgeModel,
          projectId,
          userMessage: message,
          toolCallsThisBatch: toolCallsData,
          toolResults,
          toolCallsRecord,
          explorationNudgeKeys,
          inspectDocsNudgeUsed,
          wiringNudgeUsed,
          projectPath,
          repeatTracker: repeatToolReminder,
          stopInstruction: stopToolLoopForFailures ? toolFailureRecovery.getStopInstruction() : '',
          getExecutionModeDesc,
          getExecutionModeRules
        })
        stepAssembly.applyStepInstructions(messages, postToolInstructions, {
          apiFormat,
          onApply: (item) => {
            if (item.key) explorationNudgeKeys.add(item.key)
            if (item.markInspectUsed) inspectDocsNudgeUsed = true
            if (item.markWiringUsed) wiringNudgeUsed = true
            if (item.keepLoop) continueLoop = true
            if (item.event) {
              taskRuns.event(runRef, item.event, {
                loopCount,
                ...(item.eventPayload || {})
              })
            }
          }
        })

        if (!continueLoop) {
          break
        }
      }

      if (webBridgeModel) {
        const blockingWrites = getWebBridgeBlockingWrites()
        if (blockingWrites.length) {
          clearWebBridgeFinalLock()
          webBridgeExecuteNow = true
          webBridgePhase = 'tools'
          webBridgeToolsSinceStage = 0
          pushWebBridgeFollowup(buildWebBridgeBlockingWriteFixPrompt(blockingWrites))
        } else if (webBridgeFinalBody) {
          continueLoop = false
          break
        } else if (!webBridgeFinalLocked && webBridgePhase !== 'stage' && shouldRequestWebBridgeStage(webBridgeToolsSinceStage)) {
          webBridgeToolsSinceStage = 0
          // 浏览器 DOM 桥为了减少往返，可以在执行型任务中跳过阶段气泡；
          // Gemini 直连则用 reasoning_content 承载阶段说明，不存在 DOM 抓取成本，
          // 必须保留阶段轮，才能稳定形成“思考块 -> 继续执行”的 API 式体验。
          if (!geminiDirectTransport && shouldSkipWebBridgeStageForExecute({
            userText: message,
            readOnlyBatches: webBridgeReadOnlyBatches
          })) {
            webBridgeExecuteNow = true
            webBridgeHasVisibleStageNote = false
            pushWebBridgeFollowup(buildWebBridgeKeepGoingPrompt({
              ...webBridgePromptOpts,
              executeNow: true
            }))
          } else {
            webBridgePhase = 'stage'
            pushWebBridgeFollowup(buildWebBridgeStageReplyPrompt(webBridgePromptOpts))
          }
        }
      }

      // 继续请求（检查是否有新的工具调用）
      throwIfAborted(signal)
      if (isEmptyModelCompletion({
        content: fullContent,
        toolCalls: toolCallsData,
        reasoning: fullReasoningContent,
        webBridge: webBridgeModel
      })) {
        const delayMs = resolveRetryDelayMs({ code: 'EMPTY_RESPONSE' }, Math.max(1, emptyCompletionRetries))
        await waitForLlmRetry(delayMs, signal)
      }
      absorbPendingInterjectAtStepBoundary()
      chatVerboseLog('[AIChat] 发送继续请求...')

      // 发送状态：等待模型继续输出真实过程播报或最终结果。
      taskRuns.event(runRef, 'model_continue_prepare', {
        loopCount,
        messageCount: messages.length,
        toolCallCount: toolCallsRecord.length
      })
      const latestCacheUsage = cacheUsageTracker.getLatest()
      const deepSeekCachePacingEnabled = modelConfig.deepSeekCachePacing !== false && modelConfig.deepseek_cache_pacing !== false
      const cacheCapability = getPromptCacheCapability(modelConfig, apiEndpoint, modelId)
      const isDeepSeekCacheProvider = cacheCapability.id === 'deepseek'
      if (deepSeekCachePacingEnabled && isDeepSeekCacheProvider && latestCacheUsage?.observedAt) {
        const cacheRate = Number(latestCacheUsage.cacheRate)
        // A high hit rate only proves that the old prefix was cached. The assistant/tool
        // messages appended by this request still need seconds to become a new cache unit.
        const targetSettleMs = getDeepSeekCacheSettleTargetMs(modelConfig, cacheRate)
        const elapsedSinceUsageMs = Math.max(0, Date.now() - latestCacheUsage.observedAt)
        const remainingSettleMs = Math.max(0, targetSettleMs - elapsedSinceUsageMs)
        if (remainingSettleMs > 0) {
          taskRuns.event(runRef, 'deepseek_cache_settle_wait', {
            loopCount,
            provider: cacheCapability.id,
            cacheRate: Number.isFinite(cacheRate) ? Number(cacheRate.toFixed(2)) : null,
            targetSettleMs,
            elapsedSinceUsageMs,
            waitMs: remainingSettleMs
          })
          await waitForCacheSettle(remainingSettleMs, signal)
        }
      }
      webContents?.send('ai-status', { projectId, status: 'thinking' })
      if (!webBridgeModel) {
        webContents?.send('ai-thinking-reset', { projectId })
      }

      finishNativeReasoningStream()
      holdNativeReasoningForLengthRouting = geminiDirectTransport && webBridgePhase === 'stage'
      const continueApiWatchdog = startApiWatchdog('模型继续接口')
      const continueProgressHeartbeat = startVisibleProgressHeartbeat(`continue-${loopCount}`)
      let continueResponse
      const continueStartedAt = Date.now()
      let continueHeadersMs = 0
      let continueFirstChunkSeen = false
      try {
        cacheUsageTracker.start(`continue-${loopCount}`)
        taskRuns.event(runRef, 'model_continue_request_start', { loopCount })
        interjectRunner.setRunState(projectId, 'streaming')
        continueResponse = await fetchModelStream(`continue-${loopCount}`)
        continueHeadersMs = Date.now() - continueStartedAt
        taskRuns.event(runRef, 'model_continue_response_started', {
          loopCount,
          headersMs: continueHeadersMs,
          requestProfile: perfProfile.continueProfiles[perfProfile.continueProfiles.length - 1] || null
        })
        continueApiWatchdog.touch('stream')
      } catch (error) {
        stopApiWatchdog(continueApiWatchdog)
        stopVisibleProgressHeartbeat(continueProgressHeartbeat)
        throwIfAborted(signal)
        cacheUsageTracker.fail(error.message)
        throw error
      }

      const continueReader = continueResponse.body.getReader()
      let continueBuffer = ''
      toolCallsData = []  // 重置工具调用数据
      hasToolCalls = false
      fullContent = ''    // 重置内容
      fullReasoningContent = ''  // 重置思考内容，只保留本轮
      fullReasoningDetails = []
      latestAnthropicContentBlocks = null
      streamState = createAnthropicStreamState()
      progressParser = createProgressStatusParser(status => {
        sendVisibleProgressStatus(status)
      })
      progressNarration = createProgressNarrationTracker(webContents, projectId)
      toolArgumentProgress = createToolArgumentProgressTracker(webContents, projectId, {
        chatSessionId: instance?.chatSessionId || instance?.collaborationSessionId || ''
      })

      while (true) {
        throwIfAborted(signal)
        const { done: cd, value: cv } = await continueReader.read()
        if (cd) break
        markStreamActivity()
        continueApiWatchdog.touch('stream')
        if (!continueFirstChunkSeen) {
          continueFirstChunkSeen = true
          taskRuns.event(runRef, 'model_continue_first_chunk', {
            loopCount,
            firstChunkMs: Date.now() - continueStartedAt,
            headersMs: continueHeadersMs,
            requestProfile: perfProfile.continueProfiles[perfProfile.continueProfiles.length - 1] || null
          })
        }
        continueBuffer += decoder.decode(cv, { stream: true })
        const clines = continueBuffer.split('\n')
        continueBuffer = clines.pop() || ''
        for (const cline of clines) {
          if (!cline.trim() || !cline.startsWith('data:')) continue
          const cdata = cline.slice(5).trim()
          if (cdata === '[DONE]') continue
          try {
            const cjson = JSON.parse(cdata)
            const streamError = createStreamPayloadError(cjson)
            if (streamError) throw streamError
            const cdelta = parseModelStreamEvent(cjson, streamState, activeApiFormat)
            if (cdelta) markStreamActivity()
            if (cdelta?.usage) cacheUsageTracker.record(cdelta.usage, `continue-${loopCount}`)
            if (isMiniMaxM3Model(modelConfig, modelId) && Array.isArray(cdelta?.reasoning_details)) {
              fullReasoningDetails.push(...cdelta.reasoning_details)
            }
            if (isMiniMaxM3Model(modelConfig, modelId) && Array.isArray(cdelta?.content_blocks)) {
              latestAnthropicContentBlocks = cdelta.content_blocks
            }
            if (cdelta?.reasoning_content) {
              fullReasoningContent += cdelta.reasoning_content
              sendNativeReasoningDelta(cdelta.reasoning_content)
            }
            if (cdelta?.content) {
              const visibleContent = progressParser.process(cdelta.content)
              if (visibleContent) {
                consumeVisibleContentForFinalStream(visibleContent)
              }
            }
            // 检查新的工具调用
            if (hasMeaningfulToolCallDelta(cdelta?.tool_calls)) {
              finishNativeReasoningStream()
              resetFinalDelta()
              finalReplyArmed = false
              if (!hasToolCalls) {
                progressNarration.flush({ discard: progressParser.hasEmittedStatus() })
                if (allowContentAsProgressNarration && !progressParser.hasEmittedStatus() && !progressNarration.hasProgress() && fullContent.trim()) {
                  progressNarration.markFromText(fullContent)
                  fullContent = ''
                }
              }
              hasToolCalls = true
              for (const tc of cdelta.tool_calls) {
                const idx = tc.index ?? toolCallsData.length
                while (toolCallsData.length <= idx) {
                  toolCallsData.push({ id: '', type: 'function', function: { name: '', arguments: '' } })
                }
                if (tc.id) toolCallsData[idx].id = tc.id
                if (tc.function?.name) toolCallsData[idx].function.name = tc.function.name
                if (tc.function?.arguments) {
                  toolCallsData[idx].function.arguments += tc.function.arguments
                  toolArgumentProgress.update(toolCallsData[idx])
                }
                previewStreamingToolCall(toolCallsData[idx])
              }
            }
          } catch (e) {
            if (e?.isModelStreamPayloadError) throw e
          }
        }
      }
      stopApiWatchdog(continueApiWatchdog)
      stopVisibleProgressHeartbeat(continueProgressHeartbeat)
      cacheUsageTracker.finish(`continue-${loopCount}`)

      progressNarration.flush({ discard: progressParser.hasEmittedStatus() || !hasToolCalls })
      const remainingContinueContent = progressParser.flush()
      if (remainingContinueContent) {
        consumeVisibleContentForFinalStream(remainingContinueContent)
      }
      if (webBridgeModel) {
        toolCallsData = normalizeGeminiDirectToolCalls(toolCallsData)
        liftGeminiDirectReasoningStage()
        holdNativeReasoningForLengthRouting = false
        liftWebBridgeStageNote()
        const extracted = extractWebBridgeFinalReply(fullContent)
        if (extracted.done) {
          const locked = tryLockWebBridgeFinalReply(fullContent)
          if (locked === 'final') {
            fullContent = extracted.visible
          } else if (typeof locked === 'string' && locked.startsWith('reject-final')) {
            fullContent = ''
            webBridgeResumeTools = true
          }
        }
      }
      if (webBridgeModel && webBridgePhase !== 'stage' && hasToolCalls && toolCallsData.length > 0 && fullContent.trim()) {
        const parked = parkWebBridgeStageNote(fullContent)
        if (parked === 'final') {
          fullContent = webBridgeFinalBody
        } else if (typeof parked === 'string' && parked.startsWith('reject-final')) {
          resetFinalDelta()
          fullContent = ''
          webBridgeResumeTools = true
        } else if (parked) {
          resetFinalDelta()
          fullContent = ''
          if (!isWebBridgePlanToolBatch(toolCallsData)) webBridgeHasVisibleStageNote = true
        }
      }
      if (webBridgeFinalBody && !(hasToolCalls && toolCallsData.length > 0) && !webBridgeHeldToolCalls.length) {
        fullContent = webBridgeFinalBody
      }
      if (webBridgeModel && webBridgePhase === 'stage' && !webBridgeFinalBody) {
        const parked = parkWebBridgeStageNote(fullContent)
        if (parked === 'final') {
          fullContent = webBridgeFinalBody
        } else if (typeof parked === 'string' && parked.startsWith('reject-final')) {
          resetFinalDelta()
          fullContent = ''
          webBridgeResumeTools = true
        } else if (parked) {
          resetFinalDelta()
          fullContent = ''
          if (!webBridgeHeldToolCalls.length && !(hasToolCalls && toolCallsData.length > 0)) {
            resumeAfterWebBridgeStage()
          }
        }
      }
      if (webBridgeModel && !webBridgeFinalLocked && !webBridgeResumeTools && !(hasToolCalls && toolCallsData.length > 0) && shouldNudgeWebBridgeForMissingTools({
        userText: message,
        content: fullContent,
        dialect: webBridgePromptOpts.dialect
      })) {
        webBridgeFinalBody = ''
        resetFinalDelta()
        fullContent = ''
        webBridgeOpenedStage = true
        webBridgePhase = 'tools'
        if (webBridgeKeepGoingAttempts < WEB_BRIDGE_KEEP_GOING_MAX) {
          pushWebBridgeFollowup(buildWebBridgeNoToolsNudgePrompt(webBridgePromptOpts))
          webBridgeResumeTools = true
          webBridgeKeepGoingAttempts += 1
        }
      }
      if (allowContentAsProgressNarration && hasToolCalls && toolCallsData.length > 0 && fullContent.trim() && !webBridgeFinalBody) {
        resetFinalDelta()
        finalReplyArmed = false
        progressNarration.markFromText(fullContent)
        fullContent = ''
      }
      toolCallsData.forEach(tc => toolArgumentProgress.complete(tc))
      if (webBridgeHeldToolCalls.length && webBridgePhase === 'tools' && webBridgeOpenedStage) {
        toolCallsData = webBridgeHeldToolCalls
        hasToolCalls = true
        webBridgeHeldToolCalls = []
      }
      const hasNewToolCalls = hasToolCalls && toolCallsData.length > 0
      lastModelReplyHadNoToolCalls = !hasNewToolCalls && fullContent.trim().length > 0
      continueLoop = hasNewToolCalls || webBridgeResumeTools ||
        interjectRunner.peekPendingInterjectMessages(projectId).length > 0
      if (!continueLoop && isEmptyModelCompletion({
        content: fullContent,
        toolCalls: toolCallsData,
        reasoning: fullReasoningContent,
        webBridge: webBridgeModel
      }) && emptyCompletionRetries < 2) {
        emptyCompletionRetries += 1
        continueLoop = true
        taskRuns.event(runRef, 'llm_retry', {
          label: `continue-${loopCount}`,
          code: 'EMPTY_RESPONSE',
          attempt: emptyCompletionRetries,
          delayMs: resolveRetryDelayMs({ code: 'EMPTY_RESPONSE' }, emptyCompletionRetries)
        })
      }
      webBridgeResumeTools = false
      chatVerboseLog('[AIChat] 继续响应完成, 有新工具调用:', hasNewToolCalls, '本轮正文:', fullContent.length)
    }

    if (absorbPendingInterjectAtStepBoundary()) {
      continueLoop = true
      continue
    }

    if (Array.isArray(instance.autoExecSteps) && instance.autoExecSteps.length > 0) {
      instance.autoExecSteps = []
      instance.autoExecStepIndex = 0
      instance.autoExecStepEvidenceIndex = 0
      resetAutoExecContinuationState()
    }

    if (isProcessOnlyContinuationText(fullContent)) {
      fullContent = sanitizeFinalContent(fullContent)
    }

    if (webBridgeModel && !webBridgeFinalLocked && shouldNudgeWebBridgeForMissingTools({ userText: message, content: webBridgeFinalBody || fullContent, dialect: webBridgePromptOpts.dialect }) && webBridgeKeepGoingAttempts < WEB_BRIDGE_KEEP_GOING_MAX) {
      webBridgeFinalBody = ''
      resetFinalDelta()
      fullContent = ''
      webBridgeOpenedStage = true
      webBridgePhase = 'tools'
      pushWebBridgeFollowup(buildWebBridgeNoToolsNudgePrompt(webBridgePromptOpts))
      webBridgeResumeTools = true
      webBridgeKeepGoingAttempts += 1
      continueLoop = true
      continue
    }
    if (webBridgeFinalLocked || webBridgeFinalBody) {
      const blockingWrites = getWebBridgeBlockingWrites()
      if (blockingWrites.length) {
        rejectWebBridgeFinalReply('blocking')
        fullContent = ''
        continueLoop = true
        continue
      }
      fullContent = webBridgeFinalBody || fullContent
    } else if (webBridgeModel && (toolCallsRecord.length > 0 || webBridgeHeldToolCalls.length || webBridgePhase === 'stage')) {
      if (webBridgePhase === 'stage') {
        const parked = parkWebBridgeStageNote(fullContent)
        if (parked === 'final') {
          fullContent = webBridgeFinalBody
        } else if (typeof parked === 'string' && parked.startsWith('reject-final')) {
          resetFinalDelta()
          fullContent = ''
          continueLoop = true
          continue
        } else if (parked) {
          resetFinalDelta()
          fullContent = ''
          resumeAfterWebBridgeStage()
          continueLoop = true
          continue
        }
        if (webBridgeKeepGoingAttempts < WEB_BRIDGE_KEEP_GOING_MAX) {
          webBridgeKeepGoingAttempts += 1
          if (webBridgeExecuteNow || looksLikeWebBridgeConfirmStall(fullContent)) {
            webBridgePhase = 'tools'
            pushWebBridgeFollowup(buildWebBridgeKeepGoingPrompt({
              ...webBridgePromptOpts,
              executeNow: true
            }))
          } else {
            pushWebBridgeFollowup(
              webBridgeOpenedStage
                ? buildWebBridgeStageReplyPrompt(webBridgePromptOpts)
                : buildWebBridgeOpeningStagePrompt(webBridgePromptOpts)
            )
          }
          resetFinalDelta()
          fullContent = ''
          continueLoop = true
          continue
        }
        if (webBridgeHeldToolCalls.length) {
          webBridgePhase = 'tools'
          resumeAfterWebBridgeStage()
          continueLoop = true
          continue
        }
      } else if (getWebBridgeBlockingWrites().length) {
        rejectWebBridgeFinalReply('blocking')
        fullContent = ''
        continueLoop = true
        continue
      } else if (webBridgeKeepGoingAttempts < WEB_BRIDGE_KEEP_GOING_MAX && webBridgeInspectNeedsMore(message, toolCallsRecord)) {
        webBridgeKeepGoingAttempts += 1
        webBridgePhase = 'tools'
        pushWebBridgeFollowup(buildWebBridgeInspectKeepGoingPrompt({
          userText: message,
          toolCalls: toolCallsRecord,
          dialect: webBridgePromptOpts.dialect
        }))
        resetFinalDelta()
        fullContent = ''
        continueLoop = true
        continue
      } else if (shouldPromoteWebBridgeTextToFinal({ userText: message, text: fullContent, toolCalls: toolCallsRecord })) {
        webBridgeFinalBody = normalizeWebBridgeFinalBody(fullContent)
        fullContent = webBridgeFinalBody
      } else if (shouldRequestWebBridgeStage(webBridgeToolsSinceStage)) {
        webBridgeToolsSinceStage = 0
        if (!geminiDirectTransport && shouldSkipWebBridgeStageForExecute({
          userText: message,
          stageText: fullContent,
          readOnlyBatches: webBridgeReadOnlyBatches
        })) {
          webBridgeExecuteNow = true
          webBridgeHasVisibleStageNote = false
          pushWebBridgeFollowup(buildWebBridgeKeepGoingPrompt({
            ...webBridgePromptOpts,
            executeNow: true
          }))
        } else {
          webBridgePhase = 'stage'
          pushWebBridgeFollowup(buildWebBridgeStageReplyPrompt(webBridgePromptOpts))
        }
        resetFinalDelta()
        fullContent = ''
        continueLoop = true
        continue
      } else {
        const inspectNeedsMore = webBridgeKeepGoingAttempts < WEB_BRIDGE_KEEP_GOING_MAX
          && webBridgeInspectNeedsMore(message, toolCallsRecord)
        const decision = classifyWebBridgeAssistantReply(fullContent, {
          hadToolsThisTurn: true,
          keepGoingAttempts: webBridgeKeepGoingAttempts,
          userText: message,
          dialect: webBridgePromptOpts.dialect,
          stageTurn: webBridgePhase === 'stage',
          blockingWrites: getWebBridgeBlockingWrites().length > 0,
          inspectNeedsMore
        })
        if (decision === 'continue') {
          throwIfAborted(signal)
          const note = clipWebBridgeThinkingNote(fullContent)
          if (note && !isWebThinkingPlaceholder(note)) {
            sendVisibleProgressStatus(note, {
              preserveContent: true,
              append: false,
              startNewBlock: true,
              forceUpdate: true
            })
          }
          webBridgeKeepGoingAttempts += 1
          console.log('[AIChat] web bridge keep-going', webBridgeKeepGoingAttempts)
          const blockingWrites = getWebBridgeBlockingWrites()
          const inspectPrompt = inspectNeedsMore
            ? buildWebBridgeInspectKeepGoingPrompt({
              userText: message,
              toolCalls: toolCallsRecord,
              dialect: webBridgePromptOpts.dialect
            })
            : ''
          pushWebBridgeFollowup(blockingWrites.length
            ? buildWebBridgeBlockingWriteFixPrompt(blockingWrites)
            : (inspectPrompt || buildWebBridgeKeepGoingPrompt({
              ...webBridgePromptOpts,
              executeNow: webBridgeExecuteNow || looksLikeWebBridgeConfirmStall(fullContent),
              userText: message,
              toolCalls: toolCallsRecord
            })))
          resetFinalDelta()
          fullContent = ''
          continueLoop = true
          continue
        }
        if (fullContent.trim()) fullContent = normalizeWebBridgeFinalBody(fullContent)
      }
    }

    const needsPostWriteVerifyContinuation = hasWriteToolNeedingPostVerification(toolCallsRecord) &&
      !hasPostWriteVerification(toolCallsRecord) &&
      !postWriteVerifyRetryUsed
    const continuationNudge = needsPostWriteVerifyContinuation ? buildPostWriteVerifyNudge(toolCallsRecord) : ''
    if (continuationNudge && !webBridgeModel) {
      throwIfAborted(signal)
      const hasMeaningfulContent = fullContent.trim().length > 0
      if (!projectReviewTask && lastModelReplyHadNoToolCalls && noToolQualityRetryCount >= 1) {
        chatVerboseLog('[AIChat] 改后复查续跑没有产生工具调用，接受当前正文以避免空转')
      } else if (hasMeaningfulContent && lastModelReplyHadNoToolCalls) {
        // 模型已输出最终回复但未验证：追加警告到正文，不再强制清空重跑
        console.log('[AIChat] 改后未验证但已有最终回复，追加警告而非强制续跑')
        postWriteVerifyRetryUsed = true
        const verifyWarning = '\n\n---\n改后复查提醒：本轮已修改文件但未执行验证（code_verify / dev_workflow mode=verify）。如需确认改动安全，请单独触发验证。'
        fullContent = sanitizeFinalContent(fullContent) + verifyWarning
      } else {
        if (lastModelReplyHadNoToolCalls) noToolQualityRetryCount++
        postWriteVerifyRetryUsed = true
        pushInternalInstruction(messages, continuationNudge)
        resetFinalDelta()
        fullContent = ''
        continueLoop = true
        continue
      }
    }

    // L1 运行态硬门禁续跑：UI 面改动后必须有合格 runtime_verify 才允许静默收尾
    const runtimeGate = evaluateRuntimeGateForChat({
      taskType: instance.taskType || instance.inferredTaskType || '',
      userMessage: message,
      toolCalls: toolCallsRecord,
      recoveryAttempts: Number(instance.runtimeGateRecoveryAttempts || 0)
    })
    instance.runtimeGateOutcome = runtimeGate
    if (
      !webBridgeModel &&
      runtimeGate.required === true &&
      (runtimeGate.status === 'missing' || runtimeGate.status === 'incomplete')
    ) {
      throwIfAborted(signal)
      const attempts = Number(instance.runtimeGateRecoveryAttempts || 0)
      if (attempts < runtimeVerificationGate.MAX_RUNTIME_GATE_RECOVERY) {
        instance.runtimeGateRecoveryAttempts = attempts + 1
        runtimeGateContinuationUsed = true
        const runtimeNudge = runtimeVerificationGate.buildRuntimeGateContinuationNudge(runtimeGate)
        console.log('[AIChat] runtime gate continuation:', runtimeGate.status, runtimeGate.reasons, 'attempt', instance.runtimeGateRecoveryAttempts)
        pushInternalInstruction(messages, runtimeNudge)
        resetFinalDelta()
        fullContent = ''
        finalReplyArmed = false
        continueLoop = true
        continue
      }
      // 超过恢复次数：诚实降级，允许收尾但禁止宣称已验证
      const degrade = evaluateRuntimeGateForChat({
        taskType: instance.taskType || instance.inferredTaskType || '',
        userMessage: message,
        toolCalls: toolCallsRecord,
        recoveryAttempts: attempts
      })
      instance.runtimeGateOutcome = degrade
      console.log('[AIChat] runtime gate degraded to blocked:', degrade.blocked_reason || degrade.status)
      if (fullContent.trim() && !fullContent.includes('运行态验证')) {
        fullContent = sanitizeFinalContent(fullContent) +
          `\n\n---\n运行态验证未完成（${degrade.blocked_reason || degrade.status}）：不得宣称 UI/运行问题已验证通过。`
      }
    }

    const preFinalInstructions = stepAssembly.collectPreFinalInstructions({
      webBridge: webBridgeModel,
      projectId,
      projectPath,
      userMessage: message,
      toolCallsRecord,
      inspectDocsNudgeUsed,
      wiringNudgeUsed,
      planFinalNudgeUsed
    })
    if (preFinalInstructions.length) {
      stepAssembly.applyStepInstructions(messages, preFinalInstructions, {
        apiFormat,
        onApply: (item) => {
          if (item.markInspectUsed) inspectDocsNudgeUsed = true
          if (item.markWiringUsed) wiringNudgeUsed = true
          if (item.markPlanFinalUsed) planFinalNudgeUsed = true
          if (item.event) {
            taskRuns.event(runRef, item.event, {
              loopCount,
              ...(item.eventPayload || {})
            })
          }
        }
      })
      if (preFinalInstructions.some(item => item.resetFinal)) {
        resetFinalDelta()
        fullContent = ''
        finalReplyArmed = false
      }
      if (preFinalInstructions.some(item => item.keepLoop)) {
        continueLoop = true
        continue
      }
    }

    // Gemini 网页直连由文本协议模拟函数调用。模型即使提前输出普通总结，
    // 编码任务也必须由本地执行证据决定是否收口：至少成功写入，并在最新写入后
    // 成功验证。该门禁只作用于 Gemini direct，不改变浏览器桥和普通 API 模型。
    if (geminiDirectTransport && geminiDirectCompletionGateAttempts < 8) {
      const completionGatePrompt = buildGeminiDirectCompletionGatePrompt(message, toolCallsRecord)
      if (completionGatePrompt) {
        geminiDirectCompletionGateAttempts += 1
        clearWebBridgeFinalLock()
        resetFinalDelta()
        fullContent = ''
        webBridgePhase = 'tools'
        webBridgeResumeTools = true
        webBridgeExecuteNow = true
        pushWebBridgeFollowup(completionGatePrompt)
        taskRuns.event(runRef, 'gemini_direct_completion_gate', {
          loopCount,
          attempt: geminiDirectCompletionGateAttempts,
          hasSuccessfulWrite: hasSuccessfulGeminiDirectWrite(toolCallsRecord),
          hasSuccessfulPostWriteVerification: hasSuccessfulGeminiDirectPostWriteVerification(toolCallsRecord)
        })
        continueLoop = true
        continue
      }
    }

    break
    }

    // 最终完成：只输出最后一轮正文（AI的任务完成总结）
    // 过程中的正文片段已经通过 ai-intermediate-content 显示
    throwIfAborted(signal)
    finalizedChangeSession = finishChangeSession('completed')
    let reviewResult = null

    let baseFinalContent = ensureUsableFinalContent(sanitizeFinalContent(fullContent), {
      userMessage: message,
      changeSession: finalizedChangeSession,
      toolCalls: toolCallsRecord
    })
    // 运行态门禁降级/失败时，附带不可宣称已修好的约束（防模型空口收尾）
    try {
      if (!webBridgeModel) {
        const outcome = instance.runtimeGateOutcome || evaluateRuntimeGateForChat({
          taskType: instance.taskType || instance.inferredTaskType || '',
          userMessage: message,
          toolCalls: toolCallsRecord,
          recoveryAttempts: Number(instance.runtimeGateRecoveryAttempts || 0)
        })
        if (outcome?.required && (outcome.status === 'failed' || outcome.status === 'blocked')) {
          const note = outcome.status === 'failed'
            ? '\n\n---\n运行态验证结果：failed。以上结论不得写成“已修好/已验证通过”；请以 runtime_verify 失败证据为准。'
            : `\n\n---\n运行态验证未完成（${outcome.blocked_reason || 'blocked'}）。不得宣称 UI/运行问题已验证通过。`
          if (!baseFinalContent.includes('运行态验证')) {
            baseFinalContent = `${baseFinalContent}${note}`
          }
        }
      }
    } catch (_) { /* gate is best-effort on final content */ }
    // 内嵌可视化：模型漏写 directive 时自动补到最终回复，保证自然呈现
    try {
      const { appendMissingVisualDirectives } = require('./inline-visualize')
      baseFinalContent = appendMissingVisualDirectives(baseFinalContent, toolCallsRecord)
    } catch (_) { /* optional */ }
    const fullFinalContent = baseFinalContent
    const effectiveProjectPath = instance.projectPath || projectPath || instance.storagePath
    let finalContent = fullFinalContent
    if (researchContext) {
      const changedFiles = Array.isArray(finalizedChangeSession?.files)
        ? finalizedChangeSession.files.filter(item => item?.path)
        : []
      if (changedFiles.length > 0) {
        webContents?.send('ai-status', { projectId, status: 'waiting', label: '等待确认是否对照研究约束审查本轮改动' })
        try {
          const decision = await researchMode.askToAudit({ projectId, webContents, changedFiles })
          if (decision.enabled) {
            webContents?.send('ai-status', { projectId, status: 'thinking', label: '正在对照研究约束审查本轮改动' })
            const audit = await researchMode.auditFinal({
              instance,
              projectId,
              projectPath: effectiveProjectPath,
              modelConfig,
              signal,
              constraints: researchContext.constraints,
              finalContent: fullFinalContent
            })
            if (audit.violation) {
              const report = String(audit.report || '研究约束审查未给出可验证的通过结论。').slice(0, 8000)
              finalContent = `${fullFinalContent}\n\n研究约束审查发现违规或证据缺口：\n${report}`
            }
          }
        } catch (error) {
          finalContent = `${fullFinalContent}\n\n研究约束审查未通过：审查确认或执行未能完成（${error.message || error}）。本轮实现不得视为已经通过研究约束验收。`
        }
      }
      try {
        const considered = await researchMode.considerFinalCandidate({
          instance,
          projectId,
          projectPath: effectiveProjectPath,
          webContents,
          modelConfig,
          signal,
          constraints: researchContext.constraints,
          finalContent: fullFinalContent
        })
        researchContext.constraints = considered.constraints
        if (considered.analysis?.conflict && !finalContent.includes('研究约束审查发现违规')) {
          const details = considered.analysis.violations.map((item, index) => `${index + 1}. ${item.constraintId ? `[${item.constraintId}] ` : ''}${item.reason}`).join('\n')
          finalContent = `${finalContent}\n\n研究约束审查发现违规：\n${details || considered.analysis.refusal || '最终回复与已采纳约束冲突。'}`
        }
      } catch (error) {
        finalContent = `${finalContent}\n\n研究约束条款复盘未完成：无法判断本轮最终回复是否形成新的候选条款（${error.message || error}）。`
      }
    }
    const artifactPayload = artifacts.maybeCreateLongTextArtifact(instance, finalContent, {
      taskMeta: {
        userMessage: message,
        toolCallsRecord,
        reviewResult,
        hasChangeSession: !!(finalizedChangeSession?.fileCount || finalizedChangeSession?.mutatingCommandCount)
      }
    })
    const requestCompletedAt = Date.now()
    finishNativeReasoningStream()
    const durationMs = Math.max(0, requestCompletedAt - requestStartedAt)
    const finalAssistantMsg = {
      role: 'assistant',
      content: artifactPayload.content,
      ...turnMessageMetadata,
      ...assistantModelMetadata,
      startedAt: requestStartedAt,
      completedAt: requestCompletedAt,
      durationMs,
      time: new Date().toISOString()
    }
    if (artifactPayload.artifacts.length > 0) finalAssistantMsg.artifacts = artifactPayload.artifacts
    if (fullReasoningContent) finalAssistantMsg.reasoning_content = fullReasoningContent
    if (isMiniMaxM3Model(modelConfig, modelId) && fullReasoningDetails.length) finalAssistantMsg.reasoning_details = fullReasoningDetails
    if (isMiniMaxM3Model(modelConfig, modelId) && activeApiFormat === 'anthropic' && latestAnthropicContentBlocks) finalAssistantMsg.anthropic_content = latestAnthropicContentBlocks
    if (finalizedChangeSession?.fileCount || finalizedChangeSession?.mutatingCommandCount) {
      finalAssistantMsg.changeSession = finalizedChangeSession
    }
    instance.messagesHistory.push(finalAssistantMsg)
    instance._chatHistoryDirty = true
    if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
    else projects.saveProjectChatHistory(instance)
    // messagesHistory 是给模型 API 的兼容视图；Turn/Item 是给恢复、诊断和后续
    // UI 的事实视图。最终回复也必须作为 item 落盘，否则项目切换后只能看到工具，
    // 无法把这一轮和最终结论可靠地关联起来。
    lingxiHarness.addAgentMessage(turnRuntime, artifactPayload.content, {
      id: `agent-${runRef.runId}-final`,
      startedAt: requestStartedAt,
      completedAt: requestCompletedAt,
      durationMs
    })

    let operationMemo = null
    try {
      if (modelAuthoredOperationMemo?.success && !modelAuthoredOperationMemo.skipped) {
        operationMemo = modelAuthoredOperationMemo
      } else if ((finalizedChangeSession?.fileCount || finalizedChangeSession?.mutatingCommandCount) && !isOperationMemoBackfillMessage(message)) {
        const memoChangeSession = changeSessions.getChangeSession(projectId, finalizedChangeSession.id, { includeContent: true }) || finalizedChangeSession
        operationMemo = aiOperationMemos.buildBackfillPayload({
          projectId,
          projectPath: effectiveProjectPath,
          requestId,
          userMessage: message,
          finalSummary: artifactPayload.content,
          modelName,
          changeSession: memoChangeSession,
          startedAt: requestStartedAt,
          completedAt: requestCompletedAt,
          durationMs
        })
      }
    } catch (memoError) {
      console.warn('[AIOperationMemo] 创建备忘录失败:', memoError.message)
      operationMemo = { success: false, error: memoError.message }
    }

    const requestWasCurrent = requestIsCurrent()
    deleteAbortControllerIfCurrent()
    if (requestWasCurrent) webContents?.send('ai-status', { projectId, status: 'done' })
    cacheUsageTracker.final()
    taskRuns.event(runRef, 'model_perf_profile', {
      durationMs,
      navigationMs: perfProfile.navigationMs,
      contextBuildMs: perfProfile.contextBuildMs,
      initialHeadersMs: perfProfile.initialHeadersMs,
      initialFirstChunkMs: perfProfile.initialFirstChunkMs,
      initialRequestProfile: perfProfile.initialRequestProfile,
      continueProfiles: perfProfile.continueProfiles
    })
    finishAiObservation({
      status: 'ok',
      projectId,
      meta: {
        toolCallCount: toolCallsRecord.length,
        artifactCount: artifactPayload.artifacts.length,
        historyLength: instance.messagesHistory.length,
        changeSessionId: finalizedChangeSession?.id || null
      }
    })
    if (finalizedChangeSession?.fileCount) {
      try {
        if (!signal.aborted) {
          const afterSafetySnapshot = await createAiSafetySnapshot(effectiveProjectPath, {
            phase: 'after',
            projectId,
            userMessage: message,
            changeSession: finalizedChangeSession
          })
          changeSessions.setRecoveryPoint(projectId, finalizedChangeSession.id, 'after', afterSafetySnapshot)
          finalizedChangeSession.recoveryPoints = {
            ...(finalizedChangeSession.recoveryPoints || {}),
            after: afterSafetySnapshot
          }
        }
      } catch (recoveryPointError) {
        console.warn('[RecoveryPoints] 创建 AI 任务恢复点失败:', recoveryPointError.message)
      }
    }
    // 先完成 Turn/Run 持久化，再通知 renderer “最终回复完成”。
    //
    // 之前 message-reply(done) 在这里先发出，而 turnItemStore/taskRuns
    // 要到后面的收尾阶段才 finish。renderer 收到 done 后立即调用
    // getTaskTurn 时，读到的可能仍是 running/半成品 journal；如果用户
    // 紧接着开启下一轮，上一轮的工具链就无法被历史投影补回。Codex
    // 风格的顺序应当是：事实落盘 -> 完成事件 -> UI 通知。
     lingxiHarness.finishTurn(turnRuntime, 'completed', {
       historyLength: instance.messagesHistory.length,
       toolCallCount: toolCallsRecord.length,
       changeSessionId: finalizedChangeSession?.id || null,
       artifactCount: artifactPayload.artifacts.length
     })
    webContents?.send('message-reply', {
      projectId,
      runId: runRef.runId,
      turnId: runRef.runId,
      chatSessionId: instance?.chatSessionId || instance?.collaborationSessionId || '',
      content: artifactPayload.content,
      artifacts: artifactPayload.artifacts,
      reasoningContent: fullReasoningContent,
      modelName,
      modelId,
      toolCallCount: toolCallsRecord.length,
      done: true,
      changeSession: finalizedChangeSession,
      operationMemo,
      startedAt: requestStartedAt,
      completedAt: requestCompletedAt,
      durationMs
    })
    backgroundReplySound.notifyFinalReplyDone({ projectId, completedAt: requestCompletedAt })
    event.reply('send-message-response', { requestId, projectId, success: true, changeSession: finalizedChangeSession })

    runBackgroundTask('TaskLedger', async () => {
      if (signal.aborted) return
      const ledgerEvidence = {
        hasToolCalls: toolCallsRecord.length > 0,
        hasFileChanges: !!(finalizedChangeSession?.fileCount),
        hasCommands: !!(finalizedChangeSession?.commandCount),
        hasMutatingCommands: !!(finalizedChangeSession?.mutatingCommandCount),
        hasHandoff: !!reviewResult?.results?.length
      }
      const ledgerType = taskLedger.classifyConversation(message, ledgerEvidence)
      if (ledgerType !== 'casual' || toolCallsRecord.length > 0) {
        const ruleFacts = ledgerType === 'discussion'
          ? taskLedger.extractDiscussionFacts(`${message}\n\n${artifactPayload.content}`)
          : {}
        let workerFacts = null
        let workerProvider = ''
        try {
          if (researchContext) throw new Error('研究模式跳过后台模型账本整理，改用确定性规则提取')
          const workerResult = await workerModel.summarizeLedger({
            type: ledgerType,
            userRequest: message,
            finalSummary: artifactPayload.content,
            evidence: ledgerEvidence,
            currentModel: modelConfig,
            projectId
          })
          if (workerResult?.success) {
            workerFacts = workerResult.facts || null
            workerProvider = workerResult.provider || ''
          } else if (workerResult?.error) {
            console.log('[WorkerModel] 账本整理降级为规则提取:', workerResult.error)
          }
        } catch (workerError) {
          console.log('[WorkerModel] 账本整理失败，已降级:', workerError.message)
        }
        const discussionFacts = workerFacts || ruleFacts
        const routeRecord = buildTaskRouteRecord({
          userMessage: message,
          finalSummary: artifactPayload.content,
          toolCallsRecord,
          changeSession: finalizedChangeSession,
          projectPath: effectiveProjectPath
        })
        const ledgerResult = taskLedger.createLedgerEntry(instance, {
          type: ledgerType,
          title: message,
          userRequest: message,
          completed: ledgerType === 'action'
            ? (discussionFacts.completed?.length ? discussionFacts.completed : [artifactPayload.content].filter(Boolean))
            : (discussionFacts.completed || []),
          findings: ledgerType === 'action'
            ? (discussionFacts.findings?.length ? discussionFacts.findings : (reviewResult?.summary ? [reviewResult.summary] : []))
            : (discussionFacts.findings || []),
          decisions: discussionFacts.decisions || [],
          rejected: discussionFacts.rejected || [],
          constraints: discussionFacts.constraints || [],
          openQuestions: discussionFacts.openQuestions || [],
          changedFiles: finalizedChangeSession?.files || [],
          commands: finalizedChangeSession?.commands || [],
          unfinished: discussionFacts.unfinished || [],
          artifacts: artifactPayload.artifacts.map(item => item.id),
          finalSummary: artifactPayload.content,
          evidence: ledgerEvidence,
          route: routeRecord,
          extraJson: workerProvider ? { workerModel: { provider: workerProvider } } : null
        })
        console.log('[TaskLedger] 已写入账本:', ledgerResult.entry.id, ledgerResult.dir)
      }
    })

    instance.autoExecSteps = []
    instance.autoExecStepIndex = 0
    instance.autoExecStepEvidenceIndex = 0

    contextManager.recordTurn(message, artifactPayload.content, modelName, toolCallsRecord)
    if (!researchContext) runBackgroundTask('MemoryOrganizer', async () => {
      if (signal.aborted) return
      const result = await memoryOrganizer.organize(instance, {
        currentModel: modelConfig,
        projectId
      })
      if (result?.success) {
        console.log('[MemoryOrganizer] 已整理长期记忆:', result.provider, 'turns:', result.addedTurnCount)
      } else if (result && !result.skipped) {
        console.log('[MemoryOrganizer] 记忆整理跳过/失败:', result.error || result.reason)
      }
    })
    clearContextStatusCache(projectId)
    try { require('./desktop-pet').notifyTurnComplete({ success: true }) } catch (_) { /* ignore */ }

  } catch (err) {
    const requestWasCurrent = requestIsCurrent()
    deleteAbortControllerIfCurrent()
    const timedOut = isApiTimeoutError(err, signal)
    const aborted = !timedOut && isAbortError(err, signal)
    // 注入默认不再 abort。只有旧路径或显式 interject abort 才走续轮重启。
    // 用户点停止时即使队列里有注入消息，也按真正中断收束，留给下一轮再吸收。
    const abortedByInterject = aborted && interjectRunner.isInterjectAbortReason(signal?.reason)
    const hasPendingInterject = abortedByInterject && interjectRunner.peekPendingInterjectMessages(projectId).length > 0
    // 诊断日志：记录中断的详细信息，帮助定位自动中断的根因
    console.error('[AIChat] ⚠️ 主循环 catch 诊断:',
      '\n  err.name:', err?.name,
      '\n  err.message:', err?.message,
      '\n  err.code:', err?.code,
      '\n  llmCode:', err?.llmCode || classifyLlmFailure({ error: err, signal }).code,
      '\n  signal.aborted:', signal?.aborted,
      '\n  signal.reason:', signal?.reason?.name, ':', signal?.reason?.message,
      '\n  timedOut:', timedOut,
      '\n  aborted:', aborted,
      '\n  loopCount:', typeof loopCount !== 'undefined' ? loopCount : 'N/A',
      '\n  duration:', Date.now() - requestStartedAt, 'ms',
      '\n  stack:', err?.stack?.split('\n').slice(0, 5).join('\n    ')
    )
    finalizedChangeSession = finalizedChangeSession || finishChangeSession(aborted ? 'interrupted' : 'error')
    if (finalizedChangeSession?.fileCount) {
      try {
        const failedTaskRecoveryPoint = await createAiSafetySnapshot(instance.projectPath || projectPath || instance.storagePath, {
          phase: 'after',
          projectId,
          userMessage: message,
          changeSession: finalizedChangeSession,
          metadata: { partialWrite: true, interrupted: aborted }
        })
        changeSessions.setRecoveryPoint(projectId, finalizedChangeSession.id, 'after', failedTaskRecoveryPoint)
      } catch (recoveryPointError) {
        console.warn('[RecoveryPoints] 创建失败任务恢复点失败:', recoveryPointError.message)
      }
    }
    cacheUsageTracker.fail(err?.message || String(err || ''))

    // 安全兜底：检查 messagesHistory 中是否有悬挂的 tool_calls（没有对应 tool 结果），
    // 补写合成失败结果，防止下次发消息时 Anthropic API 报 400 错误 2013。
    try {
      if (repairToolCallAdjacency(instance.messagesHistory, {
        error: '操作已中断，工具未执行完成',
        aborted: true
      })) {
        if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
        else projects.saveProjectChatHistory(instance)
      }
    } catch (patchErr) {
      console.error('[AIChat] 兜底补充 tool 结果时出错:', patchErr.message)
    }

    if (aborted) {
      const requestCompletedAt = Date.now()
      if (hasPendingInterject) {
        // 消息注入导致的中断：不推 [已中断] 到历史（避免污染上下文），
        // 不发 interrupted status（保持前端运行态），只记录轻量中断标记。
        // pendingInterjectRestart 置 true，finally 清理后异步重启 handleSendMessage。
        pendingInterjectRestart = true
        console.log('[AIChat] interject 中断，将在 finally 后异步重启以消费注入消息')
        if (requestWasCurrent) {
          instance.messagesHistory.push({
            role: 'assistant',
            content: '[注入中断，续轮中]',
            ...turnMessageMetadata,
            ...assistantModelMetadata,
            interrupted: true,
            interjectPause: true,
            startedAt: requestStartedAt,
            completedAt: requestCompletedAt,
            durationMs: Math.max(0, requestCompletedAt - requestStartedAt),
            time: new Date().toISOString()
          })
          instance._chatHistoryDirty = true
          if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
          else projects.saveProjectChatHistory(instance)
        }
        lingxiHarness.addAgentMessage(turnRuntime, '[注入中断，续轮中]', {
          id: `agent-${runRef.runId}-interject`,
          status: 'failed',
          startedAt: requestStartedAt,
          completedAt: requestCompletedAt,
          durationMs: Math.max(0, requestCompletedAt - requestStartedAt)
        })
        lingxiHarness.finishTurn(turnRuntime, 'interrupted', {
          error: 'interject',
          changeSessionId: finalizedChangeSession?.id || null
        })
        clearContextStatusCache(projectId)
        finishAiObservation({
          status: 'aborted',
          error: 'interject',
          projectId,
          meta: {
            toolCallCount: toolCallsRecord.length,
            changeSessionId: finalizedChangeSession?.id || null
          }
        })
        // 不发 interrupted status，保持前端"运行中"态；不 reply interrupted，前端不显示中断
        event.reply('send-message-response', { requestId, projectId, success: true, interrupted: false, interjectRestart: true, changeSession: finalizedChangeSession })
      } else {
        const recallUnstarted = unstartedTurnRecall.isRecallUnstartedReason(err, signal)
        if (requestWasCurrent && recallUnstarted && persistedUserIndex >= 0) {
          const popped = unstartedTurnRecall.popUnstartedUserMessage(instance.messagesHistory, persistedUserIndex)
          if (popped.popped) {
            instance.messagesHistory = popped.history
            instance._chatHistoryDirty = true
            if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
            else projects.saveProjectChatHistory(instance)
          }
        } else if (requestWasCurrent) {
          instance.messagesHistory.push({
            role: 'assistant',
            content: '[已中断]',
            ...turnMessageMetadata,
            ...assistantModelMetadata,
            interrupted: true,
            chatSessionId: instance?.chatSessionId || '',
            startedAt: requestStartedAt,
            completedAt: requestCompletedAt,
            durationMs: Math.max(0, requestCompletedAt - requestStartedAt),
            time: new Date(requestCompletedAt).toISOString()
          })
          instance._chatHistoryDirty = true
          if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
          else projects.saveProjectChatHistory(instance)
        }
        lingxiHarness.addAgentMessage(turnRuntime, '[已中断]', {
          id: `agent-${runRef.runId}-interrupted`,
          status: 'failed',
          startedAt: requestStartedAt,
          completedAt: requestCompletedAt,
          durationMs: Math.max(0, requestCompletedAt - requestStartedAt)
        })
        lingxiHarness.finishTurn(turnRuntime, 'interrupted', {
          error: err.message,
          changeSessionId: finalizedChangeSession?.id || null
        })
        clearContextStatusCache(projectId)
        finishAiObservation({
          status: 'aborted',
          error: err.message,
          projectId,
          meta: {
            toolCallCount: toolCallsRecord.length,
            changeSessionId: finalizedChangeSession?.id || null
          }
        })
        if (requestWasCurrent && !recallUnstarted) {
          webContents?.send('ai-status', { projectId, status: 'interrupted' })
        } else if (requestWasCurrent) {
          // 保留旧中断状态契约：if (requestWasCurrent) webContents?.send('ai-status', { projectId, status: 'interrupted' })
          webContents?.send('ai-status', { projectId, status: 'interrupted', recalled: recallUnstarted })
        }
        try { require('./desktop-pet').notifyAiStatus('idle') } catch (_) { /* ignore */ }
        event.reply('send-message-response', { requestId, projectId, success: true, interrupted: true, recalled: recallUnstarted, changeSession: finalizedChangeSession })
      }
    } else {
      const requestCompletedAt = Date.now()
      instance.messagesHistory.push({
        role: 'assistant',
        content: err.message,
        ...turnMessageMetadata,
        ...assistantModelMetadata,
        error: true,
        startedAt: requestStartedAt,
        completedAt: requestCompletedAt,
        durationMs: Math.max(0, requestCompletedAt - requestStartedAt)
      })
      instance._chatHistoryDirty = true
      if (projects.saveProjectChatHistoryDeferred) projects.saveProjectChatHistoryDeferred(instance)
      else projects.saveProjectChatHistory(instance)
      lingxiHarness.addAgentMessage(turnRuntime, err.message, {
        id: `agent-${runRef.runId}-failed`,
        status: 'failed',
        startedAt: requestStartedAt,
        completedAt: requestCompletedAt,
        durationMs: Math.max(0, requestCompletedAt - requestStartedAt)
      })
      lingxiHarness.finishTurn(turnRuntime, 'failed', {
        error: err.message,
        changeSessionId: finalizedChangeSession?.id || null
      })
      clearContextStatusCache(projectId)
      finishAiObservation({
        status: timedOut ? 'timeout' : 'error',
        error: err.message,
        projectId,
        meta: {
          toolCallCount: toolCallsRecord.length,
          changeSessionId: finalizedChangeSession?.id || null
        }
      })
      if (requestWasCurrent) webContents?.send('ai-status', { projectId, status: 'error' })
      try { require('./desktop-pet').notifyTurnComplete({ success: false }) } catch (_) { /* ignore */ }
      if (requestWasCurrent) webContents?.send('message-reply', { projectId, runId: runRef.runId, turnId: runRef.runId, error: err.message, done: true, changeSession: finalizedChangeSession, startedAt: requestStartedAt, completedAt: requestCompletedAt, durationMs: Math.max(0, requestCompletedAt - requestStartedAt) })
      event.reply('send-message-response', { requestId, projectId, error: err.message, changeSession: finalizedChangeSession })
    }
  } finally {
    stopApiWatchdog()
    stopAllVisibleProgressHeartbeats()
    interjectRunner.setRunState(projectId, 'idle')
    // 成功/失败收束已在 try/catch 里由 notifyTurnComplete 处理；注入重启中勿抢状态
    if (!finalizedChangeSession) {
      finalizedChangeSession = finishChangeSession('completed')
    }
    if (!pendingInterjectRestart) {
      stopLocalOllamaModelAfterReply(modelConfig, effectiveModelId)
    }
    deleteAbortControllerIfCurrent()
  }

  // 消息注入异步重启：finally 已完成清理（runState=idle、AbortController 已删除），
  // 现在用 setImmediate 异步触发一次新的 handleSendMessage，让 consumeInterjectBeforeContinue 消费注入消息。
  // 复用原 event 对象发送 IPC reply；新 requestId 避免和已 reply 的旧 requestId 冲突。
  // message 改为续轮指令（避免重复推入原始 user message），hidden=true 避免前端显示续轮指令气泡。
  if (pendingInterjectRestart) {
    const restartRequest = async () => {
      try {
        const newRequestId = `${requestId}-interject-${Date.now()}`
        const restartMessage = '[续轮] 上一轮因消息注入中断，请继续执行原任务并吸收注入的用户指令。'
        console.log('[AIChat] interject 异步重启 handleSendMessage, newRequestId:', newRequestId)
        // 保持前端"运行中"态，consumeInterjectBeforeContinue 会在 try 块开头消费注入消息
        webContents?.send('ai-status', { projectId, status: 'thinking' })
        await runTrackedSendMessage(event, newRequestId, projectId, restartMessage, modelConfig, history, skillContent, executionMode, agentMode, instance, webContents, contextManager, projectPath, effectiveModelId, [], '[续轮] 消息注入中断后继续', true, visionRelayConfig, [], [], projectMode)
      } catch (restartErr) {
        console.error('[AIChat] interject 异步重启失败:', restartErr?.message || restartErr)
        webContents?.send('ai-status', { projectId, status: 'error' })
        webContents?.send('message-reply', { projectId, error: restartErr?.message || '注入重启失败', done: true })
      }
    }
    setImmediate(restartRequest)
  }
}

function applyBehaviorStyleConfig(next = {}) {
  const saved = storageConfig.saveBehaviorStyleConfig(next)
  const data = (saved && saved.data) ? saved.data : storageConfig.getBehaviorStyleConfig()
  systemPromptBuilder.setBehaviorStyle(data)
  return data
}

function readBehaviorStyleConfig() {
  const data = storageConfig.getBehaviorStyleConfig()
  systemPromptBuilder.setBehaviorStyle(data)
  return data
}

module.exports = {
  getExecutionModeDesc,
  getExecutionModeRules,
  formatPromptCacheTimeBucket,
  getSystemPrompt,
  setUserLanguage,
  getUserLanguage,
  applyBehaviorStyleConfig,
  readBehaviorStyleConfig,
  registerChatIPC,
  handleSendMessage,
  enqueueInterjectMessage: interjectRunner.enqueueInterject,
  takePendingInterjectMessages: interjectRunner.takePendingInterjectMessages,
  peekPendingInterjectMessages: interjectRunner.peekPendingInterjectMessages,
  clearPendingInterjectMessages: interjectRunner.clearPendingInterjectMessages,
  __test: {
    isUserRequestRestatement,
    isNonProgressNarration,
    normalizeProgressStatus,
    normalizeProgressNarration,
    summarizeProgressText,
    summarizeToolResultForModel,
    normalizeGeminiDirectToolResultForModel,
    shouldRerouteManualLocationFirst,
    buildNavigationFirstRerouteInstruction,
    shouldReroutePrematureModification,
    shouldSplitLargeToolBatch,
    shouldSplitToolSectionBatch,
    shouldRerouteToolStatusMismatch,
    isBusinessToolName,
    hasPostWriteVerification,
    buildPostWriteVerifyNudge,
    evaluateRuntimeGateForChat,
    getRuntimeGateFeatureFlags,
    repairToolCallAdjacency,
    isMutatingToolName,
    buildSyntheticToolResultContent,
    buildTaskRouteRecord,
    getDeepSeekCacheSettleTargetMs,
    shouldBridgeDeepSeekMultiToolBatch,
    buildDeepSeekMultiToolCacheBridge
  }
}
