import { describe, expect, it, vi } from 'vitest'
import { ProviderRegistry, defaultRegistry, registerProvider, resolveProvider } from './registry.js'
import type { RegistryProvider } from './types.js'

function stubProvider(id: string): RegistryProvider {
  return {
    id,
    search: vi.fn(async () => []),
    resolve: vi.fn(async (source) => ({ source, revision: 'rev' })),
    download: vi.fn(async () => undefined),
    getLatestRevision: vi.fn(async () => 'rev'),
  }
}

describe('ProviderRegistry', () => {
  it('resolves providers by source type after registration', () => {
    const registry = new ProviderRegistry()
    const github = stubProvider('github')
    const local = stubProvider('local')
    registry.registerProvider(github)
    registry.registerProvider(local)

    expect(registry.resolveProvider('github')).toBe(github)
    expect(registry.resolveProvider('local')).toBe(local)
    expect(registry.hasProvider('github')).toBe(true)
    expect(registry.hasProvider('skills-sh')).toBe(false)
    expect(registry.listProviders()).toEqual([github, local])
  })

  it('re-registering the same id replaces the provider', () => {
    const registry = new ProviderRegistry()
    registry.registerProvider(stubProvider('github'))
    const replacement = stubProvider('github')
    registry.registerProvider(replacement)
    expect(registry.resolveProvider('github')).toBe(replacement)
    expect(registry.listProviders()).toHaveLength(1)
  })

  it('throws SOURCE_UNSUPPORTED for unknown source types', () => {
    const registry = new ProviderRegistry()
    registry.registerProvider(stubProvider('github'))
    let caught: unknown
    try {
      registry.resolveProvider('gitlab')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ name: 'RegistryError', code: 'SOURCE_UNSUPPORTED' })
    expect(caught).toMatchObject({ context: { sourceType: 'gitlab' } })
  })

  it('exposes registerProvider/resolveProvider over the default registry', () => {
    const provider = stubProvider('github')
    registerProvider(provider)
    expect(resolveProvider('github')).toBe(provider)
    expect(defaultRegistry.hasProvider('github')).toBe(true)
  })
})
