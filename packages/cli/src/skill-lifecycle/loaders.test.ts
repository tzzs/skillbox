import { describe, expect, it } from 'vitest'
import { isSkillboxError, SkillboxError } from '@skillbox/core'
import {
  createDefaultDiffProvider,
  createDefaultLifecycleProvider,
  createDefaultMergeProvider,
  LIFECYCLE_UNAVAILABLE_CODE,
  MERGE_CONFLICT_CODE,
  type CoreModuleLoader,
} from './loaders.js'

/**
 * Default-loaders behavior: with a module that exports none of the V0.4
 * functions, every provider call must fail with a typed SkillboxError + hint
 * instead of crashing; with the landed core exports, the adapters must map
 * the core result shapes onto the CLI contracts.
 */

/** Core module with none of the V0.4 exports (the current state). */
const emptyCore: CoreModuleLoader = async () => ({})

/** Core module with the V0.4 exports mocked (the post-integration state). */
const landedCore =
  (exports: Record<string, unknown>): CoreModuleLoader =>
  async () =>
    exports

const INPUT = { name: 'react-best-practices', repositoryRoot: '/repo' }

describe('createDefaultLifecycleProvider', () => {
  it('throws a typed unavailable error with a hint for every flow', async () => {
    const provider = createDefaultLifecycleProvider(emptyCore, 'lifecycle hint text')
    for (const call of [
      () => provider.forkSkill({ ...INPUT, homeRoot: '/home' }),
      () => provider.vendorSkill({ ...INPUT }),
      () =>
        provider.detectManagedModifications({
          name: INPUT.name,
          repositoryRoot: INPUT.repositoryRoot,
        }),
    ]) {
      const error = await call().catch((caught: unknown) => caught)
      expect(isSkillboxError(error)).toBe(true)
      expect((error as SkillboxError).code).toBe(LIFECYCLE_UNAVAILABLE_CODE)
      expect((error as SkillboxError).message).toContain('lifecycle hint text')
    }
    // Restore carries its own richer hint (mentions the fork alternative).
    const restoreError = await provider
      .restoreManagedSkill({ name: INPUT.name, repositoryRoot: INPUT.repositoryRoot })
      .catch((caught: unknown) => caught)
    expect(isSkillboxError(restoreError)).toBe(true)
    expect((restoreError as SkillboxError).code).toBe(LIFECYCLE_UNAVAILABLE_CODE)
    expect((restoreError as SkillboxError).message).toContain('Restore is not available')
    expect((restoreError as SkillboxError).message).toContain('Convert the skill to a fork')
  })

  it('adapts core forkSkill (landed shape) onto the CLI contract', async () => {
    // Agent 1's `ForkSkillResult` uses `repositoryPath` (repo-relative) and an
    // `upstream` source object; the CLI contract prefers `localPath` and a
    // canonical `upstreamSource` expression (SPEC §23).
    let seenOptions: { repositoryRoot: string; homeRoot?: string } | undefined
    const provider = createDefaultLifecycleProvider(
      landedCore({
        forkSkill: async (name: string, options: { repositoryRoot: string; homeRoot?: string }) => {
          seenOptions = options
          return {
            alias: name,
            mode: 'forked',
            repositoryPath: `skills/${name}`,
            absolutePath: `/repo/skills/${name}`,
            upstream: {
              type: 'github',
              repo: 'vercel-labs/agent-skills',
              path: 'skills/react-best-practices',
              baseRevision: 'abc1234',
            },
            baseRevision: 'abc1234',
            integrity: 'hash-1',
            agents: ['claude'],
          }
        },
      }),
    )
    const result = await provider.forkSkill({ ...INPUT, homeRoot: '/home' })
    expect(result.mode).toBe('forked')
    expect(result.alias).toBe('react-best-practices')
    expect(result.localPath).toBe('skills/react-best-practices')
    expect(result.upstreamSource).toBe(
      'github:vercel-labs/agent-skills@skills/react-best-practices',
    )
    expect(result.baseRevision).toBe('abc1234')
    expect(result.materializedPath).toBe('/repo/skills/react-best-practices')
    // The options adapter forwards repositoryRoot + homeRoot.
    expect(seenOptions?.repositoryRoot).toBe('/repo')
    expect(seenOptions?.homeRoot).toBe('/home')
  })

  it('adapts core vendorSkill (landed shape) onto the CLI contract', async () => {
    const provider = createDefaultLifecycleProvider(
      landedCore({
        vendorSkill: async (name: string) => ({
          alias: name,
          mode: 'vendored',
          repositoryPath: `skills/${name}`,
          fromFork: true,
        }),
      }),
    )
    const result = await provider.vendorSkill(INPUT)
    expect(result.mode).toBe('vendored')
    expect(result.localPath).toBe('skills/react-best-practices')
    // `fromFork` says a fork existed before; upstream clearing is implied.
    expect(result.upstreamCleared).toBe(true)
  })

  it('adapts core detectManagedModifications (boolean) onto the CLI contract', async () => {
    const provider = createDefaultLifecycleProvider(
      landedCore({
        detectManagedModifications: async (_name: string) => true,
      }),
    )
    const modified = await provider.detectManagedModifications(INPUT)
    expect(modified).toEqual({ name: 'react-best-practices', modified: true })

    const cleanProvider = createDefaultLifecycleProvider(
      landedCore({
        detectManagedModifications: async () => false,
      }),
    )
    const clean = await cleanProvider.detectManagedModifications(INPUT)
    expect(clean).toEqual({ name: 'react-best-practices', modified: false })
  })

  it('forwards Restore homeRoot to the landed Core transaction', async () => {
    let seenOptions: { repositoryRoot: string; homeRoot?: string } | undefined
    const provider = createDefaultLifecycleProvider(
      landedCore({
        restoreManagedSkill: async (
          name: string,
          options: { repositoryRoot: string; homeRoot?: string },
        ) => {
          seenOptions = options
          return { alias: name, filesRestored: 2 }
        },
      }),
    )
    const result = await provider.restoreManagedSkill({ ...INPUT, homeRoot: '/home' })
    expect(result).toEqual({ name: INPUT.name, filesRestored: 2 })
    expect(seenOptions).toEqual({ repositoryRoot: '/repo', homeRoot: '/home' })
  })
})

