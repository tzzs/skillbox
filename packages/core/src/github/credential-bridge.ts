import { REDACTED } from '../logging/redact.js'
import type { GitTransportAuth } from '../git/index.js'

/**
 * HTTPS Credential Bridge (SPEC §125.4, MVP_TASKS §111G, ARCHITECTURE §40/§15.3).
 *
 * Provides the System Git subprocess with the GitHub App token *only for the
 * duration of a single invocation*. The token:
 *
 * - never lands in a remote URL,
 * - never lands in `.git/config` or any persisted credential file,
 * - never lands in argv / process title (it is injected via environment),
 * - never lands in logs (see `describeGitAuthEnvironment`).
 *
 * Mechanism: an inline credential helper passed with `git -c` — process-scoped
 * config that expires with the process — whose shell fragment echoes the token
 * read from an environment variable. No temporary script is written to disk,
 * so there is nothing to clean up afterwards beyond the environment itself.
 *
 * Git's credential protocol expects `username=` / `password=` lines on stdout.
 * GitHub accepts `x-access-token` as the username paired with any OAuth token.
 */
export const GIT_AUTH_TOKEN_ENV = 'SKILLBOX_GITHUB_ACCESS_TOKEN'
export const GIT_AUTH_USERNAME = 'x-access-token'
/** Disable interactive credential prompts so a broken token fails loudly. */
export const GIT_TERMINAL_PROMPT_ENV = 'GIT_TERMINAL_PROMPT'

export type GitAuthEnvironment = GitTransportAuth

/** Builds the transient, process-level auth environment for a System Git run. */
export function buildGitAuthEnvironment(token: string): GitAuthEnvironment {
  // `!f() { ... }; f` runs the helper body; `$SKILLBOX_GITHUB_ACCESS_TOKEN`
  // is expanded by the helper's shell from the child environment.
  const helper = `!f() { echo username=${GIT_AUTH_USERNAME}; echo password=\$${GIT_AUTH_TOKEN_ENV}; }; f`
  return {
    prefixArgs: [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=${helper}`,
      '-c',
      'core.hooksPath=/dev/null',
    ],
    env: { [GIT_AUTH_TOKEN_ENV]: token, [GIT_TERMINAL_PROMPT_ENV]: '0' },
    sensitiveEnvKeys: [GIT_AUTH_TOKEN_ENV],
  }
}

/**
 * A log/diagnostic-safe rendering of the auth environment: argv and env shape
 * are shown, but the token value is always masked.
 */
export function describeGitAuthEnvironment(env: GitAuthEnvironment): string {
  return JSON.stringify({
    prefixArgs: env.prefixArgs,
    env: { [GIT_AUTH_TOKEN_ENV]: REDACTED, [GIT_TERMINAL_PROMPT_ENV]: '0' },
  })
}
