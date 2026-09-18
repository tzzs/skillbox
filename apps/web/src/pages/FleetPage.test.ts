import { describe, expect, it } from 'vitest'
import type { FleetHostResult } from '../api.js'
import { detailLine, fleetSummary, parseRemoteSkills } from './FleetPage.js'

describe('fleetSummary', () => {
  it('reports the loading state first', () => {
    expect(fleetSummary(true, 0, 0)).toBe('Loading fleet.yaml…')
  })

  it('reports no hosts configured', () => {
    expect(fleetSummary(false, 0, 0)).toBe('No fleet hosts configured.')
  })

  it('pluralizes and notes actions target every host when none are selected', () => {
    expect(fleetSummary(false, 1, 0)).toBe(
      '1 host configured — none selected, actions target all of them',
    )
    expect(fleetSummary(false, 3, 0)).toBe(
      '3 hosts configured — none selected, actions target all of them',
    )
  })

  it('reports the selected count once at least one host is picked', () => {
    expect(fleetSummary(false, 3, 1)).toBe('1 of 3 hosts selected')
  })
})

function hostResult(overrides: Partial<FleetHostResult>): FleetHostResult {
  return {
    host: 'staging',
    ok: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 100,
    ...overrides,
  }
}

describe('parseRemoteSkills', () => {
  it('returns undefined for a failed host — there is nothing meaningful to parse', () => {
    expect(parseRemoteSkills(hostResult({ ok: false }))).toBeUndefined()
  })

  it('returns undefined for stdout that is not JSON', () => {
    expect(parseRemoteSkills(hostResult({ stdout: 'not json' }))).toBeUndefined()
  })

  it('returns undefined for JSON that has no skills array', () => {
    expect(parseRemoteSkills(hostResult({ stdout: '{"ok":true}' }))).toBeUndefined()
  })

  it('parses the skills array out of a real `status --json` payload', () => {
    const stdout = JSON.stringify({
      skills: [{ name: 'incident-runbook', mode: 'managed', status: 'ready', agents: ['claude'] }],
    })
    expect(parseRemoteSkills(hostResult({ stdout }))).toEqual([
      { name: 'incident-runbook', mode: 'managed', status: 'ready', agents: ['claude'] },
    ])
  })
})

describe('detailLine', () => {
  it('prefers the connection error over stdout/stderr', () => {
    expect(detailLine(hostResult({ ok: false, error: 'connection refused' }), 'install')).toBe(
      'connection refused',
    )
  })

  it('summarizes a successful status run instead of dumping the raw JSON', () => {
    const stdout = JSON.stringify({
      skills: [
        { name: 'a', mode: 'managed', status: 'ready', agents: [] },
        { name: 'b', mode: 'local', status: 'ready', agents: [] },
      ],
    })
    expect(detailLine(hostResult({ stdout }), 'status')).toBe('2 skill(s) — see below')
  })

  it('falls back to a generic message when a successful status run is unparseable', () => {
    expect(detailLine(hostResult({ stdout: 'not json' }), 'status')).toBe('ok (see below)')
  })

  it('shows the first non-blank stdout line for a successful non-status operation', () => {
    expect(detailLine(hostResult({ stdout: '\nReconciled "repo"\n  skills 3\n' }), 'install')).toBe(
      'Reconciled "repo"',
    )
  })

  it('shows the first non-blank stderr line for a failed operation', () => {
    expect(
      detailLine(hostResult({ ok: false, stderr: '\nfatal: not a git repository\n' }), 'install'),
    ).toBe('fatal: not a git repository')
  })
})
