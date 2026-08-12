import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../errors.js'
import {
  createSkillSourceResolver,
  fromManifest,
  parse,
  serialize,
  toManifest,
  type CanonicalSkillSource,
} from './index.js'

describe('canonical skill sources', () => {
  it('round-trips every manifest source without dropping fields', () => {
    const sources: readonly CanonicalSkillSource[] = [
      { type: 'github', repo: 'owner/repo', path: 'skills/foo', ref: 'v1.0.0' },
      {
        type: 'git',
        url: 'https://git.example.test/owner/repo.git',
        path: 'skills/foo',
        ref: 'main',
      },
      { type: 'registry', registry: 'example', package: 'owner/package', version: '2.0.0' },
      { type: 'local', path: path.resolve('skills/foo') },
    ]

    for (const source of sources) {
      expect(fromManifest(toManifest(source))).toEqual(source)
    }
  })

  it('parses and serializes canonical expressions for all four source kinds', () => {
    expect(serialize(parse('github:owner/repo@skills/foo#main'))).toBe(
      'github:owner/repo@skills/foo#main',
    )
    expect(serialize(parse('git:https://git.example.test/owner/repo.git@skills/foo#main'))).toBe(
      'git:https://git.example.test/owner/repo.git@skills/foo#main',
    )
    expect(serialize(parse('git:git@git.example.test:owner/repo.git'))).toBe(
      'git:git@git.example.test:owner/repo.git',
    )
    expect(serialize(parse('registry:example/owner/package#2.0.0'))).toBe(
      'registry:example/owner/package#2.0.0',
    )
    expect(serialize(parse('./skills/foo'))).toBe(path.resolve('./skills/foo'))
  })

  it('preserves existing source parsing behaviour while promoting skills.sh to registry', () => {
    expect(parse('https://github.com/Owner/Repo/tree/main/skills/foo')).toEqual({
      type: 'github',
      repo: 'owner/repo',
      path: 'skills/foo',
      ref: 'main',
    })
    expect(parse('skills.sh/owner/package#1.2.3')).toEqual({
      type: 'registry',
      registry: 'skills.sh',
      package: 'owner/package',
      version: '1.2.3',
    })
  })

  it('reports an unsupported capability with a stable source error', () => {
    const resolver = createSkillSourceResolver()
    expect(() =>
      resolver.adapterFor({ type: 'git', url: 'https://git.example.test/repo.git' }),
    ).toThrowError(
      expect.objectContaining({
        code: ErrorCode.SOURCE_UNSUPPORTED,
        context: { sourceType: 'git', capability: 'resolve' },
      }),
    )
  })
})
