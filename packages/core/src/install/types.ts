import type { AgentRegistry } from '../agent/index.js'
import type { FilesystemService } from '../fs/filesystem-service.js'
import type { NormalizedSource, RegistryProvider } from '../registry/types.js'
import type { SecurityMetadata } from '../security/types.js'
import type { SkillSourceResolver } from '../sources/types.js'

/**
 * Install-time security policy overrides (M15.1 Security step). A skill whose
 * static scan rated `high` is rejected by default; pass `allowHighRisk: true`
 * to install it anyway.
 */
export interface InstallAllowPolicy {
  /** Permit a skill whose security scan rated `high`. Default `false`. */
  allowHighRisk?: boolean
}

export interface InstallSkillOptions {
  /**
   * Repository root whose `skillbox.yaml` / `skillbox.lock` gain the new
   * entry. Only the Manifest + Lock change inside the repository (M15.3);
   * the full skill files live in the managed library.
   */
  repositoryRoot: string
  /**
   * @deprecated Compatibility input for existing callers. New integrations
   * should pass `sourceResolver`; this provider is wrapped as an adapter.
   */
  provider?: RegistryProvider
  /**
   * Canonical source boundary for resolution and materialization. When omitted,
   * the legacy `provider` is wrapped as a source adapter for compatibility.
   */
  sourceResolver?: SkillSourceResolver
  /**
   * Skill alias used in the manifest, library and agent links. Derived from
   * the source when omitted (`repo` / last path segment).
   */
  alias?: string
  /** Agents the skill is linked to (skill-level `agents`). Default: none. */
  targetAgents?: string[]
  /** Security gate overrides; high risk is rejected unless allowed. */
  allowPolicy?: InstallAllowPolicy
  /** Agent registry used for the link step. Default: first-party adapters. */
  agentRegistry?: AgentRegistry
  /** Skillbox home root (defaults to `SKILLBOX_HOME` / `~/.skillbox`). */
  homeRoot?: string
  filesystem?: FilesystemService
}

/**
 * M16.2 Update options — the same transaction fields as
 * {@link InstallSkillOptions} minus `targetAgents`: an update preserves the
 * agent links already recorded in the manifest.
 */
export interface UpdateSkillOptions {
  /**
   * Repository root whose `skillbox.yaml` / `skillbox.lock` record the
   * updated entry.
   */
  repositoryRoot: string
  /**
   * @deprecated Compatibility input for existing callers. New integrations
   * should pass `sourceResolver`; this provider is wrapped as an adapter.
   */
  provider?: RegistryProvider
  /** Canonical source boundary; see {@link InstallSkillOptions.sourceResolver}. */
  sourceResolver?: SkillSourceResolver
  /**
   * Skill alias recorded in the manifest/lockfile. Derived from the source
   * when omitted (`repo` / last path segment).
   */
  alias?: string
  /** Security gate overrides; high risk is rejected unless allowed. */
  allowPolicy?: InstallAllowPolicy
  /** Agent registry used for the link step. Default: first-party adapters. */
  agentRegistry?: AgentRegistry
  /** Skillbox home root (defaults to `SKILLBOX_HOME` / `~/.skillbox`). */
  homeRoot?: string
  filesystem?: FilesystemService
}

/** Outcome of a completed install transaction (M15.1). */
export interface InstallResult {
  alias: string
  /** Install transactions always produce managed skills (M15.2). */
  mode: 'managed'
  /** The normalized source that was installed. */
  source: NormalizedSource
  /** Pinned revision installed (commit SHA for git-backed sources). */
  revision: string
  /** Canonical integrity (`sha256:<hex>`) of the installed content. */
  integrity: string
  /** Static scan metadata persisted into the lockfile. */
  security: SecurityMetadata
  /** Agents the skill was linked to. */
  agents: string[]
  /** Absolute path of the materialized skill under the managed library. */
  materializedPath: string
  /** True when the content came from the managed cache (M15.3). */
  cacheHit: boolean
}
