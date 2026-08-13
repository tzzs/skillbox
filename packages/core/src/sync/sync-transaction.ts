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
          repositoryId: (await import('../operations/lock.js')).repositoryKey(
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
      await git.abortMerge(repositoryRoot).catch(() => undefined)
      await snapshots.restore(snapshot.id).catch(() => undefined)
      throw error
    } finally {
      await Promise.all([
        git.removeWorktree(repositoryRoot, baseRoot).catch(() => undefined),
        git.removeWorktree(repositoryRoot, localRoot).catch(() => undefined),
        git.removeWorktree(repositoryRoot, remoteRoot).catch(() => undefined),
      ])
      await fs.rm(treeRoot, { recursive: true, force: true }).catch(() => undefined)
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
      applyManifestChoices(
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
      await git.abortMerge(repositoryRoot).catch(() => undefined)
      await snapshots.restore(session.snapshotId).catch(() => undefined)
      throw error
    } finally {
      await Promise.all([
        git.removeWorktree(repositoryRoot, baseRoot).catch(() => undefined),
        git.removeWorktree(repositoryRoot, localRoot).catch(() => undefined),
        git.removeWorktree(repositoryRoot, remoteRoot).catch(() => undefined),
      ])
      await fs.rm(treeRoot, { recursive: true, force: true }).catch(() => undefined)
    }
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

function applyManifestChoices(
  merged: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  session: ConflictSession,
  resolutions: Record<string, ConflictResolution>,
): void {
  const skills = merged.skills as Record<string, Record<string, unknown>>
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
      if (sourceSkill === undefined) delete skills[conflict.skillAlias]
      else skills[conflict.skillAlias] = structuredClone(sourceSkill)
      continue
    }
    const target =
      skills[conflict.skillAlias] ?? (skills[conflict.skillAlias] = {} as Record<string, unknown>)
    setNested(target, conflict.field, structuredClone(sourceSkill?.[conflict.field.split('.')[0]!]))
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

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function hasTransactionGit(
  git: RepositoryGitPort,
): git is RepositoryGitPort &
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
  > {
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
