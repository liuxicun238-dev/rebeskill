# 灵犀 LingXiCode 开发指南

## 项目架构

```
灵犀-05/
├── electron/                 # 后端（Electron 主进程）
│   ├── main.js               # 入口文件（~100行，只负责初始化和组装）
│   ├── preload.js            # IPC 桥接层
│   ├── modules/              # 功能模块目录
│   │   ├── config.js         # 共享配置中心
│   │   ├── skills.js         # 技能系统
│   │   ├── projects.js       # 项目管理
│   │   ├── windows.js        # 窗口管理
│   │   ├── tools.js          # 工具定义与执行
│   │   ├── ai-chat.js        # AI对话处理
│   │   ├── git.js            # Git版本管理
│   │   ├── dispatch.js       # 派送任务
│   │   ├── plans.js          # 方案管理
│   │   └── ipc.js            # IPC路由注册
│   └── tools/                 # 工具实现
│       ├── browser-tool.js
│       ├── context-manager.js
│       └── dispatch-context.js
│
├── frontend/                  # 前端（渲染进程）
│   ├── index.html             # 主入口（HTML结构 + 模块引入）
│   ├── styles/
│   │   └── main.css           # 主样式（外链化）
│   └── scripts/               # 前端JS模块目录（后续扩展）
│
├── skills/                    # 内置技能目录
└── package.json
```

---

## 后端模块化设计

### 模块职责

| 模块 | 职责 | 导出接口 |
|------|------|---------|
| config.js | 管理全局变量（mainWindow、projectInstances等） | getter/setter |
| skills.js | 技能加载、解析、启用/禁用 | loadAllSkills, registerSkillsIPC |
| projects.js | 项目实例创建、历史存储 | createProjectInstance, registerProjectsIPC |
| windows.js | 窗口创建、控制、热重载 | createMainWindow, registerWindowIPC |
| tools.js | 工具Schema定义、执行 | TOOLS_SCHEMA, executeToolForProject |
| ai-chat.js | AI对话、系统提示、消息循环 | registerChatIPC, getSystemPrompt |
| git.js | Git命令执行、状态获取 | registerGitIPC, execGit |
| dispatch.js | 派送任务消息发送 | registerDispatchIPC |
| plans.js | 方案存储管理 | registerPlansIPC |
| ipc.js | 统一注册所有IPC通道 | registerAllIPC |

### 添加新后端模块

**步骤：**

1. 在 `electron/modules/` 创建新模块文件
2. 编写模块逻辑，导出 `registerXxxIPC(ipcMain)` 函数
3. 在 `electron/modules/ipc.js` 中引入并注册
4. 在 `preload.js` 添加对应的 IPC 调用接口

**示例：添加"代码模板管理"模块**

```javascript
// electron/modules/templates.js

const fs = require('fs')
const path = require('path')
const config = require('./config')

/**
 * 获取所有模板列表
 */
function getAllTemplates() {
  const templatesDir = config.getTemplatesDir()
  // ... 实现逻辑
}

/**
 * 注册模板管理 IPC handlers
 */
function registerTemplatesIPC(ipcMain) {
  ipcMain.handle('get-all-templates', async () => {
    return getAllTemplates()
  })
  
  ipcMain.handle('save-template', async (event, templateData) => {
    // ... 保存逻辑
  })
}

module.exports = {
  getAllTemplates,
  registerTemplatesIPC
}
```

然后在 `ipc.js` 中添加：

```javascript
const templates = require('./templates')

function registerAllIPC(ipcMain) {
  // ... 其他模块
  templates.registerTemplatesIPC(ipcMain)
}
```

---

## 前端扩展指南

### 核心原则

**index.html 只做"组装入口"，不写入大段 JS 代码**

- HTML 结构保持不变
- CSS 通过外链引入
- 新功能 JS 通过 `<script src>` 引入

### 添加新前端模块

**步骤：**

1. 在 `frontend/scripts/` 创建新 JS 文件
2. 编写功能逻辑，通过 `window.api` 与后端通信
3. 在 `index.html` 底部添加 `<script src="scripts/xxx.js"></script>`
4. 在 HTML 中添加对应的 UI 结构

**示例：添加"代码模板管理"前端**

```javascript
// frontend/scripts/templates.js

// 模板管理模块
(function() {
  // DOM 元素引用
  const templatesPanel = document.getElementById('templates-panel')
  const templatesList = document.getElementById('templates-list')
  
  // 加载模板列表
  async function loadTemplates() {
    const templates = await window.api.getTemplates()
    renderTemplatesList(templates)
  }
  
  // 渲染列表
  function renderTemplatesList(templates) {
    templatesList.innerHTML = templates.map(t => `
      <div class="template-item" data-id="${t.id}">
        <div class="template-name">${t.name}</div>
        <div class="template-desc">${t.description}</div>
      </div>
    `).join('')
  }
  
  // 事件绑定
  document.getElementById('templates-btn').addEventListener('click', () => {
    templatesPanel.classList.add('show')
    loadTemplates()
  })
  
  // 初始化
  loadTemplates()
})()
```

在 `index.html` 中引入：

```html
<!-- 在 </body> 前添加 -->
<script src="scripts/templates.js"></script>
```

---

## 前后端通信

### IPC 调用方式

**后端（preload.js）定义接口：**

