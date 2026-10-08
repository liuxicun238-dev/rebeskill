const {
  looksLikeProjectInspectIntent,
  looksLikeDeepProjectInspectIntent,
  isDocLikePath,
  isImplementationPath,
  collectInspectEvidence,
  needsInspectSourceEvidence,
  buildProjectInspectContext,
  buildDocsOnlyInspectNudge,
  buildInspectFinalNudge
} = require('../electron/modules/project-inspect-evidence')
const { looksLikeWebBridgeInspectQuestion, shouldPromoteWebBridgeTextToFinal } = require('../electron/modules/web-bridge-coding-protocol')
const { buildTaskFocusPrompt, buildCompactAgentRuntimePrompt } = require('../electron/modules/agent-runtime')

if (!looksLikeProjectInspectIntent('当前项目是什么内容')) throw new Error('应识别查看项目')
if (!looksLikeProjectInspectIntent('帮我看看这个项目')) throw new Error('应识别看看项目')
if (!looksLikeProjectInspectIntent('深入查看这个项目')) throw new Error('应识别深入查看')
if (!looksLikeDeepProjectInspectIntent('深入查看这个项目')) throw new Error('深入查看应提高门槛')
if (looksLikeDeepProjectInspectIntent('当前项目是什么内容')) throw new Error('普通了解不应当成深入审查')
if (looksLikeProjectInspectIntent('帮我升级首页样式')) throw new Error('改页面不应当成只看项目')
if (!looksLikeWebBridgeInspectQuestion('深入查看这个项目')) throw new Error('网页桥也应识别深入查看')

if (!isDocLikePath('README.md') || !isDocLikePath('docs/guide.md')) throw new Error('应识别文档路径')
if (isImplementationPath('README.md') || isImplementationPath('package.json')) throw new Error('README/package.json 不能当实现')
if (!isImplementationPath('electron/modules/ai-chat.js') || !isImplementationPath('index.html')) {
  throw new Error('应识别源码路径')
}

const docsOnly = collectInspectEvidence([
  { name: 'file_read', args: { path: 'README.md' }, result: { success: true, path: 'README.md' } }
])
if (!docsOnly.docsOnly || docsOnly.hasImplementationEvidence) throw new Error('只读 README 应判定为文档敷衍')
if (!needsInspectSourceEvidence('当前项目是什么内容', [
  { name: 'file_read', args: { path: 'README.md' }, result: { success: true, path: 'README.md' } }
])) {
  throw new Error('只读 README 后应收紧，不能总结')
}

const withSource = [
  { name: 'file_read', args: { path: 'README.md' }, result: { success: true } },
  { name: 'file_read', args: { path: 'src/main.js' }, result: { success: true, path: 'src/main.js' } }
]
if (needsInspectSourceEvidence('当前项目是什么内容', withSource)) {
  throw new Error('已经读过实现文件后应允许介绍')
}
if (!needsInspectSourceEvidence('深入查看这个项目', withSource)) {
  throw new Error('深入查看只读一个源码文件还不够')
}

const dirOnly = collectInspectEvidence([
  { name: 'file_search', args: { action: 'directory' }, result: { files: [{ name: 'index.html' }, { name: 'README.md' }] } }
])
if (dirOnly.hasImplementationEvidence) throw new Error('只看目录名不能当读过实现')

const nudge = buildDocsOnlyInspectNudge('看看这个项目', [
  { name: 'file_read', args: { path: 'README.md' }, result: { success: true, path: 'README.md' } }
])
if (!nudge.includes('README') || !nudge.includes('真实代码')) throw new Error('文档催续应要求读源码: ' + nudge)

const context = buildProjectInspectContext('深入查看这个项目')
if (!context.includes('至少两个真实源码文件')) throw new Error('深入查看上下文门槛不对: ' + context)

const finalNudge = buildInspectFinalNudge('当前项目有什么内容', [
  { name: 'file_read', args: { path: 'docs/intro.md' }, result: { success: true } }
])
if (!finalNudge.includes('不能只靠 README') && !finalNudge.includes('真实实现')) {
  throw new Error('收尾催促应对文档敷衍拦截')
}

const focus = buildTaskFocusPrompt('帮我看看这个项目', { compact: true })
if (!focus.includes('不要只看 README') && !focus.includes('真实实现文件')) {
  throw new Error('任务重点应提醒不要只看文档: ' + focus)
}
const compact = buildCompactAgentRuntimePrompt()
if (!compact.includes('README/Markdown 只是线索')) {
  throw new Error('精简运行时应写明文档不能代替源码')
}

if (!looksLikeProjectInspectIntent('可以再深入查看一下吗')) throw new Error('应识别再深入查看')
if (!needsInspectSourceEvidence('可以再深入查看一下吗', [
  { name: 'file_read', args: { path: 'package.json' }, result: { success: true, path: 'package.json' } }
])) {
  throw new Error('只读 package.json 后深入查看应收紧')
}
if (shouldPromoteWebBridgeTextToFinal({
  userText: '可以再深入查看一下吗',
  text: '项目名称是 lingxi-phaser-game。这是一个基于 Phaser 3 的游戏，使用 Vite 和 TypeScript。',
  toolCalls: [{ name: 'file_read', args: { path: 'package.json' }, result: { success: true, path: 'package.json' } }]
})) {
  throw new Error('只读 package.json 不能把项目介绍当最终回答')
}
if (!shouldPromoteWebBridgeTextToFinal({
  userText: '当前项目有什么内容',
  text: '我已查看项目主要文件。index.html 是入口，style.css 负责样式，script.js 处理交互。当前状态：结构完整。'
})) {
  throw new Error('点出源码文件的介绍仍应能收尾')
}

console.log('project-inspect-evidence: docs-vs-source OK')
