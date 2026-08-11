import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { withTempDir } from '../fs/test-utils.js'
import { writeManifest, emptyManifest, addSkill } from '../manifest/index.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { reconcile } from '../reconcile/engine.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import { emptyLockfile, createLockedSkill, writeLockfile } from '../lockfile/index.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { StatusService } from './status-service.js'
import { GitClient, remoteCacheKey } from '../git/index.js'

function rawGit(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`))
        return
      }
      resolve(stdout ?? '')
    })
  })
}

/** Seeds a bare remote with `remote/skills/<alias>/SKILL.md` committed. */
async function seedRemoteSkill(dir: string, alias: string): Promise<string> {
  const remote = path.join(dir, 'remote.git')
  await rawGit(dir, ['init', '--bare', '--initial-branch=main', remote])
  const work = path.join(dir, 'seed-work')
  await fs.mkdir(work, { recursive: true })
  await rawGit(work, ['init', '--initial-branch=main'])
  await rawGit(work, ['config', 'user.email', 'status-test@example.com'])
  await rawGit(work, ['config', 'user.name', 'Status Test'])
  const skillDir = path.join(work, 'skills', alias)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${alias}`, 'utf8')
  await rawGit(work, ['add', 'skills'])
  await rawGit(work, ['commit', '-m', 'seed'])
  await rawGit(work, ['remote', 'add', 'origin', remote])
  await rawGit(work, ['push', '-u', 'origin', 'main'])
  return remote
}

describe('StatusService remote sources', () => {
  it('reports a remote skill as missing until it is materialized, then ready', async () => {
    await withTempDir(async (dir) => {
      const remote = await seedRemoteSkill(dir, 'hello')
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'git', url: remote, path: 'skills/hello', ref: 'main' },
        agents: ['claude'],
      })
      await writeManifest(repoRoot, manifest)

      const remoteRoot = path.join(dir, 'remotes')
      const status = new StatusService({ repositoryRoot: repoRoot, remoteRoot })

      const before = await status.status()
      const helloBefore = before.skills.find((skill) => skill.name === 'hello')
      expect(helloBefore?.status).toBe('missing')
      expect(helloBefore?.message).toMatch(/not materialized/)

      // reconcile materializes the mirror; a second status is read-only-ready
      const layout = buildSkillboxHomeLayout(path.join(dir, 'home'))
      const library = new RuntimeLibraryService(layout.library)
      const linkState = new RuntimeLinkState({ filePath: layout.linksFile })
      await reconcile({
        repositoryRoot: repoRoot,
        library,
        linkState,
        git: new GitClient(),
        remoteRoot,
      })

      const after = await status.status()
      const helloAfter = after.skills.find((skill) => skill.name === 'hello')
      expect(helloAfter?.status).toBe('ready')
      expect(helloAfter?.mode).toBe('managed')
      expect(helloAfter?.path).toBe(
        path.join(remoteRoot, remoteCacheKey(remote), 'skills', 'hello'),
      )
      expect(helloAfter?.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    })
  }, 30000)

  it('marks an unresolvable source path as broken', async () => {
    await withTempDir(async (dir) => {
      const remote = await seedRemoteSkill(dir, 'hello')
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'git', url: remote, path: '../escape', ref: 'main' },
      })
      await writeManifest(repoRoot, manifest)

      const status = new StatusService({
        repositoryRoot: repoRoot,
        remoteRoot: path.join(dir, 'remotes'),
      })
      const report = await status.status()
      const hello = report.skills.find((skill) => skill.name === 'hello')
      expect(hello?.status).toBe('broken')
      expect(hello?.message).toMatch(/unresolvable/)
    })
  })

  it('keeps registry sources as a non-git status message', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'pack', {
        source: { type: 'registry', registry: 'skills.sh', package: 'org/pack' },
      })
      await writeManifest(repoRoot, manifest)

      const status = new StatusService({ repositoryRoot: repoRoot })
      const report = await status.status()
      const pack = report.skills.find((skill) => skill.name === 'pack')
      expect(pack?.status).toBe('missing')
      expect(pack?.message).toMatch(/registry/)
    })
  })
})

