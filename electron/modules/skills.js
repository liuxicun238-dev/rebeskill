/**
 * 技能系统模块
 * 负责技能加载、解析、启用/禁用
 */

const fs = require('fs')
const path = require('path')
const { dialog } = require('electron')
const config = require('./config')
const projectSkillDrafts = require('./project-skill-drafts')
const plugins = require('./plugins')

/**
 * 解析 SKILL.md 文件
 */
function parseSkillFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const skill = { path: filePath }

    // 解析 frontmatter（支持 value 中含冒号、引号）
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (frontmatterMatch) {
      const lines = frontmatterMatch[1].split(/\r?\n/)
      for (const line of lines) {
        if (!line.trim() || line.trim().startsWith('#')) continue
        const colonIdx = line.indexOf(':')
        if (colonIdx <= 0) continue
        const key = line.slice(0, colonIdx).trim()
        let value = line.slice(colonIdx + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        if (key) skill[key] = value
      }
    }

    // 获取技能内容（去掉 frontmatter 后的部分）
    const contentMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)/)
    if (contentMatch) {
      skill.content = contentMatch[1].trim()
    } else {
      skill.content = content
    }

    // 确保 name 存在
    if (!skill.name) {
      const folderName = path.basename(path.dirname(filePath))
      skill.name = folderName
    }

    return skill
  } catch (e) {
    console.error('[Skills] 解析技能文件失败:', filePath, e.message)
    return null
  }
}

/**
 * 加载内置技能
 */
function loadBuiltinSkills() {
  // 修复路径：__dirname 是 electron/modules/，需要向上两级才能到达项目根目录的 skills/
  const builtinDir = path.join(__dirname, '../../skills')
  const skills = []

  try {
    if (!fs.existsSync(builtinDir)) return skills

    const folders = fs.readdirSync(builtinDir, { withFileTypes: true })
    for (const folder of folders) {
      if (folder.isDirectory()) {
        const skillPath = path.join(builtinDir, folder.name, 'SKILL.md')
        if (fs.existsSync(skillPath)) {
          const skill = parseSkillFile(skillPath)
          if (skill) {
            skill.builtin = true  // 标记为内置技能
            skills.push(skill)
          }
        }
      }
    }
  } catch (e) {
    console.error('[Skills] 加载内置技能失败:', e.message)
  }

  return skills
}

/**
 * 加载用户自定义技能
 */
function loadUserSkills() {
  const skillsDir = config.getSkillsDir()
  const skills = []

  try {
    if (!skillsDir || !fs.existsSync(skillsDir)) return skills

    const folders = fs.readdirSync(skillsDir, { withFileTypes: true })
    for (const folder of folders) {
      if (folder.isDirectory()) {
        const skillPath = path.join(skillsDir, folder.name, 'SKILL.md')
        if (fs.existsSync(skillPath)) {
          const skill = parseSkillFile(skillPath)
          if (skill) {
            skill.builtin = false  // 标记为用户自定义
            skills.push(skill)
          }
        }
      }
    }
  } catch (e) {
    console.error('[Skills] 加载用户技能失败:', e.message)
  }

  return skills
}

/**
 * 加载所有技能
 */
function loadProjectSkills(projectPath = '') {
  try {
    if (!projectPath) return []
    return projectSkillDrafts.listProjectSkills(projectPath)
  } catch (e) {
    console.error('[Skills] load project skills failed:', e.message)
    return []
  }
}

function loadAllSkills(projectPath = '') {
  const builtin = loadBuiltinSkills()
  const user = loadUserSkills()
  const project = loadProjectSkills(projectPath)
  let pluginSkills = []
  try {
    pluginSkills = plugins.loadInstalledPluginSkills()
  } catch (e) {
    console.warn('[Skills] load plugin skills failed:', e.message)
  }
  const allSkills = [...builtin, ...user, ...project, ...pluginSkills]
  config.setAllSkills(allSkills)
  console.log('[Skills] loaded skills:', allSkills.length, '(plugins:', pluginSkills.length + ')')
  return allSkills
}

