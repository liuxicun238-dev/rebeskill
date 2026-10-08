/**
 * Schedule one model tool batch: consecutive read-only calls may overlap;
 * mutating / blocking / unknown tools are exclusive barriers.
 * Fail closed: only an explicit allow-list is treated as concurrency-safe.
 */

const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'read_many_files',
  'file_read',
  'find_in_file',
  'list_files',
  'glob_files',
  'file_search',
  'code_inspect',
  'locate_code',
  'query_code_map',
  'discover_code',
  'search_project',
  'grep_code',
  'grep',
  'find_references',
  'trace_call_chain',
  'git_diff',
  'check_syntax',
  'code_navigate',
  'parallel_research',
  'web_bridge_search',
  'inspect_image',
  'view_image',
  'lxweb',
  'browser_search',
  'browser_fetch',
  'recall_history',
  'read_task_ledger_entry',
  'get_latest_change_session',
  'search_ai_operation_memos',
  'read_ai_operation_memo',
  'list_skill_drafts',
  'load_skill',
  'search_tools',
  'mcp_list_tools',
  'blender_status',
  'blender_inspect_scene',
])

function getCallName(call = {}) {
  return String(call?.function?.name || call?.name || '')
}

function isConcurrencySafeToolName(name = '') {
  return PARALLEL_SAFE_TOOLS.has(String(name || ''))
}

function isConcurrencySafeToolCall(call = {}) {
  return isConcurrencySafeToolName(getCallName(call))
}

function partitionToolWaves(toolCalls = []) {
  const waves = []
  let current = []
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call) continue
    if (isConcurrencySafeToolCall(call)) {
      current.push(call)
      continue
    }
    if (current.length) {
      waves.push(current)
      current = []
    }
    waves.push([call])
  }
  if (current.length) waves.push(current)
  return waves
}

module.exports = {
  PARALLEL_SAFE_TOOLS,
  isConcurrencySafeToolName,
  isConcurrencySafeToolCall,
  partitionToolWaves
}
