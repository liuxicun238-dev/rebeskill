/**
 * 灵犀模型经纪层（第一版）。
 *
 * 当前只负责把能力计划解析成可解释的路由决策，不直接发起模型请求。
 * 具体工具仍由 capability-tools / provider adapter 执行；这样可以先把
 * “为什么需要换模型、能换到哪个模型”纳入 Harness，再逐步接管真实路由。
 */

const { normalizeModel, hasCapability } = require('../model-capabilities')

function modelLabel(model = {}) {
  return String(model.modelName || model.modelId || model.provider || model.platform || '').trim()
}

function normalizeCandidates(models = []) {
  return (Array.isArray(models) ? models : [])
    .map(normalizeModel)
    .filter(model => modelLabel(model))
}

function modelRoutingKey(model = {}) {
  if (!model || typeof model !== 'object') return ''
  if (String(model.modelKey || '').trim()) return String(model.modelKey).trim()
  return [
    model.provider,
    model.apiUrl,
    model.modelId || model.modelName,
    model.modelName
  ]
    .filter(value => value !== undefined && value !== null && String(value).trim())
    .map(value => String(value).trim())
    .join('::')
}

function modelRoutingAliases(model = {}) {
  return [...new Set([
    modelRoutingKey(model),
    model.modelKey,
    model.modelId,
    model.modelName
  ].map(value => String(value || '').trim()).filter(Boolean))]
}

function hasUsableModelConfig(model = {}) {
  return !!(
    modelLabel(model) &&
    String(model.apiUrl || '').trim() &&
    (String(model.apiKey || '').trim() || String(model.modelKey || '').trim())
  )
}

function getConfiguredModels() {
  try {
    const storageConfig = require('../storage-config')
    const result = storageConfig.getApiConfig()
    return result?.success && Array.isArray(result.data?.models)
      ? result.data.models
      : []
  } catch (error) {
    // 模型目录只是路由提示，读取失败不能阻断当前 Turn。
    return []
  }
}

function getCapabilityRouting() {
  try {
    const result = require('../storage-config').getApiConfig()
    return result?.success && result.data?.capabilityRouting &&
      typeof result.data.capabilityRouting === 'object'
      ? result.data.capabilityRouting
      : {}
  } catch (_) {
    return {}
  }
}

function resolveCapabilityModel(capability, currentModel = {}, options = {}) {
  const capabilityKey = String(capability || '').trim()
  if (!capabilityKey) return null
  const current = normalizeModel(currentModel || {})
  const candidates = normalizeCandidates(
    options.availableModels === undefined ? getConfiguredModels() : options.availableModels
  ).filter(model => hasCapability(model, capabilityKey) && (
    typeof options.isUsableModel === 'function'
      ? options.isUsableModel(model)
      : hasUsableModelConfig(model)
  ))

  const routing = options.capabilityRouting || getCapabilityRouting()
  const preferredKeys = Array.isArray(routing[capabilityKey])
    ? routing[capabilityKey].map(value => String(value || '').trim()).filter(Boolean)
    : []
  const byKey = new Map()
  candidates.forEach(model => {
    modelRoutingAliases(model).forEach(alias => {
      if (!byKey.has(alias)) byKey.set(alias, model)
    })
  })
  const preferred = preferredKeys.map(key => byKey.get(key)).find(Boolean)
  if (preferred) {
    return {
      model: preferred,
      mode: 'routed-model',
      reason: 'capability_routing_preference'
    }
  }
  if (hasCapability(current, capabilityKey) && (
    typeof options.isUsableModel === 'function'
      ? options.isUsableModel(current)
      : hasUsableModelConfig(current)
  )) {
    return {
      model: current,
      mode: 'current-model',
      reason: 'current_model_supports'
    }
  }
  const selected = candidates[0] || null
  return selected
    ? {
        model: selected,
        mode: 'routed-model',
        reason: 'first_configured_capability_model'
      }
    : {
        model: null,
        mode: 'stable-entrypoint',
        reason: 'no_usable_capability_model'
      }
}

function planModelRoutes(capabilityPlan = {}, options = {}) {
  const currentModel = normalizeModel(options.currentModel || {})
  const candidates = normalizeCandidates(
    options.availableModels === undefined
      ? getConfiguredModels()
      : options.availableModels
  )
  const routes = (Array.isArray(capabilityPlan.intents) ? capabilityPlan.intents : []).map(intent => {
    if (hasCapability(currentModel, intent.capability)) {
      return {
        intentId: intent.id,
        capability: intent.capability,
        mode: 'current-model',
        model: modelLabel(currentModel),
        reason: 'current_model_supports'
      }
    }

    const routedModel = candidates.find(model => hasCapability(model, intent.capability))
    if (routedModel) {
      return {
        intentId: intent.id,
        capability: intent.capability,
        mode: 'routed-model',
        model: modelLabel(routedModel),
        reason: 'current_model_missing_capability'
      }
    }

    return {
      intentId: intent.id,
      capability: intent.capability,
      mode: 'stable-entrypoint',
      model: '',
      reason: 'defer_to_stable_tool_or_backend_fallback'
    }
  })

  return {
    broker: 'lingxi-model-broker-v1',
    routes,
    requiresRoutedModel: routes.some(route => route.mode === 'routed-model'),
    unresolved: routes.filter(route => route.mode === 'stable-entrypoint').map(route => route.capability)
  }
}

module.exports = {
  modelLabel,
  normalizeCandidates,
  modelRoutingKey,
  modelRoutingAliases,
  hasUsableModelConfig,
  getConfiguredModels,
  getCapabilityRouting,
  resolveCapabilityModel,
  planModelRoutes
}