const SKILL_CATALOG_MAX_ENTRIES = 24
const SKILL_CATALOG_DESC_MAX = 220
const WEBSITE_DELIVERY_INTENT_RE = /(落地页|官网|建站|门户|主页|网站首页|做一个网站|做个网站|站点交付|landing\s*page|homepage|build\s+(a\s+)?(site|website)|portfolio\s+site)/i

function capSkillDescription(value = '', max = SKILL_CATALOG_DESC_MAX) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(3, max - 1))}…`
}

function listKnownSkills(projectPath = '') {
  let all = []
  try {
    all = projectPath ? loadAllSkills(projectPath) : (config.getAllSkills?.() || [])
  } catch (_) {
    all = []
  }
  if (!all.length) {
    try {
      all = loadBuiltinSkills().concat(loadUserSkills()).concat(loadProjectSkills(projectPath))
    } catch (_) {
      all = []
    }
  }
  return Array.isArray(all) ? all : []
}

function readBuiltinSkillFile(name = '') {
  const skillName = String(name || '').trim()
  if (!skillName) return null
  try {
    const skillPath = path.join(__dirname, '../../skills', skillName, 'SKILL.md')
    return fs.existsSync(skillPath) ? parseSkillFile(skillPath) : null
  } catch (_) {
    return null
  }
}

function findSkillByName(name = '', projectPath = '') {
  const needle = String(name || '').trim().toLowerCase()
  if (!needle) return null
  const known = listKnownSkills(projectPath)
  const hit = known.find(skill => String(skill?.name || '').trim().toLowerCase() === needle)
  if (hit?.content) return hit
  const fromDisk = readBuiltinSkillFile(needle)
  if (fromDisk) return fromDisk
  return hit || null
}

function parseSelectedSkillName(skillContent = '') {
  const text = String(skillContent || '').trim()
  if (!text) return ''
  const header = text.match(/当前选用技能：.*?（([^）]+)）/)
  if (header) return String(header[1] || '').trim()
  const tagged = text.match(/SELECTED_SKILL:([\w.-]+)/i)
  if (tagged) return String(tagged[1] || '').trim()
  if (/^[\w.-]{1,80}$/.test(text)) return text
  return ''
}

function isSkillDynamicCatalogEnabled() {
  try {
    return require('./feature-settings').isFeatureEnabled?.('skill_dynamic_catalog') === true
  } catch (_) {
    return false
  }
}

function detectAutoRelevantSkillNames(userMessage = '') {
  const names = []
  if (!isSkillDynamicCatalogEnabled()) return names
  let featureSettings = null
  try {
    featureSettings = require('./feature-settings')
  } catch (_) {
    return names
  }
  if (featureSettings.isFeatureEnabled?.('inline_visualize')) names.push('inline-visual')
  if (featureSettings.isFeatureEnabled?.('website_delivery') && WEBSITE_DELIVERY_INTENT_RE.test(String(userMessage || ''))) {
    names.push('website-delivery')
  }
  return names
}

function skillSourceLabel(skill = {}) {
  if (skill.projectSkill) return 'project'
  if (skill.pluginId || skill.kind === 'plugin') return 'plugin'
  if (skill.builtin) return 'builtin'
  return 'user'
}

function loadSkillBody(name = '', projectPath = '', options = {}) {
  const requested = String(name || '').trim()
  if (!requested) {
    return {
      success: false,
      error_type: 'missing_skill_name',
      error: 'load_skill 需要 name，且必须与技能目录中的名称完全一致。'
    }
  }
  if (!isSkillDynamicCatalogEnabled()) {
    const selected = String(options.selectedName || '').trim()
    if (!selected || selected.toLowerCase() !== requested.toLowerCase()) {
      return {
        success: false,
        error_type: 'skill_dynamic_catalog_disabled',
        error: '技能动态目录已关闭。当前只能加载输入框选用的技能。请在 设置 → 能力开关 中开启「技能动态目录」，或在输入框下拉里选中该技能。'
      }
    }
  }
  const skill = findSkillByName(requested, projectPath)
  if (!skill?.content) {
    const available = listKnownSkills(projectPath)
      .map(item => item?.name)
      .filter(Boolean)
      .slice(0, 30)
    return {
      success: false,
      error_type: 'skill_not_found',
      error: `未找到技能 ${requested}。请使用目录中的精确名称调用 load_skill。`,
      name: requested,
      available
    }
  }
  return {
    success: true,
    name: skill.name,
    title: skill.title || skill.name,
    description: skill.description || '',
    source: skillSourceLabel(skill),
    content: skill.content,
    message: `已加载技能 ${skill.title || skill.name}（${skill.name}）全文。按其中说明执行，不要再凭目录摘要猜步骤。`
  }
}

function buildSkillCatalogPrompt(options = {}) {
  const projectPath = options.projectPath || ''
  const userMessage = options.userMessage || ''
  const selectedName = String(options.selectedName || parseSelectedSkillName(options.skillContent) || '').trim()
  const dynamicEnabled = Object.prototype.hasOwnProperty.call(options, 'dynamicCatalogEnabled')
    ? options.dynamicCatalogEnabled === true
    : isSkillDynamicCatalogEnabled()
  const relevantNames = dynamicEnabled ? detectAutoRelevantSkillNames(userMessage) : []
  const known = listKnownSkills(projectPath)
  const enabled = new Set((config.getEnabledSkills?.() || []).map(item => String(item || '').trim()).filter(Boolean))
  const wanted = new Map()

  const add = (skill, flags = {}) => {
    if (!skill?.name) return
    const prev = wanted.get(skill.name) || { skill, selected: false, relevant: false }
    wanted.set(skill.name, {
      skill: skill.content ? skill : (prev.skill || skill),
      selected: prev.selected || !!flags.selected,
      relevant: prev.relevant || !!flags.relevant
    })
  }

  if (dynamicEnabled) {
    for (const skill of known) {
      if (enabled.has(skill.name) || skill.projectSkill) add(skill)
    }
    for (const name of relevantNames) add(findSkillByName(name, projectPath), { relevant: true })
  }
  if (selectedName) add(findSkillByName(selectedName, projectPath), { selected: true })

  const entries = [...wanted.values()]
    .filter(item => item.skill?.name)
    .sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1
      if (a.relevant !== b.relevant) return a.relevant ? -1 : 1
      return String(a.skill.name).localeCompare(String(b.skill.name))
    })
    .slice(0, SKILL_CATALOG_MAX_ENTRIES)

  if (!entries.length) return ''

  const lines = entries.map(({ skill, selected, relevant }) => {
    const marks = [selected ? '当前选用' : '', relevant ? '本轮相关' : ''].filter(Boolean)
    const mark = marks.length ? ` [${marks.join('、')}]` : ''
    const summary = [skill.title && skill.title !== skill.name ? skill.title : '', skill.description || '']
      .filter(Boolean)
      .join(' — ') || skill.name
    return `- \`${skill.name}\`${mark}: ${capSkillDescription(summary)}`
  })

  if (!dynamicEnabled) {
    return `===== 当前选用技能 =====
用户已在输入框选用该技能。先调用 load_skill（name 用下面的精确名称）加载全文，再按完整说明执行。不要加载未选用的其他技能。对用户说话不要提技能名或工具名。

${lines.join('\n')}`
  }

  return `===== 可用技能目录 =====
技能是可复用的任务做法。下面只有名称和短描述，不是完整说明。
用户点名某个技能、或任务明显匹配描述时，先调用 load_skill（name 用目录里的精确名称）加载全文，再按完整说明执行。未加载前不要臆造步骤或工具细节。
若有「当前选用」或「本轮相关」标记，优先加载这些技能；对用户说话不要提技能名或工具名。

${lines.join('\n')}`
}

