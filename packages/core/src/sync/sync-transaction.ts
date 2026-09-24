import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ErrorCode, SkillboxError } from '../errors.js'
import { writeLockfile } from '../lockfile/index.js'
import { writeManifest } from '../manifest/index.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import { createOperationRuntime, type OperationRuntime } from '../operations/runtime.js'
import { ConflictSessionStore } from './conflict-session-store.js'
import { ManifestMergeService } from './manifest-merge.js'
import { LockResolver } from './lock-resolver.js'
import { RepositoryValidator } from './repository-validator.js'
import { SkillTreeMergeService } from './skill-tree-merge.js'
import { SnapshotService } from './snapshot-service.js'
import type {
  ConflictResolution,
  ConflictSession,
  RepositoryGitPort,
  SyncOutcome,
} from './types.js'

/** Git-port members the transaction needs; `hasTransactionGit` proves they exist. */
type TransactionGitPort = RepositoryGitPort &
  Required<
    Pick<
      RepositoryGitPort,
      | 'fetch'
      | 'revParse'
      | 'mergeBase'
      | 'createWorktree'
      | 'removeWorktree'
      | 'commit'
      | 'stage'
      | 'beginSemanticMerge'
      | 'abortMerge'
      | 'createPrivateRef'
      | 'deletePrivateRef'
    >
  >

/** Cleanup step run while leaving a failed transaction. */
export type CleanupStep = 'abort-merge' | 'restore' | 'remove-worktree' | 'remove-tree'

/** One rollback/cleanup step that failed, reported through the thrown error's context. */
export interface CleanupFailure {
  step: CleanupStep
  /** Restore-point id or path the step was working on. */
  target: string
  message: string
  /**
   * A leaked worktree is clutter the next sync ignores, while a working tree that
   * was never restored leaves the user mid-transaction.  Reporting them the same
   * way would bury the one fact the user has to act on.
   */
  blocking: boolean
}

/** `context.rollback` attached to the error a failed transaction rethrows. */
export interface RollbackReport {
  snapshotId: string
  /** True only when the pre-transaction working tree is still unrestored. */
  restoreFailed: boolean
  failures: CleanupFailure[]
}

/** Performs all repository mutations through a temporary, semantic merge tree. */
export class SyncTransaction {
  constructor(
    private readonly input: {
      repositoryRoot: string
      homeRoot: string
      git: RepositoryGitPort
      auth: () => Promise<import('../git/index.js').GitTransportAuth>
      event: (phase: import('./types.js').RepositorySyncPhase) => void
      /** Optional shared operation boundary for composing a larger workflow. */
      operationRuntime?: OperationRuntime
    },
  ) {}

  /** Serializes a sync while the Git-aware SnapshotService owns repository recovery. */
  async run(): Promise<SyncOutcome> {
    const operation = await this.operationRuntime().runExclusive({
      kind: 'sync',
      targets: [],
      retainForRollback: false,
      execute: () => this.runUnsafe(),
    })
    return operation.result
  }

