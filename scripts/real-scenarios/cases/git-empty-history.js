const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

module.exports = {
  id: 'git.empty-history',
  title: 'A repository without commits is a normal empty recovery history',
  tags: ['git', 'recovery-points', 'frontend-safety'],
  changedFilePatterns: [
    /^electron\/modules\/git\.js$/i,
    /^electron\/modules\/project-worktrees\.js$/i,
    /^frontend\/scripts\/features\/git-panel\.js$/i
  ],

  async run(ctx) {
    const git = require(path.join(ctx.root, 'electron/modules/git'))
    const worktrees = require(path.join(ctx.root, 'electron/modules/project-worktrees'))
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-empty-git-'))
    const plainProject = path.join(base, 'plain')
    const emptyRepo = path.join(base, 'empty-repo')
    const emptyBranchRepo = path.join(base, 'empty-branch')
    const emptyWorktreeRepo = path.join(base, 'empty-wt')
    fs.mkdirSync(plainProject, { recursive: true })
    fs.mkdirSync(emptyRepo, { recursive: true })
    fs.mkdirSync(emptyBranchRepo, { recursive: true })
    fs.mkdirSync(emptyWorktreeRepo, { recursive: true })

    let createdWorktree = null
    try {
      const plain = await git.getGitLog(plainProject)
      ctx.assert.equal(plain.success, true, 'a project without .git must not break recovery history')
      ctx.assert.deepEqual(plain.commits, [])
      ctx.assert.equal(plain.reason, 'not-a-repository')

      execFileSync('git', ['init'], { cwd: emptyRepo, windowsHide: true, stdio: 'ignore' })
      const empty = await git.getGitLog(emptyRepo)
      ctx.assert.equal(empty.success, true, 'an initialized repository without HEAD must be a normal empty state')
      ctx.assert.deepEqual(empty.commits, [])
      ctx.assert.equal(empty.reason, 'no-commits')
      ctx.assert.equal(empty.repository, true)

      execFileSync('git', ['init'], { cwd: emptyBranchRepo, windowsHide: true, stdio: 'ignore' })
      ctx.assert.equal(await git.hasHeadCommit(emptyBranchRepo), false, 'fresh init has no HEAD')
      const seeded = await git.ensureHeadCommit(emptyBranchRepo)
      ctx.assert.equal(seeded.created, true, 'empty repos should get an initial commit before branching')
      ctx.assert.equal(await git.hasHeadCommit(emptyBranchRepo), true)
      await git.execGit(emptyBranchRepo, ['branch', 'feature-empty'])
      const refs = await git.execGit(emptyBranchRepo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      ctx.assert.ok(String(refs).split(/\r?\n/).includes('feature-empty'), 'git branch should succeed after seeding HEAD')

      execFileSync('git', ['init'], { cwd: emptyWorktreeRepo, windowsHide: true, stdio: 'ignore' })
      const wt = await worktrees.createWorktree({
        projectPath: emptyWorktreeRepo,
        branchName: 'wt-empty'
      })
      ctx.assert.equal(wt.success, true, wt.error || 'empty-repo worktree create should succeed')
      ctx.assert.ok(wt.worktreePath, 'worktree path should be returned')
      createdWorktree = wt
    } finally {
      if (createdWorktree?.worktreePath) {
        try {
          await worktrees.removeWorktree({
            projectPath: emptyWorktreeRepo,
            worktreePath: createdWorktree.worktreePath,
            force: true
          })
        } catch {}
      }
      fs.rmSync(base, { recursive: true, force: true })
    }
  }
}
