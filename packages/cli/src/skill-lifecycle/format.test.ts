import { describe, expect, it } from 'vitest'
import {
  renderDiff,
  renderEditSummary,
  renderForkSummary,
  renderMergeOutcome,
  renderVendorSummary,
} from './format.js'
import type { SkillDiff } from './types.js'

describe('renderForkSummary', () => {
  it('reports alias, mode transition, upstream and base revision', () => {
    const text = renderForkSummary({
      alias: 'react-best-practices',
      mode: 'forked',
      fromMode: 'managed',
      localPath: 'skills/react-best-practices',
      upstreamSource: 'github:vercel-labs/agent-skills@skills/react-best-practices',
      baseRevision: 'abc1234def5678',
      manifestChanged: true,
      lockfileChanged: true,
    })
    expect(text).toContain('Forked "react-best-practices" (managed → forked)')
    expect(text).toContain('base revision  abc1234def5678')
    expect(text).toContain('upstream       github:vercel-labs/agent-skills')
    expect(text).toContain('manifest       updated')
    expect(text).toContain('lockfile       updated')
  })

  it('tolerates a missing upstream and empty base revision', () => {
    const text = renderForkSummary({
      alias: 'x',
      mode: 'forked',
      fromMode: 'managed',
      localPath: 'skills/x',
      baseRevision: '',
      manifestChanged: false,
      lockfileChanged: false,
    })
    expect(text).toContain('Forked "x" (managed → forked)')
    expect(text).not.toContain('base revision')
    expect(text).not.toContain('upstream')
    expect(text).toContain('manifest       unchanged')
  })
})

describe('renderVendorSummary', () => {
  it('reports the mode transition and upstream clearing', () => {
    const text = renderVendorSummary({
      alias: 'react-best-practices',
      mode: 'vendored',
      fromMode: 'forked',
      localPath: 'skills/react-best-practices',
      upstreamCleared: true,
      manifestChanged: true,
      lockfileChanged: true,
    })
    expect(text).toContain('Vendored "react-best-practices" (forked → vendored)')
    expect(text).toContain('path           skills/react-best-practices')
    expect(text).toContain('upstream       cleared')
  })
})

describe('renderEditSummary', () => {
  it('renders each action', () => {
    expect(renderEditSummary({ name: 'x', action: 'edited' })).toContain('Opened "x"')
    expect(renderEditSummary({ name: 'x', action: 'forked' })).toContain('Converted "x" to a fork')
    expect(renderEditSummary({ name: 'x', action: 'restored' })).toContain('Restored "x"')
    expect(renderEditSummary({ name: 'x', action: 'cancelled' })).toContain('Edit cancelled')
    const deferred = renderEditSummary({ name: 'x', action: 'deferred' })
    expect(deferred).toContain('Edit deferred')
    expect(deferred).toContain('skillbox edit x --yes')
  })
})

describe('renderDiff', () => {
  const forkedDiff: SkillDiff = {
    name: 'react-best-practices',
    mode: 'forked',
    unchanged: false,
    views: [
      {
        label: 'Base',
        files: [{ path: 'src/index.ts', status: 'added', patch: '+const a = 1\n' }],
      },
      {
        label: 'Local',
        files: [
          { path: 'src/index.ts', status: 'modified', patch: '-const a = 1\n+const a = 2\n' },
        ],
      },
      { label: 'Upstream', files: [] },
    ],
  }

  it('renders the managed current-vs-latest view', () => {
    const text = renderDiff({
      name: 'x',
      mode: 'managed',
      unchanged: false,
      views: [
        {
          label: 'Current vs Latest',
          files: [{ path: 'SKILL.md', status: 'modified', patch: '-old\n+new\n' }],
        },
      ],
    })
    expect(text).toContain('Changes for "x" (managed)')
    expect(text).toContain('Current vs Latest')
    // Status column is right-padded to 8 chars (see renderDiff).
    expect(text).toContain('MODIFIED SKILL.md')
    expect(text).toContain('+new')
  })

  it('renders the three forked views as separated blocks', () => {
    const text = renderDiff(forkedDiff)
    expect(text).toContain('Changes for "react-best-practices" (forked)')
    // Block order: Base → Local → Upstream.
    expect(text.indexOf('Base')).toBeLessThan(text.indexOf('Local'))
    expect(text.indexOf('Local')).toBeLessThan(text.indexOf('Upstream'))
    expect(text).toContain('ADDED    src/index.ts')
    expect(text).toContain('(no changes)')
    expect(text).toContain('+const a = 2')
  })

  it('renders "No changes" when nothing differs', () => {
    const text = renderDiff({
      name: 'x',
      mode: 'managed',
      unchanged: true,
      views: [{ label: 'Current vs Latest', files: [] }],
    })
    expect(text).toBe('No changes for "x".')
  })
})

describe('renderMergeOutcome', () => {
  it('summarizes a clean merge with the base revision update', () => {
    const text = renderMergeOutcome({
      kind: 'merged',
      name: 'x',
      filesMerged: 3,
      changes: 42,
      baseRevision: 'def5678',
    })
    expect(text).toContain('Merged "x"')
    expect(text).toContain('files         3')
    expect(text).toContain('changes       42')
    expect(text).toContain('base revision def5678 (updated)')
  })

  it('summarizes --continue and --abort', () => {
    expect(
      renderMergeOutcome({ kind: 'continued', name: 'x', filesMerged: 2, changes: 9 }),
    ).toContain('completed')
    expect(renderMergeOutcome({ kind: 'aborted', name: 'x', filesRestored: 5 })).toBe(
      'Merge aborted for "x" — restored 5 file(s).',
    )
  })
})
