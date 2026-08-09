import { RuntimeConfigService } from '../runtime/config.js'
import type { RuntimeConfig } from '../runtime/config.js'

/** `github` block persisted in config.json (SPEC §125.1). Never holds tokens. */
export interface GitHubConnectionMetadata {
  connected: boolean
  login?: string
  provider?: string
  repository?: string
}

type GitHubConfigValue = NonNullable<RuntimeConfig['github']>

function buildGh(value: GitHubConnectionMetadata): GitHubConfigValue {
  const gh: GitHubConfigValue = { connected: value.connected }
  if (value.login !== undefined) {
    gh.login = value.login
  }
  if (value.provider !== undefined) {
    gh.provider = value.provider
  }
  if (value.repository !== undefined) {
    gh.repository = value.repository
  }
  return gh
}

/**
 * Read/write access to the machine-local `github` connection metadata inside
 * `config.json` (via `RuntimeConfigService`). Only non-sensitive fields live
 * here; tokens go exclusively to the OS Credential Store.
 */
export class GitHubConfigStore {
  private readonly config: RuntimeConfigService

  constructor(config: RuntimeConfigService) {
    this.config = config
  }

  /** Reads the persisted connection metadata (empty/not-connected by default). */
  async read(): Promise<GitHubConnectionMetadata> {
    const runtime = await this.config.load()
    const gh = runtime.github
    const meta: GitHubConnectionMetadata = { connected: gh?.connected ?? false }
    if (gh?.login !== undefined) {
      meta.login = gh.login
    }
    if (gh?.provider !== undefined) {
      meta.provider = gh.provider
    }
    if (gh?.repository !== undefined) {
      meta.repository = gh.repository
    }
    return meta
  }

  /** Persists the connected-account metadata. */
  async writeConnected(input: {
    login: string
    provider: string
    repository?: string
  }): Promise<void> {
    const runtime = await this.config.load()
    await this.config.save({
      ...runtime,
      github: {
        connected: true,
        login: input.login,
        provider: input.provider,
        ...(input.repository !== undefined ? { repository: input.repository } : {}),
      },
    })
  }

  /** Drops only the bound repository, keeping the connected account. */
  async clearRepository(): Promise<void> {
    const runtime = await this.config.load()
    if (runtime.github === undefined) {
      return
    }
    const meta: GitHubConnectionMetadata = { connected: runtime.github.connected ?? true }
    if (runtime.github.login !== undefined) {
      meta.login = runtime.github.login
    }
    if (runtime.github.provider !== undefined) {
      meta.provider = runtime.github.provider
    }
    await this.config.save({ ...runtime, github: buildGh(meta) })
  }

  /** Clears all GitHub connection metadata (disconnect). */
  async clear(): Promise<void> {
    const runtime = await this.config.load()
    const next = { ...runtime }
    delete next.github
    await this.config.save(next)
  }
}
