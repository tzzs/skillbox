import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { writeManifest, emptyManifest, addSkill, updateSkill } from '../manifest/index.js'
import { readLockfile } from '../lockfile/index.js'
import { ErrorCode } from '../errors.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { reconcile } from './engine.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import { ClaudeAdapter } from '../agent/adapters/claude.js'

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
