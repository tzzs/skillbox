import type { FilesystemService } from '../fs/filesystem-service.js'
import type { ManifestSkillSource } from '../manifest/schema.js'
import type { AgentRegistry } from '../agent/index.js'
import type { RegistryProvider } from '../registry/types.js'

/** Shared options for every lifecycle transaction (fork / vendor). */
export interface LifecycleOptions {
  /**
   * Repository root whose `skillbox.yaml` / `skillbox.lock` gain the new
   * entry and whose `skills/<alias>` directory receives the copied content.
   */
  repositoryRoot: string
  /** Skillbox home root (defaults to `SKILLBOX_HOME` / `~/.skillbox`). */
  homeRoot?: string
  filesystem?: FilesystemService
}

/** Options for a Fork transaction (same shape as the base lifecycle options). */
export type ForkSkillOptions = LifecycleOptions

/** Outcome of a completed Fork transaction (M17.1). */
export interface ForkSkillResult {
  alias: string
  mode: 'forked'
  /** Repository-relative path of the forked skill directory (`skills/<alias>`). */
  repositoryPath: string
  /** Absolute path of the forked skill directory. */
  absolutePath: string
  /** Canonical integrity (`sha256:<hex>`) of the forked content. */
  integrity: string
  /** Upstream source the fork tracks (the original remote source). */
  upstream: ManifestSkillSource
  /** Revision the fork was based on (`upstream.baseRevision`). */
  baseRevision: string
  /** Integrity of the base snapshot (`upstream.baseIntegrity`). */
  baseIntegrity: string
  /**
   * Absolute path of the saved Base Snapshot
   * (`.skillbox/bases/<alias>/<revision>/`, inside the repository so git
   * tracks it — SPEC §58-60).
   */
  baseSnapshotPath: string
  /** Agents the skill stays enabled for (unchanged by the fork). */
  agents: string[]
}

export interface VendorSkillOptions extends LifecycleOptions {
  /**
   * Forked → Vendored only: also delete the saved Base Snapshot
   * (`.skillbox/bases/<alias>/`). Default `false` — removal is destructive,
   * the CLI decides.
   */
  removeBaseSnapshot?: boolean
  /**
   * Provenance (M18.3, P2): record the original source in the locked entry's
   * `metadata.originalSource`. Never consulted by update logic.
   */
  keepProvenance?: boolean
}

/** Outcome of a completed Vendor transaction (M18). */
export interface VendorSkillResult {
  alias: string
  mode: 'vendored'
  /** Repository-relative path of the vendored skill directory (`skills/<alias>`). */
  repositoryPath: string
  /** Absolute path of the vendored skill directory. */
  absolutePath: string
  /** Canonical integrity (`sha256:<hex>`) of the vendored content. */
  integrity: string
  /** True when the skill was Forked before and upstream tracking was dropped. */
  fromFork: boolean
  /** Absolute path of the removed Base Snapshot (only when removed). */
  removedBaseSnapshot?: string
  /** Agents the skill stays enabled for (unchanged by the vendor). */
  agents: string[]
}

/** Options for a Restore Upstream transaction (M17.3 "[Restore]"). */
export interface RestoreManagedSkillOptions extends LifecycleOptions {
  /**
   * Registry provider that re-downloads the pinned revision. Resolved through
   * the default registry (`resolveProvider(source.type)`) when omitted.
   */
  provider?: RegistryProvider
  /** Agent registry used to refresh the agent links. Default: first-party adapters. */
  agentRegistry?: AgentRegistry
}

/** Outcome of a completed Restore Upstream transaction (M17.3). */
export interface RestoreManagedSkillResult {
  alias: string
  /** Restore keeps the skill managed; only the runtime copy is replaced. */
  mode: 'managed'
  /** Number of files in the restored runtime (the lockfile-integrity content). */
  filesRestored: number
  /** Canonical integrity (`sha256:<hex>`) of the restored content. */
  integrity: string
  /** Pinned revision the runtime was restored to (the lockfile revision). */
  revision: string
  /** True when the runtime already matched the lockfile and nothing changed. */
  unchanged: boolean
  /**
   * Absolute path of the recovery snapshot of the pre-restore (modified)
   * runtime, kept under `~/.skillbox/state/backups/restore/`. Only set when
   * the runtime copy existed and was replaced.
   */
  backupPath?: string
  /** Absolute path of the restored managed runtime copy. */
  materializedPath: string
  /** Agents whose links were verified/refreshed. */
  agents: string[]
}