  private async runUnsafe(attempt = 0): Promise<SyncOutcome> {
    const { repositoryRoot, git } = this.input
    if (!hasTransactionGit(git))
      return {
        kind: 'blocked',
        reason: 'recovery-required',
        recovery: {
          retryable: true,
          message: 'This Git implementation cannot safely perform a repository sync.',
        },
      }
    this.input.event('preflight')
    const status = await git.status(repositoryRoot)
    if (status.hasConflicts)
      return {
        kind: 'blocked',
        reason: 'git-merge-in-progress',
        recovery: {
          retryable: true,
          message: 'Finish or abort the existing repository operation before syncing again.',
        },
      }
    if (status.upstream === undefined || status.branch === undefined || status.remote === undefined)
      return {
        kind: 'blocked',
        reason: 'recovery-required',
        recovery: { retryable: true, message: 'Connect this repository before syncing.' },
      }
    this.input.event('fetch')
    await git.fetch(repositoryRoot, status.remote.name, await this.input.auth())
    const [local, remote] = await Promise.all([
      git.revParse(repositoryRoot, 'HEAD'),
      git.revParse(repositoryRoot, status.upstream),
    ])
    if (local === remote)
      return { kind: 'completed', summary: { automaticallyMerged: 0, retriedPushes: 0 } }
    const base = await git.mergeBase(repositoryRoot, local, remote)
    this.input.event('snapshot')
    const snapshots = new SnapshotService({ repositoryRoot, homeRoot: this.input.homeRoot, git })
    const snapshot = await snapshots.create()
    const id = snapshot.id
    const treeRoot = path.join(buildSkillboxHomeLayout(this.input.homeRoot).syncTrees, id)
    const baseRoot = path.join(treeRoot, 'base'),
      localRoot = path.join(treeRoot, 'local'),
      remoteRoot = path.join(treeRoot, 'remote'),
      outputRoot = path.join(treeRoot, 'merged')
    const worktreeRoots = [baseRoot, localRoot, remoteRoot]
    const cleanup: CleanupFailure[] = []
    let released = false
    try {
      await Promise.all([
        git.createWorktree(repositoryRoot, baseRoot, base),
        git.createWorktree(repositoryRoot, localRoot, local),
        git.createWorktree(repositoryRoot, remoteRoot, remote),
      ])
      await fs.cp(localRoot, outputRoot, {
        recursive: true,
        filter: (source) => path.basename(source) !== '.git',
      })
      this.input.event('merge')
      const manifests = await Promise.all([
        import('../manifest/index.js').then(({ readManifest }) => readManifest(baseRoot)),
        import('../manifest/index.js').then(({ readManifest }) => readManifest(localRoot)),
        import('../manifest/index.js').then(({ readManifest }) => readManifest(remoteRoot)),
      ])
      const merged = new ManifestMergeService().merge({
        base: manifests[0],
        local: manifests[1],
        remote: manifests[2],
      })
      const conflicts = [...merged.conflicts]
      // The copied local tree is only a convenient starting point for
      // repository-level files.  Skill directories must be rebuilt from the
      // merged manifest so a remotely deleted skill cannot survive as an
      // untracked stale directory in the resulting commit.
      await fs.rm(path.join(outputRoot, 'skills'), { recursive: true, force: true })
      for (const alias of Object.keys(merged.manifest.skills)) {
        const result = await new SkillTreeMergeService().merge({
          baseRoot: path.join(baseRoot, 'skills', alias),
          localRoot: path.join(localRoot, 'skills', alias),
          remoteRoot: path.join(remoteRoot, 'skills', alias),
          outputRoot: path.join(outputRoot, 'skills', alias),
          skillAlias: alias,
        })
        conflicts.push(...result.conflicts)
      }
      if (conflicts.length > 0) {
        const session = {
          version: 1 as const,
          id,
          repositoryId: (await import('../operations/sync-runtime-lock.js')).repositoryKey(
            path.resolve(repositoryRoot),
          ),
          baseRevision: base,
          localRevision: local,
          remoteRevision: remote,
          snapshotId: snapshot.id,
          createdAt: snapshot.createdAt,
          expiresAt: snapshot.expiresAt,
          conflicts,
        }
        await new ConflictSessionStore({ repositoryRoot, homeRoot: this.input.homeRoot }).save(
          session,
        )
        return { kind: 'conflicts', session }
      }
      await writeManifest(outputRoot, merged.manifest)
      const lockfile = await new LockResolver().resolve(merged.manifest, outputRoot)
      await writeLockfile(outputRoot, lockfile)
      this.input.event('validate')
      await new RepositoryValidator().validate(outputRoot, lockfile)
      this.input.event('commit')
      await git.beginSemanticMerge(repositoryRoot, remote)
      for (const name of ['skillbox.yaml', 'skillbox.lock', 'skills'] as const) {
        const source = path.join(outputRoot, name),
          destination = path.join(repositoryRoot, name)
        await fs.rm(destination, { recursive: true, force: true })
        // A valid manifest may contain no skills, in which case no `skills/`
        // directory is produced.  Removing the old destination is still
        // required, but copying a nonexistent source is not.
        if (await exists(source)) await fs.cp(source, destination, { recursive: true, force: true })
      }
      await git.stage(repositoryRoot, ['skillbox.yaml', 'skillbox.lock', 'skills'])
      // Git rejects a path-limited commit while MERGE_HEAD exists. The index
      // starts as the local tree (`-s ours`) and we staged only managed paths,
      // so an ordinary commit is both valid and scope-preserving.
      await git.commit(repositoryRoot, 'skillbox: synchronize devices')
      try {
        await git.push(repositoryRoot, {
          remote: status.remote.name,
          branch: status.branch,
          auth: await this.input.auth(),
        })
      } catch (error) {
        if (isPushRejected(error)) {
          if (attempt >= 2) {
            return {
              kind: 'blocked',
              reason: 'push-retry-exhausted',
              recovery: {
                retryable: true,
                snapshotId: snapshot.id,
                message:
                  'The other device continued changing this repository. Your local synchronized commit is safe; sync again to reconcile it.',
              },
            }
          }
          // A non-fast-forward rejection is expected in a multi-device race.
          // Keep the local commit, fetch a fresh remote revision and repeat the
          // semantic three-way merge.  This never force-pushes or overwrites
          // either device's commit.
          this.input.event('retry-push')
          await git.fetch(repositoryRoot, status.remote.name, await this.input.auth())
          // Some transports reject transiently despite advertising the same
          // remote revision. Retrying the identical merge commit is safe and
          // avoids creating an empty follow-up transaction.
          if ((await git.revParse(repositoryRoot, status.upstream)) === remote) {
            await git.push(repositoryRoot, {
              remote: status.remote.name,
              branch: status.branch,
              auth: await this.input.auth(),
            })
            return {
              kind: 'completed',
              summary: {
                automaticallyMerged: merged.automaticallyMerged,
                createdSnapshotId: snapshot.id,
                retriedPushes: 1,
              },
            }
          }
          const retried = await this.runUnsafe(attempt + 1)
          if (retried.kind === 'completed') {
            return {
              ...retried,
              summary: {
                ...retried.summary,
                createdSnapshotId: retried.summary.createdSnapshotId ?? snapshot.id,
                retriedPushes: retried.summary.retriedPushes + 1,
              },
            }
          }
          return retried
        }
        throw error
      }
      return {
        kind: 'completed',
        summary: {
          automaticallyMerged: merged.automaticallyMerged,
          createdSnapshotId: snapshot.id,
          retriedPushes: 0,
        },
      }
    } catch (error) {
      await this.rollback(git, snapshots, snapshot.id, worktreeRoots, treeRoot, cleanup)
      released = true
      throw reportCleanup(error, cleanup, snapshot.id)
    } finally {
      if (!released) await this.releaseTrees(git, worktreeRoots, treeRoot, cleanup)
    }
  }

