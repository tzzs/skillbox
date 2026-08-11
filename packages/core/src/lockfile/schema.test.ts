import { describe, expect, it } from 'vitest'
import {
  createLockedSkill,
  emptyLockfile,
  lockedSkillSchema,
  skillboxLockfileSchema,
} from './schema.js'

describe('skillboxLockfileSchema', () => {
  it('parses the minimal lockfile', () => {
    const result = skillboxLockfileSchema.safeParse({ lockfileVersion: 1, skills: {} })
    expect(result.success).toBe(true)
  })

  it('accepts generatedBy and a locked skill', () => {
    const result = skillboxLockfileSchema.safeParse({
      lockfileVersion: 1,
      generatedBy: 'skillbox@0.1.0',
      skills: {
        a: {
          mode: 'managed',
          source: { type: 'github', repo: 'a/b', ref: 'main' },
          revision: '07a81df7a84e',
          integrity: 'sha256:' + 'a'.repeat(64),
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it('rejects a missing lockfileVersion', () => {
    const result = skillboxLockfileSchema.safeParse({ skills: {} })
    expect(result.success).toBe(false)
  })

  it('rejects a lockfileVersion other than 1', () => {
    const result = skillboxLockfileSchema.safeParse({ lockfileVersion: 2, skills: {} })
    expect(result.success).toBe(false)
  })

  it('rejects a locked skill without integrity', () => {
    const result = skillboxLockfileSchema.safeParse({
      lockfileVersion: 1,
      skills: {
        a: { mode: 'managed', source: { type: 'github', repo: 'a/b' } },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown lock mode', () => {
    const result = skillboxLockfileSchema.safeParse({
      lockfileVersion: 1,
      skills: {
        a: { mode: 'weird', source: { type: 'github', repo: 'a/b' }, integrity: 'sha256:x' },
      },
    })
    expect(result.success).toBe(false)
  })

  it('rejects an invalid source in a locked skill', () => {
    const result = skillboxLockfileSchema.safeParse({
      lockfileVersion: 1,
      skills: {
        a: { mode: 'local', source: { type: 'nope' }, integrity: 'sha256:x' },
      },
    })
    expect(result.success).toBe(false)
  })

  it('accepts a local-mode locked skill with upstream metadata', () => {
    const result = skillboxLockfileSchema.safeParse({
      lockfileVersion: 1,
      skills: {
        a: {
          mode: 'local',
          source: { type: 'local', path: 'skills/a' },
          integrity: 'sha256:' + 'b'.repeat(64),
          upstream: {
            source: { type: 'github', repo: 'a/c' },
            baseRevision: 'v1',
            baseIntegrity: 'sha256:' + 'c'.repeat(64),
            latestRevision: 'v2',
          },
          metadata: { installedBy: 'codex' },
        },
      },
    })
    expect(result.success).toBe(true)
  })
})

describe('emptyLockfile', () => {
  it('returns a minimal parseable lockfile', () => {
    const lockfile = emptyLockfile()
    expect(skillboxLockfileSchema.safeParse(lockfile).success).toBe(true)
  })

  it('includes generatedBy when provided', () => {
    const lockfile = emptyLockfile({ generatedBy: 'skillbox@0.1.0' })
    expect(lockfile.generatedBy).toBe('skillbox@0.1.0')
  })
})

describe('createLockedSkill', () => {
  it('builds a valid locked skill', () => {
    const skill = createLockedSkill({
      mode: 'managed',
      source: { type: 'github', repo: 'a/b' },
      integrity: 'sha256:' + 'a'.repeat(64),
      revision: 'abc123',
      metadata: { agents: ['codex'] },
    })
    expect(skill.mode).toBe('managed')
    expect(skill.revision).toBe('abc123')
    expect(skill.metadata).toEqual({ agents: ['codex'] })
    expect(lockedSkillSchema.safeParse(skill).success).toBe(true)
  })

  it('omits optional fields when not provided', () => {
    const skill = createLockedSkill({
      mode: 'local',
      source: { type: 'local', path: 'skills/x' },
      integrity: 'sha256:' + 'b'.repeat(64),
    })
    expect(skill.revision).toBeUndefined()
    expect(skill.metadata).toBeUndefined()
    expect(lockedSkillSchema.safeParse(skill).success).toBe(true)
  })
})
