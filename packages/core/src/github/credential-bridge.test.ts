import { describe, expect, it } from 'vitest'
import {
  GIT_AUTH_TOKEN_ENV,
  GIT_AUTH_USERNAME,
  GIT_TERMINAL_PROMPT_ENV,
  buildGitAuthEnvironment,
  describeGitAuthEnvironment,
} from './credential-bridge.js'
import { REDACTED } from '../logging/redact.js'

const TOKEN = 'ghu_super_secret_access_token'

describe('buildGitAuthEnvironment', () => {
  it('produces a process-scoped credential helper and env overrides', () => {
    const env = buildGitAuthEnvironment(TOKEN)
    expect(env.prefixArgs.slice(0, 2)).toEqual(['-c', 'credential.helper='])
    expect(env.prefixArgs[2]).toBe('-c')
    expect(env.prefixArgs[3]).toBe(
      `credential.helper=!f() { echo username=${GIT_AUTH_USERNAME}; echo password=\$${GIT_AUTH_TOKEN_ENV}; }; f`,
    )
    expect(env.prefixArgs.slice(-2)).toEqual(['-c', 'core.hooksPath=/dev/null'])
    expect(env.env).toEqual({
      [GIT_AUTH_TOKEN_ENV]: TOKEN,
      [GIT_TERMINAL_PROMPT_ENV]: '0',
    })
  })

  it('never places the token in the argument list', () => {
    const env = buildGitAuthEnvironment(TOKEN)
    expect(env.prefixArgs.join(' ')).not.toContain(TOKEN)
    expect(env.prefixArgs.join(' ')).not.toContain('ghu_')
    expect(env.sensitiveEnvKeys).toEqual([GIT_AUTH_TOKEN_ENV])
  })

  it('disables interactive prompts so broken credentials fail loudly', () => {
    const env = buildGitAuthEnvironment(TOKEN)
    expect(env.env[GIT_TERMINAL_PROMPT_ENV]).toBe('0')
  })
})

describe('describeGitAuthEnvironment', () => {
  it('redacts the token value but keeps the shape', () => {
    const env = buildGitAuthEnvironment(TOKEN)
    const rendered = describeGitAuthEnvironment(env)
    expect(rendered).toContain(REDACTED)
    expect(rendered).not.toContain(TOKEN)
    expect(rendered).not.toContain('ghu_')
    const parsed = JSON.parse(rendered) as { env: Record<string, string>; prefixArgs: string[] }
    expect(parsed.env[GIT_AUTH_TOKEN_ENV]).toBe(REDACTED)
    expect(parsed.env[GIT_TERMINAL_PROMPT_ENV]).toBe('0')
    // The helper shell fragment stays visible for debugging.
    expect(parsed.prefixArgs.join(' ')).toContain(`username=${GIT_AUTH_USERNAME}`)
  })
})
