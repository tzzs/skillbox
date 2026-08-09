import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpCircle, ShieldAlert } from 'lucide-react'
import { ApiError, type OutdatedSkill } from '../api.js'
import { errorMessage } from '../format.js'
import { useInstallRegistrySkill, useOutdated } from '../queries.js'
import { CenteredHint, EmptyState, ErrorState } from '../components/States.js'

/**
 * M16.3 — Updates — installed skills that are behind their upstream revision
 * (locked revision vs latest), with the change notes and a per-row Update
 * button that re-runs the install transaction for the same source/agents.
 */
export function UpdatesPage() {
  const outdatedQuery = useOutdated()
  const update = useInstallRegistrySkill()
  const [updatingName, setUpdatingName] = useState<string | undefined>(undefined)

  const rows = outdatedQuery.data ?? []

  const runUpdate = (row: OutdatedSkill) => {
    setUpdatingName(row.name)
    update.mutate(
      { source: row.source, targetAgents: row.agents, allowPolicy: 'safe' },
      {
        onSettled: () => setUpdatingName(undefined),
      },
    )
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Updates</span>
          <h1 className="page-title">Updates</h1>
          <p className="page-description">
            {outdatedQuery.isLoading
              ? 'Checking upstream revisions…'
              : rows.length === 0
                ? 'Every installed skill is on its locked revision.'
                : `${rows.length} skill${rows.length === 1 ? '' : 's'} behind their latest revision`}
          </p>
        </div>
      </header>

      {update.isError && (
        <div className="form-error" role="alert">
          <strong>Update failed</strong>
          <p>{errorMessage(update.error)}</p>
          <p className="error-hint">{updateHint(update.error)}</p>
        </div>
      )}

      {outdatedQuery.isError && <ErrorState message={errorMessage(outdatedQuery.error)} />}

      {outdatedQuery.isLoading ? (
        <CenteredHint>
          <div className="loading-row">
            <span className="spinner" />
            Checking for updates…
          </div>
        </CenteredHint>
      ) : rows.length === 0 ? (
        <EmptyState
          title="All up to date"
          body="Installed skills match their locked revisions. Check back after upstream changes."
          action={
            <Link to="/explore">
              <span className="btn btn--primary">Browse Explore</span>
            </Link>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="skill-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Installed</th>
                <th>Latest</th>
                <th>Changes</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const pending = update.isPending && updatingName === row.name
                return (
                  <tr key={row.name}>
                    <td>
                      <div className="skill-name">
                        <Link to={`/skills/${encodeURIComponent(row.name)}`}>{row.name}</Link>
                      </div>
                      <div className="skill-message">{row.source}</div>
                    </td>
                    <td>
                      <code className="registry-meta-version">{shortRevision(row.installed)}</code>
                    </td>
                    <td>
                      <div className="latest-cell">
                        <code className="registry-meta-version">{shortRevision(row.latest)}</code>
                        {row.securityRisk === 'high' && (
                          <ShieldAlert
                            aria-hidden="true"
                            className="inline-icon inline-icon--danger"
                            aria-label="Latest revision is high risk"
                          />
                        )}
                      </div>
                    </td>
                    <td>
                      <ChangeNotes changes={row.changes} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--primary btn--small"
                        onClick={() => runUpdate(row)}
                        disabled={update.isPending && !pending}
                      >
                        {pending ? (
                          <span className="spinner" />
                        ) : (
                          <ArrowUpCircle aria-hidden="true" />
                        )}
                        {pending ? 'Updating…' : 'Update'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function ChangeNotes({ changes }: { changes: string[] }) {
  if (changes.length === 0) {
    return <span className="path-muted">no change notes</span>
  }
  return (
    <ul className="change-notes">
      {changes.map((change) => (
        <li key={change}>{change}</li>
      ))}
    </ul>
  )
}

function shortRevision(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 7)}…${value.slice(-4)}`
}

function updateHint(error: unknown): string {
  if (error instanceof ApiError && error.code === 'INSTALL_SECURITY_BLOCKED') {
    return 'The latest revision is high risk and was blocked by the safety policy. Review it from the terminal with `skillbox add --force` or on the Explore page.'
  }
  return error instanceof ApiError && error.recoverable
    ? 'This failure is recoverable — fix the reported issue and retry the update.'
    : 'The update failed. Check the server log for details.'
}