/**
 * 按用户话术自动挂载相关技能目录（不再注入 SKILL.md 全文）。
 */
function buildAutoAttachedSkillPrompt(userMessage = '') {
  return buildSkillCatalogPrompt({
    userMessage,
    selectedName: '',
    skillContent: ''
  })
}

/**
 * 加载已启用技能列表
 */
function loadEnabledSkills() {
  const linguaBasePath = config.getLinguaBasePath()
  const allSkills = config.getAllSkills()
  let enabledSkills = config.getEnabledSkills()

  try {
    const enabledPath = path.join(linguaBasePath, 'enabled-skills.json')
    if (fs.existsSync(enabledPath)) {
      enabledSkills = JSON.parse(fs.readFileSync(enabledPath, 'utf-8'))
      if (!Array.isArray(enabledSkills)) enabledSkills = []
      config.setEnabledSkills(enabledSkills)
      // 空列表合法：启用是可选池，不自动回填；模型仍只看输入框当前选中
    } else {
      // 首次：默认启用内置技能（进入可选池），输入框仍默认「无技能」不对模型注入
      enabledSkills = allSkills.filter(s => s.builtin).map(s => s.name)
      config.setEnabledSkills(enabledSkills)
      saveEnabledSkills()
      console.log('[Skills] 首次加载，默认启用内置技能（可选池）:', enabledSkills.length, '个')
    }
  } catch (e) {
    console.error('[Skills] 加载启用技能失败:', e.message)
    if (allSkills.length > 0 && (!enabledSkills || enabledSkills.length === 0)) {
      enabledSkills = allSkills.filter(s => s.builtin).map(s => s.name)
      config.setEnabledSkills(enabledSkills)
    }
  }

  // 必须在磁盘启用列表加载完成后再修复插件入口，避免空内存写盘冲掉原列表
  try {
    if (typeof plugins.ensureInstalledPluginsEnabled === 'function') {
      const newly = plugins.ensureInstalledPluginsEnabled()
      if (newly && newly.length) {
        console.log('[Skills] 已自动启用插件入口:', newly.join(', '))
      }
    }
  } catch (e) {
    console.warn('[Skills] ensure plugin skills enabled failed:', e.message)
  }
}

