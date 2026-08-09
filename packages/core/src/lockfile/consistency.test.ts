import { describe, expect, it } from 'vitest'
import { compareManifestToLockfile, type LockfileOutdatedCheck } from './consistency.js'
import { emptyLockfile, type SkillboxLockfile } from './schema.js'
import {
  emptyManifest,
  type ManifestSkillSource,
  type SkillboxManifest,
} from '../manifest/schema.js'

const localSource = (path: string): ManifestSkillSource & { type: 'local' } => ({
  type: 'local',
  path,
})

function manifestWithSkill(alias: string, source: ManifestSkillSource): SkillboxManifest {
  return { ...emptyManifest(), skills: { [alias]: { source } } }
}

function lockfileWithSkill(alias: string, source: ManifestSkillSource): SkillboxLockfile {
  return { ...emptyLockfile(), skills: { [alias]: { mode: 'local', source, integrity: 'x' } } }
}

describe('compareManifestToLockfile', () => {
  it('reports a fresh pair as not outdated', () => {
    const check = compareManifestToLockfile(
      manifestWithSkill('foo', localSource('skills/foo')),
      lockfileWithSkill('foo', localSource('skills/foo')),
    )
    expect(check).toEqual<LockfileOutdatedCheck>({
      outdated: false,
      missingFromLockfile: [],
      staleLockEntries: [],
      mismatchedSources: [],
    })
  })

  it('flags aliases missing from the lockfile', () => {
    const check = compareManifestToLockfile(
      manifestWithSkill('foo', localSource('skills/foo')),
      emptyLockfile(),
    )
    expect(check.outdated).toBe(true)
    expect(check.missingFromLockfile).toEqual(['foo'])
  })

  it('flags locked sources that disagree with the manifest', () => {
    const check = compareManifestToLockfile(
      manifestWithSkill('foo', localSource('skills/foo')),
      lockfileWithSkill('foo', localSource('skills/bar')),
    )
    expect(check.outdated).toBe(true)
    expect(check.mismatchedSources).toEqual(['foo'])
  })

  it('reports stale lock entries separately without marking the pair outdated', () => {
    const check = compareManifestToLockfile(manifestWithSkill('foo', localSource('skills/foo')), {
      ...lockfileWithSkill('foo', localSource('skills/foo')),
      skills: {
        ...lockfileWithSkill('foo', localSource('skills/foo')).skills,
        keep: { mode: 'local', source: localSource('skills/foo'), integrity: 'x' },
      },
    })
    expect(check.outdated).toBe(false)
    expect(check.staleLockEntries).toEqual(['keep'])
  })

  it('is not outdated on an empty manifest with a missing lockfile', () => {
    const check = compareManifestToLockfile(emptyManifest(), emptyLockfile())
    expect(check.outdated).toBe(false)
  })
})
