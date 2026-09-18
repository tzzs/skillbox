import { Link, useNavigate } from 'react-router-dom'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { errorMessage } from '../format.js'
import { useSync, useSyncStatus } from '../queries.js'
import { CenteredHint, ErrorState } from '../components/States.js'
import { useDocumentTitle } from '../useDocumentTitle.js'

/**
 * The safe, one-click entry point for multi-device synchronization.
 * Connecting to GitHub (the device-flow handshake) stays a CLI-only step —
 * `skillbox connect` — run once per device; this page only covers ongoing
 * sync once that's done, and surfaces the connection state so a device that
 * has never connected gets a clear next step instead of a failed sync
 * attempt. A sync that needs a decision routes to
 * {@link ConflictResolutionPage} instead of applying anything silently.
 */
export function SyncPage() {
  useDocumentTitle('Sync')
  const navigate = useNavigate()
  const status = useSyncStatus()
  const sync = useSync()

  if (status.isLoading) return <CenteredHint>Checking sync status…</CenteredHint>
  if (status.isError)
    return (
      <section className="page">
        <ErrorState message={errorMessage(status.error)} />
      </section>
    )
  const view = status.data
  if (view === undefined) return null
  const { sync: value, connection } = view
  const syncDisabled = sync.isPending || !connection.connected

  const startSync = () =>
    sync.mutate(undefined, {
      onSuccess: (outcome) => {
        if (outcome.kind === 'conflicts')
          navigate(`/sync/conflicts/${encodeURIComponent(outcome.sessionId)}`)
      },
    })

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Multi-device</span>
          <h1 className="page-title">Sync</h1>
          <p className="page-description">
            Bring your skills and agent settings up to date across devices.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={startSync}
          disabled={syncDisabled}
          title={connection.connected ? undefined : 'Connect a GitHub account first'}
        >
          <RefreshCw aria-hidden="true" className={sync.isPending ? 'spin' : ''} />
          {sync.isPending ? 'Syncing…' : 'Sync now'}
        </button>
      </header>

      {sync.isError && <ErrorState message={errorMessage(sync.error)} />}

      {!connection.connected && (
        <div className="sync-card sync-card--warn">
          <h2>Not connected</h2>
          <p>
            This device hasn't connected a GitHub account yet. Run{' '}
            <code className="mono">skillbox connect</code> in a terminal on this machine, then come
            back here to sync.
          </p>
        </div>
      )}

      {connection.connected && (
        <div className="sync-card">
          {value.kind === 'conflicts' ? (
            <>
              <h2>Choices are needed</h2>
              <p>
                {value.conflictCount} change{value.conflictCount === 1 ? '' : 's'} need your review.
                A restore point was created before syncing.
              </p>
              <Link
                className="btn btn--primary"
                to={`/sync/conflicts/${encodeURIComponent(value.sessionId)}`}
              >
                Review changes
              </Link>
            </>
          ) : value.kind === 'completed' ? (
            <>
              <h2>Up to date</h2>
              <p>
                {value.automaticallyMerged === 0
                  ? 'Your devices already agree.'
                  : `${value.automaticallyMerged} change${value.automaticallyMerged === 1 ? '' : 's'} merged automatically.`}
              </p>
              {value.retriedPushes > 0 && (
                <p className="sync-subtle">We safely retried after another device changed first.</p>
              )}
            </>
          ) : value.kind === 'blocked' ? (
            <>
              <h2>Sync paused safely</h2>
              <p>{value.message}</p>
              {value.snapshotId !== undefined && (
                <p className="sync-subtle">A restore point is available if you need it.</p>
              )}
            </>
          ) : (
            <>
              <h2>Ready to sync</h2>
              <p>
                Sync checks for changes and preserves your current work before applying anything.
              </p>
            </>
          )}
        </div>
      )}

      {connection.connected && connection.login !== undefined && (
        <p className="sync-subtle">
          Connected as <strong>{connection.login}</strong>
          {connection.repository !== undefined ? ` · ${connection.repository}` : ''}
        </p>
      )}

      <div className="sync-note">
        <ShieldCheck aria-hidden="true" /> Your local work is protected by a restore point before
        changes are applied.
      </div>
    </section>
  )
}