/**
 * 保存已启用技能列表
 */
function saveEnabledSkills() {
  const linguaBasePath = config.getLinguaBasePath()
  const enabledSkills = config.getEnabledSkills()

  try {
    const enabledPath = path.join(linguaBasePath, 'enabled-skills.json')
    fs.writeFileSync(enabledPath, JSON.stringify(enabledSkills, null, 2))
  } catch (e) {
    console.error('[Skills] 保存启用技能失败:', e.message)
  }
}

/**
 * 获取已启用的技能对象列表
 */
function getEnabledSkillObjects() {
  const allSkills = config.getAllSkills()
  const enabledSkills = config.getEnabledSkills()
  return allSkills.filter(s => enabledSkills.includes(s.name))
}

/**
 * 启用技能
 */
function enableSkill(skillName) {
  const enabledSkills = config.getEnabledSkills()
  if (!enabledSkills.includes(skillName)) {
    config.addEnabledSkill(skillName)
    saveEnabledSkills()
  }
  return { success: true }
}

/**
 * 禁用技能
 */
function disableSkill(skillName) {
  config.removeEnabledSkill(skillName)
  saveEnabledSkills()
  return { success: true }
}

/**
 * 删除自定义技能
 */
function deleteSkill(skillName) {
  const allSkills = config.getAllSkills()
  const skill = allSkills.find(s => s.name === skillName && !s.builtin)
  if (!skill) {
    return { error: '只能删除自定义技能' }
  }
  if (skill.pluginId || skill.kind === 'plugin') {
    return { error: '插件技能请到「插件 · 已安装」中卸载整个插件' }
  }

  const skillFolder = path.dirname(skill.path)
  if (fs.existsSync(skillFolder)) {
    fs.rmSync(skillFolder, { recursive: true })
  }

  // 从启用列表移除
  config.removeEnabledSkill(skillName)
  saveEnabledSkills()

  // 重新加载技能
  loadAllSkills()

  return { success: true }
}

