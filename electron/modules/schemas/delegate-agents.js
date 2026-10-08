module.exports = [{
  type: 'function',
  function: {
    name: 'delegate_agents',
    description: '标准模式派工：在当前项目、当前会话里唤醒多名队员并行或按依赖执行。不要为简单问答调用。队员共用本项目工作区，不会另开聊天窗口。depends_on 决定先后；无依赖的队员并行，最多 4 人、同时最多 3 人开工。调用后会在聊天气泡里出现协作图。',
    parameters: {
      type: 'object',
      properties: {
        team_brief: {
          type: 'string',
          description: '写给所有队员看的主协调说明：总目标、边界、不要做什么、交付口径。会出现在团队便签的「主协调」。'
        },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          description: '队员任务。必须一次写全所有人：你说派几人，这里就要有几条。id 在本轮内唯一；depends_on 填其它任务的 id。每人一条短 task，不要把多人职责塞进一条。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '稳定任务 id，例如 scout-a。省略则按名称生成。' },
              name: { type: 'string', description: '短名，协作图上显示，例如「侦察员A」。' },
              role: { type: 'string', description: '职责，例如「前端侦察」「接口核对」。' },
              task: { type: 'string', description: '这个队员要独立完成的具体任务。写清范围和交付，不要让他们再拆队。' },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: '必须先完成的任务 id。省略或空数组表示可立即开工。'
              }
            },
            required: ['task']
          }
        }
      },
      required: ['tasks']
    }
  }
}]
