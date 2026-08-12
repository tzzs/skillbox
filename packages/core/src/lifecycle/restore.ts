import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { ErrorCode, SkillboxError } from '../errors.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { ManagedCache, CACHE_INTEGRITY_MARKER } from '../install/cache.js'
import { readLockfile } from '../lockfile/index.js'
import { deriveMode, readManifest, validateSkillAlias } from '../manifest/index.js'
import type { NormalizedSource } from '../registry/types.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import { createOperationRuntime } from '../operations/runtime.js'
import type { CanonicalSkillSource } from '../sources/types.js'
import type { RestoreManagedSkillOptions, RestoreManagedSkillResult } from './types.js'

function cacheSource(source: { type: string; [key: string]: unknown }): NormalizedSource {
  if (source.type === 'github' && typeof source.repo === 'string') {
    const result: Extract<NormalizedSource, { type: 'github' }> = {
      type: 'github',
      repo: source.repo,
    }
    if (typeof source.path === 'string') result.path = source.path
    if (typeof source.ref === 'string') result.ref = source.ref
    return result
  }
  throw new SkillboxError(
    ErrorCode.SOURCE_UNSUPPORTED,
    `Restore supports cached github sources; "${source.type}" will be supported by SkillSourceResolver`,
    { recoverable: true, context: { sourceType: source.type } },
  )
}

async function payloadFileCount(root: string, filesystem: FilesystemService): Promise<number> {
  let count = 0
  for (const entry of await filesystem.readDir(root)) {
    if (entry.name === CACHE_INTEGRITY_MARKER) continue
    if (entry.isDirectory) count += await payloadFileCount(entry.fullPath, filesystem)
    else if (entry.isFile) count += 1
  }
  return count
}

async function materializePinnedCacheEntry(input: {
  alias: string
  source: CanonicalSkillSource
  revision: string
  integrity: string
  cache: ManagedCache
  cacheSource: NormalizedSource
  resolver: NonNullable<RestoreManagedSkillOptions['sourceResolver']>
  filesystem: FilesystemService
  temporaryRoot: string
}): Promise<void> {
  const adapter = input.resolver.adapterFor(input.source, 'materialize')
  if (adapter.materialize === undefined) {
    throw new SkillboxError(
      ErrorCode.SOURCE_UNSUPPORTED,
      `Skill source type "${input.source.type}" does not support materialize`,
      { context: { sourceType: input.source.type, capability: 'materialize' }, recoverable: true },
    )
  }

  await input.filesystem.remove(input.temporaryRoot)
  try {
    // The lockfile revision is the sole revision passed to the adapter. In
    // particular, restore must not resolve or otherwise advance a pin.
    await adapter.materialize(input.source, input.revision, input.temporaryRoot)
    const integrity = await computeSkillIntegrity(input.temporaryRoot)
    if (integrity !== input.integrity) {
      throw new SkillboxError(
        ErrorCode.INTEGRITY_MISMATCH,
        `Downloaded content integrity ${integrity} does not match locked integrity for "${input.alias}"`,
        { context: { alias: input.alias, expected: input.integrity, actual: integrity } },
      )
    }
    await input.cache.put(input.cacheSource, input.revision, input.integrity, input.temporaryRoot)
  } finally {
    await input.filesystem.remove(input.temporaryRoot)
  }
}

/**
 * Restores a Managed runtime from the exact revision and integrity already
 * pinned in `skillbox.lock`. The cache entry is validated before any runtime
 * mutation, copied into a sibling staging directory, then activated with the
 * previous runtime retained as a rollback backup. Manifest and lockfile are
 * deliberately read-only: Restore clears local drift, never advances a pin.
 */
export async function restoreManagedSkill(
  aliasInput: string,
  options: RestoreManagedSkillOptions,
): Promise<RestoreManagedSkillResult> {
  const alias = validateSkillAlias(aliasInput)
  const repositoryRoot = path.resolve(options.repositoryRoot)
  const homeRoot = options.homeRoot ?? resolveSkillboxHome()
  const layout = buildSkillboxHomeLayout(homeRoot)
  const runtimePath = new RuntimeLibraryService(layout.library).pathFor(alias, 'managed')
  const operationRuntime =
    options.operationRuntime ?? createOperationRuntime({ repositoryRoot, homeRoot })
  const operation = await operationRuntime.runExclusive({
    kind: 'restore',
    targets: [runtimePath, layout.cache],
    execute: () => restoreManagedSkillUnsafe(alias, options),
  })
  return operation.result
}

