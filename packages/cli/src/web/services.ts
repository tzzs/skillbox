import {
  abortMerge,
  continueMerge,
  createDefaultAgentRegistry,
  defaultRegistry,
  diffSkill,
  ErrorCode,
  forkSkill,
  fromManifestSource,
  GitSourceProvider,
  GitHubProvider,
  installSkill,
  isSkillboxError,
  LocalProvider,
  mergeSkill,
  parseSource,
  readLockfile,
  readManifest,
  restoreManagedSkill,
  RuntimeConfigService,
  SkillsShProvider,
  SkillService,
  sourceToString,
  StatusService,
  vendorSkill,
  type AgentRegistry,
  type RegistryProvider,
  type RegistrySearchResult as CoreRegistrySearchResult,
  type SkillboxLockfile,
  type SkillboxManifest,
  type SkillDiff,
} from '@skillbox/core'
import { SkillboxHome } from '@skillbox/core'
import type {
  DiffService,
  InstallInput,
  InstallResult,
  InstallService,
  LifecycleOperationResult,
  LifecycleService,
  OutdatedSkill,
  RegistrySearchOptions,
  RegistrySearchResult,
  RegistrySearchService,
  UpdatesService,
  WebServices,
} from './types.js'

export interface CreateWebServicesOptions {
  /** Repository root managed by the API. */
  repositoryRoot: string
  /** Skillbox home root (library + links state). */
  homeRoot: string
  /** Agent registry; defaults to the built-in Claude + Codex + Cursor adapters. */
  registry?: AgentRegistry
  /**
   * V0.3 aggregated registry search. Defaults to the Core-backed service that
   * aggregates every provider of the process-wide `defaultRegistry`; tests
   * inject fakes to override.
   */
  search?: RegistrySearchService
  /**
   * V0.3 outdated/updates computation. Defaults to the Core-backed service
   * (lockfile managed skills compared against provider `getLatestRevision`);
   * tests inject fakes to override.
   */
  updates?: UpdatesService
  /**
   * V0.3 remote install transaction. Defaults to the Core `installSkill`
   * transaction; tests inject fakes to override.
   */
  install?: InstallService
  /**
   * V0.4 skill diff computation. Defaults to the Core `diffSkill` engine
   * (read-only: current/base/latest content against the process-wide
   * `defaultRegistry`); tests inject fakes to override.
   */
  diff?: DiffService
  /**
   * V0.4 lifecycle operations (fork / vendor / restore / merge). Defaults to
   * the Core transactions; tests inject fakes to override.
   */
  lifecycle?: LifecycleService
}

/**
 * Builds the Core service bundle behind the web API (M10.6: every route goes
 * through Core services — never through direct file access).
 */
export function createWebServices(options: CreateWebServicesOptions): WebServices {
  ensureDefaultProviders()
  const registry = options.registry ?? createDefaultAgentRegistry()
  const { repositoryRoot, homeRoot } = options
  const config = new RuntimeConfigService({
    configFilePath: new SkillboxHome({ root: homeRoot }).configFilePath(),
  })
  return {
    registry,
    repositoryRoot,
    homeRoot,
    config,
    skills: new SkillService({
      repositoryRoot,
      homeRoot,
      registry,
    }),
    status: new StatusService({
      repositoryRoot,
      registry,
    }),
    search: options.search ?? createSearchService(),
    updates: options.updates ?? createUpdatesService(repositoryRoot),
    install: options.install ?? createInstallService(repositoryRoot, homeRoot, registry),
    diff: options.diff ?? createDiffService(repositoryRoot, homeRoot),
    lifecycle: options.lifecycle ?? createLifecycleService(repositoryRoot, homeRoot, registry),
  }
}

/**
 * V0.4 lifecycle operations behind the web API (M17 fork / M18 vendor /
 * M17.3 restore / M20 merge). Every method delegates to the Core transaction
 * and maps the result onto the web shape; errors keep their Skillbox code so
 * the M10.8 envelope can offer the right recovery hint.
 */
