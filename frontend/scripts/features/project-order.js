(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.ProjectOrder = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'

  function isListedProject(project) {
    return !!project && !project.archived && !project.stateless
  }

  function groupKeyOf(project) {
    return project?.pinned ? 'pinned' : 'projects'
  }

  function listedSnapshot(projects) {
    return (Array.isArray(projects) ? projects : [])
      .filter(isListedProject)
      .map(item => `${item.id}:${item.pinned ? '1' : '0'}`)
      .join(',')
  }

  function listedOf(projects, pinned) {
    return (Array.isArray(projects) ? projects : []).filter(item => isListedProject(item) && !!item.pinned === !!pinned)
  }

  function insertInto(list, item, targetId, place) {
    if (!targetId) {
      list.push(item)
      return
    }
    const targetIndex = list.findIndex(entry => entry.id === targetId)
    if (targetIndex < 0) {
      list.push(item)
      return
    }
    list.splice(place === 'after' ? targetIndex + 1 : targetIndex, 0, item)
  }

  function writeListedOrder(projects, pinnedList, normalList) {
    const listedQ = [...pinnedList, ...normalList]
    let cursor = 0
    for (let index = 0; index < projects.length; index++) {
      if (!isListedProject(projects[index])) continue
      projects[index] = listedQ[cursor++]
    }
  }

  function moveListedProject(projects, draggedId, targetId, options = {}) {
    if (!Array.isArray(projects) || !draggedId) return false
    const dragged = projects.find(item => item.id === draggedId)
    if (!dragged || !isListedProject(dragged)) return false
    if (targetId && draggedId === targetId) return false

    const target = targetId ? projects.find(item => item.id === targetId) : null
    if (targetId && (!target || !isListedProject(target))) return false

    const destGroup = String(options.group || (target ? groupKeyOf(target) : '')).trim()
    if (destGroup !== 'pinned' && destGroup !== 'projects') return false
    const destPinned = destGroup === 'pinned'

    const before = listedSnapshot(projects)
    const pinnedList = listedOf(projects, true).filter(item => item.id !== draggedId)
    const normalList = listedOf(projects, false).filter(item => item.id !== draggedId)
    const destList = destPinned ? pinnedList : normalList
    insertInto(destList, dragged, target && groupKeyOf(target) === destGroup ? targetId : '', options.place)
    if (!!dragged.pinned !== destPinned) dragged.updatedAt = Date.now()
    dragged.pinned = destPinned
    writeListedOrder(projects, pinnedList, normalList)
    return listedSnapshot(projects) !== before
  }

  function moveProjectInGroup(projects, draggedId, targetId, options = {}) {
    return moveListedProject(projects, draggedId, targetId, options)
  }

  return { moveListedProject, moveProjectInGroup, isListedProject, groupKeyOf }
})