describe('StatusService outdated detection (M16.1)', () => {
  /** Seeds a materialized mirror for a github source at `remoteRoot`. */
  async function seedGithubMirror(
    repoRoot: string,
    remoteRoot: string,
    options: { lockedRevision?: string; lockedIntegrity?: string; latestRevision?: string } = {},
  ): Promise<{ mirrorDir: string; integrity: string }> {
    const source = {
      type: 'github' as const,
      repo: 'acme/skillz',
      path: 'skills/hello',
      ref: 'main',
    }
    const manifest = addSkill(emptyManifest(), 'hello', { source, agents: ['claude'] })
    await writeManifest(repoRoot, manifest)

    const mirrorDir = path.join(
      remoteRoot,
      remoteCacheKey('https://github.com/acme/skillz.git'),
      'skills',
      'hello',
    )
    await fs.mkdir(mirrorDir, { recursive: true })
    await fs.writeFile(path.join(mirrorDir, 'SKILL.md'), '# hello', 'utf8')
    const integrity = await computeSkillIntegrity(mirrorDir)

    const lockfile = emptyLockfile()
    const locked = createLockedSkill({
      mode: 'managed',
      source,
      integrity: options.lockedIntegrity ?? integrity,
    })
    locked.revision = options.lockedRevision ?? 'old-sha'
    if (options.latestRevision !== undefined) {
      locked.upstream = {
        source,
        baseRevision: locked.revision,
        latestRevision: options.latestRevision,
      }
    }
    lockfile.skills.hello = locked
    await writeLockfile(repoRoot, lockfile)
    return { mirrorDir, integrity }
  }

  it('marks a managed skill outdated when the latest upstream revision differs from the locked one', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const remoteRoot = path.join(dir, 'remotes')
      await fs.mkdir(repoRoot)
      await seedGithubMirror(repoRoot, remoteRoot)

      const status = new StatusService({
        repositoryRoot: repoRoot,
        remoteRoot,
        provider: { getLatestRevision: async () => 'new-sha' },
      })
      const report = await status.status()
      const hello = report.skills.find((skill) => skill.name === 'hello')
      expect(hello?.status).toBe('outdated')
      expect(hello?.message).toMatch(/newer upstream revision new-sha available/)
    })
  })

  it('keeps a managed skill ready when the latest revision equals the locked one', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const remoteRoot = path.join(dir, 'remotes')
      await fs.mkdir(repoRoot)
      await seedGithubMirror(repoRoot, remoteRoot, { lockedRevision: 'same-sha' })

      const status = new StatusService({
        repositoryRoot: repoRoot,
        remoteRoot,
        provider: { getLatestRevision: async () => 'same-sha' },
      })
      const report = await status.status()
      const hello = report.skills.find((skill) => skill.name === 'hello')
      expect(hello?.status).toBe('ready')
      expect(hello?.message).toBeUndefined()
    })
  })

  it('falls back to the lockfile upstream.latestRevision when no provider is wired', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const remoteRoot = path.join(dir, 'remotes')
      await fs.mkdir(repoRoot)
      await seedGithubMirror(repoRoot, remoteRoot, { latestRevision: 'new-sha' })

      const status = new StatusService({ repositoryRoot: repoRoot, remoteRoot })
      const report = await status.status()
      const hello = report.skills.find((skill) => skill.name === 'hello')
      expect(hello?.status).toBe('outdated')
    })
  })

  it('prefers a live provider over the recorded latestRevision', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const remoteRoot = path.join(dir, 'remotes')
      await fs.mkdir(repoRoot)
      await seedGithubMirror(repoRoot, remoteRoot, { latestRevision: 'stale-recording' })

      const status = new StatusService({
        repositoryRoot: repoRoot,
        remoteRoot,
        provider: { getLatestRevision: async () => 'live-sha' },
      })
      const report = await status.status()
      const hello = report.skills.find((skill) => skill.name === 'hello')
      expect(hello?.status).toBe('outdated')
      expect(hello?.message).toMatch(/live-sha/)
    })
  })

  it('reports modified (integrity mismatch) instead of outdated', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const remoteRoot = path.join(dir, 'remotes')
      await fs.mkdir(repoRoot)
      // Locked integrity differs from the on-disk mirror content.
      await seedGithubMirror(repoRoot, remoteRoot, {
        lockedIntegrity: `sha256:${'a'.repeat(64)}`,
      })

      const status = new StatusService({
        repositoryRoot: repoRoot,
        remoteRoot,
        provider: { getLatestRevision: async () => 'new-sha' },
      })
      const report = await status.status()
      const hello = report.skills.find((skill) => skill.name === 'hello')
      expect(hello?.status).toBe('modified')
    })
  })

  it('keeps the status ready when the registry lookup fails', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const remoteRoot = path.join(dir, 'remotes')
      await fs.mkdir(repoRoot)
      await seedGithubMirror(repoRoot, remoteRoot)

      const status = new StatusService({
        repositoryRoot: repoRoot,
        remoteRoot,
        provider: {
          getLatestRevision: async () => {
            throw new Error('registry down')
          },
        },
      })
      const report = await status.status()
      const hello = report.skills.find((skill) => skill.name === 'hello')
      expect(hello?.status).toBe('ready')
    })
  })
})

describe('StatusService pending merge (M20.5)', () => {
  it('reports conflict while a merge state exists for the skill', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      const homeRoot = path.join(dir, 'home')
      await fs.mkdir(repoRoot)
      const skillDir = path.join(repoRoot, 'skills', 'hello')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# hello', 'utf8')

      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'local', path: 'skills/hello' },
      })
      await writeManifest(repoRoot, manifest)
      const lockfile = emptyLockfile()
      lockfile.skills.hello = createLockedSkill({
        mode: 'local',
        source: { type: 'local', path: 'skills/hello' },
        integrity: await computeSkillIntegrity(skillDir),
      })
      await writeLockfile(repoRoot, lockfile)

      // A merge state dir marks the skill as mid-merge.
      const stateDir = path.join(homeRoot, 'state', 'merge', 'hello')
      await fs.mkdir(stateDir, { recursive: true })
      await fs.writeFile(
        path.join(stateDir, 'state.json'),
        JSON.stringify({
          version: 1,
          alias: 'hello',
          mode: 'forked',
          startedAt: new Date().toISOString(),
          baseRevision: 'rev1',
          latestRevision: 'rev2',
          conflictFiles: [{ path: 'SKILL.md', hunks: 1 }],
        }),
      )

      const previous = process.env.SKILLBOX_HOME
      process.env.SKILLBOX_HOME = homeRoot
      try {
        const status = new StatusService({ repositoryRoot: repoRoot })
        const report = await status.status()
        const hello = report.skills.find((skill) => skill.name === 'hello')
        expect(hello?.status).toBe('conflict')
        expect(hello?.message).toMatch(/merge in progress/)
      } finally {
        if (previous === undefined) {
          delete process.env.SKILLBOX_HOME
        } else {
          process.env.SKILLBOX_HOME = previous
        }
      }
    })
  })
})
