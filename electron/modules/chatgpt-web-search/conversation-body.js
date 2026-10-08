/**
 * ChatGPT conversation body that injects the official web.run search tool.
 * The Lingxi API model chooses the queries; OpenAI's server runs search.
 */

const crypto = require('crypto')

function uniqueQueries(values = []) {
  const items = []
  const seen = new Set()
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = String(value || '').trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    items.push(text)
  }
  return items
}

function normalizeQueryList(args = {}) {
  const items = []
  const push = value => {
    for (const text of uniqueQueries(value)) {
      if (!items.includes(text)) items.push(text)
    }
  }
  push(args.query)
  push(args.queries)
  push(args.query_list)
  push(args.queryList)
  push(args.keywords)
  return items
}

function buildUserSearchText(queries = [], focus = '') {
  const list = uniqueQueries(queries)
  const extra = String(focus || '').trim()
  const question = list.length <= 1 ? (list[0] || '') : list.map((item, index) => `${index + 1}. ${item}`).join('\n')
  return [question, extra].filter(Boolean).join('\n')
}

function createPrepareBody(options = {}) {
  const body = {
    action: 'next',
    parent_message_id: String(options.parentMessageId || crypto.randomUUID()),
    model: String(options.model || 'auto'),
    client_prepare_state: 'none',
    timezone_offset_min: Number.isFinite(Number(options.timezoneOffsetMin))
      ? Number(options.timezoneOffsetMin)
      : -480,
    timezone: String(options.timezone || 'Asia/Shanghai'),
    conversation_mode: { kind: 'primary_assistant' },
    history_and_training_disabled: options.historyDisabled !== false,
    supports_buffering: true,
    supported_encodings: ['v1'],
    client_contextual_info: {},
    local_function_names: ['local.continue_in_work']
  }
  return body
}

function createWebRunConversationBody(options = {}) {
  const now = Date.now() / 1000
  const queries = uniqueQueries(options.queries || options.query)
  const query = queries[0] || ''
  const userText = String(options.userText || buildUserSearchText(queries, options.focus) || query).trim()
  const parentMessageId = String(options.parentMessageId || crypto.randomUUID())
  const userId = String(options.userMessageId || crypto.randomUUID())
  const callId = String(options.callMessageId || crypto.randomUUID())
  const user = {
    id: userId,
    author: { role: 'user' },
    create_time: now,
    status: 'finished_successfully',
    weight: 1,
    content: { content_type: 'text', parts: [userText] },
    metadata: { serialization_metadata: { custom_symbol_offsets: [] } }
  }
  const call = {
    id: callId,
    author: { role: 'assistant' },
    recipient: 'web.run',
    create_time: now,
    weight: 1,
    content: {
      content_type: 'text',
      parts: [`search(${JSON.stringify(query)})`]
    },
    metadata: {
      serialization_metadata: { custom_symbol_offsets: [] },
      search_queries: queries
    }
  }
  return {
    action: 'next',
    messages: [user, call],
    parent_message_id: parentMessageId,
    model: String(options.model || 'auto'),
    client_prepare_state: 'success',
    timezone_offset_min: Number.isFinite(Number(options.timezoneOffsetMin))
      ? Number(options.timezoneOffsetMin)
      : -480,
    timezone: String(options.timezone || 'Asia/Shanghai'),
    conversation_mode: { kind: 'primary_assistant' },
    history_and_training_disabled: options.historyDisabled !== false,
    enable_message_followups: false,
    system_hints: [],
    supports_buffering: true,
    supported_encodings: ['v1'],
    force_parallel_switch: 'auto',
    local_function_names: ['local.continue_in_work']
  }
}

function createTextConversationBody(options = {}) {
  const prompt = String(options.prompt || '').trim()
  const parentMessageId = String(options.parentMessageId || crypto.randomUUID())
  return {
    action: 'next',
    messages: [{
      id: String(options.userMessageId || crypto.randomUUID()),
      author: { role: 'user' },
      content: { content_type: 'text', parts: [prompt] },
      metadata: { serialization_metadata: { custom_symbol_offsets: [] } }
    }],
    parent_message_id: parentMessageId,
    model: String(options.model || 'auto'),
    client_prepare_state: 'success',
    timezone_offset_min: Number.isFinite(Number(options.timezoneOffsetMin)) ? Number(options.timezoneOffsetMin) : -480,
    timezone: String(options.timezone || 'Asia/Shanghai'),
    conversation_mode: { kind: 'primary_assistant' },
    history_and_training_disabled: options.historyDisabled !== false,
    enable_message_followups: false,
    system_hints: Array.isArray(options.systemHints) ? options.systemHints : [],
    supports_buffering: true,
    supported_encodings: ['v1'],
    force_parallel_switch: 'auto',
    local_function_names: ['local.continue_in_work'],
    ...(Array.isArray(options.modelResponseContracts) ? { model_response_contracts: options.modelResponseContracts } : {})
  }
}

function createImageConversationBody(options = {}) {
  return createTextConversationBody({
    ...options,
    systemHints: ['picture_v2'],
    modelResponseContracts: [{
      id: 'image_gen_tool',
      protocol_version: 1,
      presets: ['cap:image']
    }]
  })
}

module.exports = {
  uniqueQueries,
  normalizeQueryList,
  buildUserSearchText,
  createPrepareBody,
  createWebRunConversationBody,
  createTextConversationBody,
  createImageConversationBody
}
