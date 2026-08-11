import { useEffect, useState, type FormEvent } from 'react'
import { RefreshCw } from 'lucide-react'
import type { LinkStrategy, SettingsPatch } from '../api.js'
import { errorMessage } from '../format.js'
import {
  useAgents,
  useHealth,
  useReconcile,
  useSaveSettings,
  useSettings,
  useStatus,
} from '../queries.js'
import { CenteredHint, ErrorState } from '../components/States.js'
import { THEME_PREFERENCES, useThemePreference, type ThemePreference } from '../theme.js'

const LINK_STRATEGIES: readonly LinkStrategy[] = ['auto', 'symlink', 'junction', 'copy']

interface MachineDraft {
  linkStrategy: LinkStrategy
  webPort: string
  webOpen: boolean
  agentPaths: Record<string, string>
}

/**
 * M11.6 + GAP 1.2 — Settings — repository identity, manifest/lockfile state and
 * maintenance actions, plus the editable Machine config (link strategy, web
 * server options and per-agent path overrides) persisted to `config.json`.
 */
export function SettingsPage() {
  const health = useHealth()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const agentsQuery = useAgents()
  const reconcile = useReconcile()
  const save = useSaveSettings()
  const [theme, setTheme] = useThemePreference()

  const agents = agentsQuery.data ?? []
  const settings = settingsQuery.data

  const [draft, setDraft] = useState<MachineDraft | null>(null)
  const [seededOverrides, setSeededOverrides] = useState<Record<string, string>>({})
  const [portError, setPortError] = useState(false)

  useEffect(() => {
    if (settings === undefined || draft !== null) {
      return
    }
    const overrides: Record<string, string> = {}
    for (const [id, entry] of Object.entries(settings.agents ?? {})) {
      if (entry !== null && typeof entry === 'object' && entry.path !== undefined) {
        overrides[id] = entry.path
      }
    }
    setSeededOverrides(overrides)
    setDraft({
      linkStrategy: settings.linkStrategy ?? 'auto',
      webPort: settings.web?.port === undefined ? '' : String(settings.web.port),
      webOpen: settings.web?.open ?? true,
      agentPaths: {},
    })
  }, [settings, draft])

  const setAgentPath = (id: string, value: string) => {
    setDraft((current) => {
      if (current === null) {
        return current
      }
      const next: Record<string, string> = { ...current.agentPaths }
      if (value.trim() === '') {
        delete next[id]
      } else {
        next[id] = value.trim()
      }
      return { ...current, agentPaths: next }
    })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (draft === null || save.isPending) {
      return
    }
    const port = Number(draft.webPort)
    const portInvalid =
      draft.webPort.trim() !== '' && (!Number.isInteger(port) || port < 1 || port > 65535)
    if (portInvalid) {
      setPortError(true)
      return
    }
    const patch: SettingsPatch = { linkStrategy: draft.linkStrategy }
    const web: { port?: number; open?: boolean } = {
      ...(draft.webPort.trim() !== '' ? { port } : {}),
      open: draft.webOpen,
    }
    const currentPort = settings?.web?.port
    const currentOpen = settings?.web?.open ?? true
    if (web.open !== currentOpen || (web.port ?? undefined) !== (currentPort ?? undefined)) {
      patch.web = web
    }
    const agentPatch: Record<string, { path: string }> = {}
    for (const agent of agents) {
      const value = draft.agentPaths[agent.id]
      if (value !== undefined) {
        agentPatch[agent.id] = { path: value }
      } else if (seededOverrides[agent.id] !== undefined) {
        agentPatch[agent.id] = { path: '' }
      }
    }
    if (Object.keys(agentPatch).length > 0) {
      patch.agents = agentPatch
    }
    save.mutate(patch)
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Settings</span>
          <h1 className="page-title">Settings</h1>
          <p className="page-description">
            Repository identity, manifest state, Machine configuration and maintenance actions.
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

      {health.isLoading || statusQuery.isLoading || settingsQuery.isLoading ? (
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

          <section className="settings-card" style={{ gridColumn: '1 / -1' }}>
            <h2>Appearance</h2>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="setting-theme">
                Theme
              </label>
              <select
                id="setting-theme"
                className="field-input"
                value={theme}
                onChange={(event) => setTheme(event.target.value as ThemePreference)}
              >
                {THEME_PREFERENCES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                System follows the OS color scheme. The choice is saved in this browser and applied
                on the next visit.
              </p>
            </div>
          </section>

          <section className="settings-card" style={{ gridColumn: '1 / -1' }}>
            <h2>Machine</h2>
            {settingsQuery.isError ? (
              <ErrorState message={errorMessage(settingsQuery.error)} />
            ) : draft === null ? (
              <CenteredHint>
                <div className="loading-row">
                  <span className="spinner" />
                  Preparing settings…
                </div>
              </CenteredHint>
            ) : (
              <form className="settings-form" onSubmit={submit}>
                <div className="field">
                  <label className="field-label" htmlFor="setting-link-strategy">
                    Link Strategy
                  </label>
                  <select
                    id="setting-link-strategy"
                    className="field-input"
                    value={draft.linkStrategy}
                    onChange={(event) =>
                      setDraft({ ...draft, linkStrategy: event.target.value as LinkStrategy })
                    }
                  >
                    {LINK_STRATEGIES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">
                    How Skillbox links managed skills into the agent skill directories.
                  </p>
                </div>

                <div className="settings-row">
                  <div className="field" style={{ flex: 1 }}>
                    <label className="field-label" htmlFor="setting-web-port">
                      Web Port
                    </label>
                    <input
                      id="setting-web-port"
                      className="field-input"
                      type="number"
                      min={1}
                      max={65535}
                      inputMode="numeric"
                      value={draft.webPort}
                      onChange={(event) => {
                        setPortError(false)
                        setDraft({ ...draft, webPort: event.target.value })
                      }}
                      placeholder="default"
                    />
                    {portError && (
                      <p className="field-error" role="alert">
                        The web port must be an integer between 1 and 65535.
                      </p>
                    )}
                  </div>
                  <label className="settings-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.webOpen}
                      onChange={(event) => setDraft({ ...draft, webOpen: event.target.checked })}
                    />
                    <span>Open the browser when the server starts</span>
                  </label>
                </div>

                <div className="field">
                  <span className="field-label">Agent path overrides</span>
                  {agents.length === 0 ? (
                    <p className="field-hint">No agents detected in the registry.</p>
                  ) : (
                    <div className="settings-agent-list">
                      {agents.map((agent) => {
                        const value = draft.agentPaths[agent.id] ?? ''
                        const changed = value !== (seededOverrides[agent.id] ?? '')
                        return (
                          <div key={agent.id} className="settings-agent-row">
                            <div className="settings-agent-id">
                              <span className="agent-name">{agent.name}</span>
                              <span className="agent-id">{agent.id}</span>
                            </div>
                            <input
                              className="field-input"
                              value={value}
                              onChange={(event) => setAgentPath(agent.id, event.target.value)}
                              placeholder="detected path (unset to auto-detect)"
                              aria-label={`Override path for ${agent.name}`}
                            />
                            <span className={`settings-agent-state${changed ? ' is-changed' : ''}`}>
                              {changed ? 'unsaved' : 'saved'}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <p className="field-hint">
                    An empty path resets the override and lets Skillbox auto-detect that agent.
                  </p>
                </div>

                {save.isError && (
                  <div className="form-error" role="alert">
                    {errorMessage(save.error)}
                  </div>
                )}

                <div className="form-actions">
                  <button type="submit" className="btn btn--primary" disabled={save.isPending}>
                    {save.isPending ? <span className="spinner" /> : null}
                    Save settings
                  </button>
                  {save.isSuccess && <span className="saved-note">Saved</span>}
                </div>
              </form>
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
