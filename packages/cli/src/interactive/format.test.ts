import { describe, expect, it } from 'vitest'
import type { AgentDetectionSummary, SkillStatusEntry } from '@skillbox/core'
import {
  agentStatusLines,
  buildSkillDetailLines,
  buildWelcomeSection,
  skillStatusLabel,
  toSkillDetail,
} from './format.js'

describe('skillStatusLabel', () => {
  it('humanizes statuses', () => {
    expect(skillStatusLabel('ready')).toBe('Ready')
    expect(skillStatusLabel('modified')).toBe('Modified')
    expect(skillStatusLabel('broken')).toBe('Broken')
  })
})

describe('buildWelcomeSection', () => {
  const agent = (id: string, name: string, detected: boolean): AgentDetectionSummary => ({
    id,
    name,
    capabilities: {
      supportsGlobalSkills: true,
      supportsProjectSkills: false,
      supportsSymlinks: true,
      supportsNestedSkillDirectories: false,
      requiresRestartAfterChange: false,
    },
    detected,
    confidence: 'high',
    skillDirectories: [],
    skillCount: 0,
    managedSkillCount: 0,
    externalSkillCount: 0,
  })

  it('lists detected agents and the managed skill count', () => {
    const section = buildWelcomeSection(
      [agent('claude', 'Claude Code', true), agent('codex', 'Codex', true)],
      12,
    )
    expect(section.title).toBe('Skillbox')
    expect(section.lines).toContain('  Claude Code')
    expect(section.lines).toContain('  Codex')
    expect(section.lines).toContain('  12 skills managed')
  })

  it('handles a terminal with no detected agents', () => {
    const section = buildWelcomeSection([agent('claude', 'Claude Code', false)], 0)
    expect(section.lines).toContain('  -  no agents detected')
    expect(section.lines).toContain('  0 skills managed')
  })
})

describe('agentStatusLines', () => {
  it('renders a status line per agent', () => {
    const lines = agentStatusLines([
      {
        id: 'claude',
        name: 'Claude Code',
        capabilities: {
          supportsGlobalSkills: true,
          supportsProjectSkills: false,
          supportsSymlinks: true,
          supportsNestedSkillDirectories: false,
          requiresRestartAfterChange: false,
        },
        detected: true,
        confidence: 'high',
        skillDirectories: [],
        skillCount: 4,
        managedSkillCount: 1,
        externalSkillCount: 3,
        version: '1.0.0',
      },
      {
        id: 'codex',
        name: 'Codex',
        capabilities: {
          supportsGlobalSkills: true,
          supportsProjectSkills: false,
          supportsSymlinks: true,
          supportsNestedSkillDirectories: false,
          requiresRestartAfterChange: false,
        },
        detected: false,
        confidence: 'low',
        skillDirectories: [],
        skillCount: 0,
        managedSkillCount: 0,
        externalSkillCount: 0,
      },
    ])
    expect(lines[0]).toContain('Claude Code')
    expect(lines[0]).toContain('detected')
    expect(lines[0]).toContain('v1.0.0')
    expect(lines[0]).toContain('4 skills')
    expect(lines[1]).toContain('Codex')
    expect(lines[1]).toContain('not found')
  })
})

describe('skill detail', () => {
  const entry: SkillStatusEntry = {
    name: 'my-review',
    mode: 'local',
    status: 'ready',
    agents: ['claude', 'codex'],
    path: 'E:/repo/skills/my-review',
  }

  it('builds a compact detail model', () => {
    const detail = toSkillDetail(entry)
    expect(detail).toMatchObject({
      name: 'my-review',
      mode: 'local',
      status: 'ready',
      agents: ['claude', 'codex'],
    })
    expect(detail.path).toBe('E:/repo/skills/my-review')
  })

  it('renders enabled agents through the label mapper', () => {
    const lines = buildSkillDetailLines(entry, (id) => (id === 'claude' ? 'Claude' : 'Codex'))
    expect(lines).toContain('Skill: my-review')
    expect(lines).toContain('Mode:   local')
    expect(lines).toContain('Status: Ready')
    expect(lines).toContain('  Claude')
    expect(lines).toContain('  Codex')
  })

  it('shows an empty agents list as none', () => {
    const lines = buildSkillDetailLines({ ...entry, agents: [] }, (id) => id)
    expect(lines).toContain('  none')
  })
})