  /** Materializes confirmed user choices only in a disposable worktree. */
  async resolve(
    session: ConflictSession,
    resolutions: Record<string, ConflictResolution>,
  ): Promise<SyncOutcome> {
    const operation = await this.operationRuntime().runExclusive({
      kind: 'sync',
      targets: [],
      retainForRollback: false,
      execute: () => this.resolveUnsafe(session, resolutions),
    })
    return operation.result
  }

  private async resolveUnsafe(
    session: ConflictSession,
    resolutions: Record<string, ConflictResolution>,
  ): Promise<SyncOutcome> {
    const { repositoryRoot, git } = this.input
    if (!hasTransactionGit(git))
      return {
        kind: 'blocked',
        reason: 'recovery-required',
        recovery: {
          retryable: true,
          snapshotId: session.snapshotId,
          message: 'This Git implementation cannot safely apply the selected resolutions.',
        },
      }
    const status = await git.status(repositoryRoot)
    if (status.remote === undefined || status.branch === undefined)
      return {
        kind: 'blocked',
        reason: 'recovery-required',
        recovery: {
          retryable: true,
          snapshotId: session.snapshotId,
          message: 'Connect this repository before applying resolutions.',
        },
      }
    // Do not silently apply decisions made against a different local tree.
    if ((await git.revParse(repositoryRoot, 'HEAD')) !== session.localRevision)
      return {
        kind: 'blocked',
        reason: 'recovery-required',
        recovery: {
          retryable: true,
          snapshotId: session.snapshotId,
          message:
            'This device changed since the conflict was shown. Sync again to create a fresh conflict review.',
        },
      }
    const treeRoot = path.join(
      buildSkillboxHomeLayout(this.input.homeRoot).syncTrees,
      `resolve-${session.id}`,
    )
    const baseRoot = path.join(treeRoot, 'base'),
      localRoot = path.join(treeRoot, 'local'),
      remoteRoot = path.join(treeRoot, 'remote'),
      outputRoot = path.join(treeRoot, 'merged')
    const snapshots = new SnapshotService({ repositoryRoot, homeRoot: this.input.homeRoot, git })
    const worktreeRoots = [baseRoot, localRoot, remoteRoot]
    const cleanup: CleanupFailure[] = []
    let released = false
    try {
      await Promise.all([
        git.createWorktree(repositoryRoot, baseRoot, session.baseRevision),
        git.createWorktree(repositoryRoot, localRoot, session.localRevision),
        git.createWorktree(repositoryRoot, remoteRoot, session.remoteRevision),
      ])
      await fs.cp(localRoot, outputRoot, {
        recursive: true,
        filter: (source) => path.basename(source) !== '.git',
      })
      const { readManifest } = await import('../manifest/index.js')
      const [base, local, remote] = await Promise.all([
        readManifest(baseRoot),
        readManifest(localRoot),
        readManifest(remoteRoot),
      ])
      const merged = new ManifestMergeService().merge({ base, local, remote })
      const dropped = applyManifestChoices(
        merged.manifest as unknown as Record<string, unknown>,
        local as unknown as Record<string, unknown>,
        remote as unknown as Record<string, unknown>,
        session,
        resolutions,
      )
      for (const conflict of session.conflicts.filter((item) => item.type === 'content')) {
        const resolution = resolutions[conflict.id]
        if (resolution !== 'local' && resolution !== 'remote') continue
        if (conflict.skillAlias === undefined || conflict.path === undefined) continue
        await copyResolvedFile(
          resolution === 'local' ? localRoot : remoteRoot,
          outputRoot,
          conflict.skillAlias,
          conflict.path,
        )
      }
      // keep-both preserves full skills under deterministic aliases; this is
      // deliberately done at the directory level so no preview becomes data.
      for (const conflict of session.conflicts.filter(
        (item) => resolutions[item.id] === 'keep-both' && item.skillAlias !== undefined,
      )) {
        const alias = conflict.skillAlias!
        const skills = (merged.manifest as { skills: Record<string, unknown> }).skills
        if (skills[alias] === undefined)
          skills[alias] = (local as { skills: Record<string, unknown> }).skills[alias]
        const copyAlias = allocateAlias(skills, alias)
        const copiedSkill = structuredClone(
          (remote as { skills: Record<string, unknown> }).skills[alias],
        ) as Record<string, unknown>
        const source = copiedSkill.source as Record<string, unknown> | undefined
        if (source?.type === 'local' && source.path === `skills/${alias}`)
          source.path = `skills/${copyAlias}`
        skills[copyAlias] = copiedSkill
        await fs.cp(
          path.join(remoteRoot, 'skills', alias),
          path.join(outputRoot, 'skills', copyAlias),
          { recursive: true, force: true },
        )
      }
      // `runUnsafe` rebuilds `skills/` from the merged manifest, and that rebuild is
      // what stops a deleted skill from surviving there.  This path cannot rebuild:
      // the output tree deliberately starts as a copy of this device's tree because
      // the content and keep-both choices are applied onto it.  So remove exactly the
      // directories a choice took out of the manifest — never a skill that took no
      // part in a conflict, and never a keep-both copy, which the manifest lists.
      await pruneResolvedSkills(outputRoot, merged.manifest, dropped)
      await writeManifest(outputRoot, merged.manifest)
      const lockfile = await new LockResolver().resolve(merged.manifest, outputRoot)
      await writeLockfile(outputRoot, lockfile)
      await new RepositoryValidator().validate(outputRoot, lockfile)
      await git.beginSemanticMerge(repositoryRoot, session.remoteRevision)
      for (const name of ['skillbox.yaml', 'skillbox.lock', 'skills'] as const) {
        const source = path.join(outputRoot, name),
          destination = path.join(repositoryRoot, name)
        await fs.rm(destination, { recursive: true, force: true })
        if (await exists(source)) await fs.cp(source, destination, { recursive: true, force: true })
      }
      await git.stage(repositoryRoot, ['skillbox.yaml', 'skillbox.lock', 'skills'])
      await git.commit(repositoryRoot, 'skillbox: resolve device conflicts')
      await git.push(repositoryRoot, {
        remote: status.remote.name,
        branch: status.branch,
        auth: await this.input.auth(),
      })
      await new ConflictSessionStore({ repositoryRoot, homeRoot: this.input.homeRoot }).delete(
        session.id,
      )
      return {
        kind: 'completed',
        summary: {
          automaticallyMerged: 0,
          createdSnapshotId: session.snapshotId,
          retriedPushes: 0,
        },
      }
    } catch (error) {
      await this.rollback(git, snapshots, session.snapshotId, worktreeRoots, treeRoot, cleanup)
      released = true
      throw reportCleanup(error, cleanup, session.snapshotId)
    } finally {
      if (!released) await this.releaseTrees(git, worktreeRoots, treeRoot, cleanup)
    }
  }

