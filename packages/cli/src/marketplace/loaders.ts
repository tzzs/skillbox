import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  buildSkillboxHomeLayout,
  clearCache,
  defaultRegistry,
  GitHubProvider,
  GitSourceProvider,
  installSkill,
  LocalProvider,
  parseSource,
  registerProvider,
  resolveProvider,
  resolveSkillboxHome,
  scanSkillForSecurity,
  SkillsShProvider,
  updateSkill,
  type InstallSkillOptions,
  type RegistryProvider as CoreRegistryProvider,
  type UpdateSkillOptions,
} from '@skillbox/core'
import type {
  InstallResult,
  InstallService,
  InstallSkillInput,
  NormalizedSource,
  RegistryClient,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
  SecurityScanner,
  SecurityScanResult,
  SourceParser,
  UpdateSkillInput,
} from './types.js'

/**
 * V0.3 Marketplace — default adapters over `@skillbox/core` (CLI layer).
 *
 * Core is imported statically and called through its real signatures
 * (`parseSource`, `defaultRegistry` / `resolveProvider` / `registerProvider`,
 * `installSkill` / `updateSkill` / `clearCache`, `scanSkillForSecurity`,
 * `buildSkillboxHomeLayout` / `resolveSkillboxHome`), so a renamed or dropped
 * export is a build failure here rather than a runtime "this build is missing
 * the Core X export" guess. `./types.js` re-exports core's data shapes and adds
 * the CLI's own request/view contracts, so these adapters mostly hand values
 * straight through.
 *
 * Each factory takes a `deps` object with one field per core function it
 * calls; production (see `program.ts`) uses the exported defaults, and focused
 * tests pass fakes for the functions they care about.
 */

/* ------------------------------------------------------------------ *
 * Core dependency seams
 * ------------------------------------------------------------------ */

/** First-party providers, constructed with core defaults (no options). */
const DEFAULT_PROVIDER_FACTORIES: readonly (() => CoreRegistryProvider)[] = [
  () => new GitHubProvider(),
  () => new SkillsShProvider(),
  () => new GitSourceProvider(),
  () => new LocalProvider(),
]

/** Registration slice of core's provider registry, shared by two adapters. */
export interface MarketplaceProviderRegistrationDeps {
  /** Providers currently on the process-wide `defaultRegistry`. */
  listProviders: () => CoreRegistryProvider[]
  registerProvider: typeof registerProvider
  /** Factories for the providers to register; a throwing one is skipped. */
  providerFactories: readonly (() => CoreRegistryProvider)[]
}

export const defaultMarketplaceProviderRegistrationDeps: MarketplaceProviderRegistrationDeps = {
  listProviders: () => defaultRegistry.listProviders(),
  registerProvider,
  providerFactories: DEFAULT_PROVIDER_FACTORIES,
}

/**
 * Makes the first-party providers available to every production marketplace
 * entrypoint. Nothing else on the CLI path guarantees this (the web services
 * and core's `createDefaultSkillSourceResolver` register their own, lazily),
 * and registration is idempotent: an already-registered id — including one a
 * test injected — is left alone.
 */
function ensureDefaultProvidersRegistered(deps: MarketplaceProviderRegistrationDeps): void {
  const registered = new Set(deps.listProviders().map((provider) => provider.id))
  for (const create of deps.providerFactories) {
    try {
      const provider = create()
      if (registered.has(provider.id)) {
        continue
      }
      deps.registerProvider(provider)
      registered.add(provider.id)
    } catch {
      // An unavailable optional provider must not take down the marketplace.
    }
  }
}

/* ------------------------------------------------------------------ *
 * Source parser — @skillbox/core/registry
 * ------------------------------------------------------------------ */

export interface MarketplaceSourceParserDeps {
  parseSource: typeof parseSource
}

export const defaultMarketplaceSourceParserDeps: MarketplaceSourceParserDeps = { parseSource }

