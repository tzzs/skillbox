import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, GitCompare, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { AgentSummary, LifecycleOperationResult, MergeAction } from '../api.js'
import { errorMessage } from '../format.js'
import {
  useAgents,
  useLifecycleAction,
  useMergeSkill,
  useRemoveSkill,
  useSaveSkillContent,
  useSkill,
  useSkillContent,
  useToggleSkill,
  useRestoreRollback,
  useRollbacks,
} from '../queries.js'
import { AgentTags, ModePill, SkillPath, StatusPill } from '../components/Pills.js'
import { CenteredHint, ErrorState } from '../components/States.js'

/**
 * M11.2 — Skill Detail — full status of one skill (path, mode, integrity,
 * agents) plus per-agent enable/disable, an inline markdown editor and the
 * config-only Remove action.
 */
export function SkillDetailPage() {
  const params = useParams()
  const name = params.name ?? ''
  const navigate = useNavigate()

  const skillQuery = useSkill(name)
  const contentQuery = useSkillContent(name)
  const agentsQuery = useAgents()
  const remove = useRemoveSkill()
  const save = useSaveSkillContent()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    if (skillQuery.isSuccess && !dirty) {
      setDraft(contentQuery.data?.markdown ?? '')
    }
  }, [skillQuery.isSuccess, contentQuery.data, dirty])

  if (name === '') {
    return (
      <CenteredHint>
        <Link to="/">Back to Library</Link>
      </CenteredHint>
    )
  }

  if (skillQuery.isLoading || contentQuery.isLoading || agentsQuery.isLoading) {
    return (
      <CenteredHint>
        <div className="loading-row">
          <span className="spinner" />
          Loading skill…
        </div>
      </CenteredHint>
    )
  }

  if (skillQuery.isError) {
    return (
      <section className="page">
        <ErrorState message={errorMessage(skillQuery.error)} />
        <p>
          <Link to="/">Back to Library</Link>
        </p>
      </section>
    )
  }

  const skill = skillQuery.data
  if (skill === undefined) {
    return null
  }

  const finishRemove = () => {
    remove.mutate(skill.name, {
      onSuccess: () => navigate('/'),
    })
  }

  const startEdit = () => {
    setDraft(contentQuery.data?.markdown ?? '')
    setDirty(false)
    setEditing(true)
  }

  const cancelEdit = () => {
    setDirty(false)
    setEditing(false)
  }

  const saveEdit = () => {
    save.mutate({ name: skill.name, content: draft }, { onSuccess: () => setDirty(false) })
  }

  const editorTouched = editing ? draft : (contentQuery.data?.markdown ?? '')

  return (
    <section className="page">
      <Link to="/" className="detail-anchor">
        <ArrowLeft aria-hidden="true" />
        Library
      </Link>

      <header className="page-header">
        <div>
          <span className="page-eyebrow">Skill</span>
          <div className="page-title-row">
            <h1 className="page-title">{skill.name}</h1>
            <StatusPill status={skill.status} />
            <ModePill mode={skill.mode} />
          </div>
          {skill.message !== undefined && <p className="page-description">{skill.message}</p>}
        </div>
        {(skill.mode === 'managed' || skill.mode === 'forked') && (
          <div className="page-actions">
            <Link to={`/skills/${encodeURIComponent(skill.name)}/diff`}>
              <span className="btn">
                <GitCompare aria-hidden="true" />
                View diff
              </span>
            </Link>
          </div>
        )}
      </header>

      <div className="card">
        <h2 className="card-title">Details</h2>
        <div className="detail-grid">
          <DetailItem label="Path" value={<SkillPath skill={skill} />} />
          <DetailItem label="Mode" value={<ModePill mode={skill.mode} />} />
          <DetailItem label="Status" value={<StatusPill status={skill.status} />} />
          <DetailItem
            label="Integrity"
            value={
              skill.integrity !== undefined ? (
                <span className="integrity" title={skill.integrity}>
                  {shortDigest(skill.integrity)}
                </span>
              ) : (
                <span className="path-muted">—</span>
              )
            }
          />
          <DetailItem
            label="Locked at"
            value={
              skill.lockIntegrity !== undefined ? (
                <span className="integrity" title={skill.lockIntegrity}>
                  {shortDigest(skill.lockIntegrity)}
                </span>
              ) : (
                <span className="path-muted">—</span>
              )
            }
          />
          <DetailItem label="Agents" value={<AgentTags agents={skill.agents} />} />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Agents</h2>
        <AgentToggleList
          agents={agentsQuery.data ?? []}
          enabled={skill.agents}
          skillName={skill.name}
        />
      </div>

      <div className="card">
        <div className="editor-toolbar">
          <h2 className="card-title" style={{ margin: 0 }}>
            SKILL.md
          </h2>
          <span style={{ flex: 1 }} />
          {editing ? (
            <>
              <button
                type="button"
                className="btn btn--primary"
                onClick={saveEdit}
                disabled={save.isPending}
              >
                {save.isPending ? <span className="spinner" /> : <Check aria-hidden="true" />}
                Save changes
              </button>
              <button type="button" className="btn" onClick={cancelEdit}>
                <X aria-hidden="true" />
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={startEdit}
              disabled={contentQuery.isError}
            >
              <Pencil aria-hidden="true" />
              Edit
            </button>
          )}
        </div>
        <div className="editor-box" style={{ marginTop: 14 }}>
          <textarea
            value={editorTouched}
            onChange={(event) => {
              if (editing) {
                setDraft(event.target.value)
                setDirty(true)
              }
            }}
            readOnly={!editing}
            aria-label={`Markdown for ${skill.name}`}
          />
        </div>
        {save.isSuccess && (
          <p className="saved-note">
            Saved — status is now “{save.data.status === 'ready' ? 'ready' : 'modified'}”.
          </p>
        )}
        {save.isError && <div className="form-error">{errorMessage(save.error)}</div>}
      </div>

      <div className="card">
        <LifecycleCard skill={skill} />
      </div>

      <div className="card">
        <RollbackCard skillName={skill.name} />
      </div>

      <div className="card">
        <h2 className="card-title">Danger zone</h2>
        <p className="page-description">
          Removing a skill updates the manifest and lockfile only; files on disk are kept.
        </p>
        {confirmRemove ? (
          <div className="form-actions">
            <button
              type="button"
              className="btn btn--danger"
              onClick={finishRemove}
              disabled={remove.isPending}
            >
              {remove.isPending ? <span className="spinner" /> : <Trash2 aria-hidden="true" />}
              Confirm remove
            </button>
            <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--danger btn--small"
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 aria-hidden="true" />
            Remove skill
          </button>
        )}
        {remove.isError && <div className="form-error">{errorMessage(remove.error)}</div>}
      </div>
    </section>
  )
}

