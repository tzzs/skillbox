import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { withTempDir } from '../fs/test-utils.js'
import { writeManifest, emptyManifest, addSkill, updateSkill } from '../manifest/index.js'
import { readLockfile } from '../lockfile/index.js'
import { ErrorCode } from '../errors.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { reconcile } from './engine.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import { ClaudeAdapter } from '../agent/adapters/claude.js'
import { GitClient } from '../git/index.js'
import { ProviderRegistry } from '../registry/registry.js'
import type { RegistryProvider } from '../registry/types.js'

function makeFixture(homeRoot: string) {
  const layout = buildSkillboxHomeLayout(homeRoot)
  const library = new RuntimeLibraryService(layout.library)
  const linkState = new RuntimeLinkState({ filePath: layout.linksFile })
  return { layout, library, linkState }
}

/** Writes a local skill into `repo/skills/<alias>`. */
async function writeRepoSkill(
  repo: string,
  alias: string,
  content = `# ${alias}`,
): Promise<string> {
  const dir = path.join(repo, 'skills', alias)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), content)
  return dir
}

/** A Claude adapter isolated under `dir`, with `copy`-based linking. */
function claude(root: string): { skillsRoot: string; adapter: ClaudeAdapter } {
  const skillsRoot = path.join(root, 'agent-skills', '.claude', 'skills')
  const adapter = new ClaudeAdapter({ skillsDir: skillsRoot, searchPath: false })
  return { skillsRoot, adapter }
}

