// 所有询问弹窗必须共享同一份挂起请求表。
// 否则请求在一个模块登记、响应在另一个模块查询时会被误判为过期。
const pendingAskRequests = new Map()

module.exports = { pendingAskRequests }
