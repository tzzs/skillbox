import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import {
  INTEGRITY_HASH_LENGTH,
  INTEGRITY_PREFIX,
  buildCanonicalManifest,
  computeIntegrityFromEntries,
  computeSkillIntegrity,
  hashFileContent,
  normalizeLineEndings,
  normalizeRelativePath,
} from './canonical-hash.js'

describe('normalizeLineEndings', () => {
  it('collapses CRLF to LF', () => {
    const crlf = Buffer.from('a\r\nb\r\nc', 'utf8')
    expect(normalizeLineEndings(crlf).toString('utf8')).toBe('a\nb\nc')
  })

  it('collapses a lone CR to LF', () => {
    const cr = Buffer.from('a\rb', 'utf8')
    expect(normalizeLineEndings(cr).toString('utf8')).toBe('a\nb')
  })

  it('leaves LF-only text untouched', () => {
    expect(normalizeLineEndings(Buffer.from('a\nb', 'utf8')).toString('utf8')).toBe('a\nb')
  })

  it('leaves binary content (NUL byte) untouched', () => {
    const binary = Buffer.from([0x01, 0x0d, 0x0a, 0x00, 0x0d, 0x0a])
    expect(normalizeLineEndings(binary)).toEqual(Buffer.from([0x01, 0x0d, 0x0a, 0x00, 0x0d, 0x0a]))
  })

  it('handles empty buffers', () => {
    expect(Buffer.from(normalizeLineEndings(new Uint8Array(0)))).toEqual(Buffer.from([]))
  })
})

describe('hashFileContent', () => {
  it('hashes LF and CRLF versions of the same text identically', () => {
    const lf = hashFileContent(Buffer.from('# title\nbody\n', 'utf8'))
    const crlf = hashFileContent(Buffer.from('# title\r\nbody\r\n', 'utf8'))
    expect(crlf).toBe(lf)
  })

  it('hashes different text differently', () => {
    const a = hashFileContent(Buffer.from('abc', 'utf8'))
    const b = hashFileContent(Buffer.from('abd', 'utf8'))
    expect(a).not.toBe(b)
  })
})

describe('normalizeRelativePath', () => {
  it('converts backslashes to forward slashes (windows-style inputs)', () => {
    expect(normalizeRelativePath('references\\foo.md')).toBe('references/foo.md')
    expect(normalizeRelativePath('a\\b\\c.txt')).toBe('a/b/c.txt')
  })

  it('collapses duplicate slashes and strips a leading ./', () => {
    expect(normalizeRelativePath('./a//b/file')).toBe('a/b/file')
  })

  it('keeps posix paths unchanged', () => {
    expect(normalizeRelativePath('a/b/c.txt')).toBe('a/b/c.txt')
  })
})

describe('buildCanonicalManifest', () => {
  it('sorts entries by normalized path and emits path\0hash lines', () => {
    const manifest = buildCanonicalManifest([
      { path: 'SKILL.md', hash: 'h-skill' },
      { path: 'references/b.md', hash: 'h-b' },
      { path: 'references/a.md', hash: 'h-a' },
    ])
    expect(manifest).toBe(
      'SKILL.md\u0000h-skill\nreferences/a.md\u0000h-a\nreferences/b.md\u0000h-b\n',
    )
  })

  it('normalizes separators before sorting', () => {
    const windows = buildCanonicalManifest([
      { path: 'scripts\\setup.sh', hash: 'x' },
      { path: 'SKILL.md', hash: 'y' },
    ])
    const posix = buildCanonicalManifest([
      { path: 'SKILL.md', hash: 'y' },
      { path: 'scripts/setup.sh', hash: 'x' },
    ])
    expect(windows).toBe(posix)
  })
})

