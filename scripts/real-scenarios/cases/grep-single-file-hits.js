const path = require('path')

module.exports = {
  id: 'grep.single-file-hits',
  title: 'Single-file grep keeps real content hits instead of reporting 0 matches',
  tags: ['tools', 'grep', 'ripgrep', 'search'],
  changedFilePatterns: [
    /^electron\/modules\/fast-search\.js$/i,
    /^electron\/modules\/tool-handlers\/search\.js$/i
  ],

  async run(ctx) {
    const fastSearch = require(path.join(ctx.root, 'electron/modules/fast-search'))
    const { handlers } = require(path.join(ctx.root, 'electron/modules/tool-handlers/search'))
    const workspace = ctx.createWorkspace(this.id)

    try {
      const relativeFile = 'src/server/request-log.ts'
      const filePath = path.join(workspace.projectPath, relativeFile)
      ctx.writeText(filePath, [
        'export type RequestLog = {',
        '  apiKeyId?: string',
        '}',
        'export function writeLog(entry: RequestLog) {',
        '  return entry.apiKeyId ? { apiKeyId: entry.apiKeyId } : {}',
        '}',
        ''
      ].join('\n'))

      const parsedNamed = fastSearch.parseContentMatches(
        'src/server/request-log.ts:2:  apiKeyId?: string\n',
        { projectPath: workspace.projectPath }
      )
      ctx.assert.equal(parsedNamed.length, 1, 'directory-style rg lines should parse')
      ctx.assert.equal(parsedNamed[0].line, 2)
      ctx.assert.ok(parsedNamed[0].content.includes('apiKeyId'))

      const parsedSingle = fastSearch.parseContentMatches(
        '2:  apiKeyId?: string\n5:  return entry.apiKeyId ? { apiKeyId: entry.apiKeyId } : {}\n',
        { projectPath: workspace.projectPath, defaultPath: filePath }
      )
      ctx.assert.equal(parsedSingle.length, 2, 'single-file rg lines without a path prefix should still count')
      ctx.assert.equal(parsedSingle[0].path.replace(/\\/g, '/').endsWith(relativeFile), true)

      const parsedWindows = fastSearch.parseContentMatches(
        'E:\\代理opencodex\\opencodex-main\\src\\server\\request-log.ts:2:  apiKeyId?: string\n',
        { projectPath: 'E:\\代理opencodex\\opencodex-main' }
      )
      ctx.assert.equal(parsedWindows.length, 1, 'Windows drive-letter rg lines should parse')
      ctx.assert.equal(parsedWindows[0].path, 'src/server/request-log.ts')

      const dropped = fastSearch.parseContentMatches('2:  apiKeyId?: string\n', {
        projectPath: workspace.projectPath,
        defaultPath: path.join(workspace.projectPath, 'src', 'server')
      })
      ctx.assert.equal(dropped.length, 0, 'line:content fallback should not invent hits for a directory defaultPath')

      const resolvePath = item => path.isAbsolute(item)
        ? path.resolve(item)
        : path.resolve(workspace.projectPath, item || '')
      const result = await handlers.grep_code({
        pattern: 'apiKeyId',
        path: relativeFile,
        max_results: 10
      }, {
        projectPath: workspace.projectPath,
        resolvePath
      })

      ctx.assert.equal(result.success, true, result.error || 'single-file grep should succeed')
      ctx.assert.ok((result.matches || []).length >= 2, `expected content hits, got ${JSON.stringify(result.matches)}`)
      ctx.assert.ok(result.matches.some(item => Number(item.line) === 2 && String(item.content).includes('apiKeyId')))
      ctx.assert.equal(result.engine === 'js-fallback-limited', false, 'single-file hits should come from ripgrep, not JS fallback')
      ctx.assert.equal(Number(result.follow_up_total || 0), 0, 'real hits must not trigger zero-hit parent enrichment')
    } finally {
      workspace.cleanup()
    }
  }
}