function createLifecycleService(
  repositoryRoot: string,
  homeRoot: string,
  registry: AgentRegistry,
): LifecycleService {
  return {
    async fork(name: string): Promise<LifecycleOperationResult> {
      const result = await forkSkill(name, { repositoryRoot, homeRoot })
      return {
        name: result.alias,
        action: 'forked',
        localPath: result.repositoryPath,
        revision: result.baseRevision,
      }
    },
    async vendor(name: string): Promise<LifecycleOperationResult> {
      const result = await vendorSkill(name, { repositoryRoot, homeRoot })
      return {
        name: result.alias,
        action: 'vendored',
        localPath: result.repositoryPath,
      }
    },
    async restore(name: string): Promise<LifecycleOperationResult> {
      const result = await restoreManagedSkill(name, {
        repositoryRoot,
        homeRoot,
        agentRegistry: registry,
      })
      return {
        name: result.alias,
        action: 'restored',
        revision: result.revision,
        filesRestored: result.filesRestored,
      }
    },
    async merge(
      name: string,
      action: 'merge' | 'continue' | 'abort',
    ): Promise<LifecycleOperationResult> {
      if (action === 'abort') {
        const result = await abortMerge(name, { repositoryRoot, homeRoot })
        return { name: result.name, action: 'aborted', filesRestored: result.filesRestored }
      }
      if (action === 'continue') {
        const result = await continueMerge(name, { repositoryRoot, homeRoot })
        return {
          name: result.name,
          action: 'continued',
          filesMerged: result.filesMerged,
          changes: result.changes,
          conflicts: result.remainingConflicts.map((conflict) => ({
            path: conflict.path,
            hunks: conflict.hunks,
            ...(conflict.reason !== undefined ? { reason: conflict.reason } : {}),
          })),
          ...(result.baseRevision !== undefined ? { baseRevision: result.baseRevision } : {}),
        }
      }
      const result = await mergeSkill(name, { repositoryRoot, homeRoot })
      return {
        name: result.name,
        action: 'merged',
        filesMerged: result.filesMerged,
        changes: result.changes,
        conflicts: result.conflicts.map((conflict) => ({
          path: conflict.path,
          hunks: conflict.hunks,
          ...(conflict.reason !== undefined ? { reason: conflict.reason } : {}),
        })),
        ...(result.baseRevision !== undefined ? { baseRevision: result.baseRevision } : {}),
      }
    },
  }
}

/**
 * V0.4 skill diff computation (M19.5). Delegates to the Core `diffSkill`
 * engine — a pure read (repository + provider lookups, temp downloads) that
 * never writes back. Errors keep their Skillbox code (SKILL_NOT_FOUND,
 * DIFF_UPSTREAM_UNAVAILABLE, …) so the M10.8 envelope maps them correctly.
 */
function createDiffService(repositoryRoot: string, homeRoot: string): DiffService {
  return {
    async diffSkill(name: string): Promise<SkillDiff> {
      return diffSkill(name, {
        repositoryRoot,
        homeRoot,
        registry: defaultRegistry,
      })
    },
  }
}

/* ---- V0.3 registry services (agent 1 contract: `packages/core/src/registry`,
        agent 2 contract: `packages/core/src/install`) ---- */

/** One-time guard: the default providers are registered on the first build. */
let defaultProvidersRegistered = false

/** First-party providers registered on the process-wide `defaultRegistry`. */
const DEFAULT_PROVIDER_FACTORIES: ReadonlyArray<() => RegistryProvider> = [
  () => new GitHubProvider(),
  () => new SkillsShProvider(),
  () => new GitSourceProvider(),
  () => new LocalProvider(),
]

/**
 * Registers the Core first-party providers (github / skills-sh / local) on the
 * process-wide `defaultRegistry` exactly once, so every service build shares
 * one registry view. A provider that is already registered (e.g. a
 * test-injected stub or another CLI entry point) is left untouched, and a
 * factory that fails to construct (defensive against missing/partial exports)
 * is skipped without breaking the others.
 */
function ensureDefaultProviders(): void {
  if (defaultProvidersRegistered) {
    return
  }
  defaultProvidersRegistered = true
  for (const create of DEFAULT_PROVIDER_FACTORIES) {
    try {
      const provider = create()
      if (!defaultRegistry.hasProvider(provider.id)) {
        defaultRegistry.registerProvider(provider)
      }
    } catch {
      // Defensive: a missing/partial export must not break service creation.
    }
  }
}

/**
 * V0.3 aggregated registry search (M14.7). Aggregates `search()` across every
 * provider of the process-wide `defaultRegistry`; a single failing provider
 * degrades to the others, while an all-provider failure surfaces its error
 * through the M10.8 envelope. Core hits are mapped onto the web shape: the
 * `provider` is inferred from the source expression, `securityReviewed` from
 * the security review state, and trending/official default to `false` (core
 * registries do not report them).
 */
