const Module = require('module')
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => process.cwd(), on() {}, setPath() {} } }
  if (request === 'playwright-core') return { chromium: {} }
  return originalLoad.apply(this, arguments)
}
const bridge = require('../../../electron/modules/deepseek-web-bridge.js')
const tools = [{ type: 'function', function: { name: 'file_search', parameters: {} } }]

// 场景1：前面有说明文字 + 工具调用（你贴的真实场景）
const raw1 = '正在查看项目根目录下有哪些文件或文件夹，先不限定扩展名。\n\n<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"action":"directory","path":"E:\\灵犀-11\\03\\自迭代\\05\\测试00","recursive":false}}]}</LINGXI_TOOL_CALLS>'
const p1 = bridge.parseLingxiToolCalls(raw1, tools)
console.log('场景1 parsed:', p1.length, p1[0]?.function?.name)
if (p1.length !== 1 || p1[0].function.name !== 'file_search') throw new Error('场景1 failed')

// 场景2：严格格式仍然工作
const raw2 = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"action":"glob","pattern":"*.js"}}]}</LINGXI_TOOL_CALLS>'
const p2 = bridge.parseLingxiToolCalls(raw2, tools)
console.log('场景2 parsed:', p2.length, p2[0]?.function?.name)
if (p2.length !== 1) throw new Error('场景2 failed')

// 场景3：未授权工具仍然拒绝（安全底线不破）
let rejected = false
try { bridge.parseLingxiToolCalls('<LINGXI_TOOL_CALLS>{"calls":[{"name":"delete_everything","arguments":{}}]}</LINGXI_TOOL_CALLS>', tools) }
catch (e) { rejected = e.code === 'INVALID_TOOL_CALL_PROTOCOL' }
console.log('场景3 unauthorized rejected:', rejected)
if (!rejected) throw new Error('场景3 failed')

// 场景4：完全没标记 → 返回空数组（正常文本回复）
const p4 = bridge.parseLingxiToolCalls('这是一段普通回复，没有工具调用。', tools)
console.log('场景4 no-marker returns:', JSON.stringify(p4))
if (p4.length !== 0) throw new Error('场景4 failed')

// 场景5：write_file 的 HTML contents 含裸双引号（个人介绍页常见）
const htmlTools = [{ type: 'function', function: { name: 'write_file', parameters: {} } }]
const raw5 = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"write_file","arguments":{"path":"E:/demo/index.html","contents":"<!DOCTYPE html>\\n<html><head><style>.hero{color:red}</style></head><body><div class="hero">你好</div></body></html>"}}]}</LINGXI_TOOL_CALLS>'
const p5 = bridge.parseLingxiToolCalls(raw5, htmlTools)
console.log('场景5 html write_file parsed:', p5.length, p5[0]?.function?.name)
if (p5.length !== 1 || p5[0].function.name !== 'write_file') throw new Error('场景5 failed')
const args5 = JSON.parse(p5[0].function.arguments)
if (!String(args5.content || args5.contents || '').includes('class="hero"')) throw new Error('场景5 contents not repaired')

// 场景5b：残缺 HTML 必须在写入前被拒绝
let htmlRejected = false
try {
  bridge.parseLingxiToolCalls('<LINGXI_TOOL_CALLS>{"calls":[{"name":"write_file","arguments":{"path":"E:/demo/index.html","content":"<div class=\\"hero\\">你好</div>"}}]}</LINGXI_TOOL_CALLS>', htmlTools)
} catch (e) {
  htmlRejected = e.code === 'INVALID_HTML_DOCUMENT'
}
console.log('场景5b broken html rejected:', htmlRejected)
if (!htmlRejected) throw new Error('场景5b failed')

// 场景8：CSS 里未转义的 font-family:"Inter" 和 content:""，这是刚才个人介绍页的真实失败形态
const cssBody = 'body { font-family: "Inter", sans-serif; }\n.nav a::after { content: ""; }\n'
const raw8 = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"write_file","arguments":{"path":"E:/demo/style.css","content":"' + cssBody.replace(/\n/g, '\\n') + '"}}]}</LINGXI_TOOL_CALLS>'
const p8 = bridge.parseLingxiToolCalls(raw8, htmlTools)
console.log('场景8 css quotes parsed:', p8.length, p8[0]?.function?.name)
if (p8.length !== 1) throw new Error('场景8 failed')
const args8 = JSON.parse(p8[0].function.arguments)
if (!String(args8.content || '').includes('font-family: "Inter"')) throw new Error('场景8 Inter quotes lost: ' + args8.content)
if (!String(args8.content || '').includes('content: ""')) throw new Error('场景8 css content quotes lost')

// 场景9：一次回复里两个 write_file（style.css + script.js）
const jsBody = 'document.querySelectorAll(".fade-in");\nconsole.log("loaded");\n'
const raw9 = '<LINGXI_TOOL_CALLS>{"calls":[' +
  '{"name":"write_file","arguments":{"path":"E:/demo/style.css","content":"' + cssBody.replace(/\n/g, '\\n') + '"}},' +
  '{"name":"write_file","arguments":{"path":"E:/demo/script.js","content":"' + jsBody.replace(/\n/g, '\\n') + '"}}' +
  ']}</LINGXI_TOOL_CALLS>'
const p9 = bridge.parseLingxiToolCalls('正在拆分为独立文件并优化视觉\n\n' + raw9, htmlTools)
console.log('场景9 two write_file parsed:', p9.length, p9.map(x => x.function.name).join(','))
if (p9.length !== 2) throw new Error('场景9 expected 2 calls, got ' + p9.length)
const args9b = JSON.parse(p9[1].function.arguments)
if (!String(args9b.content || '').includes('console.log("loaded")')) throw new Error('场景9 js content lost')

// 场景6：新气泡比上一轮短，也必须被当成新回复
const delta6 = bridge.extractReplyDelta(
  { count: 2, markdown: '已完成。', innerText: '已完成。' },
  { count: 1, markdown: '这是一段很长的上一轮工具调用和说明文字', innerText: '这是一段很长的上一轮工具调用和说明文字' }
)
console.log('场景6 short new bubble:', JSON.stringify(delta6.markdown))
if (delta6.markdown !== '已完成。') throw new Error('场景6 failed')

const delta7 = bridge.extractReplyDelta(
  { count: 1, markdown: '前文\n最终答案', innerText: '前文\n最终答案' },
  { count: 1, markdown: '前文', innerText: '前文' }
)
console.log('场景7 same-bubble append:', JSON.stringify(delta7.markdown))
if (delta7.markdown !== '\n最终答案') throw new Error('场景7 failed')

const gpt = require('../../../electron/modules/chatgpt-image-bridge.js')
const patchTools = [{ type: 'function', function: { name: 'apply_patch', parameters: {} } }]
const winHtml = 'E:\\灵犀-11\\03\\自迭代\\05\\测试00\\index.html'
const winCss = 'E:\\灵犀-11\\03\\自迭代\\05\\测试00\\styles.css'
const patchBody = [
  '*** Begin Patch',
  '*** Update File: ' + winHtml,
  '@@',
  '  <meta charset="UTF-8" />',
  '- <style>',
  '+ <link rel="stylesheet" href="styles.css" />',
  '*** Add File: ' + winCss,
  '+:root { --bg: #fff; }',
  '+body::before { content: ""; }',
  '+font-family: "SF Pro Display", sans-serif;',
  '*** End Patch'
].join('\n')
const rawPatch = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"apply_patch","arguments":{"patch":"' + patchBody.replace(/\n/g, '\\n') + '"}}]}</LINGXI_TOOL_CALLS>'
const pPatch = gpt.parseLingxiToolCalls(rawPatch, patchTools)
console.log('场景10 gpt apply_patch parsed:', pPatch.length, pPatch[0]?.function?.name)
if (pPatch.length !== 1 || pPatch[0].function.name !== 'apply_patch') throw new Error('场景10 failed')
const argsPatch = JSON.parse(pPatch[0].function.arguments)
if (!String(argsPatch.patch || '').includes('charset="UTF-8"')) throw new Error('场景10 html quotes lost')
if (!String(argsPatch.patch || '').includes('content: ""')) throw new Error('场景10 css content quotes lost')
if (!String(argsPatch.patch || '').includes('*** End Patch')) throw new Error('场景10 patch truncated')
if (!String(argsPatch.patch || '').includes('灵犀-11')) throw new Error('场景10 windows path lost')

const searchTools = [{ type: 'function', function: { name: 'file_search', parameters: {} } }]
const mangledCalls = 'LINGXI_TOOL_CALLS>{calls:[{name:"file_search",arguments:{action:directory,path:"E:/灵犀-11/03/自迭代/05/测试00/测试008",recursive:false}}]} </LINGXI_TO]()'
const parsedMangled = gpt.parseLingxiToolCalls(mangledCalls, searchTools)
if (parsedMangled.length !== 1 || parsedMangled[0].function.name !== 'file_search') {
  throw new Error('场景21 残缺闭合标签的工具协议应仍能执行')
}
if (!JSON.parse(parsedMangled[0].function.arguments).path.includes('测试008')) {
  throw new Error('场景21 残缺协议路径丢失')
}
const mangledObject = 'LINGXI_TOOL_CALLS>{calls:{name:"file_search",arguments:{action:directory,path:"E:/灵犀-11/03/自迭代/05/测试00/测试008",recursive:false}_'
const parsedObject = gpt.parseLingxiToolCalls(mangledObject, searchTools)
if (parsedObject.length !== 1 || parsedObject[0].function.name !== 'file_search') {
  throw new Error('场景21 无引号且 calls 为对象时应仍能执行')
}
const {
  clipWebBridgeThinkingNote,
  looksLikeWebBridgeToolProtocol
} = require('../../../electron/modules/web-bridge-coding-protocol')
if (!looksLikeWebBridgeToolProtocol(mangledCalls)) {
  throw new Error('场景21 应识别残缺工具协议')
}
if (clipWebBridgeThinkingNote(mangledCalls)) {
  throw new Error('场景21 工具协议不能写进思考块')
}

const codingTools = [
  { type: 'function', function: { name: 'write_file', parameters: { required: ['path', 'content'], properties: { path: {}, content: {} } } } },
  { type: 'function', function: { name: 'apply_patch', parameters: { required: ['patch'], properties: { patch: {} } } } },
  { type: 'function', function: { name: 'text_edit', parameters: { required: ['path', 'edits'], properties: { path: {}, edits: {} } } } },
  { type: 'function', function: { name: 'file_read', parameters: { properties: { path: {} } } } },
  { type: 'function', function: { name: 'ask_user_choice', parameters: { required: ['question', 'options'], properties: { question: {}, options: {} } } } }
]
const codingPrompt = bridge.buildWebChatPrompt({
  messages: [{ role: 'user', content: '改一下首页样式' }],
  tools: codingTools
})
if (!codingPrompt.includes('confirm_plan')) {
  throw new Error('场景11 第一轮应先调用灵犀计划工具 confirm_plan')
}
if (codingPrompt.includes('apply_patch') || codingPrompt.includes('text_edit')) {
  throw new Error('场景11 第一轮不应直接下发工具表')
}
if (codingPrompt.includes('按文件分组') || codingPrompt.includes('预折行')) {
  throw new Error('场景11 开场提示不应约束页面端最终回复排版')
}
if (!codingPrompt.includes('<LINGXI_FINAL>') || !codingPrompt.includes('<LINGXI_STAGE>')) {
  throw new Error('场景11 开场应约定最终回复和阶段性说明用不同暗号')
}
if (codingPrompt.includes('"parameters"') || codingPrompt.includes('JSON Schema')) {
  throw new Error('场景11 仍在倾倒完整 schema')
}
const toolRoundPrompt = bridge.buildWebChatPrompt({
  messages: [{ role: 'user', content: '改一下首页样式' }],
  tools: codingTools
}, [{ role: 'system', content: '继续同一任务。只填写调用标签，本地客户端会解析。' }], 'continuation')
if (!toolRoundPrompt.includes('apply_patch') || !toolRoundPrompt.includes('text_edit')) {
  throw new Error('场景11 DeepSeek 编码规则缺失')
}
if (!toolRoundPrompt.includes('覆盖') || !toolRoundPrompt.includes('<LINGXI_FINAL>')) {
  throw new Error('场景11 DeepSeek 应在工具轮约定覆盖写入，并用最终暗号收尾')
}
if (!toolRoundPrompt.includes('不要转义冒号') || !toolRoundPrompt.includes('===== /') || !toolRoundPrompt.includes('shell_run')) {
  throw new Error('场景11 工具轮应约束页面端不要把 JSON 转义写进 CSS')
}
if (!toolRoundPrompt.includes('ask_user_choice')) {
  throw new Error('场景11 工具轮应包含弹窗询问，不要把选择题写进完成标记')
}
const gptCodingPrompt = gpt.buildWebChatPrompt({
  messages: [{ role: 'user', content: '审查这段代码' }],
  tools: codingTools
})
if (!gptCodingPrompt.includes('<LINGXI_FINAL>') || !gptCodingPrompt.includes('confirm_plan') || !gptCodingPrompt.includes('<LINGXI_STAGE>')) {
  throw new Error('场景11 GPT 第一轮应先调用 confirm_plan，并约定最终回复暗号')
}
if (gptCodingPrompt.includes('apply_patch')) {
  throw new Error('场景11 GPT 第一轮不应直接下发工具表')
}
const helloPrompt = gpt.buildWebChatPrompt({
  messages: [{ role: 'user', content: '你好\n当前项目路径：E:/灵犀-11/03/自迭代/05/测试00' }],
  tools: codingTools
})
if (helloPrompt.trim() !== '你好' || helloPrompt.includes('{"calls"') || /立刻输出/.test(helloPrompt) || helloPrompt.includes('系统要求')) {
  throw new Error('场景11 打招呼只应把问候贴到网页，不要带工具协议: ' + helloPrompt)
}
const howAreYouPrompt = gpt.buildWebChatPrompt({
  messages: [{ role: 'user', content: '你还好吗\n当前项目路径：E:/灵犀-11/03/自迭代/05/测试00' }],
  tools: codingTools
})
if (howAreYouPrompt.trim() !== '你还好吗' || howAreYouPrompt.includes('第一段阶段性说明') || howAreYouPrompt.includes('{"calls"')) {
  throw new Error('场景11 「你还好吗」不应走开场计划或工具协议: ' + howAreYouPrompt)
}
const helloHistoryPrompt = gpt.buildWebChatPrompt({
  messages: [
    { role: 'user', content: '改首页' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'c-hello',
        type: 'function',
        function: { name: 'file_search', arguments: '{"action":"directory","path":"E:/demo"}' }
      }]
    },
    { role: 'tool', tool_call_id: 'c-hello', name: 'file_search', content: '{"files":[]}' },
    { role: 'user', content: '你好\n当前项目路径：E:/灵犀-11/03/自迭代/05/测试00' }
  ],
  tools: codingTools
})
if (helloHistoryPrompt.includes('灵犀工具结果') || helloHistoryPrompt.includes('--- 助手') || helloHistoryPrompt.includes('E:/demo') || helloHistoryPrompt.includes('系统要求')) {
  throw new Error('场景11 闲聊不应把历史工具结果贴到网页: ' + helloHistoryPrompt)
}

const fatSystem = `${'x'.repeat(80)}\nshow_thinking_note\nstart_final_reply\nAgent 运行时核心\nconfirm_plan\n${'y'.repeat(400)}`
const slimPrompt = bridge.buildWebChatPrompt({
  messages: [
    { role: 'system', content: fatSystem },
    { role: 'user', content: '改代码' }
  ],
  tools: codingTools
})
if (slimPrompt.includes('show_thinking_note') || slimPrompt.includes(fatSystem.slice(0, 40))) {
  throw new Error('场景11 系统提示未压缩')
}
if (!slimPrompt.includes('审查先读后改')) throw new Error('场景11 压缩后的网页系统提示缺失')
if (!slimPrompt.includes('不要讨论有没有工具') && !codingPrompt.includes('不要讨论有没有工具')) {
  throw new Error('场景11 未禁止模型声称没有工具')
}
if (codingPrompt.includes('只有改本地文件才') || slimPrompt.includes('不改本地文件就不要')) {
  throw new Error('场景11 仍把只读查代码误导成不要调工具')
}
if (codingPrompt.includes('只用于新建') || codingPrompt.includes('只建新文件') || slimPrompt.includes('只建新文件') || toolRoundPrompt.includes('只建新文件')) {
  throw new Error('场景11 页面端不能再把 write_file 限制成只能新建')
}
if (!toolRoundPrompt.includes('覆盖')) {
  throw new Error('场景11 页面端应允许 write_file 覆盖已有文件')
}
const searchTalk = ['自带搜索', '网页自己的搜索', '不要说自己不能搜', 'lxweb', 'browser_search', '联网搜索']
for (const word of searchTalk) {
  if (slimPrompt.includes(word) || codingPrompt.includes(word) || gptCodingPrompt.includes(word)) {
    throw new Error('场景11 提示词仍在谈论搜索: ' + word)
  }
}
const standin = require('../../../electron/modules/web-bridge-coding-protocol').getWebBridgeSystemStandin()
if (standin.length >= fatSystem.length) throw new Error('场景11 压缩后的网页系统提示没有变短')
for (const word of searchTalk) {
  if (standin.includes(word)) throw new Error('场景11 standin 仍在谈论搜索: ' + word)
}

const dumpedUser = [
  'Gemini 最新模型 发布 2026',
  '',
  '【本轮动态执行上下文】',
  '===== 当前运行上下文 =====',
  '当前项目路径：E:\\灵犀-11\\03\\自迭代\\05\\测试00',
  'When the user asks to open a public web page, call lxweb with action=open_right',
  '主导身份：产品规划'
].join('\n')
const dumpedPrompt = bridge.buildWebChatPrompt({
  messages: [
    { role: 'user', content: dumpedUser },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: {
          name: 'write_file',
          arguments: JSON.stringify({ path: 'E:/demo/style.css', content: 'x'.repeat(5000) })
        }
      }]
    },
    { role: 'tool', tool_call_id: 'c1', name: 'write_file', content: '/* css */\n'.repeat(800) }
  ],
  tools: codingTools
})
if (dumpedPrompt.includes('【本轮动态执行上下文】')) throw new Error('场景11 用户消息仍带运行时大段')
if (dumpedPrompt.includes('call lxweb') || dumpedPrompt.includes('主导身份')) {
  throw new Error('场景11 用户消息仍带 lxweb/角色路由')
}
if (!dumpedPrompt.includes('Gemini 最新模型 发布 2026')) throw new Error('场景11 用户原意被压掉')
if (!dumpedPrompt.includes('当前项目路径：E:/灵犀-11/03/自迭代/05/测试00')) {
  throw new Error('场景11 项目路径未保留')
}
if (!dumpedPrompt.includes('x'.repeat(200)) || !dumpedPrompt.includes('/* css */\n'.repeat(40))) {
  throw new Error('场景11 中等长度的写入内容和工具结果应完整回传，对齐 API')
}
const hugeDump = bridge.buildWebChatPrompt({
  messages: [
    { role: 'user', content: '改一下首页样式' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'c1',
        type: 'function',
        function: {
          name: 'write_file',
          arguments: JSON.stringify({ path: 'E:/demo/style.css', content: 'y'.repeat(20000) })
        }
      }]
    },
    { role: 'tool', tool_call_id: 'c1', name: 'write_file', content: 'z'.repeat(20000) }
  ],
  tools: codingTools
})
if (hugeDump.includes('y'.repeat(20000)) || hugeDump.includes('z'.repeat(20000))) {
  throw new Error('场景11 超大工具正文仍应裁切')
}
if (!hugeDump.includes('已省略')) throw new Error('场景11 超大工具调用未做成摘要')

const contPrompt = bridge.buildWebChatPrompt({
  messages: [{ role: 'user', content: '继续' }],
  tools: codingTools
}, [{ role: 'user', content: '继续' }], 'continuation')
if (contPrompt.includes('可用工具（name 必须逐字匹配）')) {
  throw new Error('场景11 continuation 不应重复完整工具表')
}
for (const word of searchTalk) {
  if (contPrompt.includes(word)) throw new Error('场景11 continuation 仍在谈论搜索: ' + word)
}

let missingRejected = false
try {
  bridge.parseLingxiToolCalls('<LINGXI_TOOL_CALLS>{"calls":[{"name":"write_file","arguments":{"path":"E:/a.js"}}]}</LINGXI_TOOL_CALLS>', codingTools)
} catch (e) {
  missingRejected = e.code === 'INVALID_TOOL_CALL_PROTOCOL' && /content/.test(e.message)
}
if (!missingRejected) throw new Error('场景11 缺字段未拒绝')

const pathTools = [{ type: 'function', function: { name: 'file_search', parameters: {} } }]
const rawPath = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"action":"directory","path":"E:\\\\灵犀-11\\\\demo"}}]}</LINGXI_TOOL_CALLS>'
const pPath = bridge.parseLingxiToolCalls(rawPath, pathTools)
const argsPath = JSON.parse(pPath[0].function.arguments)
if (argsPath.path !== 'E:/灵犀-11/demo') throw new Error('场景12 path slash normalize failed: ' + argsPath.path)

const retryPrompt = require('../../../electron/modules/web-bridge-coding-protocol').buildWebToolProtocolRetryPrompt('JSON 无法解析')
if (!retryPrompt.includes('格式无效') || !retryPrompt.includes('LINGXI_TOOL_CALLS')) {
  throw new Error('场景13 retry prompt missing')
}
for (const word of searchTalk) {
  if (retryPrompt.includes(word)) throw new Error('场景13 retry 仍在谈论搜索: ' + word)
}

