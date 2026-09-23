import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorCode, SkillboxError } from '../errors.js'
import { withTempDir } from '../fs/test-utils.js'
import type { GitStatusResult } from '../git/index.js'
import { repositoryKey } from '../operations/sync-runtime-lock.js'
import { SyncTransaction } from './sync-transaction.js'
import type { ConflictSession, RepositoryGitPort } from './types.js'

/** Structured cleanup facts the transaction is expected to attach to the original error. */
interface RollbackFacts {
  snapshotId: string
  restoreFailed: boolean
  failures: Array<{ step: string; target: string; message: string; blocking: boolean }>
}

function rollbackFacts(error: unknown): RollbackFacts {
  const context = (error as { context?: Record<string, unknown> }).context
  expect(context?.['rollback']).toBeDefined()
  return context?.['rollback'] as RollbackFacts
}

interface FailureSwitches {
  /** Error the transaction body fails with, i.e. the "original" error to preserve. */
  mergeFailure: Error
  /** Fails the restore of the pre-transaction tree during rollback. */
  restoreFails?: boolean
  /** Leaks a temporary worktree during cleanup. */
  worktreeRemovalFails?: boolean
}

const LOCAL = 'local-rev'
const REMOTE = 'remote-rev'
const BASE = 'base-rev'

/** Minimal transaction-capable Git port: every repository mutation is a no-op or a switch. */
class FakeTransactionGit implements RepositoryGitPort {
  /**
   * `createPrivateRef` pins the restore point once and is called again by the
   * rollback restore, so the second call is the restore step.
   */
  private privateRefCalls = 0

  constructor(private readonly switches: FailureSwitches) {}

  async isInstalled(): Promise<boolean> {
    return true
  }
  async isRepository(): Promise<boolean> {
    return true
  }
  async init(): Promise<void> {}
  async status(repositoryRoot: string): Promise<GitStatusResult> {
    return {
      repositoryRoot,
      branch: 'main',
      upstream: 'origin/main',
      remote: { name: 'origin', url: 'https://example.test/skills.git' },
      ahead: 1,
      behind: 1,
      files: [],
      conflicts: [],
      hasConflicts: false,
      staged: [],
      unstaged: [],
      untracked: [],
      clean: true,
    }
  }
  async getRemote(): Promise<{ name: string; url: string } | undefined> {
    return undefined
  }
  async addRemote(): Promise<void> {}
  async removeRemote(): Promise<void> {}
  async pull(): Promise<void> {}
  async push(): Promise<void> {}
  async fetch(): Promise<void> {}
  async revParse(_repositoryRoot: string, revision: string): Promise<string> {
    return revision === 'HEAD' ? LOCAL : revision === 'origin/main' ? REMOTE : revision
  }
  async mergeBase(): Promise<string> {
    return BASE
  }
  async createWorktree(): Promise<void> {
    throw this.switches.mergeFailure
  }
  async removeWorktree(): Promise<void> {
    if (this.switches.worktreeRemovalFails === true) throw new Error('worktree is in use')
  }
  async commit(): Promise<{ hash: string }> {
    return { hash: LOCAL }
  }
  async stage(): Promise<void> {}
  async beginSemanticMerge(): Promise<void> {}
  async abortMerge(): Promise<void> {}
  async createPrivateRef(): Promise<void> {
    this.privateRefCalls += 1
    // Odd calls pin the restore point, even calls are the rollback's restore, so a
    // retry can fail at the same place twice instead of failing to pin at all.
    if (this.switches.restoreFails === true && this.privateRefCalls % 2 === 0)
      throw new Error('cannot lock ref')
  }
  async deletePrivateRef(): Promise<void> {}
}

function transaction(dir: string, git: RepositoryGitPort, repositoryRoot: string): SyncTransaction {
  return new SyncTransaction({
    repositoryRoot,
    homeRoot: path.join(dir, 'home'),
    git,
    auth: async () => ({ prefixArgs: [], env: {}, sensitiveEnvKeys: [] }),
    event: () => undefined,
  })
}

function session(repositoryRoot: string): ConflictSession {
  return {
    version: 1,
    id: 'session-1',
    repositoryId: repositoryKey(repositoryRoot),
    baseRevision: BASE,
    localRevision: LOCAL,
    remoteRevision: REMOTE,
    snapshotId: 'snapshot-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    conflicts: [],
  }
}

async function rejected(run: Promise<unknown>): Promise<unknown> {
  return run.catch((error: unknown) => error)
}

