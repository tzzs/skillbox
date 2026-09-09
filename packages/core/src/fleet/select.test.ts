import { describe, expect, it } from 'vitest'
import { parseAdHocHost, selectHosts } from './select.js'
import { ErrorCode, isSkillboxError, SkillboxError } from '../errors.js'
import type { FleetHostConfig } from './types.js'

function expectSkillboxError(fn: () => unknown, code: string): void {
  expect(fn).toThrowError(SkillboxError)
  try {
    fn()
    expect.fail('expected to throw')
  } catch (error) {
    expect(isSkillboxError(error) && error.code).toBe(code)
  }
}

const hosts: FleetHostConfig[] = [
  { name: 'web-1', host: '10.0.0.11', tags: ['prod', 'web'] },
  { name: 'web-2', host: '10.0.0.12', tags: ['prod', 'web'] },
  { name: 'db-1', host: '10.0.0.21', tags: ['prod', 'db'] },
  { name: 'staging-1', host: '10.0.0.31', tags: ['staging'] },
]

describe('selectHosts', () => {
  it('returns every configured host for an empty selector', () => {
    expect(selectHosts({ hosts })).toHaveLength(4)
  })

  it('selects by name', () => {
    const result = selectHosts({ hosts }, { hostNames: ['web-1', 'db-1'] })
    expect(result.map((host) => host.name)).toEqual(['web-1', 'db-1'])
  })

  it('throws FLEET_HOST_NOT_FOUND for an unknown name', () => {
    expectSkillboxError(
      () => selectHosts({ hosts }, { hostNames: ['ghost'] }),
      ErrorCode.FLEET_HOST_NOT_FOUND,
    )
  })

  it('selects by tag, deduplicating hosts matched by multiple tags', () => {
    const result = selectHosts({ hosts }, { tags: ['web', 'db'] })
    expect(result.map((host) => host.name).sort()).toEqual(['db-1', 'web-1', 'web-2'])
  })

  it('unions name and tag selection', () => {
    const result = selectHosts({ hosts }, { hostNames: ['staging-1'], tags: ['db'] })
    expect(result.map((host) => host.name).sort()).toEqual(['db-1', 'staging-1'])
  })

  it('appends ad-hoc hosts without pulling in the rest of the config', () => {
    const adHoc = [{ name: 'adhoc@1.2.3.4', host: '1.2.3.4' }]
    const result = selectHosts({ hosts }, { adHoc })
    expect(result).toEqual(adHoc)
  })

  it('combines a name selection with ad-hoc hosts', () => {
    const adHoc = [{ name: 'adhoc@1.2.3.4', host: '1.2.3.4' }]
    const result = selectHosts({ hosts }, { hostNames: ['web-1'], adHoc })
    expect(result.map((host) => host.name)).toEqual(['web-1', 'adhoc@1.2.3.4'])
  })
})

describe('parseAdHocHost', () => {
  it('parses a bare host', () => {
    expect(parseAdHocHost('10.0.0.5')).toEqual({ name: '10.0.0.5', host: '10.0.0.5' })
  })

  it('parses user@host', () => {
    expect(parseAdHocHost('deploy@10.0.0.5')).toEqual({
      name: 'deploy@10.0.0.5',
      host: '10.0.0.5',
      user: 'deploy',
    })
  })

  it('parses user@host:port', () => {
    expect(parseAdHocHost('deploy@10.0.0.5:2222')).toEqual({
      name: 'deploy@10.0.0.5:2222',
      host: '10.0.0.5',
      user: 'deploy',
      port: 2222,
    })
  })

  it('rejects an empty spec', () => {
    expect(() => parseAdHocHost('')).toThrowError()
  })
})
