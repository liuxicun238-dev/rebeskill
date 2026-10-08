/**
 * 模型请求失败分码与有限退避重试。
 * 只对瞬时失败重试；鉴权、配额、普通 400、用户取消不重试。
 */

const { isAbortError, isApiTimeoutError, throwIfAborted } = require('./api-error-timeout')

const CODES = Object.freeze({
  ABORTED: 'ABORTED',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER: 'SERVER',
  TRANSPORT: 'TRANSPORT',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  AUTH: 'AUTH',
  QUOTA: 'QUOTA',
  INVALID_REQUEST: 'INVALID_REQUEST',
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  UNKNOWN: 'UNKNOWN'
})

const DEFAULT_RETRYABLE_CODES = Object.freeze([
  CODES.EMPTY_RESPONSE,
  CODES.RATE_LIMIT,
  CODES.SERVER,
  CODES.TIMEOUT,
  CODES.TRANSPORT
])

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1

const CONTEXT_WINDOW_RE = /context[\s_-]*(?:window|length)|maximum context|max(?:imum)?[\s_-]*tokens|token(?:s)?[\s_-]*(?:limit|overflow)|too many tokens|prompt is too long|context_length_exceeded|string too long|input is too long/i
const QUOTA_RE = /quota|insufficient[_\s-]?quota|billing|exceeded your current quota|余额不足|额度不足|欠费/i
const RATE_LIMIT_RE = /rate[\s_-]*limit|too many requests|tpm|rpm|throttl|overloaded|请稍后重试|请求过于频繁/i
const AUTH_RE = /invalid[\s_-]*api[\s_-]*key|incorrect api key|unauthorized|authentication|permission.?denied|only allows Codex official/i

function readFiniteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseRetryAfterMs(headers, body = '') {
  const raw = typeof headers?.get === 'function'
    ? headers.get('retry-after')
    : (headers?.['retry-after'] || headers?.['Retry-After'] || '')
  const headerText = String(raw || '').trim()
  if (headerText) {
    const seconds = readFiniteNumber(headerText)
    if (seconds !== null && seconds >= 0) return Math.round(seconds * 1000)
    const dateMs = Date.parse(headerText)
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now())
  }
  const match = String(body || '').match(/retry[-_\s]?after["'\s:=]+(\d+)/i)
  if (match) {
    const seconds = readFiniteNumber(match[1])
    if (seconds !== null && seconds >= 0) return Math.round(seconds * 1000)
  }
  return 0
}

function classifyHttpStatus(status, body = '') {
  const code = Number(status) || 0
  const text = String(body || '')
  if (code === 401 || code === 403) return { code: CODES.AUTH, retryable: false }
  if (code === 429 || RATE_LIMIT_RE.test(text)) return { code: CODES.RATE_LIMIT, retryable: true }
  if (code === 402 || QUOTA_RE.test(text)) return { code: CODES.QUOTA, retryable: false }
  if (code === 408) return { code: CODES.TIMEOUT, retryable: true }
  if ((code === 400 || code === 413 || code === 502) && CONTEXT_WINDOW_RE.test(text)) {
    return { code: CODES.CONTEXT_WINDOW_EXCEEDED, retryable: false }
  }
  if (CONTEXT_WINDOW_RE.test(text)) return { code: CODES.CONTEXT_WINDOW_EXCEEDED, retryable: false }
  if (QUOTA_RE.test(text)) return { code: CODES.QUOTA, retryable: false }
  if (AUTH_RE.test(text)) return { code: CODES.AUTH, retryable: false }
  if (code === 400 || code === 404 || code === 422) return { code: CODES.INVALID_REQUEST, retryable: false }
  if (code >= 500 && code <= 599) return { code: CODES.SERVER, retryable: true }
  if (code > 0) return { code: CODES.UNKNOWN, retryable: false }
  return { code: CODES.UNKNOWN, retryable: false }
}

function classifyTransportError(error) {
  const chain = []
  const seen = new Set()
  let current = error
  while (current && typeof current === 'object' && !seen.has(current) && chain.length < 8) {
    seen.add(current)
    chain.push(current)
    current = current.cause
  }
  const blob = chain.map(item => [
    item?.name,
    item?.code,
    item?.cause?.code,
    item?.message
  ].filter(Boolean).join(' ')).join(' ')
  if (/ECONNRESET|UND_ERR_SOCKET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|other side closed|fetch failed|network|ECONNABORTED/i.test(blob)) {
    return { code: CODES.TRANSPORT, retryable: true }
  }
  if (/ETIMEDOUT|timeout|timed out/i.test(blob)) {
    return { code: CODES.TIMEOUT, retryable: true }
  }
  if (/Model API transport error/i.test(blob)) {
    return { code: CODES.TRANSPORT, retryable: true }
  }
  return null
}

function classifyLlmFailure({ error, status, body, headers, signal } = {}) {
  const httpStatus = readFiniteNumber(status ?? error?.status) || 0
  const text = String(body || error?.body || error?.message || '')
  const retryAfterMs = parseRetryAfterMs(headers || error?.headers, text)

  if (isAbortError(error, signal) && !isApiTimeoutError(error, signal)) {
    return { code: CODES.ABORTED, retryable: false, status: httpStatus, retryAfterMs, message: error?.message || '已中断' }
  }
  if (isApiTimeoutError(error, signal) || error?.name === 'ApiTimeoutError') {
    return {
      code: CODES.TIMEOUT,
      retryable: signal?.aborted !== true,
      status: httpStatus,
      retryAfterMs,
      message: error?.message || '模型接口超时'
    }
  }

  if (error?.llmCode && CODES[error.llmCode]) {
    const retryable = DEFAULT_RETRYABLE_CODES.includes(error.llmCode) && signal?.aborted !== true
    return {
      code: error.llmCode,
      retryable,
      status: httpStatus,
      retryAfterMs: error.retryAfterMs || retryAfterMs,
      message: error.message || error.llmCode
    }
  }

  if (httpStatus || /^API错误\s+\d+/.test(text) || /协作 AI API 错误\s+\d+/.test(text) || /Collaboration AI API error\s+\d+/i.test(text)) {
    const parsedStatus = httpStatus || Number((text.match(/(?:API错误|API error|API 错误)\s+(\d+)/i) || [])[1]) || 0
    const classified = classifyHttpStatus(parsedStatus, text)
    return {
      ...classified,
      retryable: classified.retryable && signal?.aborted !== true,
      status: parsedStatus,
      retryAfterMs,
      message: text
    }
  }

  if (error?.name === 'ModelStreamPayloadError' || error?.isModelStreamPayloadError) {
    const payloadText = `${error.code || ''} ${text}`
    if (CONTEXT_WINDOW_RE.test(payloadText)) {
      return { code: CODES.CONTEXT_WINDOW_EXCEEDED, retryable: false, status: httpStatus, retryAfterMs, message: text }
    }
    if (RATE_LIMIT_RE.test(payloadText) || /overloaded|server_error/i.test(payloadText)) {
      const code = RATE_LIMIT_RE.test(payloadText) ? CODES.RATE_LIMIT : CODES.SERVER
      return { code, retryable: signal?.aborted !== true, status: httpStatus, retryAfterMs, message: text }
    }
    return { code: CODES.SERVER, retryable: signal?.aborted !== true, status: httpStatus, retryAfterMs, message: text }
  }

  const transport = classifyTransportError(error)
  if (transport) {
    return {
      ...transport,
      retryable: transport.retryable && signal?.aborted !== true,
      status: httpStatus,
      retryAfterMs,
      message: error?.message || text || transport.code
    }
  }

  if (/empty(?:[\s_-]*response)?|no choices|empty completion/i.test(text)) {
    return { code: CODES.EMPTY_RESPONSE, retryable: signal?.aborted !== true, status: httpStatus, retryAfterMs, message: text }
  }

  return {
    code: CODES.UNKNOWN,
    retryable: false,
    status: httpStatus,
    retryAfterMs,
    message: text || '未知模型错误'
  }
}

function createLlmRequestError({ code, message, status, retryAfterMs, body, cause, headers } = {}) {
  const resolved = code && CODES[code]
    ? { code, retryable: DEFAULT_RETRYABLE_CODES.includes(code) }
    : classifyHttpStatus(status, body || message)
  const error = new Error(message || resolved.code)
  error.name = resolved.code === CODES.TIMEOUT ? 'ApiTimeoutError' : 'LlmRequestError'
  if (resolved.code === CODES.TIMEOUT) error.isApiTimeout = true
  error.llmCode = resolved.code
  error.status = Number(status) || 0
  error.retryAfterMs = Number(retryAfterMs) || 0
  error.body = body
  error.headers = headers
  if (cause) error.cause = cause
  return error
}

function resolveRetryDelayMs(classified = {}, attempt = 1, options = {}) {
  const initialDelayMs = Math.max(0, readFiniteNumber(options.initialDelayMs) ?? DEFAULT_INITIAL_DELAY_MS)
  const maxDelayMs = Math.max(initialDelayMs, readFiniteNumber(options.maxDelayMs) ?? DEFAULT_MAX_DELAY_MS)
  const jitterRatio = Math.max(0, Math.min(0.5, readFiniteNumber(options.jitterRatio) ?? DEFAULT_JITTER_RATIO))
  const retryAfterMs = Math.max(0, Number(classified.retryAfterMs) || 0)
  const exponential = initialDelayMs * (2 ** Math.max(0, attempt - 1))
  const localDelay = Math.min(maxDelayMs, exponential)
  const acceptedRetryAfter = retryAfterMs > 0 && retryAfterMs <= maxDelayMs ? retryAfterMs : 0
  const base = Math.max(localDelay, acceptedRetryAfter)
  const jitter = jitterRatio ? base * ((Math.random() * 2 - 1) * jitterRatio) : 0
  return Math.max(0, Math.round(base + jitter))
}

function isEmptyModelCompletion({ content, toolCalls, reasoning, webBridge } = {}) {
  if (webBridge) return false
  const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0
  if (hasTools) return false
  if (String(content || '').trim()) return false
  if (String(reasoning || '').trim()) return false
  return true
}

function waitForLlmRetry(delayMs, signal = null) {
  const waitMs = Math.max(0, Number(delayMs) || 0)
  if (!waitMs) {
    throwIfAborted(signal)
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, waitMs)
    const onAbort = () => {
      clearTimeout(timer)
      try {
        throwIfAborted(signal)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      } catch (error) {
        reject(error)
      }
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

async function withLlmRequestRetries(requestOnce, options = {}) {
  const maxRetries = Math.max(0, Math.min(6, Number(options.maxRetries) ?? DEFAULT_MAX_RETRIES))
  const retryableCodes = Array.isArray(options.retryableCodes) && options.retryableCodes.length
    ? options.retryableCodes
    : DEFAULT_RETRYABLE_CODES
  let attempt = 0
  while (true) {
    throwIfAborted(options.signal)
    try {
      return await requestOnce({ attempt })
    } catch (error) {
      throwIfAborted(options.signal)
      const classified = classifyLlmFailure({ error, signal: options.signal })
      const canRetry = classified.retryable && retryableCodes.includes(classified.code) && attempt < maxRetries
      if (!canRetry) throw error
      attempt += 1
      const delayMs = resolveRetryDelayMs(classified, attempt, options)
      options.onRetry?.({
        attempt,
        maxRetries,
        code: classified.code,
        status: classified.status,
        delayMs,
        error
      })
      await waitForLlmRetry(delayMs, options.signal)
    }
  }
}

module.exports = {
  CODES,
  DEFAULT_RETRYABLE_CODES,
  classifyHttpStatus,
  classifyLlmFailure,
  createLlmRequestError,
  parseRetryAfterMs,
  resolveRetryDelayMs,
  isEmptyModelCompletion,
  waitForLlmRetry,
  withLlmRequestRetries
}
