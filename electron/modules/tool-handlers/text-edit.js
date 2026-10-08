/**
 * 文本编辑工具处理器
 * 包含：text_edit, apply_patch, json_edit 工具及相关辅助函数
 */

const fs = require('fs')
const path = require('path')
const changeSessions = require('../change-sessions')
const { toProjectRelative } = require('../path-utils')
const {
  countLines, findFlexibleTextRange, findLooseLineAnchoredRange, buildTextEditDiagnostics, applyTextEditList,
  normalizeTextEditArgs, hasUsableTextEdits, looksLikeFullFileRewrite
} = require('../text-edit-utils')
const { ensureSafetyBaselineBeforeWrite } = require('./git-safety')
const { safelyRecordChange, guardMutatingFile, rememberWrittenFile } = require('./file-ops')
const { attachPostEditDiagnostics, capturePostEditRuntimeBaseline } = require('./diagnostics')
const { buildPathFailureResult } = require('./search')
const { isChatGptWebBridgeModel } = require('../capability-tiers')
const fileVersionGuard = require('../chat/file-version-guard')

function isLenientWebBridgeWrite(ctx = {}) {
  const modelConfig = ctx.modelConfig || {}
  return ctx.options?.geminiDirectTransport === true ||
    isChatGptWebBridgeModel(modelConfig, String(modelConfig.modelId || modelConfig.model || ''))
}

async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

function isApplyPatchBeginLine(line = '') {
  return /^\*\*\*\s+Begin Patch\s*$/i.test(String(line || '').trim())
}

function isApplyPatchEndLine(line = '') {
  return /^\*\*\*\s+End(?:\s+of)?\s+Patch\s*$/i.test(String(line || '').trim())
}

