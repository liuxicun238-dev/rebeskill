const recoveryPoints = require('../recovery-points')

function isChangeIntent(message = '') {
  return /(修|修复|改|修改|实现|增加|新增|开发|做一个|优化|美化|重构|删除|移除|接入|支持|调整|替换|生成|创建)/i.test(String(message || ''))
}

function getLedgerContextMaxItems(message = '') {
  const text = String(message || '')
  if (/(账本|ledger|纪要|摘要编号|task-|discussion-|详细|展开|补充|完整|继续(刚刚|之前|上次|前面|那个)|接着(刚刚|之前|上次|前面|那个)|之前的(任务|方案|讨论)|上次的(任务|方案|讨论)|旧任务|旧方案|历史任务|历史方案)/i.test(text)) return 5
  return 3
}

/**
 * 用户要求“详细一点”时，通常不是在提出新的源码调查，而是在要求
 * 把上一轮已经完成的调查/操作结果展开。这个意图必须和“继续执行”
 * 分开，否则模型会把一条解释请求误判成新的探索任务。
 */
function isFollowupExpansionIntent(message = '') {
  const text = String(message || '').trim()
  if (!text) return false
  return /(?:详细一点|详细些|详细(?:回答|回复|说明|介绍|总结|讲解|描述)|完整(?:回答|回复|说明|介绍|总结|讲解|描述)|展开(?:说|讲|说明|介绍|解释)?|补充(?:完整|详细)|说(?:得|的)太短|(?:回复|回答|内容|总结)(?:太短|太简略|不够详细|不够完整)|总结(?:出|得)?(?:那么|这么)?短|太简略|不够详细|不够完整|太短了|把(?:刚才|刚刚|上次|之前|前面)(?:的)?(?:调查|内容|结果|说明|总结)(?:的(?:内容|结果|说明|总结))?(?:都)?(?:说|写|整理|展开|补充)(?:完整|详细|全一点)?|基于(?:刚才|刚刚|上次|之前|前面)(?:的结果|调查|内容|说明)(?:详细|完整)?(?:说明|展开|整理)|不要只给(?:我)?(?:一句|简短)?总结|把你(?:刚才|上次|之前)(?:查到|调查到|看到)的(?:内容|结果)?(?:都)?(?:列出来|说全|整理出来)|(?:刚才|刚刚|上次|之前|前面)的(?:调查|内容|结果|说明|总结)(?:太短|太简略|不够详细))/i.test(text)
}

function shouldIncludeHistoricalProjectContext(message = '') {
  const text = String(message || '').trim()
  if (!text) return false
  // 继续/接着/恢复/按 必须搭配明确的历史指向词才注入旧任务账本索引；
  // 否则"恢复默认样式""继续保持这个配色"等全新需求会误触发，注入历史索引淹没当轮需求。
  return isFollowupExpansionIntent(text) || /(账本|ledger|纪要|摘要编号|task-[\w-]+|discussion-[\w-]+|(继续|接着|恢复|回到|按)(刚刚|刚才|之前|上次|上一[轮步次]|前面|那个|前一次|上面|以前|历史|旧)|之前的(任务|方案|讨论)|上次的(任务|方案|讨论)|旧任务|旧方案|历史任务|历史方案)/i.test(text)
}

async function createAiSafetySnapshot(projectPath, options = {}) {
  const projectId = options.projectId || options.changeSession?.projectId
  const changeSessionId = options.changeSessionId || options.changeSession?.id
  if (!projectPath || !projectId || !changeSessionId) return null
  try {
    const result = await recoveryPoints.createAiTaskRecoveryPoint(projectId, projectPath, changeSessionId, options)
    console.log('[RecoveryPoints] AI 任务恢复点:', result)
    return result
  } catch (error) {
    console.error('[RecoveryPoints] AI 任务恢复点失败:', error)
    return { success: false, error: String(error?.message || error) }
  }
}

module.exports = {
  isChangeIntent,
  isFollowupExpansionIntent,
  getLedgerContextMaxItems,
  shouldIncludeHistoricalProjectContext,
  createAiSafetySnapshot
}
