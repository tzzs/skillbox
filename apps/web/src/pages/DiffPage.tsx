import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import type { SkillDiffView, SkillFileDiff } from '../api.js'
import { errorMessage } from '../format.js'
import { useSkillDiff } from '../queries.js'
import { ModePill } from '../components/Pills.js'
import { CenteredHint, EmptyState, ErrorState } from '../components/States.js'

/**
 * M19.5 — Skill Diff — the web view of `skillbox diff <name>`:
 * - unchanged → a "No changes" empty state;
 * - managed → a single `Current vs Latest` view;
 * - forked → three sections (Base vs Local / Local vs Latest / Base vs Latest).
 * Unified-diff patches render in `<pre>` blocks; binary files show a marker
 * only, never their content. Status badges use added / modified / deleted
 * colors.
 */
export function DiffPage() {
  const params = useParams()
  const name = params.name ?? ''
  const diffQuery = useSkillDiff(name)

  if (name === '') {
    return (
      <CenteredHint>
        <Link to="/">Back to Library</Link>
      </CenteredHint>
    )
  }

  if (diffQuery.isLoading) {
    return (
      <CenteredHint>
        <div className="loading-row">
          <span className="spinner" />
          Computing diff…
        </div>
      </CenteredHint>
    )
  }

  if (diffQuery.isError) {
    return (
      <section className="page">
        <header className="page-header">
          <div>
            <span className="page-eyebrow">Diff</span>
            <h1 className="page-title">{name}</h1>
          </div>
        </header>
        <ErrorState message={errorMessage(diffQuery.error)} />
        <p>
          <Link to={`/skills/${encodeURIComponent(name)}`} className="detail-anchor">
            <ArrowLeft aria-hidden="true" />
            Back to {name}
          </Link>
        </p>
      </section>
    )
  }

  const diff = diffQuery.data
  if (diff === undefined) {
    return null
  }

  const skillHref = `/skills/${encodeURIComponent(diff.name)}`

  return (
    <section className="page">
      <Link to={skillHref} className="detail-anchor">
        <ArrowLeft aria-hidden="true" />
        {diff.name}
      </Link>

      <header className="page-header">
        <div>
          <span className="page-eyebrow">Diff</span>
          <div className="page-title-row">
            <h1 className="page-title">Diff</h1>
            <ModePill mode={diff.mode} />
          </div>
          <p className="page-description">
            {diff.unchanged
              ? `${diff.name} matches the upstream exactly.`
              : `${diff.name} — changes against the upstream`}
          </p>
        </div>
      </header>

      {diff.unchanged ? (
        <EmptyState
          title="No changes"
          body={`${diff.name} is up to date — no differences against the upstream were found.`}
          action={
            <Link to={skillHref}>
              <span className="btn">Back to {diff.name}</span>
            </Link>
          }
        />
      ) : (
        diff.views.map((view) => <DiffViewCard key={view.label} view={view} />)
      )}
    </section>
  )
}

function DiffViewCard({ view }: { view: SkillDiffView }) {
  return (
    <div className="card">
      <h2 className="card-title">{view.label}</h2>
      {view.files.length === 0 ? (
        <p className="page-description">(no changes)</p>
      ) : (
        <ul className="diff-file-list">
          {view.files.map((file) => (
            <DiffFileItem key={file.path} file={file} />
          ))}
        </ul>
      )}
    </div>
  )
}

function DiffFileItem({ file }: { file: SkillFileDiff }) {
  return (
    <li className="diff-file">
      <div className="diff-file-head">
        <DiffStatusBadge status={file.status} />
        <code className="skill-path">{file.path}</code>
        {file.binary === true && <span className="diff-binary-tag">binary</span>}
      </div>
      {file.binary === true ? (
        <p className="diff-binary-note">Binary file — content is not shown.</p>
      ) : file.patch.length > 0 ? (
        <DiffPatch patch={file.patch} />
      ) : null}
    </li>
  )
}

function DiffStatusBadge({ status }: { status: SkillFileDiff['status'] }) {
  return <span className={`pill pill--diff pill--diff-${status}`}>{status}</span>
}

/**
 * Renders a unified-diff patch with per-line tinting: `@@` hunks in amber,
 * `+` additions in green, `-` deletions in red, context lines plain.
 */
function DiffPatch({ patch }: { patch: string }) {
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }
  return (
    <pre className="diff-patch">
      {lines.map((line, index) => {
        let className = 'diff-patch-line'
        if (line.startsWith('@@')) {
          className += ' diff-patch-line--hunk'
        } else if (line.startsWith('+')) {
          className += ' diff-patch-line--add'
        } else if (line.startsWith('-')) {
          className += ' diff-patch-line--del'
        }
        return (
          <span key={index} className={className}>
            {line}
          </span>
        )
      })}
    </pre>
  )
}
