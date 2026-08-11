import { describe, expect, it } from 'vitest'
import {
  AGENT_DETECTION_CONFIDENCES,
  type Agent,
  type AgentCapabilities,
  type AgentDetectionConfidence,
  type AgentDetectionResult,
  type AgentInstalledSkill,
} from './agent.js'

const capabilities: AgentCapabilities = {
  supportsGlobalSkills: true,
  supportsProjectSkills: false,
  supportsSymlinks: true,
  supportsNestedSkillDirectories: false,
  requiresRestartAfterChange: false,
}

function buildAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    detected: true,
    skillDirectories: [],
    capabilities,
    confidence: 'high',
    ...overrides,
  }
}

describe('Agent domain', () => {
  it('exposes the detection metadata required by the MVP', () => {
    const agent = buildAgent({
      version: '2.0.0',
      executable: '/usr/local/bin/claude',
      skillDirectories: ['/home/user/.claude/skills'],
    })
    expect(agent).toMatchObject({
      id: 'claude-code',
      name: 'Claude Code',
      detected: true,
      version: '2.0.0',
      executable: '/usr/local/bin/claude',
      skillDirectories: ['/home/user/.claude/skills'],
      confidence: 'high',
    })
  })

  it('supports every detection confidence', () => {
    const confidences: AgentDetectionConfidence[] = [...AGENT_DETECTION_CONFIDENCES]
    for (const confidence of confidences) {
      expect(buildAgent({ confidence }).confidence).toBe(confidence)
    }
  })

  it('supports a representative detection result', () => {
    const result: AgentDetectionResult = {
      detected: true,
      version: '1.42.0',
      executable: '/opt/codex/bin/codex',
      skillDirectories: ['/home/user/.codex/skills'],
      confidence: 'medium',
    }
    expect(result.detected).toBe(true)
    expect(result.skillDirectories).toHaveLength(1)
  })

  it('models both managed and external installed skills', () => {
    const managed: AgentInstalledSkill = {
      name: 'react-best-practices',
      path: '/home/user/.claude/skills/react-best-practices',
      managedBySkillbox: true,
      integrity: 'sha256:abc',
      status: 'ready',
    }
    const external: AgentInstalledSkill = {
      name: 'personal-note',
      path: '/home/user/.claude/skills/personal-note',
      managedBySkillbox: false,
    }
    expect(managed.managedBySkillbox).toBe(true)
    expect(external.managedBySkillbox).toBe(false)
    expect(external.integrity).toBeUndefined()
  })
})