function RollbackCard({ skillName }: { skillName: string }) {
  const backups = useRollbacks()
  const restore = useRestoreRollback()
  const relevant = (backups.data ?? []).filter((backup) => backup.alias === skillName)
  return (
    <>
      <h2 className="card-title">Rollback</h2>
      {relevant.length === 0 ? (
        <p className="page-description">No recoverable backups are available for this skill.</p>
      ) : (
        <div className="agent-toggle-list">
          {relevant.slice(0, 5).map((backup) => (
            <div className="agent-toggle-row" key={backup.id}>
              <div className="agent-toggle-info">
                <span className="agent-name">{backup.operation}</span>
                <span className="agent-id">{new Date(backup.createdAt).toLocaleString()}</span>
              </div>
              <button
                type="button"
                className="btn btn--small"
                disabled={restore.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Restore backup from ${new Date(backup.createdAt).toLocaleString()}?`,
                    )
                  )
                    restore.mutate(backup.id)
                }}
              >
                {restore.isPending ? <span className="spinner" /> : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      )}
      {restore.isSuccess && (
        <p className="saved-note">Rollback restored {restore.data.filesRestored} files.</p>
      )}
      {restore.isError && <div className="form-error">{errorMessage(restore.error)}</div>}
    </>
  )
}

function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="detail-item">
      <span className="detail-label">{label}</span>
      <span className="detail-value">{value}</span>
    </div>
  )
}

function AgentToggleList({
  agents,
  enabled,
  skillName,
}: {
  agents: AgentSummary[]
  enabled: string[]
  skillName: string
}) {
  const toggle = useToggleSkill()
  if (agents.length === 0) {
    return (
      <p className="page-description">
        No agents detected in the registry. Enable this skill from a terminal with{' '}
        <code>skillbox enable {skillName} --agent &lt;agent&gt;</code>.
      </p>
    )
  }
  return (
    <div className="agent-toggle-list">
      {agents.map((agent) => {
        const isEnabled = enabled.includes(agent.id)
        const pending = toggle.isPending && toggle.variables?.agent === agent.id
        return (
          <div key={agent.id} className="agent-toggle-row">
            <div className="agent-toggle-info">
              <span className="agent-name">{agent.name}</span>
              <span className="agent-id">{agent.id}</span>
            </div>
            <button
              type="button"
              className={`btn btn--small${isEnabled ? ' btn--danger' : ' btn--primary'}`}
              onClick={() =>
                toggle.mutate({ name: skillName, agent: agent.id, enable: !isEnabled })
              }
              disabled={pending}
            >
              {pending ? (
                <span className="spinner" />
              ) : isEnabled ? (
                <X aria-hidden="true" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              {isEnabled ? 'Disable' : 'Enable'}
            </button>
          </div>
        )
      })}
      {toggle.isError && <div className="form-error">{errorMessage(toggle.error)}</div>}
    </div>
  )
}

function shortDigest(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}

type LifecycleActionKind = 'fork' | 'vendor' | 'restore' | 'merge' | 'continue' | 'abort'

interface LifecycleCandidate {
  kind: LifecycleActionKind
  label: string
  hint: string
}

/**
 * M17/M18/M20 — lifecycle actions for one skill. The available actions follow
 * the mode/status state machine: managed skills can fork / restore / vendor /
 * merge; forked skills can vendor / merge; a skill in conflict state can
 * continue or abort an in-flight merge. Every action runs through the
 * Core-backed web API (and the cross-process mutation lock server-side).
 */
function LifecycleCard({ skill }: { skill: { name: string; mode: string; status: string } }) {
  const fork = useLifecycleAction('fork')
  const vendor = useLifecycleAction('vendor')
  const restore = useLifecycleAction('restore')
  const merge = useMergeSkill()
  const [pending, setPending] = useState<LifecycleActionKind | null>(null)
  const [result, setResult] = useState<LifecycleOperationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const candidates: LifecycleCandidate[] = []
  if (skill.mode === 'managed') {
    candidates.push({
      kind: 'fork',
      label: 'Convert to fork',
      hint: 'Copy the runtime into the repository and keep local edits.',
    })
    candidates.push({
      kind: 'restore',
      label: 'Restore upstream',
      hint: 'Re-fetch the pinned revision — local edits are replaced (a recovery snapshot is kept).',
    })
  }
  if (skill.mode === 'managed' || skill.mode === 'forked') {
    candidates.push({
      kind: 'vendor',
      label: 'Vendor',
      hint: 'Freeze the content in the repository and drop upstream tracking (terminal).',
    })
    candidates.push({
      kind: 'merge',
      label: 'Merge upstream',
      hint: '3-way merge the latest upstream revision against the base.',
    })
  }
  if (skill.status === 'conflict') {
    candidates.push({
      kind: 'continue',
      label: 'Continue merge',
      hint: 'Finish the merge after resolving the conflicts manually.',
    })
    candidates.push({
      kind: 'abort',
      label: 'Abort merge',
      hint: 'Restore the pre-merge state.',
    })
  }

  const dispatch = (kind: LifecycleActionKind): void => {
    setError(null)
    setResult(null)
    const onSuccess = (data: LifecycleOperationResult): void => {
      setPending(null)
      setResult(data)
    }
    const onError = (err: unknown): void => {
      setPending(null)
      setError(errorMessage(err))
    }
    switch (kind) {
      case 'fork':
        fork.mutate(skill.name, { onSuccess, onError })
        break
      case 'vendor':
        vendor.mutate(skill.name, { onSuccess, onError })
        break
      case 'restore':
        restore.mutate(skill.name, { onSuccess, onError })
        break
      case 'merge':
      case 'continue':
      case 'abort':
        merge.mutate({ name: skill.name, action: kind as MergeAction }, { onSuccess, onError })
        break
    }
  }

  const busy = fork.isPending || vendor.isPending || restore.isPending || merge.isPending

  return (
    <div>
      <h2 className="card-title">Lifecycle</h2>
      <p className="page-description">
        Fork / vendor / restore / merge change the skill&apos;s mode and how it tracks upstream.
      </p>
      {candidates.length === 0 && (
        <p className="page-description">No lifecycle actions for a {skill.mode} skill.</p>
      )}
      {candidates.length > 0 && (
        <div className="agent-toggle-list">
          {candidates.map((candidate) => {
            const isPending = pending === candidate.kind
            return (
              <div key={candidate.kind} className="agent-toggle-row">
                <div className="agent-toggle-info">
                  <span className="agent-name">{candidate.label}</span>
                  <span className="agent-id">{candidate.hint}</span>
                </div>
                {isPending ? (
                  <div className="form-actions" style={{ margin: 0 }}>
                    <button
                      type="button"
                      className="btn btn--primary btn--small"
                      onClick={() => dispatch(candidate.kind)}
                      disabled={busy}
                    >
                      {busy ? <span className="spinner" /> : <Check aria-hidden="true" />}
                      Confirm
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setPending(null)}
                      disabled={busy}
                    >
                      <X aria-hidden="true" />
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => {
                      setPending(candidate.kind)
                      setError(null)
                    }}
                    disabled={busy}
                  >
                    Run
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {result !== null && (
        <p className="saved-note">
          <LifecycleResultSummary result={result} />
        </p>
      )}
      {error !== null && <div className="form-error">{error}</div>}
    </div>
  )
}

/** Human summary of a lifecycle outcome (fork / vendor / restore / merge). */
function LifecycleResultSummary({ result }: { result: LifecycleOperationResult }) {
  switch (result.action) {
    case 'forked':
      return (
        <>
          Forked — now at {result.localPath ?? 'the repository'} (base {result.revision}).
        </>
      )
    case 'vendored':
      return <>Vendored — content frozen at {result.localPath ?? 'the repository'}.</>
    case 'restored':
      return (
        <>
          Restored {result.filesRestored ?? 0} file(s) to the pinned revision{' '}
          {result.revision ?? ''} — the runtime is pristine again.
        </>
      )
    case 'merged':
      if ((result.conflicts ?? []).length > 0) {
        return (
          <>
            Merge left {result.conflicts?.length} conflicted file(s) — resolve them, then use{' '}
            <strong>Continue merge</strong> or <strong>Abort merge</strong>.
          </>
        )
      }
      return <>Merged {result.filesMerged ?? 0} file(s) (base updated).</>
    case 'continued':
      if ((result.conflicts ?? []).length > 0) {
        return (
          <>
            Merge is still in conflict ({result.conflicts?.length} file(s)) — resolve and continue
            again, or abort.
          </>
        )
      }
      return <>Merge completed — {result.filesMerged ?? 0} file(s) updated.</>
    case 'aborted':
      return <>Merge aborted — restored {result.filesRestored ?? 0} file(s).</>
  }
}
