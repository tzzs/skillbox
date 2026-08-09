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
import { removeBaseSnapshot } from './bases.js'
import { repositorySkillPath } from './fork.js'
import { assertLegalTransition } from './transitions.js'
import type { VendorSkillOptions, VendorSkillResult } from './types.js'

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
 * M18 Vendor transaction: Managed → Vendored (M18.1) or Forked → Vendored
 * (M18.2). The content is frozen into the repository (`skills/<alias>`),
 * the mode becomes `vendored` (a terminal state) and all upstream tracking
 * is dropped. Provenance can be kept as `metadata.originalSource` (M18.3, P2)
 * — it never participates in update logic.
 *
 * - Managed → Vendored: the managed runtime copy is copied into the repo.
 * - Forked → Vendored: the content already lives in the repo; only the
 *   metadata changes, and the saved Base Snapshot may be deleted
 *   (`options.removeBaseSnapshot`).
 *
 * Any failure rolls the transaction back: Manifest/Lockfile are restored and
 * directories created by this run are removed.
 *
 * Preconditions:
 * - the skill exists in the manifest → else `SKILL_NOT_FOUND`
 * - the current mode is `managed` or `forked` → else `LIFECYCLE_ILLEGAL_TRANSITION`
 * - a locked entry exists → else `VENDOR_FAILED`
 * - for Managed → Vendored: `skills/<alias>` is free → else `VENDOR_TARGET_EXISTS`
 */
export async function vendorSkill(
  aliasInput: string,
  options: VendorSkillOptions,
): Promise<VendorSkillResult> {
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
  assertLegalTransition(fromMode, 'vendored', alias)

  const lockfile = await readLockfile(repositoryRoot)
  const locked = lockfile.skills[alias]
  if (locked === undefined) {
    throw new SkillboxError(
      ErrorCode.VENDOR_FAILED,
      `Cannot vendor "${alias}": no locked entry in skillbox.lock`,
      { context: { alias } },
    )
  }

  const targetRel = repositorySkillPath(alias)
  const targetPath = resolveInsideRoot(repositoryRoot, targetRel)
  const fromFork = fromMode === 'forked'
  let managedPath: string | undefined
  if (!fromFork) {
    managedPath = library.pathFor(alias, 'managed')
    if (!(await filesystem.exists(managedPath))) {
      throw new SkillboxError(
        ErrorCode.SKILL_MISSING,
        `Cannot vendor "${alias}": managed runtime copy is missing at "${managedPath}"`,
        { context: { alias, path: managedPath } },
      )
    }
    if (await filesystem.exists(targetPath)) {
      throw new SkillboxError(
        ErrorCode.VENDOR_TARGET_EXISTS,
        `Cannot vendor "${alias}": "${targetRel}" already exists in the repository`,
        { context: { alias, path: targetRel } },
      )
    }
  }

  /* --- rollback bookkeeping --- */
  const manifestPath = path.join(repositoryRoot, 'skillbox.yaml')
  const lockfilePath = path.join(repositoryRoot, 'skillbox.lock')
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
    /* Step 1 — Copy the managed runtime into the repo (Forked → Vendored keeps
     * the repository copy it already has). */
    if (!fromFork && managedPath !== undefined) {
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
    }

    /* Step 2 — Integrity of the vendored content. */
    const integrity = await computeSkillIntegrity(targetPath)

    /* Step 3 — Manifest: source → local, mode → vendored, drop upstream. */
    const localSource: ManifestSkillSource = { type: 'local', path: targetRel }
    const nextManifest = updateSkill(manifest, alias, {
      mode: 'vendored',
      source: localSource,
      upstream: undefined,
    })
    await writeManifest(repositoryRoot, nextManifest)
    manifestWritten = true

    /* Step 4 — Lockfile: vendored entry, upstream cleared (M18.1/M18.2). */
    const nextLocked: SkillboxLockfile['skills'][string] = {
      ...locked,
      mode: 'vendored',
      source: localSource,
      integrity,
      upstream: undefined,
    }
    if (options.keepProvenance === true) {
      const originalSource = locked.upstream?.source ?? locked.source
      nextLocked.metadata = { ...(locked.metadata ?? {}), originalSource }
    }
    delete nextLocked.revision
    const nextLockfile: SkillboxLockfile = {
      ...lockfile,
      skills: { ...lockfile.skills, [alias]: nextLocked },
    }
    await writeLockfile(repositoryRoot, nextLockfile)
    lockfileWritten = true

    /* Step 5 — Optional: delete the Base Snapshot (Forked → Vendored only). */
    let removedBaseSnapshot: string | undefined
    if (fromFork && options.removeBaseSnapshot === true) {
      removedBaseSnapshot = await removeBaseSnapshot({ repositoryRoot, alias, filesystem })
    }

    return {
      alias,
      mode: 'vendored',
      repositoryPath: targetRel,
      absolutePath: targetPath,
      integrity,
      fromFork,
      ...(removedBaseSnapshot !== undefined ? { removedBaseSnapshot } : {}),
      agents: entry.agents ?? [],
    }
  } catch (error) {
    await rollback()
    if (rollbackFailed) {
      throw new SkillboxError(
        ErrorCode.LIFECYCLE_ROLLBACK_FAILED,
        `Vendor of "${alias}" failed and rollback was incomplete`,
        {
          cause: error,
          context: { alias, original: error instanceof Error ? error.message : String(error) },
        },
      )
    }
    throw error
  }
}
