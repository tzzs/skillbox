import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ErrorCode,
  isSkillboxError,
  readLockfile,
  readManifest,
  SkillboxError,
  type AgentRegistry,
  type ManifestSkillSource,
  type SkillboxErrorCode,
  type SkillboxLockfile,
} from '@skillbox/core'
import { isCancelResult, type InteractivePrompt } from '../interactive/prompts.js'
import { formatSource, progressStepLabel, renderSecurityReview, shortRevision } from './format.js'
import type {
  AddOutcome,
  CacheCleanOutcome,
  InstallResult,
  InstallService,
  InstallSkillInput,
  InstallStep,
  NormalizedSource,
  OutdatedEntry,
  RegistryClient,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
  SecurityScanner,
  SecurityScanResult,
  SourceParser,
  UpdateOutcome,
  UpdateSkillInput,
} from './types.js'

/**
 * V0.3 Marketplace — command flows behind `search` / `add` / `outdated` /
 * `update` / `cache clean`. All failures surface as `SkillboxError`s with a
 * recovery hint; the command layer only renders the results.
 */

export interface MarketplaceServiceOptions {
  repositoryRoot: string
  homeRoot: string
  registry: AgentRegistry
  sourceParser: SourceParser
  registryClient: RegistryClient
  installer: InstallService
  /** Agent 2's static security scanner (M21.3), used by the add flow. */
  scanner: SecurityScanner
  /** Clack prompts used by the interactive `add` flow. */
  prompts: InteractivePrompt
  /** True when the process is attached to a real interactive terminal. */
  isInteractive: boolean
  out: (chunk: string) => void
}

