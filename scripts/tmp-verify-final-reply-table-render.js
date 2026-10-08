const fs = require('fs')
const path = require('path')
const parser = require('../frontend/scripts/features/markdown-table-parser')

const root = path.resolve(__dirname, '..')
const css = fs.readFileSync(path.join(root, 'frontend/styles/chat.css'), 'utf8')
const ui = fs.readFileSync(path.join(root, 'frontend/scripts/features/ai-message-ui.js'), 'utf8')
const index = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8')

for (const token of [
  '.ai-structured-table',
  '.ai-table-view-switch',
  '.ai-table-chart-bar',
  '.ai-table-series-1',
  '.ai-table-wrap',
  'li.ai-task-item'
]) {
  if (!css.includes(token)) throw new Error('chat.css 缺少表格样式: ' + token)
}

if (!ui.includes('renderMarkdownListItem') || !ui.includes('ai-task-item')) {
  throw new Error('列表渲染应识别 [x]/[✅] 任务项')
}
if (!ui.includes('renderStructuredMarkdownTable') || !ui.includes('data-ai-table-view="chart"')) {
  throw new Error('最终回复应渲染结构化表格和图表切换')
}
if (index.indexOf('markdown-table-parser.js') > index.indexOf('ai-message-ui.js')) {
  throw new Error('表格解析器必须先于消息渲染加载')
}

const extracted = parser.extractTables([
  '说明',
  '文件 | 行数 | 评价',
  '--- | ---: | ---',
  'electron/modules/ai-chat.js | 4535 | 仍然单文件',
  'frontend/scripts/app.js | 3231 | 巨石化未改善'
].join('\n'))
if (extracted.tables.length !== 1 || extracted.tables[0].header.length !== 3) {
  throw new Error('三列表格应完整解析: ' + JSON.stringify(extracted.tables[0]?.header))
}
const chart = parser.getChartModel(extracted.tables[0])
if (!chart || chart.series[0].values.join() !== '4535,3231') {
  throw new Error('行数表应能生成图表模型')
}

console.log('final-reply-table-render: css/task-list/parser OK')