describe('reconcile', () => {
  it('materializes a local skill, writes the lockfile and assigns agents', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      await writeRepoSkill(repoRoot, 'hello')
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'local', path: 'skills/hello' },
        agents: ['claude'],
        mode: 'local',
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const { adapter } = claude(dir)
      const adapters = new Map([['claude', adapter]])

      const result = await reconcile({
        repositoryRoot: repoRoot,
        library,
        linkState,
        adapters,
        linkStrategy: 'copy',
      })

      expect(result.changed).toBe(true)
      const hello = result.skills.find((skill) => skill.alias === 'hello')
      expect(hello?.status).toBe('ok')
      expect(hello?.materialized).toBe(true)
      expect(hello?.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(hello?.links?.[0]?.agent).toBe('claude')

      const lock = await readLockfile(repoRoot)
      expect(lock.skills.hello).toBeDefined()
      expect(lock.skills.hello?.integrity).toBe(hello?.integrity)
    })
  })

  it('is idempotent: a second immediate run reports no changes', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      await writeRepoSkill(repoRoot, 'hello')
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'local', path: 'skills/hello' },
        mode: 'local',
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const options = { repositoryRoot: repoRoot, library, linkState }

      const first = await reconcile(options)
      expect(first.changed).toBe(true)
      const firstHello = first.skills.find((s) => s.alias === 'hello')
      expect(firstHello?.materializeStatus).toBe('created')

      const lockFile = path.join(repoRoot, 'skillbox.lock')
      const before = await fs.readFile(lockFile, 'utf8')
      const second = await reconcile(options)
      expect(second.changed).toBe(false)
      const after = await fs.readFile(lockFile, 'utf8')
      expect(after).toBe(before)
      const secondHello = second.skills.find((s) => s.alias === 'hello')
      expect(secondHello?.materializeStatus).toBe('unchanged')
      expect(secondHello?.integrity).toBe(firstHello?.integrity)
    })
  })

  it('reports a missing local skill as status + problem without crashing', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'ghost', {
        source: { type: 'local', path: 'skills/ghost' },
        mode: 'local',
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const result = await reconcile({ repositoryRoot: repoRoot, library, linkState })

      const ghost = result.skills.find((skill) => skill.alias === 'ghost')
      expect(ghost?.status).toBe('missing')
      expect(result.problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: ErrorCode.SKILL_MISSING, alias: 'ghost' }),
        ]),
      )
      expect(result.skills.filter((skill) => skill.status === 'missing')).toHaveLength(1)
    })
  })

  it('reports a broken local skill (no SKILL.md) as status + problem', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      await fs.mkdir(path.join(repoRoot, 'skills', 'flaky'), { recursive: true })
      const manifest = addSkill(emptyManifest(), 'flaky', {
        source: { type: 'local', path: 'skills/flaky' },
        mode: 'local',
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const result = await reconcile({ repositoryRoot: repoRoot, library, linkState })

      const flaky = result.skills.find((skill) => skill.alias === 'flaky')
      expect(flaky?.status).toBe('broken')
      expect(result.problems).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: ErrorCode.SKILL_BROKEN })]),
      )
    })
  })

  it('removes a dropped Skillbox link but preserves an external skill (M7.4)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      await writeRepoSkill(repoRoot, 'alpha')

      let manifest = addSkill(emptyManifest(), 'alpha', {
        source: { type: 'local', path: 'skills/alpha' },
        agents: ['claude'],
        mode: 'local',
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const { skillsRoot, adapter } = claude(dir)
      const adapters = new Map([['claude', adapter]])

      const first = await reconcile({
        repositoryRoot: repoRoot,
        library,
        linkState,
        adapters,
        linkStrategy: 'copy',
      })
      expect(first.changed).toBe(true)

      const agentDir = path.join(skillsRoot, 'alpha')
      expect(await dirExists(agentDir)).toBe(true)

      await fs.writeFile(path.join(skillsRoot, 'personal'), '# personal', 'utf8')

      manifest = updateSkill(manifest, 'alpha', { agents: [] })
      await writeManifest(repoRoot, manifest)

      const dropped = await reconcile({
        repositoryRoot: repoRoot,
        library,
        linkState,
        adapters,
        linkStrategy: 'copy',
      })
      expect(dropped.staleLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agent: 'claude', alias: 'alpha', action: 'removed' }),
        ]),
      )
      expect(await dirExists(agentDir)).toBe(false)
      expect(await statExists(path.join(skillsRoot, 'personal'))).toBe(true)
    })
  })

  it('keeps an unmanaged external skill untouched during reconcile', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      await writeRepoSkill(repoRoot, 'alpha')

      const manifest = addSkill(emptyManifest(), 'alpha', {
        source: { type: 'local', path: 'skills/alpha' },
        agents: ['claude'],
        mode: 'local',
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const { skillsRoot, adapter } = claude(dir)
      const adapters = new Map([['claude', adapter]])

      const externalSkillDir = path.join(skillsRoot, 'ext')
      await fs.mkdir(externalSkillDir, { recursive: true })
      await fs.writeFile(path.join(externalSkillDir, 'SKILL.md'), '# ext')

      await reconcile({
        repositoryRoot: repoRoot,
        library,
        linkState,
        adapters,
        linkStrategy: 'copy',
      })

      expect(await fs.readFile(path.join(externalSkillDir, 'SKILL.md'), 'utf8')).toBe('# ext')
    })
  })

  it('materializes a git source via clone and records the immutable revision', async () => {
    await withTempDir(async (dir) => {
      const { remote } = await seedGitRemote(dir, 'remote.git', 'hello', '# hello upstream')
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'git', url: remote, path: 'skills/hello', ref: 'main' },
        agents: ['claude'],
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const { adapter } = claude(dir)
      const adapters = new Map([['claude', adapter]])

      const result = await reconcile({
        repositoryRoot: repoRoot,
        library,
        linkState,
        adapters,
        linkStrategy: 'copy',
        git: new GitClient(),
        remoteRoot: path.join(dir, 'remotes'),
      })

      const hello = result.skills.find((skill) => skill.alias === 'hello')
      expect(hello?.status).toBe('ok')
      expect(hello?.mode).toBe('managed')
      expect(hello?.materialized).toBe(true)
      expect(hello?.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(hello?.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(hello?.links?.[0]?.agent).toBe('claude')

      const lock = await readLockfile(repoRoot)
      expect(lock.skills.hello?.mode).toBe('managed')
      expect(lock.skills.hello?.revision).toBe(hello?.revision)
      expect(lock.skills.hello?.integrity).toBe(hello?.integrity)
    })
  }, 30000)

  it('reconciles a git source idempotently and refreshes when the remote advances', async () => {
    await withTempDir(async (dir) => {
      const { remote, work } = await seedGitRemote(dir, 'remote.git', 'hello', '# v1')
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'git', url: remote, path: 'skills/hello', ref: 'main' },
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const options = {
        repositoryRoot: repoRoot,
        library,
        linkState,
        git: new GitClient(),
        remoteRoot: path.join(dir, 'remotes'),
      }

      const first = await reconcile(options)
      expect(first.skills.find((s) => s.alias === 'hello')?.status).toBe('ok')
      expect(first.changed).toBe(true)
      const firstLock = await readLockfile(repoRoot)
      const firstRevision = firstLock.skills.hello?.revision

      const second = await reconcile(options)
      expect(second.changed).toBe(false)

      // remote gains a commit → next reconcile refreshes the mirror + library
      await advanceGitRemote(work, 'hello', '# v2')
      const third = await reconcile(options)
      expect(third.changed).toBe(true)
      const thirdHello = third.skills.find((s) => s.alias === 'hello')
      expect(thirdHello?.status).toBe('ok')
      expect(thirdHello?.revision).not.toBe(firstRevision)
      const thirdLock = await readLockfile(repoRoot)
      expect(thirdLock.skills.hello?.revision).toBe(thirdHello?.revision)
    })
  }, 30000)

  it('keeps a registry source out of the git path as skipped', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'pack', {
        source: { type: 'registry', registry: 'skills.sh', package: 'org/pack' },
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const result = await reconcile({
        repositoryRoot: repoRoot,
        library,
        linkState,
        git: new GitClient(),
        remoteRoot: path.join(dir, 'remotes'),
      })

      const pack = result.skills.find((skill) => skill.alias === 'pack')
      expect(pack?.status).toBe('skipped')
      expect(pack?.message).toMatch(/registry/)
    })
  })
})