const { markdownFromDomNode } = require('../../../electron/modules/web-bridge-dom-markdown')
function textNode(value) {
  return { nodeType: 3, textContent: value }
}
function matchSel(node, selector) {
  return String(selector).split(',').map(part => part.trim()).some(part => {
    if (!part) return false
    if (part.startsWith('[class*="')) {
      const bit = part.match(/class\*="([^"]+)"/)[1]
      return String(node.className || '').includes(bit)
    }
    if (part.startsWith('[role="')) {
      const role = part.match(/role="([^"]+)"/)[1]
      return String(node.getAttribute('role') || '') === role
    }
    if (part.startsWith('.')) return String(node.className || '').split(/\s+/).includes(part.slice(1))
    if (/^[a-z][\w-]*$/i.test(part)) return node.tagName === part.toUpperCase()
    return false
  })
}
function el(tag, kids = [], extra = {}) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: kids,
    children: kids.filter(child => child.nodeType === 1),
    className: extra.className || '',
    innerText: extra.innerText || '',
    textContent: extra.textContent || '',
    parentElement: null,
    getAttribute: name => (extra.attrs && extra.attrs[name]) || '',
    contains(other) {
      let current = other
      while (current) {
        if (current === this) return true
        current = current.parentElement
      }
      return false
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null
    },
    querySelectorAll(sel) {
      const out = []
      const walk = child => {
        if (!child || child.nodeType !== 1) return
        if (matchSel(child, sel)) out.push(child)
        for (const nested of child.children || []) walk(nested)
      }
      for (const child of this.children || []) walk(child)
      return out
    }
  }
  for (const child of node.children) child.parentElement = node
  if (!node.innerText) {
    node.innerText = kids.map(child => child.textContent || child.innerText || '').join('')
  }
  if (!node.textContent) node.textContent = node.innerText
  return node
}
const brokenPage = el('div', [
  textNode('确认已发布。'),
  el('br'),
  el('strong', [textNode('主要定位')]),
  textNode('：专门为'),
  el('br'),
  textNode('编程（Coding）和智能体（Agent）任务设计。')
])
const restored = markdownFromDomNode(brokenPage)
if (/\n\n\*\*主要定位\*\*\n\n/.test(restored)) throw new Error('场景14 文本节点仍被拆成独立段落')
if (!restored.includes('**主要定位**：专门为')) throw new Error('场景14 行内格式丢失: ' + restored)
if (!restored.includes('确认已发布。')) throw new Error('场景14 正文丢失')

const listed = markdownFromDomNode(el('div', [
  el('p', [textNode('要点：')]),
  el('ul', [
    el('li', [textNode('快速迭代')]),
    el('li', [textNode('主要定位：编程和智能体')])
  ])
]))
if (!listed.includes('要点：')) throw new Error('场景14 段落丢失')
if (!listed.includes('- 快速迭代') || !listed.includes('- 主要定位：编程和智能体')) {
  throw new Error('场景14 列表未还原: ' + listed)
}
const htmlBubble = el('div', [
  textNode('<LINGXI_TOOL_CALLS>{"calls":[{"name":"write_file","arguments":{"path":"E:/demo/index.html","content":"'),
  { nodeType: 10, textContent: '' },
  el('html', [
    el('head', [el('title', [textNode('Demo')])], { attrs: {} }),
    el('body', [el('div', [textNode('hello')], { attrs: { class: 'hero' } })])
  ], { attrs: { lang: 'zh-CN' } }),
  textNode('"}}]}</LINGXI_TOOL_CALLS>')
])
const htmlRestored = markdownFromDomNode(htmlBubble)
if (!htmlRestored.includes('<!DOCTYPE html>') || !htmlRestored.includes('<html') || !htmlRestored.includes('<head>') || !htmlRestored.includes('<div')) {
  throw new Error('场景14 页面端抓气泡时不能丢掉 HTML 声明: ' + htmlRestored)
}

function cell(tag, text) {
  return el(tag, [textNode(text)], { innerText: text, textContent: text })
}
const comparisonTable = el('table', [
  el('thead', [
    el('tr', [cell('th', '维度'), cell('th', 'Gemini 3.7'), cell('th', 'DeepSeek Pro')])
  ]),
  el('tbody', [
    el('tr', [cell('td', '核心优势'), cell('td', '多模态'), cell('td', '中文代码')])
  ])
])
const pageBubble = el('div', [
  el('div', [
    el('p', [textNode('两者都属第一梯队。')]),
    el('p', [textNode('以下是客观分析：')])
  ], { className: 'ds-markdown' }),
  comparisonTable,
  el('div', [
    el('p', [textNode('我的建议（产品视角）：')])
  ], { className: 'ds-markdown' })
], { className: 'ds-assistant-message' })
const withTable = markdownFromDomNode(pageBubble, { markdownSelectors: ['[class*="markdown"]', '[class*="ds-markdown"]'] })
if (!withTable.includes('| 维度 | Gemini 3.7 | DeepSeek Pro |')) {
  throw new Error('场景15 页面表格未抓到: ' + withTable)
}
if (!withTable.includes('核心优势') || !withTable.includes('我的建议（产品视角）：')) {
  throw new Error('场景15 表格或后文丢失: ' + withTable)
}
if (!withTable.includes('两者都属第一梯队') || withTable.indexOf('两者都属第一梯队') > withTable.indexOf('| 维度 |')) {
  throw new Error('场景15 表格前后文顺序应跟页面一致: ' + withTable)
}

const fencedPipeTable = markdownFromDomNode(el('div', [
  el('p', [textNode('对比如下：')]),
  el('pre', [
    el('code', [textNode([
      '| 文件 | 问题 |',
      '| --- | --- |',
      '| index.html | 字体 |',
      '| style.css | 注释 |'
    ].join('\n'))], { className: 'language-markdown' })
  ])
], { className: 'markdown' }), { markdownSelectors: ['[class*="markdown"]'] })
if (!fencedPipeTable.includes('| 文件 | 问题 |') || fencedPipeTable.includes('```')) {
  throw new Error('场景15 代码块里的 Markdown 表格应抓成软件端表格: ' + fencedPipeTable)
}

const htmlTableCode = [
  '<table>',
  '<tr><th>模型</th><th>特点</th></tr>',
  '<tr><td>GPT</td><td>综合</td></tr>',
  '</table>'
].join('')
const fencedHtmlTable = markdownFromDomNode(el('div', [
  el('pre', [
    el('code', [textNode(htmlTableCode)], { className: 'language-html', innerText: htmlTableCode, textContent: htmlTableCode })
  ])
], { className: 'markdown' }), { markdownSelectors: ['[class*="markdown"]'] })
if (!fencedHtmlTable.includes('| 模型 | 特点 |') || !fencedHtmlTable.includes('| GPT | 综合 |')) {
  throw new Error('场景15 代码创建的 HTML 表格应抓成软件端表格: ' + fencedHtmlTable)
}

const nestedDomTable = markdownFromDomNode(el('pre', [
  comparisonTable
], { className: 'markdown-code-block' }))
if (!nestedDomTable.includes('| 维度 | Gemini 3.7 | DeepSeek Pro |')) {
  throw new Error('场景15 代码块里的真实表格节点应抓到: ' + nestedDomTable)
}

const { parseApplyPatch } = require('../../../electron/modules/tool-handlers/text-edit')
const addLoose = parseApplyPatch([
  '*** Begin Patch',
  '*** Add File: D:/小说/个人介绍/index.html',
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<body>张三</body>',
  '</html>',
  '*** End Patch'
].join('\n'), { lenient: true })
if (addLoose.length !== 1 || addLoose[0].type !== 'add' || !addLoose[0].content.includes('张三')) {
  throw new Error('场景16 lenient Add File 未接受无 + 行')
}
let strictAddFailed = false
try {
  parseApplyPatch([
    '*** Begin Patch',
    '*** Add File: D:/demo/a.html',
    '<html></html>',
    '*** End Patch'
  ].join('\n'))
} catch (error) {
  strictAddFailed = /必须以 \+ 开头/.test(error.message)
}
if (!strictAddFailed) throw new Error('场景16 严格模式应拒绝无 + 的 Add File')

let updateLooseRejected = false
try {
  parseApplyPatch([
    '*** Begin Patch',
    '*** Update File: D:/小说/个人介绍/index.html',
    '</a> · <a href="https://github.com/zhangsan">GitHub</a>',
    '*** End Patch'
  ].join('\n'), { lenient: true })
} catch (error) {
  updateLooseRejected = /缺少可验证的 \+\/- 替换内容/.test(error.message)
}
if (!updateLooseRejected) {
  throw new Error('场景16 lenient Update File 无前缀应拒绝不可验证补丁，避免误覆盖整文件')
}

const { isWebThinkingPlaceholder } = require('../../../electron/modules/web-bridge-coding-protocol')
if (!isWebThinkingPlaceholder('正在思考') || !isWebThinkingPlaceholder('Thinking') || !isWebThinkingPlaceholder('正在处理')) {
  throw new Error('场景16 思考占位未识别')
}
if (isWebThinkingPlaceholder('修复已经成功写入 D:/小说/个人介绍/。')) {
  throw new Error('场景16 把正常正文误判成思考占位')
}

const {
  getResumePromptMessages,
  getSavedConversationUrl,
  rememberSavedConversation,
  resolveWebChatPromptPlan
} = require('../../../electron/modules/web-bridge-coding-protocol')

const history = [
  { role: 'system', content: 'standin' },
  { role: 'user', content: '先看项目结构' },
  { role: 'assistant', content: '先搜文件' },
  { role: 'tool', content: '很长的工具结果'.repeat(80) },
  { role: 'user', content: '继续改首页' }
]
const resumeSlice = getResumePromptMessages(history)
if (resumeSlice.length !== 1 || resumeSlice[0].content !== '继续改首页') {
  throw new Error('场景17 续写切片应只保留最后一条用户消息，实际: ' + JSON.stringify(resumeSlice))
}

const restartPlan = resolveWebChatPromptPlan({
  resumedThread: true,
  inputMessages: history,
  continuation: null
})
if (restartPlan.promptMode !== 'initial') throw new Error('场景17 旧线程上的新用户消息应按正常提问发送，不要催工具')
if (restartPlan.promptMessages.some(message => String(message.content || '').includes('先看项目结构'))) {
  throw new Error('场景17 重启后续写不能把完整历史再贴进页面')
}
if (restartPlan.promptMessages.length !== 1 || restartPlan.promptMessages[0].content !== '继续改首页') {
  throw new Error('场景17 重启后续写应只发最后一轮用户消息')
}

const freshPlan = resolveWebChatPromptPlan({
  resumedThread: false,
  inputMessages: history,
  continuation: null
})
if (freshPlan.promptMode !== 'initial' || freshPlan.promptMessages.length !== history.length) {
  throw new Error('场景17 全新页面会话才应发送完整压缩历史')
}

const toolTail = [{ role: 'tool', content: 'file_read 结果' }]
const toolPlan = resolveWebChatPromptPlan({
  resumedThread: true,
  inputMessages: history.concat(toolTail),
  continuation: toolTail
})
if (toolPlan.promptMode !== 'continuation' || toolPlan.promptMessages !== toolTail) {
  throw new Error('场景17 工具往返应沿用 continuation 增量')
}

const resumeTools = getResumePromptMessages(history.concat([
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'file_read' }] },
  { role: 'tool', content: 'file_read 结果 A' },
  { role: 'tool', content: 'file_read 结果 B' }
]))
if (resumeTools.length !== 2 || resumeTools.some(message => message.role !== 'tool')) {
  throw new Error('场景17 工具循环续写失败时应只回灌最新工具结果，实际: ' + JSON.stringify(resumeTools))
}

let saved = rememberSavedConversation({}, 'sess-a', 'https://chat.deepseek.com/a/chat/s/111', 'proj-1')
if (getSavedConversationUrl(saved, 'sess-a', 'proj-1') !== 'https://chat.deepseek.com/a/chat/s/111') {
  throw new Error('场景17 应按 session 精确恢复对话 URL')
}
saved = {
  'sess-a': { url: 'https://chat.deepseek.com/a/chat/s/111', projectId: 'proj-1', updatedAt: 1 },
  'sess-b': { url: 'https://chat.deepseek.com/a/chat/s/222', projectId: 'proj-1', updatedAt: 2 }
}
if (getSavedConversationUrl(saved, 'sess-missing', 'proj-1') !== 'https://chat.deepseek.com/a/chat/s/222') {
  throw new Error('场景17 同项目新会话应回落到最近一条页面对话')
}

const grokBridge = require('../../../electron/modules/grok-web-bridge.js')
const grokModel = grokBridge.getSuggestedChatModel()
if (grokModel.provider !== 'grok-web-bridge' || grokModel.modelId !== 'grok-web-chat') {
  throw new Error('场景18 Grok 网页模型标识不对: ' + JSON.stringify(grokModel))
}
if (!String(grokModel.apiUrl || '').includes('127.0.0.1:3219')) {
  throw new Error('场景18 Grok 网关应监听 3219，实际: ' + grokModel.apiUrl)
}
if (!String(grokBridge.getBrowserProfileDir() || '')) {
  throw new Error('场景18 Grok 必须有 Chrome 资料目录')
}
const grokImageModel = grokBridge.getSuggestedModel()
if (grokImageModel.modelId !== 'grok-web-image' || grokImageModel.capabilities?.imageGeneration !== true) {
  throw new Error('场景18 Grok 生图模型配置不对')
}
const grokSource = require('fs').readFileSync(require('path').join(__dirname, '../../../electron/modules/grok-web-bridge.js'), 'utf8')
if (!grokSource.includes("https://grok.com/")) throw new Error('场景18 缺少 grok.com 首页')
if (!grokSource.includes('data-testid="assistant-message"')) throw new Error('场景18 缺少 Grok 回复选择器')
if (!grokSource.includes('data-testid="chat-submit"') && !grokSource.includes('aria-label="Submit"')) {
  throw new Error('场景18 缺少 Grok Submit 发送按钮')
}
if (!grokSource.includes("pathname === '/v1/images/generations'")) throw new Error('场景18 缺少 Grok 生图接口')
if (!grokSource.includes('listCandidateImages')) throw new Error('场景18 缺少 Grok 生图抓取')
if (!grokSource.includes('captureReplyImages')) throw new Error('场景18 聊天回复应抓取内嵌生成图')
if (!grokSource.includes('insertContent')) throw new Error('场景18 Grok 输入框应走 TipTap insertContent')

