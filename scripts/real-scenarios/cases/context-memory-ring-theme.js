const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'context-memory-ring-theme',
  title: 'Context budget ring follows theme tokens instead of a fixed light ring',
  tags: ['frontend', 'context', 'theme'],
  changedFilePatterns: [
    /^frontend\/styles\/context-memory-ruler\.css$/i,
    /^frontend\/index\.html$/i
  ],

  async run(ctx) {
    const css = fs.readFileSync(path.join(ctx.root, 'frontend/styles/context-memory-ruler.css'), 'utf8')
    const html = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')

    ctx.assert.ok(
      /\.cmring-bg\s*\{[\s\S]*stroke:\s*color-mix\(in srgb, var\(--text-primary\)/.test(css),
      'the ring track must mix from theme text color, not a fixed white overlay'
    )
    ctx.assert.ok(
      /\.cmstack--safe\s*\{\s*--cm-tone:\s*var\(--accent-primary\)/.test(css),
      'the progress arc must use the theme accent instead of a hardcoded blue'
    )
    ctx.assert.ok(
      !/\.cmring-bg[\s\S]{0,80}rgba\(255,\s*255,\s*255/.test(css),
      'the ring track must not stay locked to a white stroke'
    )
    ctx.assert.match(html, /context-memory-ruler\.css\?v=20260829-cmring-theme/)
  }
}
