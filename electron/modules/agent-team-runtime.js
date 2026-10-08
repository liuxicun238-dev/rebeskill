/**
 * 标准模式团队派工：同项目 in-process 队员，不另开聊天实例。
 * 聊天内嵌图和全屏画布都读 toProjection() 这一份。
 */

const crypto = require('crypto')
const projectModes = require('./project-mode')
const { isChatGptWebBridgeModel, isGeminiSparkAgentModel } = require('./capability-tiers')

const TEAM_TOOL_NAME = 'delegate_agents'
const MAX_TASKS = 4
const MAX_PARALLEL = 3
const TASK_NODE_ID = 'task'
const CEO_NODE_ID = 'ceo'
const NODE_W = 210
const NODE_H = 110
const LAYER_GAP = 80
const ROW_GAP = 56
const LAYOUT_PAD = 24

function randomId(prefix = 'team') {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

function slugId(name, index) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
  return base || `worker_${index + 1}`
}

function compactText(value, limit = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function clipText(value, limit = 4000) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim()
  if (!text) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function buildStandardModePrompt() {
  return `===== 标准模式组队（delegate_agents） =====
简单问答、单文件小改、只需一次查找的任务：自己直接做，不要派工。
只有明显能拆成 2 到 4 个互不抢同一文件的并行块，或必须先 A 再 B 的流水线时，才调用 delegate_agents。
规则：
- 队员在当前项目里执行，不要幻想另开窗口或临时子项目。
- 一次调用必须把全部队员写进 tasks 数组。你嘴上说几个人，tasks 就必须有几条。禁止先派 1 人、把其余人只写在 team_brief 或思考里。
- 一次最多 4 人；无 depends_on 的会并行，同时最多 3 人开工。
- team_brief 写总目标、边界和交付口径（全队共享）。每个 task 只写这一人要做的短指令，不要把四个人的活塞进一条 task。
- 能并行就不要硬串行。后一步必须读前一步结果时才填 depends_on。
- 派工返回后，你负责汇总队员 output 给用户，不要假装这些工作是你亲手做的。
- 研究模式没有这个工具。`
}

function coerceTaskList(args = {}) {
  const candidates = [args.tasks, args.agents, args.workers, args.members]
  for (const value of candidates) {
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed)) return parsed
        if (parsed && typeof parsed === 'object') return coerceTaskList({ tasks: parsed })
      } catch (_) { /* ignore */ }
      continue
    }
    if (value && typeof value === 'object') {
      if (typeof value.task === 'string' || typeof value.prompt === 'string' || typeof value.instruction === 'string') {
        return [value]
      }
      const values = Object.values(value).filter(item => item && typeof item === 'object' && !Array.isArray(item))
      if (values.length) return values
    }
  }
  return []
}

function announcedMemberCount(text = '') {
  const src = String(text || '')
  if (!src.trim()) return 0
  const cn = { 两: 2, 二: 2, 两名: 2, 三: 3, 三名: 3, 四: 4, 四名: 4, 五个: 5, 五: 5 }
  const patterns = [
    /(?:派|派遣|安排|唤醒|并行(?:摸底)?)\s*([2-4])\s*个/,
    /([2-4])\s*个(?:侦察员|队员|人|worker|agent)/i,
    /(?:派|派遣|安排|唤醒)\s*([两三四五](?:个|名)?)/
  ]
  for (const re of patterns) {
    const match = src.match(re)
    if (!match) continue
    const n = cn[match[1]] || Number(match[1])
    if (n >= 2 && n <= MAX_TASKS) return n
  }
  const named = src.match(/(?:侦察员|队员)[甲乙丙丁ABCD1234一二三四]/g)
  if (named) {
    const uniq = new Set(named)
    if (uniq.size >= 2) return Math.min(MAX_TASKS, uniq.size)
  }
  return 0
}

