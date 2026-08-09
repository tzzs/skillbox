import { RefreshCw } from 'lucide-react'
import { errorMessage } from '../format.js'
import { useHealth, useReconcile, useStatus } from '../queries.js'
import { CenteredHint, ErrorState } from '../components/States.js'

/**
 * M11.6 — Settings — repository identity, manifest/lockfile state and a
 * one-click Reconcile for the whole repository.
 */
export function SettingsPage() {
  const health = useHealth()
  const statusQuery = useStatus()
  const reconcile = useReconcile()

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-description">
            Repository identity, manifest state and maintenance actions.
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            onClick={() => reconcile.mutate()}
            disabled={reconcile.isPending}
            title="Reconcile the repository (install / manage agent links)"
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

      {health.isLoading || statusQuery.isLoading ? (
        <CenteredHint>
          <div className="loading-row">
            <span className="spinner" />
            Loading settings…
          </div>
        </CenteredHint>
      ) : (
        <div className="settings-grid">
          <section className="settings-card">
            <h2>Server</h2>
            {health.isError ? (
              <ErrorState message={errorMessage(health.error)} />
            ) : (
              <>
                <StatRow label="Product" value={health.data?.name ?? 'skillbox'} />
                <StatRow label="Version" value={health.data?.version ?? '—'} />
                <StatRow label="Repository" value={health.data?.repository ?? '—'} mono />
                <StatRow label="Home" value={health.data?.home ?? '—'} mono />
              </>
            )}
          </section>

          <section className="settings-card">
            <h2>Repository</h2>
            {statusQuery.isError ? (
              <ErrorState message={errorMessage(statusQuery.error)} />
            ) : statusQuery.data === undefined ? null : (
              <>
                <StatRow
                  label="Manifest"
                  value={statusQuery.data.manifestPresent ? 'present' : 'missing'}
                />
                <StatRow label="Manifest path" value={statusQuery.data.manifestPath} mono />
                <StatRow
                  label="Lockfile"
                  value={statusQuery.data.lockfilePresent ? 'present' : 'missing'}
                />
                <StatRow label="Lockfile path" value={statusQuery.data.lockfilePath} mono />
                <StatRow label="Skills" value={String(statusQuery.data.skills.length)} />
                <StatRow label="Modified" value={String(statusQuery.data.modified.length)} />
                <StatRow label="Broken" value={String(statusQuery.data.broken.length)} />
                <StatRow label="Agents" value={String(statusQuery.data.agents.length)} />
              </>
            )}
          </section>
        </div>
      )}

      <section className="settings-card" style={{ marginTop: 20 }}>
        <h2>Maintenance</h2>
        <p className="page-description">
          Reconcile installs every declared skill into the runtime library and creates or removes
          the managed links in each agent&apos;s skill directory.
        </p>
        <div className="form-actions" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => reconcile.mutate()}
            disabled={reconcile.isPending}
          >
            {reconcile.isPending ? <span className="spinner" /> : <RefreshCw aria-hidden="true" />}
            Reconcile repository
          </button>
          {reconcile.isSuccess && (
            <span className="saved-note">
              Reconciled{reconcile.data?.changed === true ? ' — changes applied' : ''} —{' '}
              {reconcile.data?.problems.length ?? 0} problem
              {(reconcile.data?.problems.length ?? 0) === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </section>
    </section>
  )
}

function StatRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className={mono ? 'stat-badge' : 'stat-value'}>{value}</span>
    </div>
  )
}
