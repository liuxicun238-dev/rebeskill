/**
 * 统一的询问请求服务。
 *
 * 所有需要用户确认/选择的能力都必须使用这里的请求 ID、挂起表、
 * 响应归一化和 IPC 回包逻辑。具体业务模块只负责构造弹窗内容，
 * 不再各自复制一套等待与注册实现。
 */

const config = require('./config')
const turnLifecycle = require('./chat/turn-lifecycle')
const { pendingAskRequests } = require('./ask-request-registry')

let askIpcRegistered = false

function createAskRequestId(projectId, type) {
  return `${projectId || 'global'}:${type}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

function normalizeAskResponse(data = {}) {
  const value = String(data.value || '')
  const rejected = value === 'rejected' || value === 'not_now'
  const answer = data.answer || ''
  const selectedOption = data.selectedOption && typeof data.selectedOption === 'object'
    ? data.selectedOption
    : null
  return {
    success: !rejected,
    status: rejected ? 'user_rejected' : 'answered',
    answer,
    value,
    selectedOption,
    type: data.type || '',
    executionMode: data.executionMode || null,
    workflowChoice: value || answer,
    message: rejected
      ? `用户选择暂停或不执行：${answer || value}`
      : `用户已选择：${answer || value}`
  }
}

function waitForAskResponse(projectId, requestId, timeoutMs = 30 * 60 * 1000, options = {}) {
  return turnLifecycle.observeGate(projectId, requestId, options.type || 'ask', new Promise((resolve, reject) => {
    let settled = false
    const controller = projectId ? config.getAbortController(projectId) : null
    const signal = controller?.signal

    const cleanup = () => {
      clearTimeout(timer)
      pendingAskRequests.delete(requestId)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    }

    const finish = (data) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(normalizeAskResponse(data))
    }

    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const timer = setTimeout(() => {
      fail(new Error('等待用户选择超时'))
    }, timeoutMs)

    const onAbort = () => {
      const error = new Error('用户已中断等待')
      error.name = 'AbortError'
      fail(error)
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // 同一项目默认只保留一个挂起询问；协作场景可通过 allowConcurrent 显式并发。
    if (projectId && !options.allowConcurrent) {
      for (const [existingId, existing] of pendingAskRequests.entries()) {
        if (existingId === requestId) continue
        if (existing && existing.projectId === projectId && !existing.allowConcurrent) {
          console.warn('[Ask] 检测到同项目已有挂起的询问，先清理旧的:', existingId)
          try {
            existing.finish({
              requestId: existingId,
              projectId,
              type: 'superseded',
              value: 'superseded',
              answer: '已切换到新的询问'
            })
          } catch (err) {
            console.warn('[Ask] 清理旧询问失败:', err && err.message)
          }
        }
      }
    }

    pendingAskRequests.set(requestId, {
      projectId,
      finish,
      allowConcurrent: !!options.allowConcurrent
    })
  }))
}

function sendAskAck(sender, payload) {
  if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) return
  try {
    sender.send('ask-popup-response-ack', payload)
  } catch (err) {
    console.warn('[Ask] 发送 ask-popup-response-ack 失败:', err && err.message)
  }
}

function registerToolAskIPC(ipcMain) {
  if (askIpcRegistered) return
  askIpcRegistered = true

  ipcMain.on('ask-popup-response', (event, data = {}) => {
    const requestId = data.requestId
    const pending = pendingAskRequests.get(requestId)
    if (!pending) {
      console.warn('[Ask] ask-popup-response 收到未知或已过期的 requestId:', requestId, 'pendingAskRequests size:', pendingAskRequests.size)
      sendAskAck(event.sender, { requestId, ok: false, reason: 'no-pending-request' })
      return
    }
    if (pending.projectId && data.projectId && pending.projectId !== data.projectId) {
      console.warn('[Ask] ask-popup-response projectId 不匹配:', pending.projectId, 'vs', data.projectId)
      sendAskAck(event.sender, { requestId, ok: false, reason: 'project-mismatch' })
      return
    }
    pending.finish(data)
    sendAskAck(event.sender, { requestId, ok: true })
  })
}

module.exports = {
  pendingAskRequests,
  createAskRequestId,
  normalizeAskResponse,
  waitForAskResponse,
  sendAskAck,
  registerToolAskIPC
}
