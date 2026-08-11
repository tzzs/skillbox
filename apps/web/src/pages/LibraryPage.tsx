import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus, RefreshCw, Search } from 'lucide-react'
import type { SkillStatusEntry } from '../api.js'
import { errorMessage } from '../format.js'
import { useAgents, useReconcile, useSkills } from '../queries.js'
import { AgentTags, ModePill, StatusPill } from '../components/Pills.js'
import { CenteredHint, EmptyState, ErrorState } from '../components/States.js'

const STATUS_OPTIONS = ['ready', 'modified', 'outdated', 'conflict', 'missing', 'broken'] as const

type StatusFilter = 'all' | (typeof STATUS_OPTIONS)[number]

/**
 * M11.1 + GAP 1.3 — Library — the full skill catalog with a name search, a
 * status filter and an optional `?agent=` filter (Entered from the Agents
 * page). Each row links to its detail page; the toolbar offers "New skill"
 * and "Reconcile".
 */
export function LibraryPage() {
  const skillsQuery = useSkills()
  const reconcile = useReconcile()
  const agentsQuery = useAgents()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const agentFilter = searchParams.get('agent') ?? 'all'

  const skills = skillsQuery.data ?? []
  const agents = agentsQuery.data ?? []
  const counts = useMemo(() => statusCounts(skills), [skills])
  const agentCounts = useMemo(() => skillsByAgent(skills), [skills])

  const setAgentFilter = (value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === 'all') {
      next.delete('agent')
    } else {
      next.set('agent', value)
    }
    setSearchParams(next, { replace: true })
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return skills.filter((skill) => {
      if (statusFilter !== 'all' && skill.status !== statusFilter) {
        return false
      }
      if (agentFilter !== 'all' && !skill.agents.includes(agentFilter)) {
        return false
      }
      return needle.length === 0 || skill.name.toLowerCase().includes(needle)
    })
  }, [skills, query, statusFilter, agentFilter])

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Library</span>
          <h1 className="page-title">Library</h1>
          <p className="page-description">
            {reconcile.isPending
              ? 'Reconciling repository…'
              : skills.length === 0
                ? 'Skills declared in this repository will show up here.'
                : `${skills.length} skill${skills.length === 1 ? '' : 's'} in this repository`}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            onClick={() => reconcile.mutate()}
            disabled={reconcile.isPending}
            title="Run the reconcile engine (install / manage agent links)"
          >
            {reconcile.isPending ? <span className="spinner" /> : <RefreshCw aria-hidden="true" />}
            Reconcile
          </button>
          <Link to="/skills/new" aria-label="Create a new skill">
            <span className="btn btn--primary">
              <Plus aria-hidden="true" />
              New skill
            </span>
          </Link>
        </div>
      </header>

      {reconcile.isError && (
        <div className="form-error" role="alert">
          {errorMessage(reconcile.error)}
        </div>
      )}

      <div className="toolbar">
        <div className="search-field">
          <Search aria-hidden="true" className="search-icon" />
          <input
            className="search-input"
            type="search"
            placeholder="Search skills…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search skills"
          />
        </div>
        <select
          className="filter-select"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {valueLabel(value)}
              {(counts[value] ?? 0) > 0 ? ` (${counts[value] ?? 0})` : ''}
            </option>
          ))}
        </select>
        <select
          className="filter-select"
          value={agentFilter}
          onChange={(event) => setAgentFilter(event.target.value)}
          aria-label="Filter by agent"
        >
          <option value="all">All agents</option>
          {agentFilter !== 'all' && !agents.some((agent) => agent.id === agentFilter) && (
            <option value={agentFilter}>{agentFilter}</option>
          )}
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
              {(agentCounts[agent.id] ?? 0) > 0 ? ` (${agentCounts[agent.id] ?? 0})` : ''}
            </option>
          ))}
        </select>
      </div>

      {skillsQuery.isError && <ErrorState message={errorMessage(skillsQuery.error)} />}

      {skillsQuery.isLoading ? (
        <CenteredHint>
          <div className="loading-row">
            <span className="spinner" />
            Loading skills…
          </div>
        </CenteredHint>
      ) : skills.length === 0 ? (
        <EmptyState
          title="No skills yet"
          body="Create your first skill to get started."
          action={
            <Link to="/skills/new">
              <span className="btn btn--primary">
                <Plus aria-hidden="true" />
                New skill
              </span>
            </Link>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          body="No skill matches the current search and status filter."
        />
      ) : (
        <div className="table-wrap">
          <table className="skill-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Mode</th>
                <th>Status</th>
                <th>Agents</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((skill) => (
                <SkillRow key={skill.name} skill={skill} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function SkillRow({ skill }: { skill: SkillStatusEntry }) {
  const href = `/skills/${encodeURIComponent(skill.name)}`
  return (
    <tr>
      <td>
        <div className="skill-name">
          <Link to={href}>{skill.name}</Link>
        </div>
        {skill.message !== undefined && <div className="skill-message">{skill.message}</div>}
      </td>
      <td>
        <ModePill mode={skill.mode} />
      </td>
      <td>
        <StatusPill status={skill.status} />
      </td>
      <td>
        <AgentTags agents={skill.agents} />
      </td>
    </tr>
  )
}

function statusCounts(skills: SkillStatusEntry[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of STATUS_OPTIONS) {
    counts[value] = 0
  }
  for (const skill of skills) {
    counts[skill.status] = (counts[skill.status] ?? 0) + 1
  }
  return counts
}

function skillsByAgent(skills: SkillStatusEntry[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const skill of skills) {
    for (const agent of skill.agents) {
      counts[agent] = (counts[agent] ?? 0) + 1
    }
  }
  return counts
}

function valueLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
