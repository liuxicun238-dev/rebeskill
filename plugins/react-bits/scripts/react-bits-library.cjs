#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const PLUGIN_ROOT = path.resolve(__dirname, '..')
const LIBRARY_ROOT = path.join(PLUGIN_ROOT, 'library')
const LICENSE_PATH = path.join(PLUGIN_ROOT, 'LICENSES', 'REACT-BITS-LICENSE.md')

const VARIANTS = {
  'js-css': { root: 'content', extensions: ['.jsx', '.js', '.css'] },
  'js-tailwind': { root: 'tailwind', extensions: ['.jsx', '.js'] },
  'ts-css': { root: 'ts-default', extensions: ['.tsx', '.ts', '.css'] },
  'ts-tailwind': { root: 'ts-tailwind', extensions: ['.tsx', '.ts'] }
}

function fail(message, details = {}) {
  const error = new Error(message)
  error.details = details
  throw error
}

function parseArgs(argv) {
  const result = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) {
      result._.push(value)
      continue
    }
    const key = value.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) result[key] = true
    else {
      result[key] = next
      index += 1
    }
  }
  return result
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

function directorySize(root) {
  let bytes = 0
  let files = 0
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile()) {
        files += 1
        bytes += fs.statSync(fullPath).size
      }
    }
  }
  if (isDirectory(root)) walk(root)
  return { files, bytes }
}

