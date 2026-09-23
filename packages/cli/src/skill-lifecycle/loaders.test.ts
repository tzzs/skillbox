import { describe, expect, it } from 'vitest'
import { ErrorCode, isSkillboxError, SkillboxError, type ManifestSkillSource } from '@skillbox/core'
import {
  createDefaultDiffProvider,
  createDefaultLifecycleProvider,
  createDefaultMergeProvider,
  type DiffCoreDeps,
  type LifecycleCoreDeps,
  type MergeCoreDeps,
} from './loaders.js'

/**
 * Default-provider behavior: the adapters call core's functions with the
 * repository options and map core's real result shapes onto the CLI contracts
 * in `./types.js`. Every fake below is typed as the real core function, so a
 * field rename in core breaks these tests instead of silently passing.
 */

const INPUT = { name: 'react-best-practices', repositoryRoot: '/repo' }

/** Fails the test when a flow reaches a core function it should not use. */
function notCalled(): never {
  throw new Error('unexpected call into @skillbox/core')
}

const untouchedLifecycle: LifecycleCoreDeps = {
  forkSkill: notCalled,
  vendorSkill: notCalled,
  detectManagedModifications: notCalled,
  restoreManagedSkill: notCalled,
}

const untouchedMerge: MergeCoreDeps = {
  mergeSkill: notCalled,
  continueMerge: notCalled,
  abortMerge: notCalled,
}

/** Lifecycle deps with every core call untouched except the fakes given. */
function lifecycleCore(deps: Partial<LifecycleCoreDeps>): LifecycleCoreDeps {
  return { ...untouchedLifecycle, ...deps }
}

function mergeCore(deps: Partial<MergeCoreDeps>): MergeCoreDeps {
  return { ...untouchedMerge, ...deps }
}