  /**
   * Leaves a failed transaction the way it was entered: unstage the semantic
   * merge, replay the restore point and release the temporary trees.  Every step
   * is best-effort, so failures accumulate in `cleanup` for the caller to report
   * instead of being swallowed here.
   */
  private async rollback(
    git: TransactionGitPort,
    snapshots: SnapshotService,
    snapshotId: string,
    worktreeRoots: readonly string[],
    treeRoot: string,
    cleanup: CleanupFailure[],
  ): Promise<void> {
    const repositoryRoot = this.input.repositoryRoot
    await recordCleanup(cleanup, 'abort-merge', repositoryRoot, () =>
      git.abortMerge(repositoryRoot),
    )
    await recordCleanup(cleanup, 'restore', snapshotId, () => snapshots.restore(snapshotId))
    await this.releaseTrees(git, worktreeRoots, treeRoot, cleanup)
  }

  /** Drops the temporary merge trees; safe to call once per transaction. */
  private async releaseTrees(
    git: TransactionGitPort,
    worktreeRoots: readonly string[],
    treeRoot: string,
    cleanup: CleanupFailure[],
  ): Promise<void> {
    const repositoryRoot = this.input.repositoryRoot
    await Promise.all(
      worktreeRoots.map((root) =>
        recordCleanup(
          cleanup,
          'remove-worktree',
          root,
          () => git.removeWorktree(repositoryRoot, root),
          // When the transaction died *creating* a worktree there is nothing left
          // behind, and "1 temporary worktree were left behind" would be a lie.
          (reason) => reason.includes('is not a working tree'),
        ),
      ),
    )
    await recordCleanup(cleanup, 'remove-tree', treeRoot, () =>
      fs.rm(treeRoot, { recursive: true, force: true }),
    )
  }

