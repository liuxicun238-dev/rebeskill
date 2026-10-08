/**
 * Stable, high-level capability entry points.
 *
 * These tools intentionally stay visible to the model even when the concrete
 * implementation is routed to another provider/model or to an optional pack.
 * This is the same "stable tool name -> runtime capability router" boundary
 * used by Codex-style harnesses: the model should not need to know whether a
 * search is backed by an API, a web bridge, or the local browser.
 */

const browserTool = require('../../tools/browser-tool-secure')
const webBridgeSearch = require('../web-bridge-search')
const vision = require('./vision')
const imageGeneration = require('./image-gen')
const { resolveCapabilityModel } = require('../lingxi-harness/model-broker')

function withStableRoute(result, requestedTool, routedTool, extra = {}) {
  if (!result || typeof result !== 'object') return result
  return {
    ...result,
    capability: requestedTool,
    routed_tool: routedTool,
    ...extra
  }
}

function normalizeSearchArgs(args = {}) {
  const next = { ...(args || {}) }
  const preference = String(next.source_preference || next.sourcePreference || '').trim()
  const focus = String(next.focus || '').trim()
  const preferenceHint = preference === 'official'
    ? '优先使用官方文档、官方公告或官方产品页面作为来源。'
    : preference === 'docs'
      ? '优先使用技术文档、标准文档和官方 API 文档。'
      : preference === 'news'
        ? '优先使用近期新闻和带明确发布日期的来源。'
        : ''
  const timeHint = next.time_sensitive === true || next.timeSensitive === true
    ? '这是时效性问题，请核对最新日期并明确写出日期。'
    : ''
  next.focus = [focus, preferenceHint, timeHint].filter(Boolean).join(' ')
  delete next.source_preference
  delete next.sourcePreference
  delete next.time_sensitive
  delete next.timeSensitive
  return next
}

function resolveCapabilityContext(capability, ctx = {}) {
  const route = resolveCapabilityModel(capability, ctx.modelConfig, {
    availableModels: ctx.availableModels,
    capabilityRouting: ctx.capabilityRouting
  })
  return {
    ctx: {
      ...(ctx || {}),
      modelConfig: route?.model || ctx.modelConfig
    },
    route
  }
}

async function webSearch(args = {}, ctx = {}) {
  const resolved = resolveCapabilityContext('webSearch', ctx)
  const result = await webBridgeSearch.searchWithWebBridge(
    normalizeSearchArgs(args),
    {
      ...(resolved.ctx || {}),
      toolName: 'web_search',
      toolCallId: ctx?.toolCallId || ctx?.options?.toolCallId || ''
    },
    {
      findWebSearchModel: () => resolved.route?.model || null
    }
  )
  return withStableRoute(result, 'web_search', 'web_bridge_search', {
    route_mode: resolved.route?.mode || 'stable-entrypoint',
    route_model: resolved.route?.model?.modelName || resolved.route?.model?.modelId || ''
  })
}

async function webOpen(args = {}, ctx = {}) {
  const action = String(args.action || '').trim().toLowerCase() || (args.pattern ? 'find' : 'fetch')
  const result = await browserTool.lxweb(
    {
      ...(args || {}),
      action,
      url: args.url || args.href || args.link || args.ref_id || ''
    },
    {
      projectId: ctx.projectId || '',
      webContents: ctx.webContents || null
    }
  )
  return withStableRoute(result, 'web_open', `lxweb:${action}`, {
    source: 'local-browser',
    fetched_url: args.url || args.href || args.link || args.ref_id || ''
  })
}

async function visionAnalyze(args = {}, ctx = {}) {
  try {
    const resolved = resolveCapabilityContext('vision', ctx)
    const result = await vision.inspectImageWithPermission(
      ctx.projectId || '',
      args,
      ctx.resolvePath,
      resolved.ctx.modelConfig
    )
    return withStableRoute(result, 'vision_analyze', 'inspect_image', {
      route_mode: resolved.route?.mode || 'stable-entrypoint',
      route_model: resolved.route?.model?.modelName || resolved.route?.model?.modelId || ''
    })
  } catch (error) {
    return {
      success: false,
      status: 'provider_error',
      error: error.message || String(error),
      capability: 'vision_analyze',
      routed_tool: 'inspect_image'
    }
  }
}

async function imageGenerate(args = {}, ctx = {}) {
  try {
    const resolved = resolveCapabilityContext('imageGeneration', ctx)
    const result = await imageGeneration.generateImageWithModel(
      ctx.projectId || '',
      args,
      resolved.ctx.modelConfig
    )
    return withStableRoute(result, 'image_generate', 'generate_image', {
      route_mode: resolved.route?.mode || 'stable-entrypoint',
      route_model: resolved.route?.model?.modelName || resolved.route?.model?.modelId || ''
    })
  } catch (error) {
    const name = error?.name || ''
    if (name === 'TimeoutError') {
      const timeoutMs = Math.max(10000, Math.min(Number(args.timeout_ms || args.timeoutMs || args.timeout || 300000), 900000))
      return {
        success: false,
        status: 'timeout',
        error: `Image generation timed out after ${Math.round(timeoutMs / 1000)} seconds. The request was cancelled.`,
        capability: 'image_generate',
        routed_tool: 'generate_image'
      }
    }
    if (name === 'AbortError') {
      return {
        success: false,
        status: 'aborted',
        aborted: true,
        error: 'Image generation was cancelled.',
        capability: 'image_generate',
        routed_tool: 'generate_image'
      }
    }
    return {
      success: false,
      status: 'provider_error',
      error: error.message || String(error),
      capability: 'image_generate',
      routed_tool: 'generate_image'
    }
  }
}

const handlers = {
  web_search: async (args, ctx) => webSearch(args, ctx),
  web_open: async (args, ctx) => webOpen(args, ctx),
  vision_analyze: async (args, ctx) => visionAnalyze(args, ctx),
  image_generate: async (args, ctx) => imageGenerate(args, ctx)
}

module.exports = {
  handlers,
  normalizeSearchArgs,
  webSearch,
  webOpen,
  visionAnalyze,
  imageGenerate
}
