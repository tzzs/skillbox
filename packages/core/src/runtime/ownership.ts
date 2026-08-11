import { ManagedRootOwnershipResolver, type AgentOwnershipResolver } from '../agent/adapter.js'
import { RuntimeLinkState, hasRecordedTarget } from './links.js'

export interface RuntimeOwnershipResolverOptions {
  /** The runtime library root; links resolving into it are owned. */
  managedRoot?: string | null
  /** `state/links.json` state; recorded targets are owned as well. */
  links?: RuntimeLinkState | null
}

/**
 * Ownership resolution used by the Runtime layer (M7). A skill entry is
 * Skillbox-owned when it either resolves (symlink *or* junction, via
 * `realpath`) into the managed library root, or when its target path is
 * recorded in `state/links.json`. The second clause covers the `copy` link
 * strategy and keeps the Ownership Marker (SKILLBOX_SPEC.md §132) authoritative
 * even when the realpath does not leave the agent skills directory.
 */
export class RuntimeOwnershipResolver implements AgentOwnershipResolver {
  private readonly linker: ManagedRootOwnershipResolver
  private readonly links: RuntimeLinkState | null

  constructor(options: RuntimeOwnershipResolverOptions = {}) {
    this.linker = new ManagedRootOwnershipResolver(options.managedRoot ?? null)
    this.links = options.links ?? null
  }

  async isSkillboxOwned(skillPath: string): Promise<boolean> {
    if (await this.linker.isSkillboxOwned(skillPath)) {
      return true
    }
    if (this.links === null) {
      return false
    }
    const database = await this.links.load()
    return hasRecordedTarget(database, skillPath)
  }
}