describe('createDefaultDiffProvider', () => {
  it('throws a typed unavailable error until diffSkill lands', async () => {
    const provider = createDefaultDiffProvider(emptyCore, 'diff hint text')
    const error = await provider.diffSkill(INPUT).catch((caught: unknown) => caught)
    expect(isSkillboxError(error)).toBe(true)
    expect((error as SkillboxError).code).toBe(LIFECYCLE_UNAVAILABLE_CODE)
    expect((error as SkillboxError).message).toContain('diff hint text')
  })

  it('adapts core diffSkill onto the CLI contract once it lands', async () => {
    const provider = createDefaultDiffProvider(
      landedCore({
        diffSkill: async (name: string) => ({
          name,
          mode: 'forked',
          views: [
            { label: 'Local', files: [{ path: 'SKILL.md', status: 'modified', patch: '-a\n+b' }] },
          ],
        }),
      }),
    )
    const result = await provider.diffSkill(INPUT)
    expect(result.mode).toBe('forked')
    expect(result.views[0]?.label).toBe('Local')
    expect(result.views[0]?.files[0]?.patch).toBe('-a\n+b')
  })
})

describe('createDefaultMergeProvider', () => {
  it('throws a typed unavailable error for merge/continue/abort', async () => {
    const provider = createDefaultMergeProvider(emptyCore, 'merge hint text')
    for (const call of [
      () => provider.mergeSkill(INPUT),
      () => provider.continueMerge(INPUT),
      () => provider.abortMerge(INPUT),
    ]) {
      const error = await call().catch((caught: unknown) => caught)
      expect(isSkillboxError(error)).toBe(true)
      expect((error as SkillboxError).code).toBe(LIFECYCLE_UNAVAILABLE_CODE)
      expect((error as SkillboxError).message).toContain('merge hint text')
    }
  })

  it('adapts core merge/continue/abort onto the CLI contract once they land', async () => {
    const provider = createDefaultMergeProvider(
      landedCore({
        mergeSkill: async (name: string) => ({
          name,
          conflicts: [{ path: 'src/index.ts', hunks: 2 }],
          filesMerged: 1,
          changes: 5,
        }),
        continueMerge: async (name: string) => ({
          name,
          resolved: true,
          remainingConflicts: [],
          filesMerged: 2,
          changes: 9,
          baseRevision: 'def5678',
        }),
        abortMerge: async (name: string) => ({ name, filesRestored: 4 }),
      }),
    )
    const merged = await provider.mergeSkill(INPUT)
    expect(merged.conflicts[0]?.path).toBe('src/index.ts')
    const continued = await provider.continueMerge(INPUT)
    expect(continued.resolved).toBe(true)
    expect(continued.baseRevision).toBe('def5678')
    const aborted = await provider.abortMerge(INPUT)
    expect(aborted.filesRestored).toBe(4)
  })
})

describe('exit-code codes', () => {
  it('defines the CLI-level MERGE_CONFLICT code (exit 3 mapping lives in exit-codes.ts)', () => {
    expect(MERGE_CONFLICT_CODE).toBe('MERGE_CONFLICT')
  })
})
