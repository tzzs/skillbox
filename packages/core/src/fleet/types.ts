import type { z } from 'zod'
import type { fleetConfigSchema, fleetHostConfigSchema } from './schema.js'

/**
 * Fleet (multi-host orchestration): drive `skillbox install` / `update` /
 * `status` on a set of remote machines over SSH from this machine. Every
 * remote host is expected to already have `skillbox` (and its own skill
 * repository) installed — Fleet does not provision either; it only
 * orchestrates the existing single-machine CLI remotely.
 *
 * One remote machine, from `.skillbox/fleet.yaml` (or an ad-hoc `--ssh`
 * entry): `name` is the unique label used to select this host (`--host
 * <name>`) and in results; `host` is the hostname/IP passed to `ssh`;
 * `identityFile` (private key path, `~` expanded by ssh itself) and
 * `remotePath` (directory to `cd` into before running `skillbox`) and
 * `skillboxBin` (defaults to `skillbox`, PATH lookup) and `tags` (free-form
 * labels selected with `--tag <tag>`) are all optional.
 */
export type FleetHostConfig = z.infer<typeof fleetHostConfigSchema>

export const FLEET_CONFIG_VERSION = 1 as const

/** `.skillbox/fleet.yaml` — the inventory of remote hosts Fleet can target. */
export type FleetConfig = z.infer<typeof fleetConfigSchema>

/** Remote command Fleet knows how to run. */
export type FleetOperationName = 'install' | 'update' | 'status'

/** Which configured/ad-hoc hosts a Fleet run targets. */
export interface FleetHostSelector {
  /** Select configured hosts by name; unknown names throw `FLEET_HOST_NOT_FOUND`. */
  hostNames?: readonly string[]
  /** Select configured hosts carrying any of these tags. */
  tags?: readonly string[]
  /** Hosts supplied directly on the command line, outside the config file. */
  adHoc?: readonly FleetHostConfig[]
}

/** Outcome of running one operation against one host. */
export interface FleetHostResult {
  host: string
  ok: boolean
  /** Remote process exit code; `null` when the connection itself failed. */
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  /** Set when the SSH connection/spawn failed before a remote exit code existed. */
  error?: string
}

export interface FleetRunResult {
  operation: FleetOperationName
  results: FleetHostResult[]
}

export interface FleetRunOptions {
  /** Maximum number of hosts contacted at once; defaults to 4. */
  concurrency?: number
  /** Per-host SSH timeout in milliseconds. */
  timeoutMs?: number
  /** Report the command that would run on each host without executing it. */
  dryRun?: boolean
}