const claudeBridge = require('../../../electron/modules/claude-web-bridge.js')
const claudeModel = claudeBridge.getSuggestedChatModel()
if (claudeModel.provider !== 'claude-web-bridge' || claudeModel.modelId !== 'claude-web-chat') {
  throw new Error('场景21 Claude 网页模型标识不对: ' + JSON.stringify(claudeModel))
}
if (!String(claudeModel.apiUrl || '').includes('127.0.0.1:3220')) {
  throw new Error('场景21 Claude 网关应监听 3220，实际: ' + claudeModel.apiUrl)
}
if (!String(claudeBridge.getBrowserProfileDir() || '')) {
  throw new Error('场景21 Claude 必须有 Chrome 资料目录')
}
if (claudeBridge.getBrowserProfileDir() !== grokBridge.getBrowserProfileDir()
  || grokBridge.getBrowserProfileDir() !== gpt.getBrowserProfileDir()
  || gpt.getBrowserProfileDir() !== bridge.getBrowserProfileDir()) {
  throw new Error('场景21 四家网页桥应共用同一份 Chrome 登录资料，避免新加一家就空白登录')
}
const arenaBridge = require('../../../electron/modules/arena-web-bridge.js')
const arenaModel = arenaBridge.getSuggestedChatModel()
if (arenaModel.provider !== 'arena-web-bridge' || arenaModel.modelId !== 'arena-web-chat') {
  throw new Error('场景21 Arena 网页模型标识不对: ' + JSON.stringify(arenaModel))
}
if (!String(arenaModel.apiUrl || '').includes('127.0.0.1:3221')) {
  throw new Error('场景21 Arena 网关应监听 3221，实际: ' + arenaModel.apiUrl)
}
if (arenaBridge.getBrowserProfileDir() !== claudeBridge.getBrowserProfileDir()) {
  throw new Error('场景21 Arena 应共用同一份 Chrome 登录资料')
}
const qwenBridge = require('../../../electron/modules/qwen-web-bridge.js')
const qwenModel = qwenBridge.getSuggestedChatModel()
if (qwenModel.provider !== 'qwen-web-bridge' || qwenModel.modelId !== 'qwen-web-chat') {
  throw new Error('场景21 Qwen 网页模型标识不对: ' + JSON.stringify(qwenModel))
}
if (!String(qwenModel.apiUrl || '').includes('127.0.0.1:3222')) {
  throw new Error('场景21 Qwen 网关应监听 3222，实际: ' + qwenModel.apiUrl)
}
if (qwenBridge.getBrowserProfileDir() !== arenaBridge.getBrowserProfileDir()) {
  throw new Error('场景21 Qwen 应共用同一份 Chrome 登录资料')
}
const qwenSource = require('fs').readFileSync(require('path').join(__dirname, '../../../electron/modules/qwen-web-bridge.js'), 'utf8')
if (!qwenSource.includes('https://chat.qwen.ai/')) throw new Error('场景21 缺少 chat.qwen.ai 入口')
if (!qwenSource.includes('textarea.message-input-textarea') || !qwenSource.includes('button.send-button')) {
  throw new Error('场景21 Qwen 应使用官网输入框和发送按钮')
}
if (!qwenSource.includes('header-right-auth-button')) {
  throw new Error('场景21 Qwen 登录检测应认页面上的 Log in / Sign up')
}
if (!qwenBridge.isQwenComposerChromeClass('chat-message-input-fixed-container')) {
  throw new Error('场景21 Qwen 必须把底部输入条从回复里排除')
}
if (qwenBridge.isQwenComposerChromeClass('qwen-chat-message-assistant')) {
  throw new Error('场景21 Qwen 不能把助手气泡当成输入条')
}
if (!qwenSource.includes('extractQwenAssistantState') || !qwenSource.includes('.response-message-content') || !qwenSource.includes('.qwen-chat-message-assistant')) {
  throw new Error('场景21 Qwen 应抓助手正文，而不是 chat-message-input 输入框')
}
if (!qwenSource.includes('QWEN_TURN_SELECTORS') || !qwenSource.includes('assistantTurns[assistantTurns.length - 1]') || !qwenSource.includes('climbToTurn')) {
  throw new Error('场景21 Qwen 应抓整条助手气泡，不能只取最后一个 markdown 碎片')
}
if (!qwenSource.includes('[class*="code-block"]') || !qwenSource.includes('stableCount >= 4')) {
  throw new Error('场景21 Qwen 应把页面代码块算进回复，并等代码写完再收尾')
}
const qwenFullDelta = qwenBridge.extractReplyDelta(
  {
    count: 2,
    markdown: '这一轮我计划先为你补齐 `0025/script.js`。同时，进行细节打磨。\n\n```html\nD:/小说/0025/index.html\n<!DOCTYPE html>\n```',
    innerText: '这一轮我计划先为你补齐 0025/script.js。同时，进行细节打磨。'
  },
  { count: 1, markdown: '上一轮完整回复', innerText: '上一轮完整回复' }
)
if (!String(qwenFullDelta.markdown || '').includes('这一轮我计划先为你补齐') || !String(qwenFullDelta.markdown || '').includes('index.html')) {
  throw new Error('场景21 Qwen 新气泡应返回全文，不能只留尾巴')
}
const qwenFenceReply = [
  '这一轮我计划先为你补齐 `0025/script.js`，实现彩蛋按钮的趣味交互。同时，我将对现有的 `index.html` 和 `style.css` 进行细节打磨。',
  '```html',
  'D:/小说/0025/index.html',
  '<!DOCTYPE html>',
  '<html lang="zh"><body>卡通个人介绍</body></html>',
  '```',
  '```css',
  'D:/小说/0025/style.css',
  'body{margin:0}',
  '```',
  '```javascript',
  'D:/小说/0025/script.js',
  'console.log("ok")',
  '```'
].join('\n')
const parsedQwenFences = qwenBridge.parseLingxiToolCalls(qwenFenceReply, codingTools)
if (parsedQwenFences.length) {
  throw new Error('场景21 Qwen 普通代码块不能当成 write_file，必须打回要工具协议')
}
const qwenPrompt = qwenBridge.buildWebChatPrompt({
  messages: [{ role: 'user', content: '补齐 0025/script.js 的彩蛋按钮\n当前项目路径：D:/小说/0025' }],
  tools: codingTools
})
if (qwenPrompt.includes('用代码块包住') || qwenPrompt.includes('语言标记后面写路径') || qwenPrompt.includes('下面会贴上当前项目文件')) {
  throw new Error('场景21 Qwen 不能再教网页用代码块交文件')
}
if (!qwenPrompt.includes('调用标签') && !qwenPrompt.includes('<LINGXI_TOOL_CALLS>')) {
  throw new Error('场景21 Qwen 提示应走工具协议')
}
const qwenProtocol = require('../../../electron/modules/web-bridge-coding-protocol')
if (!qwenProtocol.looksLikeWebBridgeFileWrite(qwenFenceReply)) {
  throw new Error('场景21 带路径的页面代码块应识别成未走协议')
}
if (!qwenProtocol.shouldNudgeWebBridgeForMissingTools({
  userText: '补齐 0025/script.js 的彩蛋按钮\n当前项目路径：D:/小说/0025',
  content: qwenFenceReply
})) {
  throw new Error('场景21 Qwen 用代码块交文件后应催它改输出工具协议')
}
const qwenRetry = qwenProtocol.buildWebToolProtocolRetryPrompt('网页模型用普通代码块交文件，未输出调用标签。', {
  fileFence: true,
  projectPath: 'D:/小说/0025'
})
if (!qwenRetry.includes('<LINGXI_TOOL_CALLS>') || !qwenRetry.includes('write_file') || qwenRetry.includes('用代码块包住')) {
  throw new Error('场景21 Qwen 重试应只要调用标签，不要再要代码块')
}
const qwenXmlReply = [
  '<file_manage>{"action":"create_directory","path":"D:/小说/0025"}</file_manage>',
  '<write_file>{"path":"D:/小说/0025/index.html","content":"<!DOCTYPE html><html lang=\'zh-CN\'><head><meta charset=\'UTF-8\'><title>卡通个人主页</title><style>body{margin:0}</style></head><body><h1>小圆同学</h1><script>document.getElementById(\'year\').textContent=2026;</script></body></html>"}</write_file>',
  '<file_read>{"path":"D:/小说/0025/index.html"}</file_read>'
].join('\n')
const qwenXmlTools = codingTools.concat([
  { type: 'function', function: { name: 'file_manage', parameters: {} } }
])
const parsedQwenXml = qwenBridge.parseLingxiToolCalls(qwenXmlReply, qwenXmlTools)
if (parsedQwenXml.length !== 3 || parsedQwenXml[0].function.name !== 'file_manage' || parsedQwenXml[1].function.name !== 'write_file' || parsedQwenXml[2].function.name !== 'file_read') {
  throw new Error('场景21 Qwen 的 <write_file> 标签应收成工具调用，实际: ' + parsedQwenXml.map(call => call.function.name).join(','))
}
const qwenXmlWrite = JSON.parse(parsedQwenXml[1].function.arguments)
if (!String(qwenXmlWrite.content || '').includes('<!DOCTYPE html>') || !String(qwenXmlWrite.content || '').includes('<html') || !String(qwenXmlWrite.content || '').includes('小圆同学')) {
  throw new Error('场景21 Qwen write_file 的 HTML 原文不能被抓丢')
}
if (String(qwenXmlWrite.content || '').includes('🐱') && !String(qwenXmlWrite.content || '').includes('<style>')) {
  throw new Error('场景21 不能把 HTML 渲染成可见文字再当文件内容')
}
const mdSource = require('fs').readFileSync(require('path').join(__dirname, '../../../electron/modules/web-bridge-dom-markdown.js'), 'utf8')
if (!mdSource.includes('collectXmlToolCalls') || !mdSource.includes('recoverXmlToolArgs') || !mdSource.includes('isWebToolTag')) {
  throw new Error('场景21 抓取必须从 DOM 还原 <write_file> 里被浏览器吃掉的 HTML')
}
if (!mdSource.includes('collectFosteredHtml') || !mdSource.includes('collectPathLabeledCodeWrites') || !mdSource.includes('stripLeadingLineNumbers')) {
  throw new Error('场景21 抓取应还原被寄养的 HTML，并丢掉代码块行号')
}
const qwenMangled = [
  'D:/小说/0025create_directoryD:/小说/0025/index.html      卡通个人主页',
  '1',
  '2',
  '3',
  '<section class="about"><h2>关于我</h2></section>jsD:/小说/0025/style.css:root { --bg-1: #ffe8f2; }',
  'D:/小说/0025/script.jsconst avatar = document.getElementById("avatar"); avatar.addEventListener("click", () => {});'
].join('\n')
if (!qwenProtocol.looksLikeWebBridgeMangledFileDump(qwenMangled)) {
  throw new Error('场景21 被浏览器拆碎的文件残片应识别成未走协议')
}
if (qwenBridge.parseLingxiToolCalls(qwenMangled, qwenXmlTools).length) {
  throw new Error('场景21 文件残片不能直接当成已经成功的工具调用')
}
if (!qwenProtocol.shouldNudgeWebBridgeForMissingTools({
  userText: '做个卡通个人介绍页\n当前项目路径：D:/小说/0025',
  content: qwenMangled
})) {
  throw new Error('场景21 文件残片不能当最终回复，应催工具协议')
}
if (qwenProtocol.classifyWebBridgeAssistantReply(qwenMangled, {
  userText: '做个卡通个人介绍页\n当前项目路径：D:/小说/0025',
  hadToolsThisTurn: false
}) !== 'continue') {
  throw new Error('场景21 文件残片应继续要协议，不能当 final')
}
const arenaXml = [
  '<file_manage>',
  '<action>create_directory</action>',
  '<path>D:/页面测试/0045</path>',
  '</file_manage>'
].join('\n')
const arenaXmlTools = codingTools.concat([
  { type: 'function', function: { name: 'file_manage', parameters: {} } }
])
const parsedArenaXml = arenaBridge.parseLingxiToolCalls(arenaXml, arenaXmlTools)
if (parsedArenaXml.length !== 1 || parsedArenaXml[0].function.name !== 'file_manage') {
  throw new Error('场景21 Arena 嵌套 XML 工具标签应收成 file_manage')
}
const arenaXmlArgs = JSON.parse(parsedArenaXml[0].function.arguments)
if (arenaXmlArgs.action !== 'create_directory' || String(arenaXmlArgs.path || '').replace(/\\/g, '/') !== 'D:/页面测试/0045') {
  throw new Error('场景21 Arena XML 的 action/path 应保留: ' + JSON.stringify(arenaXmlArgs))
}
const arenaBareDump = 'create_directory\nD:/页面测试/0045'
if (arenaBridge.parseLingxiToolCalls(arenaBareDump, arenaXmlTools).length) {
  throw new Error('场景21 没有标签的残片不能直接当成已成功调用')
}
if (!qwenProtocol.looksLikeWebBridgeBareToolDump(arenaBareDump)) {
  throw new Error('场景21 Arena 把 create_directory 和路径渲染成正文时应识别成未走协议')
}
if (qwenProtocol.classifyWebBridgeAssistantReply(arenaBareDump, {
  userText: '新建目录\n当前项目路径：D:/页面测试/0045',
  hadToolsThisTurn: false
}) !== 'continue') {
  throw new Error('场景21 Arena 工具残片不能当最终回复')
}
if (arenaBridge.looksLikeArenaHumanChallenge({ visibleWidget: true })) {
  throw new Error('场景21 常驻 recaptcha 勾选框不能当成弹出验证')
}
if (arenaBridge.looksLikeArenaHumanChallenge({ visibleText: true })) {
  throw new Error('场景21 I\'m not a robot 文案不能当成弹出验证')
}
if (!arenaBridge.looksLikeArenaHumanChallenge({ challengePopup: true })) {
  throw new Error('场景21 验证弹窗应识别为人机验证')
}
if (!arenaBridge.looksLikeArenaHumanChallenge({ visibleChallengeText: true })) {
  throw new Error('场景21 验证拦截文案应识别为人机验证')
}
if (arenaBridge.looksLikeArenaHumanChallenge({ hiddenRecaptchaOnly: true })) {
  throw new Error('场景21 隐藏 g-recaptcha-response 不能当成弹出了验证')
}
if (arenaBridge.looksLikeArenaHumanChallenge({})) {
  throw new Error('场景21 空页面状态不能当成弹出了验证')
}
const arenaSource = require('fs').readFileSync(require('path').join(__dirname, '../../../electron/modules/arena-web-bridge.js'), 'utf8')
if (!arenaSource.includes('waitForArenaHumanChallenge')) {
  throw new Error('场景21 Arena 必须等人点完人机验证再续跑')
}
if (!arenaSource.includes('HUMAN_CHALLENGE_HEADLESS')) {
  throw new Error('场景21 无头模式遇到验证必须明确提示打开显示浏览器')
}
if (arenaSource.includes('grecaptcha.execute') || arenaSource.includes('bypassCaptcha')) {
  throw new Error('场景21 不得自动绕过人机验证')
}
if (!arenaSource.includes('composerAlreadyHoldsPrompt')) {
  throw new Error('场景21 Arena 输入框已有同一段文字时应跳过重填')
}
if (!arenaSource.includes('busyRoot') || !arenaSource.includes('noteArenaReplyGrowth') || !arenaSource.includes('followUp')) {
  throw new Error('场景21 Arena 第一句应立刻填框，续写才等对方写完')
}
if (!arenaSource.includes('bframe') || /i\['’\]\?m not a robot/.test(arenaSource)) {
  throw new Error('场景21 人机验证只能认弹窗，不能把 I\'m not a robot 当拦截')
}
const { isChatGptWebBridgeModel } = require('../../../electron/modules/capability-tiers.js')
if (!isChatGptWebBridgeModel({ provider: 'arena-web-bridge' }, 'arena-web-chat')) {
  throw new Error('场景21 Arena 应走网页桥宽松写协议')
}
if (!isChatGptWebBridgeModel({ provider: 'qwen-web-bridge' }, 'qwen-web-chat')) {
  throw new Error('场景21 Qwen 应走网页桥宽松写协议')
}
const profileHelper = require('../../../electron/modules/web-bridge-chrome-profile.js')
if (!profileHelper.SHARED_DEBUG_PORTS.includes(19327) || !profileHelper.SHARED_DEBUG_PORTS.includes(19332) || !profileHelper.SHARED_PROFILE_NAME.includes('lingxi-web-chrome-profile')) {
  throw new Error('场景21 共用资料目录配置不完整')
}
const claudeSource = require('fs').readFileSync(require('path').join(__dirname, '../../../electron/modules/claude-web-bridge.js'), 'utf8')
if (!claudeSource.includes("https://claude.ai/new")) throw new Error('场景21 缺少 claude.ai 新对话页')
if (!claudeSource.includes('isClaudeConversationUrl') || !claudeSource.includes('claude.ai')) {
  throw new Error('场景21 缺少 Claude 对话 URL')
}
if (!claudeSource.includes('div.ProseMirror[contenteditable="true"]')) throw new Error('场景21 缺少 Claude ProseMirror 输入框')
if (!claudeSource.includes('aria-label="Send Message"') && !claudeSource.includes('aria-label="Send message"')) {
  throw new Error('场景21 缺少 Claude 发送按钮')
}
if (!claudeSource.includes('insertContent')) throw new Error('场景21 Claude 输入框应走 ProseMirror insertContent')
if (claudeSource.includes("pathname === '/v1/images/generations'")) throw new Error('场景21 Claude 网页桥不应带生图接口')

const {
  nextWebGenerationIdleTicks,
  noteWebGenerationStarted,
  shouldAcceptStoppedWebReply,
  throwIfWebChatAborted,
  attachWebChatAbort
} = require('../../../electron/modules/web-bridge-coding-protocol')
if (nextWebGenerationIdleTicks({ generating: true }, 4) !== 0) {
  throw new Error('场景19 仍在生成时 idleTicks 必须清零')
}
if (nextWebGenerationIdleTicks({ generating: false }, 0) !== 1) {
  throw new Error('场景19 停止后 idleTicks 应累加')
}
if (nextWebGenerationIdleTicks({ generating: false }, 2) !== 3) {
  throw new Error('场景19 连续空闲应继续累加')
}
if (noteWebGenerationStarted({ generating: false }, false) !== false) {
  throw new Error('场景19 首次发送时页面空闲不能当成已经开始生成')
}
if (noteWebGenerationStarted({ generating: true, stale: true }, false) !== false) {
  throw new Error('场景19 读页失败的占位状态不能当成已经开始生成')
}
if (noteWebGenerationStarted({ generating: true }, false) !== true) {
  throw new Error('场景19 真正进入生成后应记下 sawGenerating')
}
if (shouldAcceptStoppedWebReply(5, 3) !== false) {
  throw new Error('场景19 没见过生成就开始收尾，会把第一次发送判成空回复')
}
if (shouldAcceptStoppedWebReply(2, 3, true) !== false) throw new Error('场景19 思考间隙 2 拍不应提前收尾')
if (shouldAcceptStoppedWebReply(3, 3, true) !== true) throw new Error('场景19 见过生成后再连续空闲才收尾')
let aborted = false
try { throwIfWebChatAborted({ aborted: true }) } catch (error) { aborted = error.code === 'CHAT_ABORTED' }
if (!aborted) throw new Error('场景19 软件端中断应抛 CHAT_ABORTED')
throwIfWebChatAborted(null)
throwIfWebChatAborted({ aborted: false })

const {
  FINAL_OPEN,
  FINAL_CLOSE,
  STAGE_OPEN,
  STAGE_CLOSE,
  extractWebBridgeFinalReply,
  extractWebBridgeStageNote,
  stripWebBridgeStageMarkers,
  stripWebBridgeFinalMarkers,
  buildWebBridgeFinalReplyConstraint,
  normalizeWebBridgeFinalBody,
  classifyWebBridgeAssistantReply,
  shouldAcceptWebBridgeFinalReply,
  buildWebBridgeBlockingWriteFixPrompt,
  buildWebBridgeStageFinalRejectPrompt,
  webBridgeInspectNeedsMore,
  buildWebBridgeInspectKeepGoingPrompt,
  buildWebBridgeKeepGoingPrompt,
  buildWebBridgeStageReplyPrompt,
  buildWebBridgeOpeningStagePrompt,
  buildWebBridgeCompleteStepPrompt,
  shouldRequestWebBridgeStage,
  shouldHoldWebBridgeToolsForOpeningStage,
  shouldParkWebBridgeOpeningStageFromText,
  didWebPromptLeaveComposer,
  looksLikeWebBridgeChitchat,
  looksLikeWebBridgeChitchatReply,
  looksLikeWebBridgeDumpedPrompt,
  stripWebBridgeDumpedPrompt,
  sanitizeWebBridgeCapturedReply,
  hasClosedWebBridgeFinalCipher,
  looksLikeWebBridgeCapturedUserQuestion,
  looksLikeWebBridgeInspectQuestion,
  looksLikeWebBridgeDirectEditTask,
  looksLikeWebBridgeConfirmStall,
  isWebBridgeReadOnlyToolBatch,
  shouldSkipWebBridgeStageForExecute,
  shouldPromoteWebBridgeTextToFinal,
  shouldNudgeWebBridgeForMissingTools,
  looksLikeWebBridgeHallucinatedWork,
  looksLikeWebBridgeFuturePlan,
  looksLikeWebBridgeRestatedCharter,
  looksLikeWebBridgePlanToolName,
  isWebBridgePlanToolBatch,
  canSendWebChatPromptMessages,
  hasWebBridgeSendableSourceMessage,
  WEB_BRIDGE_STAGE_EVERY,
  WEB_BRIDGE_DIALECT_JSON_FENCE,
  assembleWebPagePrompt,
  assertWebBridgeHtmlDocument,
  inspectWebBridgeHtmlDocument,
  collectUnresolvedBlockingWebBridgeWriteDiagnostics,
  formatLingxiWebChatTranscript,
  isStaleWebBridgeHarvest,
  extractWebBridgeReplyDelta,
  rewriteWebBridgeDemoPaths,
  isWebBridgeDemoExamplePath,
  isWebBridgeNoToolsRefusal,
  buildWebBridgeNoToolsNudgePrompt,
  dropRepeatedWebBridgeSearchCalls,
  normalizeWebToolCallArgs,
  resolveWebBridgeApiMode,
  WEB_BRIDGE_MODE_LINGXI,
  WEB_BRIDGE_MODE_PASSTHROUGH,
  parsePassthroughWebToolCalls,
  getWebBridgeAgentLane,
  buildWebChatSessionKey,
  pickReusableWebChatPage
} = require('../../../electron/modules/web-bridge-coding-protocol')
const tagged = `阶段说明\n${FINAL_OPEN}\n整体升级完成，hero 和光晕都已加上。\n${FINAL_CLOSE}`
const extractedFinal = extractWebBridgeFinalReply(tagged)
if (!extractedFinal.done) throw new Error('场景20 完成标记应被识别')
if (!extractedFinal.body.includes('整体升级完成')) throw new Error('场景20 应收出标记内正文')
if (extractedFinal.body.includes(FINAL_OPEN) || extractedFinal.visible.includes(FINAL_OPEN)) {
  throw new Error('场景20 标记不能留在正文或阶段说明里')
}
if (stripWebBridgeFinalMarkers(`${FINAL_OPEN}收尾${FINAL_CLOSE}`).includes('LINGXI_FINAL')) {
  throw new Error('场景20 给用户的最终回复必须去掉标记')
}
const constraint = buildWebBridgeFinalReplyConstraint()
if (!constraint.includes(FINAL_OPEN) || !constraint.includes(STAGE_OPEN) || !constraint.includes('不要混用')) {
  throw new Error('场景20 应约定最终回复暗号，且与阶段性暗号分开')
}
const wrappedFinal = [
  '<LINGXI_FINAL>',
  '当前项目是一个前端个人作品展示网站，路径',
  'E:/灵犀-11/03/自迭代/05/测试00 下主要内容如下：',
  '',
  '- index.html：网站主页面，是一个名为 “LIU YU · Cartoon',
  '  Portfolio” 的创意个人作品集。页面包含顶部导航、Hero',
  '  介绍区和项目卡片。',
  '- style.css：全站视觉样式，定义奶油色背景和卡片布局。',
  '</LINGXI_FINAL>'
].join('\n')
const unwrapped = extractWebBridgeFinalReply(wrappedFinal)
if (!unwrapped.done) throw new Error('场景20 带预折行的完成标记也应识别')
if (unwrapped.body.split('\n').some(line => /Cartoon$/.test(line.trim()))) {
  throw new Error('场景20 最终回复不应把网页预折行原样带进软件')
}
if (!unwrapped.body.includes('Cartoon Portfolio') || !unwrapped.body.includes('- style.css：')) {
  throw new Error('场景20 最终回复应拼回完整句子，并保留列表分行')
}
if (normalizeWebBridgeFinalBody('先看首页\n再改光晕。') !== '先看首页再改光晕。') {
  throw new Error('场景20 中文预折行应直接拼回')
}
const capturedTable = [
  '| 文件 | 问题 |',
  '| --- | --- |',
  '| index.html | 字体链接 |',
  '| style.css | 注释写法 |'
].join('\n')
if (normalizeWebBridgeFinalBody(capturedTable) !== capturedTable) {
  throw new Error('场景20 软件端抓取最终回复时不能把表格行拼掉: ' + normalizeWebBridgeFinalBody(capturedTable))
}
const fencedCapturedTable = [
  '对比如下：',
  '```html',
  '<table><tr><th>文件</th><th>问题</th></tr><tr><td>index.html</td><td>字体</td></tr></table>',
  '```'
].join('\n')
const unfencedTable = normalizeWebBridgeFinalBody(fencedCapturedTable)
if (!unfencedTable.includes('| 文件 | 问题 |') || !unfencedTable.includes('| index.html | 字体 |') || unfencedTable.includes('```')) {
  throw new Error('场景20 代码创建的表格应同步成软件端表格: ' + unfencedTable)
}
const groupedFinal = [
  '<LINGXI_FINAL>',
  '整体能跑，主要问题在样式和脚本。',
  '',
  '- style.css：注释不规范；blur 过重。',
  '- index.html：SVG 重复；动画 class 不一致。',
  '- script.js：滚动监听可改 requestAnimationFrame。',
  '</LINGXI_FINAL>'
].join('\n')
const grouped = extractWebBridgeFinalReply(groupedFinal)
if (!grouped.body.includes('- style.css：') || grouped.body.split('\n').filter(Boolean).length < 4) {
  throw new Error('场景20 按文件分组的最终回复不应被拼成一段')
}
if ((grouped.body.match(/style\.css/g) || []).length !== 1) {
  throw new Error('场景20 每个文件名在最终回复里应只点名一次')
}
if (classifyWebBridgeAssistantReply(tagged, { hadToolsThisTurn: true }) !== 'final') {
  throw new Error('场景20 看到完成标记必须收尾')
}
if (classifyWebBridgeAssistantReply('补丁已应用，这一步完成。', { hadToolsThisTurn: true, userText: '升级页面' }) !== 'final') {
  throw new Error('场景20 没有完成标记的实质回复也应作为最终回复抓到软件端')
}
const stageTagged = `${STAGE_OPEN}刚看完入口 index.html，下一步按计划改 hero 光晕。${STAGE_CLOSE}`
const extractedStage = extractWebBridgeStageNote(stageTagged)
if (!extractedStage.found || !extractedStage.note.includes('index.html') || extractedStage.rest) {
  throw new Error('场景20 应抽出阶段性暗号里的正文，不要留标签')
}
if (classifyWebBridgeAssistantReply(stageTagged, { hadToolsThisTurn: true, userText: '升级页面' }) !== 'continue') {
  throw new Error('场景20 带阶段性暗号的说明不能当最终回复')
}
if (classifyWebBridgeAssistantReply(stageTagged, { hadToolsThisTurn: false, userText: '升级页面', stageTurn: true }) !== 'continue') {
  throw new Error('场景20 进度轮即使没调工具也不能把阶段性说明收成终稿')
}
const finalDuringStage = `${FINAL_OPEN}检查已经完成，没有独立的最终回复模板。${FINAL_CLOSE}`
if (classifyWebBridgeAssistantReply(finalDuringStage, { hadToolsThisTurn: true, userText: '升级页面', stageTurn: true }) !== 'continue') {
  throw new Error('场景20 进度轮里误发最终暗号必须驳回，不能直接收尾')
}
if (shouldNudgeWebBridgeForMissingTools({ userText: '当前项目有什么内容', content: finalDuringStage })) {
  throw new Error('场景20 已有最终暗号时不要再催工具协议')
}
const quotedProtocolFinal = `${FINAL_OPEN}现在的问题是阶段性说明已经记下之后会强制 complete_step，每满 4 个调用就推进计划。这两个状态应该解耦。${FINAL_CLOSE}`
if (!extractWebBridgeFinalReply(quotedProtocolFinal).done) {
  throw new Error('场景20 最终暗号里即使提到协议词也应收尾')
}
if (classifyWebBridgeAssistantReply(quotedProtocolFinal, { hadToolsThisTurn: true, stageTurn: true, userText: '升级页面' }) !== 'continue') {
  throw new Error('场景20 进度轮误发最终暗号必须驳回并继续要求阶段性说明')
}
const fourToolReviewFinal = `${FINAL_OPEN}核查结论：阶段说明输出后没有自动推进。本轮还实际经历了证据不足时继续当前步骤，没有因为“四个工具”直接强制推进计划步骤。${FINAL_CLOSE}`
if (isWebBridgeNoToolsRefusal(fourToolReviewFinal)) {
  throw new Error('场景20 讨论四个工具次数不应当成没有工具')
}
if (!extractWebBridgeFinalReply(fourToolReviewFinal).done) {
  throw new Error('场景20 审查结论里提到四个工具也应按最终暗号收尾')
}
if (classifyWebBridgeAssistantReply(fourToolReviewFinal, { hadToolsThisTurn: true, userText: '核对修复' }) !== 'final') {
  throw new Error('场景20 第一次最终暗号就必须收尾，不能再塞工具协议')
}
if (looksLikeWebBridgeDumpedPrompt(fourToolReviewFinal)) {
  throw new Error('场景20 包了最终暗号的审查结论不能当成提示词回灌')
}
const entityFinal = extractWebBridgeFinalReply('&lt;LINGXI_FINAL&gt;收尾完成。&lt;/LINGXI_FINAL&gt;')
if (!entityFinal.done || !entityFinal.body.includes('收尾完成')) {
  throw new Error('场景20 网页转义后的最终暗号也应识别')
}
const spacedFinal = extractWebBridgeFinalReply('< LINGXI_FINAL >收尾完成。</ LINGXI_FINAL >')
if (!spacedFinal.done || !spacedFinal.body.includes('收尾完成')) {
  throw new Error('场景20 最终暗号应允许标签内空白')
}
if (shouldPromoteWebBridgeTextToFinal({ userText: '当前项目有什么内容', text: stageTagged })) {
  throw new Error('场景20 带阶段性暗号的查看说明不能提升为最终回复')
}
if (!clipWebBridgeThinkingNote(stageTagged).includes('index.html')) {
  throw new Error('场景20 阶段性暗号应进入思考块')
}
if (normalizeWebBridgeFinalBody(`${stageTagged}\n首页已经改好。`).includes('LINGXI_STAGE')) {
  throw new Error('场景20 最终回复里不能留下阶段性暗号')
}
if (!normalizeWebBridgeFinalBody(`${stageTagged}\n首页已经改好。`).includes('首页已经改好')) {
  throw new Error('场景20 去掉阶段性暗号后应留下真正给用户的正文')
}
const inspectAnswer = '我已查看项目主要文件。index.html 是 LIU YU 卡通个人作品集，style.css 负责奶油色视觉，script.js 处理导航和卡片交互。当前状态：结构完整，可继续优化。'
if (!looksLikeWebBridgeInspectQuestion('当前项目有什么内容')) {
  throw new Error('场景20 应识别查看项目内容的提问')
}
if (!looksLikeWebBridgeInspectQuestion('当前项目是什么内容')) {
  throw new Error('场景20 应识别“当前项目是什么内容”')
}
if (looksLikeWebBridgeInspectQuestion('帮我升级首页样式')) {
  throw new Error('场景20 改页面不应当成只看不问')
}
if (!looksLikeWebBridgeInspectQuestion('深入查看这个项目')) {
  throw new Error('场景20 应识别深入查看项目')
}
if (!shouldPromoteWebBridgeTextToFinal({ userText: '当前项目有什么内容', text: inspectAnswer })) {
  throw new Error('场景20 看完项目后的说明应直接当最终回答')
}
if (classifyWebBridgeAssistantReply(inspectAnswer, {
  hadToolsThisTurn: true,
  userText: '当前项目有什么内容'
}) !== 'final') {
  throw new Error('场景20 用户问项目有什么内容时，读完文件就应收尾')
}
const fakeProjectAnswer = '当前项目（位于 D:/小说）主要是一个小说创作与网页测试混合的项目。根据目录结构，它包含大纲、角色、设定。'
if (!looksLikeWebBridgeHallucinatedWork(fakeProjectAnswer)) {
  throw new Error('场景20 应识别没调工具却编造目录结构')
}
if (!shouldNudgeWebBridgeForMissingTools({
  userText: '你觉得这个项目还有什么可改进优化的吗啊\n当前项目路径：D:/小说',
  content: fakeProjectAnswer
})) {
  throw new Error('场景20 幻觉完成时应催它先输出调用标签')
}
if (classifyWebBridgeAssistantReply(fakeProjectAnswer, {
  hadToolsThisTurn: false,
  userText: '你觉得这个项目还有什么可改进优化的吗啊\n当前项目路径：D:/小说'
}) !== 'continue') {
  throw new Error('场景20 没调工具的幻觉回答不能当最终结果')
}
if (classifyWebBridgeAssistantReply(inspectAnswer, {
  hadToolsThisTurn: false,
  userText: '当前项目有什么内容'
}) !== 'continue') {
  throw new Error('场景20 没读文件就说看完了应继续催工具')
}
if (shouldNudgeWebBridgeForMissingTools({
  userText: '当前项目是什么内容\n当前项目路径：D:/小说',
  content: '这一轮我会先看目录结构，再决定从哪一页开始改。'
}) !== true) {
  throw new Error('场景20 只写下一步计划时应催 confirm_plan，不要当最终回复')
}
if (classifyWebBridgeAssistantReply('当前没有新的文件查看或修改需求，等待下一步具体调整内容。', {
  hadToolsThisTurn: true,
  userText: '当前项目有什么内容'
}) !== 'final') {
  throw new Error('场景20 模型说没有下一步时不要再催工具')
}
if (classifyWebBridgeAssistantReply('随便聊聊', { hadToolsThisTurn: false }) !== 'final') {
  throw new Error('场景20 没调过工具的闲聊不要强求完成标记')
}
const noToolsFinal = `${FINAL_OPEN}当前会话未提供 file_manage、shell_run 等用户指定的项目工具接口，因此不能伪造工具调用或执行结果。${FINAL_CLOSE}`
if (extractWebBridgeFinalReply(noToolsFinal).done) {
  throw new Error('场景20 说没有工具的完成标记不能当成收尾')
}
if (classifyWebBridgeAssistantReply(noToolsFinal, { hadToolsThisTurn: false }) !== 'continue') {
  throw new Error('场景20 说没有工具时应继续催它调工具')
}
if (!isWebBridgeNoToolsRefusal('当前会话没有可用的项目文件浏览工具')) {
  throw new Error('场景20 应识别没有工具的推脱')
}
if (!isWebBridgeNoToolsRefusal('我无法执行或伪造一个会在你的电脑上运行的工具调用协议。当前对话中没有实际连接的项目操作工具可供调用。')) {
  throw new Error('场景20 应识别无法执行或伪造的推脱')
}
if (shouldParkWebBridgeOpeningStageFromText({
  openedStage: false,
  hasToolCalls: false,
  hasFinal: false,
  text: '我不能输出一个会被误认为已连接并执行的工具调用协议。'
}) !== false) {
  throw new Error('场景20 说没有工具的推脱不能记进思考块')
}
if (shouldParkWebBridgeOpeningStageFromText({
  openedStage: false,
  hasToolCalls: false,
  hasFinal: false,
  text: '你好！我很好，谢谢关心 😊 你今天怎么样？',
  userText: '你好'
}) !== false) {
  throw new Error('场景20 打招呼回复不应记进思考块再催工具')
}
if (!looksLikeWebBridgeChitchatReply('你好！我很好，谢谢关心 😊 你今天怎么样？')) {
  throw new Error('场景20 应识别打招呼回复')
}
if (!looksLikeWebBridgeChitchat('你还好吗\n当前项目路径：E:/demo')) {
  throw new Error('场景20 应识别「你还好吗」为闲聊')
}
const howAreYouReply = 'Hi, I\'m fine, thanks for asking! 你也还好吗？你刚才只是打了个招呼，我先保持闲聊，先不碰文件。'
if (!looksLikeWebBridgeChitchatReply(howAreYouReply)) {
  throw new Error('场景20 「你还好吗」的闲聊回复应识别')
}
if (shouldParkWebBridgeOpeningStageFromText({
  openedStage: false,
  hasToolCalls: false,
  hasFinal: false,
  text: howAreYouReply,
  userText: '你还好吗\n当前项目路径：E:/demo'
}) !== false) {
  throw new Error('场景20 「你还好吗」不应记进思考块再催工具')
}
if (classifyWebBridgeAssistantReply(howAreYouReply, { userText: '你还好吗', hadToolsThisTurn: false }) !== 'final') {
  throw new Error('场景20 「你还好吗」应直接当最终回复')
}
const dumpedCapture = [
  '用户只是打招呼或闲聊。直接用自然语言回复。',
  '--- 用户 19 ---',
  '你好',
  '这是闲聊。直接用自然语言回复用户，不要提工具、协议或项目文件。',
  '',
  '你好啊！ 😄 今天过得怎么样？有什么想聊的，或者有什么需要帮忙的，尽管说～'
].join('\n')
if (!looksLikeWebBridgeDumpedPrompt(dumpedCapture)) {
  throw new Error('场景20 应识别网页上的提示词回声')
}
if (stripWebBridgeDumpedPrompt(dumpedCapture) !== '你好啊！ 😄 今天过得怎么样？有什么想聊的，或者有什么需要帮忙的，尽管说～') {
  throw new Error('场景20 应从回声里抽出页面上的真实回复: ' + stripWebBridgeDumpedPrompt(dumpedCapture))
}
if (stripWebBridgeDumpedPrompt('用户只是打招呼或闲聊。直接用自然语言回复。\n你好\n这是闲聊。直接用自然语言回复用户，不要提工具、协议或项目文件。')) {
  throw new Error('场景20 只有提示词回声时不应当成回复')
}
const leakedStageDump = [
  '已满 4 个调用。现在输出这一轮的阶段性说明，并调用 complete_step。不要复述本段指令。',
  '阶段性说明只写：刚做完了已确认的 confirm_plan 里哪一步、依据（文件名/测试名/指标）、下一步是哪一条。用自己的话即可，不必套固定句式；尽量 200 字内。',
  '不要重写总目标，不要写“这一轮继续深挖”或“下一步会再对照文档”。',
  'complete_step 的 step_index 从 0 起，带上全部 steps。还要看或改文件时再填写调用标签。已经能按计划收尾就直接写给用户看。',
  '',
  '<LINGXI_TOOL_CALLS>{"calls":[{"name":"complete_step","arguments":{"step_index":1,"steps":["定位入口"]}}]}</LINGXI_TOOL_CALLS>'
].join('\n')
if (!looksLikeWebBridgeDumpedPrompt(leakedStageDump)) {
  throw new Error('场景20 应识别满 4 个调用后的阶段性催促回声')
}
const strippedStageDump = stripWebBridgeDumpedPrompt(leakedStageDump)
if (!strippedStageDump.includes('complete_step') || strippedStageDump.includes('已满 4 个调用') || strippedStageDump.includes('阶段性说明只写')) {
  throw new Error('场景20 催促回声应只留下 complete_step: ' + strippedStageDump)
}
if (clipWebBridgeThinkingNote(leakedStageDump)) {
  throw new Error('场景20 催促回声不能当成思考区阶段性说明')
}
if (classifyWebBridgeAssistantReply(leakedStageDump, {
  hadToolsThisTurn: true,
  userText: '查看此目录内容并判断数据脑成熟度'
}) === 'final') {
  throw new Error('场景20 催促回声不能当成给用户的终稿')
}
const splashQuestion = '当前项目为什么时不时会出现首屏启动动画'
if (!looksLikeWebBridgeCapturedUserQuestion(splashQuestion)) {
  throw new Error('场景20 应识别被误抓的用户问题')
}
if (classifyWebBridgeAssistantReply(splashQuestion, {
  hadToolsThisTurn: false,
  userText: '查看此目录内容并判断数据脑成熟度'
}) === 'final') {
  throw new Error('场景20 误抓的用户问题不能当成终稿')
}
const pickedLeakedStage = arenaBridge.pickArenaReplyFromLeaves([
  { text: splashQuestion },
  { text: leakedStageDump },
  { text: '刚核对完入口文件，下一步读核心源码。' }
], {
  sentPrompt: buildWebBridgeStageReplyPrompt(),
  baselineLeaves: [{ text: '刚核对完入口文件，下一步读核心源码。' }]
})
if (!pickedLeakedStage.text.includes('complete_step') || pickedLeakedStage.text.includes('首屏') || pickedLeakedStage.text.includes('已满 4 个调用')) {
  throw new Error('场景20 Arena 应从催促回声里只抓住 complete_step，不要抓用户问题: ' + pickedLeakedStage.text)
}
if (sanitizeWebBridgeCapturedReply(splashQuestion)) {
  throw new Error('场景20 误抓的用户问题应被丢掉')
}
const arenaEchoDelta = arenaBridge.extractReplyDelta({
  leaves: [
    { text: dumpedCapture },
    { text: '你好啊！ 😄 今天过得怎么样？有什么想聊的，或者有什么需要帮忙的，尽管说～' }
  ]
}, { leaves: [{ text: dumpedCapture }] })
if (arenaEchoDelta.markdown !== '你好啊！ 😄 今天过得怎么样？有什么想聊的，或者有什么需要帮忙的，尽管说～') {
  throw new Error('场景20 Arena 抓取应丢掉提示词回声: ' + arenaEchoDelta.markdown)
}
const pickedArena = arenaBridge.pickArenaReplyFromLeaves([
  { text: '用户只是打招呼或闲聊。直接用自然语言回复。' },
  { text: '你好' },
  { text: '你好啊！ 😄 今天过得怎么样？有什么想聊的，或者有什么需要帮忙的，尽管说～' }
], { sentPrompt: '你好', baselineLeaves: [{ text: '用户只是打招呼或闲聊。直接用自然语言回复。' }] })
if (!pickedArena.text.includes('你好啊')) {
  throw new Error('场景20 Arena 应从多个 prose 里挑新增的助手回复')
}
if (arenaBridge.pickArenaReplyFromLeaves([
  { text: '--- 系统要求 1 ---' }
], { sentPrompt: '你好' }).text) {
  throw new Error('场景20 只有提示词回声时不能当成助手回复')
}
if (!arenaSource.includes('inspectArenaReplyDom') || arenaSource.includes('pageHasArenaPromptEcho')) {
  throw new Error('场景20 Arena 应抓页面新增回复，不要因为旧提示词就新开对话')
}
if (!arenaSource.includes('inThinking') || !arenaSource.includes('Deep Thinking')) {
  throw new Error('场景20 Arena 抓取必须跳过 Deep Thinking / 深度思考块')
}
if (/if \(state\.generating\) await stopPageGeneration/.test(arenaSource)) {
  throw new Error('场景20 Arena 不能为了填输入框而停掉还在生成的回复')
}
if (!arenaSource.includes('不能抢输入框') || !arenaSource.includes('state.busy')) {
  throw new Error('场景20 Arena 生成中必须等回复结束再填输入框')
}
if (!arenaSource.includes('ARENA_MIN_MS_AFTER_SUBMIT') || !arenaSource.includes('ARENA_REPLY_STABLE_TICKS') || !arenaSource.includes('noteArenaReplyGrowth')) {
  throw new Error('场景20 Arena 必须等正文停住且上一句发出后再填输入框')
}
if (!arenaSource.includes('ARENA_PROMPT_SUBMIT_MS') || !arenaSource.includes('thinkingActive') || !arenaSource.includes('isActiveThinkingText')) {
  throw new Error('场景20 Arena 发出消息后必须等深度思考出现，不能 13 秒就报没发出去')
}
if (arenaSource.includes('composerEmpty: false')) {
  throw new Error('场景20 Arena 必须看输入框是否清空，不能写死 composerEmpty: false')
}
const arenaToolReply = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"action":"directory","path":"E:/灵犀-11/03/自迭代/05/测试00","recursive":false}}]}</LINGXI_TOOL_CALLS>'
if (looksLikeWebBridgeDumpedPrompt(arenaToolReply)) {
  throw new Error('场景20 页面上的工具协议不能当成提示词回声')
}
const pickedTool = arenaBridge.pickArenaReplyFromLeaves([
  { text: '--- 系统要求 1 ---' },
  { text: arenaToolReply }
], { sentPrompt: '看一下项目', baselineLeaves: [{ text: '--- 系统要求 1 ---' }] })
if (!pickedTool.text.includes('file_search') || !pickedTool.text.includes('LINGXI_TOOL_CALLS')) {
  throw new Error('场景20 Arena 必须抓住页面上的工具协议: ' + pickedTool.text)
}
const arenaStageText = '先看一下项目里有哪些文件，再决定改哪一页。'
const pickedStage = arenaBridge.pickArenaReplyFromLeaves([
  { text: '--- 系统要求 1 ---' },
  { text: arenaStageText }
], { sentPrompt: '看一下项目', baselineLeaves: [{ text: '--- 系统要求 1 ---' }] })
if (pickedStage.text !== arenaStageText) {
  throw new Error('场景20 Arena 必须抓住阶段性说明: ' + pickedStage.text)
}
const novelPlan = '这一轮我会先深入查看项目里的主要文件和目录结构，了解小说大纲、角色、设定、任务卡。'
const pickedNovel = arenaBridge.pickArenaReplyFromLeaves([
  { text: '你好！有什么我可以帮你的吗？' },
  { text: '你好' },
  { text: novelPlan }
], {
  sentPrompt: '先根据用户需求写第一段阶段性说明。\n你觉得这个项目还有什么可改进优化的吗啊\n当前项目路径：D:/小说',
  baselineLeaves: [{ text: '你好！有什么我可以帮你的吗？' }]
})
if (pickedNovel.text !== novelPlan) {
  throw new Error('场景20 Arena 不能把旧的“你好”当成最新回复: ' + pickedNovel.text)
}
const completeSearch = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"action":"directory","path":"D:/小说","recursive":false}}]}</LINGXI_TOOL_CALLS>'
const pickedMixedArena = arenaBridge.pickArenaReplyFromLeaves([
  { text: '现在写这一轮的阶段性说明。用自己的话写清楚即可，不必套固定句式；尽量 200 字内。不要输出 <LINGXI_TOOL_CALLS>。写完即止。' },
  { text: '先根据用户需求写第一段阶段性说明。编辑器随后才会把工具结果给你。\n--- 用户 1 ---\n你觉得这个项目还有什么可改进优化的吗啊' },
  { text: '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"action":"glob",' },
  { text: '当前项目（位于 D:/小说）主要是一个小说创作与网页测试混合的项目。根据目录结构，它包含大纲、角色、设定。' },
  { text: completeSearch }
], { sentPrompt: '续写同一任务。已经能回答用户就直接写给用户看。' })
if (!pickedMixedArena.text.includes('</LINGXI_TOOL_CALLS>') || !pickedMixedArena.text.includes('D:/小说')) {
  throw new Error('场景20 Arena 应抓住完整工具协议，不要停在半截标签或提示词: ' + pickedMixedArena.text)
}
const pickedAnswerOnly = arenaBridge.pickArenaReplyFromLeaves([
  { text: '现在写这一轮的阶段性说明。不要输出 <LINGXI_TOOL_CALLS>。写完即止。' },
  { text: '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"action":"direct' },
  { text: '当前项目（位于 D:/小说）主要是一个小说创作与网页测试混合的项目。根据目录结构，它包含大纲、角色、设定。' }
], { sentPrompt: '续写同一任务。' })
if (!pickedAnswerOnly.text.includes('小说创作')) {
  throw new Error('场景20 没有完整工具协议时应收项目说明，不要收半截标签: ' + pickedAnswerOnly.text)
}
const arenaStagePlan = [
  '我将在 D:/页面测试/0045 目录下创建 index.html style.css 和 script.js 文件。',
  '设计为 5 屏沉浸式电影感交互个人介绍：开场、视觉故事、核心技能、作品集、联系收尾。',
  '用纯 HTML/CSS/JS 实现平滑滚动和粒子效果，然后开始创建文件。'
].join('')
const pickedArenaThinkingDup = arenaBridge.pickArenaReplyFromLeaves([
  { text: `Deep Thinking\n1m 34s\n${arenaStagePlan}`, thinking: true },
  { text: arenaStagePlan }
], { sentPrompt: '做个电影感个人介绍页' })
if (pickedArenaThinkingDup.text !== arenaStagePlan) {
  throw new Error('场景20 Arena 不能把深度思考和正文各抓一遍: ' + pickedArenaThinkingDup.text)
}
if (arenaBridge.pickArenaReplyFromLeaves([
  { text: arenaStagePlan },
  { text: arenaStagePlan }
], { sentPrompt: '做个电影感个人介绍页', baselineLeaves: [{ text: arenaStagePlan }] }).text) {
  throw new Error('场景20 Arena 续写时不能把上一轮阶段性说明再抓成新回复')
}
const arenaContinuationEcho = [
  '续写同一任务。已经能回答用户就把最终回答包在 <LINGXI_FINAL> 里；还要看或改文件才填写调用标签。不要为了调用而调用。',
  '',
  '当前项目路径：D:/站点爬取工具/fps-demo',
  '',
  '--- 灵犀工具结果 1 ---',
  '[对应 call_id=call_70ff19eb532d4f59a7c14780]',
  '{"success":true,"status":"answered","answer":"确认执行","value":"confirmed","selectedOption":null,"type":"confirm","executionMode":null,"workflowChoice":"confirmed","message":"用户已选择：确认执行"}',
  '',
  '同一件事继续，不要重读整段历史。',
  '按用户已确认的 confirm_plan 继续当前未完成步骤。不要重写计划或总目标，不要对同一路径重复搜索。',
  '如果已经能按计划回答用户的问题，把最终回答整段包在 <LINGXI_FINAL> 与 </LINGXI_FINAL> 里，不要用 <LINGXI_STAGE>，不要再调工具，不要写“等待下一步”。'
].join('\n')
const arenaRealToolReply = [
  '<LINGXI_STAGE>开始第一步：浏览 fps-demo 的目录结构，定位入口文件。</LINGXI_STAGE>',
  '',
  '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"path":"D:/站点爬取工具/fps-demo","pattern":"*","recursive":true}}]}',
  '</LINGXI_TOOL_CALLS>'
].join('\n')
if (hasClosedWebBridgeFinalCipher(arenaContinuationEcho)) {
  throw new Error('场景20 续写提示里的教学最终暗号不能当成真正收尾')
}
if (!looksLikeWebBridgeDumpedPrompt(arenaContinuationEcho)) {
  throw new Error('场景20 应识别带教学最终暗号的续写提示回声')
}
if (extractWebBridgeFinalReply(arenaContinuationEcho).done) {
  throw new Error('场景20 续写提示不能抽出最终回复')
}
if (sanitizeWebBridgeCapturedReply(arenaContinuationEcho)) {
  throw new Error('场景20 续写提示回声应被丢掉: ' + sanitizeWebBridgeCapturedReply(arenaContinuationEcho))
}
const pickedArenaContinuation = arenaBridge.pickArenaReplyFromLeaves([
  { text: arenaContinuationEcho, echo: true },
  { text: arenaContinuationEcho },
  { text: arenaRealToolReply }
], { sentPrompt: arenaContinuationEcho })
if (!pickedArenaContinuation.text.includes('file_search') || !pickedArenaContinuation.text.includes('LINGXI_TOOL_CALLS') || pickedArenaContinuation.text.includes('续写同一任务')) {
  throw new Error('场景20 Arena 必须抓住真实工具协议，不要抓续写提示: ' + pickedArenaContinuation.text)
}
const parsedArenaContinuation = arenaBridge.parseLingxiToolCalls(pickedArenaContinuation.text, [
  { type: 'function', function: { name: 'file_search', parameters: {} } }
])
if (parsedArenaContinuation.length !== 1 || parsedArenaContinuation[0].function.name !== 'file_search') {
  throw new Error('场景20 抓住的工具协议应能解析成 file_search')
}
const placeholderTools = [
  { type: 'function', function: { name: 'file_search', parameters: {} } },
  { type: 'function', function: { name: 'file_read', parameters: {} } }
]
const parsedPlaceholder = arenaBridge.parseLingxiToolCalls(
  '<LINGXI_TOOL_CALLS>{"calls":[{"name":"工具名","arguments":{"path":"D:/站点爬取工具/fps-demo","pattern":"*"}}]}</LINGXI_TOOL_CALLS>',
  placeholderTools
)
if (parsedPlaceholder.length !== 1 || parsedPlaceholder[0].function.name !== 'file_search') {
  throw new Error('场景20 占位工具名应按参数映射成 file_search: ' + JSON.stringify(parsedPlaceholder))
}
const parsedAlias = arenaBridge.parseLingxiToolCalls(
  '<LINGXI_TOOL_CALLS>{"calls":[{"name":"read_file","arguments":{"path":"D:/站点爬取工具/fps-demo/index.html"}},{"name":"工具名","arguments":{}}]}</LINGXI_TOOL_CALLS>',
  placeholderTools
)
if (parsedAlias.length !== 1 || parsedAlias[0].function.name !== 'file_read') {
  throw new Error('场景20 别名 read_file 应映射，空占位调用应丢掉: ' + JSON.stringify(parsedAlias))
}
const arenaRetryPrompt = qwenProtocol.buildWebToolProtocolRetryPrompt('网页模型请求了未授权工具“工具名”，已拒绝执行。', {
  tools: placeholderTools,
  projectPath: 'D:/站点爬取工具/fps-demo'
})
if (arenaRetryPrompt.includes('"name":"工具名"') || /\{"name":"工具名"/.test(arenaRetryPrompt)) {
  throw new Error('场景20 重试提示不能再示范 name 填“工具名”')
}
if (!arenaRetryPrompt.includes('file_read') && !arenaRetryPrompt.includes('file_search')) {
  throw new Error('场景20 重试提示应给出真实工具名')
}
if (!looksLikeWebBridgeFuturePlan(arenaStagePlan)) {
  throw new Error('场景20 应识别“我将创建文件”为下一步计划')
}
if (!looksLikeWebBridgeDirectEditTask('做个电影感个人介绍页\n当前项目路径：D:/页面测试/0045')) {
  throw new Error('场景20 创建页面应当成改文件任务，不要先要阶段性说明')
}
if (!shouldNudgeWebBridgeForMissingTools({
  userText: '做个电影感个人介绍页\n当前项目路径：D:/页面测试/0045',
  content: arenaStagePlan
})) {
  throw new Error('场景20 创建任务只写计划时不能当最终回复')
}
if (classifyWebBridgeAssistantReply(arenaStagePlan, {
  hadToolsThisTurn: false,
  userText: '做个电影感个人介绍页\n当前项目路径：D:/页面测试/0045'
}) !== 'continue') {
  throw new Error('场景20 没调工具的创建计划不能当最终结果')
}
if (shouldParkWebBridgeOpeningStageFromText({
  openedStage: false,
  hasToolCalls: false,
  hasFinal: false,
  text: arenaStagePlan,
  userText: '做个电影感个人介绍页\n当前项目路径：D:/页面测试/0045'
}) !== false) {
  throw new Error('场景20 创建任务的文字计划不能代替 confirm_plan 或直接写文件')
}
const createPagePrompt = assembleWebPagePrompt({
  mode: 'initial',
  transcript: '做个电影感个人介绍页\n当前项目路径：D:/页面测试/0045',
  tools: [{ name: 'write_file', required: ['path', 'content'] }],
  projectPath: 'D:/页面测试/0045'
})
if (/先根据用户需求写第一段阶段性说明/.test(createPagePrompt)) {
  throw new Error('场景20 创建页面不要先要一段计划当终稿')
}
if (!arenaSource.includes('prose-base') && !arenaSource.includes('prose(?:-|$|\\s)')) {
  throw new Error('场景20 Arena 必须抓 prose-base / markdown，不能只认独立 prose 类名')
}
if (!arenaBridge.composerAlreadyHoldsPrompt('hello world', 'hello world')) {
  throw new Error('场景20 输入框已有同一段文字时应跳过重填')
}
if (arenaBridge.composerAlreadyHoldsPrompt('old draft', 'new prompt text that is long enough to send')) {
  throw new Error('场景20 输入框是旧草稿时仍应重填')
}
const arenaToolDelta = arenaBridge.extractReplyDelta({
  leaves: [{ text: arenaToolReply }]
}, { leaves: [] })
if (!arenaToolDelta.markdown.includes('file_search')) {
  throw new Error('场景20 Arena 增量抓取不能丢掉工具协议')
}
const keepGoingPlan = resolveWebChatPromptPlan({
  resumedThread: true,
  continuation: [{ role: 'system', content: '继续同一任务。只填写调用标签，本地客户端会解析。' }]
})
if (keepGoingPlan.promptMode !== 'continuation') {
  throw new Error('场景20 阶段性说明后的续写指令应走 continuation，不要当新提问')
}
if (!canSendWebChatPromptMessages(keepGoingPlan.promptMessages, keepGoingPlan.promptMode)) {
  throw new Error('场景20 只有系统续写指令时也应允许发送')
}
if (!hasWebBridgeSendableSourceMessage([
  { role: 'tool', content: '{"files":["electron/main.js"]}' },
  { role: 'system', content: '【内部工作流指令】\n现在只写阶段性说明。' }
])) {
  throw new Error('场景20 工具结果回灌时即使没有 user 角色也不能报 MISSING_MESSAGES')
}
if (!canSendWebChatPromptMessages([
  { role: 'tool', content: '{"ok":true}' }
], 'initial')) {
  throw new Error('场景20 只有工具结果的续写也应允许发给网页')
}
if (hasWebBridgeSendableSourceMessage([])) {
  throw new Error('场景20 空消息仍应报缺少可发送内容')
}
const dumpedToolsCapture = [
  '现在只写阶段性说明，不要复述指令。',
  '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"action":"directory"}}]}</LINGXI_TOOL_CALLS>'
].join('\n')
if (!sanitizeWebBridgeCapturedReply(dumpedToolsCapture).includes('file_search')) {
  throw new Error('场景20 页面回复即使夹着催续文案也要抓出工具调用')
}
const fatResumePlan = resolveWebChatPromptPlan({
  resumedThread: true,
  continuation: [
    { role: 'user', content: `当前项目是什么内容\n${'x'.repeat(8000)}` },
    { role: 'system', content: '继续同一任务。只填写调用标签，本地客户端会解析。' }
  ]
})
if (fatResumePlan.promptMessages.length !== 1 || fatResumePlan.promptMessages[0].role !== 'system') {
  throw new Error('场景20 续写只应发送最新一句，不要把整段历史再倒进网页')
}
const inspectPrompt = assembleWebPagePrompt({
  mode: 'initial',
  transcript: '当前项目是什么内容\n当前项目路径：E:/demo',
  tools: [{ name: 'file_search', required: ['action'] }]
})
if (inspectPrompt.includes('{"name":"file_search"') || inspectPrompt.includes('看目录用 file_search')) {
  throw new Error('场景20 查看项目内容第一轮应先 confirm_plan，不要直接搜文件')
}
if (!inspectPrompt.includes('confirm_plan')) {
  throw new Error('场景20 查看项目内容第一轮应先调用灵犀计划工具')
}
const inspectFollowPlanPrompt = assembleWebPagePrompt({
  mode: 'continuation',
  transcript: '当前项目是什么内容\n当前项目路径：E:/灵犀-11/03/自迭代/05/测试00',
  tools: [{ name: 'file_search', required: ['action'] }],
  projectPath: 'E:/灵犀-11/03/自迭代/05/测试00'
})
if (!inspectFollowPlanPrompt.includes('file_search')) {
  throw new Error('场景20 查看项目内容在计划冻结后应给出 file_search')
}
if (!inspectFollowPlanPrompt.includes('E:/灵犀-11/03/自迭代/05/测试00')) {
  throw new Error('场景20 查看项目续写的工具示例应使用真实项目路径')
}
if (!inspectFollowPlanPrompt.includes('未勾选') && !inspectFollowPlanPrompt.includes('complete_step') && !inspectFollowPlanPrompt.includes('不要对同一路径重复搜索')) {
  throw new Error('场景20 查看项目续写应按已确认计划执行，不要重复搜索')
}
const restatedCharter = '这一轮继续把验证状态和三类关键测试放在一起看，下一步会据此给出更明确的成熟度结论。'
if (!looksLikeWebBridgeRestatedCharter(restatedCharter)) {
  throw new Error('场景20 应识别把总目标再写一遍的空阶段说明')
}
if (clipWebBridgeThinkingNote(restatedCharter)) {
  throw new Error('场景20 重写总目标不能当成阶段性说明')
}
if (!clipWebBridgeThinkingNote('刚核对完 VALIDATION_STATUS 里的失败项。下一步按已确认计划核对主循环入口。')) {
  throw new Error('场景20 真实进展应能写成阶段性说明')
}
if (!shouldNudgeWebBridgeForMissingTools({
  userText: '查看此目录内容并判断数据脑成熟度\n当前项目路径：D:/数据脑',
  content: restatedCharter
})) {
  throw new Error('场景20 重写总目标的空说明不能当最终回复')
}
if (arenaBridge.clipArenaFillPrompt('a'.repeat(12000)).length > 8500) {
  throw new Error('场景20 Arena 填入输入框的文字必须有上限')
}
if (!isWebBridgeDemoExamplePath('E:/demo') || isWebBridgeDemoExamplePath('E:/demo/_fix_page.py')) {
  throw new Error('场景20 只有示例根路径 E:/demo 才应被改写')
}
const rewrittenDemo = rewriteWebBridgeDemoPaths({ path: 'E:/demo' }, 'E:/灵犀-11/03/自迭代/05/测试00')
if (rewrittenDemo.path !== 'E:/灵犀-11/03/自迭代/05/测试00') {
  throw new Error('场景20 网页模型照抄 E:/demo 时应改成真实项目路径')
}
const realPathPrompt = assembleWebPagePrompt({
  mode: 'initial',
  transcript: '当前项目是什么内容\n当前项目路径：E:/灵犀-11/03/自迭代/05/测试00',
  tools: [{ name: 'file_search', required: ['action'] }]
})
if (/"path"\s*:\s*"E:\/demo"/.test(realPathPrompt) || realPathPrompt.includes('"path":"E:/demo"')) {
  throw new Error('场景20 有真实项目路径时禁止再举例 E:/demo')
}
if (!realPathPrompt.includes('E:/灵犀-11/03/自迭代/05/测试00')) {
  throw new Error('场景20 工具示例应使用真实项目路径')
}
const portfolioAnswer = '当前项目是一个个人作品集展示页面，主题为 LIU YU。页面采用深色电影感风格，包含首屏 Hero 区、作品展示、关于和联系方式。'
if (shouldPromoteWebBridgeTextToFinal({ userText: '当前项目是什么内容', text: portfolioAnswer })) {
  throw new Error('场景20 没点出源码文件的空介绍不能当最终回答')
}
const readmeOnlyAnswer = '根据 README.md 介绍，这是一个个人作品集项目，功能已经写在文档里。'
if (shouldPromoteWebBridgeTextToFinal({ userText: '当前项目是什么内容', text: readmeOnlyAnswer })) {
  throw new Error('场景20 只复述 README 不能当已经看过项目')
}
if (shouldParkWebBridgeOpeningStageFromText({
  openedStage: false,
  hasToolCalls: false,
  hasFinal: false,
  text: inspectAnswer,
  userText: '当前项目是什么内容'
}) !== false) {
  throw new Error('场景20 已经介绍完项目时不要再记进思考块催下一轮')
}
const fatInspectTools = [
  { name: 'file_search' },
  { name: 'file_read' },
  { name: 'apply_patch' },
  { name: 'confirm_plan' },
  { name: 'record_ai_operation_memo' },
  { name: 'write_file' },
  { name: 'shell_run' }
]
const slimInspectPrompt = assembleWebPagePrompt({
  mode: 'initial',
  transcript: '当前项目是什么内容\n当前项目路径：E:/灵犀-11/03/自迭代/05/测试00',
  tools: fatInspectTools
})
if (slimInspectPrompt.includes('apply_patch') || slimInspectPrompt.includes('record_ai_operation_memo') || slimInspectPrompt.includes('硬规则') || slimInspectPrompt.includes('按用户最后一条消息')) {
  throw new Error('场景20 查看项目内容不要塞整份工具清单')
}
if (!slimInspectPrompt.includes('confirm_plan') || slimInspectPrompt.includes('apply_patch')) {
  throw new Error('场景20 查看项目内容第一轮应先 confirm_plan，不要下发整份工具清单')
}
const inspectContinuePrompt = assembleWebPagePrompt({
  mode: 'continuation',
  transcript: [
    '--- 用户 1 ---',
    '当前项目是什么内容',
    '当前项目路径：E:/灵犀-11/03/自迭代/05/测试00',
    '',
    '--- 灵犀工具结果 1 ---',
    '{"files":[{"name":"index.html"},{"name":"style.css"},{"name":"script.js"}]}'
  ].join('\n'),
  tools: fatInspectTools
})
if (inspectContinuePrompt.includes('apply_patch') || inspectContinuePrompt.includes('硬规则') || inspectContinuePrompt.includes('本轮可用')) {
  throw new Error('场景20 看完目录后应直接让模型介绍项目，不要再倒工具清单')
}
if (!inspectContinuePrompt.includes('不要把文档当实现') && !inspectContinuePrompt.includes('已经根据源码')) {
  throw new Error('场景20 查看项目续写不能只看文档就总结')
}
if (!inspectContinuePrompt.includes('禁止再次 file_search')) {
  throw new Error('场景20 看完目录后禁止重复 file_search')
}
const rewrittenGlob = normalizeWebToolCallArgs('file_search', { query: '**/*', path: 'E:/demo-project' }, { projectPath: 'E:/demo-project' })
if (rewrittenGlob.action !== 'directory' || rewrittenGlob.query || rewrittenGlob.recursive !== false) {
  throw new Error('场景20 file_search **/* 应改写成 directory')
}
const repeatedSearch = dropRepeatedWebBridgeSearchCalls(
  [{ id: 'call_2', type: 'function', function: { name: 'file_search', arguments: JSON.stringify({ action: 'directory', path: 'E:/demo-project', recursive: false }) } }],
  [{ role: 'assistant', toolCalls: [{ name: 'file_search', arguments: JSON.stringify({ query: '**/*', path: 'E:/demo-project' }) }] }]
)
if (repeatedSearch.length) {
  throw new Error('场景20 重复的宽搜索应被丢掉')
}
const droppedInternal = formatLingxiWebChatTranscript([
  { role: 'system', content: '【内部工作流指令】这是系统给你的执行控制指令。已满 4 个调用。现在输出这一轮的阶段性说明。' },
  { role: 'user', content: '当前项目是什么内容' }
])
if (droppedInternal.includes('【内部工作流指令】') || droppedInternal.includes('--- 系统要求')) {
  throw new Error('场景20 内部阶段性说明不应再贴进网页对话')
}
if (!droppedInternal.includes('当前项目是什么内容')) {
  throw new Error('场景20 压缩历史时不能丢掉用户问题')
}
if (!looksLikeWebBridgeDirectEditTask('删除远程遥控功能')) {
  throw new Error('场景20 应识别删除任务')
}
if (looksLikeWebBridgeDirectEditTask('当前项目是什么内容')) {
  throw new Error('场景20 查看项目不应当成删除任务')
}
if (!looksLikeWebBridgeConfirmStall('这一轮继续做删除前的最后核对，确认 main.js 和 index.html 的引用后再统一移除。')) {
  throw new Error('场景20 应识别反复确认的空转说明')
}
if (looksLikeWebBridgeConfirmStall('已经删掉 remote-bridge，主进程不再启动遥控服务。')) {
  throw new Error('场景20 已经删完的说明不能当成空转确认')
}
if (!isWebBridgeReadOnlyToolBatch([{ name: 'file_search' }, { name: 'file_read' }])) {
  throw new Error('场景20 应识别只读工具批次')
}
if (isWebBridgeReadOnlyToolBatch([{ name: 'file_search' }, { name: 'file_manage' }])) {
  throw new Error('场景20 含写入/删除的批次不能当成只读')
}
if (!shouldSkipWebBridgeStageForExecute({
  userText: '删除远程遥控',
  readOnlyBatches: 1
})) {
  throw new Error('场景20 删除任务读完一轮后应跳过阶段性说明去改文件')
}
const deletePrompt = assembleWebPagePrompt({
  mode: 'initial',
  transcript: '删除远程遥控功能\n当前项目路径：E:/灵犀-11/新版本/01/灵犀-05',
  tools: fatInspectTools
})
if (deletePrompt.includes('第一段阶段性说明') || deletePrompt.includes('打算怎么做')) {
  throw new Error('场景20 删除任务第一轮就应直接改，不要先写确认计划')
}
if (!deletePrompt.includes('直接改或删') || !deletePrompt.includes('file_search')) {
  throw new Error('场景20 删除任务应直接给出工具而不是开场说明')
}
const deleteContinuePrompt = assembleWebPagePrompt({
  mode: 'continuation',
  transcript: '--- 用户 1 ---\n删除远程遥控功能',
  tools: fatInspectTools
})
if (deleteContinuePrompt.includes('硬规则') || deleteContinuePrompt.includes('apply_patch') || deleteContinuePrompt.includes('本轮可用')) {
  throw new Error('场景20 删除任务续写不要再倒整份工具清单')
}
if (!deleteContinuePrompt.includes('不要再确认')) {
  throw new Error('场景20 删除任务续写应打断确认空转')
}
const executeNowPrompt = buildWebBridgeKeepGoingPrompt({ executeNow: true })
if (!executeNowPrompt.includes('不要再确认') || !executeNowPrompt.includes('调用标签')) {
  throw new Error('场景20 空转后续应强制改文件')
}
const executeNowPlan = resolveWebChatPromptPlan({
  resumedThread: true,
  continuation: [{ role: 'system', content: executeNowPrompt }]
})
if (executeNowPlan.promptMode !== 'continuation') {
  throw new Error('场景20 创建任务的强制改文件续写应走 continuation，不要当成缺少用户消息: ' + executeNowPlan.promptMode)
}
if (!canSendWebChatPromptMessages(executeNowPlan.promptMessages, executeNowPlan.promptMode)) {
  throw new Error('场景20 强制改文件续写不能报 MISSING_MESSAGES')
}
const stageOnlyPrompt = gpt.buildWebChatPrompt({
  messages: [{ role: 'system', content: '已满 4 个调用。现在输出这一轮的阶段性说明。' }],
  tools: codingTools
}, [{ role: 'system', content: '已满 4 个调用。现在输出这一轮的阶段性说明。' }], 'stage')
if (!stageOnlyPrompt.includes('阶段性说明') || !stageOnlyPrompt.includes('不要写 complete_step')) {
  throw new Error('场景20 进度轮不应因为没有用户消息而报错')
}
if (stageOnlyPrompt.includes('【内部工作流指令】') || stageOnlyPrompt.includes('需要看或改文件时') || stageOnlyPrompt.includes('硬规则') || stageOnlyPrompt.includes('按用户最后一条消息') || stageOnlyPrompt.includes('写阶段性说明并调用')) {
  throw new Error('场景20 进度轮应只催阶段性说明，不要叠整份协议，也不要同时催 complete_step')
}
if ((stageOnlyPrompt.match(/complete_step/g) || []).length > 2) {
  throw new Error('场景20 进度轮里 complete_step 只应作为禁止项出现')
}
const noToolsNudge = buildWebBridgeNoToolsNudgePrompt()
if (!noToolsNudge.includes('<LINGXI_TOOL_CALLS>') || !noToolsNudge.includes('file_search') || !noToolsNudge.includes('你不执行')) {
  throw new Error('场景20 纠正提示应只要求填写调用标签')
}
const continuationPrompt = assembleWebPagePrompt({
  mode: 'continuation',
  transcript: '继续',
  tools: [{ name: 'file_manage', required: ['action'] }]
})
if (!continuationPrompt.includes('不要讨论有没有工具') || continuationPrompt.includes('先写阶段性说明') || continuationPrompt.includes('第一轮只写计划') || continuationPrompt.includes('E:/demo')) {
  throw new Error('场景20 续写应继续任务，不要塞演示路径或开场计划')
}
if (!looksLikeWebBridgeChitchat('你好\n当前项目路径：E:/demo')) {
  throw new Error('场景20 应识别打招呼')
}
const helloPlan = resolveWebChatPromptPlan({
  resumedThread: true,
  inputMessages: [{ role: 'user', content: '你好\n当前项目路径：E:/demo' }]
})
if (helloPlan.promptMode !== 'initial') {
  throw new Error('场景20 旧网页线程上的打招呼不应走续写催工具')
}
const toolContinuePlan = resolveWebChatPromptPlan({
  resumedThread: true,
  continuation: [
    { role: 'tool', content: '{"ok":true}' },
    { role: 'system', content: '已满 4 个调用。现在输出这一轮的阶段性说明。' }
  ]
})
if (toolContinuePlan.promptMode !== 'stage') {
  throw new Error('场景20 满 4 个工具后的说明指令应走阶段性说明模式')
}
if (!toolContinuePlan.promptMessages.some(message => message.role === 'tool' && String(message.content || '').includes('"ok":true'))) {
  throw new Error('场景20 满 4 个工具后的阶段性说明必须带上刚返回的工具结果')
}
const stageWithTools = assembleWebPagePrompt({
  mode: 'stage',
  transcript: '--- 灵犀工具结果 1 ---\n{"files":["electron/main.js","package.json"]}',
  tools: codingTools
})
if (!stageWithTools.includes('electron/main.js') || !stageWithTools.includes('现在只写阶段性说明')) {
  throw new Error('场景20 阶段性说明轮必须把工具结果贴回网页，不能只催暗号')
}
const keepGoing = buildWebBridgeKeepGoingPrompt()
if (!keepGoing.includes(FINAL_OPEN) || !keepGoing.includes('只填写调用标签') || !keepGoing.includes('不要讨论有没有工具') || !keepGoing.includes(STAGE_OPEN)) {
  throw new Error('场景20 催续提示应约定最终回复暗号，并允许已经能回答时收尾')
}
if (!keepGoing.includes('已确认的 confirm_plan') || keepGoing.includes('写阶段性说明') || keepGoing.includes('现在只调用 complete_step') || !keepGoing.includes('不要对同一路径重复搜索')) {
  throw new Error('场景20 催续应按已确认的灵犀计划执行，不要在催续里同时要阶段性说明和 complete_step')
}
if (!keepGoing.includes('阶段性说明不等于完成计划步骤') || !keepGoing.includes('尚未完成则继续当前步骤') || !keepGoing.includes('本轮必须调用 complete_step')) {
  throw new Error('场景20 催续不得把阶段性说明绑定成 complete_step，但证据够了必须勾步骤')
}
if (!keepGoing.includes('ask_user_choice')) {
  throw new Error('场景20 催续应提醒用弹窗询问，不要把选择题写进完成标记')
}
if (WEB_BRIDGE_STAGE_EVERY !== 4) throw new Error('场景20 每轮最多 4 个工具调用')
if (shouldRequestWebBridgeStage(3) !== false || shouldRequestWebBridgeStage(4) !== true) {
  throw new Error('场景20 满 4 个工具应重置批次计数')
}
if (didWebPromptLeaveComposer({ generating: false, messageCount: 1, baselineCount: 1, composerEmpty: true, hadComposerText: false }) !== false) {
  throw new Error('场景20 输入框本来就是空的不能当成已经发出')
}
if (didWebPromptLeaveComposer({ generating: true, messageCount: 1, baselineCount: 1, composerEmpty: true, hadComposerText: true }) !== true) {
  throw new Error('场景20 页面开始生成才算发出')
}
if (didWebPromptLeaveComposer({ generating: false, messageCount: 2, baselineCount: 1, composerEmpty: false, hadComposerText: true }) !== true) {
  throw new Error('场景20 消息条数增加才算发出')
}
if (shouldHoldWebBridgeToolsForOpeningStage({ openedStage: false, hasToolCalls: true }) !== true) {
  throw new Error('场景20 网页模型第一轮若直接给工具，应先拦住并写开场阶段性说明')
}
if (shouldHoldWebBridgeToolsForOpeningStage({ openedStage: false, hasToolCalls: true, chitchat: true }) !== false) {
  throw new Error('场景20 打招呼不应拦住工具去写开场阶段性说明')
}
if (shouldHoldWebBridgeToolsForOpeningStage({ openedStage: false, hasToolCalls: true, inspect: true }) !== true) {
  throw new Error('场景20 查看项目内容也应先拦住工具去写开场计划')
}
if (shouldHoldWebBridgeToolsForOpeningStage({ openedStage: false, hasToolCalls: true, directEdit: true }) !== false) {
  throw new Error('场景20 删除任务不应先拦住工具去写确认计划')
}
if (shouldHoldWebBridgeToolsForOpeningStage({ openedStage: false, hasToolCalls: true, planOnly: true }) !== false) {
  throw new Error('场景20 confirm_plan 不应被开场拦截')
}
if (!isWebBridgePlanToolBatch([{ function: { name: 'confirm_plan' } }]) || isWebBridgePlanToolBatch([{ function: { name: 'file_search' } }])) {
  throw new Error('场景20 应识别灵犀计划工具批次')
}
if (shouldParkWebBridgeOpeningStageFromText({
  openedStage: false,
  hasToolCalls: false,
  hasFinal: false,
  text: '我先看首页结构和样式，再补光晕和布局。'
}) !== false) {
  throw new Error('场景20 第一轮文字计划不能代替 confirm_plan')
}
if (!shouldNudgeWebBridgeForMissingTools({
  userText: '改一下首页样式\n当前项目路径：E:/demo',
  content: '我先看首页结构和样式，再补光晕和布局。'
})) {
  throw new Error('场景20 第一轮文字计划应催 confirm_plan')
}
if (shouldParkWebBridgeOpeningStageFromText({
  openedStage: false,
  hasToolCalls: false,
  hasFinal: true,
  text: '闲聊结束'
}) !== false) {
  throw new Error('场景20 已有完成标记的闲聊不要当成开场阶段性说明')
}
const openingPrompt = buildWebBridgeOpeningStagePrompt()
if (!openingPrompt.includes('confirm_plan') || openingPrompt.includes('可勾选计划') || !openingPrompt.includes('阶段性说明')) {
  throw new Error('场景20 开场应调用灵犀 confirm_plan，并说明确认后再写阶段性说明')
}
if (!openingPrompt.includes(FINAL_OPEN) || !openingPrompt.includes(STAGE_OPEN)) {
  throw new Error('场景20 开场应同时约定阶段性暗号和最终回复暗号')
}
const stagePrompt = buildWebBridgeStageReplyPrompt()
if (!stagePrompt.includes(FINAL_OPEN) || !stagePrompt.includes('阶段性说明') || !stagePrompt.includes('不要写 complete_step') || !stagePrompt.includes(STAGE_OPEN) || !stagePrompt.includes(STAGE_CLOSE)) {
  throw new Error('场景20 进度轮应催带暗号的阶段性说明，并标明最终回复改用另一套暗号')
}
if (stagePrompt.includes('confirm_plan') || stagePrompt.includes('写阶段性说明并调用')) {
  throw new Error('场景20 进度轮不要同时催 complete_step 或重申 confirm_plan')
}
if (!stagePrompt.includes('不要重写总目标') || !stagePrompt.includes('还缺什么') || !stagePrompt.includes('当前正在处理')) {
  throw new Error('场景20 阶段性说明应汇报当前进展和缺口，不要暗示步骤已经完成')
}
if (stagePrompt.includes('刚做完哪一步') || stagePrompt.includes('已满') || stagePrompt.includes('阶段性说明只写') || stagePrompt.includes('\n')) {
  throw new Error('场景20 进度轮催促必须是短句，不能把整段指令贴进网页，也不能暗示刚做完一步')
}
const completeStepPrompt = buildWebBridgeCompleteStepPrompt()
if (!completeStepPrompt.includes('先判断当前计划步骤') || !completeStepPrompt.includes('尚未满足') || completeStepPrompt.includes('现在只调用 complete_step') || completeStepPrompt.includes('\n')) {
  throw new Error('场景20 阶段性说明之后应让模型判断步骤是否完成，不得强制 complete_step')
}
if (!completeStepPrompt.includes('本轮只调用 complete_step') || !completeStepPrompt.includes('不要因为刚写过阶段性说明就默认完成')) {
  throw new Error('场景20 阶段性说明之后必须允许证据够了就勾步骤，不能只禁止 complete_step')
}
const completeStepPlan = resolveWebChatPromptPlan({
  resumedThread: true,
  continuation: [{ role: 'system', content: completeStepPrompt }]
})
if (completeStepPlan.promptMode !== 'complete_step') {
  throw new Error('场景20 complete_step 催促应走独立模式，不要当成阶段性说明: ' + completeStepPlan.promptMode)
}
if (!canSendWebChatPromptMessages(completeStepPlan.promptMessages, completeStepPlan.promptMode)) {
  throw new Error('场景20 complete_step 催促不能报 MISSING_MESSAGES')
}
const completeStepPage = assembleWebPagePrompt({
  mode: 'complete_step',
  transcript: '--- 用户 1 ---\n查看项目',
  tools: codingTools
})
if (completeStepPage !== completeStepPrompt || completeStepPage.includes('现在只写阶段性说明')) {
  throw new Error('场景20 complete_step 轮应只贴勾进度那一句')
}
const completeStepWithTools = assembleWebPagePrompt({
  mode: 'complete_step',
  transcript: '--- 灵犀工具结果 1 ---\nAGENTS.md 写了打包必须跑 npm run dist。',
  tools: codingTools
})
if (!completeStepWithTools.includes('npm run dist') || !completeStepWithTools.includes('先判断当前计划步骤')) {
  throw new Error('场景20 complete_step 判断轮也必须带上刚返回的工具结果')
}
const initialPrompt = assembleWebPagePrompt({
  mode: 'initial',
  transcript: '升级页面',
  tools: [{ name: 'apply_patch', required: ['patch'] }]
})
if (!initialPrompt.includes(FINAL_OPEN) || !initialPrompt.includes('confirm_plan')) {
  throw new Error('场景20 初始提示应先调用 confirm_plan，并约定最终回复暗号')
}
if (initialPrompt.includes('直接输出调用') || initialPrompt.includes('每轮最多 4 个 calls')) {
  throw new Error('场景20 第一轮应先 confirm_plan，不要直接要改文件工具')
}
if (!initialPrompt.includes('confirm_plan')) {
  throw new Error('场景20 初始提示应先让模型调用灵犀计划工具')
}
const afterStagePrompt = assembleWebPagePrompt({
  mode: 'continuation',
  transcript: '继续',
  tools: [{ name: 'apply_patch', required: ['patch'] }]
})
if (!afterStagePrompt.includes('只填写调用标签') && !afterStagePrompt.includes('调用标签') && !afterStagePrompt.includes('4 个') && !afterStagePrompt.includes('最多 4')) {
  throw new Error('场景20 开场说明之后才应把工具调用交给页面模型')
}

const { EventEmitter } = require('events')
const firstSendReq = new EventEmitter()
const firstSendRes = new EventEmitter()
firstSendRes.writableEnded = false
const firstSendAbort = new AbortController()
attachWebChatAbort(firstSendReq, firstSendRes, firstSendAbort)
firstSendReq.emit('close')
if (firstSendAbort.signal.aborted) {
  throw new Error('场景19 读完请求体触发的 req.close 不能中止第一次发送')
}
const clientAbortReq = new EventEmitter()
const clientAbortRes = new EventEmitter()
clientAbortRes.writableEnded = false
const clientAbort = new AbortController()
attachWebChatAbort(clientAbortReq, clientAbortRes, clientAbort)
clientAbortRes.emit('close')
if (!clientAbort.signal.aborted) {
  throw new Error('场景19 软件端真正断开响应连接后应中止桥接等待')
}

const fs = require('fs')
const path = require('path')
const bridgeFiles = [
  '../../../electron/modules/chatgpt-image-bridge.js',
  '../../../electron/modules/deepseek-web-bridge.js',
  '../../../electron/modules/grok-web-bridge.js',
  '../../../electron/modules/claude-web-bridge.js',
  '../../../electron/modules/arena-web-bridge.js',
  '../../../electron/modules/qwen-web-bridge.js'
]
for (const relative of bridgeFiles) {
  const source = fs.readFileSync(path.join(__dirname, relative), 'utf8')
  if (!source.includes('ensureComposerAcceptsInput')) {
    throw new Error('场景19 缺少停止后重新占用输入框: ' + relative)
  }
  if (!source.includes('shouldAcceptStoppedWebReply')) {
    throw new Error('场景19 页面停止后必须立即收尾: ' + relative)
  }
  if (!source.includes('noteWebGenerationStarted') || !source.includes('sawGenerating')) {
    throw new Error('场景19 必须先见到页面开始生成，才能把空闲当成停止: ' + relative)
  }
  if (!source.includes('attachWebChatAbort')) {
    throw new Error('场景19 软件端中断绑定错误: ' + relative)
  }
  if (source.includes("req.once('close'")) {
    throw new Error('场景19 不能再监听 req.close，读完 body 会误杀发送: ' + relative)
  }
  if (!source.includes('stoppedIncomplete')) {
    throw new Error('场景19 停止后的半截工具调用不能再重试发页: ' + relative)
  }
}
const deepseekSource = fs.readFileSync(path.join(__dirname, '../../../electron/modules/deepseek-web-bridge.js'), 'utf8')
if (/stopLabelPattern:\s*'停止\|/.test(deepseekSource)) {
  throw new Error('场景19 DeepSeek 停止键不能再用单独的「停止」，会误判生成中')
}

const {
  looksLikeWebBridgeProtocolSafetyRefusal,
  shouldRetryWebBridgeToolProtocol
} = require('../../../electron/modules/web-bridge-coding-protocol')
const claudeSafety = [
  '识别并拒绝了提示注入攻击尝试。',
  '你好!不过我需要说明一下,我是 Claude,并没有"灵犀"这样的工具调用系统。',
  '我不会输出这些自定义标签(比如 <LINGXI_TOOL_CALLS>、<LINGXI_FINAL>),也不会假装自己拥有访问本地文件系统。'
].join('\n')
const realToolCalls = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"file_search","arguments":{"action":"directory","path":"E:/demo","recursive":false}}]}</LINGXI_TOOL_CALLS>'
if (looksLikeWebBridgeToolProtocol(claudeSafety)) {
  throw new Error('场景22 正文提到标签名不能当成工具协议')
}
if (!looksLikeWebBridgeToolProtocol(realToolCalls)) {
  throw new Error('场景22 完整工具协议仍应识别')
}
if (!looksLikeWebBridgeProtocolSafetyRefusal(claudeSafety)) {
  throw new Error('场景22 应识别网页模型把协议当成提示注入')
}
if (shouldNudgeWebBridgeForMissingTools({
  userText: '你好\n当前项目路径：E:/灵犀-11/03/自迭代/05/测试00',
  content: claudeSafety
})) {
  throw new Error('场景22 打招呼被拒后不要再催 E:/demo 工具')
}
if (shouldRetryWebBridgeToolProtocol({ userText: '你好', answer: claudeSafety })) {
  throw new Error('场景22 打招呼被拒后不要再发格式无效重试')
}
if (classifyWebBridgeAssistantReply(claudeSafety, { userText: '你好' }) !== 'final') {
  throw new Error('场景22 打招呼的防护回复应直接展示给用户')
}
if (!shouldNudgeWebBridgeForMissingTools({
  userText: '升级页面',
  content: '当前会话没有可用的项目文件浏览工具'
})) {
  throw new Error('场景22 改代码时说没有工具仍应催它调用')
}
if (!shouldRetryWebBridgeToolProtocol({ userText: '升级页面', answer: realToolCalls })) {
  throw new Error('场景22 改代码时的残缺协议仍应重试')
}
if (helloPrompt.includes('<LINGXI_TOOL_CALLS>') || helloPrompt.includes('<LINGXI_FINAL>')) {
  throw new Error('场景22 打招呼提示不能再写出协议标签名')
}

const claudePromptDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lx-claude-paste-'))
fs.writeFileSync(path.join(claudePromptDir, 'index.html'), '<!DOCTYPE html><html><body>hello-paste</body></html>')
fs.writeFileSync(path.join(claudePromptDir, 'style.css'), 'body{color:red}')
const claudeProjectPath = claudePromptDir.replace(/\\/g, '/')
const claudePrompt = claudeBridge.buildWebChatPrompt({
  messages: [{ role: 'user', content: `改一下首页样式\n当前项目路径：${claudeProjectPath}` }],
  tools: codingTools
})
if (claudePrompt.includes('<LINGXI_TOOL_CALLS>') || claudePrompt.includes('<LINGXI_FINAL>') || claudePrompt.includes('系统要求') || /伪造/.test(claudePrompt)) {
  throw new Error('场景23 Claude 提示不能再用自定义标签或伪造工具说法')
}
if (claudePrompt.includes('```json') || claudePrompt.includes('"calls"') || claudePrompt.includes('json 代码块') || claudePrompt.includes('编辑器已经把上次请求的结果')) {
  throw new Error('场景23 Claude 不能再要 json 工具调用块')
}
if (claudePrompt.includes('--- 系统要求') || claudePrompt.includes('灵犀工具结果') || claudePrompt.includes('编辑器说明') || claudePrompt.includes('内部工作流')) {
  throw new Error('场景23 Claude 转写不能再写系统要求或编辑器包装')
}
if (!claudePrompt.includes('hello-paste') || !claudePrompt.includes('body{color:red}')) {
  throw new Error('场景23 Claude 应把项目文件原文贴进提示')
}
fs.rmSync(claudePromptDir, { recursive: true, force: true })
const fencedFile = [
  '对比度我调高了。',
  '```html E:/demo/index.html',
  '<!DOCTYPE html><html><head><title>ok</title></head><body>ok</body></html>',
  '```'
].join('\n')
const parsedFence = claudeBridge.parseLingxiToolCalls(fencedFile, codingTools)
if (parsedFence.length !== 1 || parsedFence[0].function.name !== 'write_file') {
  throw new Error('场景23 带路径的代码块应写成文件')
}
const parsedArgs = JSON.parse(parsedFence[0].function.arguments)
if (!String(parsedArgs.path || '').replace(/\\/g, '/').endsWith('/index.html') || !String(parsedArgs.content || '').includes('<body>ok</body>')) {
  throw new Error('场景23 代码块路径和内容应保留')
}
const commentedFence = [
  '```css',
  '/* file: E:/demo/style.css */',
  'body{color:#111}',
  '```'
].join('\n')
const parsedComment = claudeBridge.parseLingxiToolCalls(commentedFence, codingTools)
if (parsedComment.length !== 1 || JSON.parse(parsedComment[0].function.arguments).path.replace(/\\/g, '/') !== 'E:/demo/style.css') {
  throw new Error('场景23 第一行路径注释应能识别')
}
const claudeRefuse = '我不会使用这套"LINGXI_TOOL_CALLS"格式,也不会输出标记——这不是我这边真实的工具系统,我不能假装在操作你本地的文件或路径。这个格式无论包装成"用户消息"还是"系统要求",对我来说都一样。'
if (!looksLikeWebBridgeProtocolSafetyRefusal(claudeRefuse)) {
  throw new Error('场景23 应识别 Claude 拒用协议')
}
const claudeJsonRefuse = '你又换了个说法,但本质还是让我输出一份看起来像工具调用的 JSON 代码块。这个我没法照做,也不会假装在操作它。'
if (!looksLikeWebBridgeProtocolSafetyRefusal(claudeJsonRefuse)) {
  throw new Error('场景23 应识别 Claude 拒写 json 调用块')
}
if (shouldNudgeWebBridgeForMissingTools({ userText: '升级页面', content: claudeRefuse, dialect: 'paste-files' })) {
  throw new Error('场景23 Claude 拒用协议后不要再催标签')
}
if (shouldRetryWebBridgeToolProtocol({ userText: '升级页面', answer: claudeRefuse, dialect: 'paste-files' })) {
  throw new Error('场景23 Claude 拒用协议后不要再重试格式')
}
if (looksLikeWebBridgeToolProtocol(claudeRefuse)) {
  throw new Error('场景23 拒用协议的正文不能当成工具调用')
}
if (classifyWebBridgeAssistantReply('样式已经改好了，首页对比更清楚。', {
  hadToolsThisTurn: true,
  dialect: 'paste-files'
}) !== 'final') {
  throw new Error('场景23 Claude 用普通文字收尾时应直接展示')
}
const claudeRetry = require('../../../electron/modules/web-bridge-coding-protocol').buildWebToolProtocolRetryPrompt('JSON 无法解析', { dialect: 'paste-files' })
if (claudeRetry.includes('<LINGXI_TOOL_CALLS>') || claudeRetry.includes('禁止解释') || claudeRetry.includes('"calls"') || claudeRetry.includes('```json')) {
  throw new Error('场景23 Claude 重试不能再逼 json 或自定义标签')
}

