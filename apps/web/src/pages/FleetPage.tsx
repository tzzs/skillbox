import { useState, type FormEvent } from 'react'
import {
  Activity,
  ArrowLeftRight,
  Download,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import type {
  FleetHostConfig,
  FleetHostResult,
  FleetOperationName,
  FleetRunResult,
  FleetSkillTarget,
  SkillStatusEntry,
} from '../api.js'
import { errorMessage } from '../format.js'
import {
  useAddFleetHost,
  useFleetHosts,
  useFleetRun,
  useRemoveFleetHost,
  useUpdateFleetHost,
} from '../queries.js'
import { ModePill, StatusPill } from '../components/Pills.js'
import { CenteredHint, EmptyState, ErrorState } from '../components/States.js'
import { useDocumentTitle } from '../useDocumentTitle.js'

/** Editable fields shared by the "add host" and "edit host" forms. */
interface HostDraft {
  name: string
  host: string
  user: string
  port: string
  tags: string
}

const EMPTY_HOST_DRAFT: HostDraft = { name: '', host: '', user: '', port: '', tags: '' }

function hostToDraft(host: FleetHostConfig): HostDraft {
  return {
    name: host.name,
    host: host.host,
    user: host.user ?? '',
    port: host.port === undefined ? '' : String(host.port),
    tags: (host.tags ?? []).join(', '),
  }
}

/** Parses a {@link HostDraft} into the fields `addFleetHost`/`updateFleetHost` expect, or `undefined` for an invalid port. */
function draftToHostFields(draft: HostDraft): Omit<FleetHostConfig, 'name' | 'host'> | undefined {
  const fields: Omit<FleetHostConfig, 'name' | 'host'> = {}
  if (draft.user.trim() !== '') fields.user = draft.user.trim()
  if (draft.port.trim() !== '') {
    const port = Number(draft.port)
    if (!Number.isInteger(port) || port <= 0) {
      return undefined
    }
    fields.port = port
  }
  const tags = draft.tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
  if (tags.length > 0) fields.tags = tags
  return fields
}

/** Name/Host/User/Port/Tags fields shared by the "add host" and "edit host" forms. */
function HostFieldset({
  draft,
  onChange,
  idPrefix,
}: {
  draft: HostDraft
  onChange: (draft: HostDraft) => void
  idPrefix: string
}) {
  return (
    <div className="settings-row">
      <div className="field" style={{ flex: 1 }}>
        <label className="field-label" htmlFor={`${idPrefix}-name`}>
          Name
        </label>
        <input
          id={`${idPrefix}-name`}
          className="field-input"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          placeholder="web-1"
          required
        />
      </div>
      <div className="field" style={{ flex: 1 }}>
        <label className="field-label" htmlFor={`${idPrefix}-host`}>
          Host
        </label>
        <input
          id={`${idPrefix}-host`}
          className="field-input"
          value={draft.host}
          onChange={(event) => onChange({ ...draft, host: event.target.value })}
          placeholder="10.0.0.11"
          required
        />
      </div>
      <div className="field" style={{ flex: 1 }}>
        <label className="field-label" htmlFor={`${idPrefix}-user`}>
          User
        </label>
        <input
          id={`${idPrefix}-user`}
          className="field-input"
          value={draft.user}
          onChange={(event) => onChange({ ...draft, user: event.target.value })}
          placeholder="deploy"
        />
      </div>
      <div className="field" style={{ flex: 1 }}>
        <label className="field-label" htmlFor={`${idPrefix}-port`}>
          Port
        </label>
        <input
          id={`${idPrefix}-port`}
          className="field-input"
          type="number"
          min={1}
          max={65535}
          inputMode="numeric"
          value={draft.port}
          onChange={(event) => onChange({ ...draft, port: event.target.value })}
          placeholder="22"
        />
      </div>
      <div className="field" style={{ flex: 1 }}>
        <label className="field-label" htmlFor={`${idPrefix}-tags`}>
          Tags
        </label>
        <input
          id={`${idPrefix}-tags`}
          className="field-input"
          value={draft.tags}
          onChange={(event) => onChange({ ...draft, tags: event.target.value })}
          placeholder="prod, web"
        />
      </div>
    </div>
  )
}

/**
 * Fleet — orchestrates `skillbox install` / `update` / `status` on the
 * remote hosts listed in `.skillbox/fleet.yaml`, over SSH from the server
 * this Web UI runs on. Selecting no host runs the action on every configured
 * host; a per-host failure never blocks the others, so the result table
 * always shows one row per targeted host.
 */
export function FleetPage() {
  useDocumentTitle('Fleet')
  const hostsQuery = useFleetHosts()
  const run = useFleetRun()
  const addHost = useAddFleetHost()
  const updateHost = useUpdateFleetHost()
  const removeHost = useRemoveFleetHost()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [result, setResult] = useState<FleetRunResult | undefined>(undefined)
  const [addingHost, setAddingHost] = useState(false)
  const [hostDraft, setHostDraft] = useState<HostDraft>(EMPTY_HOST_DRAFT)
  const [editingHost, setEditingHost] = useState<string | undefined>(undefined)
  const [editDraft, setEditDraft] = useState<HostDraft>(EMPTY_HOST_DRAFT)
  const [confirmingRemoveHost, setConfirmingRemoveHost] = useState<string | undefined>(undefined)
  const [portInvalid, setPortInvalid] = useState(false)

  const hosts = hostsQuery.data ?? []

  function submitAddHost(event: FormEvent): void {
    event.preventDefault()
    const fields = draftToHostFields(hostDraft)
    if (fields === undefined) {
      setPortInvalid(true)
      return
    }
    addHost.mutate(
      { name: hostDraft.name.trim(), host: hostDraft.host.trim(), ...fields },
      {
        onSuccess: () => {
          setAddingHost(false)
          setHostDraft(EMPTY_HOST_DRAFT)
          setPortInvalid(false)
        },
      },
    )
  }

  function startEditHost(host: FleetHostConfig): void {
    setEditingHost(host.name)
    setEditDraft(hostToDraft(host))
    setPortInvalid(false)
  }

  function submitEditHost(event: FormEvent, name: string): void {
    event.preventDefault()
    const fields = draftToHostFields(editDraft)
    if (fields === undefined) {
      setPortInvalid(true)
      return
    }
    const patch: Partial<FleetHostConfig> = { host: editDraft.host.trim(), ...fields }
    if (editDraft.name.trim() !== name) {
      patch.name = editDraft.name.trim()
    }
    updateHost.mutate(
      { name, patch },
      {
        onSuccess: () => {
          setEditingHost(undefined)
          setPortInvalid(false)
        },
      },
    )
  }

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
    // Keep the previous result on screen while this one is in flight — e.g.
    // a per-skill action re-running `status` afterward — so the tables don't
    // flash empty and back.
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
            onClick={() => {
              setAddingHost((current) => !current)
              setHostDraft(EMPTY_HOST_DRAFT)
              setPortInvalid(false)
            }}
            title="Add a host to .skillbox/fleet.yaml"
          >
            <Plus aria-hidden="true" />
            Add host
          </button>
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
            className="btn"
            disabled={actionsDisabled}
            onClick={() => runOperation('sync')}
            title="Run `skillbox sync --multi-device` on the selected hosts — each must already be `skillbox connect`-ed"
          >
            {run.isPending ? <span className="spinner" /> : <ArrowLeftRight aria-hidden="true" />}
            Sync
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

      {addingHost && (
        <form className="settings-form" onSubmit={submitAddHost}>
          <HostFieldset draft={hostDraft} onChange={setHostDraft} idPrefix="add-host" />
          {portInvalid && (
            <p className="field-error" role="alert">
              Port must be a positive integer.
            </p>
          )}
          {addHost.isError && (
            <div className="form-error" role="alert">
              {errorMessage(addHost.error)}
            </div>
          )}
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={addHost.isPending}>
              {addHost.isPending ? <span className="spinner" /> : <Plus aria-hidden="true" />}
              Add host
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setAddingHost(false)
                setPortInvalid(false)
              }}
            >
              Cancel
            </button>
          </div>
        </form>
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
          body="Add a host above, or add .skillbox/fleet.yaml to this skill repository, to list the remote servers Fleet can install and update skills on over SSH."
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
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {hosts.map((host) =>
                editingHost === host.name ? (
                  <tr key={host.name}>
                    <td colSpan={6}>
                      <form
                        className="settings-form"
                        onSubmit={(event) => submitEditHost(event, host.name)}
                      >
                        <HostFieldset
                          draft={editDraft}
                          onChange={setEditDraft}
                          idPrefix={`edit-host-${host.name}`}
                        />
                        {portInvalid && (
                          <p className="field-error" role="alert">
                            Port must be a positive integer.
                          </p>
                        )}
                        {updateHost.isError && (
                          <div className="form-error" role="alert">
                            {errorMessage(updateHost.error)}
                          </div>
                        )}
                        <div className="form-actions">
                          <button
                            type="submit"
                            className="btn btn--primary btn--small"
                            disabled={updateHost.isPending}
                          >
                            {updateHost.isPending ? <span className="spinner" /> : null}
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => setEditingHost(undefined)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                ) : (
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
                    <td>
                      {confirmingRemoveHost === host.name ? (
                        <div className="form-actions">
                          <button
                            type="button"
                            className="btn btn--danger btn--small"
                            disabled={removeHost.isPending}
                            onClick={() =>
                              removeHost.mutate(host.name, {
                                onSuccess: () => setConfirmingRemoveHost(undefined),
                              })
                            }
                          >
                            {removeHost.isPending ? (
                              <span className="spinner" />
                            ) : (
                              <Trash2 aria-hidden="true" />
                            )}
                            Confirm
                          </button>
                          <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => setConfirmingRemoveHost(undefined)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="form-actions">
                          <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => startEditHost(host)}
                            title={`Edit ${host.name}`}
                          >
                            <Pencil aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="btn btn--danger btn--small"
                            onClick={() => setConfirmingRemoveHost(host.name)}
                            title={`Remove ${host.name}`}
                          >
                            <Trash2 aria-hidden="true" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      {removeHost.isError && (
        <div className="form-error" role="alert">
          {errorMessage(removeHost.error)}
        </div>
      )}

      {result !== undefined && <FleetResultTable result={result} />}

      {result?.operation === 'status' &&
        result.results.map((entry) => (
          <FleetHostSkills
            key={entry.host}
            entry={entry}
            onChanged={() => runOperation('status')}
          />
        ))}
    </section>
  )
}

export function fleetSummary(isLoading: boolean, hostCount: number, selectedCount: number): string {
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
                <td className="skill-message">{detailLine(entry, result.operation)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * First non-blank line of whichever stream best explains the outcome —
 * except a successful `status` run, whose single-line stdout *is* the full
 * skill-list JSON: showing it raw here would just repeat, illegibly, what
 * the per-host table below already renders properly.
 */
export function detailLine(entry: FleetHostResult, operation: FleetOperationName): string {
  if (entry.error !== undefined) {
    return entry.error
  }
  if (operation === 'status' && entry.ok) {
    const skills = parseRemoteSkills(entry)
    return skills === undefined ? 'ok (see below)' : `${skills.length} skill(s) — see below`
  }
  const text = entry.ok ? entry.stdout : entry.stderr || entry.stdout
  return text.split('\n').find((line) => line.trim() !== '') ?? ''
}

/**
 * `status` is the one Fleet operation run with `--json` (see
 * OPERATION_ARGS in packages/core/src/fleet/orchestrator.ts), so a
 * successful host's stdout is the same `RepositoryStatus` JSON the local
 * Library page already renders. Parsed defensively: a host running an
 * older skillbox build, a login-shell MOTD ahead of the JSON, or a
 * mid-stream SSH error all land here as unparseable stdout.
 */
export function parseRemoteSkills(entry: FleetHostResult): SkillStatusEntry[] | undefined {
  if (!entry.ok) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(entry.stdout)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { skills?: unknown }).skills)
    ) {
      return (parsed as { skills: SkillStatusEntry[] }).skills
    }
  } catch {
    // Fall through to undefined — rendered as "couldn't be read" below.
  }
  return undefined
}

/**
 * One host's skill inventory from a Fleet `status` run — the remote
 * counterpart to the Library table, with the same Remove / enable / disable
 * actions, each proxied over SSH to the CLI command already installed on
 * that host. `onChanged` re-runs `status` on every selected host after a
 * successful action, so the table reflects what actually happened remotely
 * instead of an optimistic local guess.
 */
function FleetHostSkills({ entry, onChanged }: { entry: FleetHostResult; onChanged: () => void }) {
  const skills = parseRemoteSkills(entry)
  const action = useFleetRun()
  const [confirmingRemove, setConfirmingRemove] = useState<string | undefined>(undefined)
  const [addingAgentFor, setAddingAgentFor] = useState<string | undefined>(undefined)
  const [agentDraft, setAgentDraft] = useState('')
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)

  function runSkillAction(
    key: string,
    operation: 'remove' | 'enable' | 'disable',
    target: FleetSkillTarget,
  ): void {
    setBusyKey(key)
    action.mutate(
      { operation, hosts: [entry.host], target },
      {
        onSuccess: () => {
          setBusyKey(undefined)
          setConfirmingRemove(undefined)
          setAddingAgentFor(undefined)
          setAgentDraft('')
          onChanged()
        },
        onError: () => setBusyKey(undefined),
      },
    )
  }

  function submitAgent(event: FormEvent, skillName: string): void {
    event.preventDefault()
    const agent = agentDraft.trim()
    if (agent.length === 0) {
      return
    }
    runSkillAction(`${skillName}:enable:${agent}`, 'enable', { name: skillName, agent })
  }

  return (
    <div className="fleet-results">
      <h2 className="section-title">
        {entry.host} — {skills === undefined ? 'skills' : `${skills.length} skill(s)`}
      </h2>
      {action.isError && (
        <div className="form-error" role="alert">
          {errorMessage(action.error)}
        </div>
      )}
      {skills === undefined ? (
        <p className="page-description">
          {entry.ok
            ? "Ran, but the output couldn't be read as a skill list."
            : 'This host failed to report status — see the run result above.'}
        </p>
      ) : skills.length === 0 ? (
        <p className="page-description">No skills declared in this host's repository.</p>
      ) : (
        <div className="table-wrap">
          <table className="skill-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Agents</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr key={skill.name}>
                  <td>
                    <div className="skill-name">{skill.name}</div>
                    {skill.message !== undefined && (
                      <div className="skill-message">{skill.message}</div>
                    )}
                  </td>
                  <td>
                    <ModePill mode={skill.mode} />
                  </td>
                  <td>
                    <StatusPill status={skill.status} />
                  </td>
                  <td>
                    <div className="agent-tags">
                      {skill.agents.length === 0 && addingAgentFor !== skill.name && (
                        <span className="empty-agents">no agents</span>
                      )}
                      {skill.agents.map((agent) => {
                        const key = `${skill.name}:disable:${agent}`
                        return (
                          <span className="agent-tag agent-tag--removable" key={agent}>
                            {agent}
                            <button
                              type="button"
                              className="agent-tag-remove"
                              disabled={busyKey !== undefined}
                              onClick={() =>
                                runSkillAction(key, 'disable', { name: skill.name, agent })
                              }
                              aria-label={`Disable ${skill.name} for ${agent}`}
                              title={`Disable for ${agent}`}
                            >
                              {busyKey === key ? (
                                <span className="spinner" />
                              ) : (
                                <X aria-hidden="true" />
                              )}
                            </button>
                          </span>
                        )
                      })}
                      {addingAgentFor === skill.name ? (
                        <form
                          className="agent-add-form"
                          onSubmit={(event) => submitAgent(event, skill.name)}
                        >
                          <input
                            className="field-input agent-add-input"
                            value={agentDraft}
                            onChange={(event) => setAgentDraft(event.target.value)}
                            placeholder="agent id…"
                            aria-label={`Agent to enable ${skill.name} for`}
                            autoFocus
                            disabled={busyKey !== undefined}
                          />
                          <button
                            type="submit"
                            className="btn btn--small"
                            disabled={busyKey !== undefined || agentDraft.trim().length === 0}
                          >
                            {busyKey?.startsWith(`${skill.name}:enable:`) === true ? (
                              <span className="spinner" />
                            ) : (
                              <Plus aria-hidden="true" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => {
                              setAddingAgentFor(undefined)
                              setAgentDraft('')
                            }}
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="agent-tag agent-tag--add"
                          onClick={() => setAddingAgentFor(skill.name)}
                          disabled={busyKey !== undefined}
                          title={`Enable ${skill.name} for another agent`}
                        >
                          <Plus aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </td>
                  <td>
                    {confirmingRemove === skill.name ? (
                      <div className="form-actions">
                        <button
                          type="button"
                          className="btn btn--danger btn--small"
                          disabled={busyKey !== undefined}
                          onClick={() =>
                            runSkillAction(`${skill.name}:remove`, 'remove', { name: skill.name })
                          }
                        >
                          {busyKey === `${skill.name}:remove` ? (
                            <span className="spinner" />
                          ) : (
                            <Trash2 aria-hidden="true" />
                          )}
                          Confirm
                        </button>
                        <button
                          type="button"
                          className="btn btn--small"
                          onClick={() => setConfirmingRemove(undefined)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--danger btn--small"
                        disabled={busyKey !== undefined}
                        onClick={() => setConfirmingRemove(skill.name)}
                      >
                        <Trash2 aria-hidden="true" />
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
