const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const {
  normalizeComparablePath,
  getPathTokens,
  isInsideProject,
  toProjectRelative,
  collectProjectPathCandidates,
  scorePathCandidate
} = require('../../electron/modules/path-utils')

test('normalizeComparablePath：反斜杠归一、去前导 ./、转小写', () => {
  assert.equal(normalizeComparablePath('A\\B\\C.js'), 'a/b/c.js')
  assert.equal(normalizeComparablePath('./Src/App.vue'), 'src/app.vue')
  assert.equal(normalizeComparablePath(''), '')
})

test('getPathTokens：拆 token、过滤通用目录名、限 12 个', () => {
  assert.deepEqual(getPathTokens('src/components/UserProfile.vue'), ['components', 'userprofile', 'vue'])
  assert.deepEqual(getPathTokens('src/index.js'), ['js'], 'src/index 被过滤，但扩展名 js 会保留为 token')
  assert.ok(getPathTokens('a/b/c/d/e/f/g/h/i/j/k/l/m/n').length <= 12)
})

test('isInsideProject：项目内为真，逃逸为假', () => {
  const project = path.join(os.tmpdir(), 'lingxi-path-utils-fixture')
  assert.equal(isInsideProject(project, path.join(project, 'src', 'a.js')), true)
  assert.equal(isInsideProject(project, project), true, '项目根本身算内部')
  assert.equal(isInsideProject(project, path.join(project, '..', 'outside.js')), false)
  assert.equal(isInsideProject('', path.join(project, 'a.js')), false, '空项目路径返回 false')
  assert.equal(isInsideProject(project, ''), false, '空目标路径返回 false')
})

test('toProjectRelative：项目内转为相对路径，外部保持原样', () => {
  const project = path.join(os.tmpdir(), 'lingxi-path-utils-rel')
  assert.equal(toProjectRelative(project, path.join(project, 'src', 'a.js')), 'src/a.js')
  assert.equal(toProjectRelative(project, 'D:\\elsewhere\\x.js').includes(':'), true, '外部路径不转换')
})

test('collectProjectPathCandidates：跳过 node_modules 与 .git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-candidates-'))
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'x')
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'hidden.js'), 'x')
    fs.writeFileSync(path.join(root, '.git', 'config'), 'x')

    const files = collectProjectPathCandidates(root, 'file')
    assert.ok(files.some(f => f.endsWith('app.js')), '应包含 src/app.js')
    assert.ok(!files.some(f => f.includes('node_modules')), '不应包含 node_modules')
    assert.ok(!files.some(f => f.includes('.git')), '不应包含 .git')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('scorePathCandidate：精确匹配得分高于后缀匹配高于包含匹配', () => {
  const project = path.join(os.tmpdir(), 'lingxi-score-fixture')
  const exact = scorePathCandidate(path.join(project, 'src', 'app.vue'), 'src/app.vue', project)
  const suffix = scorePathCandidate(path.join(project, 'deep', 'src', 'app.vue'), 'src/app.vue', project)
  const contains = scorePathCandidate(path.join(project, 'xsrc', 'app.vue'), 'src/app.vue', project)
  assert.ok(exact.score > suffix.score, `exact(${exact.score}) 应高于 suffix(${suffix.score})`)
  assert.ok(suffix.score > contains.score, `suffix(${suffix.score}) 应高于 contains(${contains.score})`)
  assert.ok(exact.reasons.includes('exact_relative_path'))
  assert.ok(suffix.reasons.includes('relative_path_suffix'))
})

test('scorePathCandidate：同名 basename 与相同扩展名加分', () => {
  const project = os.tmpdir()
  const result = scorePathCandidate(path.join(project, 'p', 'readme.md'), 'docs/readme.md', project)
  assert.ok(result.reasons.includes('same_basename'))
  assert.ok(result.reasons.includes('same_extension'))
})

test('scorePathCandidate：codemap 来源带初始加分与标记', () => {
  const project = os.tmpdir()
  const scanned = scorePathCandidate(path.join(project, 'a.js'), 'a.js', project, 'scan')
  const codemap = scorePathCandidate(path.join(project, 'a.js'), 'a.js', project, 'codemap')
  assert.equal(codemap.score, scanned.score + 12)
  assert.ok(codemap.reasons.includes('codemap_history'))
})