  private operationRuntime(): OperationRuntime {
    return (
      this.input.operationRuntime ??
      createOperationRuntime({
        repositoryRoot: this.input.repositoryRoot,
        homeRoot: this.input.homeRoot,
      })
    )
  }
}

/**
 * Applies the whole-skill and per-field `local`/`remote` choices to the merged
 * manifest in place, and returns the aliases a choice *removed* from it.  Those are
 * the only skill directories the resolve path may prune: an alias no conflict
 * mentions never appears here, so it is untouchable by construction.
 */
function applyManifestChoices(
  merged: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  session: ConflictSession,
  resolutions: Record<string, ConflictResolution>,
): string[] {
  const skills = merged.skills as Record<string, Record<string, unknown>>
  const dropped: string[] = []
  for (const conflict of session.conflicts) {
    const choice = resolutions[conflict.id]
    if (
      (choice !== 'local' && choice !== 'remote') ||
      conflict.skillAlias === undefined ||
      conflict.type === 'content'
    )
      continue
    const source = (choice === 'local' ? local : remote).skills as Record<
      string,
      Record<string, unknown>
    >
    const sourceSkill = source[conflict.skillAlias]
    if (conflict.field === undefined || conflict.type === 'delete-modify') {
      if (sourceSkill === undefined) {
        delete skills[conflict.skillAlias]
        dropped.push(conflict.skillAlias)
      } else skills[conflict.skillAlias] = structuredClone(sourceSkill)
      continue
    }
    const target =
      skills[conflict.skillAlias] ?? (skills[conflict.skillAlias] = {} as Record<string, unknown>)
    setNested(target, conflict.field, structuredClone(sourceSkill?.[conflict.field.split('.')[0]!]))
  }
  return dropped
}