/**
 * 上传自定义技能
 */
function uploadSkill(skillData) {
  const skillsDir = config.getSkillsDir()
  const { name, title, description, content } = skillData
  const skillFolder = path.join(skillsDir, name)

  // 确保技能目录存在
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true })
  }

  // 创建技能文件夹
  if (!fs.existsSync(skillFolder)) {
    fs.mkdirSync(skillFolder, { recursive: true })
  }

  // 写入 SKILL.md 文件
  const skillContent = `---
name: ${name}
title: ${title || name}
description: ${description || ''}
---

${content || ''}
`
  fs.writeFileSync(path.join(skillFolder, 'SKILL.md'), skillContent)

  // 重新加载技能
  loadAllSkills()

  return { success: true, skillName: name }
}

/**
 * 获取所有技能列表（用于IPC响应）
 */
function getAllSkillsForIPC(projectPath = '') {
  const allSkills = projectPath ? loadAllSkills(projectPath) : config.getAllSkills()
  const enabledSkills = config.getEnabledSkills()
  return allSkills.map(s => ({
    name: s.name,
    title: s.title || s.name,
    description: s.description || '',
    content: s.content,
    builtin: s.builtin,
    projectSkill: !!s.projectSkill,
    kind: s.kind || (s.pluginId ? 'plugin' : 'skill'),
    pluginId: s.pluginId || null,
    pluginName: s.pluginName || null,
    pluginSkill: s.pluginSkill || null,
    isPluginRoot: !!s.isPluginRoot,
    scope: s.scope || (s.projectSkill ? 'project' : 'global'),
    enabled: !!s.projectSkill || enabledSkills.includes(s.name)
  }))
}

/**
 * 获取已启用技能列表（用于IPC响应）
 */
function getEnabledSkillsForIPC(projectPath = '') {
  const enabled = projectPath
    ? loadAllSkills(projectPath).filter(s => s.projectSkill || config.getEnabledSkills().includes(s.name))
    : getEnabledSkillObjects()
  return enabled.map(s => ({
    name: s.name,
    title: s.title || s.name,
    description: s.description || '',
    content: s.content,
    builtin: s.builtin,
    projectSkill: !!s.projectSkill,
    kind: s.kind || (s.pluginId ? 'plugin' : 'skill'),
    pluginId: s.pluginId || null,
    pluginName: s.pluginName || null,
    pluginSkill: s.pluginSkill || null,
    isPluginRoot: !!s.isPluginRoot,
    scope: s.scope || (s.projectSkill ? 'project' : 'global')
  }))
}

/**
 * 注册技能系统 IPC handlers
 */
