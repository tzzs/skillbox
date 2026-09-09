import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { FilesystemService } from '../fs/filesystem-service.js'
import { scanSkillDirectory } from '../fs/scanner.js'
import { ErrorCode, isSkillboxError, SkillboxError } from '../errors.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { deriveMode, readManifest, validateSkillAlias } from '../manifest/index.js'
import { readLockfile } from '../lockfile/index.js'
import { fromManifestSource } from '../registry/source.js'
import { resolveProvider } from '../registry/registry.js'
import { isRegistryError } from '../registry/errors.js'
import type { NormalizedSource, RegistryProvider } from '../registry/types.js'
import { createDefaultAgentRegistry } from '../agent/index.js'
import { BackupService, backupDir } from '../backup/index.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { RuntimeOwnershipResolver } from '../runtime/ownership.js'
import { linkSkillToAgent } from '../runtime/linker.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import type { RestoreManagedSkillOptions, RestoreManagedSkillResult } from './types.js'

/**
 * M17.3 Restore Upstream transaction ("[Restore]" in the edit flow).
 *
 * Re-materializes the pinned upstream revision of a *modified managed* skill
 * into the managed runtime copy (`~/.skillbox/library/managed/<alias>`), so
 * the runtime matches the integrity recorded in `skillbox.lock` again and the
 * `modified` status clears.
 *
 * Steps — Verify the locked pin → backup the modified runtime (recovery
 * snapshot) → download the pinned revision through the registry provider →
 * path + structure validate → integrity check against the lockfile →
 * atomically replace the library copy → refresh the agent links.
 *
 * The repository Manifest / Lockfile are never touched: restore only repairs
 * the runtime to the state the lockfile already promises.
 *
 * Any failure rolls the transaction back: the fresh download is removed and
 * the pre-restore runtime (from the backup) is put back, so a failed restore
 * never leaves a half-restored skill.
 *
 * Preconditions (checked before anything is written):
 * - the skill exists in the manifest → else `SKILL_NOT_FOUND`
 * - the skill is currently `managed` → else `LIFECYCLE_ILLEGAL_TRANSITION`
 * - a locked entry with `revision` and `integrity` exists → else `RESTORE_FAILED`
 * - the locked source has a registry representation → else `SOURCE_UNSUPPORTED`
 *
 * Errors during download/validation/materialize are wrapped in `RESTORE_FAILED`
 * (with the failing phase in context); an integrity mismatch surfaces the
 * recoverable `INTEGRITY_MISMATCH` so the user learns the pinned revision no
 * longer resolves to the locked hash.
 */
