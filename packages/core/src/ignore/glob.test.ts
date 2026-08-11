import { describe, expect, it } from 'vitest'
import { compileIgnoreGlob, matchIgnoreGlob } from './glob.js'

function matches(pattern: string, relativePath: string, raw = pattern): boolean {
  const compiled = compileIgnoreGlob(raw)
  expect(compiled).not.toBeNull()
  return matchIgnoreGlob(compiled!, relativePath)
}

describe('compileIgnoreGlob', () => {
  it('matches basename patterns at any depth', () => {
    expect(matches('*.key', 'id.pem.key')).toBe(true)
    expect(matches('*.key', 'credentials/keys/svc.key')).toBe(true)
    expect(matches('*.key', 'svc.txt')).toBe(false)
  })

  it('matches directory-only patterns and their contents', () => {
    expect(matches('secrets/', 'secrets/db.env')).toBe(true)
    expect(matches('secrets/', 'secrets')).toBe(true)
    expect(matches('secrets/', 'config/secrets/token')).toBe(true)
    expect(matches('secrets/', 'public/readme.md')).toBe(false)
  })

  it('anchors patterns containing a slash to the root', () => {
    expect(matches('references/internal/', 'references/internal/doc.md')).toBe(true)
    expect(matches('references/internal', 'config/internal/doc.md')).toBe(false)
    expect(matches('docs/guide.md', 'docs/guide.md')).toBe(true)
    expect(matches('docs/guide.md', 'a/docs/guide.md')).toBe(false)
  })

  it('supports `?` single-character wildcards', () => {
    expect(matches('file?.txt', 'file1.txt')).toBe(true)
    expect(matches('file?.txt', 'file12.txt')).toBe(false)
  })

  it('supports `**` between slashes (zero or more directories)', () => {
    expect(matches('a/**/b', 'a/b')).toBe(true)
    expect(matches('a/**/b', 'a/x/b')).toBe(true)
    expect(matches('a/**/b', 'a/x/y/b')).toBe(true)
    expect(matches('a/**/b', 'a/x/c')).toBe(false)
  })

  it('supports trailing `/**` matching everything inside', () => {
    expect(matches('private/**', 'private/a.txt')).toBe(true)
    expect(matches('private/**', 'private/deep/b.txt')).toBe(true)
    expect(matches('private/**', 'shared/deep/b.txt')).toBe(false)
  })

  it('supports leading `**/` matching in all directories', () => {
    expect(matches('**/foo', 'foo')).toBe(true)
    expect(matches('**/foo', 'a/b/foo')).toBe(true)
  })

  it('escapes regex metacharacters in patterns', () => {
    expect(matches('a.b', 'aXb')).toBe(false)
    expect(matches('a.b', 'a.b')).toBe(true)
    expect(matches('weird(1).txt', 'weird(1).txt')).toBe(true)
  })

  it('handles `?` and `*` after an escaped backslash literally', () => {
    expect(matches('\\*.key', '*.key')).toBe(true)
    expect(matches('\\*.key', 'x.key')).toBe(false)
  })

  it('returns null for empty patterns', () => {
    expect(compileIgnoreGlob('')).toBeNull()
  })

  it('treats a lone `/` as matching everything (no-op)', () => {
    const compiled = compileIgnoreGlob('/')
    expect(compiled).not.toBeNull()
    expect(matchIgnoreGlob(compiled!, 'anything/at/all')).toBe(true)
  })
})
