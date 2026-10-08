/**
 * Stable high-level capability tools.
 *
 * Keep these small and provider-agnostic. The model calls these names; the
 * runtime decides which configured API, web bridge, browser, or routed model
 * actually performs the work.
 */

module.exports = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '稳定的网页搜索入口。模型可根据任务主动搜索公开网页、最新资料或官方文档，不需要知道底层是搜索 API、ChatGPT web.run 还是其他网页桥。需要核对来源时优先调用本工具；返回答案、日期和来源链接。当前对话模型不具备搜索能力也不影响，系统会自动选择已配置的搜索后端。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查询的问题或关键词' },
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: '可选的补充查询词；适合从多个角度核对同一主题'
          },
          focus: { type: 'string', description: '希望重点核对的版本、日期、地区或来源类型' },
          source_preference: {
            type: 'string',
            enum: ['auto', 'official', 'docs', 'news'],
            description: '来源偏好；official 优先官方页面，docs 优先技术文档，news 优先近期新闻'
          },
          time_sensitive: { type: 'boolean', description: '是否需要按当前日期核对最新状态，默认 false' },
          timeout_ms: { type: 'integer', description: '搜索超时毫秒数，可选' },
          skipPermission: { type: 'boolean', description: '仅在用户已经允许本轮能力调用时使用；不要自行绕过设置中的强制确认' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_open',
      description: '稳定的网页打开与抓取入口。用于打开已知网址、抓取官方文档正文、页内查找，或把网址打开到右侧网页面板。不要把网页内容臆造为事实；成功时返回结构化正文和来源 URL。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要打开或抓取的 http/https 网址' },
          action: {
            type: 'string',
            enum: ['fetch', 'find', 'open', 'open_right'],
            description: 'fetch 抓正文，find 查找关键词，open 用系统浏览器打开，open_right 在右侧网页面板打开；默认 fetch'
          },
          pattern: { type: 'string', description: 'action=find 时要查找的关键词或短语' },
          max_results: { type: 'integer', description: 'action=find 最多返回的匹配片段数，默认 12' },
          timeout_ms: { type: 'integer', description: '可选超时毫秒数' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'vision_analyze',
      description: '稳定的视觉理解入口。分析本地图片、截图、设计稿或运行效果图；系统会自动选择当前模型或已配置的视觉模型，不要因为当前聊天模型没有视觉能力就直接说系统没有看图能力。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '项目内图片路径，支持截图工具返回的 path' },
          question: { type: 'string', description: '希望视觉模型重点回答的问题' },
          skipPermission: { type: 'boolean', description: '仅在用户已经允许跨模型视觉调用时使用' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'image_generate',
      description: '稳定的图片生成入口。根据文字提示生成图片；系统会自动路由到已配置并标注“图片生成”能力的模型，不需要模型知道具体 Provider、模型 ID 或工具包名称。成功时返回本地文件路径和缩略图。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '图片生成提示词，描述主体、风格、构图、色彩、比例和细节' },
          model: { type: 'string', description: '可选模型 ID；通常留空，由能力路由自动选择' },
          size: { type: 'string', description: '可选尺寸，例如 1024x1024' },
          quality: { type: 'string', description: '可选质量等级，具体取决于模型' },
          style: { type: 'string', description: '可选风格' },
          skipPermission: { type: 'boolean', description: '仅在用户已经允许本轮图片生成时使用' },
          timeout: { type: 'number', description: '可选最大等待毫秒数' }
        },
        required: ['prompt']
      }
    }
  }
]
