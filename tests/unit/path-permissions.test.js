const { test, beforeEach } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// path-permissions 通过 storageConfig.getConfigDir() 动态取存储目录，
// 测试里把配置目录指到临时目录，避免污染真实用户数据
const storageConfig = require('../../electron/modules/storage-config')
const permissions = require('../../electron/modules/path-permissions')

let tmpDir
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-perm-'))
  storageConfig.getConfigDir = () => tmpDir
})

test('isPathInside：基础包含关系与边界', () => {
  assert.equal(permissions.isPathInside('C:\\proj', 'C:\\proj\\src\\a.js'), true)
  assert.equal(permissions.isPathInside('C:\\proj', 'C:\\proj'), true, '自身算内部')
  assert.equal(permissions.isPathInside('C:\\proj', 'C:\\other\\a.js'), false)
  assert.equal(permissions.isPathInside('C:\\proj', 'C:\\project\\a.js'), false, '前缀相同但不是同目录')
  assert.equal(permissions.isPathInside('', 'C:\\x'), false)
  assert.equal(permissions.isPathInside('C:\\proj', ''), false)
})

test('normalizeMode：非法模式归一为 ask，critical/auto 也归为 ask', () => {
  assert.equal(permissions.getMode('p'), 'ask', '默认模式为 ask')
})

test('findAllowedRule：full 模式直接放行', () => {
  permissions.setMode('full', 'proj-full')
  const rule = permissions.findAllowedRule('proj-full', 'write_file', 'C:\\anywhere\\x.js')
  assert.equal(rule.allowed, true)
  assert.equal(rule.mode, 'full')
  permissions.setMode('ask', 'proj-full')
})

test('findAllowedRule：无规则时返回 null', () => {
  assert.equal(permissions.findAllowedRule('proj-none', 'read_file', 'C:\\none\\x.js'), null)
})

test('rememberAllowed + findAllowedRule：目录级授权覆盖目录内文件', () => {
  // rememberAllowed 以 target 的父目录作为授权目录（target 带扩展名时取 dirname）
  const srcDir = path.join(tmpDir, 'workspace', 'src')
  fs.mkdirSync(srcDir, { recursive: true })
  permissions.rememberAllowed('proj-a', 'write_file', path.join(srcDir, 'app.js'), { scope: 'directory' })

  assert.ok(permissions.findAllowedRule('proj-a', 'write_file', path.join(srcDir, 'app.js')), '目录内文件应命中')
  assert.ok(permissions.findAllowedRule('proj-a', 'write_file', path.join(srcDir, 'other.js')), '同目录其他文件也应命中')
  assert.equal(
    permissions.findAllowedRule('proj-a', 'write_file', path.join(tmpDir, 'workspace', 'readme.md')),
    null,
    '授权目录之外的文件不命中'
  )
  assert.equal(permissions.findAllowedRule('proj-a', 'read_file', path.join(srcDir, 'app.js')), null, '其他操作不命中')
  assert.equal(permissions.findAllowedRule('proj-b', 'write_file', path.join(srcDir, 'app.js')), null, '其他项目不命中')
})

test('rememberAllowed + findAllowedRule：path 级授权精确到文件', () => {
  const file = path.join(tmpDir, 'exact.txt')
  fs.writeFileSync(file, 'x')
  permissions.rememberAllowed('proj-b', 'read_file', file, { scope: 'path' })

  assert.ok(permissions.findAllowedRule('proj-b', 'read_file', file), '精确文件应命中')
  assert.equal(permissions.findAllowedRule('proj-b', 'read_file', file + '.bak'), null, '相邻文件不应命中')
})

test('通配操作规则：operation=* 匹配所有操作', () => {
  const dir = path.join(tmpDir, 'wildcard')
  fs.mkdirSync(dir, { recursive: true })
  permissions.addManualRule({ projectId: 'proj-w', path: dir, operation: '*' })

  assert.ok(permissions.findAllowedRule('proj-w', 'write_file', path.join(dir, 'a.txt')), '* 应放行 write_file')
  assert.ok(permissions.findAllowedRule('proj-w', 'delete_file', path.join(dir, 'a.txt')), '* 应放行 delete_file')
})

test('规则上限 500 条且新规则排在最前', () => {
  for (let i = 0; i < 505; i++) {
    const f = path.join(tmpDir, `bulk-${i}.txt`)
    permissions.rememberAllowed('proj-bulk', 'read_file', f, { scope: 'path' })
  }
  const rules = permissions.listRules().rules
  assert.ok(rules.length <= 500, `规则数应不超过 500，实际 ${rules.length}`)
})

test('removeRule 删除指定规则', () => {
  const file = path.join(tmpDir, 'removable.txt')
  fs.writeFileSync(file, 'x')
  const rule = permissions.rememberAllowed('proj-r', 'read_file', file, { scope: 'path' })
  assert.ok(permissions.findAllowedRule('proj-r', 'read_file', file))

  const result = permissions.removeRule(rule.key)
  assert.equal(result.success, true)
  assert.equal(result.removed, 1)
  assert.equal(permissions.findAllowedRule('proj-r', 'read_file', file), null)
})

test('addManualRule 缺少 path 时返回错误', () => {
  const result = permissions.addManualRule({})
  assert.equal(result.success, false)
  assert.match(result.error, /path is required/)
})

test('isInsideProject：无项目路径时默认放行', () => {
  assert.equal(permissions.isInsideProject('', 'C:\\anything'), true)
  assert.equal(permissions.isInsideProject('C:\\proj', 'C:\\proj\\a.js'), true)
})