export async function restoreManagedSkill(
  aliasInput: string,
  options: RestoreManagedSkillOptions,
): Promise<RestoreManagedSkillResult> {
  const alias = validateSkillAlias(aliasInput)
  const filesystem = options.filesystem ?? new FilesystemService()
  const layout = buildSkillboxHomeLayout(options.homeRoot ?? resolveSkillboxHome())
  const library = new RuntimeLibraryService(layout.library, filesystem)
  const repositoryRoot = path.resolve(options.repositoryRoot)
  const backupService = new BackupService({ homeRoot: layout.root, filesystem })

  /* --- preconditions (read-only, nothing written yet) --- */
  const manifest = await readManifest(repositoryRoot)
  const entry = manifest.skills[alias]
  if (entry === undefined) {
    throw new SkillboxError(ErrorCode.SKILL_NOT_FOUND, `Skill "${alias}" is not in the manifest`, {
      context: { alias },
    })
  }
  if (deriveMode(entry) !== 'managed') {
    throw new SkillboxError(
      ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
      `Skill "${alias}" is not managed; only managed skills can be restored to their pinned upstream`,
      { context: { alias, mode: deriveMode(entry) } },
    )
  }

  const lockfile = await readLockfile(repositoryRoot)
  const locked = lockfile.skills[alias]
  if (locked === undefined) {
    throw new SkillboxError(
      ErrorCode.RESTORE_FAILED,
      `Cannot restore "${alias}": no locked entry in skillbox.lock`,
      { context: { alias } },
    )
  }
  if (locked.revision === undefined || locked.revision === '') {
    throw new SkillboxError(
      ErrorCode.RESTORE_FAILED,
      `Cannot restore "${alias}": no pinned revision recorded in skillbox.lock`,
      { context: { alias } },
    )
  }
  if (locked.integrity === undefined || locked.integrity === '') {
    throw new SkillboxError(
      ErrorCode.RESTORE_FAILED,
      `Cannot restore "${alias}": no integrity recorded in skillbox.lock`,
      { context: { alias } },
    )
  }

  const normalized = fromManifestSource(locked.source)
  if (normalized === null) {
    throw new SkillboxError(
      ErrorCode.SOURCE_UNSUPPORTED,
      `Cannot restore "${alias}": source type "${locked.source.type}" has no registry representation yet`,
      { context: { alias, source: locked.source } },
    )
  }
  const provider = options.provider ?? restoreProvider(alias, normalized)

  const managedPath = library.pathFor(alias, 'managed')
  const agents = entry.agents ?? []

  /* Early no-op: the runtime already matches the lockfile integrity. */
  if (await filesystem.exists(managedPath)) {
    const current = await computeSkillIntegrity(managedPath)
    if (current === locked.integrity) {
      return {
        alias,
        mode: 'managed',
        filesRestored: 0,
        integrity: current,
        revision: locked.revision,
        unchanged: true,
        materializedPath: managedPath,
        agents,
      }
    }
  }

  /* --- rollback bookkeeping --- */
  const createdDirs: string[] = []
  let backupId = ''
  let backupPath: string | undefined
  let backupRecorded = false
  let libraryTouched = false
  let rollbackFailed = false

  const rollback = async (): Promise<void> => {
    if (backupRecorded) {
      try {
        await backupService.forget(backupId)
      } catch {
        rollbackFailed = true
      }
    }
    // Remove the fresh library copy and put the pre-restore runtime back.
    if (libraryTouched) {
      try {
        await filesystem.remove(managedPath)
      } catch {
        rollbackFailed = true
      }
      if (backupPath !== undefined) {
        try {
          await filesystem.copy(backupPath, managedPath)
        } catch {
          rollbackFailed = true
        }
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
    /* Step 1 — Recovery snapshot of the modified runtime (kept on success,
       indexed by the unified BackupService so `skillbox rollback` can undo
       the restore). */
    if (await filesystem.exists(managedPath)) {
      backupId = `restore-${alias}-${Date.now()}`
      backupPath = backupDir(layout.root, backupId)
      createdDirs.push(backupPath)
      try {
        await filesystem.mkdir(path.dirname(backupPath))
        await filesystem.copy(managedPath, backupPath)
      } catch (error) {
        throw new SkillboxError(
          ErrorCode.RESTORE_FAILED,
          `Failed to snapshot the current runtime of "${alias}" before restoring`,
          { cause: error, context: { alias, phase: 'backup', target: backupPath } },
        )
      }
      backupRecorded = true
      await backupService.record({
        id: backupId,
        kind: 'runtime',
        operation: 'restore',
        alias,
        path: backupPath,
        sourcePath: managedPath,
        repositoryRoot,
      })
    }

    /* Step 2 — Download the pinned revision (never the latest). */
    const tmpRoot = path.join(layout.tmp, `restore-${alias}-${Date.now()}-${process.pid}`)
    const downloadDir = path.join(tmpRoot, 'download')
    createdDirs.push(tmpRoot)
    await filesystem.mkdir(downloadDir)
    try {
      await provider.download(normalized, locked.revision, downloadDir)
    } catch (error) {
      throw wrapRestoreFailure(error, `Failed to download the pinned revision of "${alias}"`, {
        alias,
        phase: 'download',
        revision: locked.revision,
        source: normalized,
      })
    }

    /* Step 3 — Path: registry providers materialize the skill *subtree* of the
       source directly into `downloadDir` (the path prefix is stripped), so the
       download root already is the skill root. Nothing to re-resolve here. */

    /* Step 4 — Structure Validate: SKILL.md (and optional skillbox.yaml). */
    await validateSkillStructure(downloadDir, alias, filesystem)

    /* Step 5 — Integrity: must equal the lockfile expectation (M17.3). */
    const integrity = await computeSkillIntegrity(downloadDir)
    if (integrity !== locked.integrity) {
      throw new SkillboxError(
        ErrorCode.INTEGRITY_MISMATCH,
        `Restored content of "${alias}"@${locked.revision} has integrity ${integrity}, which does not match the lockfile (${locked.integrity}) — the pinned revision may have changed upstream`,
        {
          recoverable: true,
          context: {
            alias,
            revision: locked.revision,
            expected: locked.integrity,
            actual: integrity,
          },
        },
      )
    }

    /* Step 6 — Materialize: replace the managed runtime copy atomically. */
    libraryTouched = true
    try {
      if (await filesystem.exists(managedPath)) {
        await filesystem.remove(managedPath)
      }
      await filesystem.mkdir(path.dirname(managedPath))
      await filesystem.copy(downloadDir, managedPath)
    } catch (error) {
      throw wrapRestoreFailure(error, `Failed to materialize "${alias}" into the managed library`, {
        alias,
        phase: 'materialize',
        target: managedPath,
      })
    }

    /* Step 7 — Refresh the agent links (reconcile copy-style entries too). */
    const linkState = new RuntimeLinkState({ filePath: layout.linksFile, filesystem })
    const ownership = new RuntimeOwnershipResolver({
      managedRoot: layout.library,
      links: linkState,
    })
    const agentRegistry = options.agentRegistry ?? createDefaultAgentRegistry()
    const linksDatabase = await linkState.load()
    for (const agentId of agents) {
      const adapter = agentRegistry.get(agentId)
      if (adapter === undefined) {
        throw new SkillboxError(
          ErrorCode.RESTORE_FAILED,
          `Cannot refresh the link of "${alias}": unknown target agent "${agentId}"`,
          { context: { alias, phase: 'agent-link', agentId } },
        )
      }
      const strategy = linksDatabase[agentId]?.[alias]?.strategy ?? 'auto'
      let result = await linkSkillToAgent({
        adapter,
        agentId,
        alias,
        source: managedPath,
        strategy,
        ownership,
        links: linkState,
        filesystem,
      })
      if (result.action === 'kept_modified' && result.path !== undefined) {
        // A copy-style link holds stale content; restoring refreshes it.
        await filesystem.remove(result.path)
        result = await linkSkillToAgent({
          adapter,
          agentId,
          alias,
          source: managedPath,
          strategy,
          ownership,
          links: linkState,
          filesystem,
        })
      }
      if (result.action === 'blocked') {
        throw new SkillboxError(
          ErrorCode.RESTORE_FAILED,
          `Cannot refresh the link of "${alias}" for agent "${agentId}": the skills-directory entry is owned by something else`,
          { context: { alias, phase: 'agent-link', agentId, path: result.path } },
        )
      }
    }

    /* Success: drop the temporary download, keep the recovery snapshot. */
    try {
      await filesystem.remove(tmpRoot)
    } catch {
      // best effort: a stale tmp dir must not fail a completed restore
    }
    createdDirs.length = 0

    const scan = await scanSkillDirectory(managedPath)
    return {
      alias,
      mode: 'managed',
      filesRestored: scan.files.length,
      integrity,
      revision: locked.revision,
      unchanged: false,
      ...(backupPath !== undefined ? { backupPath } : {}),
      materializedPath: managedPath,
      agents,
    }
  } catch (error) {
    await rollback()
    if (rollbackFailed) {
      throw new SkillboxError(
        ErrorCode.LIFECYCLE_ROLLBACK_FAILED,
        `Restore of "${alias}" failed and rollback was incomplete`,
        {
          cause: error,
          context: { alias, original: error instanceof Error ? error.message : String(error) },
        },
      )
    }
    throw error
  }
}

/** Resolves the registry provider, mapping registry errors onto RESTORE_FAILED. */
function restoreProvider(alias: string, source: NormalizedSource): RegistryProvider {
  try {
    return resolveProvider(source.type)
  } catch (error) {
    if (isRegistryError(error)) {
      throw new SkillboxError(
        ErrorCode.RESTORE_FAILED,
        `No registry provider is wired for "${source.type}" sources; restore of "${alias}" cannot download the pinned revision`,
        { cause: error, context: { alias, source, phase: 'resolve-provider' } },
      )
    }
    throw error
  }
}

/** Wraps a download/validation/materialize failure in a RESTORE_FAILED error. */
function wrapRestoreFailure(
  error: unknown,
  message: string,
  context: Record<string, unknown>,
): SkillboxError {
  if (isSkillboxError(error)) {
    return error
  }
  return new SkillboxError(ErrorCode.RESTORE_FAILED, message, { cause: error, context })
}

/** Structure Validate: SKILL.md required; an optional skillbox.yaml must parse. */
async function validateSkillStructure(
  skillRoot: string,
  alias: string,
  filesystem: FilesystemService,
): Promise<void> {
  if (!(await filesystem.exists(path.join(skillRoot, 'SKILL.md')))) {
    throw new SkillboxError(
      ErrorCode.RESTORE_FAILED,
      `Restored skill "${alias}" is missing SKILL.md`,
      { context: { alias, path: skillRoot, phase: 'validate-structure' } },
    )
  }
  const skillManifestPath = path.join(skillRoot, 'skillbox.yaml')
  if (await filesystem.exists(skillManifestPath)) {
    let document: unknown
    try {
      document = parseYaml(await filesystem.readFile(skillManifestPath))
    } catch (error) {
      throw new SkillboxError(
        ErrorCode.RESTORE_FAILED,
        `Restored skill "${alias}" has an invalid skillbox.yaml`,
        { cause: error, context: { alias, path: skillManifestPath, phase: 'validate-structure' } },
      )
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      throw new SkillboxError(
        ErrorCode.RESTORE_FAILED,
        `Restored skill "${alias}" skillbox.yaml must be a YAML mapping`,
        { context: { alias, path: skillManifestPath, phase: 'validate-structure' } },
      )
    }
  }
}

/** Re-exported for consumers that only need the type. */
export type { RestoreManagedSkillOptions, RestoreManagedSkillResult } from './types.js'
