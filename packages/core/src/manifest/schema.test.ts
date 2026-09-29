import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { SkillboxError } from '../errors.js'
import { CURRENT_MANIFEST_VERSION } from '../migrations/types.js'
import {
  deriveMode,
  emptyManifest,
  MANIFEST_VERSION,
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

  it('accepts a registry source that names a skill inside the package', () => {
    const result = manifestSkillSchema.safeParse({
      source: {
        type: 'registry',
        registry: 'skills.sh',
        package: 'acme/skillz',
        path: 'skills/b',
        version: '1.2.0',
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.source).toEqual({
        type: 'registry',
        registry: 'skills.sh',
        package: 'acme/skillz',
        path: 'skills/b',
        version: '1.2.0',
      })
    }
  })

  it('rejects an empty registry path, exactly like the git variant', () => {
    for (const path of ['', '   ']) {
      const result = manifestSkillSchema.safeParse({
        source: { type: 'registry', registry: 'skills.sh', package: 'acme/skillz', path },
      })
      expect(result.success).toBe(false)
    }
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

describe('manifest schema compatibility (why no version bump)', () => {
  it('strips unknown keys rather than rejecting them (no .strict() in this schema)', () => {
    // The whole file uses zod's default object behaviour — there is no
    // `.strict()` / `.passthrough()` call anywhere in `schema.ts` — so an
    // unrecognised key is removed, not reported. Pinned here because the
    // "adding an optional field needs no migration" decision rests on it.
    const result = manifestSkillSchema.safeParse({
      source: { type: 'github', repo: 'a/b', fromTheFuture: { nested: true } },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.source).not.toHaveProperty('fromTheFuture')
    }
  })

  it('lets a pre-path reader parse a registry source that carries path', () => {
    // The registry schema exactly as it was before `path` landed. Parsing a
    // node written by the current build succeeds and drops the key: an older
    // skillbox keeps working on a newer manifest (it just re-resolves the
    // path from registry metadata, as it always did).
    const oldRegistrySourceSchema = z.object({
      type: z.literal('registry'),
      registry: z.string().trim().min(1),
      package: z.string().trim().min(1),
      version: z.string().trim().min(1).optional(),
    })
    const parsed = oldRegistrySourceSchema.safeParse({
      type: 'registry',
      registry: 'skills.sh',
      package: 'acme/skillz',
      path: 'skills/b',
      version: '1.2.0',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        type: 'registry',
        registry: 'skills.sh',
        package: 'acme/skillz',
        version: '1.2.0',
      })
    }
  })

  it('keeps the manifest version at 1 with the optional field added', () => {
    // ReadManifest refuses `version > MANIFEST_VERSION` outright, so bumping
    // here would break the very readers this field is compatible with.
    expect(MANIFEST_VERSION).toBe(1)
    expect(CURRENT_MANIFEST_VERSION).toBe(1)
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