async function dirExists(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function statExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/** Runs `git` directly to scaffold test remotes (bare init, commit, push). */
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

/**
 * Creates a bare git remote seeded with one skill commit. Returns the remote
 * path (a manifest `git` source URL) and the work repo used to advance it.
 */
async function seedGitRemote(
  dir: string,
  name: string,
  skillAlias: string,
  content: string,
): Promise<{ remote: string; work: string }> {
  const remotePath = path.join(dir, name)
  await rawGit(dir, ['init', '--bare', '--initial-branch=main', remotePath])

  const work = path.join(dir, `${name}-seed`)
  await fs.mkdir(work, { recursive: true })
  await rawGit(work, ['init', '--initial-branch=main'])
  await rawGit(work, ['config', 'user.email', 'reconcile-test@example.com'])
  await rawGit(work, ['config', 'user.name', 'Reconcile Test'])

  await writeRepoSkill(work, skillAlias, content)
  await rawGit(work, ['add', 'skills'])
  await rawGit(work, ['commit', '-m', 'seed skill'])
  await rawGit(work, ['remote', 'add', 'origin', remotePath])
  await rawGit(work, ['push', '-u', 'origin', 'main'])
  return { remote: remotePath, work }
}

/** Pushes a new version of a skill file from the remote's work repo. */
async function advanceGitRemote(
  workDir: string,
  skillAlias: string,
  content: string,
): Promise<void> {
  await writeRepoSkill(workDir, skillAlias, content)
  await rawGit(workDir, ['add', 'skills'])
  await rawGit(workDir, ['commit', '-m', 'advance skill'])
  await rawGit(workDir, ['push', 'origin', 'main'])
}

/** Fake skills.sh provider: downloads the subtree into the target dir. */
function fakeSkillsShProvider(): RegistryProvider {
  return {
    id: 'skills-sh',
    search: async () => [],
    resolve: async (source) => ({ source, revision: 'abc123' }),
    download: async (_source, _revision, targetDir) => {
      await fs.mkdir(targetDir, { recursive: true })
      await fs.writeFile(path.join(targetDir, 'SKILL.md'), '# hello\n')
    },
    getLatestRevision: async () => 'abc123',
  }
}

describe('reconcile with registry sources', () => {
  it('materializes a registry (skills.sh) source via the registry provider on a fresh clone', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'registry', registry: 'skills.sh', package: 'acme/hello' },
        mode: 'managed',
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const providers = new ProviderRegistry()
      providers.registerProvider(fakeSkillsShProvider())

      const result = await reconcile({
        repositoryRoot: repoRoot,
        library,
        linkState,
        registry: providers,
      })

      expect(result.problems).toHaveLength(0)
      const report = result.skills.find((entry) => entry.alias === 'hello')
      expect(report?.status).toBe('ok')
      expect(report?.revision).toBe('abc123')
      await expect(
        fs.stat(path.join(dir, 'home', 'library', 'managed', 'hello', 'SKILL.md')),
      ).resolves.toBeDefined()
      const lockfile = await readLockfile(repoRoot)
      expect(lockfile.skills['hello']?.revision).toBe('abc123')
    })
  })

  it('skips a registry source with an actionable hint when no provider is wired', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const manifest = addSkill(emptyManifest(), 'hello', {
        source: { type: 'registry', registry: 'skills.sh', package: 'acme/hello' },
        mode: 'managed',
      })
      await writeManifest(repoRoot, manifest)

      const { library, linkState } = makeFixture(path.join(dir, 'home'))
      const result = await reconcile({ repositoryRoot: repoRoot, library, linkState })

      const report = result.skills.find((entry) => entry.alias === 'hello')
      expect(report?.status).toBe('skipped')
      expect(report?.message).toContain('skills-sh')
      expect(report?.message).toContain('skillbox add')
    })
  })
})
