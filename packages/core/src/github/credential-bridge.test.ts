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
    expect(env.args).toHaveLength(2)
    expect(env.args[0]).toBe('-c')
    expect(env.args[1]).toBe(
      `credential.helper=!f() { echo username=${GIT_AUTH_USERNAME}; echo password=\$${GIT_AUTH_TOKEN_ENV}; }; f`,
    )
    expect(env.env).toEqual({
      [GIT_AUTH_TOKEN_ENV]: TOKEN,
      [GIT_TERMINAL_PROMPT_ENV]: '0',
    })
  })

  it('never places the token in the argument list', () => {
    const env = buildGitAuthEnvironment(TOKEN)
    expect(env.args.join(' ')).not.toContain(TOKEN)
    expect(env.args.join(' ')).not.toContain('ghu_')
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
    const parsed = JSON.parse(rendered) as { env: Record<string, string>; args: string[] }
    expect(parsed.env[GIT_AUTH_TOKEN_ENV]).toBe(REDACTED)
    expect(parsed.env[GIT_TERMINAL_PROMPT_ENV]).toBe('0')
    // The helper shell fragment stays visible for debugging.
    expect(parsed.args.join(' ')).toContain(`username=${GIT_AUTH_USERNAME}`)
  })
})