const askJson = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"ask_user_choice","arguments":{"question":"首页用哪种主题？","options":[{"label":"深色主题","value":"dark","desc":"对比更强，适合夜间长时间阅读。"},{"label":"浅色主题","value":"light","desc":"更接近现有品牌，改动集中在配色。"}]}}]}</LINGXI_TOOL_CALLS>'
const parsedAsk = bridge.parseLingxiToolCalls(askJson, codingTools)
if (parsedAsk.length !== 1 || parsedAsk[0].function.name !== 'ask_user_choice') {
  throw new Error('场景25 JSON 弹窗询问应解析为 ask_user_choice')
}
const parsedAskArgs = JSON.parse(parsedAsk[0].function.arguments)
if (parsedAskArgs.question !== '首页用哪种主题？' || parsedAskArgs.options.length !== 2) {
  throw new Error('场景25 JSON 弹窗询问应保留问题和选项')
}
const askLooseJson = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"ask_user_choice","arguments":{"prompt":"首页用哪种主题？","choices":[{"name":"深色主题","description":"对比更强，适合夜间长时间阅读。"},{"title":"浅色主题","detail":"更接近现有品牌，改动集中在配色。"}]}}]}</LINGXI_TOOL_CALLS>'
const parsedLooseAsk = gpt.parseLingxiToolCalls(askLooseJson, codingTools)
if (parsedLooseAsk.length !== 1 || parsedLooseAsk[0].function.name !== 'ask_user_choice') {
  throw new Error('场景25 GPT 缺 question 时应从 prompt/choices 补全')
}
const parsedLooseAskArgs = JSON.parse(parsedLooseAsk[0].function.arguments)
if (parsedLooseAskArgs.question !== '首页用哪种主题？' || parsedLooseAskArgs.options.length !== 2) {
  throw new Error('场景25 GPT 弹窗询问应把 prompt/choices 收成 question/options')
}
const askNoQuestion = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"ask_user_choice","arguments":{"options":[{"label":"先改首页","value":"home","desc":"先处理用户正在看的首页结构和样式。"},{"label":"先改脚本","value":"js","desc":"先处理交互和脚本报错，再回头调样式。"}]}}]}</LINGXI_TOOL_CALLS>'
const parsedNoQuestion = gpt.parseLingxiToolCalls(askNoQuestion, codingTools)
if (parsedNoQuestion.length !== 1) {
  throw new Error('场景25 GPT 只有 options 时不应因缺少 question 整段拒绝')
}
if (!String(JSON.parse(parsedNoQuestion[0].function.arguments).question || '').trim()) {
  throw new Error('场景25 缺 question 时应补默认问句')
}
const gptParsedAsk = gpt.parseLingxiToolCalls(askJson, codingTools)
if (gptParsedAsk.length !== 1 || gptParsedAsk[0].function.name !== 'ask_user_choice') {
  throw new Error('场景25 GPT 也应解析 JSON 弹窗询问')
}
const claudeAsk = [
  '对比度有两种做法。',
  '请用户选择',
  '问题：首页用哪种主题？',
  '- 深色主题：对比更强，适合夜间长时间阅读。',
  '- 浅色主题：更接近现有品牌，改动集中在配色。'
].join('\n')
const parsedClaudeAsk = claudeBridge.parseLingxiToolCalls(claudeAsk, codingTools)
if (parsedClaudeAsk.length !== 1 || parsedClaudeAsk[0].function.name !== 'ask_user_choice') {
  throw new Error('场景25 Claude 请用户选择应解析为弹窗询问')
}
const claudeAskArgs = JSON.parse(parsedClaudeAsk[0].function.arguments)
if (!String(claudeAskArgs.question || '').includes('主题') || claudeAskArgs.options.length !== 2) {
  throw new Error('场景25 Claude 请用户选择应带问题和两个选项')
}
if (!claudeAskArgs.options[0].label || String(claudeAskArgs.options[0].desc || '').length < 6) {
  throw new Error('场景25 Claude 选项应有标题和说明')
}
const parsedPlainAsk = bridge.parseLingxiToolCalls(claudeAsk, codingTools)
if (parsedPlainAsk.length !== 1 || parsedPlainAsk[0].function.name !== 'ask_user_choice') {
  throw new Error('场景25 DeepSeek 也应把请用户选择收成弹窗询问')
}
if (claudePrompt.includes('"calls"') || claudePrompt.includes('json 代码块')) {
  throw new Error('场景25 Claude 提示仍不能出现 json 工具调用块')
}