describe('createDefaultLifecycleProvider', () => {
  it('maps core forkSkill onto the CLI contract and forwards the options', async () => {
    // The CLI contract prefers `localPath` + a canonical `upstreamSource`
    // expression (SPEC §23) over core's `repositoryPath` + source object.
    let seenOptions: { repositoryRoot: string; homeRoot?: string } | undefined
    const provider = createDefaultLifecycleProvider(
      lifecycleCore({
        forkSkill: async (name, options) => {
          seenOptions = options
          return {
            alias: name,
            mode: 'forked',
            repositoryPath: `skills/${name}`,
            absolutePath: `/repo/skills/${name}`,
            integrity: 'sha256:fork',
            upstream: {
              type: 'github',
              repo: 'vercel-labs/agent-skills',
              path: 'skills/react-best-practices',
            },
            baseRevision: 'abc1234',
            baseIntegrity: 'sha256:base',
            baseSnapshotPath: `/repo/.skillbox/bases/${name}/abc1234`,
            agents: ['claude'],
          }
        },
      }),
    )

    const result = await provider.forkSkill({ ...INPUT, homeRoot: '/home' })
    expect(result).toEqual({
      alias: 'react-best-practices',
      mode: 'forked',
      localPath: 'skills/react-best-practices',
      upstreamSource: 'github:vercel-labs/agent-skills@skills/react-best-practices',
      baseRevision: 'abc1234',
      materializedPath: '/repo/skills/react-best-practices',
      manifestChanged: true,
      lockfileChanged: true,
    })
    // repositoryRoot + homeRoot reach the core call.
    expect(seenOptions?.repositoryRoot).toBe('/repo')
    expect(seenOptions?.homeRoot).toBe('/home')
  })

  it('renders every core upstream source in its canonical form', async () => {
    // `./format.js` and the web UI print `upstreamSource` verbatim, so the
    // strings core's source union produces are pinned here.
    const upstreamSourceFor = async (upstream: ManifestSkillSource): Promise<string> => {
      const provider = createDefaultLifecycleProvider(
        lifecycleCore({
          forkSkill: async (name) => ({
            alias: name,
            mode: 'forked',
            repositoryPath: `skills/${name}`,
            absolutePath: `/repo/skills/${name}`,
            integrity: 'sha256:fork',
            upstream,
            baseRevision: 'abc1234',
            baseIntegrity: 'sha256:base',
            baseSnapshotPath: `/repo/.skillbox/bases/${name}/abc1234`,
            agents: [],
          }),
        }),
      )
      return (await provider.forkSkill(INPUT)).upstreamSource ?? ''
    }

    await expect(
      upstreamSourceFor({
        type: 'github',
        repo: 'vercel-labs/agent-skills',
        path: 'skills/react-best-practices',
      }),
    ).resolves.toBe('github:vercel-labs/agent-skills@skills/react-best-practices')
    await expect(upstreamSourceFor({ type: 'github', repo: 'acme/skills' })).resolves.toBe(
      'github:acme/skills',
    )
    await expect(
      upstreamSourceFor({ type: 'git', url: 'https://example.com/skills.git' }),
    ).resolves.toBe('https://example.com/skills.git')
    await expect(
      upstreamSourceFor({ type: 'registry', registry: 'hub.skillbox.dev', package: '@acme/x' }),
    ).resolves.toBe('hub.skillbox.dev:@acme/x')
    await expect(upstreamSourceFor({ type: 'local', path: 'skills/x' })).resolves.toBe('skills/x')
  })

  it('maps core vendorSkill onto the CLI contract', async () => {
    const provider = createDefaultLifecycleProvider(
      lifecycleCore({
        vendorSkill: async (name) => ({
          alias: name,
          mode: 'vendored',
          repositoryPath: `skills/${name}`,
          absolutePath: `/repo/skills/${name}`,
          integrity: 'sha256:vendored',
          fromFork: true,
          agents: ['claude'],
        }),
      }),
    )

    const result = await provider.vendorSkill(INPUT)
    expect(result).toEqual({
      alias: 'react-best-practices',
      mode: 'vendored',
      localPath: 'skills/react-best-practices',
      // `fromFork` only reports the previous mode; vendoring always clears
      // the upstream tracking.
      upstreamCleared: true,
      manifestChanged: true,
      lockfileChanged: true,
    })
  })

  it('derives { name, modified } from core detectManagedModifications', async () => {
    let seenOptions: { repositoryRoot: string; homeRoot?: string } | undefined
    const modified = createDefaultLifecycleProvider(
      lifecycleCore({
        detectManagedModifications: async (_name, options) => {
          seenOptions = options
          return true
        },
      }),
    )
    const clean = createDefaultLifecycleProvider(
      lifecycleCore({
        detectManagedModifications: async () => false,
      }),
    )

    await expect(modified.detectManagedModifications(INPUT)).resolves.toEqual({
      name: 'react-best-practices',
      modified: true,
    })
    await expect(
      clean.detectManagedModifications({ ...INPUT, homeRoot: '/home' }),
    ).resolves.toEqual({ name: 'react-best-practices', modified: false })
    expect(seenOptions?.repositoryRoot).toBe('/repo')
  })

  it('maps core restoreManagedSkill onto the CLI contract', async () => {
    let seenOptions: { repositoryRoot: string } | undefined
    const provider = createDefaultLifecycleProvider(
      lifecycleCore({
        restoreManagedSkill: async (name, options) => {
          seenOptions = options
          return {
            alias: name,
            mode: 'managed',
            filesRestored: 5,
            integrity: 'sha256:restored',
            revision: 'abc1234',
            unchanged: false,
            materializedPath: `/home/.skillbox/library/managed/${name}`,
            agents: ['claude'],
          }
        },
      }),
    )

    await expect(
      provider.restoreManagedSkill({ name: INPUT.name, repositoryRoot: '/repo' }),
    ).resolves.toEqual({ name: 'react-best-practices', filesRestored: 5 })
    expect(seenOptions?.repositoryRoot).toBe('/repo')
  })
})

