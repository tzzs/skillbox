import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { withTempDir } from '../fs/test-utils.js'
import { loadSkillboxIgnore, SkillboxIgnore } from './skillbox-ignore.js'

describe('SkillboxIgnore', () => {
  it('ignores comments, blank lines and unknown scopes', () => {
    const matcher = SkillboxIgnore.fromText(
      ['# a comment', '', '  ', '*.key', 'unknown-scope: cache/', 'scan: secrets/'].join('\n'),
    )
    expect(matcher.ruleCount).toBe(2)
    expect(matcher.matches('a/b.key')).toBe(true)
    expect(matcher.matches('cache/x')).toBe(false)
  })

  it('uses last-match-wins semantics', () => {
    const matcher = SkillboxIgnore.fromText(['*.key', '!keep.key'].join('\n'))
    expect(matcher.matches('secret.key')).toBe(true)
    expect(matcher.matches('keep.key')).toBe(false)
  })

  it('supports re-inclusion after a directory pattern', () => {
    const matcher = SkillboxIgnore.fromText(['secrets/', '!secrets/readme.md'].join('\n'))
    expect(matcher.matches('secrets/db.env')).toBe(true)
    expect(matcher.matches('secrets/readme.md')).toBe(false)
  })

  it('matches a `.gitignore` example from the spec', () => {
    const text = ['foo/', '*.key', '!important.key'].join('\n')
    const matcher = SkillboxIgnore.fromText(text)
    expect(matcher.matches('foo/a.txt')).toBe(true)
    expect(matcher.matches('nested/foo/a.txt')).toBe(true)
    expect(matcher.matches('svc.key')).toBe(true)
    expect(matcher.matches('important.key')).toBe(false)
  })

  it('applies scoped rules only to their workflow scope', () => {
    const matcher = SkillboxIgnore.fromText(
      ['*.pem', 'scan: secrets/', 'sync: vendor/', 'backup: cache/'].join('\n'),
    )
    expect(matcher.matches('cert.pem')).toBe(true)
    expect(matcher.matches('secrets/x', { scope: 'scan' })).toBe(true)
    expect(matcher.matches('secrets/x', { scope: 'sync' })).toBe(false)
    expect(matcher.matches('secrets/x')).toBe(false)
    expect(matcher.matches('vendor/y', { scope: 'sync' })).toBe(true)
    expect(matcher.matches('cache/c', { scope: 'backup' })).toBe(true)
  })

  it('supports `scan: !pattern` negation syntax', () => {
    const matcher = SkillboxIgnore.fromText(
      ['scan: secrets/', 'scan: !secrets/public.env'].join('\n'),
    )
    expect(matcher.matches('secrets/db.env', { scope: 'scan' })).toBe(true)
    expect(matcher.matches('secrets/public.env', { scope: 'scan' })).toBe(false)
  })

  it('normalizes backslashes and ./ prefixes', () => {
    const matcher = SkillboxIgnore.fromText('docs/\n'.concat(''))
    expect(matcher.matches('./docs/a.md')).toBe(true)
    expect(matcher.matches('docs\\a.md')).toBe(true)
  })

  it('an empty matcher ignores nothing', () => {
    const matcher = SkillboxIgnore.empty()
    expect(matcher.ruleCount).toBe(0)
    expect(matcher.matches('anything')).toBe(false)
  })
})

describe('loadSkillboxIgnore', () => {
  it('loads rules from <root>/.skillboxignore', async () => {
    await withTempDir(async (root) => {
      await fs.writeFile(path.join(root, '.skillboxignore'), '*.key\nscan: .env\n')
      const matcher = await loadSkillboxIgnore(root)
      expect(matcher.matches('a/b.key')).toBe(true)
      expect(matcher.matches('.env', { scope: 'scan' })).toBe(true)
    })
  })

  it('returns an empty matcher when the file is missing', async () => {
    await withTempDir(async (root) => {
      const matcher = await loadSkillboxIgnore(root)
      expect(matcher.ruleCount).toBe(0)
      expect(matcher.matches('x.key')).toBe(false)
    })
  })
})