describe('SyncTransaction rollback reporting', () => {
  it('keeps the original error and reports a failed working-tree restore', async () => {
    await withTempDir(async (dir) => {
      const repositoryRoot = path.join(dir, 'repo')
      await fs.mkdir(repositoryRoot, { recursive: true })
      const original = new SkillboxError(ErrorCode.GIT_COMMAND_FAILED, 'no merge tree', {
        context: { command: 'worktree add' },
      })
      const git = new FakeTransactionGit({
        mergeFailure: original,
        restoreFails: true,
        worktreeRemovalFails: true,
      })

      const thrown = await rejected(transaction(dir, git, repositoryRoot).run())

      expect(thrown).toBe(original)
      expect(thrown).toMatchObject({ code: ErrorCode.GIT_COMMAND_FAILED })
      const error = thrown as SkillboxError
      // What a caller prints still leads with the sync failure itself.
      expect(error.message.startsWith('no merge tree')).toBe(true)
      expect(error.message).toMatch(/working tree was not restored/)
      // Pre-existing context survives the attach.
      expect(error.context?.['command']).toBe('worktree add')

      const rollback = rollbackFacts(error)
      expect(rollback.restoreFailed).toBe(true)
      expect(rollback.snapshotId.length).toBeGreaterThan(8)
      const byStep = new Map(rollback.failures.map((failure) => [failure.step, failure] as const))
      // An unrestored tree outranks a leaked worktree: only it is blocking.
      expect(byStep.get('restore')).toMatchObject({ blocking: true, message: 'cannot lock ref' })
      expect(byStep.get('remove-worktree')?.blocking).toBe(false)
    })
  })

  it('appends the rollback sentence once even when one error is annotated twice', async () => {
    await withTempDir(async (dir) => {
      const repositoryRoot = path.join(dir, 'repo')
      await fs.mkdir(repositoryRoot, { recursive: true })
      // One error instance reused by a retrying caller: the second rollback must
      // add its facts to the report without re-sending the user the same sentence.
      const original = new SkillboxError(ErrorCode.GIT_COMMAND_FAILED, 'no merge tree')
      const git = new FakeTransactionGit({ mergeFailure: original, restoreFails: true })
      const tx = transaction(dir, git, repositoryRoot)

      const first = (await rejected(tx.run())) as SkillboxError
      const sentencesAfterFirst = (first.message.match(/rollback is incomplete/g) ?? []).length
      const failuresAfterFirst = rollbackFacts(first).failures.length

      const second = (await rejected(tx.run())) as SkillboxError

      // Same object, same classification: a caller still matches on `code`.
      expect(second).toBe(original)
      expect(second).toMatchObject({ code: ErrorCode.GIT_COMMAND_FAILED })
      expect(sentencesAfterFirst).toBe(1)
      expect(second.message).toBe(first.message)
      expect(rollbackFacts(second).failures.length).toBeGreaterThan(failuresAfterFirst)
    })
  })

  it('reports a leaked worktree without claiming the working tree is unrestored', async () => {
    await withTempDir(async (dir) => {
      const repositoryRoot = path.join(dir, 'repo')
      await fs.mkdir(repositoryRoot, { recursive: true })
      const original = new Error('no merge tree')
      const git = new FakeTransactionGit({ mergeFailure: original, worktreeRemovalFails: true })

      const thrown = await rejected(transaction(dir, git, repositoryRoot).run())

      expect(thrown).toBe(original)
      const rollback = rollbackFacts(thrown)
      expect(rollback.restoreFailed).toBe(false)
      // Nothing was restored wrongly; only the three temporary worktrees leaked.
      expect(rollback.failures.map((failure) => failure.step)).toEqual([
        'remove-worktree',
        'remove-worktree',
        'remove-worktree',
      ])
      expect((thrown as Error).message).toMatch(
        /rollback cleanup was also incomplete: 3 temporary worktrees were left behind/,
      )
      expect((thrown as Error).message).not.toMatch(/restored/)
    })
  })

  it('leaves the error untouched when every rollback step succeeds', async () => {
    await withTempDir(async (dir) => {
      const repositoryRoot = path.join(dir, 'repo')
      await fs.mkdir(repositoryRoot, { recursive: true })
      const original = new SkillboxError(ErrorCode.GIT_COMMAND_FAILED, 'no merge tree', {
        context: { command: 'worktree add' },
      })
      const git = new FakeTransactionGit({ mergeFailure: original })

      const thrown = await rejected(transaction(dir, git, repositoryRoot).run())

      expect(thrown).toBe(original)
      expect((thrown as Error).message).toBe('no merge tree')
      expect((thrown as SkillboxError).context).toEqual({ command: 'worktree add' })
    })
  })

  it('attaches cleanup failures on the conflict-resolution rollback path', async () => {
    await withTempDir(async (dir) => {
      const repositoryRoot = path.join(dir, 'repo')
      await fs.mkdir(repositoryRoot, { recursive: true })
      const original = new Error('no merge tree')
      const git = new FakeTransactionGit({ mergeFailure: original, worktreeRemovalFails: true })

      const thrown = await rejected(
        transaction(dir, git, repositoryRoot).resolve(session(repositoryRoot), {}),
      )

      expect(thrown).toBe(original)
      const rollback = rollbackFacts(thrown)
      // The session's restore point is gone by then, so the restore fails too.
      expect(rollback.restoreFailed).toBe(true)
      expect(rollback.snapshotId).toBe('snapshot-1')
    })
  })
})