function parseDelegateArgs(args = {}, announceText = '') {
  const teamBrief = String(args.team_brief || args.teamBrief || '').trim()
  const rawTasks = coerceTaskList(args)
  if (!rawTasks.length) {
    return { success: false, error: 'tasks 不能为空。简单任务请自己做，不要派空队。' }
  }
  if (rawTasks.length > MAX_TASKS) {
    return { success: false, error: `一次最多派 ${MAX_TASKS} 名队员。` }
  }

  const used = new Set()
  const tasks = []
  for (let index = 0; index < rawTasks.length; index += 1) {
    const item = rawTasks[index] && typeof rawTasks[index] === 'object' ? rawTasks[index] : {}
    const task = String(item.task || item.prompt || item.instruction || '').trim()
    if (!task) {
      return { success: false, error: `第 ${index + 1} 个任务缺少 task。` }
    }
    let id = String(item.id || '').trim() || slugId(item.name || item.role, index)
    if (used.has(id)) id = `${id}_${index + 1}`
    used.add(id)
    const dependsOn = (Array.isArray(item.depends_on) ? item.depends_on : Array.isArray(item.dependsOn) ? item.dependsOn : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
    tasks.push({
      id,
      name: String(item.name || item.role || `队员${index + 1}`).trim() || `队员${index + 1}`,
      role: String(item.role || item.name || '队员').trim() || '队员',
      task,
      dependsOn
    })
  }

  const ids = new Set(tasks.map(item => item.id))
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter(dep => dep !== task.id)
    const missing = task.dependsOn.filter(dep => !ids.has(dep))
    if (missing.length) {
      return { success: false, error: `任务 ${task.id} 的 depends_on 引用了不存在的 id：${missing.join(', ')}` }
    }
  }

  const announced = announcedMemberCount(`${announceText}\n${teamBrief}\n${tasks.map(item => item.task).join('\n')}`)
  if (announced > tasks.length) {
    return {
      success: false,
      error: `你声明了 ${announced} 名队员，但 tasks 只有 ${tasks.length} 条。必须在同一次 delegate_agents 里列出全部队员，禁止只派一个人。每人一条短 task，共用规则写 team_brief。`,
      next_action: '重新调用 delegate_agents，把 tasks 数组补齐到声明人数。'
    }
  }

  const waves = buildDagWaves(tasks)
  if (!waves.success) return waves
  return { success: true, teamBrief, tasks, waves: waves.waves }
}

function buildDagWaves(tasks = []) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const remaining = new Set(tasks.map(task => task.id))
  const waves = []
  while (remaining.size) {
    const ready = [...remaining].filter(id => {
      const deps = byId.get(id)?.dependsOn || []
      return deps.every(dep => !remaining.has(dep))
    })
    if (!ready.length) {
      return { success: false, error: 'depends_on 形成了循环，无法开工。' }
    }
    waves.push(ready.map(id => byId.get(id)))
    ready.forEach(id => remaining.delete(id))
  }
  return { success: true, waves }
}

function createAgent(task) {
  return {
    id: task.id,
    nodeId: task.id,
    name: task.name,
    role: task.role,
    task: task.task,
    dependsOn: [...(task.dependsOn || [])],
    status: 'waiting',
    statusText: '等待开工',
    startedAt: 0,
    finishedAt: 0,
    thinking: [],
    tools: [],
    output: '',
    error: null
  }
}

function layoutColumns(columns) {
  const cols = Array.isArray(columns) ? columns.filter(col => Array.isArray(col) && col.length) : []
  const heights = cols.map(col => col.length * NODE_H + Math.max(0, col.length - 1) * ROW_GAP)
  const maxH = Math.max(NODE_H, ...heights, 0)
  cols.forEach((col, index) => {
    const y0 = LAYOUT_PAD + (maxH - heights[index]) / 2
    col.forEach((node, row) => {
      node.x = LAYOUT_PAD + index * (NODE_W + LAYER_GAP)
      node.y = y0 + row * (NODE_H + ROW_GAP)
    })
  })
  return {
    width: LAYOUT_PAD * 2 + cols.length * NODE_W + Math.max(0, cols.length - 1) * LAYER_GAP,
    height: LAYOUT_PAD * 2 + maxH
  }
}

function leafAgentIds(agents = []) {
  return agents
    .map(agent => agent.id)
    .filter(id => !agents.some(agent => (agent.dependsOn || []).includes(id)))
}