function createSearchService(): RegistrySearchService {
  return {
    async search(query: string, options?: RegistrySearchOptions): Promise<RegistrySearchResult[]> {
      const errors: unknown[] = []
      const results: RegistrySearchResult[] = []
      for (const provider of defaultRegistry.listProviders()) {
        if (options?.provider !== undefined && provider.id !== options.provider) {
          continue
        }
        try {
          for (const hit of await provider.search(query)) {
            results.push(mapSearchResult(hit))
          }
        } catch (error) {
          errors.push(error)
        }
      }
      if (results.length === 0 && errors.length > 0) {
        throw errors[0]
      }
      let filtered = results
      if (options?.trending === true) {
        filtered = filtered.filter((result) => result.trending === true)
      }
      if (options?.official === true) {
        filtered = filtered.filter((result) => result.official === true)
      }
      if (options?.sort === 'popularity') {
        filtered = [...filtered].sort(
          (left, right) => (right.popularity ?? 0) - (left.popularity ?? 0),
        )
      }
      return filtered
    },
  }
}

/** Maps a Core registry hit onto the web `RegistrySearchResult` shape. */
function mapSearchResult(hit: CoreRegistrySearchResult): RegistrySearchResult {
  return {
    name: hit.name,
    source: hit.source,
    provider: providerIdForSource(hit.source),
    ...(hit.description.length > 0 ? { description: hit.description } : {}),
    ...(hit.popularity > 0 ? { popularity: hit.popularity } : {}),
    trending: false,
    official: false,
    securityReviewed: hit.security === 'reviewed',
  }
}

/** Infers the provider id from a source expression (`github:` / `skills.sh/` / local path). */
function providerIdForSource(source: string): string {
  try {
    return parseSource(source).type
  } catch {
    // Unparseable expressions are not a provider we can label; keep them local-ish.
    return 'local'
  }
}

/**
 * V0.3 outdated / updates computation (M16.3). Reads the repository lockfile,
 * compares each managed skill's pinned revision against the provider's latest
 * and reports the rows that actually drifted. Per-skill failures degrade to
 * the remaining skills; a missing lockfile simply means "nothing installed".
 */
function createUpdatesService(repositoryRoot: string): UpdatesService {
  return {
    async outdated(): Promise<OutdatedSkill[]> {
      let lockfile: SkillboxLockfile
      try {
        lockfile = await readLockfile(repositoryRoot)
      } catch (error) {
        if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
          return []
        }
        throw error
      }
      let manifest: SkillboxManifest | undefined
      try {
        manifest = await readManifest(repositoryRoot)
      } catch {
        // An unreadable manifest only costs the per-row `agents` decoration.
      }
      const rows: OutdatedSkill[] = []
      for (const [alias, skill] of Object.entries(lockfile.skills)) {
        if (skill.mode !== 'managed') {
          continue
        }
        const normalized = fromManifestSource(skill.source)
        if (normalized === null) {
          continue
        }
        let latest: string
        try {
          latest = await defaultRegistry
            .resolveProvider(normalized.type)
            .getLatestRevision(normalized)
        } catch {
          // One unreachable provider must not fail the whole update check.
          continue
        }
        const installed = skill.revision ?? ''
        if (installed === latest) {
          continue
        }
        rows.push({
          name: alias,
          source: sourceToString(normalized),
          installed,
          latest,
          changes: [],
          ...(skill.security !== undefined ? { securityRisk: skill.security.risk } : {}),
          agents: manifest?.skills[alias]?.agents ?? [],
        })
      }
      return rows
    },
  }
}

/**
 * V0.3 remote install transaction (M15). Parses the source, resolves its
 * provider on the process-wide `defaultRegistry` and delegates to the Core
 * `installSkill` transaction. Errors keep their Skillbox code so the M10.8
 * envelope can offer the right recovery hint (e.g. retry with
 * `allowPolicy: 'all'` after an `INSTALL_SECURITY_BLOCKED`).
 */
function createInstallService(
  repositoryRoot: string,
  homeRoot: string,
  registry: AgentRegistry,
): InstallService {
  return {
    async install(input: InstallInput): Promise<InstallResult> {
      const source = parseSource(input.source)
      const provider = defaultRegistry.resolveProvider(source.type)
      const result = await installSkill(source, {
        repositoryRoot,
        homeRoot,
        provider,
        targetAgents: input.targetAgents,
        allowPolicy: { allowHighRisk: input.allowPolicy === 'all' },
        agentRegistry: registry,
      })
      return {
        name: result.alias,
        source: sourceToString(result.source),
        revision: result.revision,
        path: result.materializedPath,
        security: {
          risk: result.security.risk,
          scannedAt: result.security.scannedAt,
          findings: [],
        },
        agents: result.agents,
        manifestChanged: true,
        lockfileChanged: true,
      }
    },
  }
}
