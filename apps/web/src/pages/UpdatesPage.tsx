import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpCircle, ShieldAlert } from 'lucide-react'
import { ApiError, type OutdatedSkill } from '../api.js'
import { errorMessage } from '../format.js'
import { useInstallRegistrySkill, useOutdated } from '../queries.js'
import { CenteredHint, EmptyState, ErrorState } from '../components/States.js'
import { useDocumentTitle } from '../useDocumentTitle.js'

/** One row an "Update all" batch could not update, with the reason the API gave. */
export interface BatchFailure {
  name: string
  /** The server's own `error.message` (M10.8 envelope), or the transport error text. */
  reason: string
}

/** Progress of an "Update all" batch plus every failure collected so far. */
export interface BatchState {
  done: number
  total: number
  failed: number
  failures: BatchFailure[]
}

/**
 * Runs one "Update all" batch sequentially and reports progress after every
 * row. A rejection never aborts the batch — the `safe` policy refuses
 * high-risk revisions on purpose — but the reason is kept per skill so the UI
 * can say *which* rows failed and why instead of a bare count.
 */
export async function runBatchUpdates(
  rows: readonly OutdatedSkill[],
  updateOne: (row: OutdatedSkill) => Promise<unknown>,
  onProgress: (state: BatchState) => void,
): Promise<BatchState> {
  let state: BatchState = { done: 0, total: rows.length, failed: 0, failures: [] }
  onProgress(state)
  for (const row of rows) {
    let failure: BatchFailure | undefined
    try {
      await updateOne(row)
    } catch (error) {
      failure = { name: row.name, reason: errorMessage(error) }
    }
    state = {
      done: state.done + 1,
      total: rows.length,
      failed: state.failed + (failure === undefined ? 0 : 1),
      failures: failure === undefined ? state.failures : [...state.failures, failure],
    }
    onProgress(state)
  }
  return state
}

/**
 * M16.3 — Updates — installed skills that are behind their upstream revision
 * (locked revision vs latest), with the change notes and a per-row Update
 * button that re-runs the install transaction for the same source/agents.
 */
export function UpdatesPage() {
  useDocumentTitle('Updates')
  const outdatedQuery = useOutdated()
  const update = useInstallRegistrySkill()
  const [updatingName, setUpdatingName] = useState<string | undefined>(undefined)
  const [batch, setBatch] = useState<BatchState | null>(null)

  const rows = outdatedQuery.data ?? []
  const highRiskCount = rows.filter((row) => row.securityRisk === 'high').length

  const runUpdate = (row: OutdatedSkill) => {
    setBatch(null)
    setUpdatingName(row.name)
    update.mutate(
      { source: row.source, targetAgents: row.agents, allowPolicy: 'safe' },
      {
        onSettled: () => setUpdatingName(undefined),
      },
    )
  }

  /**
   * Updates every outdated skill sequentially through the `safe` policy, so a
   * high-risk revision is blocked rather than installed and the batch keeps
   * going. The count in the confirm dialog tells the user how many will be
   * held back before anything runs.
   */
  const updateAll = async () => {
    const message =
      highRiskCount > 0
        ? `Update all ${rows.length} skill(s)? ${highRiskCount} high-risk revision(s) will be skipped by the safety policy.`
        : `Update all ${rows.length} skill(s)?`
    if (!window.confirm(message)) {
      return
    }
    // `runBatchUpdates` emits the initial 0/N state itself before the first row.
    await runBatchUpdates(
      rows,
      (row) => {
        setUpdatingName(row.name)
        return update.mutateAsync({
          source: row.source,
          targetAgents: row.agents,
          allowPolicy: 'safe',
        })
      },
      setBatch,
    )
    setUpdatingName(undefined)
  }

  const batchRunning = batch !== null && updatingName !== undefined

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
        {rows.length > 0 && (
          <div className="page-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void updateAll()}
              disabled={update.isPending}
              title="Update every outdated skill (high-risk revisions are skipped by the safety policy)"
            >
              {batchRunning ? <span className="spinner" /> : <ArrowUpCircle aria-hidden="true" />}
              {batch !== null ? `Updating ${batch.done}/${batch.total}` : 'Update all'}
            </button>
          </div>
        )}
      </header>

      {batch !== null && !batchRunning && (
        <p className="page-description path-muted">
          Batch finished — {batch.total - batch.failed} updated
          {batch.failed > 0 ? `, ${batch.failed} skipped or failed` : ''}.
        </p>
      )}

      {/* Every failed row keeps its own reason while the batch result is on
       * screen — it also grows while the loop still runs. */}
      <BatchFailureList failures={batch?.failures ?? []} />

      {/* A batch reports its failures row by row above, so the single-error
       * block (which can only ever name the last mutation) stays for the
       * per-row Update button. */}
      {update.isError && batch === null && (
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

/**
 * The "Update all" failure detail: one line per skill the batch could not
 * update, naming the skill and the reason the API reported. It follows the
 * live-region idiom of the global activity feed (`App.tsx`), so the reasons are
 * announced as they arrive and stay readable after the loop is gone — the
 * single mutation error can only ever name the last one.
 */
export function BatchFailureList({ failures }: { failures: BatchFailure[] }) {
  if (failures.length === 0) {
    return null
  }
  return (
    <div role="status" aria-live="polite">
      <ul className="finding-list">
        {failures.map((failure) => (
          <li key={failure.name} className="finding finding--high">
            <span className="finding-rule">{failure.name}</span>
            <span className="finding-message">{failure.reason}</span>
          </li>
        ))}
      </ul>
    </div>
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