function isLenientPatchNoiseLine(line = '') {
  const value = String(line || '').trim()
  if (!value) return false
  if (/^```/.test(value)) return true
  if (/^(?:Copy code|复制代码|Copy|复制|Download|下载)$/i.test(value)) return true
  return /[\u4e00-\u9fff]/.test(value) && !/^[-+@*]/.test(value) && !/[\\/][\w.-]+\.\w+/.test(value)
}

function normalizePageReplacementSegments(patchBody = '') {
  const lines = String(patchBody || '').split('\n')
  const output = []
  let index = 0
  while (index < lines.length) {
    const header = lines[index]
    if (!/^\*\*\*\s+Update File:\s*/i.test(header)) {
      output.push(header)
      index += 1
      continue
    }
    let nextFile = index + 1
    while (nextFile < lines.length && !/^\*\*\*\s+(?:Update|Add|Delete) File:\s*/i.test(lines[nextFile])) nextFile += 1
    const segment = lines.slice(index + 1, nextFile)
    const updateStart = segment.findIndex(line => /^\*\*\*\s+Update Start:\s*$/i.test(line.trim()))
    const updateEnd = segment.findIndex((line, offset) => offset > updateStart && /^\*\*\*\s+Update End:\s*$/i.test(line.trim()))
    const replacement = segment.findIndex((line, offset) => offset > updateEnd && /^\*\*\*\s+Replacement:\s*$/i.test(line.trim()))
    output.push(header)
    if (updateStart >= 0 && updateEnd > updateStart && replacement > updateEnd) {
      output.push('@@')
      for (const line of segment.slice(updateStart + 1, updateEnd)) output.push(`-${line}`)
      for (const line of segment.slice(replacement + 1)) output.push(`+${line}`)
    } else {
      output.push(...segment)
    }
    index = nextFile
  }
  return output.join('\n')
}

function normalizeApplyPatchText(patchText = '') {
  let raw = String(patchText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/＊/g, '*').trim()
  if (!raw) return raw
  const hasFileOp = /\*\*\*\s+(Add File|Update File|Delete File):/im.test(raw)
  const hasBegin = /^\*\*\*\s+Begin Patch/im.test(raw)
  if (hasFileOp) {
    // 页面模型常把 Begin/End 放在每个 Update File 内部，或先写 Update File
    // 再写 Begin Patch。统一移除所有局部包裹后，对整批文件操作只包一层。
    const body = raw.split('\n')
      .filter(line => !isApplyPatchBeginLine(line) && !isApplyPatchEndLine(line))
      .join('\n')
      .trim()
    return `*** Begin Patch\n${normalizePageReplacementSegments(body)}\n*** End Patch`
  }
  if (!hasFileOp && !hasBegin) return raw
  if (!hasBegin) raw = `*** Begin Patch\n${raw}`
  if (!/\*\*\*\s+End(?:\s+of)?\s+Patch\s*$/im.test(raw)) {
    raw = `${raw.replace(/\s+$/, '')}\n*** End Patch`
  }
  return raw
}

function parseApplyPatch(patchText = '', options = {}) {
  const lenient = options.lenient === true
  const raw = normalizeApplyPatchText(patchText)
  const lines = raw.split('\n')
  const firstMeaningful = lines.findIndex(line => line.trim())
  if (firstMeaningful < 0 || !isApplyPatchBeginLine(lines[firstMeaningful])) {
    throw new Error('apply_patch 缺少 *** Begin Patch')
  }

  const operations = []
  let i = firstMeaningful + 1
  while (i < lines.length) {
    const line = lines[i]
    if (isApplyPatchEndLine(line)) break

    if (line.startsWith('*** Add File: ')) {
      const filePath = line.slice('*** Add File: '.length).trim()
      if (!filePath) throw new Error('Add File 缺少路径')
      i += 1
      const contentLines = []
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (lines[i].startsWith('+')) {
          contentLines.push(lines[i].slice(1))
        } else if (lenient) {
          contentLines.push(lines[i])
        } else {
          throw new Error(`Add File ${filePath} 中的内容行必须以 + 开头`)
        }
        i += 1
      }
      operations.push({ type: 'add', path: filePath, content: contentLines.join('\n') })
      continue
    }

    if (line.startsWith('*** Delete File: ')) {
      const filePath = line.slice('*** Delete File: '.length).trim()
      if (!filePath) throw new Error('Delete File 缺少路径')
      operations.push({ type: 'delete', path: filePath })
      i += 1
      continue
    }

    if (line.startsWith('*** Update File: ')) {
      const filePath = line.slice('*** Update File: '.length).trim()
      if (!filePath) throw new Error('Update File 缺少路径')
      i += 1
      let moveTo = ''
      const hunks = []
      let oldLines = []
      let newLines = []
      let hadDiffPrefix = false
      const flushHunk = () => {
        if (!oldLines.length && !newLines.length) return
        hunks.push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') })
        oldLines = []
        newLines = []
      }
      while (i < lines.length && !lines[i].startsWith('*** Update File: ') && !lines[i].startsWith('*** Add File: ') && !lines[i].startsWith('*** Delete File: ') && !isApplyPatchEndLine(lines[i])) {
        const hunkLine = lines[i]
        if (hunkLine.startsWith('*** Move to: ')) {
          moveTo = hunkLine.slice('*** Move to: '.length).trim()
        } else if (hunkLine.startsWith('@@')) {
          flushHunk()
        } else if (lenient && /^(?:---|\+\+\+)\s+/.test(hunkLine)) {
          // Gemini 页面端有时会在 Codex 的 *** Update File 段内再嵌一层
          // unified-diff 文件头。它们是元数据，不属于待匹配的源码上下文。
        } else if (hunkLine === '*** End of File') {
          // Marker accepted for Codex-style patch compatibility.
        } else if (lenient && isLenientPatchNoiseLine(hunkLine)) {
          // 页面端常在补丁后跟中文说明或代码块标签，不能写进上下文。
        } else if (hunkLine.startsWith(' ')) {
          hadDiffPrefix = true
          oldLines.push(hunkLine.slice(1))
          newLines.push(hunkLine.slice(1))
        } else if (hunkLine.startsWith('-')) {
          hadDiffPrefix = true
          oldLines.push(hunkLine.slice(1))
        } else if (hunkLine.startsWith('+')) {
          hadDiffPrefix = true
          newLines.push(hunkLine.slice(1))
        } else if (!hunkLine.trim()) {
          oldLines.push('')
          newLines.push('')
        } else if (lenient) {
          oldLines.push(hunkLine)
          newLines.push(hunkLine)
        } else {
          throw new Error(`Update File ${filePath} 中存在无法识别的补丁行: ${hunkLine.slice(0, 80)}`)
        }
        i += 1
      }
      flushHunk()
      if (lenient && !hadDiffPrefix) {
        throw new Error(`Update File ${filePath} 缺少可验证的 +/- 替换内容；请改用 text_edit`)
      }
      operations.push({ type: 'update', path: filePath, moveTo, hunks })
      continue
    }

    if (!line.trim()) {
      i += 1
      continue
    }
    if (lenient && (line.startsWith('*** ') || isLenientPatchNoiseLine(line))) {
      i += 1
      continue
    }
    throw new Error(`无法识别的补丁段: ${line.slice(0, 80)}`)
  }

  if (!lenient && !lines.some(isApplyPatchEndLine)) {
    throw new Error('apply_patch 缺少 *** End Patch')
  }
  if (!operations.length) throw new Error('apply_patch 没有任何文件操作')
  return operations
}

function looksLikeFullFileReplace(newText, oldContent) {
  const next = String(newText || '')
  if (next.trim().length < 40) return false
  if (/^\s*(<!DOCTYPE\s+html|<html[\s>]|\/\*|{)/i.test(next)) return true
  const newLines = next.split('\n').length
  const oldLines = String(oldContent || '').split('\n').length
  return newLines >= 8 && newLines >= Math.max(8, Math.floor(oldLines * 0.4))
}

function looksLikeStandaloneSourceFile(text = '') {
  const next = String(text || '')
  if (next.trim().length < 40) return false
  if (/<!DOCTYPE\s+html|<html[\s>]|:root\s*\{|html\s*,\s*body|function\s+|<\/svg>/i.test(next)) return true
  const lines = next.split('\n').length
  return lines >= 12 && /[{};]/.test(next)
}

function ensureTextPatchTarget(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const blocked = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.bmp', '.mp3', '.wav', '.mp4', '.mov', '.zip', '.7z', '.rar', '.pdf', '.docx', '.pptx', '.xlsx'])
  if (blocked.has(ext)) {
    throw new Error(`apply_patch 不处理二进制文件: ${filePath}`)
  }
}

async function applyTextPatchOperations(operations, resolvePath, projectId, projectPath, options = {}) {
  const touched = []
  const recordBefore = async (filePath, action) => {
    if (projectId) await safelyRecordChange(() => changeSessions.recordFileBeforeAsync(projectId, filePath, action))
  }
  const recordAfter = async (filePath, action) => {
    if (projectId) await safelyRecordChange(() => changeSessions.recordFileAfterAsync(projectId, filePath, action))
  }

  const affectedPaths = []
  for (const op of operations) {
    affectedPaths.push(resolvePath(op.path))
    if (op.moveTo) affectedPaths.push(resolvePath(op.moveTo))
  }
  await ensureSafetyBaselineBeforeWrite(projectId, projectPath, affectedPaths)

  const skipVersionGuard = options.skipVersionGuard === true
  if (!skipVersionGuard && projectId) {
    for (const op of operations) {
      const targetPath = resolvePath(op.path)
      const guard = await fileVersionGuard.assertFileVersion(projectId, targetPath, {
        mode: op.type === 'add' ? 'write' : 'edit',
        toolName: 'apply_patch'
      })
      fileVersionGuard.throwIfGuardFailed(guard)
    }
  }

  for (const op of operations) {
    const filePath = resolvePath(op.path)
    ensureTextPatchTarget(filePath)

    if (op.type === 'add') {
      const existed = await pathExists(filePath)
      if (existed && !options.allowOverwriteAdd) throw new Error(`文件已存在，无法 Add File: ${op.path}`)
      await recordBefore(filePath, existed ? 'modify' : 'create')
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
      await fs.promises.writeFile(filePath, op.content, 'utf-8')
      await recordAfter(filePath, existed ? 'modify' : 'create')
      await rememberWrittenFile(projectId, filePath, op.content)
      touched.push({ action: existed ? 'update' : 'add', path: filePath, line_count: countLines(op.content) })
      continue
    }

    if (op.type === 'delete') {
      if (!await pathExists(filePath)) throw new Error(`文件不存在，无法 Delete File: ${op.path}`)
      ensureTextPatchTarget(filePath)
      await recordBefore(filePath, 'delete')
      await fs.promises.unlink(filePath)
      await recordAfter(filePath, 'delete')
      if (projectId) fileVersionGuard.recordAbsentObservation(projectId, filePath)
      touched.push({ action: 'delete', path: filePath })
      continue
    }

    if (op.type === 'update') {
      if (!await pathExists(filePath)) throw new Error(`文件不存在，无法 Update File: ${op.path}`)
      const content = await fs.promises.readFile(filePath, 'utf-8')
      const hunks = Array.isArray(op.hunks) ? op.hunks : []
      if (!hunks.length && !op.moveTo) throw new Error(`Update File ${op.path} 缺少可匹配的上下文`)
      let nextContent = content
      for (const hunk of hunks) {
        if (!hunk.oldText) {
          if (options.allowLooseUpdate && hunk.newText && looksLikeFullFileReplace(hunk.newText, nextContent)) {
            nextContent = hunk.newText
            continue
          }
          continue
        }
        const range = findFlexibleTextRange(nextContent, hunk.oldText)
          || (options.allowLooseUpdate ? findLooseLineAnchoredRange(nextContent, hunk.oldText) : null)
        if (!range) {
          if (options.allowLooseUpdate && (looksLikeFullFileReplace(hunk.newText, nextContent) || looksLikeStandaloneSourceFile(hunk.newText))) {
            nextContent = hunk.newText
            continue
          }
          if (options.allowLooseUpdate && hunk.newText && !hunk.oldText.trim()) {
            nextContent = hunk.newText
            continue
          }
          const error = new Error(`Update File ${op.path} context not found`)
          error.diagnostics = {
            path: op.path,
            ...buildTextEditDiagnostics(nextContent, hunk.oldText),
            hint: 'Patch context did not match. Use returned candidate lines with text_edit replace_lines/regex instead of rewriting the whole file.'
          }
          throw error
        }
        nextContent = nextContent.slice(0, range.start) + hunk.newText + nextContent.slice(range.end)
      }
      await recordBefore(filePath, 'modify')
      await fs.promises.writeFile(filePath, nextContent, 'utf-8')
      await recordAfter(filePath, 'modify')
      await rememberWrittenFile(projectId, filePath, nextContent)
      let finalPath = filePath
      if (op.moveTo) {
        const targetPath = resolvePath(op.moveTo)
        ensureTextPatchTarget(targetPath)
        if (await pathExists(targetPath)) throw new Error(`目标文件已存在，无法 Move to: ${op.moveTo}`)
        await recordBefore(targetPath, 'create')
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.promises.rename(filePath, targetPath)
        await recordAfter(targetPath, 'create')
        if (projectId) fileVersionGuard.recordAbsentObservation(projectId, filePath)
        await rememberWrittenFile(projectId, targetPath, nextContent)
        finalPath = targetPath
      }
      touched.push({ action: op.moveTo ? 'move_update' : 'update', path: finalPath, line_count: countLines(nextContent) })
    }
  }

  return touched
}

function parseJsonPath(jsonPath = '') {
  return String(jsonPath || '')
    .split('.')
    .map(part => part.trim())
    .filter(Boolean)
}

function getJsonContainer(rootValue, pathParts, createMissing = false) {
  let current = rootValue
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const key = pathParts[index]
    const nextKey = pathParts[index + 1]
    const nextShouldBeArray = /^\d+$/.test(nextKey)
    if (Array.isArray(current)) {
      const arrayIndex = Number(key)
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0) throw new Error(`JSON 路径数组下标不合法: ${key}`)
      if (current[arrayIndex] === undefined) {
        if (!createMissing) return null
        current[arrayIndex] = nextShouldBeArray ? [] : {}
      }
      current = current[arrayIndex]
    } else if (current && typeof current === 'object') {
      if (current[key] === undefined) {
        if (!createMissing) return null
        current[key] = nextShouldBeArray ? [] : {}
      }
      current = current[key]
    } else {
      throw new Error(`JSON 路径无法进入非对象节点: ${key}`)
    }
  }
  return { container: current, key: pathParts[pathParts.length - 1] }
}

function applyJsonEditOperations(data, operations = []) {
  const applied = []
  for (const operation of operations) {
    const op = String(operation.op || '').toLowerCase()
    const parts = parseJsonPath(operation.json_path || operation.path || '')
    if (!parts.length) throw new Error('json_path 不能为空')
    const target = getJsonContainer(data, parts, op === 'set' || op === 'append')
    if (!target) {
      applied.push({ op, json_path: parts.join('.'), skipped: true, reason: 'path-not-found' })
      continue
    }
    const { container, key } = target
    if (Array.isArray(container)) {
      const index = key === '-' ? container.length : Number(key)
      if (op === 'set') {
        if (!Number.isInteger(index) || index < 0) throw new Error(`数组下标不合法: ${key}`)
        container[index] = operation.value
      } else if (op === 'delete') {
        if (Number.isInteger(index) && index >= 0 && index < container.length) container.splice(index, 1)
      } else if (op === 'append') {
        if (key === '-' || key === String(container.length)) container.push(operation.value)
        else {
          if (!Array.isArray(container[index])) throw new Error(`append 目标不是数组: ${parts.join('.')}`)
          container[index].push(operation.value)
        }
      } else {
        throw new Error(`不支持的 json_edit op: ${op}`)
      }
    } else if (container && typeof container === 'object') {
      if (op === 'set') container[key] = operation.value
      else if (op === 'delete') delete container[key]
      else if (op === 'append') {
        if (!Array.isArray(container[key])) {
          if (container[key] === undefined) container[key] = []
          else throw new Error(`append 目标不是数组: ${parts.join('.')}`)
        }
        container[key].push(operation.value)
      } else {
        throw new Error(`不支持的 json_edit op: ${op}`)
      }
    } else {
      throw new Error(`JSON 路径目标不是对象或数组: ${parts.join('.')}`)
    }
    applied.push({ op, json_path: parts.join('.') })
  }
  return applied
}

const handlers = {
  text_edit: async (args, ctx) => {
    const { resolvePath, projectPath, projectId } = ctx
    const webBridgeWrite = isLenientWebBridgeWrite(ctx)
    const normalizedArgs = normalizeTextEditArgs(args, { lenient: webBridgeWrite })
    try {
      if (webBridgeWrite && !hasUsableTextEdits(normalizedArgs.edits)) {
        const fullContent = String(normalizedArgs.content ?? normalizedArgs.contents ?? '')
        if (looksLikeFullFileRewrite(fullContent)) {
          const { handlers } = require('./file-ops')
          return handlers.write_file({
            path: normalizedArgs.path || args.path,
            content: fullContent,
            allow_full_rewrite: true
          }, ctx)
        }
      }
      const filePath = resolvePath(normalizedArgs.path || args.path)
      if (!await pathExists(filePath)) {
        return buildPathFailureResult({
          requestedPath: normalizedArgs.path || args.path,
          resolvedPath: filePath,
          projectPath,
          kind: 'file'
        })
      }
      if (!(await fs.promises.stat(filePath)).isFile()) {
        return buildPathFailureResult({
          requestedPath: normalizedArgs.path || args.path,
          resolvedPath: filePath,
          projectPath,
          kind: 'file',
          errorType: 'not_a_file'
        })
      }
      ensureTextPatchTarget(filePath)
      await ensureSafetyBaselineBeforeWrite(projectId, projectPath, [filePath])
      const versionBlock = await guardMutatingFile(ctx, filePath, {
        mode: 'edit',
        toolName: 'text_edit',
        webBridge: webBridgeWrite
      })
      if (versionBlock) return versionBlock
      if (projectId) {
        await safelyRecordChange(() => changeSessions.recordFileBeforeAsync(projectId, filePath, 'modify'))
      }
      const content = await fs.promises.readFile(filePath, 'utf-8')
      const editResult = applyTextEditList(content, normalizedArgs.edits, { lenient: webBridgeWrite })
      if (editResult.content === content) {
        return {
          success: true,
          path: filePath,
          relative_path: toProjectRelative(projectPath, filePath),
          unchanged: true,
          applied: editResult.applied,
          message: 'text_edit made no content changes'
        }
      }
      const runtimeCursor = capturePostEditRuntimeBaseline(projectId, projectPath)
      await fs.promises.writeFile(filePath, editResult.content, 'utf-8')
      if (projectId) {
        await safelyRecordChange(() => changeSessions.recordFileAfterAsync(projectId, filePath, 'modify'))
        await rememberWrittenFile(projectId, filePath, editResult.content)
      }
      const result = {
        success: true,
        path: filePath,
        relative_path: toProjectRelative(projectPath, filePath),
        applied: editResult.applied,
        operation_count: editResult.applied.length,
        added_lines: editResult.applied.reduce((sum, item) => sum + (item.added_lines || 0), 0),
        removed_lines: editResult.applied.reduce((sum, item) => sum + (item.removed_lines || 0), 0),
        line_count: countLines(editResult.content),
        message: `Text edited: ${toProjectRelative(projectPath, filePath) || filePath}`
      }
      await attachPostEditDiagnostics(result, [filePath], projectPath, runtimeCursor)
      return result
    } catch (e) {
      return {
        success: false,
        error_type: 'text_edit_error',
        error: e.message,
        diagnostics: e.diagnostics || null,
        requested_path: normalizedArgs.path || args.path || '',
        project_root: projectPath
      }
    }
  },

  apply_patch: async (args, ctx) => {
      const { resolvePath, projectPath, projectId } = ctx
    try {
      const webBridgeWrite = isLenientWebBridgeWrite(ctx)
      const geminiDirectWrite = ctx.options?.geminiDirectTransport === true
      const operations = parseApplyPatch(args.patch || '', { lenient: webBridgeWrite })
      const runtimeCursor = capturePostEditRuntimeBaseline(projectId, projectPath)
      const touched = await applyTextPatchOperations(operations, resolvePath, projectId, projectPath, {
        // Gemini 直连可以宽松解析页面模型的包装格式，但落盘仍要求真实上下文匹配。
        // 浏览器桥保留原兼容行为；普通 API 模型完全不受影响。
        allowOverwriteAdd: webBridgeWrite && !geminiDirectWrite,
        allowLooseUpdate: webBridgeWrite && !geminiDirectWrite,
        skipVersionGuard: webBridgeWrite && !geminiDirectWrite
      })
      const result = {
        success: true,
        message: `补丁已应用，共 ${touched.length} 个文件操作`,
        files: touched
      }
      await attachPostEditDiagnostics(result, touched.filter(item => item.action !== 'delete').map(item => item.path), projectPath, runtimeCursor)
      result.syntaxWarnings = result.postEditDiagnostics.results.map(item => ({
        path: item.path,
        valid: item.valid,
        language: item.language,
        errors: item.errors || []
      }))
      return result
    } catch (e) {
      return {
        success: false,
        error_type: e.error_type || 'patch_error',
        error: e.message,
        diagnostics: e.diagnostics || null,
        ...(e.guard ? fileVersionGuard.toToolResult(e.guard, projectPath) || {} : {})
      }
    }
  },

  json_edit: async (args, ctx) => {
    const { resolvePath, projectPath, projectId } = ctx
    try {
      const filePath = resolvePath(args.path)
      const operations = Array.isArray(args.operations) ? args.operations : []
      const indent = Math.max(0, Math.min(Number(args.indent ?? 2) || 2, 8))
      if (!await pathExists(filePath)) {
        return buildPathFailureResult({
          requestedPath: args.path,
          resolvedPath: filePath,
          projectPath,
          kind: 'file'
        })
      }
      if (!(await fs.promises.stat(filePath)).isFile()) {
        return { success: false, error: 'json_edit only supports files', path: filePath }
      }
      if (!operations.length) {
        return { success: false, error: 'json_edit requires at least one operation', path: filePath }
      }
      await ensureSafetyBaselineBeforeWrite(projectId, projectPath, [filePath])
      const versionBlock = await guardMutatingFile(ctx, filePath, {
        mode: 'edit',
        toolName: 'json_edit'
      })
      if (versionBlock) return versionBlock
      if (projectId) {
        await safelyRecordChange(() => changeSessions.recordFileBeforeAsync(projectId, filePath, 'modify'))
      }
      const originalContent = await fs.promises.readFile(filePath, 'utf-8')
      let data
      try {
        data = JSON.parse(originalContent)
      } catch (parseError) {
        return {
          success: false,
          error_type: 'json_parse_error',
          error: parseError.message,
          path: filePath
        }
      }
      const applied = applyJsonEditOperations(data, operations)
      const nextContent = `${JSON.stringify(data, null, indent)}\n`
      const runtimeCursor = capturePostEditRuntimeBaseline(projectId, projectPath)
      await fs.promises.writeFile(filePath, nextContent, 'utf-8')
      if (projectId) {
        await safelyRecordChange(() => changeSessions.recordFileAfterAsync(projectId, filePath, 'modify'))
        await rememberWrittenFile(projectId, filePath, nextContent)
      }
      const result = {
        success: true,
        path: filePath,
        relative_path: toProjectRelative(projectPath, filePath),
        operations: applied,
        operation_count: applied.length,
        line_count: countLines(nextContent),
        message: `JSON updated: ${toProjectRelative(projectPath, filePath) || filePath}`
      }
      await attachPostEditDiagnostics(result, [filePath], projectPath, runtimeCursor)
      return result
    } catch (e) {
      return { success: false, error_type: 'json_edit_error', error: e.message, requested_path: args.path || '', project_root: projectPath }
    }
  }
}

module.exports = {
  handlers,
  parseApplyPatch,
  ensureTextPatchTarget,
  applyTextPatchOperations,
  parseJsonPath,
  getJsonContainer,
  applyJsonEditOperations
}
