import { describe, expect, it } from 'vitest'
import { collect, runOptionsFromOptions, selectorFromOptions } from './options.js'

describe('collect', () => {
  it('accumulates repeated flag values in order', () => {
    let acc = collect('a', [])
    acc = collect('b', acc)
    expect(acc).toEqual(['a', 'b'])
  })
})

describe('selectorFromOptions', () => {
  it('is empty when no selection flags were passed', () => {
    expect(selectorFromOptions({})).toEqual({})
  })

  it('carries host names and tags through untouched', () => {
    expect(selectorFromOptions({ host: ['web-1'], tag: ['prod'] })).toEqual({
      hostNames: ['web-1'],
      tags: ['prod'],
    })
  })

  it('drops empty arrays instead of producing empty selector fields', () => {
    expect(selectorFromOptions({ host: [], tag: [], ssh: [] })).toEqual({})
  })

  it('parses --ssh specs into ad-hoc host configs', () => {
    expect(selectorFromOptions({ ssh: ['deploy@10.0.0.5:2222'] })).toEqual({
      adHoc: [{ name: 'deploy@10.0.0.5:2222', host: '10.0.0.5', user: 'deploy', port: 2222 }],
    })
  })
})

describe('runOptionsFromOptions', () => {
  it('is empty with no flags', () => {
    expect(runOptionsFromOptions({})).toEqual({})
  })

  it('parses a valid --concurrency', () => {
    expect(runOptionsFromOptions({ concurrency: '8' })).toEqual({ concurrency: 8 })
  })

  it('ignores a non-numeric or non-positive --concurrency', () => {
    expect(runOptionsFromOptions({ concurrency: 'nope' })).toEqual({})
    expect(runOptionsFromOptions({ concurrency: '0' })).toEqual({})
    expect(runOptionsFromOptions({ concurrency: '-1' })).toEqual({})
  })

  it('carries --dry-run through', () => {
    expect(runOptionsFromOptions({ dryRun: true })).toEqual({ dryRun: true })
  })
})
