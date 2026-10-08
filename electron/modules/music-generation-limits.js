/**
 * MiniMax 音乐生成字段约束。
 * 页面桥和官方 API 共用：歌词最多 3500 字，风格最多 2000 字。
 * schema 只负责教模型怎么填；真正保证上限的是这里的截断。
 */

const MUSIC_LYRICS_MAX_CHARS = 3500
const MUSIC_STYLE_MAX_CHARS = 2000
const MUSIC_TITLE_MAX_CHARS = 80
const MUSIC_N_MIN = 1
const MUSIC_N_MAX = 4

function clipChars(value, max) {
  const text = String(value == null ? '' : value)
  if (text.length <= max) return text
  return text.slice(0, max)
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value == null ? '' : value).trim()
    if (text) return text
  }
  return ''
}

function isMiniMaxMusicWebModel(model = {}) {
  const text = [
    model.provider,
    model.modelId,
    model.modelName,
    model.imageModel,
    model.musicModel
  ].filter(Boolean).join(' ')
  return /minimax-music-web-bridge|minimax-music-web/i.test(text)
}

function normalizeMusicGenerationInput(args = {}) {
  const instrumental = !!(args.is_instrumental ?? args.instrumental)
  const prompt = clipChars(
    firstNonEmpty(args.prompt, args.style, args.description),
    MUSIC_STYLE_MAX_CHARS
  )
  const lyrics = instrumental
    ? ''
    : clipChars(firstNonEmpty(args.lyrics, args.lyric), MUSIC_LYRICS_MAX_CHARS)
  const title = clipChars(
    firstNonEmpty(args.title, args.song_name, args.songName, args.song_title),
    MUSIC_TITLE_MAX_CHARS
  )
  const rawN = Number(args.n ?? args.count ?? args.quantity ?? 1)
  const n = Math.max(
    MUSIC_N_MIN,
    Math.min(MUSIC_N_MAX, Number.isFinite(rawN) ? Math.round(rawN) : 1)
  )
  return {
    prompt,
    lyrics,
    title,
    n,
    instrumental,
    lyricsClipped: !instrumental && firstNonEmpty(args.lyrics, args.lyric).length > MUSIC_LYRICS_MAX_CHARS,
    promptClipped: firstNonEmpty(args.prompt, args.style, args.description).length > MUSIC_STYLE_MAX_CHARS
  }
}

function validateMusicGenerationInput(prepared = {}) {
  if (!String(prepared.prompt || '').trim()) {
    return '生成音乐需要风格提示词：请把风格、情绪、乐器写入 prompt（最多 2000 字），不要把歌词写进 prompt。'
  }
  if (!prepared.instrumental && !String(prepared.lyrics || '').trim()) {
    return '有人声时必须填写 lyrics。请用 [Intro]/[Verse]/[Chorus]/[Bridge]/[Outro] 分段，最多 3500 字。纯音乐请设 is_instrumental=true，不要填歌词。'
  }
  return ''
}

function isMiniMaxCreatingButtonText(text = '') {
  return /创作中/.test(String(text || '').replace(/\s+/g, ''))
}

function isMiniMaxGenerateButtonText(text = '') {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact) return false
  if (/创作中/.test(compact)) return false
  if (/开始创作|升级以获得|新手教程|参考音乐|生成专属翻唱/.test(compact)) return false
  if (/限时免费/.test(compact)) return true
  if (compact === '生成') return true
  if (/生成/.test(compact) && !/生成中|重新生成/.test(compact) && compact.length <= 16) return true
  return false
}

function countAppearedMiniMaxWorks(current = {}, baseline = {}) {
  const extraCount = Math.max(0, Number(current.workCount || 0) - Number(baseline.workCount || 0))
  const extraDurations = Math.max(0, Number(current.durationCount || 0) - Number(baseline.durationCount || 0))
  const previousTitles = new Set((baseline.titles || []).filter(Boolean))
  const extraTitles = (current.titles || []).filter(title => title && !previousTitles.has(title))
  return Math.max(extraCount, extraDurations, extraTitles.length)
}

function countReadyMiniMaxWorks(current = {}, baseline = {}) {
  const extraReady = Math.max(0, Number(current.readyCount || 0) - Number(baseline.readyCount || 0))
  const extraReadyDownloads = Math.max(0, Number(current.readyDownloadCount || 0) - Number(baseline.readyDownloadCount || 0))
  return Math.max(extraReady, extraReadyDownloads)
}

function countNewMiniMaxWorks(current = {}, baseline = {}) {
  return Math.max(countAppearedMiniMaxWorks(current, baseline), countReadyMiniMaxWorks(current, baseline))
}

module.exports = {
  MUSIC_LYRICS_MAX_CHARS,
  MUSIC_STYLE_MAX_CHARS,
  MUSIC_TITLE_MAX_CHARS,
  MUSIC_N_MIN,
  MUSIC_N_MAX,
  clipChars,
  isMiniMaxMusicWebModel,
  isMiniMaxGenerateButtonText,
  isMiniMaxCreatingButtonText,
  countNewMiniMaxWorks,
  countAppearedMiniMaxWorks,
  countReadyMiniMaxWorks,
  normalizeMusicGenerationInput,
  validateMusicGenerationInput
}
