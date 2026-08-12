import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ErrorCode, SkillboxError, isSkillboxError, type SkillboxErrorCode } from '../errors.js'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveInsideRoot } from '../fs/paths.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { createDefaultAgentRegistry } from '../agent/index.js'
import { MANIFEST_FILE_NAME } from '../manifest/schema.js'
import {
  addSkill,
  emptyManifest,
  readManifest,
  updateSkill as updateManifestSkill,
  validateSkillAlias,
  writeManifest,
  type ManifestSkillInput,
  type ManifestSkillSource,
  type SkillboxManifest,
} from '../manifest/index.js'
import {
  LOCKFILE_FILE_NAME,
  createLockedSkill,
  emptyLockfile,
  readLockfile,
  writeLockfile,
  type SkillboxLockfile,
} from '../lockfile/index.js'
import { resolveProvider } from '../registry/registry.js'
import type { NormalizedSource, RegistryProvider } from '../registry/types.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { RuntimeOwnershipResolver } from '../runtime/ownership.js'
import { linkSkillToAgent } from '../runtime/linker.js'
import { buildSkillboxHomeLayout, resolveSkillboxHome } from '../runtime/paths.js'
import { scanSkillForSecurity } from '../security/index.js'
import { createSkillSourceResolver } from '../sources/resolver.js'
import type {
  CanonicalSkillSource,
  SkillSourceAdapter,
  SkillSourceResolver,
} from '../sources/types.js'
import { ManagedCache, type CacheEntry } from './cache.js'
import type { InstallResult, InstallSkillOptions, UpdateSkillOptions } from './types.js'

export type {
  InstallResult,
  InstallSkillOptions,
  InstallAllowPolicy,
  UpdateSkillOptions,
} from './types.js'

/** Human-readable source expression used in errors and messages. */
export function describeSource(source: NormalizedSource): string {
  switch (source.type) {
    case 'github': {
      let description = `github:${source.repo}`
      if (source.path !== undefined) description += `@${source.path}`
      return description
    }
    case 'skills-sh':
      return `skills-sh:${source.package}`
    case 'local':
      return `local:${source.path}`
  }
}

/**
 * Derives the default skill alias from a source: the last path segment of a
 * GitHub path (or the repo name), or the package name for skills.sh.
 */
export function defaultAliasFor(source: NormalizedSource): string {
  let raw: string
  switch (source.type) {
    case 'github':
      raw = source.path?.split('/').pop() ?? source.repo.split('/').pop() ?? source.repo
      break
    case 'skills-sh':
      raw = source.package.split('/').pop() ?? source.package
      break
    case 'local':
      raw = path.basename(source.path)
      break
  }
  return sanitizeAlias(raw)
}

/** Lowercases `raw` into a valid skill alias (`^[a-z0-9][a-z0-9-_]*$`). */
export function sanitizeAlias(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return validateSkillAlias(cleaned)
}

/**
 * Stopgap mapping from the registry framework's `NormalizedSource` onto the
 * Manifest/Lockfile `ManifestSkillSource` shape. TODO(agent-1): replace with
 * the canonical conversion once the registry framework finalizes its mapping.
 */
export function normalizedSourceToManifestSource(source: NormalizedSource): ManifestSkillSource {
  switch (source.type) {
    case 'github': {
      const node: ManifestSkillSource = { type: 'github', repo: source.repo }
      if (source.path !== undefined) node.path = source.path
      const ref = source.ref ?? source.branch
      if (ref !== undefined) node.ref = ref
      return node
    }
    case 'skills-sh': {
      const node: ManifestSkillSource = {
        type: 'registry',
        registry: 'skills.sh',
        package: source.package,
      }
      if (source.version !== undefined) node.version = source.version
      return node
    }
    case 'local':
      return { type: 'local', path: source.path }
  }
}

/**
 * Temporary compatibility adapter for callers which still pass a legacy
 * RegistryProvider. Install/update themselves only dispatch through the
 * canonical SkillSourceResolver boundary.
 */
