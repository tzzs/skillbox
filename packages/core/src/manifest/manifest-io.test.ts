import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { ErrorCode } from '../errors.js'
import { isSkillboxError } from '../errors.js'
import { withTempDir } from '../fs/test-utils.js'
import { readManifest, serializeManifest, writeManifest } from './manifest-io.js'
import { emptyManifest, type SkillboxManifest } from './schema.js'

describe('readManifest', () => {
  it('throws MANIFEST_NOT_FOUND when the file is missing', async () => {
    await withTempDir(async (dir) => {
      try {
        await readManifest(dir)
        expect.unreachable('expected readManifest to throw')
      } catch (error) {
        expect(isSkillboxError(error)).toBe(true)
        expect(error).toMatchObject({ code: ErrorCode.MANIFEST_NOT_FOUND })
      }
    })
  })

  it('throws INVALID_MANIFEST for invalid YAML', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox.yaml'), 'version: 1:\n  - not: closed', 'utf8')
      await expect(readManifest(dir)).rejects.toMatchObject({
        code: ErrorCode.INVALID_MANIFEST,
      })
    })
  })

  it('throws INVALID_MANIFEST for a non-mapping document', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox.yaml'), '- a\n- b\n', 'utf8')
      await expect(readManifest(dir)).rejects.toMatchObject({
        code: ErrorCode.INVALID_MANIFEST,
      })
    })
  })

  it('throws INVALID_MANIFEST when version is missing or not an integer', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox.yaml'), 'skills: {}\n', 'utf8')
      await expect(readManifest(dir)).rejects.toMatchObject({
        code: ErrorCode.INVALID_MANIFEST,
      })
    })
  })

  it('throws UNSUPPORTED_MANIFEST_VERSION for a newer version', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox.yaml'), 'version: 2\nskills: {}\n', 'utf8')
      await expect(readManifest(dir)).rejects.toMatchObject({
        code: ErrorCode.UNSUPPORTED_MANIFEST_VERSION,
        context: { version: 2 },
      })
    })
  })

  it('throws INVALID_MANIFEST for a schema-invalid document', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox.yaml'), 'version: 1\nskills: not-a-map\n', 'utf8')
      try {
        await readManifest(dir)
        expect.unreachable('expected readManifest to throw')
      } catch (error) {
        expect(isSkillboxError(error)).toBe(true)
        expect(error).toMatchObject({ code: ErrorCode.INVALID_MANIFEST })
        if (isSkillboxError(error) && Array.isArray(error.context?.issues)) {
          expect(error.context.issues.length).toBeGreaterThan(0)
        }
      }
    })
  })

  it('reads a valid manifest back', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'skillbox.yaml'),
        [
          'version: 1',
          'name: demo',
          'skills:',
          '  react:',
          '    source:',
          '      type: github',
          '      repo: a/b',
          '',
        ].join('\n'),
        'utf8',
      )
      const manifest = await readManifest(dir)
      expect(manifest.version).toBe(1)
      expect(manifest.name).toBe('demo')
      expect(manifest.skills['react']?.source).toEqual({ type: 'github', repo: 'a/b' })
    })
  })
})

describe('serializeManifest', () => {
  it('serializes the minimal manifest deterministically', () => {
    const serialized = serializeManifest(emptyManifest())
    expect(serialized).toMatchSnapshot()
    expect(serialized.endsWith('\n')).toBe(true)
  })

  it('is byte-identical across calls', () => {
    const manifest: SkillboxManifest = {
      version: 1,
      name: 'demo',
      skills: {
        a: { source: { type: 'github', repo: 'x/y' }, enabled: true },
      },
    }
    expect(serializeManifest(manifest)).toBe(serializeManifest(manifest))
  })
})

describe('writeManifest', () => {
  it('writes UTF-8, LF line endings and two-space indentation', async () => {
    await withTempDir(async (dir) => {
      const manifest = emptyManifest()
      await writeManifest(dir, manifest)
      const bytes = await fs.readFile(path.join(dir, 'skillbox.yaml'))
      expect(bytes).not.toContain(Buffer.from('  \r\n'))
      const text = bytes.toString('utf8')
      expect(text).toBe('version: 1\nskills: {}\n')
    })
  })

  it('ensures a .gitattributes fixture exists and never overwrites an existing one', async () => {
    await withTempDir(async (dir) => {
      await writeManifest(dir, emptyManifest())
      const generated = await fs.readFile(path.join(dir, '.gitattributes'), 'utf8')
      expect(generated).toContain('* text=auto eol=lf')

      const custom = '*.md text eol=crlf\n'
      await fs.writeFile(path.join(dir, '.gitattributes'), custom, 'utf8')
      await writeManifest(dir, emptyManifest())
      expect(await fs.readFile(path.join(dir, '.gitattributes'), 'utf8')).toBe(custom)
    })
  })

  it('is deterministic: writing the same input twice yields identical bytes', async () => {
    await withTempDir(async (dir) => {
      const manifest: SkillboxManifest = {
        version: 1,
        name: 'demo',
        skills: {
          one: { source: { type: 'local', path: 'skills/one' } },
          two: {
            source: { type: 'github', repo: 'a/b', ref: 'main' },
            mode: 'managed',
            agents: ['codex'],
          },
        },
      }
      await writeManifest(dir, manifest)
      const first = await fs.readFile(path.join(dir, 'skillbox.yaml'))
      await writeManifest(dir, manifest)
      const second = await fs.readFile(path.join(dir, 'skillbox.yaml'))
      expect(second).toEqual(first)
    })
  })

  it('round-trips: write then read returns an equivalent manifest', async () => {
    await withTempDir(async (dir) => {
      const manifest: SkillboxManifest = {
        version: 1,
        name: 'demo',
        settings: { defaultAgents: ['claude'] },
        skills: {
          a: { source: { type: 'local', path: 'skills/a' } },
        },
      }
      await writeManifest(dir, manifest)
      const readBack = await readManifest(dir)
      expect(readBack).toEqual(manifest)
    })
  })
})
