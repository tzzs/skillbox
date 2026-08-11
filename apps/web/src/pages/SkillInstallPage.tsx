import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  FileLock2,
  Link2,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react'
import {
  ApiError,
  type AgentSummary,
  type InstallResult,
  type RegistryFinding,
  type RegistryRisk,
  type RegistrySearchResult,
} from '../api.js'
import { errorMessage } from '../format.js'
import { useAgents, useInstallRegistrySkill } from '../queries.js'
import { CenteredHint, ErrorState } from '../components/States.js'
import { SecurityReviewedBadge } from './ExplorePage.js'

interface InstallLocationState {
  result?: RegistrySearchResult
}

/**
 * M15 — Skill Install Page — reached from the Explore page's Install button
 * (or with a manual source). Shows the source/version, the security review
 * result (high risk demands an explicit confirmation before `allowPolicy: 'all'`),
 * lets the user pick target agents, then runs the install transaction and
 * renders its manifest/lockfile summary or a recovery hint on failure.
 */
export function SkillInstallPage() {
  const location = useLocation()
  const locationState = location.state as InstallLocationState | null
  const picked = locationState?.result

  const agentsQuery = useAgents()
  const install = useInstallRegistrySkill()

  const [source, setSource] = useState(picked?.source ?? '')
  const [targetAgents, setTargetAgents] = useState<string[]>([])
  const [allowHighRisk, setAllowHighRisk] = useState(false)

  const result = install.data
  const error = install.error
  const securityBlocked = error instanceof ApiError && error.code === 'INSTALL_SECURITY_BLOCKED'

  if (result !== undefined) {
    return <InstallSuccess result={result} />
  }

  const toggleAgent = (agentId: string) => {
    setTargetAgents((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    )
  }

  const startInstall = () => {
    install.mutate({ source, targetAgents, allowPolicy: allowHighRisk ? 'all' : 'safe' })
  }

  const risk = picked?.securityRisk
  const highRisk = risk === 'high' || securityBlocked

  return (
    <section className="page">
      <Link to="/explore" className="detail-anchor">
        <ArrowLeft aria-hidden="true" />
        Explore
      </Link>

      <header className="page-header">
        <div>
          <span className="page-eyebrow">Marketplace</span>
          <h1 className="page-title">Install skill</h1>
          <p className="page-description">
            Review the source and the security scan, then pick the agents to install for.
          </p>
        </div>
      </header>

      {/* source identity */}
      <div className="card">
        <h2 className="card-title">Source</h2>
        {picked !== undefined ? (
          <div className="detail-grid">
            <DetailItem label="Name" value={picked.name} />
            <DetailItem
              label="Source"
              value={<code className="registry-meta-version">{picked.source}</code>}
            />
            <DetailItem label="Provider" value={picked.provider} />
            {(picked.version ?? picked.revision) !== undefined && (
              <DetailItem label="Version" value={picked.version ?? picked.revision ?? '—'} />
            )}
            {picked.description !== undefined && (
              <DetailItem label="Description" value={picked.description} />
            )}
          </div>
        ) : (
          <div className="field">
            <label className="field-label" htmlFor="install-source">
              Source <span className="field-required">*</span>
            </label>
            <input
              id="install-source"
              className="field-input"
              type="text"
              placeholder="github:owner/repo@path"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
            <p className="field-hint">
              No skill selected on the Explore page — paste a normalized source such as{' '}
              <code>github:acme/react-best-practices</code>.
            </p>
          </div>
        )}
      </div>

      {/* security review */}
      <div className="card">
        <h2 className="card-title">Security review</h2>
        {picked !== undefined ? (
          <>
            <SecurityReviewedBadge result={picked} />
            {risk !== undefined && (
              <div className={`risk-line risk-line--${risk}`}>
                <RiskIcon risk={risk} />
                <span>
                  Risk level: <strong className={`risk-text risk-text--${risk}`}>{risk}</strong>
                </span>
              </div>
            )}
          </>
        ) : (
          <p className="page-description">
            No registry result attached — the server scans the skill at install time and will report
            findings before the transaction completes.
          </p>
        )}

        {highRisk && (
          <div className="risk-warning" role="alert">
            <ShieldAlert aria-hidden="true" />
            <div>
              <strong>High-risk skill</strong>
              <p>
                This skill failed or was flagged by the security review. Review the findings below
                before continuing.
              </p>
            </div>
          </div>
        )}

        <FindingsList findings={picked?.securityFindings ?? []} />

        {highRisk && (
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={allowHighRisk}
              onChange={(event) => setAllowHighRisk(event.target.checked)}
            />
            <span>
              I reviewed the findings and want to install this skill anyway{' '}
              <span className="path-muted">(installs with allow-all security policy)</span>
            </span>
          </label>
        )}
      </div>

      {/* target agents */}
      <div className="card">
        <h2 className="card-title">Target agents</h2>
        {agentsQuery.isLoading ? (
          <CenteredHint>
            <div className="loading-row">
              <span className="spinner" />
              Loading agents…
            </div>
          </CenteredHint>
        ) : agentsQuery.isError ? (
          <ErrorState message={errorMessage(agentsQuery.error)} />
        ) : (agentsQuery.data ?? []).length === 0 ? (
          <p className="page-description">
            No agents detected in the registry. Install from a terminal with{' '}
            <code>skillbox add</code> once agents are detected.
          </p>
        ) : (
          <div className="agent-toggle-list">
            {(agentsQuery.data ?? []).map((agent) => (
              <AgentPick
                key={agent.id}
                agent={agent}
                checked={targetAgents.includes(agent.id)}
                onToggle={() => toggleAgent(agent.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* submit */}
      <div className="card">
        <div className="form-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={startInstall}
            disabled={
              install.isPending ||
              source.trim() === '' ||
              targetAgents.length === 0 ||
              (highRisk && !allowHighRisk)
            }
          >
            {install.isPending ? <span className="spinner" /> : <Download aria-hidden="true" />}
            {install.isPending ? 'Installing…' : 'Confirm install'}
          </button>
          {targetAgents.length === 0 && (
            <span className="field-hint">Select at least one target agent.</span>
          )}
          {highRisk && !allowHighRisk && (
            <span className="field-hint">
              Confirm the security findings above to enable the install button.
            </span>
          )}
        </div>

        {install.isError && (
          <InstallError error={install.error} securityBlocked={securityBlocked} />
        )}
      </div>
    </section>
  )
}

function AgentPick({
  agent,
  checked,
  onToggle,
}: {
  agent: AgentSummary
  checked: boolean
  onToggle: () => void
}) {
  return (
    <label className="agent-toggle-row agent-pick">
      <span className="agent-toggle-info">
        <span className="agent-name">{agent.name}</span>
        <span className="agent-id">{agent.id}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={onToggle} aria-label={agent.name} />
    </label>
  )
}

function FindingsList({ findings }: { findings: RegistryFinding[] }) {
  if (findings.length === 0) {
    return (
      <p className="page-description">
        <Check aria-hidden="true" className="inline-icon" /> No findings reported for this skill.
      </p>
    )
  }
  return (
    <ul className="finding-list">
      {findings.map((finding) => (
        <li
          key={`${finding.rule}:${finding.message}`}
          className={`finding finding--${finding.severity}`}
        >
          <span className="finding-rule">{finding.rule}</span>
          <span className="finding-message">{finding.message}</span>
        </li>
      ))}
    </ul>
  )
}

function RiskIcon({ risk }: { risk: RegistryRisk }) {
  if (risk === 'high') {
    return <ShieldAlert aria-hidden="true" />
  }
  if (risk === 'medium') {
    return <AlertTriangle aria-hidden="true" />
  }
  return <ShieldCheck aria-hidden="true" />
}

function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-item">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  )
}

function InstallError({ error, securityBlocked }: { error: unknown; securityBlocked: boolean }) {
  const hint = recoveryHint(error, securityBlocked)
  return (
    <div className="form-error" role="alert">
      <strong>Install failed</strong>
      <p>{errorMessage(error)}</p>
      {hint !== undefined && <p className="error-hint">{hint}</p>}
    </div>
  )
}

function recoveryHint(error: unknown, securityBlocked: boolean): string | undefined {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'REGISTRY_UNAVAILABLE':
      case 'REGISTRY_SEARCH_FAILED':
        return 'The registry is unreachable right now. Check your network connection and retry.'
      case 'INSTALL_SECURITY_BLOCKED':
        return securityBlocked
          ? 'The security review blocked this install. Review the findings and confirm to install with the allow-all policy.'
          : undefined
      case 'INSTALL_CONFLICT':
      case 'INSTALL_AGENT_LINK_FAILED':
        return 'The repository is in a conflicting state. Run Reconcile from the Library and retry.'
      case 'SOURCE_INVALID':
      case 'SOURCE_UNSUPPORTED':
        return 'The source is not a recognized skill source. Check the format and try again.'
      default:
        return error.recoverable
          ? 'This failure is recoverable — fix the reported issue and retry the install.'
          : undefined
    }
  }
  return undefined
}

function InstallSuccess({ result }: { result: InstallResult }) {
  const navigate = useNavigate()
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Installed</h1>
          <p className="page-description">
            <Check aria-hidden="true" className="inline-icon inline-icon--ok" />{' '}
            <strong>{result.name}</strong> is now part of this repository.
          </p>
        </div>
      </header>

      <div className="card">
        <h2 className="card-title">Install summary</h2>
        <div className="detail-grid">
          <DetailItem label="Name" value={result.name} />
          <DetailItem label="Source" value={result.source} />
          {result.revision !== undefined && <DetailItem label="Revision" value={result.revision} />}
          <DetailItem label="Path" value={result.path} />
          <DetailItem
            label="Agents"
            value={result.agents.length > 0 ? result.agents.join(', ') : '—'}
          />
        </div>

        <div className="install-changes">
          <span className={`change-chip${result.manifestChanged ? '' : ' change-chip--off'}`}>
            <FileLock2 aria-hidden="true" />
            {result.manifestChanged ? 'Manifest updated' : 'Manifest unchanged'}
          </span>
          <span className={`change-chip${result.lockfileChanged ? '' : ' change-chip--off'}`}>
            <FileLock2 aria-hidden="true" />
            {result.lockfileChanged ? 'Lockfile updated' : 'Lockfile unchanged'}
          </span>
          <span className="change-chip">
            <Link2 aria-hidden="true" />
            {result.agents.length} agent link{result.agents.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Security</h2>
        <div className={`risk-line risk-line--${result.security.risk}`}>
          <RiskIcon risk={result.security.risk} />
          <span>
            Risk level:{' '}
            <strong className={`risk-text risk-text--${result.security.risk}`}>
              {result.security.risk}
            </strong>
          </span>
        </div>
        <FindingsList findings={result.security.findings} />
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => navigate(`/skills/${encodeURIComponent(result.name)}`)}
        >
          View in Library
        </button>
        <button type="button" className="btn" onClick={() => navigate('/explore')}>
          <X aria-hidden="true" />
          Back to Explore
        </button>
      </div>
    </section>
  )
}