function legacyProviderAdapter(
  source: NormalizedSource,
  provider: RegistryProvider,
): SkillSourceAdapter {
  const canonicalType = normalizedSourceToManifestSource(source).type
  return {
    type: canonicalType,
    capabilities: { resolve: true, download: true, latest: true, materialize: false },
    async resolve(canonical) {
      const resolved = await provider.resolve(toLegacyNormalizedSource(canonical))
      return {
        source: canonical,
        revision: resolved.revision,
        ...(resolved.integrity === undefined ? {} : { integrity: resolved.integrity }),
      }
    },
    async download(canonical, revision, targetDir) {
      await provider.download(toLegacyNormalizedSource(canonical), revision, targetDir)
    },
    async latest(canonical) {
      return provider.getLatestRevision(toLegacyNormalizedSource(canonical))
    },
  }
}

function toLegacyNormalizedSource(source: CanonicalSkillSource): NormalizedSource {
  switch (source.type) {
    case 'github':
      return {
        type: 'github',
        repo: source.repo,
        ...(source.path === undefined ? {} : { path: source.path }),
        ...(source.ref === undefined ? {} : { ref: source.ref }),
      }
    case 'registry':
      if (source.registry === 'skills.sh') {
        return {
          type: 'skills-sh',
          package: source.package,
          ...(source.version === undefined ? {} : { version: source.version }),
        }
      }
      break
    case 'local':
      return { type: 'local', path: source.path }
    case 'git':
      break
  }
  throw new SkillboxError(
    ErrorCode.SOURCE_UNSUPPORTED,
    `Legacy registry providers cannot handle ${source.type} sources`,
    { context: { source } },
  )
}

function resolverForInstall(
  source: NormalizedSource,
  options: Pick<InstallSkillOptions, 'provider' | 'sourceResolver'>,
): { resolver: SkillSourceResolver; canonicalSource: CanonicalSkillSource } {
  const resolver = options.sourceResolver
  if (resolver !== undefined) {
    return {
      resolver,
      canonicalSource: resolver.fromManifest(normalizedSourceToManifestSource(source)),
    }
  }
  if (options.provider === undefined) {
    throw new SkillboxError(
      ErrorCode.INSTALL_SOURCE_UNRESOLVED,
      `No SkillSourceResolver or registry provider is wired for "${source.type}" sources`,
      { context: { source } },
    )
  }
  const canonicalSource = normalizedSourceToManifestSource(source)
  return {
    resolver: createSkillSourceResolver({
      adapters: [legacyProviderAdapter(source, options.provider)],
    }),
    canonicalSource,
  }
}

function rethrowOrWrap(error: unknown, code: SkillboxErrorCode, message: string): never {
  if (isSkillboxError(error)) {
    throw error
  }
  throw new SkillboxError(code, message, {
    cause: error,
  })
}

async function readManifestOrEmpty(repositoryRoot: string): Promise<SkillboxManifest> {
  try {
    return await readManifest(repositoryRoot)
  } catch (error) {
    if (isSkillboxError(error) && error.code === ErrorCode.MANIFEST_NOT_FOUND) {
      return emptyManifest()
    }
    throw error
  }
}

async function readLockfileOrEmpty(repositoryRoot: string): Promise<SkillboxLockfile> {
  try {
    return await readLockfile(repositoryRoot)
  } catch (error) {
    if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
      return emptyLockfile()
    }
    throw error
  }
}

/** Serialized file content, or `undefined` when the file does not exist. */
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

/** Resolves the skill subtree inside the downloaded directory (Path Validate). */
async function validateSkillRoot(downloadRoot: string, source: NormalizedSource): Promise<string> {
  const subPath = 'path' in source ? source.path : undefined
  if (subPath === undefined) {
    return downloadRoot
  }
  try {
    return resolveInsideRoot(downloadRoot, subPath)
  } catch (error) {
    throw new SkillboxError(
      ErrorCode.INSTALL_INVALID_PATH,
      `Source path "${subPath}" is not a safe path inside the downloaded skill`,
      { cause: error, context: { source, path: subPath } },
    )
  }
}

