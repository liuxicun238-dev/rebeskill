/**
 * 把 ChatGPT / DeepSeek 网页气泡里的 HTML 还原成 Markdown。
 * 给 Playwright page.evaluate 用，函数必须自包含，不能闭包外部变量。
 *
 * 旧逻辑把每个文本节点都当成独立段落（后面加 \n\n），页面上的
 * 「主要定位：……」会被拆成多行碎句，软件端就和网页排版对不上。
 */

function markdownFromDomNode(latest, options) {
  const skipThinking = !options || options.skipThinking !== false
  const markdownSelectors = (options && options.markdownSelectors) || []
  const consumedNodes = new Set()

  function classText(node) {
    const cls = node && node.className
    if (!cls) return ''
    return typeof cls === 'string' ? cls : String(cls.baseVal || cls)
  }

  function isThinkingNode(node) {
    if (!skipThinking || !node || node.nodeType !== 1) return false
    const cls = classText(node)
    const testid = String(node.getAttribute && node.getAttribute('data-testid') || '')
    const aria = String(node.getAttribute && node.getAttribute('aria-label') || '')
    const text = String((node && (node.innerText || node.textContent)) || '').replace(/\s+/g, ' ').trim()
    if (/LINGXI_(TOOL_CALLS|FINAL|STAGE)/i.test(text)) return false
    if (text.length <= 8 && /^(正在思考|思考中|Thinking)$/i.test(text)) return true
    if (/think|reasoning|thought|思考|deep.?thinking/i.test(`${cls} ${testid} ${aria}`)) return true
    return /^(Deep Thinking|深度思考)\b/i.test(text.slice(0, 24)) && text.length < 80
  }

  function isBlockTag(tag) {
    return /^(p|h1|h2|h3|h4|h5|h6|ul|ol|li|pre|table|thead|tbody|tr|blockquote|hr|section|article)$/.test(tag)
  }

  function isTableLike(node) {
    if (!node || node.nodeType !== 1) return false
    const tag = String(node.tagName || '').toLowerCase()
    if (tag === 'table') return true
    const role = String(node.getAttribute && node.getAttribute('role') || '').toLowerCase()
    if (role === 'table' || role === 'grid') return true
    const cls = classText(node)
    if (/(?:markdown-table|md-table|ds-table|table-wrapper|table-container|data-table|spreadsheet|comparison-table)/i.test(cls)) return true
    if (/table/i.test(cls) && node.querySelector && node.querySelector('tr, [role="row"]')) return true
    return false
  }

  function looksLikePipeTableText(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
      .map(line => line.replace(/^\s+|\s+$/g, ''))
      .filter(line => line && !/^```/.test(line))
    if (lines.length < 2) return false
    const tableLines = lines.filter(line => /\|/.test(line))
    if (tableLines.length < 2 || tableLines.length < lines.length * 0.7) return false
    return tableLines.some(line => /\|[\s:|-]+\|/.test(line) || /^\|?\s*:?-{2,}/.test(line.replace(/\s/g, '')))
  }

  function looksLikeHtmlTableText(text) {
    const value = String(text || '')
    return /<table[\s>]/i.test(value) && /<\/table>/i.test(value)
  }

  function looksLikeHtmlTableOnly(text) {
    const value = String(text || '').trim()
    if (!looksLikeHtmlTableText(value)) return false
    const leftover = value
      .replace(/<table[\s\S]*?<\/table>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/i, '')
      .replace(/<\/?(?:html|head|body)[^>]*>/gi, '')
      .replace(/\s+/g, '')
    return leftover.length < 48
  }

  function htmlTableStringToMd(html) {
    const tableMatch = String(html || '').match(/<table[\s\S]*?<\/table>/i)
    if (!tableMatch) return ''
    const rows = []
    const chunk = tableMatch[0]
    const trRe = /<tr[\s\S]*?<\/tr>/gi
    let tr = null
    while ((tr = trRe.exec(chunk))) {
      const cells = []
      const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi
      let cell = null
      while ((cell = cellRe.exec(tr[0]))) {
        cells.push(String(cell[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim())
      }
      if (cells.length && cells.some(Boolean)) rows.push(cells)
    }
    if (!rows.length) return ''
    const width = Math.max.apply(null, rows.map(row => row.length))
    if (width < 2) return ''
    const normalized = rows.map(row => {
      const next = row.slice()
      while (next.length < width) next.push('')
      return next.slice(0, width)
    })
    const header = normalized[0]
    const body = normalized.slice(1)
    const out = ['| ' + header.join(' | ') + ' |', '| ' + header.map(function () { return '---' }).join(' | ') + ' |']
    body.forEach(row => out.push('| ' + row.join(' | ') + ' |'))
    return out.join('\n') + '\n\n'
  }

  function htmlTableTextToMd(html) {
    const decoded = String(html || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
    if (typeof document !== 'undefined' && document.createElement) {
      try {
        const wrap = document.createElement('div')
        wrap.innerHTML = decoded
        const table = wrap.querySelector && wrap.querySelector('table')
        if (table) {
          const md = tableMd(table)
          if (md) return md
        }
      } catch (_) { /* fall through to regex parse */ }
    }
    return htmlTableStringToMd(decoded)
  }

  function fenceToMd(codeText, lang) {
    const text = String(codeText || '').replace(/\s+$/, '')
    if (looksLikeHtmlTableOnly(text)) {
      const md = htmlTableTextToMd(text)
      if (md) return md
    }
    if (looksLikePipeTableText(text) && (!lang || /^(html|xml|markdown|md|text|txt|csv)?$/i.test(lang))) {
      return text.replace(/^\s+|\s+$/g, '') + '\n\n'
    }
    return '```' + (lang || '') + '\n' + text + '\n```\n\n'
  }

  function nestedTableMd(node) {
    const nested = node && node.querySelector && node.querySelector('table, [role="table"], [role="grid"]')
    if (!nested || !isTableLike(nested)) return ''
    return tableMd(nested) || ''
  }

  function hasBlockChild(node) {
    const kids = Array.from((node && node.children) || [])
    return kids.some(child => {
      const tag = String(child.tagName || '').toLowerCase()
      return isBlockTag(tag) || isTableLike(child) || hasBlockChild(child)
    })
  }

  function isHtmlDocumentTag(tag) {
    return /^(html|head|body|meta|link|title|style|script|noscript)$/.test(tag)
  }

  function isWebToolTag(tag) {
    return /^(write_file|file_manage|file_read|file_search|apply_patch|text_edit|edit_file|json_edit|ask_user_choice|confirm_plan|complete_step|record_ai_operation_memo|project_history|shell_run)$/i.test(tag)
  }

  function isLineNumberGutter(node) {
    if (!node || node.nodeType !== 1) return false
    const cls = classText(node)
    if (/line-number|linenumber|line-numbers|cm-gutters|gutter|hljs-ln-numbers|hljs-ln-n/i.test(cls)) return true
    const text = String(node.innerText || node.textContent || '').trim()
    if (!text || text.length > 80) return false
    const lines = text.split(/\n/).map(function (line) { return line.trim() }).filter(Boolean)
    if (lines.length < 3) return false
    return lines.every(function (line) { return /^\d+$/.test(line) })
  }

  function stripLeadingLineNumbers(text) {
    const lines = String(text || '').split(/\r?\n/)
    let i = 0
    while (i < lines.length && /^\s*\d+\s*$/.test(lines[i]) && (i === 0 || Number(lines[i].trim()) === Number(lines[i - 1].trim()) + 1)) i += 1
    return i >= 3 ? lines.slice(i).join('\n') : String(text || '')
  }

  function looksLikeAbsPathToken(text) {
    const t = String(text || '').trim().replace(/\\/g, '/')
    if (!t || t.length > 360 || /\s/.test(t)) return false
    return /^[A-Za-z]:\//.test(t)
  }

  function looksLikeFilePathToken(text) {
    return looksLikeAbsPathToken(text) && /\.\w{1,12}$/.test(String(text || '').trim().replace(/[\\/]+$/, ''))
  }

  function splitJammedFilePath(text) {
    const value = String(text || '')
    const match = value.match(/^(?:html|htm|css|js|javascript|json)?\s*([A-Za-z]:[\\/][^\s]*?\.\w{1,12})(?=[A-Za-z<{]|$)/i)
    if (!match) return { path: '', body: value }
    return { path: match[1].replace(/\\/g, '/'), body: value.slice(match.index + match[0].length).replace(/^\s+/, '') }
  }

  function markConsumed(node) {
    if (node) consumedNodes.add(node)
  }

  function recoverLooseToolArgs(name, text) {
    const value = String(text || '')
    if (name === 'file_manage') {
      const actionMatch = value.match(/create_directory|delete|copy|move/i)
      const pathMatch = value.match(/[A-Za-z]:[\\/][^\s"'{}]+/)
      if (actionMatch && pathMatch) return { action: actionMatch[0], path: pathMatch[0].replace(/\\/g, '/') }
    }
    if (name === 'file_read' || name === 'file_search') {
      const pathMatch = value.match(/[A-Za-z]:[\\/][^\s"'{}]+/)
      if (pathMatch) return { path: pathMatch[0].replace(/\\/g, '/') }
    }
    return null
  }

  function collectFosteredHtml(startNode) {
    const parts = []
    let node = startNode && startNode.nextSibling
    while (node) {
      if (consumedNodes.has(node)) {
        node = node.nextSibling
        continue
      }
      if (node.nodeType === 3) {
        const text = String(node.textContent || '')
        if (/^\s*"\s*\}/.test(text) || /^\s*<\/?(write_file|file_manage|file_read)/i.test(text)) break
        const trimmed = text.trim()
        if (looksLikeFilePathToken(trimmed) || looksLikeAbsPathToken(trimmed)) break
        if (trimmed) parts.push(text)
        markConsumed(node)
        node = node.nextSibling
        continue
      }
      if (node.nodeType === 10) {
        parts.push('<!DOCTYPE html>')
        markConsumed(node)
        node = node.nextSibling
        continue
      }
      if (node.nodeType !== 1) {
        node = node.nextSibling
        continue
      }
      const tag = String(node.tagName || '').toLowerCase()
      if (isWebToolTag(tag)) break
      if (isLineNumberGutter(node)) {
        markConsumed(node)
        node = node.nextSibling
        continue
      }
      const cls = classText(node)
      if ((/copy|clipboard/i.test(cls) && tag === 'button') || /code-block|syntax-highlighter|qwen-code|highlight-container/i.test(cls)) break
      if (isHtmlDocumentTag(tag) || /^(section|header|footer|main|article|nav|h[1-6]|ul|ol|li|p|a|button|img)$/i.test(tag) || (tag === 'div' && node.querySelector && node.querySelector('section, header, footer, h1, .card, .hero, .avatar'))) {
        parts.push(serializeHtmlNode(node))
        markConsumed(node)
        node = node.nextSibling
        continue
      }
      break
    }
    return parts.join('')
  }

  function argsFromFieldChildren(node) {
    const args = {}
    let found = false
    Array.from((node && node.children) || []).forEach(child => {
      const tag = String(child.tagName || '').toLowerCase()
      if (!tag || isWebToolTag(tag) || isHtmlDocumentTag(tag)) return
      if (/^(div|span|p|pre|code|ul|ol|li|section|header|footer|main|article|button|a|img|table|br)$/i.test(tag)) return
      if (!/^[a-z_][a-z0-9_]*$/i.test(tag)) return
      if (tag === 'content' || tag === 'contents' || tag === 'patch') {
        args[tag] = Array.from(child.childNodes || []).map(function (item) {
          if (item.nodeType === 3) return item.textContent || ''
          if (item.nodeType === 10) return '<!DOCTYPE html>'
          if (item.nodeType === 1) return serializeHtmlNode(item)
          return ''
        }).join('')
      } else {
        args[tag] = String(child.textContent || '').trim()
      }
      found = true
      markConsumed(child)
    })
    return found ? args : null
  }

  function recoverXmlToolArgs(node) {
    const name = String(node && node.tagName || '').toLowerCase()
    const kids = Array.from((node && node.childNodes) || [])
    const hasEl = kids.some(child => child.nodeType === 1 || child.nodeType === 10)
    if (!hasEl) {
      const text = String((node && (node.textContent || '')) || '').trim()
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      } catch (_) { /* fall through */ }
      const fostered = collectFosteredHtml(node)
      if ((name === 'write_file' || name === 'edit_file') && fostered) {
        const pathMatch = text.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/) || text.match(/[A-Za-z]:[\\/][^\s"'{}]+\.\w{1,12}/)
        const path = pathMatch ? String(pathMatch[1] || pathMatch[0]).replace(/\\"/g, '"').replace(/\\/g, '/') : ''
        let content = fostered
        if (/<html[\s>]/i.test(content) && !/<!DOCTYPE/i.test(content)) content = '<!DOCTYPE html>' + content
        if (path) return { path: path, content: content }
      }
      return recoverLooseToolArgs(name, text)
    }
    const fieldArgs = argsFromFieldChildren(node)
    if (fieldArgs && (fieldArgs.action || fieldArgs.path || fieldArgs.content || fieldArgs.contents || fieldArgs.patch)) {
      return fieldArgs
    }
    let prefix = ''
    const htmlParts = []
    let suffix = ''
    let seenEl = false
    kids.forEach(child => {
      if (child.nodeType === 3) {
        if (!seenEl) prefix += child.textContent || ''
        else suffix += child.textContent || ''
        return
      }
      if (child.nodeType === 1 || child.nodeType === 10) {
        seenEl = true
        htmlParts.push(serializeHtmlNode(child))
        markConsumed(child)
      }
    })
    let html = htmlParts.join('') + collectFosteredHtml(node)
    const pathMatch = prefix.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/)
    const path = pathMatch ? pathMatch[1].replace(/\\"/g, '"') : ''
    if ((name === 'write_file' || name === 'edit_file') && html) {
      if (/<html[\s>]/i.test(html) && !/<!DOCTYPE/i.test(html)) html = '<!DOCTYPE html>' + html
      const args = { content: html }
      if (path) args.path = path
      return args
    }
    try {
      const parsed = JSON.parse((prefix + html + suffix).trim())
      if (parsed && typeof parsed === 'object') return parsed
    } catch (_) { /* fall through */ }
    if (path) return html ? { path: path, content: html } : { path: path }
    return recoverLooseToolArgs(name, prefix + suffix)
  }

  function collectPathLabeledCodeWrites(root) {
    if (!root || !root.querySelectorAll) return []
    const widgets = Array.from(root.querySelectorAll('[class*="code-block"], [class*="syntax-highlighter"], [class*="qwen-code"], [class*="highlight-container"], pre'))
    const writes = []
    const seen = new Set()
    widgets.forEach(node => {
      if (consumedNodes.has(node)) return
      const header = node.querySelector && node.querySelector('[class*="filename"], [class*="file-name"], [class*="header"], [class*="title"], [class*="path"]')
      let path = String((header && header.textContent) || (node.getAttribute && (node.getAttribute('data-path') || node.getAttribute('data-file'))) || '').replace(/^(html|htm|css|js|javascript|json)\s*/i, '').trim().replace(/\\/g, '/')
      const pre = node.querySelector && node.querySelector('pre, .cm-content, [class*="code-content"]')
      const code = (pre && pre.querySelector && pre.querySelector('code')) || (node.querySelector && node.querySelector('code')) || pre || node
      let body = stripLeadingLineNumbers(String((code && (code.innerText || code.textContent)) || ''))
      if (!looksLikeFilePathToken(path)) {
        const jammed = splitJammedFilePath(body)
        if (jammed.path) {
          path = jammed.path
          body = jammed.body
        }
      }
      if (!looksLikeFilePathToken(path) || body.trim().length < 8) return
      const key = path.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      markConsumed(node)
      writes.push({ name: 'write_file', arguments: { path: path, content: body.replace(/\s+$/g, '') } })
    })
    return writes
  }

  function collectXmlToolCalls(root) {
    if (!root) return []
    const selector = 'write_file, file_manage, file_read, file_search, apply_patch, text_edit, edit_file, json_edit, ask_user_choice, confirm_plan, complete_step, record_ai_operation_memo, project_history, shell_run'
    const nodes = []
    if (isWebToolTag(String(root.tagName || ''))) nodes.push(root)
    if (root.querySelectorAll) {
      Array.from(root.querySelectorAll(selector)).forEach(node => {
        if (!nodes.includes(node)) nodes.push(node)
      })
    }
    const calls = []
    const seen = new Set()
    nodes.forEach(node => {
      const name = String(node.tagName || '').toLowerCase()
      markConsumed(node)
      const args = recoverXmlToolArgs(node)
      if (!args) return
      const key = name + ':' + String(args.path || args.action || '')
      if (seen.has(key)) return
      seen.add(key)
      calls.push({ name: name, arguments: args })
    })
    collectPathLabeledCodeWrites(root).forEach(call => {
      const key = call.name + ':' + String(call.arguments.path || '')
      if (seen.has(key)) return
      seen.add(key)
      calls.push(call)
    })
    const jammed = String(root.innerText || '').match(/([A-Za-z]:[\\/][^\s.]+?)create_directory([A-Za-z]:[\\/])/i)
    if (jammed && !calls.some(call => call.name === 'file_manage')) {
      calls.unshift({ name: 'file_manage', arguments: { action: 'create_directory', path: jammed[1].replace(/\\/g, '/') } })
    }
    return calls
  }

  function htmlAttrText(node) {
    if (node.attributes && node.attributes.length) {
      return Array.from(node.attributes).map(attr => {
        const name = String(attr.name || '')
        const value = String(attr.value || '')
        if (!name) return ''
        return value ? ' ' + name + '="' + value.replace(/"/g, '&quot;') + '"' : ' ' + name
      }).join('')
    }
    const names = ['lang', 'charset', 'name', 'content', 'rel', 'href', 'src', 'type', 'id', 'class', 'http-equiv']
    let out = ''
    names.forEach(name => {
      const value = node.getAttribute && node.getAttribute(name)
      if (value) out += ' ' + name + '="' + String(value).replace(/"/g, '&quot;') + '"'
    })
    return out
  }

  function serializeHtmlNode(node) {
    if (!node) return ''
    if (node.nodeType === 10) return '<!DOCTYPE html>'
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    const tag = String(node.tagName || '').toLowerCase()
    const attrs = htmlAttrText(node)
    if (/^(meta|link|br|hr|img|input)$/.test(tag)) return '<' + tag + attrs + '>'
    const inner = Array.from(node.childNodes || []).map(child => {
      const childTag = String(child.tagName || '').toLowerCase()
      if (child.nodeType === 1 && (isHtmlDocumentTag(childTag) || isHtmlDocumentTag(tag))) {
        return serializeHtmlNode(child)
      }
      if (child.nodeType === 10) return '<!DOCTYPE html>'
      if (child.nodeType === 3) return child.textContent || ''
      return serializeHtmlNode(child)
    }).join('')
    return '<' + tag + attrs + '>' + inner + '</' + tag + '>'
  }

  function inlineMd(node) {
    if (!node) return ''
    if (node.nodeType === 10) return '<!DOCTYPE html>'
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    if (isThinkingNode(node)) return ''
    if (consumedNodes.has(node) || isLineNumberGutter(node)) return ''
    const tag = String(node.tagName || '').toLowerCase()
    if (isWebToolTag(tag)) return ''
    if (isHtmlDocumentTag(tag)) return serializeHtmlNode(node)
    if (tag === 'button' || /copy|clipboard/i.test(classText(node))) return ''
    const children = Array.from(node.childNodes || []).map(inlineMd).join('')
    switch (tag) {
      case 'strong':
      case 'b':
        return '**' + children + '**'
      case 'em':
      case 'i':
        return '*' + children + '*'
      case 'code':
        return '`' + children + '`'
      case 'a': {
        const href = (node.getAttribute && node.getAttribute('href')) || ''
        return href ? '[' + children + '](' + href + ')' : children
      }
      case 'br':
        return '\n'
      default:
        return children
    }
  }

  function liMd(li) {
    const nested = Array.from((li && li.children) || []).filter(child => {
      const tag = String(child.tagName || '').toLowerCase()
      return tag === 'ul' || tag === 'ol'
    })
    const p = li && li.querySelector && li.querySelector(':scope > p')
    const text = p ? inlineMd(p) : inlineMd(li)
    if (!nested.length) return text
    const nestedMd = nested.map(blockMd).join('').replace(/\s+$/, '')
    return (text.replace(/\s+$/, '') + '\n' + nestedMd.replace(/^/gm, '  ')).trim()
  }

  function cellText(node) {
    return String((node && (node.innerText || node.textContent)) || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim()
  }

  function rowCells(row) {
    if (!row) return []
    let cells = Array.from((row.querySelectorAll) ? row.querySelectorAll('th, td') : [])
    if (!cells.length) {
      cells = Array.from((row.querySelectorAll)
        ? row.querySelectorAll('[role="columnheader"], [role="cell"], [role="gridcell"]')
        : [])
    }
    if (!cells.length) {
      cells = Array.from(row.children || []).filter(child => {
        const tag = String(child.tagName || '').toLowerCase()
        return child.nodeType === 1 && tag !== 'button'
      })
    }
    return cells.map(cellText)
  }

  function tableRows(table) {
    let rows = Array.from((table && table.querySelectorAll) ? table.querySelectorAll('tr') : [])
    if (!rows.length) {
      rows = Array.from((table && table.querySelectorAll) ? table.querySelectorAll('[role="row"]') : [])
    }
    if (!rows.length) {
      const expanded = []
      Array.from((table && table.children) || []).forEach(child => {
        const tag = String(child.tagName || '').toLowerCase()
        if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
          expanded.push(...Array.from(child.children || []))
        } else {
          expanded.push(child)
        }
      })
      rows = expanded.filter(child => child && child.nodeType === 1)
    }
    return rows
  }

  function tableMd(table) {
    const grid = tableRows(table).map(rowCells).filter(row => row.length && row.some(Boolean))
    if (!grid.length) return ''
    const width = Math.max(...grid.map(row => row.length))
    if (width < 2) return ''
    const normalized = grid.map(row => {
      const next = row.slice()
      while (next.length < width) next.push('')
      return next.slice(0, width)
    })
    const header = normalized[0]
    const body = normalized.slice(1)
    const out = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |']
    body.forEach(row => out.push('| ' + row.join(' | ') + ' |'))
    return out.join('\n') + '\n\n'
  }

  function blockMd(node) {
    if (!node) return ''
    if (node.nodeType === 10) return '<!DOCTYPE html>'
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    if (isThinkingNode(node)) return ''
    if (consumedNodes.has(node) || isLineNumberGutter(node)) return ''
    const tag = String(node.tagName || '').toLowerCase()
    if (isWebToolTag(tag)) return ''
    if (isHtmlDocumentTag(tag)) return serializeHtmlNode(node)
    const cls = classText(node)
    if (tag === 'button' || (/copy|clipboard/i.test(cls) && tag !== 'table' && !isTableLike(node))) return ''
    if (isTableLike(node)) {
      const md = tableMd(node)
      if (md) return md
    }
    switch (tag) {
      case 'br':
        return '\n'
      case 'h1':
        return '# ' + inlineMd(node).trim() + '\n\n'
      case 'h2':
        return '## ' + inlineMd(node).trim() + '\n\n'
      case 'h3':
        return '### ' + inlineMd(node).trim() + '\n\n'
      case 'h4':
      case 'h5':
      case 'h6':
        return '#### ' + inlineMd(node).trim() + '\n\n'
      case 'p':
        return inlineMd(node).replace(/\s+$/, '') + '\n\n'
      case 'pre': {
        const nestedMd = nestedTableMd(node)
        if (nestedMd) return nestedMd
        const codeEl = node.querySelector && node.querySelector('code')
        const codeText = stripLeadingLineNumbers(codeEl
          ? (codeEl.innerText || codeEl.textContent || '')
          : (node.innerText || node.textContent || ''))
        const langMatch = codeEl && codeEl.className ? String(codeEl.className).match(/language-([\w+-]+)/) : null
        const lang = langMatch ? langMatch[1] : ''
        return fenceToMd(codeText, lang)
      }
      case 'ul': {
        const items = Array.from(node.children || []).filter(c => String(c.tagName || '').toLowerCase() === 'li').map(liMd)
        return items.length ? items.map(i => '- ' + String(i).trim()).join('\n') + '\n\n' : ''
      }
      case 'ol': {
        const items = Array.from(node.children || []).filter(c => String(c.tagName || '').toLowerCase() === 'li').map(liMd)
        return items.length ? items.map((i, idx) => (idx + 1) + '. ' + String(i).trim()).join('\n') + '\n\n' : ''
      }
      case 'blockquote':
        return '> ' + inlineMd(node).replace(/\n/g, '\n> ') + '\n\n'
      case 'hr':
        return '---\n\n'
      case 'table':
        return tableMd(node)
      default: {
        if (/md-code-block|markdown-code-block|code-block|syntax-highlighter|qwen-code|highlight-container/i.test(cls)) {
          const nestedMd = nestedTableMd(node)
          if (nestedMd) return nestedMd
          const codeEl = node.querySelector && node.querySelector('code')
          const codeText = stripLeadingLineNumbers(codeEl
            ? (codeEl.innerText || codeEl.textContent || '')
            : (node.innerText || node.textContent || ''))
          const langMatch = codeEl && codeEl.className ? String(codeEl.className).match(/language-([\w+-]+)/) : null
          const lang = langMatch ? langMatch[1] : ''
          return fenceToMd(codeText, lang)
        }
        if (hasBlockChild(node)) {
          return Array.from(node.childNodes || []).map(blockMd).join('')
        }
        return inlineMd(node)
      }
    }
  }

  function renderRoot(node) {
    if (isTableLike(node)) {
      const md = tableMd(node)
      if (md) return md
    }
    return Array.from(node.childNodes || []).map(blockMd).join('')
  }

  function nodeDocumentIndex(root, target) {
    let index = 0
    let found = -1
    function walk(node) {
      if (!node || found >= 0) return
      if (node === target) {
        found = index
        return
      }
      index += 1
      const kids = Array.from(node.childNodes || [])
      for (let i = 0; i < kids.length; i += 1) walk(kids[i])
    }
    walk(root)
    return found < 0 ? 999999 : found
  }

  if (!latest) return ''
  const tableSelector = 'table, [role="table"], [role="grid"], [class*="markdown-table"], [class*="md-table"], [class*="ds-table"], [class*="table-wrapper"], [class*="table-container"]'
  const mdFound = markdownSelectors.length && latest.querySelectorAll
    ? Array.from(latest.querySelectorAll(markdownSelectors.join(', '))).filter(node => !isThinkingNode(node))
    : []
  const mdRoots = mdFound.filter(node => !mdFound.some(other => other !== node && other.contains && other.contains(node)))
  const tableFound = latest.querySelectorAll
    ? Array.from(latest.querySelectorAll(tableSelector)).filter(node => !isThinkingNode(node) && isTableLike(node))
    : []
  const orphanTables = tableFound.filter(table => !mdRoots.some(root => root.contains && root.contains(table)))
  const roots = mdRoots.length
    ? mdRoots.concat(orphanTables).sort((a, b) => nodeDocumentIndex(latest, a) - nodeDocumentIndex(latest, b))
    : []
  const xmlCalls = collectXmlToolCalls(latest)
  const source = roots.length
    ? roots.map(node => (isTableLike(node) ? (tableMd(node) || renderRoot(node)) : renderRoot(node))).join('\n')
    : renderRoot(latest)
  const protocol = xmlCalls.length
    ? '<LINGXI_TOOL_CALLS>' + JSON.stringify({ calls: xmlCalls }) + '</LINGXI_TOOL_CALLS>\n\n'
    : ''
  return (protocol + String(source || ''))
    .replace(/```([^\n]*)\n([\s\S]*?)```/g, function (full, info, body) {
      const lang = String(info || '').trim()
      const converted = fenceToMd(body, lang)
      return converted.indexOf('```') === 0 ? full : converted.trim()
    })
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/^[ \t]*(?:Copy code|复制代码|Copy|复制)\s*$/gim, '')
    .replace(/^[ \t]*(?:json|javascript|js|ts|typescript|xml|html|text)\s*$/gim, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const extractWebAssistantState = new Function('config', `
  const markdownFromDomNode = ${markdownFromDomNode.toString()};
  const cfg = config || {};
  const replySelectors = Array.isArray(cfg.replySelectors) ? cfg.replySelectors : [];
  const markdownSelectors = Array.isArray(cfg.markdownSelectors) ? cfg.markdownSelectors : [];
  const stopSelectors = Array.isArray(cfg.stopSelectors) ? cfg.stopSelectors : [];
  const stopLabelPattern = cfg.stopLabelPattern ? new RegExp(cfg.stopLabelPattern, 'i') : null;

  const excludeRe = cfg.excludeTextPattern ? new RegExp(cfg.excludeTextPattern, 'i') : null;
  function isExcluded(node) {
    if (!excludeRe || !node) return false;
    return excludeRe.test(String(node.innerText || node.textContent || ''));
  }
  const replies = replySelectors.reduce((acc, selector) => {
    if (acc.length) return acc;
    return Array.from(document.querySelectorAll(selector) || []).filter(node => !isExcluded(node));
  }, []);
  const latest = replies[replies.length - 1] || null;

  function isGenerating() {
    if (stopSelectors.some(selector => {
      const node = document.querySelector(selector);
      return !!node && node.getClientRects().length > 0;
    })) return true;
    if (stopLabelPattern) {
      const labeled = Array.from(document.querySelectorAll(
        'button[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="停止"], [role="button"][aria-label*="Stop"], [role="button"][aria-label*="停止"]'
      )).some(node => {
        if (!node.getClientRects().length) return false;
        const label = [
          node.getAttribute('aria-label') || '',
          node.getAttribute('title') || '',
          node.getAttribute('data-testid') || ''
        ].join(' ');
        return stopLabelPattern.test(label);
      });
      if (labeled) return true;
    }
    if (cfg.detectComposer) {
      const composer = document.querySelector('textarea, [contenteditable="true"]');
      if (composer && (composer.disabled || composer.getAttribute('aria-disabled') === 'true')) return true;
    }
    return false;
  }

  function composerReady() {
    if (!cfg.detectComposer) return false;
    const composer = document.querySelector('textarea, [contenteditable="true"]');
    if (!composer || !composer.getClientRects().length) return false;
    if (composer.disabled || composer.getAttribute('aria-disabled') === 'true') return false;
    return !isGenerating();
  }

  const alerts = cfg.detectAlerts
    ? Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"]'))
      .map(node => String(node.innerText || '')).filter(Boolean).join(' ').slice(0, 500)
    : '';

  const markdown = markdownFromDomNode(latest, {
    skipThinking: cfg.skipThinking !== false,
    markdownSelectors
  });
  const innerText = String((latest && (latest.innerText || latest.textContent)) || '').trim();
  return {
    count: replies.length,
    markdown: markdown || innerText,
    innerText,
    generating: isGenerating(),
    composerReady: composerReady(),
    alerts
  };
`)

module.exports = {
  markdownFromDomNode,
  extractWebAssistantState
}
