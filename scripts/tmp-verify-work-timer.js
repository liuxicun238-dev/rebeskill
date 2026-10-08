const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = path.resolve(__dirname, '..')
const chatCss = fs.readFileSync(path.join(root, 'frontend/styles/chat.css'), 'utf8')
const ui = fs.readFileSync(path.join(root, 'frontend/scripts/features/ai-message-ui.js'), 'utf8')
const formatSrc = fs.readFileSync(path.join(root, 'frontend/scripts/utils/format-utils.js'), 'utf8')
const i18n = fs.readFileSync(path.join(root, 'frontend/i18n/modules/zh/tool_display.js'), 'utf8')

if (!chatCss.includes('.ai-work-detail-header') || !chatCss.includes('border-bottom')) {
  throw new Error('计时区域下方应有分割线')
}
if (!chatCss.includes('width: 0.33em') || !chatCss.includes('gap: 0.28em')) {
  throw new Error('计时左侧圆点应随字体 em 缩放')
}
if (!ui.includes('已工作 0 秒') || !ui.includes('formatWorkElapsedLabel')) {
  throw new Error('实时计时应使用「已工作」文案')
}
if (!i18n.includes("'toolDisplay.text.elapsed': '已工作 {duration}'")) {
  throw new Error('历史计时 i18n 应改为已工作')
}

const sandbox = { window: {} }
vm.runInNewContext(formatSrc, sandbox)
const FormatUtils = sandbox.window.FormatUtils
if (FormatUtils.formatWorkElapsedLabel(138) !== '已工作 2 分 18 秒') {
  throw new Error('2分18秒应格式化为「已工作 2 分 18 秒」，实际: ' + FormatUtils.formatWorkElapsedLabel(138))
}
if (FormatUtils.formatWorkElapsedLabel(13) !== '已工作 13 秒') {
  throw new Error('纯秒数格式不正确: ' + FormatUtils.formatWorkElapsedLabel(13))
}

console.log('work-timer: copy/divider/dots OK')
