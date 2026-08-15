import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorCode, isSkillboxError } from '../errors.js'
import {
  fromManifestSource,
  normalizeSourceString,
  parseSource,
  sourceToString,
  toManifestSource,
} from './source.js'
import type { NormalizedSource } from './types.js'

function githubOf(input: string): Extract<NormalizedSource, { type: 'github' }> {
  const source = parseSource(input)
  if (source.type !== 'github') {
    throw new Error(`expected a github source, got ${source.type}`)
  }
  return source
}

describe('parseSource', () => {
  it('parses the github: scheme form', () => {
    expect(parseSource('github:vercel-labs/agent-skills')).toEqual({
      type: 'github',
      repo: 'vercel-labs/agent-skills',
    })
  })

  it('parses the https://github.com URL form', () => {
    expect(parseSource('https://github.com/vercel-labs/agent-skills')).toEqual({
      type: 'github',
      repo: 'vercel-labs/agent-skills',
    })
  })

  it('strips .git suffix and trailing slashes', () => {
    expect(githubOf('https://github.com/org/repo.git/').repo).toBe('org/repo')
  })

  it('normalizes owner/repo to lowercase (case-insensitive sources)', () => {
    expect(githubOf('GitHub:Vercel-Labs/Agent-Skills').repo).toBe('vercel-labs/agent-skills')
  })

  it('parses the bare org/repo shorthand (MVP M14.5)', () => {
    expect(parseSource('vercel-labs/agent-skills')).toEqual({
      type: 'github',
      repo: 'vercel-labs/agent-skills',
    })
  })

  it('parses org/repo@path with a nested skill path', () => {
    expect(parseSource('vercel-labs/agent-skills@react-best-practices')).toEqual({
      type: 'github',
      repo: 'vercel-labs/agent-skills',
      path: 'react-best-practices',
    })
    expect(parseSource('github:org/repo@skills/foo/deep')).toEqual({
      type: 'github',
      repo: 'org/repo',
      path: 'skills/foo/deep',
    })
  })

  it('parses org/repo#ref pins and combined path+ref', () => {
    expect(parseSource('github:org/repo#main')).toEqual({
      type: 'github',
      repo: 'org/repo',
      ref: 'main',
    })
    expect(parseSource('org/repo@skills/foo#v1.2.0')).toEqual({
      type: 'github',
      repo: 'org/repo',
      path: 'skills/foo',
      ref: 'v1.2.0',
    })
  })

  it('parses github tree/blob URLs into ref + path', () => {
    expect(parseSource('https://github.com/org/repo/tree/main/skills/foo')).toEqual({
      type: 'github',
      repo: 'org/repo',
      ref: 'main',
      path: 'skills/foo',
    })
    expect(parseSource('https://github.com/org/repo/blob/v1/SKILL.md')).toEqual({
      type: 'github',
      repo: 'org/repo',
      ref: 'v1',
      path: 'SKILL.md',
    })
  })

  it('parses skills.sh package expressions', () => {
    expect(parseSource('skills.sh/react-best-practices')).toEqual({
      type: 'skills-sh',
      package: 'react-best-practices',
    })
    expect(parseSource('skills.sh/vercel-labs/agent-skills@skills/foo')).toEqual({
      type: 'skills-sh',
      package: 'vercel-labs/agent-skills',
      path: 'skills/foo',
    })
    expect(parseSource('https://skills.sh/foo#1.2.0')).toEqual({
      type: 'skills-sh',
      package: 'foo',
      version: '1.2.0',
    })
  })

  it('resolves local relative paths against cwd', () => {
    expect(parseSource('./my-skills')).toEqual({
      type: 'local',
      path: path.resolve('./my-skills'),
    })
    expect(parseSource('../shared/skills')).toEqual({
      type: 'local',
      path: path.resolve('../shared/skills'),
    })
  })

  it('keeps absolute paths as local sources', () => {
    expect(parseSource('/home/user/skills/foo')).toEqual({
      type: 'local',
      path: path.resolve('/home/user/skills/foo'),
    })
    expect(parseSource('C:\\Users\\User\\skills\\my-code-review')).toEqual({
      type: 'local',
      path: path.resolve('C:\\Users\\User\\skills\\my-code-review'),
    })
    expect(parseSource('C:/Users/User/skills/foo')).toEqual({
      type: 'local',
      path: path.resolve('C:/Users/User/skills/foo'),
    })
  })

  it('rejects empty and whitespace-only input with SOURCE_INVALID', () => {
    for (const input of ['', '   ']) {
      let caught: unknown
      try {
        parseSource(input)
      } catch (error) {
        caught = error
      }
      expect(isSkillboxError(caught)).toBe(true)
      expect(caught).toMatchObject({ code: ErrorCode.SOURCE_INVALID })
    }
  })

  it('rejects unparseable input with SOURCE_INVALID', () => {
    for (const input of ['foo', 'foo/', 'org/', 'github:', 'skills.sh/', 'foo#bar']) {
      let caught: unknown
      try {
        parseSource(input)
      } catch (error) {
        caught = error
      }
      expect(isSkillboxError(caught)).toBe(true)
      expect(caught).toMatchObject({ code: ErrorCode.SOURCE_INVALID, context: { input } })
    }
  })

  it('rejects known-but-unsupported schemes with SOURCE_UNSUPPORTED', () => {
    for (const input of ['ssh:git@example.com:org/repo.git', 'file:/tmp/skill']) {
      let caught: unknown
      try {
        parseSource(input)
      } catch (error) {
        caught = error
      }
      expect(isSkillboxError(caught)).toBe(true)
      expect(caught).toMatchObject({ code: ErrorCode.SOURCE_UNSUPPORTED })
    }
  })

  it('parses gitlab:/bitbucket: host shorthands as git sources', () => {
    expect(parseSource('gitlab:org/repo')).toEqual({
      type: 'git',
      url: 'https://gitlab.com/org/repo',
    })
    expect(parseSource('gitlab:org/repo#main')).toEqual({
      type: 'git',
      url: 'https://gitlab.com/org/repo',
      ref: 'main',
    })
    expect(parseSource('bitbucket:org/repo.git')).toEqual({
      type: 'git',
      url: 'https://bitbucket.org/org/repo.git',
    })
  })

  it('parses generic git sources (git: URL and scp-style)', () => {
    expect(parseSource('git:https://git.example.com/org/repo.git')).toEqual({
      type: 'git',
      url: 'https://git.example.com/org/repo.git',
    })
    expect(parseSource('git:https://git.example.com/org/repo.git#main')).toEqual({
      type: 'git',
      url: 'https://git.example.com/org/repo.git',
      ref: 'main',
    })
    expect(parseSource('git@git.example.com:org/repo.git')).toEqual({
      type: 'git',
      url: 'git@git.example.com:org/repo.git',
    })
    expect(parseSource('git@git.example.com:org/repo.git#v1.0.0')).toEqual({
      type: 'git',
      url: 'git@git.example.com:org/repo.git',
      ref: 'v1.0.0',
    })
  })

  it('round-trips git sources through string / manifest / normalized forms', () => {
    const normalized = parseSource('git:https://git.example.com/org/repo.git#main')
    expect(sourceToString(normalized)).toBe('git:https://git.example.com/org/repo.git#main')
    const manifest = toManifestSource(normalized)
    expect(manifest).toEqual({
      type: 'git',
      url: 'https://git.example.com/org/repo.git',
      ref: 'main',
    })
    expect(fromManifestSource(manifest)).toEqual(normalized)
    expect(normalizeSourceString('git:https://git.example.com/org/repo.git#main')).toBe(
      'git:https://git.example.com/org/repo.git#main',
    )
  })

  it('rejects unsupported github.com URL shapes', () => {
    for (const input of [
      'https://github.com/org/repo/issues/1',
      'https://github.com/org/repo/tree/main',
      'https://github.com/org',
    ]) {
      expect(() => parseSource(input)).toThrowError(
        expect.objectContaining({ code: ErrorCode.SOURCE_INVALID }),
      )
    }
  })

  it('rejects path traversal in skill paths', () => {
    for (const input of ['org/repo@../evil', 'org/repo@skills/../../evil', 'skills.sh/foo@..']) {
      let caught: unknown
      try {
        parseSource(input)
      } catch (error) {
        caught = error
      }
      expect(caught).toMatchObject({ code: ErrorCode.SOURCE_INVALID })
    }
  })

  it('normalizes backslash paths inside github expressions to forward slashes', () => {
    expect(parseSource('org/repo@skills\\foo').path).toBe('skills/foo')
  })
})

