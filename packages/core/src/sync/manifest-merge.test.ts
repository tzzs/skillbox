import { describe, expect, it } from 'vitest'
import type { SkillboxManifest } from '../manifest/index.js'
import { ManifestMergeService } from './manifest-merge.js'

const source = (repo: string) => ({ type: 'github' as const, repo })
const skill = (repo = 'acme/demo') => ({ source: source(repo), enabled: true, agents: ['codex'] })
const manifest = (skills: SkillboxManifest['skills']): SkillboxManifest => ({ version: 1, skills })

/** Offered and accepted before GAP §2.5 was closed, applied by nothing. */
const NOT_IMPLEMENTED: readonly string[] = ['delete', 'merged', 'restore']

describe('ManifestMergeService', () => {
  const service = new ManifestMergeService()

  it('merges independently added skills', () => {
    const result = service.merge({
      base: manifest({}),
      local: manifest({ local: skill() }),
      remote: manifest({ remote: skill('acme/remote') }),
    })
    expect(result.conflicts).toEqual([])
    expect(Object.keys(result.manifest.skills)).toEqual(['local', 'remote'])
  })

  it('merges independent fields of the same skill including agent membership', () => {
    const base = manifest({ demo: skill() })
    const local = manifest({ demo: { ...skill(), enabled: false } })
    const remote = manifest({ demo: { ...skill(), agents: ['codex', 'claude'] } })
    const result = service.merge({ base, local, remote })
    expect(result.conflicts).toEqual([])
    expect(result.manifest.skills.demo).toMatchObject({
      enabled: false,
      agents: ['claude', 'codex'],
    })
  })

  it('merges a one-sided agent membership change and reports lifecycle conflicts', () => {
    const base = manifest({ demo: skill() })
    const result = service.merge({
      base,
      local: manifest({ demo: { ...skill(), enabled: false } }),
      remote: manifest({ demo: { ...skill(), enabled: true, metadata: { untouched: true } } }),
    })
    expect(result.conflicts).toEqual([])

    const conflict = service.merge({
      base,
      local: manifest({ demo: { ...skill(), mode: 'managed' } }),
      remote: manifest({
        demo: {
          ...skill(),
          mode: 'forked',
          source: { type: 'local', path: 'skills/demo' },
          upstream: source('acme/demo'),
        },
      }),
    }).conflicts
    expect(conflict).toContainEqual(
      expect.objectContaining({ type: 'mode', field: 'mode', destructive: true }),
    )
  })

  it('detects source, lifecycle, metadata, and delete-modify conflicts', () => {
    const base = manifest({ demo: { ...skill(), metadata: { nested: { flag: true } } } })
    const fieldConflicts = service.merge({
      base,
      local: manifest({ demo: { ...skill('a/local'), metadata: { nested: { flag: false } } } }),
      remote: manifest({
        demo: { ...skill('a/remote'), metadata: { nested: { flag: 'remote' } } },
      }),
    }).conflicts
    expect(fieldConflicts.map((item) => item.type)).toEqual(
      expect.arrayContaining(['source', 'manifest-field']),
    )
    const deleteModify = service.merge({
      base,
      local: manifest({}),
      remote: manifest({
        demo: { ...skill(), enabled: false, metadata: { nested: { flag: true } } },
      }),
    }).conflicts
    expect(deleteModify).toContainEqual(
      expect.objectContaining({ type: 'delete-modify', destructive: true }),
    )

    // GAP §2.5: an offer is a promise `resolveConflicts` keeps by construction, so a
    // conflict may list only a resolution the transaction has a branch for.
    for (const conflict of [...fieldConflicts, ...deleteModify]) {
      expect(conflict.allowedResolutions.filter((one) => NOT_IMPLEMENTED.includes(one))).toEqual([])
      expect(conflict.allowedResolutions.length).toBeGreaterThan(0)
      // Nothing is pre-selected for delete/modify: `restore` used to be recommended
      // and did nothing at all, which is worse than offering no recommendation.
      if (conflict.recommendedResolution !== undefined) {
        expect(NOT_IMPLEMENTED).not.toContain(conflict.recommendedResolution)
      }
    }
    // `keep-both` is gone here too, and not for lack of implementation: on a
    // delete/modify one side has no skill entry, so the copy has nothing to clone
    // and the transaction threw on `remote.skills[alias].source`.
    expect(deleteModify[0]?.allowedResolutions).toEqual(['local', 'remote'])
    expect(deleteModify[0]?.recommendedResolution).toBeUndefined()

    // `merged` was advertised on every field conflict and never combined anything:
    // the transaction has no branch for it, so the field just kept whatever the
    // three-way merge had already produced.
    const fieldConflict = fieldConflicts.find((item) => item.type === 'manifest-field')
    expect(fieldConflict).toBeDefined()
    expect(fieldConflict?.allowedResolutions).toEqual(['local', 'remote'])
  })

  it('automatically deletes an unchanged skill from the other side', () => {
    const base = manifest({ demo: skill() })
    const result = service.merge({ base, local: manifest({}), remote: base })
    expect(result.conflicts).toEqual([])
    expect(result.manifest.skills).toEqual({})
  })
})
