import { RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { AgentSummary } from '../api.js'
import { errorMessage } from '../format.js'
import { useAgents, useReconcile } from '../queries.js'
import { CenteredHint, EmptyState, ErrorState } from '../components/States.js'

/**
 * M11.4 + GAP 1.3 — Agents — the detected agent registry: capabilities,
 * detected status, skill counts and the directories each agent looks at.
 * Every card links into the Library pre-filtered to that agent's skills.
 */
export function AgentsPage() {
  const agentsQuery = useAgents()
  const reconcile = useReconcile()
  const agents = agentsQuery.data ?? []
  const detected = agents.filter((agent) => agent.detected)

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Agents</span>
          <h1 className="page-title">Agents</h1>
          <p className="page-description">
            {reconcile.isPending
              ? 'Reconciling repository…'
              : detected.length === 0
                ? agents.length === 0
                  ? 'No agents configured in the registry.'
                  : 'Agents configured, none detected on this machine.'
                : `${detected.length} agent${detected.length === 1 ? '' : 's'} detected`}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            onClick={() => reconcile.mutate()}
            disabled={reconcile.isPending}
            title="Re-run the reconcile engine after enabling skills"
          >
            {reconcile.isPending ? <span className="spinner" /> : <RefreshCw aria-hidden="true" />}
            Reconcile
          </button>
        </div>
      </header>

      {reconcile.isError && (
        <div className="form-error" role="alert">
          {errorMessage(reconcile.error)}
        </div>
      )}

      {agentsQuery.isError && <ErrorState message={errorMessage(agentsQuery.error)} />}

      {agentsQuery.isLoading ? (
        <CenteredHint>
          <div className="loading-row">
            <span className="spinner" />
            Detecting agents…
          </div>
        </CenteredHint>
      ) : agents.length === 0 ? (
        <EmptyState
          title="No agents"
          body="The registry is empty, so no agent directories are managed or scanned."
        />
      ) : (
        <div className="agent-grid">
          {agents.map((agent) => (
            <AgentCardLink key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </section>
  )
}

const CAPABILITY_LABELS: Array<{ key: keyof AgentSummary['capabilities']; label: string }> = [
  { key: 'supportsGlobalSkills', label: 'Global skills' },
  { key: 'supportsProjectSkills', label: 'Project skills' },
  { key: 'supportsSymlinks', label: 'Symlinks' },
  { key: 'supportsNestedSkillDirectories', label: 'Nested dirs' },
  { key: 'requiresRestartAfterChange', label: 'Needs restart' },
]

function AgentCardLink({ agent }: { agent: AgentSummary }) {
  return (
    <Link
      to={`/?agent=${encodeURIComponent(agent.id)}`}
      className="agent-card-anchor"
      aria-label={`View the skills assigned to ${agent.name}`}
    >
      <AgentCard agent={agent} />
    </Link>
  )
}

function AgentCard({ agent }: { agent: AgentSummary }) {
  return (
    <article className="agent-card">
      <header className="agent-card-header">
        <div>
          <h3 className="agent-card-title">{agent.name}</h3>
          <div className="agent-card-id">
            {agent.id}
            {agent.version !== undefined ? ` · ${agent.version}` : ''}
          </div>
        </div>
        <span
          className={`pill ${agent.detected ? 'pill--status status-ready' : 'pill--status status-missing'}`}
        >
          {agent.detected ? 'detected' : 'not found'}
        </span>
      </header>

      <div className="agent-meta">
        <div>
          <div className="meta-label">Skills</div>
          <div className="meta-value">{agent.skillCount}</div>
        </div>
        <div>
          <div className="meta-label">Managed</div>
          <div className="meta-value">{agent.managedSkillCount}</div>
        </div>
        <div>
          <div className="meta-label">External</div>
          <div className="meta-value">{agent.externalSkillCount}</div>
        </div>
        <div>
          <div className="meta-label">Confidence</div>
          <div className="meta-value">{agent.confidence}</div>
        </div>
      </div>

      <div>
        <div className="meta-label">Capabilities</div>
        <div className="cap-list" style={{ marginTop: 6 }}>
          {CAPABILITY_LABELS.map(({ key, label }) => (
            <span key={key} className={`cap-chip${agent.capabilities[key] ? '' : ' cap-chip--no'}`}>
              {label}
            </span>
          ))}
        </div>
      </div>

      {agent.skillDirectories.length > 0 && (
        <div>
          <div className="meta-label">Directories</div>
          <ul className="dir-list" style={{ marginTop: 6 }}>
            {agent.skillDirectories.map((dir) => (
              <li key={dir}>{dir}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="agent-card-cta">View skills for this agent →</div>
    </article>
  )
}
