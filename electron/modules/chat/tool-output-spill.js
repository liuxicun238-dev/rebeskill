/**
 * Bounded tool-result retention: oversized text is saved beside the project
 * so the model can file_read it later. Inline results keep a head/tail preview.
 * Save failure falls back to the clipped inline payload, never throws.
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_THRESHOLD = 12000
const SHELL_THRESHOLD = 8000
const TEXT_FIELDS = ['stdout', 'stderr', 'output', 'combined', 'log', 'content', 'text', 'body', 'preview']
const COMMAND_OUTPUT_TOOLS = new Set(['run_command', 'shell_run', 'terminal_status'])
const SKIP_SPILL_TOOLS = new Set(['load_skill', 'search_tools'])

function retainText(text = '', maxChars = DEFAULT_THRESHOLD) {
  const value = String(text || '')
  const limit = Math.max(1000, Number(maxChars) || DEFAULT_THRESHOLD)
  if (value.length <= limit) {
    return { text: value, truncated: false, originalChars: value.length }
  }
  const headLength = Math.max(600, Math.floor(limit * 0.72))
  const tailLength = Math.max(300, limit - headLength - 140)
  const omitted = value.length - headLength - tailLength
  return {
    text: `${value.slice(0, headLength)}\n...[truncated ${omitted} chars; read spill_path with file_read]\n${value.slice(-tailLength)}`,
    truncated: true,
    originalChars: value.length
  }
}

function sanitizeSegment(value, fallback = 'tool') {
  const safe = String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
  return safe || fallback
}

function resolveSpillDir(options = {}) {
  const root = String(options.projectPath || options.storagePath || '').trim()
  if (!root) return ''
  return path.join(path.resolve(root), '.lingxi', 'tool-spills')
}

function ensureSpillDir(dir) {
  if (!dir) return false
  fs.mkdirSync(dir, { recursive: true })
  const ignoreFile = path.join(dir, '.gitignore')
  if (!fs.existsSync(ignoreFile)) {
    fs.writeFileSync(ignoreFile, '*\n', 'utf8')
  }
  return true
}

function serializeSpillBody(toolName, result) {
  if (result == null) return ''
  if (typeof result === 'string') return result
  const chunks = []
  for (const key of TEXT_FIELDS) {
    if (typeof result[key] === 'string' && result[key]) {
      chunks.push(`=== ${key} ===\n${result[key]}`)
    }
  }
  if (chunks.length) return chunks.join('\n\n')
  try {
    return JSON.stringify(result, null, 2)
  } catch (_) {
    return String(result)
  }
}

function measureInlineChars(toolName, result) {
  if (result == null) return 0
  if (typeof result === 'string') return result.length
  let total = 0
  for (const key of TEXT_FIELDS) {
    if (typeof result[key] === 'string') total += result[key].length
  }
  if (total > 0) return total
  try {
    return JSON.stringify(result).length
  } catch (_) {
    return String(result).length
  }
}

function thresholdFor(toolName) {
  return COMMAND_OUTPUT_TOOLS.has(String(toolName || '')) ? SHELL_THRESHOLD : DEFAULT_THRESHOLD
}

function clipResultFields(result, maxChars) {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    const retained = retainText(String(result || ''), maxChars)
    return { next: retained.text, truncated: retained.truncated }
  }
  const next = { ...result }
  let truncated = false
  let remaining = maxChars
  for (const key of TEXT_FIELDS) {
    if (typeof next[key] !== 'string' || !next[key]) continue
    const retained = retainText(next[key], Math.max(800, remaining))
    next[key] = retained.text
    if (retained.truncated) truncated = true
    remaining = Math.max(800, remaining - retained.text.length)
  }
  if (!truncated) {
    const serialized = (() => {
      try { return JSON.stringify(next) } catch (_) { return '' }
    })()
    if (serialized.length > maxChars) {
      const retained = retainText(serialized, maxChars)
      return {
        next: {
          success: next.success,
          error: next.error,
          preview: retained.text,
          truncated: true
        },
        truncated: true
      }
    }
  }
  return { next, truncated }
}

function applyToToolResult(toolName, result, options = {}) {
  if (result == null) return result
  if (SKIP_SPILL_TOOLS.has(String(toolName || ''))) return result
  if (result && typeof result === 'object' && result.spilled === true) return result
  const chars = measureInlineChars(toolName, result)
  const threshold = thresholdFor(toolName)
  if (chars <= threshold) return result

  const dir = resolveSpillDir(options)
  const body = serializeSpillBody(toolName, result)
  const clipped = clipResultFields(result, threshold)
  let spillPath = ''
  if (dir && body) {
    try {
      if (ensureSpillDir(dir)) {
        const fileName = `${sanitizeSegment(options.callId, 'call')}-${sanitizeSegment(toolName)}.txt`
        spillPath = path.join(dir, fileName)
        fs.writeFileSync(spillPath, body, 'utf8')
      }
    } catch (_) {
      spillPath = ''
    }
  }

  const base = clipped.next && typeof clipped.next === 'object' && !Array.isArray(clipped.next)
    ? clipped.next
    : { preview: clipped.next }

  if (!spillPath) {
    return {
      ...base,
      truncated: true,
      original_chars: chars,
      retrieval_hint: '输出过长且未能写入 spill 文件。下面只保留头尾预览，不要假设已看到全文。'
    }
  }

  return {
    ...base,
    spilled: true,
    truncated: true,
    spill_path: spillPath,
    spill_bytes: Buffer.byteLength(body, 'utf8'),
    original_chars: chars,
    retrieval_hint: `完整输出已写入 ${spillPath}。需要细节时用 file_read 按行段读取该文件，不要假设当前结果已包含全文。`
  }
}

module.exports = {
  DEFAULT_THRESHOLD,
  SHELL_THRESHOLD,
  retainText,
  applyToToolResult,
  resolveSpillDir,
  measureInlineChars
}
