import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import {
  githubCloneUrl,
  planRemoteSource,
  remoteCacheKey,
  remoteMaterializeRoot,
} from './source.js'

describe('planRemoteSource', () => {
  it('maps a git source to its URL and ref', () => {
    expect(
      planRemoteSource({ type: 'git', url: 'git@github.com:acme/skills.git', ref: 'v2' }),
    ).toEqual({ url: 'git@github.com:acme/skills.git', ref: 'v2', key: expect.any(String) })
  })

  it('maps a git source without a ref (no unused key)', () => {
    const plan = planRemoteSource({ type: 'git', url: 'https://example.com/a.git' })
    expect(plan).toMatchObject({ url: 'https://example.com/a.git' })
    expect(plan?.ref).toBeUndefined()
  })

  it('derives a public https clone URL for github sources', () => {
    const plan = planRemoteSource({
      type: 'github',
      repo: 'vercel-labs/agent-skills',
      path: 'labs/foo',
    })
    expect(plan).toMatchObject({ url: 'https://github.com/vercel-labs/agent-skills.git' })
    expect(plan?.ref).toBeUndefined()
  })

  it('keeps an already-qualified github repo URL', () => {
    expect(githubCloneUrl('https://github.com/org/repo')).toBe('https://github.com/org/repo')
    expect(githubCloneUrl('git@github.com:org/repo.git')).toBe('git@github.com:org/repo.git')
  })

  it('returns undefined for registry and local sources', () => {
    expect(
      planRemoteSource({ type: 'registry', registry: 'skills.sh', package: 'org/skill' }),
    ).toBeUndefined()
    expect(planRemoteSource({ type: 'local', path: './skills/foo' })).toBeUndefined()
  })
})

describe('remoteCacheKey', () => {
  it('is deterministic per URL and stable across calls', () => {
    expect(remoteCacheKey('https://example.com/a.git')).toBe(
      remoteCacheKey('https://example.com/a.git'),
    )
    expect(remoteCacheKey('https://example.com/a.git')).not.toBe(
      remoteCacheKey('https://example.com/b.git'),
    )
  })
})

describe('remoteMaterializeRoot', () => {
  it('resolves to the home cache/git under the library root', () => {
    const root = remoteMaterializeRoot('/home/user/.skillbox/library')
    expect(root).toBe(path.join('/home/user/.skillbox', 'cache', 'git'))
  })
})
