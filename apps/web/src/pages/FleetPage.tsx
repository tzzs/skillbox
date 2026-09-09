import { useState } from 'react'
import { Activity, Download, RefreshCw } from 'lucide-react'
import type { FleetHostResult, FleetOperationName, FleetRunResult } from '../api.js'
import { errorMessage } from '../format.js'
import { useFleetHosts, useFleetRun } from '../queries.js'
import { CenteredHint, EmptyState, ErrorState } from '../components/States.js'

/**
 * Fleet — orchestrates `skillbox install` / `update` / `status` on the
 * remote hosts listed in `.skillbox/fleet.yaml`, over SSH from the server
 * this Web UI runs on. Selecting no host runs the action on every configured
 * host; a per-host failure never blocks the others, so the result table
 * always shows one row per targeted host.
 */
export function FleetPage() {
  const hostsQuery = useFleetHosts()
  const run = useFleetRun()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [result, setResult] = useState<FleetRunResult | undefined>(undefined)

  const hosts = hostsQuery.data ?? []

  function toggle(name: string): void {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  function runOperation(operation: FleetOperationName): void {
    setResult(undefined)
    run.mutate(
      { operation, ...(selected.size > 0 ? { hosts: [...selected] } : {}) },
      { onSuccess: setResult },
    )
  }

  const actionsDisabled = run.isPending || hosts.length === 0

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Fleet</span>
          <h1 className="page-title">Fleet</h1>
          <p className="page-description">
            {fleetSummary(hostsQuery.isLoading, hosts.length, selected.size)}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            disabled={actionsDisabled}
            onClick={() => runOperation('status')}
            title="Run `skillbox status --json` on the selected hosts"
          >
            {run.isPending ? <span className="spinner" /> : <Activity aria-hidden="true" />}
            Status
          </button>
          <button
            type="button"
            className="btn"
            disabled={actionsDisabled}
            onClick={() => runOperation('update')}
            title="Run `skillbox update` on the selected hosts"
          >
            {run.isPending ? <span className="spinner" /> : <RefreshCw aria-hidden="true" />}
            Update
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={actionsDisabled}
            onClick={() => runOperation('install')}
            title="Run `skillbox install` on the selected hosts"
          >
            {run.isPending ? <span className="spinner" /> : <Download aria-hidden="true" />}
            Install
          </button>
        </div>
      </header>

      {run.isError && (
        <div className="form-error" role="alert">
          <strong>Fleet run failed</strong>
          <p>{errorMessage(run.error)}</p>
        </div>
      )}

      {hostsQuery.isError && <ErrorState message={errorMessage(hostsQuery.error)} />}

      {hostsQuery.isLoading ? (
        <CenteredHint>
          <div className="loading-row">
            <span className="spinner" />
            Loading fleet.yaml…
          </div>
        </CenteredHint>
      ) : hosts.length === 0 ? (
        <EmptyState
          title="No fleet hosts"
          body="Add .skillbox/fleet.yaml to this skill repository to list the remote servers Fleet can install and update skills on over SSH."
        />
      ) : (
        <div className="table-wrap">
          <table className="skill-table">
            <thead>
              <tr>
                <th aria-label="Select" />
                <th>Name</th>
                <th>Host</th>
                <th>User</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((host) => (
                <tr key={host.name}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(host.name)}
                      onChange={() => toggle(host.name)}
                      aria-label={`Select ${host.name}`}
                    />
                  </td>
                  <td>{host.name}</td>
                  <td>
                    <code className="registry-meta-version">
                      {host.host}
                      {host.port !== undefined ? `:${host.port}` : ''}
                    </code>
                  </td>
                  <td>{host.user ?? <span className="path-muted">-</span>}</td>
                  <td>
                    {host.tags !== undefined && host.tags.length > 0 ? (
                      host.tags.join(', ')
                    ) : (
                      <span className="path-muted">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result !== undefined && <FleetResultTable result={result} />}
    </section>
  )
}

function fleetSummary(isLoading: boolean, hostCount: number, selectedCount: number): string {
  if (isLoading) {
    return 'Loading fleet.yaml…'
  }
  if (hostCount === 0) {
    return 'No fleet hosts configured.'
  }
  if (selectedCount === 0) {
    return `${hostCount} host${hostCount === 1 ? '' : 's'} configured — none selected, actions target all of them`
  }
  return `${selectedCount} of ${hostCount} host${hostCount === 1 ? '' : 's'} selected`
}

function FleetResultTable({ result }: { result: FleetRunResult }) {
  const failed = result.results.filter((entry) => !entry.ok).length
  return (
    <div className="fleet-results">
      <h2 className="section-title">
        {result.operation} result —{' '}
        {failed === 0
          ? `all ${result.results.length} host(s) succeeded`
          : `${failed} of ${result.results.length} host(s) failed`}
      </h2>
      <div className="table-wrap">
        <table className="skill-table">
          <thead>
            <tr>
              <th>Host</th>
              <th>Status</th>
              <th>Exit</th>
              <th>Duration</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {result.results.map((entry) => (
              <tr key={entry.host}>
                <td>{entry.host}</td>
                <td>
                  <span
                    className={`pill pill--status ${entry.ok ? 'status-ready' : 'status-broken'}`}
                  >
                    {entry.ok ? 'ok' : 'failed'}
                  </span>
                </td>
                <td>{entry.exitCode ?? '-'}</td>
                <td>{entry.durationMs}ms</td>
                <td className="skill-message">{detailLine(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** First non-blank line of whichever stream best explains the outcome. */
function detailLine(entry: FleetHostResult): string {
  if (entry.error !== undefined) {
    return entry.error
  }
  const text = entry.ok ? entry.stdout : entry.stderr || entry.stdout
  return text.split('\n').find((line) => line.trim() !== '') ?? ''
}
