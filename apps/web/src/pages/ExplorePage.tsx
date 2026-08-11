import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowDownWideNarrow,
  CheckCircle2,
  Download,
  Flame,
  Search,
  ShieldCheck,
} from 'lucide-react'
import type { RegistrySearchResult } from '../api.js'
import { errorMessage } from '../format.js'
import { useRegistrySearch } from '../queries.js'
import { CenteredHint, EmptyState, ErrorState } from '../components/States.js'

type SortOption = 'popularity' | 'recently-updated'

/**
 * M14.7 — Explore — the marketplace browse page. A debounced search box plus
 * Trending / Official tag filters and a popularity sort feed the aggregated
 * registry search API; every card carries an Install button that carries the
 * result over to the Skill Install Page.
 */
export function ExplorePage() {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortOption>('popularity')
  const [trending, setTrending] = useState(false)
  const [official, setOfficial] = useState(false)

  // Debounce the search box so keystrokes don't fire a request each time.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(draft.trim()), 300)
    return () => clearTimeout(timer)
  }, [draft])

  const params = useMemo(
    () => ({ q: query, sort, trending, official }),
    [query, sort, trending, official],
  )
  const searchQuery = useRegistrySearch(params)
  const results = searchQuery.data ?? []

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <span className="page-eyebrow">Marketplace</span>
          <h1 className="page-title">Explore</h1>
          <p className="page-description">
            Discover skills from the Skillbox registry and install them into this repository.
          </p>
        </div>
      </header>

      <div className="toolbar">
        <div className="search-field">
          <Search aria-hidden="true" className="search-icon" />
          <input
            className="search-input"
            type="search"
            placeholder="Search the registry…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Search the registry"
          />
        </div>
        <div className="tag-filter" role="group" aria-label="Registry filters">
          <button
            type="button"
            className={`tag-filter-chip${trending ? ' tag-filter-chip--active' : ''}`}
            onClick={() => setTrending((value) => !value)}
            aria-pressed={trending}
          >
            <Flame aria-hidden="true" />
            Trending
          </button>
          <button
            type="button"
            className={`tag-filter-chip${official ? ' tag-filter-chip--active' : ''}`}
            onClick={() => setOfficial((value) => !value)}
            aria-pressed={official}
          >
            <CheckCircle2 aria-hidden="true" />
            Official
          </button>
        </div>
        <select
          className="filter-select"
          value={sort}
          onChange={(event) => setSort(event.target.value as SortOption)}
          aria-label="Sort results"
        >
          <option value="popularity">Most popular</option>
          <option value="recently-updated">Recently updated</option>
        </select>
      </div>

      {searchQuery.isError && <ErrorState message={errorMessage(searchQuery.error)} />}

      {searchQuery.isLoading ? (
        <CenteredHint>
          <div className="loading-row">
            <span className="spinner" />
            Searching the registry…
          </div>
        </CenteredHint>
      ) : results.length === 0 ? (
        <EmptyState
          title={query === '' ? 'Nothing in the registry yet' : `No results for “${query}”`}
          body={
            query === ''
              ? 'The registry did not return any skills for this filter combination.'
              : 'Try a different search term or clear the Trending / Official filters.'
          }
        />
      ) : (
        <div className="registry-grid">
          {results.map((result) => (
            <RegistryCard key={`${result.provider}:${result.source}`} result={result} />
          ))}
        </div>
      )}
    </section>
  )
}

function RegistryCard({ result }: { result: RegistrySearchResult }) {
  const navigate = useNavigate()
  const install = () => {
    navigate('/explore/install', { state: { result } })
  }

  return (
    <article className="registry-card">
      <div className="registry-card-head">
        <h2 className="registry-card-name">{result.name}</h2>
        <span className="registry-provider">{result.provider}</span>
      </div>

      <div className="registry-badges">
        {result.trending === true && (
          <span className="badge badge--trending">
            <Flame aria-hidden="true" />
            Trending
          </span>
        )}
        {result.official === true && (
          <span className="badge badge--official">
            <CheckCircle2 aria-hidden="true" />
            Official
          </span>
        )}
        {result.verified === true && <span className="badge badge--verified">Verified</span>}
        <SecurityReviewedBadge result={result} />
        {result.installed === true && <span className="badge badge--installed">Installed</span>}
      </div>

      <p className="registry-card-desc">{result.description ?? 'No description provided.'}</p>

      <div className="registry-card-meta">
        <span className="registry-meta-popularity">
          <ArrowDownWideNarrow aria-hidden="true" />
          {result.popularity !== undefined ? formatPopularity(result.popularity) : 'n/a'} downloads
        </span>
        {(result.version ?? result.revision) !== undefined && (
          <code className="registry-meta-version">{result.version ?? result.revision}</code>
        )}
      </div>

      <div className="registry-card-actions">
        {result.installed === true ? (
          <span className="path-muted">Already installed</span>
        ) : (
          <button type="button" className="btn btn--primary btn--small" onClick={install}>
            <Download aria-hidden="true" />
            Install
          </button>
        )}
      </div>
    </article>
  )
}

export function SecurityReviewedBadge({ result }: { result: RegistrySearchResult }) {
  if (result.securityReviewed !== true) {
    return <span className="badge badge--unreviewed">Not security reviewed</span>
  }
  return (
    <span className={`badge badge--security badge--security-${result.securityRisk ?? 'low'}`}>
      <ShieldCheck aria-hidden="true" />
      Security reviewed
    </span>
  )
}

function formatPopularity(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return String(value)
}
