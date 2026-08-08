import type { SkillStatus } from './skill.js'

export type AgentDetectionConfidence = 'high' | 'medium' | 'low'

export const AGENT_DETECTION_CONFIDENCES: readonly AgentDetectionConfidence[] = [
  'high',
  'medium',
  'low',
]

export interface AgentCapabilities {
  supportsGlobalSkills: boolean
  supportsProjectSkills: boolean
  supportsSymlinks: boolean
  supportsNestedSkillDirectories: boolean
  requiresRestartAfterChange: boolean
}

export interface AgentDetectionResult {
  detected: boolean
  version?: string
  executable?: string
  skillDirectories: string[]
  confidence: AgentDetectionConfidence
}

export interface Agent {
  id: string
  name: string
  detected: boolean
  version?: string
  executable?: string
  skillDirectories: string[]
  capabilities: AgentCapabilities
  confidence: AgentDetectionConfidence
}

export interface AgentInstalledSkill {
  name: string
  path: string
  managedBySkillbox: boolean
  integrity?: string
  status?: SkillStatus
}
