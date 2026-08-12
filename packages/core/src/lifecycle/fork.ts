import * as path from 'node:path'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { ErrorCode, SkillboxError } from '../errors.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import {
  deriveMode,
  readManifest,
  updateSkill,
  validateSkillAlias,
  writeManifest,
} from '../manifest/index.js'
import { readLockfile, writeLockfile, type SkillboxLockfile } from '../lockfile/index.js'
import type { ManifestSkillSource } from '../manifest/schema.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import { createOperationRuntime } from '../operations/runtime.js'
import { baseSnapshotDir, saveBaseSnapshot } from './bases.js'
import { assertLegalTransition } from './transitions.js'
import type { ForkSkillOptions, ForkSkillResult } from './types.js'

/** Repository-relative root of repo-local skills: `skills/`. */
export const REPOSITORY_SKILLS_RELATIVE = 'skills'

/** Repository-relative path of a repo-local skill directory: `skills/<alias>`. */
export function repositorySkillPath(alias: string): string {
  return `${REPOSITORY_SKILLS_RELATIVE}/${alias}`
}

async function snapshotFileOrUndefined(
  filePath: string,
  filesystem: FilesystemService,
): Promise<string | undefined> {
  if (!(await filesystem.exists(filePath))) {
    return undefined
  }
  return filesystem.readFile(filePath)
}

async function restoreSnapshot(
  filePath: string,
  before: string | undefined,
  filesystem: FilesystemService,
): Promise<void> {
  if (before === undefined) {
    await filesystem.remove(filePath)
  } else {
    await atomicWriteFile(filePath, before)
  }
}

/**
 * M17.1 Fork transaction: Managed → Forked.
 *
 * Steps — Copy the Managed Runtime copy (`~/.skillbox/library/managed/<alias>`)
 * into the repository (`skills/<alias>/`), flip the source to the local path,
 * switch the mode to `forked`, record the upstream source, save the Base
 * Revision + integrity into the lockfile's `upstream`, and persist a Base
 * Snapshot at `.skillbox/bases/<alias>/<revision>/` (SPEC §87, §53-54, §58-60).
 *
 * Any failure rolls the transaction back: the Manifest/Lockfile are restored
 * to their previous content and every directory created by this run is
 * removed, so no half-forked skill is ever left behind.
 *
 * Preconditions (checked before anything is written):
 * - the skill exists in the manifest → else `SKILL_NOT_FOUND`
 * - the skill is currently `managed` → else `LIFECYCLE_ILLEGAL_TRANSITION`
 * - a locked entry with a base revision exists → else `FORK_FAILED`
 * - the managed runtime copy exists → else `SKILL_MISSING`
 * - `skills/<alias>` does not already exist in the repo → else `FORK_TARGET_EXISTS`
 */
