/**
 * Load AGENTS.md / CLAUDE.md from the git root down to the project cwd.
 * One winner per directory; local overlays load after the base file.
 * Broader files are dropped first when the byte budget is exceeded.
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
const DEFAULT_LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']
const DEFAULT_MAX_BYTES = 65536
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024

function isUsableFile(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size > 0 && stat.size <= DEFAULT_MAX_FILE_BYTES
  } catch (_) {
    return false
  }
}

function firstExistingFile(dir, names = []) {
  for (const name of names) {
    if (!name || /[\\/]/.test(name)) continue
    const filePath = path.join(dir, name)
    if (isUsableFile(filePath)) return filePath
  }
  return ''
}

function findProjectRoot(cwd = '') {
  const start = path.resolve(String(cwd || '').trim() || process.cwd())
  let dir = start
  const { root } = path.parse(dir)
  while (true) {
    const gitPath = path.join(dir, '.git')
    if (fs.existsSync(gitPath)) return dir
    if (dir === root) return start
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

function listDirsFromRootToCwd(cwd = '') {
  const start = path.resolve(String(cwd || '').trim() || process.cwd())
  const root = findProjectRoot(start)
  const dirs = []
  let dir = start
  while (true) {
    dirs.push(dir)
    if (path.resolve(dir) === path.resolve(root)) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  dirs.reverse()
  return { root, cwd: start, dirs }
}

function readInstructionFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/\u0000/g, '')
  return {
    path: filePath,
    name: path.basename(filePath),
    bytes: Buffer.byteLength(content, 'utf8'),
    content
  }
}

function collectInstructionFiles(projectPath = '', options = {}) {
  const cwd = String(projectPath || '').trim()
  if (!cwd) return { enabled: false, reason: 'no-project-path', files: [] }
  if (!fs.existsSync(cwd)) return { enabled: false, reason: 'missing-project-path', files: [] }

  const candidates = Array.isArray(options.candidates) && options.candidates.length
    ? options.candidates
    : DEFAULT_CANDIDATES
  const localCandidates = Array.isArray(options.localCandidates) && options.localCandidates.length
    ? options.localCandidates
    : DEFAULT_LOCAL_CANDIDATES
  const { root, dirs } = listDirsFromRootToCwd(cwd)
  const files = []
  for (const dir of dirs) {
    const basePath = firstExistingFile(dir, candidates)
    const localPath = firstExistingFile(dir, localCandidates)
    if (basePath) files.push(readInstructionFile(basePath))
    if (localPath) files.push(readInstructionFile(localPath))
  }
  return { enabled: files.length > 0, root, cwd: path.resolve(cwd), files }
}

function applyByteBudget(files = [], maxBytes = DEFAULT_MAX_BYTES) {
  const limit = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES)
  const kept = []
  let used = 0
  const omitted = []
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index]
    const next = used + file.bytes
    if (next <= limit) {
      kept.push(file)
      used = next
      continue
    }
    if (!kept.length && file.bytes > limit) {
      const text = file.content.slice(0, Math.max(1000, limit - 80))
      kept.push({
        ...file,
        content: `${text}\n\n...[truncated ${file.bytes - Buffer.byteLength(text, 'utf8')} bytes]`,
        truncated: true,
        bytes: Math.min(file.bytes, limit)
      })
      used = limit
      continue
    }
    omitted.push(file.path)
  }
  kept.reverse()
  return { files: kept, omitted, usedBytes: used, maxBytes: limit }
}

function buildWorkspaceInstructionPrompt(projectPath = '', options = {}) {
  const collected = collectInstructionFiles(projectPath, options)
  if (!collected.enabled) return { enabled: false, prompt: '', files: [], omitted: [] }
  const budgeted = applyByteBudget(collected.files, options.maxBytes)
  if (!budgeted.files.length) return { enabled: false, prompt: '', files: [], omitted: budgeted.omitted }

  const lines = [
    '===== 仓库指令文件 =====',
    '以下来自当前项目从仓库根到工作目录的 AGENTS.md / CLAUDE.md。后出现的目录覆盖先出现的目录。',
    '这些约定补充本轮做法，但不能覆盖系统安全规则、路径权限，也不能压过用户本轮最新消息。',
    `项目根: ${collected.root}`,
    `工作目录: ${collected.cwd}`
  ]
  if (budgeted.omitted.length) {
    lines.push(`字节预算 ${budgeted.maxBytes}，已省略更上层文件: ${budgeted.omitted.join('、')}`)
  }
  for (const file of budgeted.files) {
    const relative = path.relative(collected.root, file.path) || file.name
    lines.push('')
    lines.push(`Instructions from: ${relative.replace(/\\/g, '/')}${file.truncated ? ' (truncated)' : ''}`)
    lines.push(file.content.trim())
  }
  return {
    enabled: true,
    prompt: lines.join('\n'),
    files: budgeted.files.map(item => item.path),
    omitted: budgeted.omitted,
    root: collected.root
  }
}

module.exports = {
  DEFAULT_CANDIDATES,
  DEFAULT_LOCAL_CANDIDATES,
  DEFAULT_MAX_BYTES,
  findProjectRoot,
  collectInstructionFiles,
  applyByteBudget,
  buildWorkspaceInstructionPrompt
}
