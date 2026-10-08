const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'resource-center.audio-inline-play',
  title: 'Resource Center audio cards can be played in place',
  tags: ['resource-center', 'assets', 'audio'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/integration-market\.js$/i,
    /^frontend\/styles\/resource-center\.css$/i
  ],

  async run(ctx) {
    const js = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/integration-market.js'), 'utf8')
    const css = fs.readFileSync(path.join(ctx.root, 'frontend/styles/resource-center.css'), 'utf8')
    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')

    ctx.assert.ok(js.includes('function isPreviewableAudio'), 'audio detection helper must exist')
    ctx.assert.ok(js.includes('asset-library-audio-preview'), 'audio cards must render an in-place player shell')
    ctx.assert.ok(js.includes('toggleAssetAudio'), 'clicking an audio card must toggle playback')
    ctx.assert.ok(js.includes('pauseOtherAssetAudio'), 'starting one audio file must stop the others')
    ctx.assert.ok(js.includes('pauseAllAssetAudio()'), 'closing the resource center must stop audio')
    ctx.assert.ok(js.includes('data-asset-ui="audio-seek"'), 'audio cards must expose a seek control')
    const audioPreviewBlock = js.match(/if \(isPreviewableAudio\(item\)\) \{[\s\S]*?<audio preload="metadata"[\s\S]*?<\/div>`/)
    ctx.assert.ok(audioPreviewBlock, 'audio preview markup must be generated as its own branch')
    ctx.assert.ok(!audioPreviewBlock[0].includes('data-asset-action="open"'), 'audio preview must not reuse the image/video open action')
    ctx.assert.ok(audioPreviewBlock[0].includes('<audio preload="metadata"'), 'audio preview must include an inline audio element')
    ctx.assert.ok(css.includes('.asset-library-audio-preview'), 'audio player styles must live in the resource center sheet')
    ctx.assert.ok(css.includes('.asset-library-audio-play'), 'audio cards must show a play affordance')
    ctx.assert.ok(html.includes('resource-center.css?v=20260818-audio-play'), 'resource center css cache must include the audio player refresh')
    ctx.assert.ok(html.includes('integration-market.js?v=20260818-audio-play'), 'resource center script cache must include the audio player refresh')
  }
}
