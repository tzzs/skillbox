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
import { RepositorySyncService } from './repository-sync.js'
import type { RepositorySyncEvent } from './types.js'

export interface CreateRepositorySyncOptions {
  repositoryRoot: string
  homeRoot: string
  clientId?: string
  credentialStore?: CredentialStore
  onEvent?: (event: RepositorySyncEvent) => void
  /** GitHub API base (defaults to `SKILLBOX_GITHUB_API_BASE` / api.github.com). */
  apiBaseUrl?: string
  /** GitHub login base for the device flow (defaults to `SKILLBOX_GITHUB_LOGIN_BASE` / github.com). */
  loginBaseUrl?: string
}

/** Constructs the production repository-sync dependency graph. */
export function createRepositorySync(options: CreateRepositorySyncOptions): RepositorySyncService {
  const clientId = options.clientId ?? process.env.SKILLBOX_GITHUB_CLIENT_ID ?? ''
  const api = new GitHubApi({
    clientId,
    ...(options.apiBaseUrl !== undefined
      ? { apiBaseUrl: options.apiBaseUrl }
      : process.env.SKILLBOX_GITHUB_API_BASE !== undefined
        ? { apiBaseUrl: process.env.SKILLBOX_GITHUB_API_BASE }
        : {}),
    ...(options.loginBaseUrl !== undefined
      ? { loginBaseUrl: options.loginBaseUrl }
      : process.env.SKILLBOX_GITHUB_LOGIN_BASE !== undefined
        ? { loginBaseUrl: process.env.SKILLBOX_GITHUB_LOGIN_BASE }
        : {}),
  })
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
    git: new GitClient(),
    host,
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
  })
}