/** Structure Validate: SKILL.md required; an optional skillbox.yaml must parse. */
async function validateSkillStructure(
  skillRoot: string,
  filesystem: FilesystemService,
): Promise<void> {
  if (!(await filesystem.exists(path.join(skillRoot, 'SKILL.md')))) {
    throw new SkillboxError(ErrorCode.INSTALL_INVALID_STRUCTURE, 'Skill is missing SKILL.md', {
      context: { path: skillRoot },
    })
  }
  const skillManifestPath = path.join(skillRoot, 'skillbox.yaml')
  if (await filesystem.exists(skillManifestPath)) {
    let document: unknown
    try {
      document = parseYaml(await filesystem.readFile(skillManifestPath))
    } catch (error) {
      throw new SkillboxError(
        ErrorCode.INSTALL_INVALID_STRUCTURE,
        `Skill manifest "${skillManifestPath}" is not a valid YAML document`,
        { cause: error, context: { path: skillManifestPath } },
      )
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      throw new SkillboxError(
        ErrorCode.INSTALL_INVALID_STRUCTURE,
        `Skill manifest "${skillManifestPath}" must be a YAML mapping`,
        { context: { path: skillManifestPath } },
      )
    }
  }
}

/**
 * M15.1 Remote Install transaction.
 *
 * Ten steps — Resolve → Materialize source (with the M15.3 managed cache) → Path
 * Validate → Structure Validate → Integrity → Security → Materialize →
 * Manifest → Lock → Agents. Any failure triggers a rollback that removes the
 * temporary download, the materialized library copy, any agent links created
 * during this run, and restores the repository Manifest/Lockfile to their
 * previous content, so no half-installed skill is ever left behind.
 *
 * Defaults to `mode = managed` (M15.2): the full skill files live in
 * `~/.skillbox/library/<alias>`, and the repository only gains a Manifest
 * entry plus a Lockfile entry (0.3.0 acceptance criteria).
 *
 * Throws on failure:
 * - `SOURCE_UNSUPPORTED` for local sources (use the import flow instead)
 * - `INSTALL_SOURCE_UNRESOLVED` when no source resolver is wired / resolution fails
 * - `INSTALL_DOWNLOAD_FAILED`, `INSTALL_INVALID_PATH`,
 *   `INSTALL_INVALID_STRUCTURE`, `INTEGRITY_MISMATCH` (M15.5),
 *   `INSTALL_SECURITY_BLOCKED`, `INSTALL_MATERIALIZE_FAILED`,
 *   `INSTALL_CONFLICT`, `INSTALL_AGENT_LINK_FAILED`
 */
export async function installSkill(
  source: NormalizedSource,
  options: InstallSkillOptions,
): Promise<InstallResult> {
  return runInstallTransaction(source, options)
}

/**
 * Shared M15.1 ten-step pipeline, called by both {@link installSkill} and
 * {@link updateSkill}. `extras.replacing` switches the Manifest step from
 * "the alias must be new" (install) to "replace the existing entry, keeping
 * its agents" (M16.2 update).
 */
