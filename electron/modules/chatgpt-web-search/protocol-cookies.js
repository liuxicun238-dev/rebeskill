/**
 * Read ChatGPT cookies from the dedicated web-bridge Chrome profile on disk.
 * Copies the cookie DB and decrypts in memory. Does not start Chrome.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const HEADER_COOKIE_NAMES = [
  '__Secure-next-auth.session-token.0',
  '__Secure-next-auth.session-token.1',
  '__Secure-next-auth.session-token',
  '__Secure-oai-is',
  'oai-client-auth-session',
  'oai-client-auth-info',
  '__cf_bm',
  '__cflb',
  '__oailb',
  '_puid',
  'cf_clearance'
]

function cookieFile(profileDir) {
  const nested = path.join(profileDir, 'Default', 'Network', 'Cookies')
  const legacy = path.join(profileDir, 'Default', 'Cookies')
  if (fs.existsSync(nested)) return nested
  if (fs.existsSync(legacy)) return legacy
  return ''
}

function pickProfileDir(explicit = '') {
  if (explicit && cookieFile(explicit)) return explicit
  // 网关子进程不是 Electron 进程，取不到 userData，因此由灵犀把共用资料目录传进来。
  const configured = String(process.env.LINGXI_WEB_BRIDGE_PROFILE_DIR || '').trim()
  if (configured && cookieFile(configured)) return configured
  if (process.versions?.electron) {
    try {
      const dir = require('../web-bridge-chrome-profile').getSharedWebBridgeProfileDir()
      if (dir && cookieFile(dir)) return dir
    } catch (_) { /* isolated tests */ }
  }
  const fallbacks = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'lingxi-lingxicode', 'lingxi-web-chrome-profile'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'lingxi-lingxicode', 'chatgpt-image-chrome-profile')
  ]
  return fallbacks.find(dir => cookieFile(dir)) || ''
}

function normalizeCookieList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => item && typeof item.name === 'string' && typeof item.value === 'string')
    .map(item => ({ name: item.name, value: item.value, host: String(item.host || item.domain || '.chatgpt.com') }))
}

function loadCredentialFile(file) {
  if (!file || !fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const cookies = normalizeCookieList(parsed?.cookies || parsed)
    const cookieHeader = String(parsed?.cookieHeader || '').trim() ||
      cookies.map(item => `${item.name}=${item.value}`).join('; ')
    const hasToken = cookies.some(item => /session-token/i.test(item.name)) ||
      /(?:^|;\s*)__Secure-next-auth\.session-token(?:[.=0-9]*=)/i.test(cookieHeader)
    if (!cookieHeader || !hasToken) return null
    return {
      ok: true,
      cookieHeader,
      deviceId: String(parsed?.deviceId || parsed?.oaiDeviceId || '').trim(),
      source: 'credentials-file'
    }
  } catch (_) {
    return null
  }
}

function saveCredentialFile(file, input = {}) {
  if (!file) throw new Error('ChatGPT credentials file path is required.')
  const cookies = normalizeCookieList(input.cookies || input)
  const cookieHeader = String(input.cookieHeader || '').trim() ||
    cookies.map(item => `${item.name}=${item.value}`).join('; ')
  const hasToken = cookies.some(item => /session-token/i.test(item.name)) ||
    /(?:^|;\s*)__Secure-next-auth\.session-token(?:[.=0-9]*=)/i.test(cookieHeader)
  if (!cookieHeader || !hasToken) {
    const error = new Error('ChatGPT credentials require a session cookie or cookieHeader.')
    error.code = 'LOGIN_REQUIRED'
    throw error
  }
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true })
  const temporary = `${file}.candidate-${process.pid}-${crypto.randomBytes(5).toString('hex')}`
  const payload = {
    version: 1,
    provider: 'chatgpt-web',
    updatedAt: new Date().toISOString(),
    deviceId: String(input.deviceId || input.oaiDeviceId || '').trim(),
    cookieHeader,
    cookies
  }
  fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch (_) { /* ignore */ }
    throw error
  }
  return { ok: true, path: file, cookieCount: cookies.length, deviceId: payload.deviceId }
}

async function dpapiUnprotect(buffer) {
  const tmp = os.tmpdir()
  const stamp = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(tmp, `lx-cws-dpapi-in-${stamp}.bin`)
  const output = path.join(tmp, `lx-cws-dpapi-out-${stamp}.bin`)
  const script = path.join(tmp, `lx-cws-dpapi-${stamp}.ps1`)
  fs.writeFileSync(input, buffer)
  fs.writeFileSync(script, [
    'Add-Type -AssemblyName System.Security',
    `$in = ${JSON.stringify(input)}`,
    `$out = ${JSON.stringify(output)}`,
    '$bytes = [System.IO.File]::ReadAllBytes($in)',
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[System.IO.File]::WriteAllBytes($out, $plain)'
  ].join('\r\n'), 'utf8')
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000
    })
  } catch (error) {
    throw Object.assign(new Error('无法解密网页桥登录资料。'), { code: 'LOGIN_REQUIRED', cause: error })
  }
  if (!fs.existsSync(output)) throw Object.assign(new Error('无法解密网页桥登录资料。'), { code: 'LOGIN_REQUIRED' })
  const plain = fs.readFileSync(output)
  for (const file of [input, output, script]) {
    try { fs.unlinkSync(file) } catch (_) { /* ignore */ }
  }
  return plain
}

