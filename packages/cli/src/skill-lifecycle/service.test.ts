import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ErrorCode,
  isSkillboxError,
  SkillboxError,
  type RepositoryStatus,
  type SkillStatusEntry,
} from '@skillbox/core'
import { LIFECYCLE_UNAVAILABLE_CODE, MERGE_CONFLICT_CODE } from './loaders.js'
import {
  createDefaultEditorLauncher,
  SkillLifecycleService,
  type SkillLifecycleServiceOptions,
} from './service.js'
import {
  FakeDiffProvider,
  FakeEditorLauncher,
  FakeLifecycleProvider,
  FakeMergeProvider,
  FakePrompts,
} from './test-support.js'

/**
 * SkillLifecycleService flows: fork / vendor / edit / diff / merge driven by
 * fake providers (agents 1/2 stand-ins). Lockfile-backed preconditions use a
 * real lockfile on disk; status-backed ones use the fake status reader.
 */

function createFixture(): {
  repositoryRoot: string
  base: string
  writeLockfile(yaml: string): void
  cleanup(): void
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skillbox-lifecycle-'))
  const repositoryRoot = path.join(base, 'repo')
  fs.mkdirSync(repositoryRoot)
  return {
    repositoryRoot,
    base,
    writeLockfile: (yaml: string) =>
      fs.writeFileSync(path.join(repositoryRoot, 'skillbox.lock'), yaml),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

const MANAGED_LOCK = (name = 'react-best-practices'): string => `lockfileVersion: 1
skills:
  ${name}:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/${name}
    revision: abc1234def5678
    integrity: hash-1
`

const FORKED_LOCK = (name = 'react-best-practices'): string => `lockfileVersion: 1
skills:
  ${name}:
    mode: forked
    source:
      type: local
      path: skills/${name}
    integrity: hash-2
    upstream:
      source:
        type: github
        repo: vercel-labs/agent-skills
        path: skills/${name}
      baseRevision: abc1234def5678
`

const LOCAL_LOCK = (name = 'local-skill'): string => `lockfileVersion: 1
skills:
  ${name}:
    mode: local
    source:
      type: local
      path: skills/${name}
    integrity: hash-3
`

class FakeStatusReader {
  skills: SkillStatusEntry[] = []

  async status(): Promise<RepositoryStatus> {
    return {
      repositoryRoot: '/repo',
      manifestPath: '/repo/skillbox.yaml',
      manifestPresent: true,
      lockfilePath: '/repo/skillbox.lock',
      lockfilePresent: true,
      skills: this.skills,
      modified: [],
      broken: [],
      agents: [],
    }
  }
}

function managedEntry(name = 'react-best-practices'): SkillStatusEntry {
  return {
    name,
    mode: 'managed',
    status: 'ready',
    path: `/repo/.skillbox/library/${name}`,
    agents: ['claude'],
  }
}

function forkedEntry(name = 'react-best-practices'): SkillStatusEntry {
  return { name, mode: 'forked', status: 'ready', path: `/repo/skills/${name}`, agents: ['claude'] }
}

function localEntry(name = 'local-skill'): SkillStatusEntry {
  return { name, mode: 'local', status: 'ready', path: `/repo/skills/${name}`, agents: [] }
}

interface Harness {
  service: SkillLifecycleService
  lifecycle: FakeLifecycleProvider
  diff: FakeDiffProvider
  merge: FakeMergeProvider
  prompts: FakePrompts
  editor: FakeEditorLauncher
  status: FakeStatusReader
  fixture: ReturnType<typeof createFixture>
  out(): string
}

function createHarness(overrides: { isInteractive?: boolean } = {}): Harness {
  const fixture = createFixture()
  const lifecycle = new FakeLifecycleProvider()
  const diff = new FakeDiffProvider()
  const merge = new FakeMergeProvider()
  const prompts = new FakePrompts()
  const editor = new FakeEditorLauncher()
  const status = new FakeStatusReader()
  const captured = { text: '' }
  const options: SkillLifecycleServiceOptions = {
    repositoryRoot: fixture.repositoryRoot,
    homeRoot: path.join(fixture.base, 'home'),
    status,
    lifecycle,
    diff,
    merge,
    prompts,
    isInteractive: overrides.isInteractive ?? false,
    out: (chunk) => {
      captured.text += chunk
    },
    openEditor: editor,
  }
  const service = new SkillLifecycleService(options)
  return {
    service,
    lifecycle,
    diff,
    merge,
    prompts,
    editor,
    status,
    fixture,
    out: () => captured.text,
  }
}

describe('SkillLifecycleService.fork', () => {
  it('forks a managed skill with the pipeline progress and result', async () => {
    const h = createHarness()
    h.fixture.writeLockfile(MANAGED_LOCK())
    const outcome = await h.service.fork({ name: 'react-best-practices' })
    expect(outcome.mode).toBe('forked')
    expect(outcome.fromMode).toBe('managed')
    expect(outcome.baseRevision).toBe('abc1234def5678')
    expect(h.out()).toContain('Copy runtime → Snapshot → Register')
    expect(h.lifecycle.forkCalls).toHaveLength(1)
    expect(h.lifecycle.forkCalls[0]?.repositoryRoot).toBe(h.fixture.repositoryRoot)
    expect(h.lifecycle.forkCalls[0]?.homeRoot).toBe(path.join(h.fixture.base, 'home'))
  })

  it('rejects non-managed skills (SOURCE_UNSUPPORTED)', async () => {
    const h = createHarness()
    h.fixture.writeLockfile(LOCAL_LOCK())
    const error = await h.service.fork({ name: 'local-skill' }).catch((caught: unknown) => caught)
    expect(isSkillboxError(error)).toBe(true)
    expect((error as SkillboxError).code).toBe(ErrorCode.SOURCE_UNSUPPORTED)
    expect((error as SkillboxError).message).toContain('only managed')
    expect(h.lifecycle.forkCalls).toHaveLength(0)
  })

  it('reports a missing skill (SKILL_NOT_FOUND)', async () => {
    const h = createHarness()
    h.fixture.writeLockfile('lockfileVersion: 1\nskills: {}\n')
    const error = await h.service.fork({ name: 'ghost' }).catch((caught: unknown) => caught)
    expect((error as SkillboxError).code).toBe(ErrorCode.SKILL_NOT_FOUND)
  })

  it('hints at sync when the lockfile is missing', async () => {
    const h = createHarness()
    const error = await h.service
      .fork({ name: 'react-best-practices' })
      .catch((caught: unknown) => caught)
    expect((error as SkillboxError).code).toBe(ErrorCode.LOCKFILE_NOT_FOUND)
    expect((error as SkillboxError).message).toContain('skillbox sync')
  })
})

describe('SkillLifecycleService.vendor', () => {
  it('vendors a managed skill (mode → vendored)', async () => {
    const h = createHarness()
    h.fixture.writeLockfile(MANAGED_LOCK())
    const outcome = await h.service.vendor({ name: 'react-best-practices' })
    expect(outcome.mode).toBe('vendored')
    expect(outcome.fromMode).toBe('managed')
    expect(outcome.upstreamCleared).toBe(true)
    expect(h.out()).toContain('Copy runtime → Localize → Clear upstream')
    expect(h.lifecycle.vendorCalls).toHaveLength(1)
  })

  it('vendors a forked skill (forked → vendored)', async () => {
    const h = createHarness()
    h.fixture.writeLockfile(FORKED_LOCK())
    const outcome = await h.service.vendor({ name: 'react-best-practices' })
    expect(outcome.fromMode).toBe('forked')
  })

  it('rejects local skills (SOURCE_UNSUPPORTED)', async () => {
    const h = createHarness()
    h.fixture.writeLockfile(LOCAL_LOCK())
    const error = await h.service.vendor({ name: 'local-skill' }).catch((caught: unknown) => caught)
    expect((error as SkillboxError).code).toBe(ErrorCode.SOURCE_UNSUPPORTED)
  })
})

describe('SkillLifecycleService.edit', () => {
  it('opens a local skill directly without forking', async () => {
    const h = createHarness()
    h.status.skills = [localEntry()]
    const outcome = await h.service.edit({ name: 'local-skill' })
    expect(outcome.action).toBe('edited')
    expect(outcome.path).toBe(path.join('/repo', 'skills/local-skill', 'SKILL.md'))
    expect(h.editor.opened).toEqual([path.join('/repo', 'skills/local-skill', 'SKILL.md')])
    expect(h.lifecycle.forkCalls).toHaveLength(0)
  })

  it('defers a pristine managed edit without --yes (safe downgrade)', async () => {
    const h = createHarness()
    h.status.skills = [managedEntry()]
    const outcome = await h.service.edit({ name: 'react-best-practices' })
    expect(outcome.action).toBe('deferred')
    expect(h.out()).toContain('would create a local fork')
    expect(h.out()).toContain('skillbox edit react-best-practices --yes')
    expect(h.lifecycle.forkCalls).toHaveLength(0)
    expect(h.editor.opened).toHaveLength(0)
  })

  it('converts and edits with --yes non-interactively', async () => {
    const h = createHarness()
    h.status.skills = [managedEntry()]
    const outcome = await h.service.edit({ name: 'react-best-practices', yes: true })
    expect(outcome.action).toBe('forked')
    expect(outcome.baseRevision).toBe('abc1234def5678')
    expect(h.lifecycle.forkCalls).toHaveLength(1)
    expect(h.out()).toContain('Copy runtime → Snapshot → Register')
    // Editor opens the forked copy's SKILL.md (fresh status path wins).
    expect(h.editor.opened[0]?.endsWith('SKILL.md')).toBe(true)
  })

  it('asks before converting interactively and cancels cleanly', async () => {
    const h = createHarness({ isInteractive: true })
    h.status.skills = [managedEntry()]
    h.prompts.confirmResult = false
    const outcome = await h.service.edit({ name: 'react-best-practices' })
    expect(outcome.action).toBe('cancelled')
    expect(h.prompts.calls.join()).toContain('Editing will create a local fork')
    expect(h.lifecycle.forkCalls).toHaveLength(0)
  })

  it('converts after an interactive confirm', async () => {
    const h = createHarness({ isInteractive: true })
    h.status.skills = [managedEntry()]
    h.prompts.confirmResult = true
    const outcome = await h.service.edit({ name: 'react-best-practices' })
    expect(outcome.action).toBe('forked')
    expect(h.lifecycle.forkCalls).toHaveLength(1)
  })

  it('offers [Convert to Fork]/[Restore] for modified runtimes and restores on choice', async () => {
    const h = createHarness({ isInteractive: true })
    h.status.skills = [managedEntry()]
    h.lifecycle.modifications = {
      name: 'react-best-practices',
      modified: true,
      files: ['SKILL.md'],
    }
    h.prompts.selectResult = 'restore'
    const outcome = await h.service.edit({ name: 'react-best-practices' })
    expect(outcome.action).toBe('restored')
    expect(h.prompts.calls.join()).toContain('Convert to Fork')
    expect(h.prompts.calls.join()).toContain('Restore')
    expect(h.lifecycle.restoreCalls).toHaveLength(1)
    expect(h.out()).toContain('Restored 4 file(s)')
    // Restored runtimes are pristine managed again — no editor opens and the
    // flow points back at the fork conversion.
    expect(h.out()).toContain('pristine again')
    expect(h.out()).toContain('skillbox edit react-best-practices')
    expect(h.editor.opened).toHaveLength(0)
  })

  it('defaults --yes on modified runtimes to the change-preserving fork', async () => {
    const h = createHarness()
    h.status.skills = [managedEntry()]
    h.lifecycle.modifications = {
      name: 'react-best-practices',
      modified: true,
      files: ['SKILL.md'],
    }
    const outcome = await h.service.edit({ name: 'react-best-practices', yes: true })
    expect(outcome.action).toBe('forked')
    expect(h.lifecycle.forkCalls).toHaveLength(1)
    expect(h.lifecycle.restoreCalls).toHaveLength(0)
  })

  it('defers modified edits without --yes and never touches the runtime', async () => {
    const h = createHarness()
    h.status.skills = [managedEntry()]
    h.lifecycle.modifications = {
      name: 'react-best-practices',
      modified: true,
      files: ['SKILL.md'],
    }
    const outcome = await h.service.edit({ name: 'react-best-practices' })
    expect(outcome.action).toBe('deferred')
    expect(h.out()).toContain('has local modifications')
    expect(h.lifecycle.forkCalls).toHaveLength(0)
    expect(h.lifecycle.restoreCalls).toHaveLength(0)
  })

  it('degrades to the unmodified path while modification detection is unavailable', async () => {
    const h = createHarness()
    h.status.skills = [managedEntry()]
    h.lifecycle.detectError = new SkillboxError(
      LIFECYCLE_UNAVAILABLE_CODE,
      'detection not available',
    )
    const outcome = await h.service.edit({ name: 'react-best-practices' })
    expect(outcome.action).toBe('deferred')
    expect(h.out()).toContain('would create a local fork')
  })

  it('prints the file path when no editor can be launched', async () => {
    const h = createHarness()
    h.status.skills = [localEntry()]
    h.editor.canOpen = false
    const outcome = await h.service.edit({ name: 'local-skill' })
    expect(outcome.action).toBe('edited')
    expect(h.out()).toContain('No editor configured (set EDITOR or VISUAL)')
    expect(h.out()).toContain(path.join('/repo', 'skills/local-skill', 'SKILL.md'))
  })

  it('reports a missing skill (SKILL_NOT_FOUND)', async () => {
    const h = createHarness()
    const error = await h.service.edit({ name: 'ghost' }).catch((caught: unknown) => caught)
    expect((error as SkillboxError).code).toBe(ErrorCode.SKILL_NOT_FOUND)
  })
})

describe('createDefaultEditorLauncher', () => {
  it('resolves false without an editor configured', async () => {
    const launcher = createDefaultEditorLauncher({})
    expect(await launcher.open('/repo/skills/x/SKILL.md')).toBe(false)
  })
})

describe('SkillLifecycleService.diff', () => {
  it('computes unchanged from the views (managed)', async () => {
    const h = createHarness()
    h.status.skills = [managedEntry()]
    h.diff.diffResult = {
      name: 'react-best-practices',
      mode: 'managed',
      views: [{ label: 'Current vs Latest', files: [] }],
      unchanged: true,
    }
    const diff = await h.service.diff({ name: 'react-best-practices' })
    expect(diff.unchanged).toBe(true)
    expect(h.diff.diffCalls[0]?.name).toBe('react-best-practices')
  })

  it('marks a diff with files as changed (forked)', async () => {
    const h = createHarness()
    h.status.skills = [forkedEntry()]
    h.diff.diffResult = {
      name: 'react-best-practices',
      mode: 'forked',
      views: [
        { label: 'Base', files: [] },
        { label: 'Local', files: [{ path: 'SKILL.md', status: 'modified', patch: '-a\n+b' }] },
        { label: 'Upstream', files: [] },
      ],
      unchanged: false,
    }
    const diff = await h.service.diff({ name: 'react-best-practices' })
    expect(diff.unchanged).toBe(false)
    expect(diff.views[1]?.files[0]?.patch).toBe('-a\n+b')
  })

  it('rejects local skills (SOURCE_UNSUPPORTED)', async () => {
    const h = createHarness()
    h.status.skills = [localEntry()]
    const error = await h.service.diff({ name: 'local-skill' }).catch((caught: unknown) => caught)
    expect((error as SkillboxError).code).toBe(ErrorCode.SOURCE_UNSUPPORTED)
  })
})

describe('SkillLifecycleService.merge', () => {
  it('summarizes a clean 3-way merge', async () => {
    const h = createHarness()
    h.status.skills = [forkedEntry()]
    h.merge.mergeResult = {
      name: 'react-best-practices',
      conflicts: [],
      filesMerged: 3,
      changes: 42,
      baseRevision: 'def56789abcd',
    }
    const outcome = await h.service.merge({ name: 'react-best-practices', action: 'merge' })
    expect(outcome.kind).toBe('merged')
    if (outcome.kind === 'merged') {
      expect(outcome.filesMerged).toBe(3)
      expect(outcome.changes).toBe(42)
      expect(outcome.baseRevision).toBe('def56789abcd')
    }
    expect(h.merge.mergeCalls).toHaveLength(1)
  })

  it('reports conflicts with the continue hint (MERGE_CONFLICT)', async () => {
    const h = createHarness()
    h.status.skills = [forkedEntry()]
    h.merge.mergeResult = {
      name: 'react-best-practices',
      conflicts: [
        { path: 'src/index.ts', hunks: 3 },
        { path: 'assets/logo.png', hunks: 1, reason: 'binary' },
      ],
      filesMerged: 1,
      changes: 5,
    }
    const error = await h.service
      .merge({ name: 'react-best-practices', action: 'merge' })
      .catch((caught: unknown) => caught)
    expect(isSkillboxError(error)).toBe(true)
    expect((error as SkillboxError).code).toBe(MERGE_CONFLICT_CODE)
    expect((error as SkillboxError).message).toContain('2 conflicting file(s)')
    expect((error as SkillboxError).message).toContain('src/index.ts (3 hunks)')
    expect((error as SkillboxError).message).toContain('assets/logo.png (1 hunk, binary)')
    expect((error as SkillboxError).message).toContain(
      'skillbox merge react-best-practices --continue',
    )
  })

  it('finishes a resolved merge via --continue', async () => {
    const h = createHarness()
    h.status.skills = [forkedEntry()]
    const outcome = await h.service.merge({ name: 'react-best-practices', action: 'continue' })
    expect(outcome.kind).toBe('continued')
    expect(h.merge.continueCalls).toHaveLength(1)
  })

  it('fails --continue with the remaining conflicts', async () => {
    const h = createHarness()
    h.status.skills = [forkedEntry()]
    h.merge.continueResult = {
      name: 'react-best-practices',
      resolved: false,
      remainingConflicts: [{ path: 'src/index.ts', hunks: 2 }],
      filesMerged: 1,
      changes: 2,
    }
    const error = await h.service
      .merge({ name: 'react-best-practices', action: 'continue' })
      .catch((caught: unknown) => caught)
    expect((error as SkillboxError).code).toBe(MERGE_CONFLICT_CODE)
    expect((error as SkillboxError).message).toContain('still has 1 unresolved')
    expect((error as SkillboxError).message).toContain('src/index.ts (2 hunks)')
  })

  it('aborts and reports the restored files', async () => {
    const h = createHarness()
    h.status.skills = [forkedEntry()]
    const outcome = await h.service.merge({ name: 'react-best-practices', action: 'abort' })
    expect(outcome.kind).toBe('aborted')
    if (outcome.kind === 'aborted') {
      expect(outcome.filesRestored).toBe(5)
    }
    expect(h.merge.abortCalls).toHaveLength(1)
  })

  it('rejects managed skills with the update hint', async () => {
    const h = createHarness()
    h.status.skills = [managedEntry()]
    const error = await h.service
      .merge({ name: 'react-best-practices', action: 'merge' })
      .catch((caught: unknown) => caught)
    expect((error as SkillboxError).code).toBe(ErrorCode.SOURCE_UNSUPPORTED)
    expect((error as SkillboxError).message).toContain('skillbox update')
    expect(h.merge.mergeCalls).toHaveLength(0)
  })
})
