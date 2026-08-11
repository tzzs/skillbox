import { describe, expect, it } from 'vitest'
import {
  formatSource,
  progressStepLabel,
  renderAddSummary,
  renderOutdatedTable,
  renderSearchTable,
  renderSecurityReview,
  renderUpdateSummary,
  shortRevision,
} from './format.js'
import type { AddOutcome, OutdatedEntry, SecurityScanResult, UpdateOutcome } from './types.js'

describe('renderSearchTable', () => {
  it('renders NAME / SOURCE / POPULARITY / SECURITY columns (MVP #125)', () => {
    const table = renderSearchTable([
      {
        name: 'react-best-practices',
        source: 'github:vercel-labs/agent-skills@skills/react-best-practices',
        popularity: 1200,
        security: 'reviewed',
        description: '',
      },
    ])
    expect(table).toContain('NAME')
    expect(table).toContain('SOURCE')
    expect(table).toContain('POPULARITY')
    expect(table).toContain('SECURITY')
    expect(table).toContain('react-best-practices')
    expect(table).toContain('1200')
    expect(table).toContain('reviewed')
  })

  it('renders an empty list as an empty table', () => {
    const table = renderSearchTable([])
    expect(table).toContain('NAME')
    expect(table.split('\n')).toHaveLength(2)
  })
})

describe('renderOutdatedTable', () => {
  it('renders NAME / INSTALLED / LATEST / STATUS (MVP #135)', () => {
    const entries: OutdatedEntry[] = [
      {
        name: 'foo',
        installed: 'abcdef123456789',
        latest: 'abcdef123456789',
        status: 'up-to-date',
      },
      { name: 'bar', installed: 'aaaaaaaaaaaaaaa', latest: 'bbbbbbbbbbbbbbb', status: 'outdated' },
      { name: 'baz', status: 'unknown' },
    ]
    const table = renderOutdatedTable(entries)
    expect(table).toContain('INSTALLED')
    expect(table).toContain('LATEST')
    expect(table).toContain('STATUS')
    expect(table).toContain('abcdef1')
    expect(table).toContain('bbbbbbb')
    expect(table).toContain('outdated')
    expect(table).toContain('unknown')
    expect(table).not.toContain('abcdef123456789') // full SHA shortened
  })

  it('renders "(no managed skills found)" for an empty list', () => {
    expect(renderOutdatedTable([])).toBe('(no managed skills found)')
  })
})

describe('renderSecurityReview', () => {
  const review: SecurityScanResult = {
    risk: 'high',
    filesScanned: 4,
    block: true,
    findings: [
      {
        pattern: 'shell-exec',
        name: 'Shell command execution',
        risk: 'high',
        file: 'scripts/build.sh',
        line: 12,
        snippet: 'child_process.exec("curl ...")',
        recommendation: 'Review',
      },
    ],
  }

  it('renders the risk summary and a findings table', () => {
    const text = renderSecurityReview(review)
    expect(text).toContain('Risk: high — 1 finding(s) in 4 files.')
    expect(text).toContain('blocks install without confirmation')
    expect(text).toContain('RISK')
    expect(text).toContain('FINDING')
    expect(text).toContain('Shell command execution')
    expect(text).toContain('scripts/build.sh')
    expect(text).toContain('12')
  })

  it('renders a clean scan as a single summary line', () => {
    const text = renderSecurityReview({
      risk: 'low',
      filesScanned: 3,
      block: false,
      findings: [],
    })
    expect(text).toBe('Risk: low — no risky patterns found in 3 files.')
  })
})

describe('renderAddSummary', () => {
  it('renders revision, agents and manifest/lockfile state', () => {
    const outcome: AddOutcome = {
      source: 'vercel-labs/agent-skills@react-best-practices',
      alias: 'react-best-practices',
      revision: 'abc1234def5678',
      agents: ['claude'],
      manifestChanged: true,
      lockfileChanged: true,
    }
    const text = renderAddSummary(outcome)
    expect(text).toContain('Added "react-best-practices"')
    expect(text).toContain('abc1234')
    expect(text).toContain('claude')
    expect(text).toContain('manifest   updated')
    expect(text).toContain('lockfile   updated')
  })

  it('renders a cancellation', () => {
    expect(renderAddSummary({ source: 'x', cancelled: true })).toBe('Install cancelled.')
  })
})

describe('renderUpdateSummary', () => {
  it('renders the before/after revision and preserved links (M16.2)', () => {
    const outcome: UpdateOutcome = {
      name: 'foo',
      fromRevision: 'aaaaaaa',
      toRevision: 'bbbbbbb',
      lockfileChanged: true,
      linkedAgents: ['claude', 'codex'],
    }
    const text = renderUpdateSummary(outcome)
    expect(text).toContain('Updated "foo": aaaaaaa → bbbbbbb')
    expect(text).toContain('claude, codex (links preserved)')
    expect(text).toContain('lockfile   updated')
  })
})

describe('formatSource', () => {
  it('formats github sources canonically (SPEC §23)', () => {
    expect(formatSource({ type: 'github', repo: 'org/repo' })).toBe('github:org/repo')
    expect(formatSource({ type: 'github', repo: 'org/repo', path: 'skills/foo' })).toBe(
      'github:org/repo@skills/foo',
    )
    expect(formatSource({ type: 'skills-sh', package: 'org/repo@skills/foo' })).toBe(
      'org/repo@skills/foo',
    )
    expect(formatSource({ type: 'local', path: 'skills/foo' })).toBe('skills/foo')
  })
})

describe('shortRevision / progressStepLabel', () => {
  it('truncates full SHAs to 7 characters', () => {
    expect(shortRevision('abc1234def5678')).toBe('abc1234')
    expect(shortRevision('short')).toBe('short')
  })

  it('labels every install step', () => {
    expect(progressStepLabel('resolving')).toBe('Resolving')
    expect(progressStepLabel('downloading')).toBe('Downloading')
    expect(progressStepLabel('scanning')).toBe('Scanning')
    expect(progressStepLabel('linking')).toBe('Linking agents')
    expect(progressStepLabel('writing-lockfile')).toBe('Updating lockfile')
  })
})