const { filterWebGptCoreTools } = require('../../../electron/modules/capability-tiers.js')
const webPlanMemoTools = filterWebGptCoreTools([
  { function: { name: 'confirm_plan' } },
  { function: { name: 'complete_step' } },
  { function: { name: 'enter_plan_mode' } },
  { function: { name: 'record_ai_operation_memo' } },
  { function: { name: 'project_history' } },
  { function: { name: 'show_thinking_note' } },
  { function: { name: 'mcp' } }
]).map(tool => tool.function.name)
if (!webPlanMemoTools.includes('confirm_plan') || !webPlanMemoTools.includes('complete_step') || !webPlanMemoTools.includes('enter_plan_mode') || !webPlanMemoTools.includes('record_ai_operation_memo') || !webPlanMemoTools.includes('project_history')) {
  throw new Error('场景25 页面端应开放计划、进度和备忘录工具')
}
if (webPlanMemoTools.includes('show_thinking_note') || webPlanMemoTools.includes('mcp')) {
  throw new Error('场景25 页面端仍应裁掉过程工具和 MCP')
}
const planMemoTools = codingTools.concat([
  { type: 'function', function: { name: 'confirm_plan', parameters: { required: ['plan'], properties: { plan: {} } } } },
  { type: 'function', function: { name: 'complete_step', parameters: { required: ['step_index', 'total_steps', 'steps', 'status'], properties: { step_index: {}, total_steps: {}, steps: {}, status: {} } } } },
  { type: 'function', function: { name: 'enter_plan_mode', parameters: { required: ['reason'], properties: { reason: {} } } } },
  { type: 'function', function: { name: 'record_ai_operation_memo', parameters: { required: ['title', 'summary', 'changes'], properties: { title: {}, summary: {}, changes: {} } } } },
  { type: 'function', function: { name: 'project_history', parameters: { required: ['action'], properties: { action: {}, query: {}, memo_id: {} } } } }
])
const planMemoPrompt = gpt.buildWebChatPrompt({
  messages: [{ role: 'user', content: '改一下首页样式' }],
  tools: planMemoTools
}, [{ role: 'system', content: '继续同一任务。只填写调用标签，本地客户端会解析。' }], 'continuation')
if (!planMemoPrompt.includes('confirm_plan') || !planMemoPrompt.includes('complete_step') || !planMemoPrompt.includes('record_ai_operation_memo') || !planMemoPrompt.includes('project_history')) {
  throw new Error('场景25 页面端工具轮应出现计划和进度工具')
}
const parsedPlan = gpt.parseLingxiToolCalls('<LINGXI_TOOL_CALLS>{"calls":[{"name":"confirm_plan","arguments":{"steps":["定位入口","改首页样式","核对页面"],"title":"先改首页"}}]}</LINGXI_TOOL_CALLS>', planMemoTools)
if (parsedPlan.length !== 1 || parsedPlan[0].function.name !== 'confirm_plan') {
  throw new Error('场景25 confirm_plan 应解析成功')
}
const parsedPlanArgs = JSON.parse(parsedPlan[0].function.arguments)
if (!Array.isArray(parsedPlanArgs.plan) || parsedPlanArgs.plan.length !== 3 || parsedPlanArgs.summary !== '先改首页') {
  throw new Error('场景25 confirm_plan 应从 steps/title 收成 plan/summary')
}
const parsedMemo = gpt.parseLingxiToolCalls('<LINGXI_TOOL_CALLS>{"calls":[{"name":"record_ai_operation_memo","arguments":{"title":"统一首页入口","description":"把入口收到同一处","files":["frontend/index.html"]}}]}</LINGXI_TOOL_CALLS>', planMemoTools)
if (parsedMemo.length !== 1 || parsedMemo[0].function.name !== 'record_ai_operation_memo') {
  throw new Error('场景25 record_ai_operation_memo 应解析成功')
}
const parsedMemoArgs = JSON.parse(parsedMemo[0].function.arguments)
if (parsedMemoArgs.summary !== '把入口收到同一处' || !Array.isArray(parsedMemoArgs.changes) || parsedMemoArgs.changes[0].path !== 'frontend/index.html') {
  throw new Error('场景25 备忘录应从 description/files 收成 summary/changes')
}
const parsedHistory = gpt.parseLingxiToolCalls('<LINGXI_TOOL_CALLS>{"calls":[{"name":"project_history","arguments":{"action":"memos","q":"弹窗入口"}}]}</LINGXI_TOOL_CALLS>', planMemoTools)
if (parsedHistory.length !== 1 || parsedHistory[0].function.name !== 'project_history') {
  throw new Error('场景25 project_history 应解析成功')
}
const parsedHistoryArgs = JSON.parse(parsedHistory[0].function.arguments)
if (parsedHistoryArgs.action !== 'search_memos' || parsedHistoryArgs.query !== '弹窗入口') {
  throw new Error('场景25 project_history 应从 memos/q 收成 search_memos/query')
}

