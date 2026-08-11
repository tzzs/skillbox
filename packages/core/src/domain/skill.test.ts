import { describe, expect, it } from 'vitest'
import {
  SKILL_MODES,
  SKILL_STATUSES,
  type Skill,
  type SkillMode,
  type SkillSource,
  type SkillStatus,
  type SkillUpstream,
} from './skill.js'

function buildSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'review',
    name: 'my-code-review',
    mode: 'local',
    source: { type: 'local', path: './skills/my-code-review' },
    localPath: 'skills/my-code-review',
    agents: [],
    status: 'ready',
    ...overrides,
  }
}

function sourceType(source: SkillSource): string {
  return source.type
}

describe('Skill domain', () => {
  it('supports every skill mode', () => {
    const modes: SkillMode[] = [...SKILL_MODES]
    for (const mode of modes) {
      expect(buildSkill({ mode, id: `skill-${mode}` }).mode).toBe(mode)
    }
  })

  it('supports every skill status', () => {
    const statuses: SkillStatus[] = [...SKILL_STATUSES]
    for (const status of statuses) {
      expect(buildSkill({ status }).status).toBe(status)
    }
  })

  it('accepts every source variant', () => {
    const sources: SkillSource[] = [
      { type: 'github', repo: 'vercel-labs/agent-skills', path: 'skills/react', ref: 'main' },
      { type: 'github', repo: 'owner/repo' },
      { type: 'git', url: 'git@github.com:company/internal.git' },
      { type: 'git', url: 'git@example.com:internal.git', path: 'skills/foo', ref: 'v1' },
      { type: 'registry', registry: 'skills.sh', package: 'org/pkg' },
      { type: 'registry', registry: 'skills.sh', package: 'org/pkg', version: '1.2.3' },
      { type: 'local', path: './skills/my-code-review' },
    ]
    for (const source of sources) {
      expect(buildSkill({ source }).source).toEqual(source)
      expect(sourceType(source)).toBe(source.type)
    }
  })

  it('supports an upstream with and without latest revision', () => {
    const withLatest: SkillUpstream = {
      source: { type: 'github', repo: 'owner/react-practices', path: 'skills/react' },
      baseRevision: 'abc123',
      latestRevision: 'def456',
    }
    const withoutLatest: SkillUpstream = {
      source: { type: 'github', repo: 'owner/react-practices' },
      baseRevision: 'abc123',
    }
    expect(buildSkill({ mode: 'forked', upstream: withLatest }).upstream).toEqual(withLatest)
    expect(buildSkill({ mode: 'forked', upstream: withoutLatest }).upstream).toEqual(withoutLatest)
  })

  it('keeps optional fields absent by default', () => {
    const skill = buildSkill()
    expect(skill.description).toBeUndefined()
    expect(skill.revision).toBeUndefined()
    expect(skill.integrity).toBeUndefined()
    expect(skill.upstream).toBeUndefined()
    expect(skill.agents).toEqual([])
  })
})
