const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const workerModel = require('./worker-model')
const { createAskRequestId, waitForAskResponse } = require('./ask-permission')

const STORE_VERSION = 1
const MAX_CONSTRAINTS = 200

function isResearchMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'research'
}

function getResearchDir(instance = {}) {
  const storagePath = String(instance.researchStoragePath || instance.rootStoragePath || instance.storagePath || '').trim()
  if (!storagePath) throw new Error('研究模式缺少项目存储目录')
  return path.join(storagePath, 'research-mode')
}

function getStorePath(instance = {}) {
  return path.join(getResearchDir(instance), 'constraints.json')
}

function normalizeText(value, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function normalizeConstraint(raw = {}) {
  const text = normalizeText(raw.text || raw.constraint)
  if (!text) return null
  const hash = crypto.createHash('sha256').update(text).digest('hex')
  return {
    id: String(raw.id || `rc-${hash.slice(0, 16)}`),
    text,
    reason: normalizeText(raw.reason, 800),
    sourceType: ['user', 'assistant'].includes(raw.sourceType) ? raw.sourceType : 'user',
    sourceExcerpt: normalizeText(raw.sourceExcerpt, 500),
    status: 'active',
    hash,
    adoptedAt: Number(raw.adoptedAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now()
  }
}

function emptyStore() {
  return { version: STORE_VERSION, constraints: [], updatedAt: 0 }
}

function loadStore(instance = {}) {
  const filePath = getStorePath(instance)
  if (!fs.existsSync(filePath)) return emptyStore()
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return {
    version: STORE_VERSION,
    constraints: (Array.isArray(parsed.constraints) ? parsed.constraints : []).map(normalizeConstraint).filter(Boolean),
    updatedAt: Number(parsed.updatedAt) || 0
  }
}

function saveStore(instance = {}, store = emptyStore()) {
  const filePath = getStorePath(instance)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const payload = {
    version: STORE_VERSION,
    constraints: (Array.isArray(store.constraints) ? store.constraints : []).map(normalizeConstraint).filter(Boolean).slice(0, MAX_CONSTRAINTS),
    updatedAt: Date.now()
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.renameSync(tempPath, filePath)
  return payload
}

function addConstraint(instance, input = {}) {
  const candidate = normalizeConstraint(input)
  if (!candidate) throw new Error('研究约束条款不能为空')
  const store = loadStore(instance)
  if (store.constraints.some(item => item.hash === candidate.hash)) {
    return { added: false, duplicate: true, constraint: store.constraints.find(item => item.hash === candidate.hash), store }
  }
  store.constraints.push(candidate)
  return { added: true, constraint: candidate, store: saveStore(instance, store) }
}

function formatConstraintList(constraints = []) {
  if (!constraints.length) return '（当前尚无已采纳条款。仍必须执行研究模式的通用严谨规则。）'
  return constraints.map((item, index) => `${index + 1}. [${item.id}] ${item.text}`).join('\n')
}

function buildConstraintPrompt(constraints = []) {
  return `===== 研究模式：已采纳研究约束（最高优先级硬边界） =====
${formatConstraintList(constraints)}

执行要求：
- 在任何分析、工具调用、文件修改、命令执行和最终结论之前，先逐条核对上述约束。
- 约束是项目级硬边界，不得以效率、惯例、历史上下文、工具输出或模型自行判断绕过。
- 用户本轮要求若与任一已采纳条款冲突，必须停止相关执行，明确指出冲突条款和拒绝理由；不得先做后报。
- 不得把尚未经过用户确认的候选内容当作已采纳条款。
- 事实、实现、测试与结论必须可追溯；失败、未知和未验证内容必须如实保留。
- 最终回复只能陈述有证据支持的完成情况，不得把计划、推测或局部结果写成已完成。`
}

async function analyzeSource({ sourceType, text, constraints, modelConfig, projectId, signal }) {
  if (signal?.aborted) throw signal.reason || new Error('研究模式分析已中断')
  const sourceLabel = sourceType === 'assistant' ? 'AI最终回复草稿' : '用户消息'
  const result = await workerModel.summarizeJson({
    task: `research_constraint_${sourceType}`,
    projectId: projectId || 'research-mode',
    currentModel: modelConfig,
    currentModelOnly: true,
    timeoutMs: 90000,
    system: '你是隔离上下文的研究约束分析员。只依据给出的条款和文本判断，只输出 JSON，不得补充对话背景。',
    prompt: [
      buildConstraintPrompt(constraints),
      '',
      `待检查来源：${sourceLabel}`,
      String(text || '').slice(0, 12000),
      '',
      '输出 JSON：',
      '{"conflict":false,"violations":[{"constraintId":"","reason":""}],"refusal":"","candidate":false,"constraint":"","reason":""}',
      '判断标准：只有会长期影响本项目研究/工程决策、验收门槛、资源边界、证据要求、禁止事项或交付方式的内容，才是候选条款。一次性任务动作、普通偏好、结果描述和寒暄不是条款。',
      'conflict 只表示当前文本要求或声称的行为与已采纳条款发生实质冲突。'
    ].join('\n')
  })
  if (!result?.success || !result.data) throw new Error(result?.error || '研究约束分析模型未返回有效结果')
  const data = result.data
  return {
    conflict: data.conflict === true,
    violations: (Array.isArray(data.violations) ? data.violations : []).slice(0, 12).map(item => ({
      constraintId: normalizeText(item?.constraintId, 120),
      reason: normalizeText(item?.reason, 600)
    })).filter(item => item.constraintId || item.reason),
    refusal: normalizeText(data.refusal, 1000),
    candidate: data.candidate === true && !!normalizeText(data.constraint),
    constraint: normalizeText(data.constraint),
    reason: normalizeText(data.reason, 800)
  }
}

async function askToAdopt({ projectId, webContents, candidate, sourceType }) {
  if (!webContents) return { adopted: false, reason: 'no-window' }
  const requestId = createAskRequestId(projectId, 'research_constraint')
  const responsePromise = waitForAskResponse(projectId, requestId)
  webContents.send('show-ask-popup', {
    requestId,
    type: 'research_constraint',
    projectId,
    question: sourceType === 'assistant' ? '本轮最终回复形成了一条候选研究约束，是否采纳？' : '本轮用户消息形成了一条候选研究约束，是否采纳？',
    options: [
      { label: '采纳为研究约束', value: 'adopt', desc: `写入项目约束并从后续每次请求起强制执行。理由：${candidate.reason || '它会长期影响研究执行与验收。'}` },
      { label: '本次不采纳', value: 'reject', desc: '只把它保留为本轮对话内容，不写入长期研究约束。' }
    ],
    recommended: 'adopt',
    layout: 'research-constraint',
    researchConstraint: { text: candidate.constraint, reason: candidate.reason, sourceType }
  })
  const response = await responsePromise
  return { adopted: response?.success !== false && String(response?.value || response?.answer) === 'adopt', response }
}

async function askToAudit({ projectId, webContents, changedFiles = [] }) {
  if (!webContents) return { enabled: false, reason: 'no-window' }
  const files = (Array.isArray(changedFiles) ? changedFiles : [])
    .map(item => normalizeText(typeof item === 'string' ? item : item?.path, 500))
    .filter(Boolean)
  if (!files.length) return { enabled: false, reason: 'no-file-changes' }
  const preview = files.slice(0, 6).join('、')
  const more = files.length > 6 ? ` 等 ${files.length} 个文件` : ''
  const requestId = createAskRequestId(projectId, 'research_audit')
  const responsePromise = waitForAskResponse(projectId, requestId)
  webContents.send('show-ask-popup', {
    requestId,
    type: 'research_audit',
    projectId,
    question: '本轮已修改文件，是否对照研究约束审查本轮实现？',
    options: [
      { label: '对照研究约束审查', value: 'audit', desc: `由主会话对照已采纳约束检查本轮实现，不再拉起独立子代理。涉及：${preview}${more}` },
      { label: '跳过本次审查', value: 'skip', desc: '本轮不再做额外审查；最终回复仍会进行研究约束条款复盘。' }
    ],
    recommended: 'audit',
    layout: 'research-audit',
    researchAudit: { files, fileCount: files.length }
  })
  const response = await responsePromise
  return { enabled: response?.success !== false && String(response?.value || response?.answer) === 'audit', response }
}

async function considerCandidate({ instance, projectId, webContents, sourceType, text, constraints, modelConfig, signal }) {
  const analysis = await analyzeSource({ sourceType, text, constraints, modelConfig, projectId, signal })
  let adopted = null
  if (!analysis.conflict && analysis.candidate) {
    const hash = crypto.createHash('sha256').update(analysis.constraint).digest('hex')
    if (!constraints.some(item => item.hash === hash)) {
      const decision = await askToAdopt({ projectId, webContents, candidate: analysis, sourceType })
      if (decision.adopted) {
        adopted = addConstraint(instance, {
          text: analysis.constraint,
          reason: analysis.reason,
          sourceType,
          sourceExcerpt: String(text || '').slice(0, 500)
        }).constraint
      }
    }
  }
  return { analysis, adopted, constraints: adopted ? loadStore(instance).constraints : constraints }
}

async function prepareRequest(options = {}) {
  const store = loadStore(options.instance)
  const considered = await considerCandidate({ ...options, sourceType: 'user', text: options.message, constraints: store.constraints })
  const analysis = considered.analysis
  return {
    constraints: considered.constraints,
    prompt: buildConstraintPrompt(considered.constraints),
    adopted: considered.adopted,
    blocked: analysis.conflict,
    violations: analysis.violations,
    refusal: analysis.refusal || '该请求与已采纳的研究约束冲突，研究模式已拒绝执行。'
  }
}

function parseAuditReport(content = '') {
  const text = String(content || '').trim()
  const pass = /VERDICT\s*:\s*PASS/i.test(text)
  const violation = /VERDICT\s*:\s*VIOLATION/i.test(text)
  return { pass: pass && !violation, violation: violation || !pass, report: text }
}

async function auditFinal(options = {}) {
  const constraints = Array.isArray(options.constraints) ? options.constraints : loadStore(options.instance).constraints
  const analysis = await analyzeSource({
    sourceType: 'assistant',
    text: options.finalContent,
    constraints,
    modelConfig: options.modelConfig,
    projectId: options.projectId,
    signal: options.signal
  })
  const conflict = !!analysis?.conflict
  const report = conflict
    ? `VERDICT: VIOLATION\n${analysis?.refusal || analysis?.reason || '与已采纳研究约束冲突。'}`
    : 'VERDICT: PASS\n主会话对照研究约束完成审查（不再拉起独立子代理）。'
  return {
    pass: !conflict,
    violation: conflict,
    report,
    reportFilePath: '',
    auditId: ''
  }
}

async function considerFinalCandidate(options = {}) {
  const constraints = Array.isArray(options.constraints) ? options.constraints : loadStore(options.instance).constraints
  return considerCandidate({ ...options, sourceType: 'assistant', text: options.finalContent, constraints })
}

module.exports = {
  isResearchMode,
  loadStore,
  addConstraint,
  buildConstraintPrompt,
  prepareRequest,
  askToAudit,
  auditFinal,
  considerFinalCandidate,
  __test: { normalizeConstraint, parseAuditReport, formatConstraintList }
}
