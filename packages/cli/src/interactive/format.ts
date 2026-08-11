import type {
  AgentDetectionSummary,
  SkillMode,
  SkillStatus,
  SkillStatusEntry,
} from '@skillbox/core'

/** Human label for a skill status (e.g. `ready` -> `Ready`). */
export function skillStatusLabel(status: SkillStatus): string {
  const known: Record<SkillStatus, string> = {
    ready: 'Ready',
    modified: 'Modified',
    outdated: 'Outdated',
    conflict: 'Conflict',
    missing: 'Missing',
    broken: 'Broken',
  }
  return known[status] ?? status
}

export interface WelcomeSection {
  title: string
  lines: string[]
}

/** Lines rendered on the Welcome screen (detected agents + managed count). */
export function buildWelcomeSection(
  agents: readonly AgentDetectionSummary[],
  managedSkillCount: number,
): WelcomeSection {
  const detected = agents.filter((agent) => agent.detected)
  const agentLines =
    detected.length === 0 ? ['  -  no agents detected'] : detected.map((agent) => `  ${agent.name}`)
  return {
    title: 'Skillbox',
    lines: [...agentLines, '', `  ${managedSkillCount} skills managed`],
  }
}

/** Minimal agent status row: name, detected?, version, skill count. */
export function agentStatusLines(summaries: readonly AgentDetectionSummary[]): string[] {
  if (summaries.length === 0) {
    return ['  (no agents registered)']
  }
  return summaries.map((agent) => {
    const status = agent.detected ? 'detected' : 'not found'
    const version = agent.detected && agent.version !== undefined ? ` v${agent.version}` : ''
    const skills = agent.detected ? `${agent.skillCount} skills` : '-'
    return `  ${agent.name}${version}  ${status}    ${skills}`
  })
}

export interface SkillDetailModel {
  name: string
  mode: SkillMode
  status: SkillStatus
  agents: string[]
  message?: string
  path?: string
}

/** Builds a compact skill detail model from a status entry. */
export function toSkillDetail(entry: SkillStatusEntry): SkillDetailModel {
  const detail: SkillDetailModel = {
    name: entry.name,
    mode: entry.mode,
    status: entry.status,
    agents: entry.agents,
  }
  if (entry.message !== undefined) {
    detail.message = entry.message
  }
  if (entry.path !== undefined) {
    detail.path = entry.path
  }
  return detail
}

/**
 * Detail view for a skill. `agentLabel` maps agent ids to display names so the
 * enabled list is human-readable.
 */
export function buildSkillDetailLines(
  skill: SkillDetailModel,
  agentLabel: (agentId: string) => string,
): string[] {
  const enabled = skill.agents.map((id) => agentLabel(id))
  const statusLine = `${skillStatusLabel(skill.status)}${
    skill.message !== undefined ? ` (${skill.message})` : ''
  }`
  return [
    `Skill: ${skill.name}`,
    '',
    `Mode:   ${skill.mode}`,
    `Status: ${statusLine}`,
    '',
    'Agents:',
    ...(enabled.length === 0 ? ['  none'] : enabled.map((label) => `  ${label}`)),
  ]
}
