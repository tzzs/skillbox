import * as path from 'node:path'
import { GitClient } from '../git/index.js'
import {
  GitHubApi,
  GitHubConfigStore,
  GitHubService,
  TokenStore,
  createCredentialStore,
  type CredentialStore,
} from '../github/index.js'
import { RuntimeConfigService } from '../runtime/index.js'
import { createDefaultAgentRegistry } from '../agent/index.js'
import { SkillService } from '../services/index.js'
import { RepositorySyncService } from './repository-sync.js'
import type { RepositorySyncEvent } from './types.js'

export interface CreateRepositorySyncOptions {
  repositoryRoot: string
  homeRoot: string
  clientId?: string
  credentialStore?: CredentialStore
  onEvent?: (event: RepositorySyncEvent) => void
}

/** Constructs the production repository-sync dependency graph. */
export function createRepositorySync(options: CreateRepositorySyncOptions): RepositorySyncService {
  const clientId = options.clientId ?? process.env.SKILLBOX_GITHUB_CLIENT_ID ?? ''
  const api = new GitHubApi({ clientId })
  const credentialStore =
    options.credentialStore ??
    createCredentialStore({ secretsDir: path.join(options.homeRoot, 'state', 'secrets') })
  const host = new GitHubService({
    clientId,
    api,
    tokenStore: new TokenStore({ store: credentialStore }),
    configStore: new GitHubConfigStore(
      new RuntimeConfigService({ configFilePath: path.join(options.homeRoot, 'config.json') }),
    ),
  })
  return new RepositorySyncService({
    repositoryRoot: options.repositoryRoot,
    homeRoot: options.homeRoot,
    git: new GitClient(),
    host,
    reconcile: async () => {
      await new SkillService({
        repositoryRoot: options.repositoryRoot,
        homeRoot: options.homeRoot,
        registry: createDefaultAgentRegistry(),
      }).install()
    },
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  })
}
