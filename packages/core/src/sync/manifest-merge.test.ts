import { describe, expect, it } from 'vitest'
import type { SkillboxManifest } from '../manifest/index.js'
import { ManifestMergeService } from './manifest-merge.js'

const source = (repo: string) => ({ type: 'github' as const, repo })
const skill = (repo = 'acme/demo') => ({ source: source(repo), enabled: true, agents: ['codex'] })
const manifest = (skills: SkillboxManifest['skills']): SkillboxManifest => ({ version: 1, skills })

describe('ManifestMergeService', () => {
  const service = new ManifestMergeService()

  it('merges independently added skills', () => {
    const result = service.merge({ base: manifest({}), local: manifest({ local: skill() }), remote: manifest({ remote: skill('acme/remote') }) })
    expect(result.conflicts).toEqual([])
    expect(Object.keys(result.manifest.skills)).toEqual(['local', 'remote'])
  })

  it('merges independent fields of the same skill including agent membership', () => {
    const base = manifest({ demo: skill() })
    const local = manifest({ demo: { ...skill(), enabled: false } })
    const remote = manifest({ demo: { ...skill(), agents: ['codex', 'claude'] } })
    const result = service.merge({ base, local, remote })
    expect(result.conflicts).toEqual([])
    expect(result.manifest.skills.demo).toMatchObject({ enabled: false, agents: ['claude', 'codex'] })
  })

  it('merges a one-sided agent membership change and reports lifecycle conflicts', () => {
    const base = manifest({ demo: skill() })
    const result = service.merge({ base, local: manifest({ demo: { ...skill(), enabled: false } }), remote: manifest({ demo: { ...skill(), enabled: true, metadata: { untouched: true } } }) })
    expect(result.conflicts).toEqual([])

    const conflict = service.merge({ base, local: manifest({ demo: { ...skill(), mode: 'managed' } }), remote: manifest({ demo: { ...skill(), mode: 'forked', source: { type: 'local', path: 'skills/demo' }, upstream: source('acme/demo') } }) }).conflicts
    expect(conflict).toContainEqual(expect.objectContaining({ type: 'mode', field: 'mode', destructive: true }))
  })

  it('detects source, lifecycle, metadata, and delete-modify conflicts', () => {
    const base = manifest({ demo: { ...skill(), metadata: { nested: { flag: true } } } })
    expect(service.merge({ base, local: manifest({ demo: { ...skill('a/local'), metadata: { nested: { flag: false } } } }), remote: manifest({ demo: { ...skill('a/remote'), metadata: { nested: { flag: 'remote' } } } }) }).conflicts.map((item) => item.type)).toEqual(expect.arrayContaining(['source', 'manifest-field']))
    expect(service.merge({ base, local: manifest({}), remote: manifest({ demo: { ...skill(), enabled: false, metadata: { nested: { flag: true } } } }) }).conflicts).toContainEqual(expect.objectContaining({ type: 'delete-modify', recommendedResolution: 'restore', destructive: true }))
  })

  it('automatically deletes an unchanged skill from the other side', () => {
    const base = manifest({ demo: skill() })
    const result = service.merge({ base, local: manifest({}), remote: base })
    expect(result.conflicts).toEqual([])
    expect(result.manifest.skills).toEqual({})
  })
})
