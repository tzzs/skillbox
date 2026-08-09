import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Plus } from 'lucide-react'
import { errorMessage } from '../format.js'
import { useCreateSkill } from '../queries.js'

/**
 * M11.3 — Create Skill — scaffolds a new skill with an optional description.
 * On success the UI navigates to the new skill's detail page.
 */
export function CreateSkillPage() {
  const navigate = useNavigate()
  const create = useCreateSkill()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0 || create.isPending) {
      return
    }
    const input: { name: string; description?: string } = { name: trimmed }
    if (description.trim().length > 0) {
      input.description = description.trim()
    }
    create.mutate(input, {
      onSuccess: (created) => navigate(`/skills/${encodeURIComponent(created.name)}`),
    })
  }

  return (
    <section className="page">
      <Link to="/" className="detail-anchor">
        <ArrowLeft aria-hidden="true" />
        Library
      </Link>

      <header className="page-header">
        <div>
          <h1 className="page-title">New skill</h1>
          <p className="page-description">
            Scaffold a skill directory, register it in the manifest and lockfile, and materialize it
            into the runtime library.
          </p>
        </div>
      </header>

      <form className="card" onSubmit={submit} style={{ maxWidth: 560 }}>
        <div className="field">
          <label className="field-label" htmlFor="skill-name">
            Name <span className="field-required">*</span>
          </label>
          <input
            id="skill-name"
            className="field-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. git-cleanup"
            autoFocus
            required
          />
          <p className="field-hint">
            Lowercase letters, digits and dashes. This becomes the directory name.
          </p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="skill-description">
            Description
          </label>
          <input
            id="skill-description"
            className="field-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this skill does (optional)"
          />
        </div>

        {create.isError && (
          <div className="form-error" role="alert">
            {errorMessage(create.error)}
          </div>
        )}

        <div className="form-actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={name.trim().length === 0 || create.isPending}
          >
            {create.isPending ? <span className="spinner" /> : <Plus aria-hidden="true" />}
            Create skill
          </button>
          <Link to="/">
            <button type="button" className="btn">
              Cancel
            </button>
          </Link>
        </div>
      </form>
    </section>
  )
}
