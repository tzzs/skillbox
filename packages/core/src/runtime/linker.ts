import * as path from 'node:path'
import { realpath } from 'node:fs/promises'
import { FilesystemService } from '../fs/filesystem-service.js'
import { resolveLinkStrategy, type LinkStrategy, type ResolvedLinkStrategy } from '../fs/links.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import type { AgentAdapter } from '../agent/adapter.js'
import { RuntimeLinkState } from './links.js'
import { RuntimeOwnershipResolver } from './ownership.js'

export type LinkAction =
  'created' | 'existing' | 'kept_modified' | 'blocked' | 'missing_adapter' | 'no_dir'

export interface LinkSkillInput {
  adapter: AgentAdapter
  agentId: string
  /** Skill alias used inside the agent skills-directory entry name. */
  alias: string
  /** Absolute path of the materialized library source (the link source). */
  source: string
  /** Requested link strategy; `auto` is resolved per platform. */
  strategy: LinkStrategy
  ownership: RuntimeOwnershipResolver
  links: RuntimeLinkState
  filesystem?: FilesystemService
  platform?: NodeJS.Platform
}

export interface LinkSkillResult {
  action: LinkAction
  /** Absolute path of the agent skills-directory entry (when reachable). */
  path?: string
  /** True when the physical entry was (re)created, i.e. a real change. */
  changed: boolean
  strategy: ResolvedLinkStrategy
}

/** True when two paths resolve to the same target (follows junction + symlink). */
async function realpathTargetsEqual(left: string, right: string): Promise<boolean> {
  try {
    return (await realpath(left)) === (await realpath(right))
  } catch {
    return path.resolve(left) === path.resolve(right)
  }
}

/**
 * Idempotency gate for a single agent skill entry: the entry is "up to date"
 * when it resolves to the library source (symlink/junction) or its content is
 * identical to the library (copy strategy or an unmodified materialized copy).
 */
export async function linkContentUpToDate(source: string, destination: string): Promise<boolean> {
  if (await realpathTargetsEqual(source, destination)) {
    return true
  }
  try {
    const sourceHash = await computeSkillIntegrity(source)
    const destinationHash = await computeSkillIntegrity(destination)
    return sourceHash === destinationHash
  } catch {
    return false
  }
}

/**
 * M7.4-safe link reconciliation for a single (agent, alias) pair.
 *
 * - existing entry owned by someone else → `blocked`, left untouched
 * - existing Skillbox-owned entry already current → `existing` (no change)
 * - existing Skillbox-owned entry with different content → `kept_modified`
 *   (never silently overwrite a managed local modification)
 * - otherwise create the link and record the Ownership Marker.
 */
export async function linkSkillToAgent(input: LinkSkillInput): Promise<LinkSkillResult> {
  const filesystem = input.filesystem ?? new FilesystemService()
  const strategy = resolveLinkStrategy(input.strategy, input.platform)
  const dirs = await input.adapter.getSkillDirectories()
  const dir = dirs[0]
  if (dir === undefined) {
    return { action: 'no_dir', changed: false, strategy }
  }
  await filesystem.mkdir(dir)
  const destination = path.join(dir, input.alias)
  const source = path.resolve(input.source)

  if (await filesystem.exists(destination)) {
    const owned = await input.ownership.isSkillboxOwned(destination)
    if (!owned) {
      return { action: 'blocked', path: destination, changed: false, strategy }
    }
    if (await linkContentUpToDate(source, destination)) {
      await input.links.set(input.agentId, input.alias, {
        strategy,
        source,
        target: destination,
      })
      return { action: 'existing', path: destination, changed: false, strategy }
    }
    return { action: 'kept_modified', path: destination, changed: false, strategy }
  }

  await input.adapter.linkSkill(source, { name: input.alias, strategy: input.strategy })
  await input.links.set(input.agentId, input.alias, {
    strategy,
    source,
    target: destination,
  })
  return { action: 'created', path: destination, changed: true, strategy }
}

export type StaleLinkAction = 'removed' | 'kept_external' | 'not_found'

export interface StaleLinkInput {
  /** Absolute path of the recorded target entry in the agent skills dir. */
  target: string
  /** Absolute path of the recorded library source. */
  source: string
  filesystem?: FilesystemService
}

/**
 * Removes one stale Skillbox-owned link. When the recorded target and source
 * still match, the entry is removed (it is a managed link); otherwise the
 * entry is treated as external/superseded and preserved.
 */
export async function removeStaleSkillLink(input: StaleLinkInput): Promise<StaleLinkAction> {
  const filesystem = input.filesystem ?? new FilesystemService()
  if (!(await filesystem.exists(input.target))) {
    return 'not_found'
  }
  if (await linkContentUpToDate(input.source, input.target)) {
    await filesystem.remove(input.target)
    return 'removed'
  }
  return 'kept_external'
}
