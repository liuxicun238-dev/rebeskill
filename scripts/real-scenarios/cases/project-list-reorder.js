const fs = require('fs')
const path = require('path')

module.exports = {
  id: 'project.list-reorder',
  title: 'Pinned and normal project lists share one drag list; dropping across groups pins or unpins',
  tags: ['sidebar', 'projects', 'drag'],
  changedFilePatterns: [
    /^frontend\/scripts\/features\/project-order\.js$/i,
    /^frontend\/scripts\/features\/project-list\.js$/i,
    /^frontend\/scripts\/features\/projects\.js$/i,
    /^frontend\/scripts\/features\/archive-panel\.js$/i,
    /^frontend\/styles\/sidebar\.css$/i
  ],

  async run(ctx) {
    const order = require(path.join(ctx.root, 'frontend/scripts/features/project-order.js'))
    const listUi = fs.readFileSync(path.join(ctx.root, 'frontend/scripts/features/project-list.js'), 'utf8')
    const indexHtml = fs.readFileSync(path.join(ctx.root, 'frontend/index.html'), 'utf8')

    ctx.assert.ok(indexHtml.includes('project-order.js'), 'index.html should load the shared project order helper')
    ctx.assert.ok(listUi.includes('is-drag-handle'), 'project header should be the drag handle')
    ctx.assert.ok(listUi.includes("dataset.group"), 'project items should remember pinned vs normal group')
    ctx.assert.ok(listUi.includes("place === 'after'") || listUi.includes("place === \"after\""), 'drop should distinguish before/after')
    ctx.assert.equal(/draggable="true"/.test(listUi), false, 'native HTML5 drag must stay off in Electron')
    ctx.assert.ok(listUi.includes('pointerdown'), 'project reorder must use pointer events')
    ctx.assert.ok(listUi.includes('project-drop-indicator'), 'drop must show an insertion line')
    ctx.assert.ok(listUi.includes('project-drag-ghost'), 'drag must show a floating ghost of the project row')
    ctx.assert.ok(listUi.includes('bindProjectListReorder'), 'pinned and normal lists should share one reorder binder')
    ctx.assert.equal(listUi.includes('bindProjectGroupReorder'), false, 'per-group-only reorder binding should be gone')
    ctx.assert.ok(listUi.includes("appendProjectGroup(container, '置顶'"), 'pinned group should always render')
    ctx.assert.ok(listUi.includes("appendProjectGroup(container, '项目'"), 'normal group should always render')
    ctx.assert.equal(/if \(projects\.length === 0\) return/.test(listUi), false, 'empty pinned/normal groups should still be drop targets')
    ctx.assert.ok(listUi.includes('is-empty'), 'empty groups should be marked for drop targeting')
    ctx.assert.ok(
      listUi.includes('const prevScrollTop = container.scrollTop || 0') &&
        listUi.includes('container.scrollTop = prevScrollTop'),
      're-rendering the project list must keep sidebar scroll so activity updates during a run do not jump'
    )

    const css = fs.readFileSync(path.join(ctx.root, 'frontend/styles/sidebar.css'), 'utf8')
    ctx.assert.ok(css.includes('.project-drop-indicator::before'), 'insertion line should have the circular node')
    ctx.assert.ok(css.includes('.project-drag-ghost'), 'ghost styles should be present')
    ctx.assert.ok(css.includes('.project-list-group-body.is-empty'), 'empty group drop zone styles should be present')

    const projects = [
      { id: 'pin-a', pinned: true },
      { id: 'a', pinned: false },
      { id: 'b', pinned: false },
      { id: 'c', pinned: false },
      { id: 'pin-b', pinned: true },
      { id: 'archived', pinned: false, archived: true },
      { id: 'temp', pinned: false, stateless: true }
    ]

    ctx.assert.equal(
      order.moveProjectInGroup(projects, 'c', 'a', { group: 'projects', place: 'before' }),
      true,
      'normal list should accept a same-group move'
    )
    ctx.assert.deepEqual(
      projects.filter(item => !item.pinned && !item.archived && !item.stateless).map(item => item.id),
      ['c', 'a', 'b'],
      'normal list order should become c, a, b'
    )
    ctx.assert.deepEqual(
      projects.filter(item => item.pinned).map(item => item.id),
      ['pin-a', 'pin-b'],
      'pinned list should stay put while the normal list moves'
    )
    ctx.assert.equal(projects.find(item => item.archived)?.id, 'archived', 'archived rows should not be rewritten')
    ctx.assert.equal(projects.find(item => item.stateless)?.id, 'temp', 'stateless rows should not be rewritten')

    ctx.assert.equal(
      order.moveProjectInGroup(projects, 'pin-b', 'pin-a', { group: 'pinned', place: 'before' }),
      true,
      'pinned list should accept a same-group move'
    )
    ctx.assert.deepEqual(
      projects.filter(item => item.pinned).map(item => item.id),
      ['pin-b', 'pin-a'],
      'pinned list order should become pin-b, pin-a'
    )

    ctx.assert.equal(
      order.moveProjectInGroup(projects, 'pin-b', 'c', { group: 'projects', place: 'before' }),
      true,
      'dragging from 置顶 onto 项目 should unpin and insert'
    )
    ctx.assert.equal(projects.find(item => item.id === 'pin-b')?.pinned, false, 'dropped pinned project should become unpinned')
    ctx.assert.deepEqual(
      projects.filter(item => item.pinned).map(item => item.id),
      ['pin-a'],
      'pinned list should drop the moved project'
    )
    ctx.assert.deepEqual(
      projects.filter(item => !item.pinned && !item.archived && !item.stateless).map(item => item.id),
      ['pin-b', 'c', 'a', 'b'],
      'unpinned project should land before the drop target in 项目'
    )

    ctx.assert.equal(
      order.moveProjectInGroup(projects, 'c', 'pin-a', { place: 'after' }),
      true,
      'dropping onto a pinned row should pin without a separate pin click'
    )
    ctx.assert.equal(projects.find(item => item.id === 'c')?.pinned, true, 'dropped normal project should become pinned')
    ctx.assert.deepEqual(
      projects.filter(item => item.pinned).map(item => item.id),
      ['pin-a', 'c'],
      'pinned list should insert after the drop target'
    )
    ctx.assert.deepEqual(
      projects.filter(item => !item.pinned && !item.archived && !item.stateless).map(item => item.id),
      ['pin-b', 'a', 'b'],
      'normal list should lose the newly pinned project'
    )

    ctx.assert.equal(
      order.moveProjectInGroup(projects, 'b', 'pin-b', { group: 'projects', place: 'after' }),
      true,
      'normal list should still support insert-after'
    )
    ctx.assert.deepEqual(
      projects.filter(item => !item.pinned && !item.archived && !item.stateless).map(item => item.id),
      ['pin-b', 'b', 'a'],
      'inserting b after pin-b should become pin-b, b, a'
    )

    const emptyPinned = [
      { id: 'only-a', pinned: false },
      { id: 'only-b', pinned: false },
      { id: 'archived', pinned: false, archived: true }
    ]
    ctx.assert.equal(
      order.moveListedProject(emptyPinned, 'only-a', '', { group: 'pinned', place: 'after' }),
      true,
      'dropping into an empty 置顶 group should pin without a target row'
    )
    ctx.assert.equal(emptyPinned.find(item => item.id === 'only-a')?.pinned, true, 'project dropped into empty 置顶 should be pinned')
    ctx.assert.deepEqual(
      emptyPinned.filter(item => !item.archived).map(item => `${item.id}:${item.pinned ? '1' : '0'}`),
      ['only-a:1', 'only-b:0'],
      'empty 置顶 drop should keep listed slots as pinned then normal'
    )
  }
}