async function restoreManagedSkillUnsafe(
  aliasInput: string,
  options: RestoreManagedSkillOptions,
): Promise<RestoreManagedSkillResult> {
  const alias = validateSkillAlias(aliasInput)
  const filesystem = options.filesystem ?? new FilesystemService()
  const repositoryRoot = path.resolve(options.repositoryRoot)
  const layout = buildSkillboxHomeLayout(options.homeRoot ?? resolveSkillboxHome())
  const library = new RuntimeLibraryService(layout.library, filesystem)

  const manifest = await readManifest(repositoryRoot)
  const skill = manifest.skills[alias]
  if (skill === undefined) {
    throw new SkillboxError(ErrorCode.SKILL_NOT_FOUND, `Skill "${alias}" is not in the manifest`, {
      context: { alias },
    })
  }
  if (deriveMode(skill) !== 'managed') {
    throw new SkillboxError(
      ErrorCode.LIFECYCLE_ILLEGAL_TRANSITION,
      `Cannot restore "${alias}": only managed skills have a pinned runtime`,
      { context: { alias, from: deriveMode(skill), to: 'managed' } },
    )
  }
  const locked = (await readLockfile(repositoryRoot)).skills[alias]
  if (locked === undefined || locked.mode !== 'managed' || !locked.revision || !locked.integrity) {
    throw new SkillboxError(
      ErrorCode.RESTORE_FAILED,
      `Cannot restore "${alias}": skillbox.lock has no managed revision and integrity pin`,
      { recoverable: true, context: { alias } },
    )
  }

  const runtimePath = library.pathFor(alias, 'managed')
  const normalizedCacheSource = cacheSource(locked.source)
  const cache = new ManagedCache(layout.cache, filesystem)
  let cached = await cache.get(normalizedCacheSource, locked.revision, locked.integrity)
  if (cached === null) {
    if (options.sourceResolver === undefined) {
      throw new SkillboxError(
        ErrorCode.CACHE_MISS,
        `No cache entry for "${alias}" at locked revision ${locked.revision}; a source resolver is required to restore it`,
        { recoverable: true, context: { alias, revision: locked.revision } },
      )
    }
    const token = `${process.pid}-${Date.now()}`
    await materializePinnedCacheEntry({
      alias,
      source: options.sourceResolver.fromManifest(locked.source),
      revision: locked.revision,
      integrity: locked.integrity,
      cache,
      cacheSource: normalizedCacheSource,
      resolver: options.sourceResolver,
      filesystem,
      temporaryRoot: `${runtimePath}.cache-${token}`,
    })
    cached = await cache.requireEntry(normalizedCacheSource, locked.revision, locked.integrity)
  }
  if (
    (await filesystem.exists(runtimePath)) &&
    (await computeSkillIntegrity(runtimePath)) === locked.integrity
  ) {
    return { alias, filesRestored: 0, integrity: locked.integrity, materializedPath: runtimePath }
  }

  const token = `${process.pid}-${Date.now()}`
  const staging = `${runtimePath}.restore-${token}`
  const backup = `${runtimePath}.backup-${token}`
  let movedExisting = false
  let activated = false
  try {
    await filesystem.remove(staging)
    await filesystem.copy(cached.path, staging)
    await filesystem.remove(path.join(staging, CACHE_INTEGRITY_MARKER))
    const stagedIntegrity = await computeSkillIntegrity(staging)
    if (stagedIntegrity !== locked.integrity) {
      throw new SkillboxError(
        ErrorCode.INTEGRITY_MISMATCH,
        `Cached content integrity ${stagedIntegrity} does not match locked integrity for "${alias}"`,
        { context: { alias, expected: locked.integrity, actual: stagedIntegrity } },
      )
    }
    if (await filesystem.exists(runtimePath)) {
      await filesystem.move(runtimePath, backup)
      movedExisting = true
    }
    await filesystem.move(staging, runtimePath)
    activated = true
    const integrity = await computeSkillIntegrity(runtimePath)
    if (integrity !== locked.integrity) {
      throw new SkillboxError(
        ErrorCode.INTEGRITY_MISMATCH,
        `Restore verification failed for "${alias}"`,
        {
          context: { alias, expected: locked.integrity, actual: integrity },
        },
      )
    }
    await filesystem.remove(backup)
    return {
      alias,
      filesRestored: await payloadFileCount(runtimePath, filesystem),
      integrity,
      materializedPath: runtimePath,
    }
  } catch (error) {
    let rollbackFailed = false
    try {
      if (activated) await filesystem.remove(runtimePath)
      if (movedExisting) await filesystem.move(backup, runtimePath)
    } catch {
      rollbackFailed = true
    }
    try {
      await filesystem.remove(staging)
      if (!movedExisting) await filesystem.remove(backup)
    } catch {
      rollbackFailed = true
    }
    if (rollbackFailed) {
      throw new SkillboxError(
        ErrorCode.LIFECYCLE_ROLLBACK_FAILED,
        `Restore of "${alias}" failed and rollback was incomplete`,
        {
          cause: error,
          context: { alias },
        },
      )
    }
    throw error
  }
}
