import type { SkillStatusEntry } from '../api.js'
import { modeLabel, statusClass, statusLabel } from '../format.js'

/**
 * Status + mode pills used across the Library and Agent views. Class names
 * come from `format.ts` and the colors live in `styles.css`.
 */
export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill--status ${statusClass(status)}`}>{statusLabel(status)}</span>
}

export function ModePill({ mode }: { mode: string }) {
  return <span className={`pill pill--mode pill--mode-${mode}`}>{modeLabel(mode)}</span>
}

/** The list of agents a skill is enabled for, as small tags. */
export function AgentTags({ agents }: { agents: string[] }) {
  if (agents.length === 0) {
    return <span className="empty-agents">no agents</span>
  }
  return (
    <div className="agent-tags">
      {agents.map((agent) => (
        <span key={agent} className="agent-tag">
          {agent}
        </span>
      ))}
    </div>
  )
}

/** Relative skill path, or an em dash when the source is not local. */
export function SkillPath({ skill }: { skill: SkillStatusEntry }) {
  if (skill.path === undefined) {
    return <span className="path-muted">—</span>
  }
  return <code className="skill-path">{skill.path}</code>
}
