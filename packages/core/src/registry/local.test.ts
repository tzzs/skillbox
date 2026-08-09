import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withTempDir } from '../fs/test-utils.js'
import { computeSkillIntegrity } from '../integrity/index.js'
import { LocalProvider, LOCAL_REVISION } from './local.js'

async function seedSkill(
  dir: string,
  name: string,
  description: string | undefined,
): Promise<void> {
  const skillDir = path.join(dir, name)
  await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true })
  const manifest: Record<string, unknown> = { version: 1, skills: {} }
  if (description !== undefined) {
    manifest.description = description
  }
  await fs.writeFile(
    path.join(skillDir, 'skillbox.yaml'),
    `version: 1\n${description !== undefined ? `description: ${description}\n` : ''}skills: {}\n`,
  )
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\n`)
  await fs.writeFile(path.join(skillDir, 'scripts', 'check.sh'), '#!/bin/sh\necho hi\n')
}

describe('LocalProvider.search', () => {
  it('lists skill subdirectories with their manifest identity', async () => {
    await withTempDir(async (dir) => {
      await seedSkill(dir, 'alpha', 'Alphabet helper')
      await seedSkill(dir, 'beta', undefined)
      const provider = new LocalProvider({ root: dir })
      const results = await provider.search('')
      expect(results).toEqual([
        {
          name: 'alpha',
          source: path.join(dir, 'alpha'),
          popularity: 0,
          security: 'unknown',
          description: 'Alphabet helper',
        },
        {
          name: 'beta',
          source: path.join(dir, 'beta'),
          popularity: 0,
          security: 'unknown',
          description: '',
        },
      ])
    })
  })

  it('skips dot-directories (.git, .skillbox, .claude — tooling internals)', async () => {
    await withTempDir(async (dir) => {
      await seedSkill(dir, 'alpha', 'Alphabet helper')
      await fs.mkdir(path.join(dir, '.git'), { recursive: true })
      await fs.mkdir(path.join(dir, '.skillbox'), { recursive: true })
      const provider = new LocalProvider({ root: dir })
      const results = await provider.search('')
      expect(results.map((result) => result.name)).toEqual(['alpha'])
    })
  })

  it('filters by query against name and description (case-insensitive)', async () => {
    await withTempDir(async (dir) => {
      await seedSkill(dir, 'react-playbook', 'React best practices')
      await seedSkill(dir, 'rust-playbook', 'Rust tips')
      const provider = new LocalProvider({ root: dir })
      const results = await provider.search('REACT')
      expect(results.map((result) => result.name)).toEqual(['react-playbook'])
    })
  })

  it('returns an empty list for a missing root', async () => {
    const provider = new LocalProvider({ root: path.join(process.cwd(), 'does-not-exist-xyz') })
    expect(await provider.search('anything')).toEqual([])
  })

  it('does not descend deeper than one level (shallow)', async () => {
    await withTempDir(async (dir) => {
      await seedSkill(dir, 'top', undefined)
      await fs.mkdir(path.join(dir, 'top', 'nested', 'deep'), { recursive: true })
      await fs.writeFile(path.join(dir, 'top', 'nested', 'deep', 'SKILL.md'), 'deep\n')
      const provider = new LocalProvider({ root: dir })
      const results = await provider.search('deep')
      expect(results).toEqual([])
    })
  })
})

describe('LocalProvider.resolve', () => {
  it('pins revision "local" and computes the canonical integrity', async () => {
    await withTempDir(async (dir) => {
      await seedSkill(dir, 'alpha', 'Alphabet helper')
      const provider = new LocalProvider()
      const source = { type: 'local' as const, path: path.join(dir, 'alpha') }
      const resolved = await provider.resolve(source)
      expect(resolved.source).toEqual(source)
      expect(resolved.revision).toBe(LOCAL_REVISION)
      expect(resolved.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(resolved.integrity).toBe(await computeSkillIntegrity(source.path))
    })
  })

  it('reports REGISTRY_NOT_FOUND for a missing directory', async () => {
    const provider = new LocalProvider()
    let caught: unknown
    try {
      await provider.resolve({ type: 'local', path: path.join(process.cwd(), 'nope-xyz') })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'REGISTRY_NOT_FOUND' })
  })

  it('rejects non-local sources with SOURCE_UNSUPPORTED', async () => {
    const provider = new LocalProvider()
    let caught: unknown
    try {
      await provider.resolve({ type: 'github', repo: 'org/repo' })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'SOURCE_UNSUPPORTED' })
  })
})

describe('LocalProvider.download', () => {
  it('copies the skill directory contents into the target', async () => {
    await withTempDir(async (dir) => {
      await seedSkill(dir, 'alpha', 'Alphabet helper')
      const provider = new LocalProvider()
      const target = path.join(dir, 'installed')
      await provider.download(
        { type: 'local', path: path.join(dir, 'alpha') },
        LOCAL_REVISION,
        target,
      )
      expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('# alpha\n')
      expect(await fs.readFile(path.join(target, 'scripts', 'check.sh'), 'utf8')).toBe(
        '#!/bin/sh\necho hi\n',
      )
      // the copied tree has the same canonical integrity as the source
      expect(await computeSkillIntegrity(target)).toBe(
        await computeSkillIntegrity(path.join(dir, 'alpha')),
      )
    })
  })

  it('reports REGISTRY_NOT_FOUND for a missing source directory', async () => {
    await withTempDir(async (dir) => {
      const provider = new LocalProvider()
      let caught: unknown
      try {
        await provider.download(
          { type: 'local', path: path.join(dir, 'missing') },
          LOCAL_REVISION,
          path.join(dir, 'target'),
        )
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'REGISTRY_NOT_FOUND' })
    })
  })
})

describe('LocalProvider.getLatestRevision', () => {
  it('is always "local"', async () => {
    await withTempDir(async (dir) => {
      await seedSkill(dir, 'alpha', 'Alphabet helper')
      const provider = new LocalProvider()
      expect(
        await provider.getLatestRevision({ type: 'local', path: path.join(dir, 'alpha') }),
      ).toBe(LOCAL_REVISION)
    })
  })
})
