const fs = require('fs')
const path = require('path')
const {
  MUSIC_LYRICS_MAX_CHARS,
  MUSIC_STYLE_MAX_CHARS,
  isMiniMaxMusicWebModel,
  isMiniMaxGenerateButtonText,
  isMiniMaxCreatingButtonText,
  countAppearedMiniMaxWorks,
  countReadyMiniMaxWorks,
  normalizeMusicGenerationInput,
  validateMusicGenerationInput
} = require('../electron/modules/music-generation-limits')
const { filterWebGptCoreTools } = require('../electron/modules/capability-tiers')
const { buildWebToolProtocol } = require('../electron/modules/web-bridge-coding-protocol')

const schemaPath = path.join(__dirname, '../electron/modules/schemas/media-gen.js')
const schemaText = fs.readFileSync(schemaPath, 'utf8')
if (!/"name": "generate_music"/.test(schemaText)) throw new Error('schema 缺少 generate_music')
if (!schemaText.includes('maxLength": 3500')) throw new Error('lyrics 应标注 maxLength 3500')
if (!schemaText.includes('maxLength": 2000')) throw new Error('prompt 应标注 maxLength 2000')
if (!schemaText.includes('"title"')) throw new Error('schema 应包含 title')
if (!/"n"/.test(schemaText.slice(schemaText.indexOf('generate_music'))) ) throw new Error('schema 应包含 n')
if (!schemaText.includes('[Intro]') || !schemaText.includes('[Verse]') || !schemaText.includes('[Chorus]')) {
  throw new Error('lyrics 说明应包含结构标签')
}
console.log('schema: generate_music title/n/tags/limits OK')

const longLyrics = '词'.repeat(MUSIC_LYRICS_MAX_CHARS + 80)
const longStyle = '风'.repeat(MUSIC_STYLE_MAX_CHARS + 40)
const clipped = normalizeMusicGenerationInput({
  lyrics: longLyrics,
  prompt: longStyle,
  style: 'should-not-win',
  title: '测试歌名',
  n: 9,
  is_instrumental: false
})
if (clipped.lyrics.length !== MUSIC_LYRICS_MAX_CHARS) throw new Error('歌词应截断到 3500，实际 ' + clipped.lyrics.length)
if (clipped.prompt.length !== MUSIC_STYLE_MAX_CHARS) throw new Error('风格应截断到 2000，实际 ' + clipped.prompt.length)
if (!clipped.lyricsClipped || !clipped.promptClipped) throw new Error('应标记 lyricsClipped/promptClipped')
if (clipped.n !== 4) throw new Error('n 应限制到最多 4，实际 ' + clipped.n)
if (clipped.title !== '测试歌名') throw new Error('title 应保留')
if (clipped.prompt.includes('should-not-win')) throw new Error('已有 prompt 时不应改用 style')
console.log('clip: 3500/2000/n=4 OK')

const instrumental = normalizeMusicGenerationInput({
  prompt: 'lofi piano',
  lyrics: '这段歌词不该留下',
  is_instrumental: true
})
if (instrumental.lyrics) throw new Error('纯音乐不应保留歌词')
if (validateMusicGenerationInput(instrumental)) throw new Error('纯音乐+风格应校验通过')
console.log('instrumental: drop lyrics OK')

const missingStyle = validateMusicGenerationInput(normalizeMusicGenerationInput({ lyrics: '[Verse]\nhello' }))
if (!missingStyle) throw new Error('缺风格时应失败')
const missingLyrics = validateMusicGenerationInput(normalizeMusicGenerationInput({ prompt: 'pop' }))
if (!missingLyrics) throw new Error('有人声缺歌词时应失败')
console.log('validate: missing fields OK')

if (isMiniMaxMusicWebModel({ provider: 'minimax-music-web-bridge', modelId: 'minimax-music-web' }) !== true) {
  throw new Error('网页音乐模型应识别为 MiniMax web')
}
if (isMiniMaxMusicWebModel({ provider: 'minimax', modelId: 'music-01', apiUrl: 'https://api.minimaxi.com/v1' }) !== false) {
  throw new Error('官方 API 音乐模型不应识别为 web bridge')
}
console.log('isMiniMaxMusicWebModel OK')

const filtered = filterWebGptCoreTools([
  { function: { name: 'file_read' } },
  { function: { name: 'generate_music' } },
  { function: { name: 'browser_open' } }
])
if (!filtered.some(tool => tool.function.name === 'generate_music')) throw new Error('网页工具过滤应放行 generate_music')
if (filtered.some(tool => tool.function.name === 'browser_open')) throw new Error('网页工具过滤不应放行无关工具')
console.log('filterWebGptCoreTools keeps generate_music OK')

