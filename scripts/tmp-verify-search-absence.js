const searchAbsence = require('../electron/modules/chat/search-absence')

async function main() {
const projectPath = 'E:\\demo\\proj'

// 1. deriveWidenedSearchLiterals
const literals = searchAbsence.deriveWidenedSearchLiterals("require('./chat/step-assembly')", [])
if (!literals.includes('step-assembly')) {
  throw new Error('require 路径应提取模块名: ' + JSON.stringify(literals))
}
const globLiterals = searchAbsence.deriveWidenedSearchLiterals('chat/step-assembly.js', [])
if (!globLiterals.includes('step-assembly')) {
  throw new Error('glob 路径应提取模块名: ' + JSON.stringify(globLiterals))
}

// 2. isNestedSearchPath
if (!searchAbsence.isNestedSearchPath('electron/modules/chat', projectPath)) {
  throw new Error('嵌套子目录应判为 nested')
}
if (searchAbsence.isNestedSearchPath('electron/modules', projectPath)) {
  throw new Error('electron/modules 不应判为 nested')
}
if (searchAbsence.isNestedSearchPath('electron', projectPath)) {
  throw new Error('electron 不应判为 nested')
}
if (searchAbsence.isNestedSearchPath('.', projectPath)) {
  throw new Error('项目根不应判为 nested')
}

// 3. parentSearchPath
const parent = searchAbsence.parentSearchPath('electron/modules/chat', projectPath)
const normalizedParent = parent.replace(/\\/g, '/')
if (!normalizedParent.endsWith('electron/modules')) {
  throw new Error('父目录应指向 electron/modules: ' + parent)
}

// 4. looksLikeWiringReviewIntent
if (!searchAbsence.looksLikeWiringReviewIntent('这个模块接进主循环了没')) throw new Error('应识别接进主循环')
if (!searchAbsence.looksLikeWiringReviewIntent('有没有接入')) throw new Error('应识别有没有接入')
if (!searchAbsence.looksLikeWiringReviewIntent('0 命中')) throw new Error('应识别 0 命中')
if (!searchAbsence.looksLikeWiringReviewIntent('not wired')) throw new Error('应识别 not wired')
if (searchAbsence.looksLikeWiringReviewIntent('帮我改一下颜色')) throw new Error('改颜色不应误判')

// 5. attachGrepZeroHitEnrichment mock
const grepResult = { success: true, pattern: "require('./chat/step-assembly')", path: 'electron/modules/chat', matches: [], totalMatches: 0 }
const enriched = await searchAbsence.attachGrepZeroHitEnrichment(grepResult, {
  projectPath,
  searchPath: 'electron/modules/chat',
  searchContent: async () => ({
    matches: [
      { path: 'electron/modules/ai-chat.js', line: 7, content: "const stepAssembly = require('./chat/step-assembly')" }
    ],
    timedOut: false
  })
})
if (!enriched.follow_up_matches || enriched.follow_up_total !== 1) {
  throw new Error('应挂上上级补搜命中: ' + JSON.stringify(enriched))
}
if (!enriched.scope_warning || !enriched.hint) {
  throw new Error('应挂上 scope_warning 和 hint')
}
if (enriched.matches.length !== 0) {
  throw new Error('不应把补搜命中混进原始 matches')
}

// 6. attachGlobZeroHitEnrichment mock
const globResult = { success: true, pattern: 'chat/step-assembly.js', path: 'electron/modules/chat', files: [], count: 0 }
const enrichedGlob = await searchAbsence.attachGlobZeroHitEnrichment(globResult, {
  projectPath,
  searchPath: 'electron/modules/chat',
  pattern: 'chat/step-assembly.js',
  searchFiles: async () => ({
    files: [{ path: 'electron/modules/chat/step-assembly.js' }],
    timedOut: false
  })
})
if (!enrichedGlob.follow_up_files || enrichedGlob.follow_up_total !== 1) {
  throw new Error('glob 应挂上上级补搜命中')
}

// 7. 跳过星号 glob
const starGlob = { success: true, pattern: '*', path: 'electron/modules/chat', files: [], count: 0 }
const starResult = await searchAbsence.attachGlobZeroHitEnrichment(starGlob, { projectPath, searchPath: 'electron/modules/chat', pattern: '*' })
if (starResult.follow_up_files) {
  throw new Error('星号 glob 不应触发补搜')
}

// 8. needsWiringCallerEvidence
const evidenceCalls = [{
  name: 'grep_code',
  args: { pattern: "require('./chat/step-assembly')", path: 'electron/modules/chat' },
  result: { success: true, path: 'electron/modules/chat', matches: [], follow_up_matches: [{ path: 'electron/modules/ai-chat.js' }], follow_up_total: 1 }
}]
if (!searchAbsence.needsWiringCallerEvidence('这个模块接进主循环了没', evidenceCalls, projectPath)) {
  throw new Error('嵌套 0 命中且有上级补搜时应需要装配证据提醒')
}
if (searchAbsence.needsWiringCallerEvidence('帮我改一下颜色', evidenceCalls, projectPath)) {
  throw new Error('非接线审查不应触发')
}

// 9. buildWiringNudge / buildWiringFinalNudge
const nudge = searchAbsence.buildWiringNudge('这个模块接进主循环了没', evidenceCalls, projectPath)
if (!nudge.includes('0 命中') || !nudge.includes('上级补搜')) {
  throw new Error('提醒应包含 0 命中和上级补搜: ' + nudge)
}
const finalNudge = searchAbsence.buildWiringFinalNudge('这个模块接进主循环了没', evidenceCalls, projectPath)
if (!finalNudge.includes('0 命中') || !finalNudge.includes('上级补搜')) {
  throw new Error('收尾提醒应包含 0 命中和上级补搜: ' + finalNudge)
}

// 10. 已有装配文件读取时不应再提醒
const readAssemblyCalls = [
  ...evidenceCalls,
  { name: 'file_read', args: { path: 'electron/modules/ai-chat.js' }, result: { success: true, path: 'electron/modules/ai-chat.js' } }
]
if (searchAbsence.needsWiringCallerEvidence('这个模块接进主循环了没', readAssemblyCalls, projectPath)) {
  throw new Error('已读装配文件时不应再提醒')
}

console.log('search-absence: literals/nested/enrich/nudge OK')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