describe('normalizeSourceString / sourceToString', () => {
  it('reduces equivalent inputs to the same canonical string', () => {
    const equivalents = [
      'github:vercel-labs/agent-skills',
      'https://github.com/vercel-labs/agent-skills',
      'https://github.com/Vercel-Labs/Agent-Skills.git',
      'vercel-labs/agent-skills',
    ]
    for (const input of equivalents) {
      expect(normalizeSourceString(input)).toBe('github:vercel-labs/agent-skills')
    }
  })

  it('round-trips github path and ref through the canonical form', () => {
    const canonical = normalizeSourceString('https://github.com/org/repo/tree/main/skills/foo')
    expect(canonical).toBe('github:org/repo@skills/foo#main')
    expect(sourceToString(parseSource(canonical))).toBe(canonical)
  })

  it('round-trips skills.sh sources', () => {
    const canonical = normalizeSourceString('https://skills.sh/pkg@skills/foo#1.2.0')
    expect(canonical).toBe('skills.sh/pkg@skills/foo#1.2.0')
    expect(sourceToString(parseSource(canonical))).toBe(canonical)
  })

  it('serializes local sources as the absolute path', () => {
    expect(sourceToString(parseSource('./dir'))).toBe(path.resolve('./dir'))
  })
})

describe('toManifestSource / fromManifestSource', () => {
  it('maps a normalized github source onto the manifest github schema', () => {
    const normalized = parseSource('org/repo@skills/foo#main') as NormalizedSource
    expect(toManifestSource(normalized)).toEqual({
      type: 'github',
      repo: 'org/repo',
      path: 'skills/foo',
      ref: 'main',
    })
    expect(fromManifestSource(toManifestSource(normalized))).toEqual(normalized)
  })

  it('falls back to branch as ref in the manifest form', () => {
    expect(toManifestSource({ type: 'github', repo: 'org/repo', branch: 'main' })).toEqual({
      type: 'github',
      repo: 'org/repo',
      ref: 'main',
    })
  })

  it('maps skills-sh onto the manifest registry schema and back', () => {
    const normalized = parseSource('skills.sh/foo#1.0.0') as NormalizedSource
    expect(toManifestSource(normalized)).toEqual({
      type: 'registry',
      registry: 'skills.sh',
      package: 'foo',
      version: '1.0.0',
    })
    expect(fromManifestSource(toManifestSource(normalized))).toEqual(normalized)
  })

  it('maps local sources through unchanged', () => {
    const normalized = parseSource('./dir') as NormalizedSource
    expect(toManifestSource(normalized)).toEqual({ type: 'local', path: path.resolve('./dir') })
    expect(fromManifestSource(toManifestSource(normalized))).toEqual(normalized)
  })

  it('returns null only for non-skills.sh registry sources', () => {
    // `git` sources gained a registry representation (GitSourceProvider).
    expect(
      fromManifestSource({ type: 'git', url: 'https://example.com/r.git', path: 'skills/hello' }),
    ).toEqual({
      type: 'git',
      url: 'https://example.com/r.git',
      path: 'skills/hello',
    })
    expect(fromManifestSource({ type: 'registry', registry: 'other', package: 'pkg' })).toBeNull()
  })
})