async function runInstallTransaction(
  source: NormalizedSource,
  options: InstallSkillOptions,
  extras: { replacing?: boolean } = {},
): Promise<InstallResult> {
  const replacing = extras.replacing ?? false

  if (source.type === 'local') {
    throw new SkillboxError(
      ErrorCode.SOURCE_UNSUPPORTED,
      'installSkill targets remote sources; local skills use the import flow (runtime/import.ts)',
      { context: { source } },
    )
  }

  const filesystem = options.filesystem ?? new FilesystemService()
  const layout = buildSkillboxHomeLayout(options.homeRoot ?? resolveSkillboxHome())
  const cache = new ManagedCache(layout.cache, filesystem)
  const library = new RuntimeLibraryService(layout.library, filesystem)
  const agentRegistry = options.agentRegistry ?? createDefaultAgentRegistry()
  const repositoryRoot = path.resolve(options.repositoryRoot)
  const alias =
    options.alias !== undefined ? validateSkillAlias(options.alias) : defaultAliasFor(source)
  const targetAgents = options.targetAgents ?? []
  const allowHighRisk = options.allowPolicy?.allowHighRisk ?? false
  const { resolver, canonicalSource } = resolverForInstall(source, options)

  const linkState = new RuntimeLinkState({ filePath: layout.linksFile, filesystem })
  const ownership = new RuntimeOwnershipResolver({ managedRoot: layout.library, links: linkState })

  /* --- rollback bookkeeping (never leaves half-finished installs) --- */
  const tmpDirs: string[] = []
  const linkedEntries: Array<{ agentId: string; alias: string }> = []
  let materializedPath: string | undefined
  let materializedBefore = false
  let manifestPath: string | undefined
  let manifestBefore: string | undefined
  let manifestWritten = false
  let lockfilePath: string | undefined
  let lockfileBefore: string | undefined
  let lockfileWritten = false

  const rollback = async (): Promise<void> => {
    for (const entry of linkedEntries) {
      try {
        const adapter = agentRegistry.get(entry.agentId)
        if (adapter !== undefined) {
          await adapter.unlinkSkill(entry.alias)
        }
      } catch {
        // best effort: a failed cleanup must not mask the original error
      }
    }
    if (materializedPath !== undefined && !materializedBefore) {
      try {
        await filesystem.remove(materializedPath)
      } catch {
        // best effort
      }
    }
    if (manifestWritten && manifestPath !== undefined) {
      try {
        await restoreSnapshot(manifestPath, manifestBefore, filesystem)
      } catch {
        // best effort
      }
    }
    if (lockfileWritten && lockfilePath !== undefined) {
      try {
        await restoreSnapshot(lockfilePath, lockfileBefore, filesystem)
      } catch {
        // best effort
      }
    }
    for (const dir of [...tmpDirs].reverse()) {
      try {
        await filesystem.remove(dir)
      } catch {
        // best effort
      }
    }
  }

  let cacheHit = false
  let revision: string | undefined
  try {
    /* Step 1 — Resolve: pin the source to a concrete revision. */
    const resolved = await resolver
      .adapterFor(canonicalSource, 'resolve')
      .resolve?.(canonicalSource)
    if (resolved === undefined) {
      throw new SkillboxError(
        ErrorCode.INSTALL_SOURCE_UNRESOLVED,
        `Source resolver could not resolve ${describeSource(source)}`,
        { context: { source } },
      )
    }
    revision = resolved.revision
    if (revision === '') {
      throw new SkillboxError(
        ErrorCode.INSTALL_SOURCE_UNRESOLVED,
        `Provider resolved an empty revision for ${describeSource(source)}`,
        { context: { source } },
      )
    }
    let expectedIntegrity = resolved.integrity

    /* Step 2 — Download to tmp (skipped on a managed-cache hit, M15.3). */
    let skillRoot: string
    let downloadUsed = false
    let cacheEntry: CacheEntry | null = null
    try {
      cacheEntry = await cache.get(source, revision, expectedIntegrity)
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.CACHE_INVALID) {
        // The cache is disposable: purge the corrupt entry and redownload.
        await cache.invalidate(source, revision)
      } else {
        throw error
      }
    }
    if (cacheEntry !== null) {
      skillRoot = cacheEntry.path
      cacheHit = true
      if (expectedIntegrity === undefined) {
        expectedIntegrity = cacheEntry.integrity
      }
    } else {
      const tmpRoot = path.join(layout.tmp, `install-${alias}-${Date.now()}-${process.pid}`)
      const downloadDir = path.join(tmpRoot, 'download')
      await filesystem.mkdir(downloadDir)
      tmpDirs.push(tmpRoot)
      try {
        const capability = resolver.capabilitiesFor(canonicalSource).materialize
          ? 'materialize'
          : 'download'
        const adapter = resolver.adapterFor(canonicalSource, capability)
        if (adapter.materialize !== undefined) {
          await adapter.materialize(canonicalSource, revision, downloadDir)
        } else if (adapter.download !== undefined) {
          await adapter.download(canonicalSource, revision, downloadDir)
        } else {
          throw new SkillboxError(
            ErrorCode.INSTALL_DOWNLOAD_FAILED,
            `Source resolver could not materialize ${describeSource(source)}@${revision}`,
            { context: { source, revision } },
          )
        }
      } catch (error) {
        throw rethrowOrWrap(
          error,
          ErrorCode.INSTALL_DOWNLOAD_FAILED,
          `Failed to download ${describeSource(source)}@${revision}`,
        )
      }
      downloadUsed = true
      skillRoot = downloadDir
    }

    /* Step 3 — Path Validate: the source sub-path must stay inside the download. */
    const skillRootDir = await validateSkillRoot(skillRoot, source)

    /* Step 4 — Structure Validate: SKILL.md (and optional skillbox.yaml). */
    await validateSkillStructure(skillRootDir, filesystem)

    /* Step 5 — Integrity: hash must equal the source/lockfile expectation (M15.5). */
    const integrity = await computeSkillIntegrity(skillRootDir)
    if (expectedIntegrity !== undefined && integrity !== expectedIntegrity) {
      throw new SkillboxError(
        ErrorCode.INTEGRITY_MISMATCH,
        `Downloaded content integrity ${integrity} does not match expected ${expectedIntegrity}`,
        {
          context: { alias, revision, expected: expectedIntegrity, actual: integrity },
        },
      )
    }

    /* Step 6 — Security: static scan; high risk is rejected by default. */
    const securityScan = await scanSkillForSecurity(skillRootDir)
    if (securityScan.block && !allowHighRisk) {
      throw new SkillboxError(
        ErrorCode.INSTALL_SECURITY_BLOCKED,
        `Security scan rated ${describeSource(source)} "${securityScan.risk}" risk (${securityScan.findings.length} finding(s)); pass allowPolicy: { allowHighRisk: true } to install anyway`,
        {
          recoverable: true,
          context: {
            alias,
            risk: securityScan.risk,
            patternIds: [...new Set(securityScan.findings.map((finding) => finding.pattern))],
            files: [...new Set(securityScan.findings.map((finding) => finding.file))],
          },
        },
      )
    }
    const security = { risk: securityScan.risk, scannedAt: new Date().toISOString() }

    // Cache the verified + accepted download (M15.3). Placed after the security
    // gate so a blocked install never leaves content behind.
    if (downloadUsed) {
      await cache.put(source, revision, integrity, skillRoot)
    }

    /* Step 7 — Materialize: managed mode → ~/.skillbox/library/<alias> (M15.4). */
    materializedBefore = await library.has(alias, 'managed')
    let materialized
    try {
      materialized = await library.materializeSkill({
        alias,
        mode: 'managed',
        source: skillRootDir,
      })
    } catch (error) {
      throw rethrowOrWrap(
        error,
        ErrorCode.INSTALL_MATERIALIZE_FAILED,
        `Failed to materialize "${alias}" into the managed library`,
      )
    }
    materializedPath = materialized.path

    /* Step 8 — Manifest: the repository gains only a Manifest entry (M15.3);
       the update flow replaces the existing entry instead (M16.2). */
    const manifestSource = resolver.toManifest(canonicalSource)
    const manifest = await readManifestOrEmpty(repositoryRoot)
    if (manifest.skills[alias] !== undefined && !replacing) {
      throw new SkillboxError(
        ErrorCode.INSTALL_CONFLICT,
        `Skill "${alias}" is already installed in the manifest; use the update flow for existing skills`,
        { context: { alias } },
      )
    }
    manifestPath = path.join(repositoryRoot, MANIFEST_FILE_NAME)
    manifestBefore = await snapshotFileOrUndefined(manifestPath, filesystem)
    const manifestPatch: ManifestSkillInput = {
      source: manifestSource,
      mode: 'managed',
      agents: targetAgents,
    }
    const nextManifest =
      !replacing || manifest.skills[alias] === undefined
        ? addSkill(manifest, alias, manifestPatch)
        : updateManifestSkill(manifest, alias, manifestPatch)
    await writeManifest(repositoryRoot, nextManifest)
    manifestWritten = true

    /* Step 9 — Lock: revision / integrity / security / upstream (SPEC §117). */
    const lockfile = await readLockfileOrEmpty(repositoryRoot)
    lockfilePath = path.join(repositoryRoot, LOCKFILE_FILE_NAME)
    lockfileBefore = await snapshotFileOrUndefined(lockfilePath, filesystem)
    const locked = createLockedSkill({
      mode: 'managed',
      source: manifestSource,
      integrity,
      revision,
    })
    locked.upstream = { source: manifestSource, baseRevision: revision }
    locked.security = { risk: security.risk, scannedAt: security.scannedAt }
    const nextLockfile: SkillboxLockfile = {
      ...lockfile,
      skills: { ...lockfile.skills, [alias]: locked },
    }
    await writeLockfile(repositoryRoot, nextLockfile)
    lockfileWritten = true

    /* Step 10 — Agents: link the materialized skill to each target agent. */
    for (const agentId of targetAgents) {
      const adapter = agentRegistry.get(agentId)
      if (adapter === undefined) {
        throw new SkillboxError(
          ErrorCode.INSTALL_AGENT_LINK_FAILED,
          `Unknown target agent "${agentId}"`,
          { context: { agentId, alias } },
        )
      }
      const linkResult = await linkSkillToAgent({
        adapter,
        agentId,
        alias,
        source: materialized.path,
        strategy: 'auto',
        ownership,
        links: linkState,
        filesystem,
      })
      if (linkResult.action === 'created') {
        linkedEntries.push({ agentId, alias })
      } else if (linkResult.action !== 'existing') {
        throw new SkillboxError(
          ErrorCode.INSTALL_AGENT_LINK_FAILED,
          `Failed to link skill "${alias}" to agent "${agentId}" (${linkResult.action})`,
          { context: { agentId, alias, action: linkResult.action } },
        )
      }
    }

    /* Success: the download served its purpose (cached + materialized) — drop it. */
    for (const dir of [...tmpDirs].reverse()) {
      try {
        await filesystem.remove(dir)
      } catch {
        // best effort: a stale tmp dir must not fail a completed install
      }
    }

    return {
      alias,
      mode: 'managed',
      source,
      revision,
      integrity,
      security,
      agents: targetAgents,
      materializedPath: materialized.path,
      cacheHit,
    }
  } catch (error) {
    if (
      cacheHit &&
      isSkillboxError(error) &&
      error.code === ErrorCode.INTEGRITY_MISMATCH &&
      revision !== undefined
    ) {
      // A poisoned cache entry must not keep failing: purge it so a retry redownloads.
      try {
        await cache.invalidate(source, revision)
      } catch {
        // best effort
      }
    }
    try {
      await rollback()
    } catch (rollbackError) {
      throw new SkillboxError(
        ErrorCode.INSTALL_ROLLBACK_FAILED,
        'Install failed and rollback also failed',
        {
          cause: rollbackError,
          context: { alias, original: error instanceof Error ? error.message : String(error) },
        },
      )
    }
    throw error
  }
}