/**
 * Deletes the directories left behind by an accepted deletion.  The membership test
 * runs against the finished manifest on purpose: a later keep-both choice can put an
 * alias back, and pruning the directory it now describes would fail validation
 * instead of honouring the user's answer.
 */
async function pruneResolvedSkills(
  outputRoot: string,
  manifest: { skills: Record<string, unknown> },
  dropped: readonly string[],
): Promise<void> {
  for (const alias of dropped) {
    if (manifest.skills[alias] !== undefined) continue
    await fs.rm(path.join(outputRoot, 'skills', alias), { recursive: true, force: true })
  }
}
function setNested(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.')
  let cursor = target
  for (const part of parts.slice(0, -1))
    cursor =
      (cursor[part] as Record<string, unknown>) ??
      ((cursor[part] = {} as Record<string, unknown>) as Record<string, unknown>)
  if (value === undefined) delete cursor[parts.at(-1)!]
  else cursor[parts.at(-1)!] = value
}
async function copyResolvedFile(
  sourceRoot: string,
  outputRoot: string,
  alias: string,
  relative: string,
): Promise<void> {
  const source = path.join(sourceRoot, 'skills', alias, relative),
    target = path.join(outputRoot, 'skills', alias, relative)
  await fs.rm(target, { force: true })
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.cp(source, target, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
function allocateAlias(skills: Record<string, unknown>, alias: string): string {
  const stem = `${alias}-other-device`
  let candidate = stem,
    suffix = 2
  while (skills[candidate] !== undefined) candidate = `${stem}-${suffix++}`
  return candidate
}

function isPushRejected(error: unknown): boolean {
  return error instanceof SkillboxError && error.code === ErrorCode.GIT_PUSH_REJECTED
}

/**
 * Runs a best-effort cleanup step, recording only its failure. `benign` matches
 * reasons that mean there was nothing to clean up — reporting them would point
 * the user at a leak that does not exist.
 */
async function recordCleanup(
  cleanup: CleanupFailure[],
  step: CleanupStep,
  target: string,
  operation: () => Promise<unknown>,
  benign?: (reason: string) => boolean,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    const reason = reasonOf(error)
    if (benign?.(reason) === true) return
    cleanup.push({ step, target, message: reason, blocking: step === 'restore' })
  }
}

/**
 * Deepest message in the `cause` chain: the sync services re-wrap the actual
 * git/filesystem failure, and "could not restore" without the reason underneath
 * tells the user nothing they can act on.
 */
function reasonOf(error: unknown): string {
  let current: unknown = error
  let message = current instanceof Error ? current.message : String(current)
  while (current instanceof Error && current.cause !== undefined) {
    current = current.cause
    message = current instanceof Error ? current.message : String(current)
  }
  return message
}

/** How a non-blocking leak reads to the user; '' means that step did not fail. */
const LEAKED: Record<
  Exclude<CleanupStep, 'restore'>,
  (failures: readonly CleanupFailure[]) => string
> = {
  'abort-merge': (failures) =>
    failures.length === 0 ? '' : `the merge could not be aborted (${reasons(failures)})`,
  'remove-worktree': (failures) =>
    failures.length === 0
      ? ''
      : `${failures.length} temporary worktree${failures.length === 1 ? '' : 's'} were left behind (${reasons(failures)})`,
  'remove-tree': (failures) =>
    failures.length === 0 ? '' : `the temporary sync tree was left behind (${reasons(failures)})`,
}

function reasons(failures: readonly CleanupFailure[]): string {
  return [...new Set(failures.map((failure) => failure.message))].join(', ')
}

/**
 * Returns the error to rethrow.  It stays the very same object so callers keep
 * classifying it by `code`; the rollback that failed alongside it is reported in
 * `context.rollback` for programmatic surfaces and in `message`, which is the one
 * field every surface prints.
 */
function reportCleanup(error: unknown, cleanup: CleanupFailure[], snapshotId: string): unknown {
  // Nothing failed, so nothing is added: a clean rollback must stay silent.
  // A non-Error throwable has nowhere to carry a report, and wrapping it would
  // change the code a caller matches on, so it is rethrown as-is.
  if (cleanup.length === 0 || !(error instanceof Error)) return error
  const blocking = cleanup.filter((failure) => failure.blocking)
  const leaked = cleanup.filter((failure) => !failure.blocking)
  const notes: string[] = []
  if (blocking.length > 0)
    notes.push(
      `rollback is incomplete: the working tree was not restored from sync restore point "${snapshotId}" (${reasons(blocking)}), so your files may still hold mid-transaction state`,
    )
  const leaks = (Object.keys(LEAKED) as (keyof typeof LEAKED)[])
    .map((step) => LEAKED[step](leaked.filter((failure) => failure.step === step)))
    .filter((text) => text !== '')
  if (leaks.length > 0) notes.push(`rollback cleanup was also incomplete: ${leaks.join('; ')}`)
  const previous = (error as { context?: unknown }).context
  const earlier =
    typeof previous === 'object' && previous !== null
      ? (previous as { rollback?: RollbackReport }).rollback
      : undefined
  const report: RollbackReport = {
    snapshotId,
    restoreFailed: blocking.length > 0 || earlier?.restoreFailed === true,
    // A retried transaction rolls back twice, once per restore point; the outer
    // report must add to the inner one rather than replace it.
    failures: [...(earlier?.failures ?? []), ...cleanup],
  }
  // Assigning onto the caught error is how this package annotates errors it did
  // not construct; see `git-client.ts`, which does the same for stdout/stderr.
  // One error can be annotated twice across a retry, so the merged report grows
  // while the sentence is only ever appended once — a message that repeats
  // "rollback is incomplete" reads like two distinct disasters.
  const sentence = earlier === undefined ? { message: `${error.message}; ${notes.join('; ')}` } : {}
  return Object.assign(error, sentence, {
    context: {
      ...(typeof previous === 'object' && previous !== null ? previous : {}),
      rollback: report,
    },
  })
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function hasTransactionGit(git: RepositoryGitPort): git is TransactionGitPort {
  return [
    'fetch',
    'revParse',
    'mergeBase',
    'createWorktree',
    'removeWorktree',
    'commit',
    'stage',
    'beginSemanticMerge',
    'abortMerge',
    'createPrivateRef',
    'deletePrivateRef',
  ].every((key) => typeof git[key as keyof RepositoryGitPort] === 'function')
}
