import { describe, expect, it } from 'vitest'
import { ErrorCode } from '../errors.js'
import { withTempDir } from '../fs/test-utils.js'
import { readManifest, writeManifest } from './manifest-io.js'
import { addSkill, removeSkill, setAgents, updateSkill } from './mutations.js'
import { emptyManifest, type SkillboxManifest } from './schema.js'

const github = { type: 'github', repo: 'vercel-labs/agent-skills', ref: 'main' } as const
const local = { type: 'local', path: 'skills/demo' } as const

describe('addSkill', () => {
  it('adds a skill and keeps existing entries', () => {
    const manifest = addSkill(emptyManifest(), 'react', { source: github })
    expect(Object.keys(manifest.skills)).toEqual(['react'])
    expect(manifest.skills['react']?.source).toEqual(github)
    expect(manifest.skills['react']?.mode).toBeUndefined()

    const next = addSkill(manifest, 'prettier', { source: local })
    expect(Object.keys(next.skills)).toEqual(['react', 'prettier'])
  })

  it('throws INVALID_MANIFEST when the skill already exists', () => {
    const manifest = addSkill(emptyManifest(), 'dup', { source: github })
    expect(() => addSkill(manifest, 'dup', { source: local })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_MANIFEST }),
    )
  })

  it('throws INVALID_MANIFEST for a bad alias', () => {
    expect(() => addSkill(emptyManifest(), 'Bad Skill', { source: github })).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_MANIFEST }),
    )
  })

  it('throws a schema validation error for an invalid source', () => {
    expect(() =>
      addSkill(emptyManifest(), 'broken', {
        source: { type: 'marketplace', repo: 'x' } as never,
      }),
    ).toThrowError(Error)
  })
})

describe('removeSkill', () => {
  it('removes an existing skill', () => {
    const manifest = addSkill(emptyManifest(), 'keep', { source: github })
    const withBoth = addSkill(manifest, 'drop', { source: local })
    const after = removeSkill(withBoth, 'drop')
    expect(Object.keys(after.skills)).toEqual(['keep'])
  })

  it('throws SKILL_NOT_FOUND for a missing skill', () => {
    expect(() => removeSkill(emptyManifest(), 'nope')).toThrowError(
      expect.objectContaining({ code: ErrorCode.SKILL_NOT_FOUND }),
    )
  })

  it('throws INVALID_MANIFEST for a bad alias', () => {
    expect(() => removeSkill(emptyManifest(), 'Bad')).toThrowError(
      expect.objectContaining({ code: ErrorCode.INVALID_MANIFEST }),
    )
  })
})

describe('updateSkill', () => {
  it('merges the patch over the existing skill', () => {
    const manifest = addSkill(emptyManifest(), 'demo', { source: local })
    const updated = updateSkill(manifest, 'demo', { enabled: false })
    expect(updated.skills['demo']).toMatchObject({ enabled: false })

    const changedSource = updateSkill(manifest, 'demo', { source: github })
    expect(changedSource.skills['demo']?.source).toEqual(github)
  })

  it('rejects a patch that makes the skill schema-invalid', () => {
    const manifest = addSkill(emptyManifest(), 'demo', { source: github })
    expect(() => updateSkill(manifest, 'demo', { mode: 'local' })).toThrowError(Error)
  })

  it('throws SKILL_NOT_FOUND for a missing skill', () => {
    expect(() => updateSkill(emptyManifest(), 'nope', { enabled: true })).toThrowError(
      expect.objectContaining({ code: ErrorCode.SKILL_NOT_FOUND }),
    )
  })
})

describe('setAgents', () => {
  it('sets the agent list for a skill', () => {
    const manifest = addSkill(emptyManifest(), 'demo', { source: local })
    const withAgents = setAgents(manifest, 'demo', ['codex', 'claude'])
    expect(withAgents.skills['demo']?.agents).toEqual(['codex', 'claude'])
  })

  it('accepts an empty agent list (installed for no agent)', () => {
    const manifest = addSkill(emptyManifest(), 'demo', { source: local })
    expect(setAgents(manifest, 'demo', []).skills['demo']?.agents).toEqual([])
  })

  it('throws INVALID_MANIFEST for an empty agent name', () => {
    const manifest = addSkill(emptyManifest(), 'demo', { source: local })
    expect(() => setAgents(manifest, 'demo', [''])).toThrowError(Error)
  })

  it('throws SKILL_NOT_FOUND for a missing skill', () => {
    expect(() => setAgents(emptyManifest(), 'nope', ['codex'])).toThrowError(
      expect.objectContaining({ code: ErrorCode.SKILL_NOT_FOUND }),
    )
  })
})

describe('mutation round-trip', () => {
  it('persists mutations and reads them back consistently', async () => {
    await withTempDir(async (dir) => {
      const manifest: SkillboxManifest = emptyManifest()

      const m1 = addSkill(manifest, 'shell', { source: github })
      const m2 = addSkill(m1, 'local-skill', { source: local })
      const m3 = updateSkill(m2, 'shell', { enabled: true })
      const m4 = setAgents(m3, 'shell', ['codex', 'claude'])
      const m5 = removeSkill(m4, 'local-skill')

      await writeManifest(dir, m5)
      const readBack = await readManifest(dir)
      expect(readBack).toEqual(m5)

      const chainedMutations = addSkill(
        setAgents(addSkill(m5, 'another', { source: github }), 'another', ['codex']),
        'third',
        { source: local },
      )
      await writeManifest(dir, chainedMutations)
      const again = await readManifest(dir)
      expect(again).toEqual(chainedMutations)
    })
  })
})