function captainWaitCaption(execution, captain) {
  const agents = Array.isArray(execution?.agents) ? execution.agents : []
  const terminal = agents.filter(agent => ['done', 'completed', 'error', 'failed', 'cancelled', 'interrupted'].includes(String(agent.status))).length
  if (captain === 'pending' && agents.length) return `等待团队 (${terminal}/${agents.length})`
  if (captain === 'running') return '各路已回，正在汇总'
  return ''
}

function captainStatus(execution) {
  const status = String(execution?.status || '')
  if (status === 'error' || status === 'failed') return 'failed'
  if (status === 'cancelled' || status === 'interrupted') return 'cancelled'
  if (status === 'done' || status === 'completed' || status === 'completed_with_errors') return 'completed'
  const agents = Array.isArray(execution?.agents) ? execution.agents : []
  if (agents.length && agents.every(agent => ['done', 'completed', 'error', 'failed', 'cancelled', 'interrupted'].includes(String(agent.status)))) {
    return 'running'
  }
  return 'pending'
}

function buildWorkflowFromAgents(execution) {
  const waves = Array.isArray(execution.waves) ? execution.waves : []
  const agents = Array.isArray(execution.agents) ? execution.agents : []
  const taskNode = {
    id: TASK_NODE_ID,
    type: 'input',
    variant: 'input',
    name: '你的任务',
    task: execution.task || execution.teamBrief || ''
  }
  const columns = [[taskNode]]
  const edges = []
  waves.forEach(wave => {
    const list = (Array.isArray(wave) ? wave : []).map(agent => ({
      id: agent.id,
      type: 'work',
      variant: 'agent',
      name: agent.name,
      role: agent.role,
      task: agent.task
    }))
    columns.push(list)
    list.forEach(node => {
      const deps = agents.find(item => item.id === node.id)?.dependsOn || []
      if (!deps.length) {
        edges.push({ id: `e-task-${node.id}`, source: TASK_NODE_ID, target: node.id })
      } else {
        deps.forEach(dep => edges.push({ id: `e-${dep}-${node.id}`, source: dep, target: node.id }))
      }
    })
  })
  const ceoNode = {
    id: CEO_NODE_ID,
    type: 'output',
    variant: 'captain',
    name: 'CEO 汇总',
    task: execution.notes?.consensus || execution.teamBrief || ''
  }
  columns.push([ceoNode])
  leafAgentIds(agents).forEach(id => {
    edges.push({ id: `e-${id}-ceo`, source: id, target: CEO_NODE_ID })
  })
  const size = layoutColumns(columns)
  const nodes = columns.flat()
  const byId = new Map(nodes.map(node => [node.id, node]))
  agents.forEach(agent => {
    const laid = byId.get(agent.id)
    if (!laid) return
    agent.x = laid.x
    agent.y = laid.y
  })
  return {
    id: `team:${execution.id}`,
    name: '本轮团队',
    width: size.width,
    height: size.height,
    nodes,
    edges
  }
}

function toProjection(execution) {
  const agents = (execution.agents || []).map(agent => ({
    id: agent.id,
    nodeId: agent.nodeId || agent.id,
    name: agent.name,
    role: agent.role,
    task: agent.task,
    dependsOn: [...(agent.dependsOn || [])],
    status: agent.status,
    statusText: agent.statusText || '',
    startedAt: agent.startedAt || 0,
    finishedAt: agent.finishedAt || 0,
    thinking: Array.isArray(agent.thinking) ? agent.thinking.slice(-24) : [],
    tools: Array.isArray(agent.tools) ? agent.tools.slice(-40) : [],
    output: clipText(agent.output, 12000),
    error: agent.error ? { message: compactText(agent.error.message || agent.error, 400) } : null,
    x: agent.x,
    y: agent.y
  }))
  const doneWorkers = agents.filter(agent => ['done', 'completed', 'error', 'failed', 'cancelled', 'interrupted'].includes(String(agent.status))).length
  const captain = captainStatus(execution)
  const captainDone = ['completed', 'failed', 'cancelled'].includes(captain)
  const done = doneWorkers + (captainDone ? 1 : 0)
  const total = agents.length + 1
  const notes = {
    coordination: execution.notes?.coordination || execution.teamBrief || '',
    convention: execution.notes?.convention || '',
    consensus: execution.notes?.consensus || ''
  }
  return {
    id: execution.id,
    executionKind: 'team',
    workflowExecution: true,
    projectId: execution.projectId,
    projectPath: execution.projectPath || '',
    requestId: execution.requestId,
    chatSessionId: execution.chatSessionId,
    task: execution.task,
    summary: execution.summary || execution.task,
    teamBrief: execution.teamBrief,
    notes,
    teamNotes: [
      notes.coordination && { id: 'coordination', author: '主', kind: '协调', source: 'ceo', text: notes.coordination },
      notes.convention && { id: 'convention', author: '主', kind: '约定', text: notes.convention },
      notes.consensus && { id: 'consensus', author: '主', kind: '团队共识', source: 'ceo', text: notes.consensus }
    ].filter(Boolean),
    captain: {
      id: CEO_NODE_ID,
      status: captain,
      preview: captain === 'pending' ? captainWaitCaption(execution, captain) : (notes.consensus || captainWaitCaption(execution, captain)),
      statusCaption: captainWaitCaption(execution, captain)
    },
    createdAt: execution.createdAt,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt || 0,
    status: execution.status,
    doneCount: done,
    totalCount: total,
    progress: { completed: done, total },
    agents,
    waves: Array.isArray(execution.waves)
      ? execution.waves.map(wave => (Array.isArray(wave) ? wave : []).map(item => item.id || item))
      : [],
    workflow: execution.workflow || buildWorkflowFromAgents(execution)
  }
}