describe('createDefaultDiffProvider', () => {
  it('maps core diffSkill onto the CLI contract and forwards the options', async () => {
    let seenOptions: { repositoryRoot: string; homeRoot?: string } | undefined
    const deps: DiffCoreDeps = {
      diffSkill: async (name, options) => {
        seenOptions = options
        return {
          name,
          mode: 'forked',
          views: [
            {
              label: 'Local',
              files: [{ path: 'SKILL.md', status: 'modified', patch: '-a\n+b' }],
            },
          ],
          unchanged: false,
        }
      },
    }
    const result = await createDefaultDiffProvider(deps).diffSkill({ ...INPUT, homeRoot: '/home' })

    expect(result).toEqual({
      name: 'react-best-practices',
      mode: 'forked',
      views: [
        { label: 'Local', files: [{ path: 'SKILL.md', status: 'modified', patch: '-a\n+b' }] },
      ],
      unchanged: false,
    })
    expect(seenOptions?.repositoryRoot).toBe('/repo')
    expect(seenOptions?.homeRoot).toBe('/home')
  })
})

describe('createDefaultMergeProvider', () => {
  it('maps core merge/continue/abort onto the CLI contract', async () => {
    let seenName: string | undefined
    const provider = createDefaultMergeProvider(
      mergeCore({
        mergeSkill: async (name) => {
          seenName = name
          return {
            name,
            conflicts: [{ path: 'src/index.ts', hunks: 2 }],
            filesMerged: 1,
            changes: 5,
          }
        },
        continueMerge: async (name) => ({
          name,
          resolved: true,
          remainingConflicts: [],
          filesMerged: 2,
          changes: 9,
          baseRevision: 'def5678',
        }),
        abortMerge: async (name) => ({ name, filesRestored: 4 }),
      }),
    )

    await expect(provider.mergeSkill(INPUT)).resolves.toEqual({
      name: 'react-best-practices',
      conflicts: [{ path: 'src/index.ts', hunks: 2 }],
      filesMerged: 1,
      changes: 5,
    })
    await expect(provider.continueMerge(INPUT)).resolves.toEqual({
      name: 'react-best-practices',
      resolved: true,
      remainingConflicts: [],
      filesMerged: 2,
      changes: 9,
      baseRevision: 'def5678',
    })
    await expect(provider.abortMerge(INPUT)).resolves.toEqual({
      name: 'react-best-practices',
      filesRestored: 4,
    })
    expect(seenName).toBe('react-best-practices')
  })
})

describe('real core defaults', () => {
  it('calls into @skillbox/core with no deps and propagates its error', async () => {
    // The zero-argument factories `program.ts` uses: every flow reaches core,
    // which reports the missing manifest as a typed SkillboxError.
    const absentRepository = {
      name: 'react-best-practices',
      repositoryRoot: '/tmp/skillbox-loaders-no-such-repository',
    }
    // Thunks, not started promises: with all eight in flight at once the
    // promises awaited later sit without a handler long enough for Node to
    // report them as unhandled rejections.
    const flows: Array<() => Promise<unknown>> = [
      () => createDefaultLifecycleProvider().forkSkill(absentRepository),
      () => createDefaultLifecycleProvider().vendorSkill(absentRepository),
      () => createDefaultLifecycleProvider().detectManagedModifications(absentRepository),
      () => createDefaultLifecycleProvider().restoreManagedSkill(absentRepository),
      () => createDefaultDiffProvider().diffSkill(absentRepository),
      () => createDefaultMergeProvider().mergeSkill(absentRepository),
      () => createDefaultMergeProvider().continueMerge(absentRepository),
      () => createDefaultMergeProvider().abortMerge(absentRepository),
    ]
    for (const flow of flows) {
      const error = await flow().catch((caught: unknown) => caught)
      expect(isSkillboxError(error)).toBe(true)
      expect((error as SkillboxError).code).toBe(ErrorCode.MANIFEST_NOT_FOUND)
    }
  })
})