async function chromeMasterKey(localStatePath) {
  const json = JSON.parse(fs.readFileSync(localStatePath, 'utf8'))
  const b64 = json?.os_crypt?.encrypted_key
  if (!b64) throw Object.assign(new Error('网页桥资料缺少加密密钥。'), { code: 'LOGIN_REQUIRED' })
  const raw = Buffer.from(b64, 'base64')
  if (raw.slice(0, 5).toString('ascii') !== 'DPAPI') {
    throw Object.assign(new Error('网页桥资料密钥格式不受支持。'), { code: 'LOGIN_REQUIRED' })
  }
  return dpapiUnprotect(raw.slice(5))
}

async function decryptValue(masterKey, encrypted) {
  if (!encrypted || !encrypted.length) return Buffer.alloc(0)
  const prefix = encrypted.slice(0, 3).toString('ascii')
  if (prefix === 'v10' || prefix === 'v11') {
    const iv = encrypted.slice(3, 15)
    const tag = encrypted.slice(-16)
    const data = encrypted.slice(15, -16)
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()])
  }
  try {
    return await dpapiUnprotect(encrypted)
  } catch (_) {
    return Buffer.alloc(0)
  }
}

function isCookieOctet(text) {
  return !!text && /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(text)
}

function cookiePlaintext(buffer) {
  if (!buffer || !buffer.length) return ''
  const candidates = []
  if (buffer.length > 32) candidates.push(32)
  candidates.push(0)
  if (buffer.length > 16) candidates.push(16)
  if (buffer[0] < 8 && buffer.length > 8) candidates.push(1, 4, 8)
  for (const skip of candidates) {
    const text = buffer.slice(skip).toString('utf8')
    if (isCookieOctet(text)) return text
  }
  return ''
}

function copySidecar(from, to) {
  try {
    fs.copyFileSync(from, to)
    return true
  } catch (_) {
    return false
  }
}

function readCookieRows(dbPath) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare(
      'SELECT name, host_key, path, encrypted_value, is_secure, is_httponly FROM cookies'
    ).all()
  } finally {
    db.close()
  }
}

async function loadProtocolCookies(options = {}) {
  const credentialsFile = String(
    options.credentialsFile ||
    process.env.WEB_MODEL_GATEWAY_CHATGPT_CREDENTIALS_FILE ||
    process.env.GEMINI_AGENT_GATEWAY_CHATGPT_CREDENTIALS_FILE ||
    ''
  ).trim()
  const fromFile = loadCredentialFile(credentialsFile)
  if (fromFile) return fromFile
  if (credentialsFile && options.allowProfileFallback !== true) {
    return { ok: false, error: 'missing-credentials-file', cookieHeader: '', deviceId: '' }
  }
  const source = pickProfileDir(String(
    options.profileDir ||
    process.env.WEB_MODEL_GATEWAY_CHATGPT_PROFILE_DIR ||
    process.env.GEMINI_AGENT_GATEWAY_CHATGPT_PROFILE_DIR ||
    ''
  ).trim())
  if (!source) {
    return { ok: false, error: 'no-chrome-profile', cookieHeader: '', deviceId: '' }
  }
  const localStateFrom = path.join(source, 'Local State')
  const cookieFrom = cookieFile(source)
  if (!cookieFrom || !fs.existsSync(localStateFrom)) {
    return { ok: false, error: 'missing-cookie-files', cookieHeader: '', deviceId: '' }
  }
  const stamp = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const copyDir = path.join(os.tmpdir(), `lx-cws-cookies-${stamp}`)
  fs.mkdirSync(copyDir, { recursive: true })
  const localStateTo = path.join(copyDir, 'Local State')
  const cookieTo = path.join(copyDir, 'Cookies')
  if (!copySidecar(localStateFrom, localStateTo) || !copySidecar(cookieFrom, cookieTo)) {
    return { ok: false, error: 'copy-failed', cookieHeader: '', deviceId: '' }
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    copySidecar(cookieFrom + suffix, cookieTo + suffix)
  }
  try {
    const masterKey = await chromeMasterKey(localStateTo)
    const rows = readCookieRows(cookieTo)
    const cookies = []
    for (const row of rows) {
      const host = String(row.host_key || '')
      if (!/chatgpt\.com|openai\.com/i.test(host)) continue
      const decrypted = await decryptValue(masterKey, Buffer.from(row.encrypted_value || []))
      if (!decrypted || !decrypted.length) continue
      const value = cookiePlaintext(decrypted)
      if (!value) continue
      cookies.push({ name: String(row.name || ''), host, value })
    }
    const byName = new Map()
    for (const item of cookies) {
      if (!HEADER_COOKIE_NAMES.includes(item.name) && item.name !== 'oai-did') continue
      if (!/chatgpt\.com/i.test(item.host) && !/^__Secure-next-auth/i.test(item.name) && item.name !== 'oai-did') continue
      if (!byName.has(item.name) || /\.chatgpt\.com$/i.test(item.host)) byName.set(item.name, item)
    }
    const ordered = HEADER_COOKIE_NAMES.map(name => byName.get(name)).filter(Boolean)
    const cookieHeader = ordered.map(item => `${item.name}=${item.value}`).join('; ')
    const hasToken = ordered.some(item => /session-token/i.test(item.name))
    return {
      ok: hasToken && cookieHeader.length > 0,
      cookieHeader,
      deviceId: byName.get('oai-did')?.value || ''
    }
  } catch (error) {
    return {
      ok: false,
      error: error.code || 'decrypt-failed',
      cookieHeader: '',
      deviceId: ''
    }
  } finally {
    try { fs.rmSync(copyDir, { recursive: true, force: true }) } catch (_) { /* ignore */ }
  }
}

module.exports = {
  loadProtocolCookies,
  pickProfileDir,
  loadCredentialFile,
  normalizeCookieList,
  saveCredentialFile
}