function emitProjection(execution, webContents) {
  if (!webContents || webContents.isDestroyed?.()) return
  try {
    webContents.send('agent-team-update', {
      projectId: execution.projectId,
      requestId: execution.requestId,
      chatSessionId: execution.chatSessionId,
      execution: toProjection(execution)
    })
  } catch (_) { /* renderer gone */ }
}

function summarizeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    output: clipText(agent.output, 4000),
    error: agent.error?.message || ''
  }
}

async function mapPool(items, limit, mapper) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return []
  const concurrency = Math.max(1, Math.min(limit || MAX_PARALLEL, list.length))
  const results = new Array(list.length)
  let cursor = 0
  async function worker() {
    while (cursor < list.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

function rejectIfBlocked(args, ctx = {}) {
  const options = ctx.options || {}
  const projectMode = projectModes.normalizeMode(options.projectMode || 'standard')
  if (projectMode === 'research') {
    return {
      success: false,
      error: '研究模式不支持派工。请在当前会话里自己完成。',
      next_action: '不要再调用 delegate_agents。'
    }
  }
  if (options.teamWorker === true || options.teamAgentId) {
    return {
      success: false,
      error: '队员不能再派工。请自己完成当前任务。',
      next_action: '继续使用普通工具完成自己的 task。'
    }
  }
  const modelConfig = ctx.modelConfig || options.modelConfig || {}
  const modelId = modelConfig.modelId || modelConfig.modelName || ''
  if (isChatGptWebBridgeModel(modelConfig, modelId) || isGeminiSparkAgentModel(modelConfig, modelId)) {
    return {
      success: false,
      error: '网页桥模型暂不支持标准模式派工，请换 API 模型后再组队。',
      next_action: '自己完成本轮，或请用户切换到 API 模型。'
    }
  }
  return parseDelegateArgs(args, [
    args.team_brief || args.teamBrief || '',
    options.userMessage,
    options.assistantAnnouncement
  ].filter(Boolean).join('\n'))
}

async function executeDelegate(args = {}, ctx = {}) {
  const parsed = rejectIfBlocked(args, ctx)
  if (!parsed.success) return parsed

  const options = ctx.options || {}
  const signal = ctx.signal || options.signal
  const webContents = ctx.webContents || options.webContents
  const userMessage = String(options.userMessage || '').trim()
  const execution = {
    id: randomId('exec'),
    executionKind: 'team',
    projectId: ctx.projectId || '',
    projectPath: ctx.projectPath || '',
    requestId: options.requestId || '',
    chatSessionId: options.chatSessionId || '',
    task: compactText(userMessage, 200) || parsed.teamBrief || '团队任务',
    teamBrief: parsed.teamBrief,
    notes: {
      coordination: parsed.teamBrief,
      convention: '',
      consensus: ''
    },
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: 0,
    status: 'running',
    waves: parsed.waves,
    agents: parsed.tasks.map(createAgent)
  }
  execution.workflow = buildWorkflowFromAgents(execution)
  emitProjection(execution, webContents)

  const byId = new Map(execution.agents.map(agent => [agent.id, agent]))
  const finished = new Set()

  try {
    for (const wave of parsed.waves) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const agents = wave.map(task => byId.get(task.id)).filter(Boolean)
      await mapPool(agents, MAX_PARALLEL, async (agent) => {
        if (signal?.aborted) {
          agent.status = 'cancelled'
          agent.statusText = '已取消'
          agent.finishedAt = Date.now()
          return
        }
        const upstream = (agent.dependsOn || [])
          .map(id => byId.get(id))
          .filter(item => item && finished.has(item.id))
          .map(item => ({
            id: item.id,
            name: item.name,
            role: item.role,
            status: item.status,
            output: compactText(item.output, 1800),
            error: item.error?.message || ''
          }))
        agent.status = 'running'
        agent.statusText = '开工'
        agent.startedAt = Date.now()
        emitProjection(execution, webContents)
        try {
          const { runTeamWorker } = require('./agent-team-worker')
          const result = await runTeamWorker({
            execution,
            agent,
            ctx,
            teamBrief: parsed.teamBrief,
            upstream,
            onUpdate() {
              emitProjection(execution, webContents)
            }
          })
          agent.output = String(result?.output || agent.output || '').trim()
          if (result?.success === false) {
            agent.status = 'error'
            agent.error = { message: result.error || '队员执行失败' }
            agent.statusText = compactText(agent.error.message, 96)
          } else {
            agent.status = 'done'
            agent.statusText = '已完成'
          }
        } catch (error) {
          const aborted = error?.name === 'AbortError' || signal?.aborted
          agent.status = aborted ? 'cancelled' : 'error'
          agent.error = { message: aborted ? '已取消' : (error?.message || String(error)) }
          agent.statusText = agent.error.message
        }
        agent.finishedAt = Date.now()
        finished.add(agent.id)
        emitProjection(execution, webContents)
      })
    }

    const failed = execution.agents.filter(agent => agent.status === 'error' || agent.status === 'failed')
    const cancelled = execution.agents.filter(agent => agent.status === 'cancelled' || agent.status === 'interrupted')
    execution.status = cancelled.length && cancelled.length === execution.agents.length
      ? 'cancelled'
      : failed.length
        ? 'completed_with_errors'
        : 'done'
    execution.notes.consensus = failed.length
      ? `有 ${failed.length} 名队员未完成，请主会话据实汇总缺口。`
      : '各队员已交卷，请主会话汇总给用户。'
    execution.finishedAt = Date.now()
    emitProjection(execution, webContents)

    return {
      success: execution.status !== 'cancelled',
      execution_id: execution.id,
      status: execution.status,
      team_brief: parsed.teamBrief,
      notes: execution.notes,
      workers: execution.agents.map(summarizeAgent),
      message: execution.status === 'cancelled'
        ? '派工已取消。'
        : '队员已交卷。请阅读 workers[].output 后给用户汇总，不要复述成你亲手做的。'
    }
  } catch (error) {
    const aborted = error?.name === 'AbortError' || signal?.aborted
    execution.status = aborted ? 'cancelled' : 'error'
    execution.finishedAt = Date.now()
    for (const agent of execution.agents) {
      if (['waiting', 'running', 'thinking', 'using_tools'].includes(agent.status)) {
        agent.status = aborted ? 'cancelled' : 'error'
        agent.statusText = aborted ? '已取消' : '中止'
        agent.finishedAt = Date.now()
      }
    }
    emitProjection(execution, webContents)
    return {
      success: false,
      aborted,
      execution_id: execution.id,
      status: execution.status,
      workers: execution.agents.map(summarizeAgent),
      error: aborted ? '派工已取消' : (error?.message || String(error))
    }
  }
}

module.exports = {
  TEAM_TOOL_NAME,
  MAX_TASKS,
  MAX_PARALLEL,
  buildStandardModePrompt,
  coerceTaskList,
  announcedMemberCount,
  parseDelegateArgs,
  buildDagWaves,
  buildWorkflowFromAgents,
  toProjection,
  clipText,
  executeDelegate
}
