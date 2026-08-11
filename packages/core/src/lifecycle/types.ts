import type { FilesystemService } from '../fs/filesystem-service.js'
import type { ManifestSkillSource } from '../manifest/schema.js'

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
