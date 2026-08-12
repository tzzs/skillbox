import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import type { ConflictChoice, SyncConflictView } from '../api.js'
import { errorMessage } from '../format.js'
import { useConflict, useResolveConflicts, useRestoreSyncSnapshot } from '../queries.js'
import { CenteredHint, ErrorState } from '../components/States.js'

const LABELS: Record<ConflictChoice, string> = {
  local: 'Use this device',
  remote: 'Use other device',
  'keep-both': 'Keep both',
  delete: 'Remove it',
  restore: 'Restore it',
  merged: 'Use combined result',
}

export function ConflictResolutionPage() {
  const id = useParams().id ?? ''
  const navigate = useNavigate()
  const session = useConflict(id)
  const resolve = useResolveConflicts(id)
  const restore = useRestoreSyncSnapshot()
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({})
  const [confirming, setConfirming] = useState(false)

  const allChosen = useMemo(
    () => session.data?.conflicts.every((item) => choices[item.id] !== undefined) ?? false,
    [choices, session.data],
  )
  if (session.isLoading) return <CenteredHint>Loading changes…</CenteredHint>
  if (session.isError)
    return (
      <section className="page">
        <ErrorState message={errorMessage(session.error)} />
      </section>
    )
  if (session.data === undefined) return null
  const data = session.data
  const destructive = data.conflicts.some(
    (item) => item.destructive && choices[item.id] !== undefined,
  )

  const submit = () => {
    if (destructive && !confirming) {
      setConfirming(true)
      return
    }
    resolve.mutate(
      { resolutions: choices },
      {
        onSuccess: (outcome) =>
          navigate(
            outcome.kind === 'conflicts'
              ? `/sync/conflicts/${encodeURIComponent(outcome.sessionId)}`
              : '/sync',
          ),
      },
    )
  }

  return (
    <section className="page">
      <Link to="/sync" className="detail-anchor">
        <ArrowLeft aria-hidden="true" />
        Sync
      </Link>
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Multi-device</span>
          <h1 className="page-title">Review changes</h1>
          <p className="page-description">
            Choose what to keep for each item. Your existing state is protected by a restore point.
          </p>
        </div>
      </header>
      {resolve.isError && <ErrorState message={errorMessage(resolve.error)} />}
      {restore.isError && <ErrorState message={errorMessage(restore.error)} />}
      <div className="sync-restore">
        <span>Restore point created before sync</span>
        <button
          className="btn btn--ghost btn--small"
          onClick={() => restore.mutate(data.snapshotId)}
          disabled={restore.isPending}
        >
          <RotateCcw aria-hidden="true" />
          {restore.isPending ? 'Restoring…' : 'Restore'}
        </button>
      </div>
      <div className="conflict-list">
        {data.conflicts.map((conflict) => (
          <ConflictCard
            key={conflict.id}
            conflict={conflict}
            choice={choices[conflict.id]}
            onChoose={(choice) => setChoices((current) => ({ ...current, [conflict.id]: choice }))}
          />
        ))}
      </div>
      <div className="form-actions">
        <button
          className="btn btn--primary"
          onClick={submit}
          disabled={!allChosen || resolve.isPending}
        >
          {resolve.isPending ? 'Applying…' : 'Apply choices'}
        </button>
      </div>
      {confirming && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="destructive-title"
          >
            <h2 id="destructive-title">Confirm change</h2>
            <p>One or more choices can discard a version. Your restore point remains available.</p>
            <div className="form-actions">
              <button className="btn btn--ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                className="btn btn--danger"
                autoFocus
                onClick={() => {
                  setConfirming(false)
                  resolve.mutate({ resolutions: choices }, { onSuccess: () => navigate('/sync') })
                }}
              >
                Apply choices
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function ConflictCard({
  conflict,
  choice,
  onChoose,
}: {
  conflict: SyncConflictView
  choice: ConflictChoice | undefined
  onChoose(choice: ConflictChoice): void
}) {
  const title = conflict.skillAlias ?? conflict.path ?? 'Skill setting'
  return (
    <article className="card conflict-card">
      <div className="conflict-card-head">
        <div>
          <h2 className="card-title">{title}</h2>
          <p className="page-description">{explanation(conflict)}</p>
        </div>
        {conflict.recommendedResolution && (
          <span className="pill pill--mode">
            Recommended: {LABELS[conflict.recommendedResolution]}
          </span>
        )}
      </div>
      {(conflict.localPreview || conflict.remotePreview) && (
        <details>
          <summary>View differences</summary>
          <div className="conflict-diff">
            <Preview label="This device" value={conflict.localPreview} />
            <Preview label="Other device" value={conflict.remotePreview} />
          </div>
        </details>
      )}
      <fieldset className="conflict-choices">
        <legend>Choose a version</legend>
        {conflict.allowedResolutions.map((resolution) => (
          <label
            key={resolution}
            className={`conflict-choice${choice === resolution ? ' conflict-choice--selected' : ''}`}
          >
            <input
              type="radio"
              name={conflict.id}
              checked={choice === resolution}
              onChange={() => onChoose(resolution)}
            />
            {LABELS[resolution]}
          </label>
        ))}
      </fieldset>
    </article>
  )
}

function Preview({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <h3>{label}</h3>
      <pre className="diff-patch">{value ?? 'No preview available.'}</pre>
    </div>
  )
}
function explanation(conflict: SyncConflictView): string {
  if (conflict.type === 'delete-modify')
    return 'One device removed this skill while the other changed it. Choose whether to keep the changed version.'
  if (conflict.type === 'mode' || conflict.type === 'source' || conflict.type === 'lifecycle')
    return `The two devices changed how this skill is managed${conflict.field ? ` (${conflict.field})` : ''}. Choose one safe setup.`
  return conflict.path
    ? `Both devices changed ${conflict.path}.`
    : 'Both devices changed the same setting.'
}