```javascript
// preload.js
contextBridge.exposeInMainWorld('api', {
  // 项目管理
  getAllProjects: () => ipcRenderer.invoke('get-all-projects'),
  createProject: (path) => ipcRenderer.invoke('create-project', path),
  
  // 技能管理
  getAllSkills: () => ipcRenderer.invoke('get-all-skills'),
  enableSkill: (name) => ipcRenderer.invoke('enable-skill', name),
  
  // 你的新功能
  getTemplates: () => ipcRenderer.invoke('get-all-templates'),
  saveTemplate: (data) => ipcRenderer.invoke('save-template', data),
})
```

**前端调用：**

```javascript
// 前端 JS 中使用
const templates = await window.api.getTemplates()
await window.api.saveTemplate({ name: 'My Template', content: '...' })
```

### 双向通信

**后端主动推送：**

```javascript
// 后端模块
mainWindow.webContents.send('template-saved', { id: 'xxx', name: '...' })
```

**前端监听：**

```javascript
// 前端 JS
window.api.onTemplateSaved((data) => {
  console.log('模板已保存:', data)
})
```

需要在 preload.js 添加：

```javascript
onTemplateSaved: (callback) => ipcRenderer.on('template-saved', callback)
```

---

## 模块间共享状态

### 使用 config.js

**config.js 是共享配置中心，管理全局变量：**

```javascript
// 当前支持的共享变量
config.setAppDataPath(path)
config.getAppDataPath()

config.setLinguaBasePath(path)
config.getLinguaBasePath()

config.setMainWindow(win)
config.getMainWindow()

config.setSkillsDir(path)
config.getSkillsDir()

config.setPlansDir(path)
config.getPlansDir()

// 项目实例管理
config.getProjectInstances()
config.setProjectInstance(id, instance)
config.getProjectInstance(id)
config.deleteProjectInstance(id)

// 派送窗口管理
config.getDispatchWindows()
config.setDispatchWindow(id, win)
config.getDispatchWindow(id)
config.deleteDispatchWindow(id)

// AbortController 管理
config.setAbortController(id, controller)
config.getAbortController(id)
config.deleteAbortController(id)

// 技能列表
config.getAllSkills()
config.setAllSkills(skills)
config.getEnabledSkills()
config.setEnabledSkills(skills)
```

**新模块使用示例：**

```javascript
// 在你的模块中引用 config
const config = require('./config')

// 获取主窗口发送通知
const mainWindow = config.getMainWindow()
mainWindow?.webContents.send('your-event', data)

// 获取当前项目实例
const projectInstances = config.getProjectInstances()
const instance = projectInstances.get(projectId)
```

---

## 文件路径约定

### 后端模块路径

```javascript
// 模块内部使用 __dirname（指向 electron/ 目录）
const skillPath = path.join(__dirname, '../skills')    // skills 目录
const frontendPath = path.join(__dirname, '../frontend') // frontend 目录

// 用户数据目录（通过 config 获取）
const linguaBasePath = config.getLinguaBasePath()      // 用户数据根目录
const skillsDir = config.getSkillsDir()                // 用户自定义技能
const plansDir = config.getPlansDir()                  // 方案存储
```

### 前端资源路径

```html
<!-- CSS -->
<link rel="stylesheet" href="styles/main.css">

<!-- JS 模块 -->
<script src="scripts/templates.js"></script>
<script src="scripts/utils.js"></script>
```

---

## 开发流程总结

### 新增功能完整流程

1. **规划模块**
   - 确定功能属于后端还是前端
   - 确定需要的 IPC 通道

2. **创建后端模块**
   - 在 `electron/modules/` 创建 xxx.js
   - 实现 `registerXxxIPC(ipcMain)` 函数
   - 在 `ipc.js` 中引入注册

3. **添加 IPC 接口**
   - 在 `preload.js` 添加 `window.api` 方法

4. **创建前端模块**
   - 在 `frontend/scripts/` 创建 xxx.js
   - 编写 UI 交互逻辑

5. **添加 UI 结构**
   - 在 `index.html` 的 `<div id="app">` 内添加 HTML 结构
   - 在 `index.html` 底部添加 `<script src>` 引入

6. **添加样式**
   - 在 `frontend/styles/main.css` 添加样式
   - 或新建独立 CSS 文件并引入

---

## 常见问题

### Q: 如何调试后端模块？

使用 `开发模式启动.bat`，会自动打开 DevTools。控制台会显示 `[Main]` 开头的后端日志。

### Q: 如何调试前端模块？

按 `Ctrl+Shift+I` 打开 DevTools，在 Console 面板查看前端日志。

### Q: 模块之间如何通信？

- 后端模块间：通过 `config.js` 共享变量
- 前端模块间：通过 `window` 全局变量或 DOM 事件
- 前后端间：通过 IPC（`window.api`）

### Q: 如何复用已有代码？

参考现有模块的实现方式，如：
- `skills.js` - 学习 IPC 注册模式
- `git.js` - 学习命令执行模式
- `ai-chat.js` - 学习异步处理模式

---

## 维护建议

1. **保持模块独立** - 每个模块只做一件事
2. **命名规范** - 文件名与功能对应（如 templates.js）
3. **导出清晰** - 模块导出 `registerXxxIPC` 函数统一注册
4. **日志完整** - 使用 `[模块名]` 开头的日志便于追踪
5. **注释适度** - 只在关键逻辑处添加注释说明意图

---

*文档版本: 1.0*
*最后更新: 2026-05-21*
