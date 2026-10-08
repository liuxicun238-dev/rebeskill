/**
 * 进程内 Turn / Item 事件总线。
 *
 * Turn/Item 的持久化仍由 turn-item-store 负责；这里仅把不含工具结果正文
 * 的事实变化通知给当前 renderer，让上下文组件和其它观察 UI 能即时刷新。
 */

const { EventEmitter } = require('events')

const emitter = new EventEmitter()
emitter.setMaxListeners(50)

function emitTurnEvent(payload = {}) {
  emitter.emit('turn-event', payload)
  return payload
}

function onTurnEvent(listener) {
  if (typeof listener !== 'function') return () => {}
  emitter.on('turn-event', listener)
  return () => emitter.off('turn-event', listener)
}

module.exports = {
  emitTurnEvent,
  onTurnEvent
}