export async function forkSkill(
  aliasInput: string,
  options: ForkSkillOptions,
): Promise<ForkSkillResult> {
  const alias = validateSkillAlias(aliasInput)
  const filesystem = options.filesystem ?? new FilesystemService()
  const layout = buildSkillboxHomeLayout(options.homeRoot ?? resolveSkillboxHome())
  const library = new RuntimeLibraryService(layout.library, filesystem)
  const repositoryRoot = path.resolve(options.repositoryRoot)

  /* --- preconditions (read-only, nothing written yet) --- */
  const manifest = await readManifest(repositoryRoot)
  const entry = manifest.skills[alias]
  if (entry === undefined) {
    throw new SkillboxError(ErrorCode.SKILL_NOT_FOUND, `Skill "${alias}" is not in the manifest`, {
      context: { alias },
    })
  }
  const fromMode = deriveMode(entry)
  assertLegalTransition(fromMode, 'forked', alias)

  const lockfile = await readLockfile(repositoryRoot)
  const locked = lockfile.skills[alias]
  if (locked === undefined) {
    throw new SkillboxError(
      ErrorCode.FORK_FAILED,
      `Cannot fork "${alias}": no locked entry in skillbox.lock`,
      { context: { alias } },
    )
  }
  const upstreamSource: ManifestSkillSource = locked.upstream?.source ?? entry.source
  const baseRevision = locked.revision ?? locked.upstream?.baseRevision
  if (baseRevision === undefined || baseRevision === '') {
    throw new SkillboxError(
      ErrorCode.FORK_FAILED,
      `Cannot fork "${alias}": no base revision recorded in skillbox.lock`,
      { context: { alias } },
    )
  }

  const managedPath = library.pathFor(alias, 'managed')
  if (!(await filesystem.exists(managedPath))) {
    throw new SkillboxError(
      ErrorCode.SKILL_MISSING,
      `Cannot fork "${alias}": managed runtime copy is missing at "${managedPath}"`,
      { context: { alias, path: managedPath } },
    )
  }

  const targetRel = repositorySkillPath(alias)
  const targetPath = resolveInsideRoot(repositoryRoot, targetRel)
  if (await filesystem.exists(targetPath)) {
    throw new SkillboxError(
      ErrorCode.FORK_TARGET_EXISTS,
      `Cannot fork "${alias}": "${targetRel}" already exists in the repository`,
      { context: { alias, path: targetRel } },
    )
  }

  const manifestPath = path.join(repositoryRoot, 'skillbox.yaml')
  const lockfilePath = path.join(repositoryRoot, 'skillbox.lock')
  const operationRuntime =
    options.operationRuntime ??
    createOperationRuntime({
      repositoryRoot,
      ...(options.homeRoot !== undefined ? { homeRoot: options.homeRoot } : {}),
    })
  const baseRoot = path.join(repositoryRoot, '.skillbox', 'bases', alias)

  return (
    await operationRuntime.runExclusive<ForkSkillResult>({
      kind: 'fork',
      targets: [manifestPath, lockfilePath, targetPath, baseRoot],
      execute: async () => {
        /* --- compatibility rollback bookkeeping --- */
        const manifestBefore = await snapshotFileOrUndefined(manifestPath, filesystem)
        const lockfileBefore = await snapshotFileOrUndefined(lockfilePath, filesystem)
        const createdDirs: string[] = []
        let manifestWritten = false
        let lockfileWritten = false
        let rollbackFailed = false

        const rollback = async (): Promise<void> => {
          if (manifestWritten) {
            try {
              await restoreSnapshot(manifestPath, manifestBefore, filesystem)
            } catch {
              rollbackFailed = true
            }
          }
          if (lockfileWritten) {
            try {
              await restoreSnapshot(lockfilePath, lockfileBefore, filesystem)
            } catch {
              rollbackFailed = true
            }
          }
          for (const dir of [...createdDirs].reverse()) {
            try {
              await filesystem.remove(dir)
            } catch {
              rollbackFailed = true
            }
          }
        }

        try {
          /* Step 1 — Copy the managed runtime into the repository. */
          try {
            await filesystem.mkdir(path.dirname(targetPath))
            await filesystem.copy(managedPath, targetPath)
          } catch (error) {
            throw new SkillboxError(
              ErrorCode.LIFECYCLE_COPY_FAILED,
              `Failed to copy "${alias}" from the managed library into the repository`,
              { cause: error, context: { alias, source: managedPath, target: targetPath } },
            )
          }
          createdDirs.push(targetPath)

          /* Step 2 — Integrity of the repository copy. */
          const integrity = await computeSkillIntegrity(targetPath)

          /* Step 3 — Save the Base Snapshot (M17.4, git-trackable inside the repo). */
          const baseSnapshotPath = baseSnapshotDir(repositoryRoot, alias, baseRevision)
          // Tracked before the copy so a failed snapshot still gets cleaned up;
          // the parent chain is only removed when this run created it.
          createdDirs.push(baseSnapshotPath)
          const baseParent = path.dirname(baseSnapshotPath)
          const basesRoot = path.dirname(baseParent)
          const [baseParentExisted, basesRootExisted] = await Promise.all([
            filesystem.exists(baseParent),
            filesystem.exists(basesRoot),
          ])
          if (!baseParentExisted) {
            createdDirs.push(baseParent)
          }
          if (!basesRootExisted) {
            createdDirs.push(basesRoot)
          }
          await saveBaseSnapshot({
            repositoryRoot,
            alias,
            revision: baseRevision,
            source: managedPath,
            filesystem,
          })

          /* Step 4 — Manifest: source → local, mode → forked, record upstream. */
          const localSource: ManifestSkillSource = { type: 'local', path: targetRel }
          const nextManifest = updateSkill(manifest, alias, {
            mode: 'forked',
            source: localSource,
            upstream: upstreamSource,
          })
          await writeManifest(repositoryRoot, nextManifest)
          manifestWritten = true

          /* Step 5 — Lockfile: forked entry with base revision / integrity (SPEC §53-54). */
          const nextLocked: SkillboxLockfile['skills'][string] = {
            ...locked,
            mode: 'forked',
            source: localSource,
            integrity,
            upstream: {
              source: upstreamSource,
              baseRevision,
              baseIntegrity: integrity,
              ...(locked.upstream?.latestRevision !== undefined
                ? { latestRevision: locked.upstream.latestRevision }
                : {}),
            },
          }
          // Forked entries track the base through `upstream.baseRevision` instead.
          delete nextLocked.revision
          const nextLockfile: SkillboxLockfile = {
            ...lockfile,
            skills: { ...lockfile.skills, [alias]: nextLocked },
          }
          await writeLockfile(repositoryRoot, nextLockfile)
          lockfileWritten = true

          return {
            alias,
            mode: 'forked',
            repositoryPath: targetRel,
            absolutePath: targetPath,
            integrity,
            upstream: upstreamSource,
            baseRevision,
            baseIntegrity: integrity,
            baseSnapshotPath,
            agents: entry.agents ?? [],
          }
        } catch (error) {
          await rollback()
          if (rollbackFailed) {
            throw new SkillboxError(
              ErrorCode.LIFECYCLE_ROLLBACK_FAILED,
              `Fork of "${alias}" failed and rollback was incomplete`,
              {
                cause: error,
                context: {
                  alias,
                  original: error instanceof Error ? error.message : String(error),
                },
              },
            )
          }
          throw error
        }
      },
    })
  ).result
}
