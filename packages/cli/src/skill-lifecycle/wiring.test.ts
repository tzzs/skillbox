import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, type CliDeps } from '../index.js'
import {
  FakeDiffProvider,
  FakeEditorLauncher,
  FakeLifecycleProvider,
  FakeMergeProvider,
  FakePrompts,
} from './test-support.js'

/**
 * End-to-end wiring: the five lifecycle commands (fork / vendor / edit /
 * diff / merge) registered in program.ts, exercised through the real `main()`
 * entry with fake providers injected via CliDeps.lifecycle. Status-mode
 * preconditions run against the real StatusService over the fixture's
 * manifest + lockfile; provider results are fake.
 */

interface Io {
  out(): string
  err(): string
}

function capture(): CliDeps & Io {
  const chunks: string[] = []
  const errorChunks: string[] = []
  return {
    stdout: (chunk: string) => chunks.push(chunk),
    stderr: (chunk: string) => errorChunks.push(chunk),
    out: () => chunks.join(''),
    err: () => errorChunks.join(''),
  }
}

function createFixture(): {
  repositoryRoot: string
  base: string
  writeLockfile(yaml: string): void
  writeManifest(yaml: string): void
  cleanup(): void
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skillbox-lifecycle-wiring-'))
  const repositoryRoot = path.join(base, 'repo')
  fs.mkdirSync(repositoryRoot)
  return {
    repositoryRoot,
    base,
    writeLockfile: (yaml: string) =>
      fs.writeFileSync(path.join(repositoryRoot, 'skillbox.lock'), yaml),
    writeManifest: (yaml: string) =>
      fs.writeFileSync(path.join(repositoryRoot, 'skillbox.yaml'), yaml),
    cleanup: () =>
      fs.rmSync(base, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
  }
}

const MANAGED_LOCK = `lockfileVersion: 1
skills:
  react-best-practices:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
    revision: abc1234def5678
    integrity: hash-1
`

const MANAGED_MANIFEST = `version: 1
skills:
  react-best-practices:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
    agents:
      - claude
`

const FORKED_MANIFEST = `version: 1
skills:
  react-best-practices:
    mode: forked
    source:
      type: local
      path: skills/react-best-practices
    upstream:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
`

interface Wiring {
  io: CliDeps & Io
  fixture: ReturnType<typeof createFixture>
  lifecycle: FakeLifecycleProvider
  diff: FakeDiffProvider
  merge: FakeMergeProvider
  editor: FakeEditorLauncher
  deps(overrides?: Partial<CliDeps>): CliDeps
}

function createWiring(overrides: { isInteractive?: boolean } = {}): Wiring {
  const io = capture()
  const fixture = createFixture()
  const lifecycle = new FakeLifecycleProvider()
  const diff = new FakeDiffProvider()
  const merge = new FakeMergeProvider()
  const editor = new FakeEditorLauncher()
  const deps: CliDeps = {
    ...io,
    repositoryRoot: fixture.repositoryRoot,
    homeRoot: path.join(fixture.base, 'home'),
    isInteractive: overrides.isInteractive ?? false,
    lifecycle: { lifecycle, diff, merge, openEditor: editor },
  }
  return {
    io,
    fixture,
    lifecycle,
    diff,
    merge,
    editor,
    deps: (extra = {}) => ({ ...deps, ...extra }),
  }
}

describe('skillbox fork', () => {
  it('prints the pipeline progress and the result summary', async () => {
    const wiring = createWiring()
    wiring.fixture.writeLockfile(MANAGED_LOCK)
    const exit = await main(['fork', 'react-best-practices'], wiring.deps())
    expect(exit).toBe(0)
    const out = wiring.io.out()
    expect(out).toContain('Copy runtime → Snapshot → Register')
    expect(out).toContain('Forked "react-best-practices" (managed → forked)')
    expect(out).toContain('base revision  abc1234def5678')
    expect(out).toContain('upstream       github:vercel-labs/agent-skills')
    expect(wiring.lifecycle.forkCalls[0]?.name).toBe('react-best-practices')
  })

  it('rejects a local skill with exit code 2 (validation)', async () => {
    const wiring = createWiring()
    wiring.fixture.writeLockfile(
      `lockfileVersion: 1
skills:
  local-skill:
    mode: local
    source:
      type: local
      path: skills/local-skill
    integrity: hash-3
`,
    )
    const exit = await main(['fork', 'local-skill'], wiring.deps())
    expect(exit).toBe(2)
    expect(wiring.io.err()).toContain('only managed')
    expect(wiring.lifecycle.forkCalls).toHaveLength(0)
  })

  it('reports a missing skill with exit code 1', async () => {
    const wiring = createWiring()
    wiring.fixture.writeLockfile('lockfileVersion: 1\nskills: {}\n')
    const exit = await main(['fork', 'ghost'], wiring.deps())
    expect(exit).toBe(1)
    expect(wiring.io.err()).toContain('is not installed')
  })

  it('delegates to the real core forkSkill (exit 1 when the runtime copy is missing)', async () => {
    // No `lifecycle` overrides → program.ts builds the default adapters over
    // the real `@skillbox/core` exports. Agent 1's `forkSkill` has landed, so
    // the call reaches the real implementation: with no managed runtime copy
    // under the fixture home, it throws SKILL_MISSING → generic exit 1.
    const io = capture()
    const fixture = createFixture()
    try {
      fixture.writeManifest(MANAGED_MANIFEST)
      fixture.writeLockfile(MANAGED_LOCK)
      const exit = await main(['fork', 'react-best-practices'], {
        ...io,
        repositoryRoot: fixture.repositoryRoot,
        homeRoot: path.join(fixture.base, 'home'),
        isInteractive: false,
      })
      expect(exit).toBe(1)
      expect(io.out()).toContain('Copy runtime → Snapshot → Register')
      expect(io.err()).toContain('managed runtime copy is missing')
    } finally {
      fixture.cleanup()
    }
  })
})

describe('skillbox vendor', () => {
  it('prints the vendor summary (mode → vendored, upstream cleared)', async () => {
    const wiring = createWiring()
    wiring.fixture.writeLockfile(MANAGED_LOCK)
    const exit = await main(['vendor', 'react-best-practices'], wiring.deps())
    expect(exit).toBe(0)
    const out = wiring.io.out()
    expect(out).toContain('Copy runtime → Localize → Clear upstream')
    expect(out).toContain('Vendored "react-best-practices" (managed → vendored)')
    expect(out).toContain('upstream       cleared')
    expect(wiring.lifecycle.vendorCalls[0]?.name).toBe('react-best-practices')
  })
})

describe('skillbox edit', () => {
  it('defers a managed edit without --yes (exit 0, hint only)', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(MANAGED_MANIFEST)
    const exit = await main(['edit', 'react-best-practices'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('would create a local fork')
    expect(wiring.io.out()).toContain('skillbox edit react-best-practices --yes')
    expect(wiring.lifecycle.forkCalls).toHaveLength(0)
    expect(wiring.editor.opened).toHaveLength(0)
  })

  it('forks and opens the editor with --yes', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(MANAGED_MANIFEST)
    const exit = await main(['edit', 'react-best-practices', '--yes'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('Converted "react-best-practices" to a fork')
    expect(wiring.lifecycle.forkCalls).toHaveLength(1)
    expect(wiring.editor.opened).toHaveLength(1)
    expect(wiring.editor.opened[0]).toContain('SKILL.md')
  })

  it('converts a modified managed skill after an interactive confirm', async () => {
    const wiring = createWiring({ isInteractive: true })
    wiring.fixture.writeManifest(MANAGED_MANIFEST)
    wiring.lifecycle.modifications = {
      name: 'react-best-practices',
      modified: true,
      files: ['SKILL.md'],
    }
    // The modified flow offers [Convert to Fork] / [Restore]; the fake selects
    // the default (fork) immediately — without it the real clack prompts
    // would block on stdin.
    const prompts = new FakePrompts()
    const exit = await main(['edit', 'react-best-practices'], wiring.deps({ prompts }))
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('Converted "react-best-practices" to a fork')
    expect(wiring.lifecycle.forkCalls).toHaveLength(1)
  })

  it('restores the runtime when the interactive flow chooses Restore', async () => {
    const wiring = createWiring({ isInteractive: true })
    wiring.fixture.writeManifest(MANAGED_MANIFEST)
    wiring.lifecycle.modifications = {
      name: 'react-best-practices',
      modified: true,
      files: ['SKILL.md'],
    }
    const prompts = new FakePrompts()
    prompts.selectResult = 'restore'
    const exit = await main(['edit', 'react-best-practices'], wiring.deps({ prompts }))
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('Restored 4 file(s)')
    expect(wiring.io.out()).toContain('pristine again')
    expect(wiring.lifecycle.restoreCalls).toHaveLength(1)
    // A restored managed runtime has no repo-local directory — no editor opens.
    expect(wiring.editor.opened).toHaveLength(0)
  })

  it('prints the manual-edit path when no editor can launch', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(MANAGED_MANIFEST)
    wiring.editor.canOpen = false
    const exit = await main(['edit', 'react-best-practices', '--yes'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('No editor configured (set EDITOR or VISUAL)')
    expect(wiring.io.out()).toContain('SKILL.md')
  })

  it('degrades safely without lifecycle wiring (unmodified path, hint only)', async () => {
    // No `lifecycle` overrides → the real `detectManagedModifications` runs:
    // the fixture has no skillbox.lock, so it returns `false` (nothing to
    // compare) → unmodified path → non-interactive without --yes defers.
    const io = capture()
    const fixture = createFixture()
    try {
      fixture.writeManifest(MANAGED_MANIFEST)
      const exit = await main(['edit', 'react-best-practices'], {
        ...io,
        repositoryRoot: fixture.repositoryRoot,
        homeRoot: path.join(fixture.base, 'home'),
        isInteractive: false,
      })
      expect(exit).toBe(0)
      expect(io.out()).toContain('would create a local fork')
    } finally {
      fixture.cleanup()
    }
  })

  it('opens a local skill directly without forking', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(
      `version: 1
skills:
  local-skill:
    source:
      type: local
      path: skills/local-skill
`,
    )
    const exit = await main(['edit', 'local-skill'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('Opened "local-skill"')
    expect(wiring.editor.opened).toHaveLength(1)
    expect(wiring.lifecycle.forkCalls).toHaveLength(0)
  })
})

describe('skillbox diff', () => {
  it('renders the forked base/local/upstream blocks', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(FORKED_MANIFEST)
    wiring.diff.diffResult = {
      name: 'react-best-practices',
      mode: 'forked',
      views: [
        { label: 'Base', files: [] },
        {
          label: 'Local',
          files: [{ path: 'SKILL.md', status: 'modified', patch: '-old\n+new\n' }],
        },
        { label: 'Upstream', files: [] },
      ],
      unchanged: false,
    }
    const exit = await main(['diff', 'react-best-practices'], wiring.deps())
    expect(exit).toBe(0)
    const out = wiring.io.out()
    expect(out).toContain('Changes for "react-best-practices" (forked)')
    expect(out).toContain('Base')
    expect(out).toContain('Local')
    expect(out).toContain('Upstream')
    expect(out).toContain('MODIFIED SKILL.md')
    expect(out).toContain('+new')
  })

  it('renders "No changes" and supports --json', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(MANAGED_MANIFEST)
    wiring.diff.diffResult = {
      name: 'react-best-practices',
      mode: 'managed',
      views: [{ label: 'Current vs Latest', files: [] }],
      unchanged: true,
    }
    const exit = await main(['diff', 'react-best-practices'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('No changes for "react-best-practices".')

    const jsonExit = await main(['diff', 'react-best-practices', '--json'], wiring.deps())
    expect(jsonExit).toBe(0)
    expect(wiring.io.out()).toContain('"views"')
    expect(wiring.io.out()).toContain('"unchanged": true')
  })

  it('rejects local skills with exit code 2', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(
      `version: 1
skills:
  local-skill:
    source:
      type: local
      path: skills/local-skill
`,
    )
    const exit = await main(['diff', 'local-skill'], wiring.deps())
    expect(exit).toBe(2)
    expect(wiring.io.err()).toContain('only available for managed and forked')
    expect(wiring.diff.diffCalls).toHaveLength(0)
  })

  it('delegates to the real core diffSkill (exit 1 without a lockfile)', async () => {
    // No overrides → the default adapter calls agent 2's real `diffSkill`.
    // With a manifest but no skillbox.lock, the core diff fails with
    // LOCKFILE_NOT_FOUND → generic exit 1 (proves real delegation).
    const io = capture()
    const fixture = createFixture()
    try {
      fixture.writeManifest(MANAGED_MANIFEST)
      const exit = await main(['diff', 'react-best-practices'], {
        ...io,
        repositoryRoot: fixture.repositoryRoot,
        homeRoot: path.join(fixture.base, 'home'),
        isInteractive: false,
      })
      expect(exit).toBe(1)
      expect(io.err()).toContain('No skillbox.lock found')
    } finally {
      fixture.cleanup()
    }
  })
})

describe('skillbox merge', () => {
  it('summarizes a clean merge (files, changes, base revision)', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(FORKED_MANIFEST)
    wiring.merge.mergeResult = {
      name: 'react-best-practices',
      conflicts: [],
      filesMerged: 3,
      changes: 42,
      baseRevision: 'def56789abcd',
    }
    const exit = await main(['merge', 'react-best-practices'], wiring.deps())
    expect(exit).toBe(0)
    const out = wiring.io.out()
    expect(out).toContain('Merged "react-best-practices"')
    expect(out).toContain('files         3')
    expect(out).toContain('changes       42')
    expect(out).toContain('base revision def56789abcd (updated)')
    expect(wiring.merge.mergeCalls).toHaveLength(1)
  })

  it('lists conflicts and exits 3 with the --continue hint', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(FORKED_MANIFEST)
    wiring.merge.mergeResult = {
      name: 'react-best-practices',
      conflicts: [{ path: 'src/index.ts', hunks: 3 }],
      filesMerged: 1,
      changes: 5,
    }
    const exit = await main(['merge', 'react-best-practices'], wiring.deps())
    expect(exit).toBe(3)
    expect(wiring.io.err()).toContain('src/index.ts (3 hunks)')
    expect(wiring.io.err()).toContain('skillbox merge react-best-practices --continue')
  })

  it('finishes a resolved merge via --continue', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(FORKED_MANIFEST)
    const exit = await main(['merge', 'react-best-practices', '--continue'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain('completed')
    expect(wiring.merge.continueCalls).toHaveLength(1)
  })

  it('fails --continue with remaining conflicts (exit 3)', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(FORKED_MANIFEST)
    wiring.merge.continueResult = {
      name: 'react-best-practices',
      resolved: false,
      remainingConflicts: [{ path: 'src/index.ts', hunks: 2 }],
      filesMerged: 1,
      changes: 2,
    }
    const exit = await main(['merge', 'react-best-practices', '--continue'], wiring.deps())
    expect(exit).toBe(3)
    expect(wiring.io.err()).toContain('still has 1 unresolved')
  })

  it('aborts and reports the restored files', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(FORKED_MANIFEST)
    const exit = await main(['merge', 'react-best-practices', '--abort'], wiring.deps())
    expect(exit).toBe(0)
    expect(wiring.io.out()).toContain(
      'Merge aborted for "react-best-practices" — restored 5 file(s).',
    )
    expect(wiring.merge.abortCalls).toHaveLength(1)
  })

  it('rejects managed skills with the update hint (exit 2)', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(MANAGED_MANIFEST)
    const exit = await main(['merge', 'react-best-practices'], wiring.deps())
    expect(exit).toBe(2)
    expect(wiring.io.err()).toContain('skillbox update')
    expect(wiring.merge.mergeCalls).toHaveLength(0)
  })

  it('delegates to the real core mergeSkill (exit 1 without a lockfile)', async () => {
    // Same as diff: the default adapter calls agent 2's real `mergeSkill`,
    // which fails with LOCKFILE_NOT_FOUND on a lockfile-less fixture.
    const io = capture()
    const fixture = createFixture()
    try {
      fixture.writeManifest(FORKED_MANIFEST)
      const exit = await main(['merge', 'react-best-practices'], {
        ...io,
        repositoryRoot: fixture.repositoryRoot,
        homeRoot: path.join(fixture.base, 'home'),
        isInteractive: false,
      })
      expect(exit).toBe(1)
      expect(io.err()).toContain('No skillbox.lock found')
    } finally {
      fixture.cleanup()
    }
  })
})

describe('skillbox status (V0.4 rendering)', () => {
  it('renders forked / vendored modes and the conflicting-skills section', async () => {
    const wiring = createWiring()
    wiring.fixture.writeManifest(
      `version: 1
skills:
  forked-skill:
    mode: forked
    source:
      type: local
      path: skills/forked-skill
    upstream:
      type: github
      repo: org/forked
  vendored-skill:
    mode: vendored
    source:
      type: local
      path: skills/vendored-skill
  local-skill:
    source:
      type: local
      path: skills/local-skill
`,
    )
    const exit = await main(['status'], wiring.deps())
    expect(exit).toBe(0)
    const out = wiring.io.out()
    expect(out).toContain('MODE')
    expect(out).toContain('forked-skill')
    expect(out).toContain('forked')
    expect(out).toContain('vendored-skill')
    expect(out).toContain('vendored')
    expect(out).toContain('Conflicting skills')
    // No core status computation yields `conflict` yet (agent 2 extends the
    // status service) — the section renders empty for now.
    expect(out).toContain('(none)')
  })
})
