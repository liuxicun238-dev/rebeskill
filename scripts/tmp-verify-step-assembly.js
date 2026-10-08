const stepAssembly = require('../electron/modules/chat/step-assembly')
const planProgress = require('../electron/modules/plan-progress')
const { createRepeatToolReminderTracker, GENTLE_REMINDER } = require('../electron/modules/chat/repeat-tool-reminder')

planProgress.resetAllForTests()

const history = [
  { role: 'system', content: 'You are Lingxi.' },
  { role: 'user', content: '看看这个项目' }
]
const assembled = stepAssembly.assembleInitialStepView({
  requestHistory: history,
  runtimeParts: {
    runtimeContext: 'cwd=/tmp/demo',
    planProgress: '',
    inspectContext: '查看项目时不要只看 README。',
    ledgerIndex: '',
    runtimeSystemMessages: ['上一轮失败只作背景。'],
    memoryContext: '',
    designStyleContext: '',
    careHint: ''
  },
  extraSystemMessages: ['【压缩摘要】旧轮已折叠'],
  prioritySystemMessages: ['风格：简洁']
})

if (assembled.extraSystemMessages.join('') !== '【压缩摘要】旧轮已折叠') {
  throw new Error('压缩摘要应留在 extra system，不能混进运行时尾巴')
}
if (!String(history[1].content).includes('【本轮动态执行上下文】') || !String(history[1].content).includes('cwd=/tmp/demo')) {
  throw new Error('运行时应挂在最新用户消息尾: ' + history[1].content)
}
if (history[0].content !== 'You are Lingxi.') {
  throw new Error('系统前缀不得被运行时改写')
}
if (history[1]._lingxiSource?.plugin !== 'runtime-tail') {
  throw new Error('运行时尾巴应带来源')
}

const webHistory = [{ role: 'user', content: 'hi' }]
stepAssembly.assembleInitialStepView({
  requestHistory: webHistory,
  webBridge: true,
  projectPath: 'E:\\demo',
  runtimeParts: { runtimeContext: 'secret runtime', inspectContext: '大量规则' }
})
if (String(webHistory[0].content).includes('secret runtime') || String(webHistory[0].content).includes('大量规则')) {
  throw new Error('网页桥不得注入运行时大段')
}
if (!String(webHistory[0].content).includes('当前项目路径：E:/demo')) {
  throw new Error('网页桥只应带项目路径: ' + webHistory[0].content)
}

const messages = [
  { role: 'assistant', tool_calls: [{ id: '1' }] },
  { role: 'tool', tool_call_id: '1', content: '{}' }
]
const applied = stepAssembly.applyStepInstructions(messages, [{
  plugin: 'plan-progress',
  content: '对照当前计划步骤。'
}], { apiFormat: 'openai' })
if (applied.length !== 1 || messages[2]?.role !== 'system' || messages[2]._lingxiSource?.plugin !== 'plan-progress') {
  throw new Error('指令必须走带来源的单一注入口')
}
if (!String(messages[2].content).includes('【内部工作流指令】')) {
  throw new Error('注入应使用内部指令框')
}

if (stepAssembly.collectPostToolInstructions({ webBridge: true, toolResults: [{ toolName: 'file_read', result: { success: true } }] }).length) {
  throw new Error('网页桥工具后不应收集 API 催续')
}

planProgress.rememberConfirmedPlan('step-assembly-test', ['定位入口', '给出结论'])
const postTool = stepAssembly.collectPostToolInstructions({
  projectId: 'step-assembly-test',
  userMessage: '继续',
  toolCallsThisBatch: [{ function: { name: 'file_search' } }],
  toolResults: [{ toolName: 'file_search', toolArgs: { query: 'a' }, result: { success: true } }],
  toolCallsRecord: [{ name: 'file_search', args: { query: 'a' }, result: { success: true } }],
  explorationNudgeKeys: new Set(),
  inspectDocsNudgeUsed: true,
  repeatTracker: createRepeatToolReminderTracker()
})
if (!postTool.some(item => item.plugin === 'plan-progress' && item.content.includes('对照当前计划步骤'))) {
  throw new Error('工具后应由组装口收集计划催续: ' + JSON.stringify(postTool))
}