/** Wraps non-Skillbox failures with a typed code while passing errors through. */
function asSkillboxError(error: unknown, code: SkillboxErrorCode, fallback: string): SkillboxError {
  if (isSkillboxError(error)) {
    return error
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new SkillboxError(code, `${fallback}: ${detail}`, { cause: error })
}

/**
 * Maps a lockfile/manifest source (SPEC §23, `github|git|registry|local`)
 * onto the registry framework's `NormalizedSource` so `outdated` / `update`
 * can ask the providers for the latest revision.
 *
 * TODO(marketplace, agent 1): `git` and `registry` sources are not
 * representable in `NormalizedSource` yet — agent 1's `fromManifestSource`
 * (`packages/core/src/registry/source.ts`) can replace this mapping once it
 * covers those source types.
 */
export function normalizeLockedSource(source: ManifestSkillSource): NormalizedSource | undefined {
  switch (source.type) {
    case 'github': {
      const normalized: NormalizedSource = {
        type: 'github',
        repo: source.repo,
      }
      if (source.path !== undefined) {
        normalized.path = source.path
      }
      if (source.ref !== undefined) {
        normalized.ref = source.ref
      }
      return normalized
    }
    case 'local':
      return { type: 'local', path: source.path }
    default:
      return undefined
  }
}

export class MarketplaceService {
  constructor(private readonly options: MarketplaceServiceOptions) {}

  /** M14.6 — aggregated search across skills.sh + GitHub, by popularity. */
  async search(query: string): Promise<RegistrySearchResult[]> {
    const results = await this.options.registryClient.search(query)
    const seen = new Map<string, RegistrySearchResult>()
    for (const result of results) {
      const previous = seen.get(result.source)
      if (previous === undefined || result.popularity > previous.popularity) {
        seen.set(result.source, result)
      }
    }
    return [...seen.values()].sort(
      (a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name),
    )
  }

  /**
   * GAP §5.2 user story: parse → resolve → security review + confirm → pick
   * the target agent → install transaction → summary.
   *
   * The security review runs BEFORE anything is written: the pinned revision
   * is downloaded into a temp dir, scanned with agent 2's static scanner, and
   * HIGH-risk skills are gated on explicit confirmation (`--yes` or an
   * interactive prompt). The temp download is discarded after the scan; the
   * install transaction downloads again through the managed cache (M15.3).
   */
  async add(input: {
    source: string
    agent?: string
    alias?: string
    yes?: boolean
  }): Promise<AddOutcome> {
    const { sourceParser, registryClient, installer } = this.options

    let normalized: NormalizedSource
    try {
      normalized = await sourceParser.parse(input.source)
    } catch (error) {
      throw asSkillboxError(
        error,
        ErrorCode.SOURCE_INVALID,
        `Cannot parse source "${input.source}" — expected e.g. \`github:org/repo@path\` or \`org/repo@skills/<name>\``,
      )
    }

    let resolved: ResolvedSource
    try {
      resolved = await registryClient.resolve(normalized)
    } catch (error) {
      throw asSkillboxError(
        error,
        ErrorCode.REGISTRY_UNAVAILABLE,
        `Cannot resolve "${input.source}"`,
      )
    }
    this.reportProgress(
      'resolving',
      `${formatSource(normalized)} → ${shortRevision(resolved.revision)}`,
    )

    const review = await this.scanPreview(normalized, resolved.revision)
    this.reportProgress('scanning', `security review of ${shortRevision(resolved.revision)}`)
    const allowHighRisk = await this.confirmReview(review, input.yes === true)

    const agents = await this.pickAgents(input.agent)
    if (agents === null) {
      return { source: input.source, cancelled: true }
    }

    const installInput: InstallSkillInput = {
      source: normalized,
      targetAgents: agents,
      allowHighRisk,
      repositoryRoot: this.options.repositoryRoot,
      homeRoot: this.options.homeRoot,
    }
    if (input.alias !== undefined) {
      installInput.alias = input.alias
    }
    try {
      installInput.provider = await registryClient.providerFor(normalized)
    } catch (error) {
      throw asSkillboxError(
        error,
        ErrorCode.REGISTRY_UNAVAILABLE,
        `No registry provider is available for "${formatSource(normalized)}"`,
      )
    }

    let result: InstallResult
    try {
      result = await installer.installSkill(installInput)
    } catch (error) {
      throw asSkillboxError(
        error,
        ErrorCode.INSTALL_DOWNLOAD_FAILED,
        `Install failed for "${input.source}"`,
      )
    }

    return {
      source: input.source,
      alias: result.alias,
      revision: result.revision,
      integrity: result.integrity,
      agents: result.agents,
      // A successful transaction always writes both files (M15.3).
      manifestChanged: true,
      lockfileChanged: true,
    }
  }

  /** M16.1 — compares every managed skill's locked revision vs upstream. */
  async outdated(): Promise<OutdatedEntry[]> {
    let lockfile: SkillboxLockfile
    try {
      lockfile = await readLockfile(this.options.repositoryRoot)
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
        // Nothing installed yet → nothing to compare.
        return []
      }
      throw error
    }

    const entries: OutdatedEntry[] = []
    for (const [name, locked] of Object.entries(lockfile.skills)) {
      if (locked.mode !== 'managed') {
        continue
      }
      const entry: OutdatedEntry = { name, status: 'unknown' }
      if (locked.revision === undefined) {
        entry.status = 'unknown'
        entries.push(entry)
        continue
      }
      entry.installed = locked.revision
      const normalized = normalizeLockedSource(locked.source)
      if (normalized === undefined) {
        entry.status = 'unsupported'
        entries.push(entry)
        continue
      }
      try {
        const latest = await this.options.registryClient.getLatestRevision(normalized)
        entry.latest = latest
        entry.status = latest === locked.revision ? 'up-to-date' : 'outdated'
      } catch {
        // A per-skill failure only degrades that row (registry hiccup on one
        // repo must not abort the whole listing).
        entry.status = 'unknown'
      }
      entries.push(entry)
    }
    return entries
  }

  /** M16.2 — re-runs the install transaction for one managed skill. */
  async update(input: { name: string; yes?: boolean }): Promise<UpdateOutcome> {
    const lockfile = await this.readLockfileRequired()
    const locked = lockfile.skills[input.name]
    if (locked === undefined) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${input.name}" is not installed — run \`skillbox add <source>\` first, or \`skillbox list\` to see what is.`,
        { context: { name: input.name } },
      )
    }
    if (locked.mode !== 'managed') {
      throw new SkillboxError(
        ErrorCode.SOURCE_UNSUPPORTED,
        `Skill "${input.name}" is ${locked.mode} — only managed (remote) skills can be updated.`,
        { context: { name: input.name, mode: locked.mode } },
      )
    }
    const normalized = normalizeLockedSource(locked.source)
    if (normalized === undefined) {
      throw new SkillboxError(
        ErrorCode.SOURCE_UNSUPPORTED,
        `Skill "${input.name}" has a "${locked.source.type}" source that the marketplace cannot update yet.`,
        { context: { name: input.name, source: locked.source } },
      )
    }

    const fromRevision = locked.revision
    const updateInput: UpdateSkillInput = {
      name: input.name,
      source: normalized,
      allowHighRisk: input.yes === true,
      repositoryRoot: this.options.repositoryRoot,
      homeRoot: this.options.homeRoot,
    }
    try {
      await this.options.installer.updateSkill(updateInput)
    } catch (error) {
      throw asSkillboxError(
        error,
        ErrorCode.INSTALL_DOWNLOAD_FAILED,
        `Update failed for "${input.name}"`,
      )
    }

    // The lockfile is the source of truth for the new revision.
    const after = await readLockfile(this.options.repositoryRoot)
    const toRevision = after.skills[input.name]?.revision ?? fromRevision ?? ''
    const outcome: UpdateOutcome = {
      name: input.name,
      toRevision,
      lockfileChanged: toRevision !== fromRevision,
      linkedAgents: await this.readLinkedAgents(input.name),
    }
    if (fromRevision !== undefined) {
      outcome.fromRevision = fromRevision
    }
    const integrity = after.skills[input.name]?.integrity
    if (integrity !== undefined) {
      outcome.integrity = integrity
    }
    return outcome
  }

  /** Empties the managed download cache; returns the entries freed. */
  async cacheClean(): Promise<CacheCleanOutcome> {
    try {
      return await this.options.installer.clearCache()
    } catch (error) {
      throw asSkillboxError(error, ErrorCode.CACHE_INVALID, 'Cache clean failed')
    }
  }

  /* ------------------------------------------------------------------ *
   * Interactive helpers (the `add` / `update` flows)
   * ------------------------------------------------------------------ */

  /**
   * Pre-install security review (GAP §5.2): downloads the pinned revision
   * into a temp dir, runs agent 2's static scanner on it, then discards the
   * download. The install transaction scans again inside its own pipeline —
   * this preview only exists so the review can be SHOWN before anything is
   * written. TODO(marketplace): once the managed cache exposes a public
   * read-through API, populate it here so the transaction's download hits.
   */
  private async scanPreview(
    source: NormalizedSource,
    revision: string,
  ): Promise<SecurityScanResult> {
    let provider: RegistryProvider
    try {
      provider = await this.options.registryClient.providerFor(source)
    } catch (error) {
      throw asSkillboxError(
        error,
        ErrorCode.REGISTRY_UNAVAILABLE,
        `No registry provider is available for "${formatSource(source)}"`,
      )
    }
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skillbox-review-'))
    try {
      const downloadDir = path.join(tmpRoot, 'download')
      await fs.mkdir(downloadDir, { recursive: true })
      await provider.download(source, revision, downloadDir)
      return await this.options.scanner.scan(downloadDir)
    } catch (error) {
      throw asSkillboxError(
        error,
        ErrorCode.REGISTRY_UNAVAILABLE,
        `Cannot download "${formatSource(source)}" for the security review`,
      )
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Chooses the install target agent. With `--agent` the flag wins (validated
   * against the registered adapters); otherwise the detected agents are
   * offered interactively. Non-interactively a single candidate is picked
   * automatically and ambiguity is an error.
   *
   * Returns `null` when the user cancelled the picker.
   */
  private async pickAgents(requested?: string): Promise<readonly string[] | null> {
    const registered = this.options.registry.list()
    if (requested !== undefined) {
      if (!registered.some((adapter) => adapter.id === requested)) {
        throw new SkillboxError(
          ErrorCode.AGENT_NOT_FOUND,
          `Unknown agent "${requested}" — run \`skillbox agents\` to see the available agents.`,
          { context: { agent: requested } },
        )
      }
      return [requested]
    }

    const detected = await this.options.registry.detectAll()
    const candidates = detected.filter((agent) => agent.detected).map((agent) => agent.name)
    const fallback = candidates.length > 0 ? candidates : registered.map((adapter) => adapter.id)
    if (fallback.length === 0) {
      throw new SkillboxError(
        ErrorCode.AGENT_NOT_DETECTED,
        'No agents are detected on this machine — configure an agent first, or pass --agent <name>.',
      )
    }

    if (!this.options.isInteractive) {
      if (fallback.length === 1 && fallback[0] !== undefined) {
        const agent = fallback[0]
        this.options.out(`Installing for agent "${agent}"\n`)
        return [agent]
      }
      throw new SkillboxError(
        ErrorCode.AGENT_LINK_CONFLICT,
        `Multiple agents are detected (${fallback.join(', ')}) and no --agent was given — pass \`--agent <name>\` to choose.`,
        { context: { agents: fallback } },
      )
    }

    const answer = await this.options.prompts.select({
      message: 'Install for which agent?',
      options: fallback.map((name) => ({ value: name, label: name })),
    })
    if (isCancelResult(answer)) {
      return null
    }
    return [answer as string]
  }

  /**
   * Security gate (M21.4): renders the scan result and, for HIGH-risk skills,
   * requires explicit confirmation — `--yes` non-interactively, a clack
   * confirm interactively. LOW/MEDIUM reviews pass through (returns `false`,
   * i.e. no high-risk override needed).
   *
   * Returns `true` when the caller may install with the high-risk gate
   * lifted. Throws `INSTALL_SECURITY_BLOCKED` when a HIGH-risk install is
   * declined (or impossible to confirm non-interactively).
   */
  private async confirmReview(review: SecurityScanResult, yes: boolean): Promise<boolean> {
    const { prompts, isInteractive, out } = this.options
    const reviewText = renderSecurityReview(review)
    if (isInteractive) {
      prompts.note(reviewText, 'Security Review')
    } else {
      out(`${reviewText}\n`)
    }

    if (!review.block) {
      return false
    }
    if (yes) {
      out('Installing a HIGH-risk skill anyway (--yes).\n')
      return true
    }
    if (!isInteractive) {
      throw new SkillboxError(
        ErrorCode.INSTALL_SECURITY_BLOCKED,
        'Install blocked: the skill has a HIGH security risk. Re-run with --yes to override, or choose a different skill.',
        { context: { risk: review.risk } },
      )
    }
    const answer = await prompts.confirm({
      message: `This skill is rated ${review.risk.toUpperCase()} risk — install anyway?`,
      initialValue: false,
      active: 'Yes, install',
      inactive: 'No, cancel',
    })
    if (isCancelResult(answer) || answer !== true) {
      throw new SkillboxError(
        ErrorCode.INSTALL_SECURITY_BLOCKED,
        'Install declined: the skill has a HIGH security risk.',
        { context: { risk: review.risk } },
      )
    }
    return true
  }

  /** Streams install-transaction steps to the terminal. */
  private reportProgress(step: InstallStep, detail: string): void {
    const line = `  ${progressStepLabel(step)} ${detail}`
    if (this.options.isInteractive) {
      this.options.prompts.info(line)
    } else {
      this.options.out(`${line}\n`)
    }
  }

  private async readLockfileRequired(): Promise<SkillboxLockfile> {
    try {
      return await readLockfile(this.options.repositoryRoot)
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
        throw new SkillboxError(
          ErrorCode.LOCKFILE_NOT_FOUND,
          'No skillbox.lock found — run `skillbox sync` (or `skillbox add <source>`) first.',
          { cause: error },
        )
      }
      throw error
    }
  }

  /** Agent links recorded for a skill (manifest `agents` / defaultAgents). */
  private async readLinkedAgents(name: string): Promise<readonly string[]> {
    try {
      const manifest = await readManifest(this.options.repositoryRoot)
      const entry = manifest.skills[name]
      if (entry === undefined) {
        return []
      }
      return entry.agents ?? manifest.settings?.defaultAgents ?? []
    } catch {
      return []
    }
  }
}
