import http from 'node:http'
import crypto from 'node:crypto'

const env = process.env
const PORT = Number(env.PORT || 3000)
const MODEL_BASE_URL = String(env.MODEL_BASE_URL || '').replace(/\/+$/, '')
const MODEL_API_KEY = String(env.MODEL_API_KEY || '')
const MODEL_NAME = String(env.MODEL_NAME || 'gpt-4o-mini')
const DEFAULT_FREE_QUOTA = Number(env.DEFAULT_FREE_QUOTA || 200)
const TRIAL_DAYS = Number(env.TRIAL_DAYS || 30)

const users = new Map()

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Lingxi-User-Id, X-Lingxi-Device-Id',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8')
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function getBearerToken(req) {
  const auth = String(req.headers.authorization || '')
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function getUser(req) {
  const token = getBearerToken(req)
  if (!token) return null
  const userId = String(req.headers['x-lingxi-user-id'] || '').trim() || crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)
  const deviceId = String(req.headers['x-lingxi-device-id'] || '').trim() || 'unknown-device'
  const key = `${userId}:${deviceId}`
  if (!users.has(key)) {
    users.set(key, {
      userId,
      deviceId,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      quotaTotal: DEFAULT_FREE_QUOTA,
      quotaRemaining: DEFAULT_FREE_QUOTA,
      quotaUsed: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000
    })
  }
  return users.get(key)
}

function assertQuota(user) {
  if (!user) return 'Missing token'
  if (Date.now() > user.expiresAt) return 'Trial expired'
  if (user.quotaRemaining <= 0) return 'Quota exhausted'
  return ''
}

function publicQuota(user) {
  return {
    userId: user.userId,
    deviceId: user.deviceId,
    total: user.quotaTotal,
    remaining: user.quotaRemaining,
    used: user.quotaUsed,
    expiresAt: new Date(user.expiresAt).toISOString()
  }
}

async function proxyChat(req, res, user) {
  if (!MODEL_BASE_URL || !MODEL_API_KEY) {
    json(res, 500, { error: 'Gateway model provider is not configured' })
    return
  }

  const quotaError = assertQuota(user)
  if (quotaError) {
    json(res, quotaError === 'Quota exhausted' ? 402 : 401, { error: quotaError, quota: user ? publicQuota(user) : null })
    return
  }

  const body = await readBody(req)
  const upstreamBody = {
    ...body,
    model: body.model || MODEL_NAME
  }

  const upstream = await fetch(`${MODEL_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MODEL_API_KEY}`,
      'Accept': body.stream === false ? 'application/json' : 'text/event-stream'
    },
    body: JSON.stringify(upstreamBody)
  })

  if (!upstream.ok) {
    const errorText = await upstream.text()
    json(res, upstream.status, { error: errorText })
    return
  }

  user.quotaRemaining -= 1
  user.quotaUsed += 1

  if (body.stream === false) {
    const payload = await upstream.text()
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'X-Lingxi-Quota-Remaining': String(user.quotaRemaining)
    })
    res.end(payload)
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Lingxi-Quota-Remaining': String(user.quotaRemaining)
  })
  for await (const chunk of upstream.body) {
    res.write(chunk)
  }
  res.end()
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      json(res, 204, {})
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const user = getUser(req)

    if (req.method === 'GET' && url.pathname === '/v1/quota') {
      const quotaError = assertQuota(user)
      if (quotaError && quotaError !== 'Quota exhausted') {
        json(res, 401, { error: quotaError })
        return
      }
      json(res, 200, { quota: publicQuota(user) })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await proxyChat(req, res, user)
      return
    }

    json(res, 404, { error: 'Not found' })
  } catch (error) {
    json(res, 500, { error: error.message || 'Gateway error' })
  }
})

server.listen(PORT, () => {
  console.log(`Lingxi model gateway listening on http://0.0.0.0:${PORT}`)
})