function registerSkillsIPC(ipcMain) {
  // 获取所有技能列表
  ipcMain.handle('get-all-skills', (event, projectPath = '') => {
    return getAllSkillsForIPC(projectPath)
  })

  // 获取已启用的技能列表
  ipcMain.handle('get-enabled-skills', (event, projectPath = '') => {
    return getEnabledSkillsForIPC(projectPath)
  })

  // 刷新技能列表
  ipcMain.handle('reload-skills', (event, projectPath = '') => {
    loadAllSkills(projectPath)
    return getAllSkillsForIPC(projectPath)
  })

  // 启用技能
  ipcMain.handle('enable-skill', (event, skillName) => {
    return enableSkill(skillName)
  })

  // 禁用技能
  ipcMain.handle('disable-skill', (event, skillName) => {
    return disableSkill(skillName)
  })

  // 上传自定义技能
  ipcMain.handle('upload-skill', async (event, skillData) => {
    return uploadSkill(skillData)
  })

  // 删除自定义技能
  ipcMain.handle('delete-skill', (event, skillName) => {
    return deleteSkill(skillName)
  })

  // 选择技能文件上传
  ipcMain.handle('select-skill-file', async () => {
    const mainWindow = config.getMainWindow()
    const skillsDir = config.getSkillsDir()

    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择技能文件',
      filters: [
        { name: '技能包', extensions: ['zip'] },
        { name: 'Markdown', extensions: ['md'] }
      ],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true }
    }

    const filePath = result.filePaths[0]

    // 判断文件类型
    if (filePath.endsWith('.zip')) {
      try {
        const skillName = path.basename(filePath, '.zip')
        const extractPath = path.join(skillsDir, skillName + '_temp')

        // 使用 PowerShell 解压（异步，不阻塞主进程）
        const { execFile } = require('child_process')
        const { promisify } = require('util')
        const execFileAsync = promisify(execFile)
        const psCmd = `Expand-Archive -Path "${filePath}" -DestinationPath "${extractPath}" -Force`
        await execFileAsync('powershell', ['-Command', psCmd], { encoding: 'utf8', timeout: 30000 })

        // 查找 SKILL.md 文件
        const findSkillMd = (dir) => {
          const items = fs.readdirSync(dir, { withFileTypes: true })
          for (const item of items) {
            const fullPath = path.join(dir, item.name)
            if (item.isDirectory()) {
              const found = findSkillMd(fullPath)
              if (found) return found
            } else if (item.name.toLowerCase() === 'skill.md') {
              return fullPath
            }
          }
          return null
        }

        const skillMdPath = findSkillMd(extractPath)

        if (skillMdPath && fs.existsSync(skillMdPath)) {
          const skillDir = path.dirname(skillMdPath)
          const finalPath = path.join(skillsDir, skillName)

          if (skillDir !== extractPath) {
            if (fs.existsSync(finalPath)) {
              fs.rmSync(finalPath, { recursive: true })
            }
            fs.renameSync(skillDir, finalPath)
            fs.rmSync(extractPath, { recursive: true })
          } else {
            if (fs.existsSync(finalPath)) {
              fs.rmSync(finalPath, { recursive: true })
            }
            fs.renameSync(extractPath, finalPath)
          }

          const skill = parseSkillFile(path.join(finalPath, 'SKILL.md'))
          if (skill) {
            loadAllSkills()
            return { success: true, skill, message: `技能 "${skill.title || skill.name}" 导入成功` }
          }
        }

        if (fs.existsSync(extractPath)) {
          fs.rmSync(extractPath, { recursive: true })
        }
        return { error: '压缩包中未找到 SKILL.md 文件' }
      } catch (e) {
        console.error('[Skills] 解压失败:', e.message)
        return { error: '解压失败: ' + e.message }
      }
    } else if (filePath.endsWith('.md')) {
      const skill = parseSkillFile(filePath)
      if (skill) {
        const skillName = skill.name || path.basename(filePath, '.md')
        const destFolder = path.join(skillsDir, skillName)
        if (!fs.existsSync(destFolder)) {
          fs.mkdirSync(destFolder, { recursive: true })
        }
        fs.copyFileSync(filePath, path.join(destFolder, 'SKILL.md'))
        loadAllSkills()
        return { success: true, skill, message: `技能 "${skill.title || skill.name}" 导入成功` }
      } else {
        return { error: '解析技能文件失败' }
      }
    } else {
      return { error: '不支持的文件格式，请选择 .zip 或 .md 文件' }
    }
  })

  // 获取技能目录路径
  ipcMain.handle('get-skills-dir', () => {
    return config.getSkillsDir()
  })
}

module.exports = {
  parseSkillFile,
  loadBuiltinSkills,
  loadUserSkills,
  loadAllSkills,
  loadEnabledSkills,
  saveEnabledSkills,
  getEnabledSkillObjects,
  enableSkill,
  disableSkill,
  deleteSkill,
  uploadSkill,
  getAllSkillsForIPC,
  getEnabledSkillsForIPC,
  parseSelectedSkillName,
  findSkillByName,
  loadSkillBody,
  buildSkillCatalogPrompt,
  buildAutoAttachedSkillPrompt,
  isSkillDynamicCatalogEnabled,
  registerSkillsIPC
}
