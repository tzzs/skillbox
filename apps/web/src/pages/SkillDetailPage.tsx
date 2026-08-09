import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Check, GitCompare, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { AgentSummary } from '../api.js'
import { errorMessage } from '../format.js'
import {
  useAgents,
  useRemoveSkill,
  useSaveSkillContent,
  useSkill,
  useSkillContent,
  useToggleSkill,
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