class SourceParserAdapter implements SourceParser {
  constructor(private readonly deps: MarketplaceSourceParserDeps) {}

  /** Core's parser is synchronous; bad input throws `SOURCE_INVALID`. */
  async parse(source: string): Promise<NormalizedSource> {
    return this.deps.parseSource(source)
  }
}

export function createDefaultSourceParser(
  deps: MarketplaceSourceParserDeps = defaultMarketplaceSourceParserDeps,
): SourceParser {
  return new SourceParserAdapter(deps)
}

/* ------------------------------------------------------------------ *
 * Registry client — @skillbox/core/registry
 * ------------------------------------------------------------------ */

export interface MarketplaceRegistryClientDeps extends MarketplaceProviderRegistrationDeps {
  resolveProvider: typeof resolveProvider
}

export const defaultMarketplaceRegistryClientDeps: MarketplaceRegistryClientDeps = {
  ...defaultMarketplaceProviderRegistrationDeps,
  resolveProvider,
}

class RegistryClientAdapter implements RegistryClient {
  constructor(private readonly deps: MarketplaceRegistryClientDeps) {}

  async search(query: string): Promise<RegistrySearchResult[]> {
    ensureDefaultProvidersRegistered(this.deps)
    const results: RegistrySearchResult[] = []
    for (const provider of this.deps.listProviders()) {
      try {
        results.push(...(await provider.search(query)))
      } catch {
        // Per-provider degradation: one registry's failure (e.g. the GitHub
        // unauthenticated 60 req/h rate limit) must not kill the aggregate.
      }
    }
    return results
  }

  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    ensureDefaultProvidersRegistered(this.deps)
    return await this.deps.resolveProvider(source.type).resolve(source)
  }

  async getLatestRevision(source: NormalizedSource): Promise<string> {
    ensureDefaultProvidersRegistered(this.deps)
    return await this.deps.resolveProvider(source.type).getLatestRevision(source)
  }

  /** Unregistered source types surface core's `SOURCE_UNSUPPORTED` error. */
  async providerFor(source: NormalizedSource): Promise<RegistryProvider> {
    ensureDefaultProvidersRegistered(this.deps)
    return this.deps.resolveProvider(source.type)
  }
}

/** `_homeRoot` stays part of the signature the CLI wiring calls with. */
export function createDefaultRegistryClient(
  _homeRoot: string,
  deps: MarketplaceRegistryClientDeps = defaultMarketplaceRegistryClientDeps,
): RegistryClient {
  return new RegistryClientAdapter(deps)
}

/* ------------------------------------------------------------------ *
 * Install transaction — @skillbox/core/install
 * ------------------------------------------------------------------ */

/**
 * Counts managed-cache entries (`cache/<source-key>/<revision>` dirs) so
 * `skillbox cache clean` can report how many were freed. Core's
 * `clearCache()` returns void, so the count happens on the CLI side.
 * Transient `.partial-*` staging dirs are not counted.
 */
async function countCacheEntries(cacheRoot: string): Promise<number> {
  let keys: string[]
  try {
    keys = await fs.readdir(cacheRoot)
  } catch {
    return 0
  }
  let entries = 0
  for (const key of keys) {
    if (key.startsWith('.')) {
      continue
    }
    let revisions: string[]
    try {
      revisions = await fs.readdir(path.join(cacheRoot, key))
    } catch {
      continue
    }
    entries += revisions.filter((revision) => !revision.startsWith('.partial-')).length
  }
  return entries
}

export interface MarketplaceInstallServiceDeps extends MarketplaceProviderRegistrationDeps {
  installSkill: typeof installSkill
  /**
   * Core's install *transaction* `updateSkill(source, options)` — the root
   * barrel re-exports it explicitly over the same-named manifest helper.
   */
  updateSkill: typeof updateSkill
  clearCache: typeof clearCache
  buildSkillboxHomeLayout: typeof buildSkillboxHomeLayout
  resolveSkillboxHome: typeof resolveSkillboxHome
}