const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
if (gpt.getSuggestedChatModel().capabilities?.vision !== true) {
  throw new Error('场景24 GPT 网页聊天应具备视觉理解')
}
const visionMsgs = gpt.normalizeWebChatMessages({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: tinyPng } }
    ]
  }]
})
if (!visionMsgs[0]?.images?.length || /暂不支持/.test(visionMsgs[0].content)) {
  throw new Error('场景24 用户图片应保留并转发给 ChatGPT')
}
if (!gpt.getLatestWebUserImages(visionMsgs).length) {
  throw new Error('场景24 应取出最近一张用户图')
}
const visionFiles = gpt.materializeWebChatImages(visionMsgs[0].images)
if (!visionFiles.length || !fs.existsSync(visionFiles[0].path)) {
  throw new Error('场景24 图片应落成临时文件')
}
fs.unlinkSync(visionFiles[0].path)
const visionPrompt = gpt.buildWebChatPrompt({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: tinyPng } }
    ]
  }]
})
if (!visionPrompt.includes('已向 ChatGPT 附加') || visionPrompt.includes(tinyPng.slice(-24))) {
  throw new Error('场景24 提示词不能塞 data URI，但要标明已附图')
}

if (resolveWebBridgeApiMode({ headers: { 'x-lingxi-project-id': 'abc123' } }) !== WEB_BRIDGE_MODE_LINGXI) {
  throw new Error('场景26 带灵犀项目头应走原协议')
}
if (resolveWebBridgeApiMode({ headers: {} }) !== WEB_BRIDGE_MODE_PASSTHROUGH) {
  throw new Error('场景26 外部请求默认应走透传')
}
if (resolveWebBridgeApiMode({
  headers: { 'x-lingxi-project-id': 'abc123', 'x-lingxi-bridge-mode': 'passthrough' }
}) !== WEB_BRIDGE_MODE_PASSTHROUGH) {
  throw new Error('场景26 无灵犀工具时，显式透传头应覆盖灵犀项目头')
}
if (resolveWebBridgeApiMode({ headers: {}, queryMode: 'lingxi' }) !== WEB_BRIDGE_MODE_LINGXI) {
  throw new Error('场景26 query mode=lingxi 应强制原协议')
}
if (resolveWebBridgeApiMode({
  headers: {},
  body: { tools: codingTools }
}) !== WEB_BRIDGE_MODE_LINGXI) {
  throw new Error('场景26 灵犀工具表即使没有项目头也不能走透传')
}
if (resolveWebBridgeApiMode({
  headers: { 'x-lingxi-bridge-mode': 'passthrough' },
  body: {
    messages: [{ role: 'system', content: '【内部工作流指令】\n先写这一轮打算怎么做。' }],
    tools: codingTools
  }
}) !== WEB_BRIDGE_MODE_LINGXI) {
  throw new Error('场景26 灵犀内部工作流请求不能被透传头改协议')
}
const leakedLingxiPrompt = gpt.buildWebChatPrompt({
  messages: [{
    role: 'system',
    content: '【内部工作流指令】\n先写这一轮打算怎么做。\n不要输出 <LINGXI_TOOL_CALLS>。'
  }, { role: 'user', content: '改一下首页样式' }],
  tools: codingTools
}, null, 'initial', { passthrough: true })
if (leakedLingxiPrompt.includes('这是网页聊天转发') || leakedLingxiPrompt.includes('不要写 LINGXI 标签')) {
  throw new Error('场景26 灵犀工具协议不能被透传 json 方言覆盖')
}
if (leakedLingxiPrompt.includes('--- system 1 ---')) {
  throw new Error('场景26 灵犀请求不能改用透传 transcript 标签')
}
const foreignTools = [
  { type: 'function', function: { name: 'Read', parameters: { properties: { path: {} } } } },
  { type: 'function', function: { name: 'Bash', parameters: { properties: { command: {} } } } }
]
const passthroughPrompt = gpt.buildWebChatPrompt({
  messages: [
    { role: 'system', content: `${'Keep the foreign agent prompt. '.repeat(40)}show_thinking_note` },
    { role: 'user', content: '打开 README' }
  ],
  tools: foreignTools
}, null, 'initial', { passthrough: true })
if (!passthroughPrompt.includes('Keep the foreign agent prompt')) {
  throw new Error('场景26 透传应保留对方系统提示')
}
if (!passthroughPrompt.includes('Read') || !passthroughPrompt.includes('Bash')) {
  throw new Error('场景26 透传应列出对方工具名')
}
if (passthroughPrompt.includes('<LINGXI_TOOL_CALLS>') || passthroughPrompt.includes('<LINGXI_FINAL>') || passthroughPrompt.includes('阶段性说明')) {
  throw new Error('场景26 透传不能再用灵犀标签或开场阶段性说明')
}
const lingxiStill = gpt.buildWebChatPrompt({
  messages: [{ role: 'user', content: '改一下首页样式' }],
  tools: codingTools
})
if (!lingxiStill.includes('confirm_plan') || lingxiStill.includes('Read(')) {
  throw new Error('场景26 灵犀默认提示不能被透传模式带偏')
}
const parsedForeign = gpt.parseLingxiToolCalls(
  '```json\n{"calls":[{"name":"Read","arguments":{"path":"README.md"}}]}\n```',
  foreignTools,
  { passthrough: true }
)
if (parsedForeign.length !== 1 || parsedForeign[0].function.name !== 'Read') {
  throw new Error('场景26 透传应解析对方工具名')
}
if (JSON.parse(parsedForeign[0].function.arguments).path !== 'README.md') {
  throw new Error('场景26 透传应保留对方工具参数')
}
const parsedForeignClaude = claudeBridge.parseLingxiToolCalls(
  '```json\n{"calls":[{"name":"Bash","arguments":{"command":"ls"}}]}\n```',
  foreignTools,
  { passthrough: true }
)
if (parsedForeignClaude.length !== 1 || parsedForeignClaude[0].function.name !== 'Bash') {
  throw new Error('场景26 Claude 透传也应解析对方工具，而不是把代码块当成写文件')
}
let foreignRejected = false
try {
  gpt.parseLingxiToolCalls(
    '```json\n{"calls":[{"name":"Read","arguments":{"path":"README.md"}}]}\n```',
    codingTools,
    { passthrough: true }
  )
} catch (error) {
  foreignRejected = error.code === 'INVALID_TOOL_CALL_PROTOCOL'
}
if (!foreignRejected) throw new Error('场景26 透传仍只能调用本次请求里的工具')
const claudePassthrough = claudeBridge.buildWebChatPrompt({
  messages: [{ role: 'user', content: '打开 README\n当前项目路径：E:/demo' }],
  tools: foreignTools
}, null, 'initial', { passthrough: true })
if (claudePassthrough.includes('请用户选择') || claudePassthrough.includes('hello-paste')) {
  throw new Error('场景26 Claude 透传不应再贴项目文件或灵犀选择格式')
}
if (!claudePassthrough.includes('Read') || claudePassthrough.includes('<LINGXI_TOOL_CALLS>')) {
  throw new Error('场景26 Claude 透传应使用通用 json 工具协议')
}
if (!passthroughPrompt.includes('不要写进 json 字符串')) {
  throw new Error('场景26 透传应要求长代码放在 json 外')
}
const runCodeTools = [
  { type: 'function', function: { name: 'run_code', parameters: { required: ['code'], properties: { code: {}, description: {} } } } }
]
const lingxiLane = getWebBridgeAgentLane({ body: { tools: codingTools } })
const dshLane = getWebBridgeAgentLane({ body: { tools: runCodeTools } })
const bashLane = getWebBridgeAgentLane({ body: { tools: foreignTools } })
if (lingxiLane !== 'lingxi') throw new Error('场景26 灵犀工具表应落在灵犀会话道')
if (dshLane === lingxiLane || bashLane === lingxiLane || dshLane === bashLane) {
  throw new Error('场景26 不同 agent 产品必须分到不同会话道')
}
const lingxiSession = buildWebChatSessionKey({ projectId: 'p1', sessionId: 's1', lane: 'lingxi' })
const lingxiSessionOld = buildWebChatSessionKey({ projectId: 'p1', sessionId: 's1' })
if (lingxiSession !== lingxiSessionOld) throw new Error('场景26 灵犀会话键不能因分道而失效')
if (buildWebChatSessionKey({ sessionId: 'default', lane: dshLane }) === lingxiSession) {
  throw new Error('场景26 外部 agent 不能复用灵犀会话键')
}
const lingxiPage = { url: () => 'https://chatgpt.com/c/lingxi', isClosed: () => false }
const stolen = pickReusableWebChatPage([lingxiPage], {
  sessionKey: 'dsh',
  chatSessions: new Map([['lingxi', { page: lingxiPage }]])
})
if (stolen) throw new Error('场景26 不能把别的 agent 正在用的网页对话抢过来')
let conv = rememberSavedConversation({}, 'lx', 'https://chatgpt.com/c/lingxi', 'proj', 'lingxi')
conv = rememberSavedConversation(conv, 'dsh', 'https://chatgpt.com/c/dsh', 'proj', dshLane)
if (getSavedConversationUrl(conv, 'missing', 'proj', 'lingxi') !== 'https://chatgpt.com/c/lingxi') {
  throw new Error('场景26 灵犀仍可按项目回落到自己的对话')
}
if (getSavedConversationUrl(conv, 'missing', 'proj', dshLane) === 'https://chatgpt.com/c/lingxi') {
  throw new Error('场景26 外部 agent 不能回落到灵犀网页对话')
}
const messyRunCode = [
  '我们需要理解用户的请求。',
  'json',
  '{"calls":[{"name":"run_code","arguments":{"code":"import * as fs from \'fs\';',
  'console.log("hi");',
  '","description":"列出目录"}}]}'
].join('\n')
const parsedMessy = gpt.parseLingxiToolCalls(messyRunCode, runCodeTools, { passthrough: true })
if (parsedMessy.length !== 1 || parsedMessy[0].function.name !== 'run_code') {
  throw new Error('场景26 未转义换行的 run_code 也应能解析')
}
if (!String(JSON.parse(parsedMessy[0].function.arguments).code || '').includes('console.log')) {
  throw new Error('场景26 宽松解析应保留代码正文')
}
const splitRunCode = [
  '```json',
  '{"calls":[{"name":"run_code","arguments":{"description":"列出目录"}}]}',
  '```',
  '```ts',
  "import * as fs from 'fs'",
  'console.log("hi")',
  '```'
].join('\n')
const parsedSplit = gpt.parseLingxiToolCalls(splitRunCode, runCodeTools, { passthrough: true })
if (parsedSplit.length !== 1 || !String(JSON.parse(parsedSplit[0].function.arguments).code || '').includes('console.log')) {
  throw new Error('场景26 json 短参数 + 后续代码块应合并成 run_code')
}

const lingxiPrompt = gpt.buildWebChatPrompt({
  messages: [{ role: 'user', content: '打开 README\n当前项目路径：E:/demo' }],
  tools: codingTools
})
if (lingxiPrompt.includes('本地调用方会执行 run_code') || lingxiPrompt.includes('run_code: 五到十字说明')) {
  throw new Error('场景26 灵犀原协议不能掺 Harness run_code 方言')
}
const runCodePrompt = gpt.buildWebChatPrompt({
  messages: [
    { role: 'system', content: `SDK_HEAD ${'x'.repeat(12000)} SDK_TAIL_MARKER await tools.glob` },
    { role: 'user', content: '列出项目文件' }
  ],
  tools: runCodeTools
}, null, 'initial', { passthrough: true })
if (!runCodePrompt.includes('run_code: 五到十字说明') || !runCodePrompt.includes('```ts')) {
  throw new Error('场景26 run_code 透传应要求网页输出 ts 代码块')
}
if (runCodePrompt.includes('只输出一个 json 代码块') || runCodePrompt.includes('<LINGXI_TOOL_CALLS>')) {
  throw new Error('场景26 run_code 透传不应再逼网页把程序写进 json 或灵犀标签')
}
if (!runCodePrompt.includes('SDK_TAIL_MARKER')) {
  throw new Error('场景26 run_code 透传应保留对方较长的 SDK 系统提示')
}
const dialectFence = [
  'The user wants a listing of the workspace.',
  'I will inspect files with glob.',
  'run_code: 列出项目文件',
  '```ts',
  "const files = await tools.glob({ pattern: '**/*' })",
  'console.log(files)',
  '```'
].join('\n')
const parsedDialect = gpt.parseLingxiToolCalls(dialectFence, runCodeTools, { passthrough: true })
if (parsedDialect.length !== 1 || parsedDialect[0].function.name !== 'run_code') {
  throw new Error('场景26 思考文字 + ts 代码块应解析为 run_code')
}
const dialectArgs = JSON.parse(parsedDialect[0].function.arguments)
if (!String(dialectArgs.code || '').includes('await tools.glob') || !String(dialectArgs.description || '').includes('列出')) {
  throw new Error('场景26 run_code 应带上代码和说明')
}
const unlabeledFence = [
  '先看一下工作区里有哪些文件。',
  '```typescript',
  "const files = await tools.glob({ pattern: '**/*' })",
  'console.log(files)',
  '```'
].join('\n')
const parsedUnlabeled = gpt.parseLingxiToolCalls(unlabeledFence, runCodeTools, { passthrough: true })
if (parsedUnlabeled.length !== 1 || !String(JSON.parse(parsedUnlabeled[0].function.arguments).code || '').includes('await tools.glob')) {
  throw new Error('场景26 仅有 run_code 时，ts 代码块也应收成 tool_calls')
}
const lingxiFence = gpt.parseLingxiToolCalls(dialectFence, codingTools)
if (lingxiFence.some(call => call.function.name === 'run_code')) {
  throw new Error('场景26 灵犀路径不能把 ts 代码块当成 run_code')
}
const retryRunCode = require('../../../electron/modules/web-bridge-coding-protocol').buildWebToolProtocolRetryPrompt('bad', {
  passthrough: true,
  tools: runCodeTools
})
if (!retryRunCode.includes('run_code:') || retryRunCode.includes('只写工具名和短参数')) {
  throw new Error('场景26 run_code 重试应继续用代码块方言')
}
const claudeRunCodePrompt = claudeBridge.buildWebChatPrompt({
  messages: [{ role: 'user', content: '列出文件' }],
  tools: runCodeTools
}, null, 'initial', { passthrough: true })
if (!claudeRunCodePrompt.includes('```ts') || claudeRunCodePrompt.includes('请用户选择') || claudeRunCodePrompt.includes('"calls"')) {
  throw new Error('场景26 Claude 透传 run_code 也应走代码块方言，而不是灵犀贴文件或 json')
}
const pageInnerText = [
  '明白了，您说“没法当成 run_code 执行”可能是因为之前的格式或说明不够清晰。现在我严格按照您给的格式重新发一次：',
  '',
  'run_code: 列出项目所有文件',
  '',
  'ts',
  'const files = await tools.glob({ pattern: \'**/*\' })',
  'console.log(files)',
  '如果执行后能正常打印文件列表，就说明项目结构已清晰；如果还有问题，请告诉我具体的报错信息，我再调整代码。'
].join('\n')
const parsedPageInner = gpt.parseLingxiToolCalls(pageInnerText, runCodeTools, { passthrough: true })
if (parsedPageInner.length !== 1 || parsedPageInner[0].function.name !== 'run_code') {
  throw new Error('场景26 DeepSeek 页面 innerText 丢失围栏时也应解析为 run_code')
}
const pageInnerArgs = JSON.parse(parsedPageInner[0].function.arguments)
if (!String(pageInnerArgs.code || '').includes('await tools.glob') || String(pageInnerArgs.code || '').includes('如果执行后')) {
  throw new Error('场景26 应只收 TypeScript 正文，去掉语言标签和后面的说明')
}
if (!String(pageInnerArgs.description || '').includes('列出项目所有文件')) {
  throw new Error('场景26 无围栏 run_code 应保留说明')
}
const dshPageReply = [
  '好的，我这就调用工具读取三个主要代码文件的内容，直接贴给您看。',
  '',
  'ts',
  "const files = ['index.html', 'styles.css', 'game.js']",
  'for (const f of files) {',
  '  const result = await tools.read({ file_path: `D:\\\\游戏05\\\\${f}` })',
  "  console.log('===== ' + f + ' =====')",
  "  console.log(result.lines.map(l => l.text).join('\\n'))",
  '}'
].join('\n')
const parsedDshPage = gpt.parseLingxiToolCalls(dshPageReply, runCodeTools, { passthrough: true })
if (parsedDshPage.length !== 1 || parsedDshPage[0].function.name !== 'run_code') {
  throw new Error('场景26 第三方 agent 的 tools.read 程序即使没有 run_code 头也应收成 tool_calls')
}
const dshPageArgs = JSON.parse(parsedDshPage[0].function.arguments)
if (!String(dshPageArgs.code || '').includes('await tools.read') || String(dshPageArgs.code || '').includes('直接贴给您看')) {
  throw new Error('场景26 应只收 TypeScript，不要把中文说明写进 run_code')
}
const mixedRunCodeTools = [
  ...runCodeTools,
  { type: 'function', function: { name: 'bash', parameters: { properties: { command: {} } } } }
]
const parsedMixedDsh = gpt.parseLingxiToolCalls(dshPageReply, mixedRunCodeTools, { passthrough: true })
if (parsedMixedDsh.length !== 1 || parsedMixedDsh[0].function.name !== 'run_code') {
  throw new Error('场景26 即使对方还带了其他短工具，tools.read 程序也应收成 run_code')
}
if (gpt.parseLingxiToolCalls(dshPageReply, codingTools).length) {
  throw new Error('场景26 灵犀路径不能把第三方 tools.read 程序当成工具调用')
}
const plainTalk = gpt.parseLingxiToolCalls('好的，我先看看项目结构再告诉你。', runCodeTools, { passthrough: true })
if (plainTalk.length) {
  throw new Error('场景26 普通文字不能收成 run_code')
}

