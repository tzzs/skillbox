import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../errors.js'
import { withTempDir } from '../fs/test-utils.js'
import { ProviderRegistry } from '../registry/index.js'
import {
  createSkillSourceResolver,
  createDefaultSkillSourceResolver,
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

  it('materializes a git source path as the selected skill root', async () => {
    await withTempDir(async (dir) => {
      const fixture = path.join(dir, 'fixture')
      await fs.mkdir(path.join(fixture, 'skills', 'foo'), { recursive: true })
      await fs.writeFile(path.join(fixture, 'skills', 'foo', 'SKILL.md'), '# Foo\n')
      const git = {
        materialize: async ({ targetDir }: { targetDir: string }) => {
          await fs.cp(fixture, targetDir, { recursive: true })
          return { cloned: true, headRev: 'sha' }
        },
        revParse: async () => 'sha',
      }
      const resolver = createDefaultSkillSourceResolver({
        registry: new ProviderRegistry(),
        git: git as never,
        temporaryRoot: path.join(dir, 'tmp'),
      })
      const target = path.join(dir, 'target')
      const source = {
        type: 'git' as const,
        url: 'https://git.example.test/skills.git',
        path: 'skills/foo',
      }
      await resolver.adapterFor(source, 'materialize').materialize?.(source, 'sha', target)
      await expect(fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).resolves.toBe('# Foo\n')
      await expect(fs.stat(path.join(target, 'skills', 'foo'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  it('keeps unknown registry names on the unified SOURCE_UNSUPPORTED contract', async () => {
    const resolver = createDefaultSkillSourceResolver({ registry: new ProviderRegistry() })
    const source = { type: 'registry' as const, registry: 'unknown.example', package: 'foo' }
    await expect(resolver.adapterFor(source, 'latest').latest?.(source)).rejects.toMatchObject({
      code: ErrorCode.SOURCE_UNSUPPORTED,
      context: { sourceType: 'registry', capability: 'provider dispatch' },
    })
  })
})
