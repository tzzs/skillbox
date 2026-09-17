import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import type { ConflictChoice, SyncConflictView } from '../api.js'
import { errorMessage } from '../format.js'
import { useConflict, useResolveConflicts, useRestoreSyncSnapshot } from '../queries.js'
import { CenteredHint, ErrorState } from '../components/States.js'
import { useDocumentTitle } from '../useDocumentTitle.js'

const CHOICE_LABELS: Record<ConflictChoice, string> = {
  local: 'Use this device',
  remote: 'Use other device',
  'keep-both': 'Keep both',
  delete: 'Remove it',
  restore: 'Restore it',
  merged: 'Use combined result',
}

/**
 * One open conflict session (routed from {@link SyncPage} at `/sync/conflicts/:id`):
 * a choice per conflicting item, applied together with "Apply choices". A
 * choice that can discard a version asks for one extra confirm click; the
 * restore point created before sync stays available either way.
 */
export function ConflictResolutionPage() {
  const id = useParams().id ?? ''
  useDocumentTitle(id === '' ? 'Review changes' : `Review ${id}`)
  const navigate = useNavigate()
  const session = useConflict(id)
  const resolve = useResolveConflicts(id)
  const restore = useRestoreSyncSnapshot()
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({})
  const [confirming, setConfirming] = useState(false)

  const data = session.data
  const allChosen = useMemo(
    () => data?.conflicts.every((item) => choices[item.id] !== undefined) ?? false,
    [choices, data],
  )
  const destructive = useMemo(
    () =>
      data?.conflicts.some((item) => item.destructive && choices[item.id] !== undefined) ?? false,
    [choices, data],
  )

  if (session.isLoading) {
    return <CenteredHint>Loading changes…</CenteredHint>
  }
  if (session.isError) {
    return (
      <section className="page">
        <ErrorState message={errorMessage(session.error)} />
      </section>
    )
  }
  if (data === undefined) {
    return null
  }

  function applyChoices(): void {
    resolve.mutate(
      { resolutions: choices },
      {
        onSuccess: (outcome) => {
          setConfirming(false)
          navigate(
            outcome.kind === 'conflicts'
              ? `/sync/conflicts/${encodeURIComponent(outcome.sessionId)}`
              : '/sync',
          )
        },
      },
    )
  }

  function submit(): void {
    if (destructive && !confirming) {
      setConfirming(true)
      return
    }
    applyChoices()
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
            Choose what to keep for each item below, then apply them together.
          </p>
        </div>
      </header>

      {resolve.isError && <ErrorState message={errorMessage(resolve.error)} />}
      {restore.isError && <ErrorState message={errorMessage(restore.error)} />}

      <div className="sync-restore">
        <span>Restore point created before sync</span>
        <button
          type="button"
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
          type="button"
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
            aria-labelledby="destructive-confirm-title"
          >
            <h2 id="destructive-confirm-title">Confirm change</h2>
            <p>
              One or more of your choices discards a version. Your restore point stays available
              either way.
            </p>
            <div className="form-actions">
              <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                autoFocus
                disabled={resolve.isPending}
                onClick={applyChoices}
              >
                {resolve.isPending ? 'Applying…' : 'Apply choices'}
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
  onChoose: (choice: ConflictChoice) => void
}) {
  const title = conflict.skillAlias ?? conflict.path ?? 'Setting'
  return (
    <article className="card conflict-card">
      <div className="conflict-card-head">
        <div>
          <h2 className="card-title">{title}</h2>
          <p className="page-description">{explain(conflict)}</p>
        </div>
        {conflict.recommendedResolution !== undefined && (
          <span className="pill pill--mode">
            Recommended: {CHOICE_LABELS[conflict.recommendedResolution]}
          </span>
        )}
      </div>
      {(conflict.localPreview !== undefined || conflict.remotePreview !== undefined) && (
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
            {CHOICE_LABELS[resolution]}
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

function explain(conflict: SyncConflictView): string {
  if (conflict.type === 'delete-modify') {
    return 'One device removed this skill while the other changed it — choose whether to keep the change.'
  }
  if (conflict.type === 'mode' || conflict.type === 'source' || conflict.type === 'lifecycle') {
    return `Both devices changed how this skill is managed${conflict.field !== undefined ? ` (${conflict.field})` : ''} — choose one setup.`
  }
  if (conflict.type === 'manifest-field' && conflict.field !== undefined) {
    return `Both devices changed "${conflict.field}".`
  }
  return conflict.path !== undefined
    ? `Both devices changed ${conflict.path}.`
    : 'Both devices changed this at the same time.'
}
