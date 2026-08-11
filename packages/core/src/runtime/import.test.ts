import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { readManifest } from '../manifest/index.js'
import { readLockfile } from '../lockfile/index.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { importSkill } from './import.js'
import { buildSkillboxHomeLayout } from './paths.js'
import { ClaudeAdapter } from '../agent/adapters/claude.js'

function fixture(homeRoot: string) {
  const layout = buildSkillboxHomeLayout(homeRoot)
  const library = new RuntimeLibraryService(layout.library)
  const linkState = new RuntimeLinkState({ filePath: layout.linksFile })
  return { layout, library, linkState }
}

/** Creates an external skill directory on disk. */
async function writeExternalSkill(
  root: string,
  name: string,
  content = `# ${name}`,
): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), content)
  return dir
}

describe('importSkill', () => {
  it('copies the external skill, preserves its contents and records manifest + lockfile', async () => {
    await withTempDir(async (dir) => {
      const external = path.join(dir, 'external')
      const externalDir = await writeExternalSkill(
        external,
        'my-skill',
        '# My Skill\nSome body text.\n',
      )

      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const { library, linkState } = fixture(path.join(dir, 'home'))

      const result = await importSkill({
        sourceDir: externalDir,
        alias: 'hello',
        repositoryRoot: repoRoot,
        library,
        linkState,
      })

      expect(result.status).toBe('imported')
      expect(result.changed).toBe(true)
      expect(result.alias).toBe('hello')

      const repoCopy = await fs.readFile(path.join(repoRoot, 'skills', 'hello', 'SKILL.md'), 'utf8')
      expect(repoCopy).toBe('# My Skill\nSome body text.\n')

      const sourceCopy = await fs.readFile(path.join(externalDir, 'SKILL.md'), 'utf8')
      expect(sourceCopy).toBe('# My Skill\nSome body text.\n')

      const manifest = await readManifest(repoRoot)
      expect(manifest.skills.hello).toMatchObject({
        source: { type: 'local', path: 'skills/hello' },
      })

      const lockfile = await readLockfile(repoRoot)
      expect(lockfile.skills.hello?.integrity).toBeDefined()
      expect(lockfile.skills.hello?.integrity).toBe(result.integrity)

      const materialized = await library.getRuntimeSkill('hello', 'local')
      expect(materialized.exists).toBe(true)
    })
  })

  it('re-importing an identical alias is a no-op (unchanged)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const externalDir = await writeExternalSkill(path.join(dir, 'external'), 'hello')
      const { library, linkState } = fixture(path.join(dir, 'home'))

      const first = await importSkill({
        sourceDir: externalDir,
        repositoryRoot: repoRoot,
        library,
        linkState,
      })
      expect(first.status).toBe('imported')

      const second = await importSkill({
        sourceDir: externalDir,
        repositoryRoot: repoRoot,
        library,
        linkState,
      })
      expect(second.status).toBe('unchanged')
      expect(second.changed).toBe(false)
    })
  })

  it('replaces an existing external agent copy with a managed link (M6.5)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const skillsRoot = path.join(dir, 'agent-skills', '.claude', 'skills')
      await fs.mkdir(skillsRoot, { recursive: true })

      const adapter = new ClaudeAdapter({ skillsDir: skillsRoot, searchPath: false })
      const externalDir = await writeExternalSkill(
        path.join(dir, 'external'),
        'linked-skill',
        '# old external copy',
      )

      const { library, linkState } = fixture(path.join(dir, 'home'))

      const result = await importSkill({
        sourceDir: externalDir,
        repositoryRoot: repoRoot,
        library,
        linkState,
        linkStrategy: 'copy',
        adapters: new Map([['claude', adapter]]),
        migrateAgents: ['claude'],
      })

      expect(result.status).toBe('imported')
      expect(result.links).toEqual(
        expect.arrayContaining([expect.objectContaining({ agent: 'claude', action: 'created' })]),
      )

      const linkedMeta = await fs.readFile(
        path.join(skillsRoot, 'linked-skill', 'SKILL.md'),
        'utf8',
      )
      expect(linkedMeta).toBe('# old external copy')
    })
  })

  it('surfaces an alias conflict with structured decisions (M6.6)', async () => {
    await withTempDir(async (dir) => {
      const repoRoot = path.join(dir, 'repo')
      await fs.mkdir(repoRoot)
      const { library, linkState } = fixture(path.join(dir, 'home'))

      const sourceA = await writeExternalSkill(path.join(dir, 'a'), 'town', '# town A')
      await importSkill({ sourceDir: sourceA, repositoryRoot: repoRoot, library, linkState })

      const sourceB = await writeExternalSkill(path.join(dir, 'b'), 'town', '# town B different')

      const conflicted = await importSkill({
        sourceDir: sourceB,
        repositoryRoot: repoRoot,
        library,
        linkState,
      })
      expect(conflicted.status).toBe('conflict')
      expect(conflicted.changed).toBe(false)
      expect(conflicted.conflicts?.[0]?.kind).toBe('manifest')
      expect(conflicted.conflicts?.[0]?.decisions.map((d) => d.kind)).toEqual(
        expect.arrayContaining(['use-existing', 'import-incoming']),
      )

      const kept = await fs.readFile(path.join(repoRoot, 'skills', 'town', 'SKILL.md'), 'utf8')
      expect(kept).toBe('# town A')

      const imported = await importSkill(
        { sourceDir: sourceB, repositoryRoot: repoRoot, library, linkState },
        { kind: 'import-incoming' },
      )
      expect(imported.status).toBe('imported')
      expect(await fs.readFile(path.join(repoRoot, 'skills', 'town', 'SKILL.md'), 'utf8')).toBe(
        '# town B different',
      )
    })
  })
})
