import { describe, expect, it } from 'vitest'
import { SkillboxError } from '../errors.js'
import {
  deriveMode,
  emptyManifest,
  manifestSkillSchema,
  skillboxManifestSchema,
  validateSkillAlias,
} from './schema.js'

describe('skillboxManifestSchema', () => {
  it('parses the minimal manifest (version: 1, skills: {})', () => {
    const result = skillboxManifestSchema.safeParse({ version: 1, skills: {} })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ version: 1, skills: {} })
    }
  })

  it('rejects a missing skills map', () => {
    const result = skillboxManifestSchema.safeParse({ version: 1 })
    expect(result.success).toBe(false)
  })

  it('rejects a non-integer version', () => {
    const result = skillboxManifestSchema.safeParse({ version: '1', skills: {} })
    expect(result.success).toBe(false)
  })

  it('rejects a version other than 1', () => {
    const result = skillboxManifestSchema.safeParse({ version: 2, skills: {} })
    expect(result.success).toBe(false)
  })

  it('accepts top-level name/description/settings/agents', () => {
    const result = skillboxManifestSchema.safeParse({
      version: 1,
      name: 'demo',
      description: 'demo repo',
      skills: {},
      agents: { codex: { enabled: true } },
      settings: { defaultAgents: ['codex'] },
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown top-level skill mode source type', () => {
    const result = skillboxManifestSchema.safeParse({
      version: 1,
      skills: {
        foo: { source: { type: 'marketplace', repo: 'x' } },
      },
    })
    expect(result.success).toBe(false)
  })
})

describe('manifestSkillSchema sources', () => {
  it('accepts a github source with mode derived to managed', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'github', repo: 'vercel-labs/agent-skills', path: 'skills/one', ref: 'main' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a git source', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'git', url: 'https://example.com/skills.git' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a registry source', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'registry', registry: 'npm', package: '@acme/skill' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a local source with mode derived to local', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'local', path: 'skills/foo' },
    })
    expect(result.success).toBe(true)
  })

  it('rejects a local skill with an explicit managed mode', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'local', path: 'skills/foo' },
      mode: 'managed',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a github skill with an explicit local mode', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'github', repo: 'a/b' },
      mode: 'local',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a github-managed skill with an upstream', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'github', repo: 'a/b' },
      upstream: { type: 'github', repo: 'a/c', ref: 'v1' },
    })
    expect(result.success).toBe(true)
  })

  it('rejects a local skill with an upstream', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'local', path: 'skills/foo' },
      upstream: { type: 'github', repo: 'a/c' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a forked skill without an upstream', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'local', path: 'skills/foo' },
      mode: 'forked',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a forked skill with a local source and upstream', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'local', path: 'skills/foo' },
      mode: 'forked',
      upstream: { type: 'github', repo: 'a/c', ref: 'v1' },
    })
    expect(result.success).toBe(true)
  })

  it('rejects a github source missing the required repo field', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'github' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty source url', () => {
    const result = manifestSkillSchema.safeParse({
      source: { type: 'git', url: '' },
    })
    expect(result.success).toBe(false)
  })
})

describe('deriveMode', () => {
  it('derives managed from a remote source', () => {
    expect(deriveMode({ source: { type: 'github', repo: 'a/b' } })).toBe('managed')
  })

  it('derives local from a local source', () => {
    expect(deriveMode({ source: { type: 'local', path: 'skills/foo' } })).toBe('local')
  })

  it('honors an explicit mode', () => {
    expect(deriveMode({ source: { type: 'github', repo: 'a/b' }, mode: 'forked' })).toBe('forked')
  })
})

describe('validateSkillAlias', () => {
  it('accepts valid lowercase aliases', () => {
    expect(validateSkillAlias('react')).toBe('react')
    expect(validateSkillAlias('react-best-practices')).toBe('react-best-practices')
    expect(validateSkillAlias('a1-b_c')).toBe('a1-b_c')
    expect(validateSkillAlias('trailing-')).toBe('trailing-')
  })

  it('rejects invalid aliases with INVALID_MANIFEST', () => {
    for (const alias of ['React', 'my skill', '-dash', '-leading', '']) {
      expect(() => validateSkillAlias(alias)).toThrowError(SkillboxError)
    }
  })
})

describe('emptyManifest', () => {
  it('returns a parseable minimal manifest', () => {
    const manifest = emptyManifest()
    expect(skillboxManifestSchema.safeParse(manifest).success).toBe(true)
  })
})