function listFiles(root) {
  if (!isDirectory(root)) return []
  const files = []
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) walk(fullPath)
      else if (entry.isFile()) files.push(fullPath)
    }
  }
  walk(root)
  return files
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) copyDirectory(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

function scanCatalog() {
  if (!isDirectory(LIBRARY_ROOT)) {
    fail('React Bits 离线组件库缺失，请重新安装插件。', { libraryRoot: LIBRARY_ROOT })
  }
  const base = path.join(LIBRARY_ROOT, 'content')
  if (!isDirectory(base)) fail('React Bits 组件索引目录损坏。', { base })
  const components = []
  for (const categoryEntry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!categoryEntry.isDirectory()) continue
    const category = categoryEntry.name
    const categoryPath = path.join(base, category)
    for (const componentEntry of fs.readdirSync(categoryPath, { withFileTypes: true })) {
      if (!componentEntry.isDirectory()) continue
      const name = componentEntry.name
      const variants = Object.entries(VARIANTS)
        .filter(([, config]) => isDirectory(path.join(LIBRARY_ROOT, config.root, category, name)))
        .map(([variant]) => variant)
      components.push({ name, category, variants })
    }
  }
  return components.sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

function findComponent(name, catalog) {
  const needle = String(name || '').trim().toLowerCase()
  if (!needle) fail('缺少组件名称。')
  const exact = catalog.find(item => item.name.toLowerCase() === needle)
  if (exact) return exact
  const candidates = catalog.filter(item => item.name.toLowerCase().includes(needle)).slice(0, 12)
  fail(`未找到组件：${name}`, { candidates })
}

function resolveVariant(component, requested) {
  const variant = String(requested || 'js-css').toLowerCase()
  if (!VARIANTS[variant]) fail(`不支持的变体：${variant}`, { supported: Object.keys(VARIANTS) })
  if (!component.variants.includes(variant)) {
    fail(`${component.name} 不包含 ${variant} 变体。`, { available: component.variants })
  }
  return variant
}

function componentDirectory(component, variant) {
  return path.join(LIBRARY_ROOT, VARIANTS[variant].root, component.category, component.name)
}

function packageName(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return ''
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function analyzeDependencies(files) {
  const packages = new Set()
  const importPattern = /(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g
  for (const file of files) {
    if (!/\.(?:jsx?|tsx?)$/i.test(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    let match
    while ((match = importPattern.exec(text))) {
      const name = packageName(match[1])
      if (name) packages.add(name)
    }
  }
  const peers = ['react', 'react-dom'].filter(name => packages.has(name))
  peers.forEach(name => packages.delete(name))
  return { dependencies: [...packages].sort(), peerDependencies: peers.sort() }
}

function inspectComponent(component, variant) {
  const sourceDir = componentDirectory(component, variant)
  const files = listFiles(sourceDir)
  const dependencyInfo = analyzeDependencies(files)
  return {
    ...component,
    variant,
    sourceDir,
    files: files.map(file => path.relative(sourceDir, file).replaceAll('\\', '/')),
    ...dependencyInfo
  }
}

function ensureInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function copyComponent(component, variant, args) {
  if (!args.project || args.project === true) fail('copy 命令需要 --project <项目绝对路径>。')
  const projectRoot = path.resolve(String(args.project))
  if (!isDirectory(projectRoot)) fail('项目目录不存在。', { projectRoot })
  const targetBase = path.resolve(projectRoot, String(args.target || 'src/components/react-bits'))
  if (!ensureInside(projectRoot, targetBase)) fail('目标目录必须位于项目内部。', { targetBase })
  const targetDir = path.join(targetBase, component.name)
  if (!ensureInside(projectRoot, targetDir)) fail('组件目标路径越出项目范围。', { targetDir })
  if (fs.existsSync(targetDir)) {
    if (!args.force) fail('目标组件已经存在；确认覆盖时请添加 --force。', { targetDir })
    fs.rmSync(targetDir, { recursive: true, force: true })
  }
  const inspected = inspectComponent(component, variant)
  fs.mkdirSync(targetBase, { recursive: true })
  copyDirectory(inspected.sourceDir, targetDir)
  if (isFile(LICENSE_PATH)) {
    fs.copyFileSync(LICENSE_PATH, path.join(targetDir, 'LICENSE.react-bits.md'))
  }
  const notice = [
    '# React Bits component notice',
    '',
    `Component: ${component.name}`,
    `Category: ${component.category}`,
    `Variant: ${variant}`,
    'Source: https://github.com/DavidHDev/react-bits',
    'License: see LICENSE.react-bits.md',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(targetDir, 'THIRD_PARTY.md'), notice, 'utf8')
  return {
    success: true,
    component: component.name,
    category: component.category,
    variant,
    targetDir,
    files: listFiles(targetDir).map(file => path.relative(projectRoot, file).replaceAll('\\', '/')),
    dependencies: inspected.dependencies,
    peerDependencies: inspected.peerDependencies,
    installCommand: inspected.dependencies.length ? `npm install ${inspected.dependencies.join(' ')}` : ''
  }
}

function output(value, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  if (typeof value === 'string') process.stdout.write(`${value}\n`)
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] || 'status'
  const catalog = scanCatalog()
  if (command === 'status') {
    const size = directorySize(LIBRARY_ROOT)
    output({
      available: true,
      offline: true,
      thirdParty: true,
      source: 'https://github.com/DavidHDev/react-bits',
      libraryRoot: LIBRARY_ROOT,
      componentCount: catalog.length,
      variants: Object.keys(VARIANTS),
      files: size.files,
      bytes: size.bytes,
      sizeMB: Number((size.bytes / 1024 / 1024).toFixed(2)),
      license: 'MIT WITH Commons-Clause'
    }, args.json)
    return
  }
  if (command === 'search') {
    const query = String(args._.slice(1).join(' ') || args.query || '').trim().toLowerCase()
    const results = query
      ? catalog.filter(item => `${item.name} ${item.category}`.toLowerCase().includes(query))
      : catalog
    output({ query, count: results.length, results }, args.json)
    return
  }
  if (command === 'inspect') {
    const component = findComponent(args._[1] || args.component, catalog)
    const variant = resolveVariant(component, args.variant)
    output(inspectComponent(component, variant), args.json)
    return
  }
  if (command === 'copy') {
    const component = findComponent(args._[1] || args.component, catalog)
    const variant = resolveVariant(component, args.variant)
    output(copyComponent(component, variant, args), args.json)
    return
  }
  fail(`未知命令：${command}`, { supported: ['status', 'search', 'inspect', 'copy'] })
}

try {
  main()
} catch (error) {
  const payload = { success: false, error: error.message, ...(error.details || {}) }
  if (process.argv.includes('--json')) process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
  else process.stderr.write(`React Bits: ${error.message}\n`)
  process.exitCode = 1
}