/**
 * M16.2 Update transaction.
 *
 * Re-runs the M15.1 pipeline for a skill that is already installed: locates
 * the alias in the lockfile, compares the provider's latest revision with
 * the locked one and — when they differ — re-resolves, re-downloads (through
 * the managed cache), re-validates, re-scans and re-materializes the skill,
 * bumping the lockfile `revision` / `integrity` while preserving the agent
 * links recorded in the manifest. When the locked revision is already the
 * latest, the call is a no-op that returns the current state.
 *
 * The canonical source resolver comes from `options.sourceResolver`. Existing
 * `provider` callers are supported through a temporary adapter; when omitted,
 * update resolves the legacy provider from the default registry.
 *
 * Throws on failure:
 * - `SKILL_NOT_FOUND` when the alias has no lockfile entry (or no lockfile)
 * - `SOURCE_UNSUPPORTED` for non-managed modes / unknown source types
 * - the same transaction errors as {@link installSkill} when updating
 *
 * Rollback caveat: like install, a failed update restores the repository
 * Manifest/Lockfile, but the refreshed library copy is left in place — the
 * library is disposable by design and a later successful run reconciles it.
 */
export async function updateSkill(
  source: NormalizedSource,
  options: UpdateSkillOptions,
): Promise<InstallResult> {
  const repositoryRoot = path.resolve(options.repositoryRoot)
  const alias =
    options.alias !== undefined ? validateSkillAlias(options.alias) : defaultAliasFor(source)

  // Locate the installed skill through the lockfile (source of truth).
  let lockfile: SkillboxLockfile
  try {
    lockfile = await readLockfile(repositoryRoot)
  } catch (error) {
    if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${alias}" is not installed; add it with the install flow first`,
        { context: { alias } },
      )
    }
    throw error
  }
  const locked = lockfile.skills[alias]
  if (locked === undefined) {
    throw new SkillboxError(ErrorCode.SKILL_NOT_FOUND, `Skill "${alias}" is not in the lockfile`, {
      context: { alias },
    })
  }
  if (locked.mode !== 'managed') {
    throw new SkillboxError(
      ErrorCode.SOURCE_UNSUPPORTED,
      `Skill "${alias}" is ${locked.mode}; only managed (remote) skills can be updated`,
      { context: { alias, mode: locked.mode } },
    )
  }

  const sourceResolver =
    options.sourceResolver ??
    createSkillSourceResolver({
      adapters: [legacyProviderAdapter(source, options.provider ?? resolveProvider(source.type))],
    })
  const canonicalSource = sourceResolver.fromManifest(normalizedSourceToManifestSource(source))

  /* Latest vs locked (M16.2): equal → no-op, return the current state. */
  const latestAdapter = sourceResolver.adapterFor(canonicalSource, 'latest')
  const latest = await latestAdapter.latest?.(canonicalSource)
  if (latest === undefined) {
    throw new SkillboxError(
      ErrorCode.INSTALL_SOURCE_UNRESOLVED,
      `Source resolver could not determine the latest revision for ${describeSource(source)}`,
      { context: { source } },
    )
  }
  if (latest === locked.revision) {
    const filesystem = options.filesystem ?? new FilesystemService()
    const layout = buildSkillboxHomeLayout(options.homeRoot ?? resolveSkillboxHome())
    const library = new RuntimeLibraryService(layout.library, filesystem)
    const manifest = await readManifestOrEmpty(repositoryRoot)
    const agents = manifest.skills[alias]?.agents ?? []
    return {
      alias,
      mode: 'managed',
      source,
      revision: latest,
      integrity: locked.integrity,
      security: locked.security ?? { risk: 'low', scannedAt: '' },
      agents,
      materializedPath: library.pathFor(alias, 'managed'),
      cacheHit: false,
    }
  }

  /* Changed → re-run the transaction, preserving the manifest's agent links. */
  const manifest = await readManifestOrEmpty(repositoryRoot)
  const targetAgents = manifest.skills[alias]?.agents ?? []
  const transactionOptions: InstallSkillOptions = {
    repositoryRoot,
    alias,
    targetAgents,
    sourceResolver,
  }
  if (options.allowPolicy !== undefined) {
    transactionOptions.allowPolicy = options.allowPolicy
  }
  if (options.agentRegistry !== undefined) {
    transactionOptions.agentRegistry = options.agentRegistry
  }
  if (options.homeRoot !== undefined) {
    transactionOptions.homeRoot = options.homeRoot
  }
  if (options.filesystem !== undefined) {
    transactionOptions.filesystem = options.filesystem
  }
  return runInstallTransaction(source, transactionOptions, { replacing: true })
}