describe('computeIntegrityFromEntries', () => {
  it('returns a sha256:<hex> value of the expected length', () => {
    const hash = computeIntegrityFromEntries([{ path: 'SKILL.md', hash: 'a'.repeat(64) }])
    expect(hash.startsWith(INTEGRITY_PREFIX)).toBe(true)
    expect(hash.length).toBe(INTEGRITY_PREFIX.length + INTEGRITY_HASH_LENGTH)
  })

  it('is independent of entry order', () => {
    const entries = [
      { path: 'SKILL.md', hash: 'a' },
      { path: 'ref/b.md', hash: 'b' },
      { path: 'ref/a.md', hash: 'c' },
    ]
    const shuffled = [entries[2]!, entries[0]!, entries[1]!]
    expect(computeIntegrityFromEntries(shuffled)).toBe(computeIntegrityFromEntries(entries))
  })

  it('hashes windows-style and posix-style paths identically', () => {
    const windows = computeIntegrityFromEntries([
      { path: 'scripts\\setup.sh', hash: 'x' },
      { path: 'SKILL.md', hash: 'y' },
    ])
    const posix = computeIntegrityFromEntries([
      { path: 'SKILL.md', hash: 'y' },
      { path: 'scripts/setup.sh', hash: 'x' },
    ])
    expect(windows).toBe(posix)
  })
})

describe('computeSkillIntegrity', () => {
  it('ignores runtime metadata directories (.git, .skillbox)', async () => {
    await withTempDir(async (dir) => {
      const skill = path.join(dir, 'skill')
      await fs.mkdir(path.join(skill, '.git'), { recursive: true })
      await fs.mkdir(path.join(skill, '.skillbox', 'tmp'), { recursive: true })
      await fs.mkdir(path.join(skill, 'references'), { recursive: true })
      await fs.writeFile(path.join(skill, 'SKILL.md'), '# demo\n', 'utf8')
      await fs.writeFile(path.join(skill, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
      await fs.writeFile(path.join(skill, '.skillbox', 'tmp', 'cache.bin'), 'zzz', 'utf8')
      await fs.writeFile(path.join(skill, 'references', 'a.md'), 'a\n', 'utf8')

      const hash = await computeSkillIntegrity(skill)
      expect(hash.startsWith(INTEGRITY_PREFIX)).toBe(true)

      const expected = computeIntegrityFromEntries([
        { path: 'SKILL.md', hash: hashFileContent(Buffer.from('# demo\n', 'utf8')) },
        {
          path: 'references/a.md',
          hash: hashFileContent(Buffer.from('a\n', 'utf8')),
        },
      ])
      expect(hash).toBe(expected)
    })
  })

  it('hashes CRLF content identically to LF content on disk', async () => {
    await withTempDir(async (dir) => {
      const lfSkill = path.join(dir, 'lf')
      const crlfSkill = path.join(dir, 'crlf')
      await fs.mkdir(lfSkill)
      await fs.mkdir(crlfSkill)
      await fs.writeFile(path.join(lfSkill, 'SKILL.md'), '# title\nline two\n', 'utf8')
      await fs.writeFile(path.join(crlfSkill, 'SKILL.md'), '# title\r\nline two\r\n', 'utf8')

      expect(await computeSkillIntegrity(lfSkill)).toBe(await computeSkillIntegrity(crlfSkill))
    })
  })

  it('is stable regardless of directory read order', async () => {
    await withTempDir(async (dir) => {
      const skill = path.join(dir, 'skill')
      await fs.mkdir(path.join(skill, 'a'), { recursive: true })
      await fs.writeFile(path.join(skill, 'SKILL.md'), 'one\n', 'utf8')
      await fs.writeFile(path.join(skill, 'a', 'b.md'), 'two\n', 'utf8')

      const first = await computeSkillIntegrity(skill)
      const second = await computeSkillIntegrity(skill)
      expect(first).toBe(second)
    })
  })

  it('detects the presence of extra files', async () => {
    await withTempDir(async (dir) => {
      const skill = path.join(dir, 'skill')
      await fs.mkdir(skill)
      await fs.writeFile(path.join(skill, 'SKILL.md'), 'x\n', 'utf8')
      const before = await computeSkillIntegrity(skill)
      await fs.writeFile(path.join(skill, 'extra.md'), 'y\n', 'utf8')
      const after = await computeSkillIntegrity(skill)
      expect(after).not.toBe(before)
    })
  })
})