const {
  applyTextEditList,
  normalizeTextEditArgs,
  hasUsableTextEdits
} = require('../../../electron/modules/text-edit-utils')
const uniqueSource = 'color: red;\nfont-size: 12px;\n'
const inferred = applyTextEditList(uniqueSource, [{ old_content: 'color: red;', new_content: 'color: blue;' }])
if (!inferred.content.startsWith('color: blue;') || inferred.applied[0].op !== 'replace') {
  throw new Error('场景27 缺 op 的 text_edit 应推断为 replace')
}
const aliased = normalizeTextEditArgs({
  path: 'E:/demo/style.css',
  edits: { old_string: 'a', new_string: 'b' }
})
if (!hasUsableTextEdits(aliased.edits) || aliased.edits[0].op !== 'replace' || aliased.edits[0].old_content !== 'a') {
  throw new Error('场景27 old_string/new_string 与单个 edits 对象应能规范化')
}
const topLevel = normalizeTextEditArgs({
  path: 'E:/demo/index.html',
  old_content: '<div></div>',
  new_content: '<div class="ok"></div>'
})
if (!hasUsableTextEdits(topLevel.edits) || topLevel.edits[0].op !== 'replace') {
  throw new Error('场景27 顶层 old_content/new_content 应转成 edits')
}
const emptyOpSource = 'color: red;\ncolor: red;\n'
const firstOnly = applyTextEditList(emptyOpSource, [{ old_content: 'color: red;', new_content: 'color: blue;' }], { lenient: true })
if (firstOnly.content !== 'color: blue;\ncolor: red;\n') {
  throw new Error('场景27 页面端多处命中时应只改第一处，而不是整轮拒绝')
}
let strictMultiFailed = false
try {
  applyTextEditList(emptyOpSource, [{ op: 'replace', old_content: 'color: red;', new_content: 'color: blue;' }])
} catch (error) {
  strictMultiFailed = /occurrences/.test(String(error.message || ''))
}
if (!strictMultiFailed) {
  throw new Error('场景27 API 模型多处命中仍应拒绝，避免误改')
}

const { findLooseLineAnchoredRange } = require('../../../electron/modules/text-edit-utils')
const cssSource = ['.hero {', '  color: red;', '  padding: 8px;', '}', ''].join('\n')
const looseCss = findLooseLineAnchoredRange(cssSource, '.hero {\n    color: red;\n    padding: 8px;\n}')
if (!looseCss || cssSource.slice(looseCss.start, looseCss.end).indexOf('color: red') < 0) {
  throw new Error('场景28 页面端补丁应按行宽松匹配，不能因缩进不同就 context not found')
}

const noEndPatch = parseApplyPatch([
  '*** Begin Patch',
  '*** Update File: E:/demo/index.html',
  '@@',
  '-<title>旧</title>',
  '+<title>新</title>'
].join('\n'), { lenient: true })
if (!noEndPatch.length || noEndPatch[0].type !== 'update') {
  throw new Error('场景28 页面端缺少 End Patch 也应解析补丁，不能硬拒绝')
}

const htmlLine = ' <link rel="preconnect" href="https://fonts.googleapis.com" />'
const escapedFix = applyTextEditList(htmlLine + '\n', [{
  op: 'replace',
  old_content: ' <link rel="preconnect" href="https://fonts.googleapis.com\\" />',
  new_content: htmlLine
}], { lenient: true })
if (!String(escapedFix.content || '').includes('fonts.googleapis.com')) {
  throw new Error('场景29 页面端把 JSON 转义写进 old_content 时应按去转义匹配，不能硬拒绝')
}
const alreadyFixed = applyTextEditList(htmlLine + '\n', [{
  op: 'replace',
  old_content: 'THIS_DOES_NOT_EXIST',
  new_content: htmlLine
}], { lenient: true })
if (alreadyFixed.applied[0].match_mode !== 'already_applied') {
  throw new Error('场景29 目标内容已在文件里时，缺 old_content 命中应视为已应用，而不是再卡写入')
}

const lineReplace = normalizeTextEditArgs({
  path: 'E:/demo/index.html',
  start_line: 7,
  end_line: 9,
  new_content: htmlLine
}, { lenient: true })
if (!hasUsableTextEdits(lineReplace.edits) || lineReplace.edits[0].op !== 'replace_lines') {
  throw new Error('场景29 顶层 start_line 应转成 replace_lines，不能报缺少 edits')
}

const {
  tryExtractLingxiCallsLoose
} = require('../../../electron/modules/web-bridge-coding-protocol')
const mashed = tryExtractLingxiCallsLoose('<LINGXI_TOOL_CALLS>{"calls":[{"name":"shell_run","arguments":{"command":"python _fix_page.py","cwd":"E:/demo"}}]}</LINGXI_TOOL_CALLS>')
const mashedArgs = mashed?.calls?.[0]?.arguments || {}
const splitShell = normalizeWebToolCallArgs('shell_run', mashedArgs)
if (String(splitShell.command || '').includes('cwd') || String(splitShell.cwd || '').indexOf('E:/demo') < 0) {
  throw new Error('场景29 shell_run 的 cwd 不能被拼进 command')
}

const deleteArgs = normalizeWebToolCallArgs('file_manage', { action: 'delete_file', path: 'E:/demo/_fix_page.py' })
if (deleteArgs.action !== 'delete') {
  throw new Error('场景29 file_manage action=delete_file 应识别为 delete')
}
const mashedStatus = normalizeWebToolCallArgs('shell_run', {
  action: 'status","session_id":"term-msvjlm1t-eqsivk'
})
if (mashedStatus.action !== 'status' || mashedStatus.session_id !== 'term-msvjlm1t-eqsivk') {
  throw new Error('场景29 页面端把 session_id 挤进 shell_run action 时应拆开: ' + JSON.stringify(mashedStatus))
}
const mashedInspect = normalizeWebToolCallArgs('code_inspect', {
  path: 'E:/灵犀-11/03/灵犀-05/frontend/index.html","query":"cloud-token-usage.css'
})
if (!String(mashedInspect.path || '').endsWith('frontend/index.html') || mashedInspect.query !== 'cloud-token-usage.css' || mashedInspect.action !== 'locate') {
  throw new Error('场景29 页面端把 query 挤进 path 时应拆开并补 action: ' + JSON.stringify(mashedInspect))
}

const {
  sanitizeWebBridgeSourceText,
  sanitizeWebBridgePatch
} = require('../../../electron/modules/web-bridge-coding-protocol')
const leakedCss = [
  '\\:root { --bg: #111; }',
  '/* ===== 噪点 ===== /',
  'body::before { background-image: url(\\"data:image/svg+xml,%3Csvg/%3E\\"); }',
  '\\@media (max-width: 768px) {',
  ' a\\:nth-child(2) { color: red; }',
  '}'
].join('\n')
const cleanedCss = sanitizeWebBridgeSourceText(leakedCss, 'E:/demo/style.css')
if (cleanedCss.includes('\\:root') || cleanedCss.includes('\\@media') || cleanedCss.includes('\\:nth-child')) {
  throw new Error('场景29 JSON 转义不能写进 CSS: ' + cleanedCss)
}
if (!cleanedCss.includes(':root {') || !cleanedCss.includes('@media (max-width') || !cleanedCss.includes('a:nth-child(2)')) {
  throw new Error('场景29 应还原 :root/@media/:nth-child: ' + cleanedCss)
}
if (!cleanedCss.includes('===== */')) {
  throw new Error('场景29 残缺 CSS 注释应补成 */: ' + cleanedCss)
}
if (cleanedCss.includes('url(\\"') || cleanedCss.includes('\\");')) {
  throw new Error('场景29 CSS data URL 不应残留 JSON 引号转义: ' + cleanedCss)
}
const cleanedWrite = normalizeWebToolCallArgs('write_file', {
  path: 'E:/demo/style.css',
  content: '\\:root { color: #fff; }\n/* ===== 进度条 ===== /\n@media (max-width: 480px) { body { margin: 0; } }'
})
if (String(cleanedWrite.content || '').includes('\\:root') || !String(cleanedWrite.content || '').includes('===== */')) {
  throw new Error('场景29 write_file 落盘前应清洗 CSS 转义和残缺注释: ' + cleanedWrite.content)
}
const cleanedPatch = sanitizeWebBridgePatch([
  '*** Begin Patch',
  '*** Update File: E:/demo/style.css',
  '@@',
  '+\\:root { --bg: #fff; }',
  '+/* ===== 背景 ===== /',
  '*** End Patch'
].join('\n'))
if (cleanedPatch.includes('\\:root') || !cleanedPatch.includes('+:root') || !cleanedPatch.includes('===== */')) {
  throw new Error('场景29 apply_patch 新增行也应清洗: ' + cleanedPatch)
}

const editTools = [{ type: 'function', function: { name: 'text_edit', parameters: {} } }]
const rawLineEdit = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"text_edit","arguments":{"path":"E:/demo/index.html","edits":[{"op":"replace_lines","start_line":7,"end_line":9,"new_content":" <link rel="preconnect" href="https://fonts.googleapis.com" />"}]}}]}</LINGXI_TOOL_CALLS>'
const parsedLineEdit = bridge.parseLingxiToolCalls(rawLineEdit, editTools)
if (parsedLineEdit.length !== 1 || parsedLineEdit[0].function.name !== 'text_edit') {
  throw new Error('场景29 未转义引号的按行 text_edit 应能解析，不能报缺少 edits')
}
const lineEditArgs = JSON.parse(parsedLineEdit[0].function.arguments)
if (!Array.isArray(lineEditArgs.edits) || lineEditArgs.edits[0].op !== 'replace_lines' || Number(lineEditArgs.edits[0].start_line) !== 7) {
  throw new Error('场景29 按行 text_edit 解析后应保留 start_line')
}

const mixedRaw = '<LINGXI_TOOL_CALLS>{"calls":[{"name":"text_edit","arguments":{"path":"E:/demo/index.html","edits":[{"op":"replace_lines","start_line":7,"end_line":9,"new_content":""}]}},{"name":"text_edit","arguments":{"path":"E:/demo/index.html","edits":[{"op":"regex","pattern":"\\s+xmlns="[^"]"","replacement":"","all":true}]}}]}</LINGXI_TOOL_CALLS>'
const mixedParsed = bridge.parseLingxiToolCalls(mixedRaw, editTools)
if (!mixedParsed.length || mixedParsed[0].function.name !== 'text_edit') {
  throw new Error('场景30 同一批里有一条坏 JSON 时，合法的按行覆盖仍应执行，不能整单作废')
}
const mixedArgs = JSON.parse(mixedParsed[0].function.arguments)
if (!Array.isArray(mixedArgs.edits) || mixedArgs.edits[0].op !== 'replace_lines' || Number(mixedArgs.edits[0].start_line) !== 7) {
  throw new Error('场景30 应保留可执行的 replace_lines')
}

{
  const brokenHtml = [
    '<div class="hero">',
    ':root { --accent: #f00; }',
    '<span>标题',
    '<svg><circle cx="1" cy="1" r="1">'
  ].join('\n')
  const htmlProblems = inspectWebBridgeHtmlDocument('D:/0098测试/index.html', brokenHtml)
  if (!htmlProblems.some(item => /DOCTYPE|html|head|body|style|div|span|svg/i.test(item))) {
    throw new Error('场景31 残缺 HTML 应被结构检查识别')
  }
  let rejected = false
  try {
    assertWebBridgeHtmlDocument('D:/0098测试/index.html', brokenHtml)
  } catch (error) {
    rejected = error?.code === 'INVALID_HTML_DOCUMENT'
  }
  if (!rejected) throw new Error('场景31 残缺 HTML 写入前必须拒绝')

  const blockingFinal = `${FINAL_OPEN}已为你成功创建页面。${FINAL_CLOSE}`
  if (shouldAcceptWebBridgeFinalReply({ blockingWrites: true })) {
    throw new Error('场景31 blocking 时不能接受最终暗号')
  }
  if (classifyWebBridgeAssistantReply(blockingFinal, {
    hadToolsThisTurn: true,
    userText: '做一个页面',
    blockingWrites: true
  }) !== 'continue') {
    throw new Error('场景31 blocking 后误发最终暗号必须 continue')
  }
  const unresolved = collectUnresolvedBlockingWebBridgeWriteDiagnostics([
    {
      name: 'write_file',
      result: {
        path: 'D:/0098测试/index.html',
        blocking: true,
        requires_fix: true,
        postEditDiagnostics: {
          blocking: true,
          requires_fix: true,
          errors: [{ message: 'Unclosed tag: <div>' }],
          next_action: 'fix_post_edit_diagnostics_from_code_frames_before_final_reply'
        }
      }
    },
    {
      name: 'write_file',
      result: {
        path: 'D:/0098测试/index.html',
        blocking: false,
        requires_fix: false,
        postEditDiagnostics: { ok: true, blocking: false, requires_fix: false }
      }
    }
  ])
  if (unresolved.length) {
    throw new Error('场景31 同路径最新写入已通过时，不应再保留旧 blocking')
  }
  const stillBlocking = collectUnresolvedBlockingWebBridgeWriteDiagnostics([
    {
      name: 'write_file',
      result: {
        path: 'D:/0098测试/index.html',
        blocking: true,
        requires_fix: true,
        syntaxWarning: { errors: [{ message: 'Unclosed tag: <html>' }] },
        next_action: 'fix_post_edit_diagnostics_from_code_frames_before_final_reply'
      }
    }
  ])
  if (!stillBlocking.length) throw new Error('场景31 未修复的写入应保持 blocking')
  const fixPrompt = buildWebBridgeBlockingWriteFixPrompt(stillBlocking)
  if (!fixPrompt.includes('禁止输出 <LINGXI_FINAL>') || !fixPrompt.includes('file_read')) {
    throw new Error('场景31 修复提示必须禁止最终暗号并要求先读后改')
  }
  const stageReject = buildWebBridgeStageFinalRejectPrompt({ dialect: WEB_BRIDGE_DIALECT_JSON_FENCE })
  if (!stageReject.includes('<LINGXI_STAGE>') || !stageReject.includes('禁止输出 <LINGXI_FINAL>')) {
    throw new Error('场景31 进度轮驳回提示必须要求阶段性暗号')
  }
  const geminiPrompt = assembleWebPagePrompt({
    mode: 'initial',
    transcript: '--- 用户 1 ---\n做一个电影感个人介绍页\n当前项目路径：D:/0098测试',
    tools: [{ name: 'write_file' }, { name: 'file_read' }, { name: 'file_search' }],
    maxToolCalls: 4,
    dialect: WEB_BRIDGE_DIALECT_JSON_FENCE,
    projectPath: 'D:/0098测试'
  })
  if (!geminiPrompt.includes('```json') || !geminiPrompt.includes('禁止输出 <LINGXI_TOOL_CALLS>')) {
    throw new Error('场景31 Gemini json-fence 协议应使用 json 代码块，并禁止 XML 工具标签')
  }
  if (/调用示例：\s*<LINGXI_TOOL_CALLS>/.test(geminiPrompt)) {
    throw new Error('场景31 Gemini json-fence 协议不得再把 XML 标签当调用示例')
  }
  if (!geminiPrompt.includes('<!DOCTYPE html>') || !geminiPrompt.includes('requires_fix')) {
    throw new Error('场景31 json-fence 协议应强调 HTML 完整性和 requires_fix')
  }
  const geminiInspectContinue = assembleWebPagePrompt({
    mode: 'continuation',
    dialect: WEB_BRIDGE_DIALECT_JSON_FENCE,
    transcript: [
      '--- 用户 1 ---',
      '可以再深入查看一下吗',
      '当前项目路径：E:/demo-game',
      '',
      '--- 灵犀工具结果 1 ---',
      '{"path":"E:/demo-game/package.json","content":"{\\"name\\":\\"lingxi-phaser-game\\"}"}'
    ].join('\n'),
    tools: [{ name: 'file_read' }, { name: 'file_search' }],
    projectPath: 'E:/demo-game'
  })
  if (!geminiInspectContinue.includes('file_read') || !geminiInspectContinue.includes('package.json')) {
    throw new Error('场景31 深入查看读完 package.json 后应继续读源码')
  }
  if (/已经能介绍项目就直接/.test(geminiInspectContinue) || geminiInspectContinue.includes('不要再写 json 代码块')) {
    throw new Error('场景31 读完配置文件后不能催模型立刻收口')
  }
  const packageOnlyCalls = [{ name: 'file_read', args: { path: 'package.json' }, result: { success: true, path: 'package.json' } }]
  if (!webBridgeInspectNeedsMore('可以再深入查看一下吗', packageOnlyCalls)) {
    throw new Error('场景31 只读 package.json 不能算深入查看完成')
  }
  const inspectNudge = buildWebBridgeInspectKeepGoingPrompt({
    userText: '可以再深入查看一下吗',
    toolCalls: packageOnlyCalls,
    dialect: WEB_BRIDGE_DIALECT_JSON_FENCE
  })
  if (!inspectNudge.includes('json 代码块') || !inspectNudge.includes('禁止输出 <LINGXI_FINAL>')) {
    throw new Error('场景31 深入查看催续必须禁止最终暗号并要求 json 调用: ' + inspectNudge)
  }
  if (classifyWebBridgeAssistantReply('这是基于 Phaser 3 的游戏，使用 Vite 和 TypeScript。', {
    hadToolsThisTurn: true,
    dialect: WEB_BRIDGE_DIALECT_JSON_FENCE,
    userText: '可以再深入查看一下吗',
    inspectNeedsMore: true
  }) !== 'continue') {
    throw new Error('场景31 只读 package.json 后的介绍不能当最终回复')
  }
}

{
  const oldFinal = `${FINAL_OPEN}已为你成功创建电影感个人介绍页，首页结构已经写好。${FINAL_CLOSE}`
  const dumped = formatLingxiWebChatTranscript([
    { role: 'user', content: '做一个电影感个人介绍页' },
    { role: 'assistant', content: oldFinal },
    { role: 'user', content: '颜色再暗一点' }
  ])
  if (dumped.includes('已为你成功创建') || dumped.includes('--- 助手')) {
    throw new Error('场景32 下一轮网页提示不能再贴上一轮最终回复')
  }
  if (!dumped.includes('颜色再暗一点')) {
    throw new Error('场景32 新用户消息仍应发给网页')
  }
  const stale = extractWebBridgeReplyDelta(
    { count: 1, markdown: oldFinal, innerText: oldFinal },
    { count: 1, markdown: oldFinal, innerText: oldFinal }
  )
  if (stale.markdown || stale.innerText) {
    throw new Error('场景32 同一条最终回复不能再当增量抓取')
  }
  const chromeOnly = extractWebBridgeReplyDelta(
    { count: 1, markdown: `${oldFinal}\nCopy`, innerText: `${oldFinal} Copy` },
    { count: 1, markdown: oldFinal, innerText: oldFinal }
  )
  if (chromeOnly.markdown || chromeOnly.innerText) {
    throw new Error('场景32 旧终稿上的复制按钮不能当成新回复')
  }
  if (!isStaleWebBridgeHarvest({ markdown: oldFinal }, { markdown: oldFinal })) {
    throw new Error('场景32 应识别旧终稿为过期抓取')
  }
  if (!isStaleWebBridgeHarvest({ markdown: oldFinal, innerText: oldFinal }, { markdown: oldFinal, innerText: oldFinal })) {
    throw new Error('场景32 完整旧终稿不能当成可用抓取')
  }
  const fresh = extractWebBridgeReplyDelta(
    { count: 2, markdown: '好的，我把背景改成更深的蓝黑。', innerText: '好的，我把背景改成更深的蓝黑。' },
    { count: 1, markdown: oldFinal, innerText: oldFinal }
  )
  if (!fresh.markdown.includes('更深的蓝黑')) {
    throw new Error('场景32 新气泡仍应正常抓取')
  }
}

console.log('DeepSeek tool-call parser PASS')