const tracker = createRepeatToolReminderTracker()
tracker.record('file_read', { path: 'a.js' })
tracker.record('file_read', { path: 'a.js' })
const repeatBatch = stepAssembly.collectPostToolInstructions({
  projectId: 'step-assembly-test',
  userMessage: '继续',
  toolCallsThisBatch: [{ function: { name: 'file_read' } }],
  toolResults: [{ toolName: 'file_read', toolArgs: { path: 'a.js' }, result: { success: true } }],
  toolCallsRecord: [],
  explorationNudgeKeys: new Set(),
  inspectDocsNudgeUsed: true,
  repeatTracker: tracker
})
if (!repeatBatch.some(item => item.plugin === 'repeat-tool-reminder' && item.content === GENTLE_REMINDER)) {
  throw new Error('第三次同参调用应由组装口注入空转提醒')
}

const inspectFinal = stepAssembly.collectPreFinalInstructions({
  projectId: 'step-assembly-test',
  userMessage: '深入查看这个项目',
  toolCallsRecord: [{ name: 'file_read', args: { path: 'README.md' }, result: { success: true, path: 'README.md' } }],
  inspectDocsNudgeUsed: false,
  planFinalNudgeUsed: false
})
if (!inspectFinal.length || inspectFinal[0].plugin !== 'inspect-evidence' || !inspectFinal[0].keepLoop) {
  throw new Error('收尾前应由组装口先处理查看证据催续')
}

const wiringPost = stepAssembly.collectPostToolInstructions({
  projectId: 'step-assembly-test',
  userMessage: '这个模块接进主循环了没，怎么在模块目录里搜 require 是 0 命中',
  toolCallsThisBatch: [],
  toolResults: [],
  toolCallsRecord: [
    {
      name: 'grep_code',
      args: { pattern: "require('./chat/step-assembly')", path: 'electron/modules/chat' },
      result: { success: true, path: 'electron/modules/chat', matches: [], follow_up_matches: [{ path: 'electron/modules/ai-chat.js', line: 7, content: "const stepAssembly = require('./chat/step-assembly')" }], follow_up_total: 1 }
    }
  ],
  explorationNudgeKeys: new Set(),
  inspectDocsNudgeUsed: true,
  wiringNudgeUsed: false,
  projectPath: 'E:\\demo',
  repeatTracker: createRepeatToolReminderTracker()
})
if (!wiringPost.some(item => item.plugin === 'search-absence' && item.markWiringUsed)) {
  throw new Error('模块目录 0 命中审查接线时应注入装配提醒: ' + JSON.stringify(wiringPost))
}

const wiringFinal = stepAssembly.collectPreFinalInstructions({
  projectId: 'step-assembly-test',
  projectPath: 'E:\\demo',
  userMessage: '这个模块接进主循环了没，怎么在模块目录里搜 require 是 0 命中',
  toolCallsRecord: [
    {
      name: 'grep_code',
      args: { pattern: "require('./chat/step-assembly')", path: 'electron/modules/chat' },
      result: { success: true, path: 'electron/modules/chat', matches: [], follow_up_matches: [{ path: 'electron/modules/ai-chat.js', line: 7, content: "const stepAssembly = require('./chat/step-assembly')" }], follow_up_total: 1 }
    }
  ],
  inspectDocsNudgeUsed: true,
  wiringNudgeUsed: false,
  planFinalNudgeUsed: true
})
if (!wiringFinal.length || wiringFinal[0].plugin !== 'search-absence' || !wiringFinal[0].keepLoop || !wiringFinal[0].markWiringUsed) {
  throw new Error('收尾前应先拦截接线误判: ' + JSON.stringify(wiringFinal))
}

const planOnlyFinal = stepAssembly.collectPreFinalInstructions({
  projectId: 'step-assembly-test',
  userMessage: '实现登录',
  toolCallsRecord: [{ name: 'file_read', args: { path: 'app.js' }, result: { success: true } }],
  inspectDocsNudgeUsed: true,
  wiringNudgeUsed: true,
  planFinalNudgeUsed: false
})
if (!planOnlyFinal.some(item => item.plugin === 'plan-progress' && item.markPlanFinalUsed)) {
  throw new Error('无查看催续时应收尾计划催续')
}

planProgress.resetAllForTests()
console.log('step-assembly: tail/source/post-tool/pre-final OK')
