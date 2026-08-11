import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { SkillboxError, type SkillboxErrorCode } from '@skillbox/core'
import type {
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
 * V0.3 Marketplace — default provider loaders (CLI layer).
 *
 * Follows the V0.2 sync convention (`./sync/loaders.js`): the CLI defines the
 * contracts in `./types.js` and adapts the core modules onto them at runtime
 * through a dynamic import. A build missing an expected export fails with a
 * typed SkillboxError and recovery hint instead of crashing.
 *
 * Current mapping onto `@skillbox/core`:
 * - `parseSource`                     (registry/source.js)
 * - `defaultRegistry` / `resolveProvider` (registry/registry.js)
 * - `installSkill` / `updateSkill` / `clearCache` (install/transaction.js + cache.js)
 * - `scanSkillForSecurity`            (security/scanner.js)
 * - `buildSkillboxHomeLayout` / `resolveSkillboxHome` (runtime/paths.js)
 */

/** Loads the core package as an opaque module map (injectable in tests). */
export type CoreModuleLoader = () => Promise<Record<string, unknown>>

async function loadSkillboxCore(): Promise<Record<string, unknown>> {
  try {
    return (await import('@skillbox/core')) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

function unavailable(code: SkillboxErrorCode, hint: string): SkillboxError {
  return new SkillboxError(code, hint)
}

/* ------------------------------------------------------------------ *
 * Source parser — @skillbox/core/registry
 * ------------------------------------------------------------------ */

class SourceParserAdapter implements SourceParser {
  constructor(
    private readonly loadCore: CoreModuleLoader,
    private readonly hint: string,
  ) {}

  async parse(source: string): Promise<NormalizedSource> {
    const core = await this.loadCore()
    const parseSource = core.parseSource as ((source: string) => unknown) | undefined
    if (typeof parseSource === 'function') {
      return parseSource(source) as NormalizedSource
    }
    // Fallback for older core builds that shipped a `SourceParser` class.
    const Parser = core.SourceParser as
      (new () => { parse: (source: string) => unknown }) | undefined
    if (typeof Parser === 'function') {
      return new Parser().parse(source) as NormalizedSource
    }
    throw unavailable('REGISTRY_UNAVAILABLE', this.hint)
  }
}

export function createDefaultSourceParser(
  loadCore: CoreModuleLoader = loadSkillboxCore,
  hint: string = 'This build is missing the Core source parser export. Reinstall or upgrade skillbox.',
): SourceParser {
  return new SourceParserAdapter(loadCore, hint)
}

/* ------------------------------------------------------------------ *
 * Registry client — @skillbox/core/registry
 * ------------------------------------------------------------------ */

/** Structural shape of a core `RegistryProvider` (registry/types.js). */
interface RegistryProviderShape {
  id: string
  search: (query: string) => unknown
  resolve: (source: unknown) => unknown
  download: (source: unknown, revision: string, targetDir: string) => unknown
  getLatestRevision: (source: unknown) => unknown
}

/** Structural shape of the core `ProviderRegistry` (registry/registry.js). */
interface ProviderRegistryShape {
  listProviders: () => RegistryProviderShape[]
}

/** Makes first-party providers available to every production marketplace entrypoint. */
function ensureDefaultProvidersRegistered(core: Record<string, unknown>): void {
  const registerProvider = core.registerProvider as ((provider: unknown) => unknown) | undefined
  const registry = core.defaultRegistry as ProviderRegistryShape | undefined
  if (typeof registerProvider !== 'function' || registry?.listProviders === undefined) {
    return
  }
  for (const candidate of [core.GitHubProvider, core.SkillsShProvider, core.LocalProvider]) {
    if (typeof candidate !== 'function') {
      continue
    }
    const Provider = candidate as new () => RegistryProviderShape
    try {
      const provider = new Provider()
      if (!registry.listProviders().some((existing) => existing.id === provider.id)) {
        registerProvider(provider)
      }
    } catch {
      // An unavailable optional provider must not take down the marketplace.
    }
  }
}

class RegistryClientAdapter implements RegistryClient {
  private modulePromise?: Promise<Record<string, unknown>>

  constructor(
    private readonly loadCore: CoreModuleLoader,
    private readonly hint: string,
  ) {}

  /** The core module, loaded once per adapter (dynamic imports are cached). */
  private async core(): Promise<Record<string, unknown>> {
    this.modulePromise ??= this.loadCore()
    const core = await this.modulePromise
    ensureDefaultProvidersRegistered(core)
    return core
  }

  private providerForSync(
    core: Record<string, unknown>,
    source: NormalizedSource,
  ): RegistryProviderShape {
    const resolveProvider = core.resolveProvider as ((sourceType: string) => unknown) | undefined
    if (typeof resolveProvider !== 'function') {
      throw unavailable('REGISTRY_UNAVAILABLE', this.hint)
    }
    return resolveProvider(source.type) as RegistryProviderShape
  }

  async search(query: string): Promise<RegistrySearchResult[]> {
    const core = await this.core()
    const registry = core.defaultRegistry as ProviderRegistryShape | undefined
    if (registry?.listProviders === undefined) {
      throw unavailable('REGISTRY_UNAVAILABLE', this.hint)
    }
    const results: RegistrySearchResult[] = []
    for (const provider of registry.listProviders()) {
      try {
        results.push(...((await provider.search(query)) as RegistrySearchResult[]))
      } catch {
        // Per-provider degradation: one registry's failure (e.g. the GitHub
        // unauthenticated 60 req/h rate limit) must not kill the aggregate.
      }
    }
    return results
  }

  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    const core = await this.core()
    const provider = this.providerForSync(core, source)
    return (await provider.resolve(source)) as ResolvedSource
  }

  async getLatestRevision(source: NormalizedSource): Promise<string> {
    const core = await this.core()
    const provider = this.providerForSync(core, source)
    return (await provider.getLatestRevision(source)) as string
  }

  async providerFor(source: NormalizedSource): Promise<RegistryProvider> {
    const core = await this.core()
    return this.providerForSync(core, source) as unknown as RegistryProvider
  }
}

export function createDefaultRegistryClient(
  _homeRoot: string,
  loadCore: CoreModuleLoader = loadSkillboxCore,
  hint: string = 'This build is missing the Core registry exports. Reinstall or upgrade skillbox.',
): RegistryClient {
  return new RegistryClientAdapter(loadCore, hint)
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

class InstallServiceAdapter implements InstallService {
  private modulePromise?: Promise<Record<string, unknown>>

  constructor(
    private readonly options: { repositoryRoot: string; homeRoot: string },
    private readonly loadCore: CoreModuleLoader,
    private readonly installHint: string,
    private readonly cacheHint: string,
  ) {}

  private async core(): Promise<Record<string, unknown>> {
    this.modulePromise ??= this.loadCore()
    const core = await this.modulePromise
    ensureDefaultProvidersRegistered(core)
    return core
  }

  async installSkill(
    input: InstallSkillInput,
  ): Promise<Awaited<ReturnType<InstallService['installSkill']>>> {
    const core = await this.core()
    const installSkill = core.installSkill as
      ((source: unknown, options: unknown) => unknown) | undefined
    if (typeof installSkill !== 'function') {
      throw unavailable('INSTALL_DOWNLOAD_FAILED', this.installHint)
    }
    // Maps the CLI input onto core's `InstallSkillOptions`. The transaction
    // re-resolves the revision internally (M15.1), so none is passed here.
    const options: Record<string, unknown> = {
      repositoryRoot: this.options.repositoryRoot,
      provider: input.provider,
    }
    if (input.alias !== undefined) {
      options.alias = input.alias
    }
    if (input.targetAgents !== undefined) {
      options.targetAgents = input.targetAgents
    }
    if (input.allowHighRisk === true) {
      options.allowPolicy = { allowHighRisk: true }
    }
    if (input.homeRoot !== undefined) {
      options.homeRoot = input.homeRoot
    }
    return (await installSkill(input.source, options)) as Awaited<
      ReturnType<InstallService['installSkill']>
    >
  }

  async updateSkill(input: UpdateSkillInput): Promise<void> {
    const core = await this.core()
    const updateSkill = core.updateSkill as
      ((source: unknown, options: unknown) => unknown) | undefined
    // `@skillbox/core` exports BOTH a manifest helper `updateSkill(manifest,
    // alias, patch)` (arity 3) and the install-transaction `updateSkill
    // (source, options)` (arity 2, M16.2) — the arity check keeps the adapter
    // from delegating to the wrong function.
    const isTransactionUpdate = typeof updateSkill === 'function' && updateSkill.length === 2
    if (!isTransactionUpdate) {
      throw unavailable(
        'INSTALL_DOWNLOAD_FAILED',
        'This build is missing the Core update transaction export. Reinstall or upgrade skillbox.',
      )
    }
    const options: Record<string, unknown> = {
      repositoryRoot: this.options.repositoryRoot,
      alias: input.name,
    }
    if (input.allowHighRisk === true) {
      options.allowPolicy = { allowHighRisk: true }
    }
    if (input.homeRoot !== undefined) {
      options.homeRoot = input.homeRoot
    }
    await updateSkill(input.source, options)
  }

  async clearCache(): Promise<{ cleared: number }> {
    const core = await this.core()
    const clearCache = core.clearCache as ((homeRoot?: string) => unknown) | undefined
    if (typeof clearCache !== 'function') {
      throw unavailable('CACHE_MISS', this.cacheHint)
    }
    const buildSkillboxHomeLayout = core.buildSkillboxHomeLayout as
      ((root: string) => { cache: string }) | undefined
    const resolveSkillboxHome = core.resolveSkillboxHome as (() => string) | undefined
    // Prefer the CLI's configured home root; fall back to core's resolution
    // (SKILLBOX_HOME env / `~/.skillbox`) when it was left empty.
    const homeRoot =
      this.options.homeRoot !== ''
        ? this.options.homeRoot
        : typeof resolveSkillboxHome === 'function'
          ? resolveSkillboxHome()
          : undefined
    const cacheRoot =
      typeof buildSkillboxHomeLayout === 'function' && homeRoot !== undefined
        ? buildSkillboxHomeLayout(homeRoot).cache
        : undefined
    const cleared = cacheRoot === undefined ? 0 : await countCacheEntries(cacheRoot)
    // The core cache is disposable by design; only clear when something is
    // there, so an empty cache never touches unrelated directories.
    if (cleared > 0 && homeRoot !== undefined) {
      await clearCache(homeRoot)
    }
    return { cleared }
  }
}

export function createDefaultInstallService(
  options: { repositoryRoot: string; homeRoot: string },
  loadCore: CoreModuleLoader = loadSkillboxCore,
  installHint: string = 'This build is missing the Core install transaction export. Reinstall or upgrade skillbox.',
  cacheHint: string = 'This build is missing the Core cache export; there is nothing to clean.',
): InstallService {
  return new InstallServiceAdapter(options, loadCore, installHint, cacheHint)
}

/* ------------------------------------------------------------------ *
 * Security scanner — @skillbox/core/security
 * ------------------------------------------------------------------ */

class SecurityScannerAdapter implements SecurityScanner {
  constructor(
    private readonly loadCore: CoreModuleLoader,
    private readonly hint: string,
  ) {}

  async scan(directory: string): Promise<SecurityScanResult> {
    const core = await this.loadCore()
    const scanSkillForSecurity = core.scanSkillForSecurity as
      ((skillRoot: string) => unknown) | undefined
    if (typeof scanSkillForSecurity !== 'function') {
      throw unavailable('INSTALL_DOWNLOAD_FAILED', this.hint)
    }
    return (await scanSkillForSecurity(directory)) as SecurityScanResult
  }
}

export function createDefaultSecurityScanner(
  loadCore: CoreModuleLoader = loadSkillboxCore,
  hint: string = 'This build is missing the Core security scanner export. Reinstall or upgrade skillbox.',
): SecurityScanner {
  return new SecurityScannerAdapter(loadCore, hint)
}