const protocol = buildWebToolProtocol([
  { name: 'file_read', parameters: { properties: { path: {} }, required: ['path'] } },
  { name: 'generate_music', parameters: { properties: { lyrics: {}, prompt: {}, title: {}, n: {} }, required: ['prompt'] } }
])
if (!protocol.includes('generate_music')) throw new Error('网页协议应列出 generate_music')
if (!protocol.includes('3500') || !protocol.includes('2000')) throw new Error('网页协议应写出 3500/2000 字数')
if (!protocol.includes('[Verse]') && !protocol.includes('[Chorus]')) throw new Error('网页协议应写出歌词结构标签')
if (!protocol.includes('不要自己去任何音乐网站点按钮')) throw new Error('网页协议应禁止模型自己点 MiniMax')
console.log('web protocol music line OK')

const noMusicProtocol = buildWebToolProtocol([
  { name: 'file_read', parameters: { properties: { path: {} }, required: ['path'] } }
])
if (noMusicProtocol.includes('generate_music')) throw new Error('没有 generate_music 时不应塞音乐协议')
console.log('web protocol without music OK')

if (!isMiniMaxGenerateButtonText('0限时免费')) throw new Error('0限时免费 应识别为提交按钮')
if (!isMiniMaxGenerateButtonText('限时免费')) throw new Error('限时免费 应识别为提交按钮')
if (!isMiniMaxGenerateButtonText('生成')) throw new Error('生成 仍应识别为提交按钮')
if (isMiniMaxGenerateButtonText('创作中')) throw new Error('创作中 不应当成可点提交')
if (!isMiniMaxCreatingButtonText('创作中')) throw new Error('创作中 应识别为生成中')
if (!isMiniMaxCreatingButtonText('0创作中')) throw new Error('带数量的创作中 应识别为生成中')
if (isMiniMaxCreatingButtonText('0限时免费')) throw new Error('限时免费 不应识别为生成中')
if (isMiniMaxGenerateButtonText('开始创作')) throw new Error('开始创作 不应当成提交')
if (isMiniMaxGenerateButtonText('升级以获得更多声贝')) throw new Error('升级按钮不应当成提交')
if (isMiniMaxGenerateButtonText('参考音乐（可选）点击或拖拽上传，生成专属翻唱（上传即同意服务条款）')) {
  throw new Error('参考音乐上传区不应当成提交')
}
console.log('generate button text OK')

const bridgePath = path.join(__dirname, '../electron/modules/minimax-music-bridge.js')
const bridgeText = fs.readFileSync(bridgePath, 'utf8')
if (!bridgeText.includes('waitForCreationIdle')) throw new Error('桥应等待创作中结束，而不是盯下载图标')
if (bridgeText.includes('waitForGeneratedWorks')) throw new Error('不应再按作品卡/下载图标判断完成')
if (!bridgeText.includes("report('正在创作')")) throw new Error('应在创作中时报进度')
if (!bridgeText.includes("report('创作完成')")) throw new Error('应变回限时免费时报完成')
if (!bridgeText.includes('clickNoWatermark')) throw new Error('下载后应再点 MP3无水印')
if (!bridgeText.includes('无水印')) throw new Error('应默认选择无水印下载')
console.log('bridge waits on 创作中 -> 限时免费 OK')

const extraWorks = countAppearedMiniMaxWorks(
  { workCount: 5, durationCount: 5, titles: ['Light It Up', '旧歌'], downloadCount: 1 },
  { workCount: 4, durationCount: 4, titles: ['旧歌'], downloadCount: 0 }
)
if (extraWorks < 1) throw new Error('新作品标题应算作出歌')
if (countAppearedMiniMaxWorks({ workCount: 4, titles: ['旧歌'], downloadCount: 2 }, { workCount: 4, titles: ['旧歌'], downloadCount: 0 }) !== 0) {
  throw new Error('灰下载图标增加不应算作出歌完成')
}
if (countReadyMiniMaxWorks({ readyCount: 4 }, { readyCount: 4 }) !== 0) {
  throw new Error('下载仍不可用时 ready 应为 0')
}
if (countReadyMiniMaxWorks({ readyCount: 5, readyDownloadCount: 5 }, { readyCount: 4, readyDownloadCount: 4 }) !== 1) {
  throw new Error('下载变实后 ready 应 +1')
}
if (countReadyMiniMaxWorks({ readyCount: 4, readyDownloadCount: 4, downloadCount: 5 }, { readyCount: 4, readyDownloadCount: 4, downloadCount: 4 }) !== 0) {
  throw new Error('只多了一个灰下载图标时不应算 ready')
}
console.log('new works counting OK')

console.log('MiniMax music generation contract PASS')