export const defaultMarketplaceInstallServiceDeps: MarketplaceInstallServiceDeps = {
  ...defaultMarketplaceProviderRegistrationDeps,
  installSkill,
  updateSkill,
  clearCache,
  buildSkillboxHomeLayout,
  resolveSkillboxHome,
}

class InstallServiceAdapter implements InstallService {
  constructor(
    private readonly options: { repositoryRoot: string; homeRoot: string },
    private readonly deps: MarketplaceInstallServiceDeps,
  ) {}

  async installSkill(input: InstallSkillInput): Promise<InstallResult> {
    ensureDefaultProvidersRegistered(this.deps)
    // Maps the CLI input onto core's `InstallSkillOptions`. The transaction
    // re-resolves the revision internally (M15.1), so none is passed here.
    const options: InstallSkillOptions = { repositoryRoot: this.options.repositoryRoot }
    if (input.provider !== undefined) {
      options.provider = input.provider
    }
    if (input.alias !== undefined) {
      options.alias = input.alias
    }
    if (input.targetAgents !== undefined) {
      options.targetAgents = [...input.targetAgents]
    }
    if (input.allowHighRisk === true) {
      options.allowPolicy = { allowHighRisk: true }
    }
    if (input.homeRoot !== undefined) {
      options.homeRoot = input.homeRoot
    }
    return await this.deps.installSkill(input.source, options)
  }

  async updateSkill(input: UpdateSkillInput): Promise<void> {
    ensureDefaultProvidersRegistered(this.deps)
    // No provider here: core's transaction falls back to
    // `resolveProvider(source.type)`, which the registration above wires up.
    const options: UpdateSkillOptions = {
      repositoryRoot: this.options.repositoryRoot,
      alias: input.name,
    }
    if (input.allowHighRisk === true) {
      options.allowPolicy = { allowHighRisk: true }
    }
    if (input.homeRoot !== undefined) {
      options.homeRoot = input.homeRoot
    }
    await this.deps.updateSkill(input.source, options)
  }

  async clearCache(): Promise<{ cleared: number }> {
    // Prefer the CLI's configured home root; fall back to core's resolution
    // (SKILLBOX_HOME env / `~/.skillbox`) when it was left empty.
    const homeRoot =
      this.options.homeRoot !== '' ? this.options.homeRoot : this.deps.resolveSkillboxHome()
    const cleared = await countCacheEntries(this.deps.buildSkillboxHomeLayout(homeRoot).cache)
    // The core cache is disposable by design; only clear when something is
    // there, so an empty cache never touches unrelated directories.
    if (cleared > 0) {
      await this.deps.clearCache(homeRoot)
    }
    return { cleared }
  }
}

export function createDefaultInstallService(
  options: { repositoryRoot: string; homeRoot: string },
  deps: MarketplaceInstallServiceDeps = defaultMarketplaceInstallServiceDeps,
): InstallService {
  return new InstallServiceAdapter(options, deps)
}

/* ------------------------------------------------------------------ *
 * Security scanner — @skillbox/core/security
 * ------------------------------------------------------------------ */

export interface MarketplaceSecurityScannerDeps {
  scanSkillForSecurity: typeof scanSkillForSecurity
}

export const defaultMarketplaceSecurityScannerDeps: MarketplaceSecurityScannerDeps = {
  scanSkillForSecurity,
}

class SecurityScannerAdapter implements SecurityScanner {
  constructor(private readonly deps: MarketplaceSecurityScannerDeps) {}

  async scan(directory: string): Promise<SecurityScanResult> {
    return await this.deps.scanSkillForSecurity(directory)
  }
}

export function createDefaultSecurityScanner(
  deps: MarketplaceSecurityScannerDeps = defaultMarketplaceSecurityScannerDeps,
): SecurityScanner {
  return new SecurityScannerAdapter(deps)
}
