import { RegistryError, RegistryErrorCode } from './errors.js'
import type { RegistryProvider } from './types.js'

/**
 * Registry provider registry (MVP M14.2): maps a `source.type`
 * (`github` | `skills-sh` | `local`) to the provider that handles it.
 *
 * Providers are stateless service instances; re-registering the same id
 * replaces the previous entry (idempotent).
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, RegistryProvider>()

  /** Registers (or replaces) the provider for `provider.id`. */
  registerProvider(provider: RegistryProvider): void {
    this.providers.set(provider.id, provider)
  }

  /** Returns the provider for `sourceType` or throws `SOURCE_UNSUPPORTED`. */
  resolveProvider(sourceType: string): RegistryProvider {
    const provider = this.providers.get(sourceType)
    if (provider === undefined) {
      throw new RegistryError(
        RegistryErrorCode.SOURCE_UNSUPPORTED,
        `No registry provider registered for source type "${sourceType}"`,
        { reason: 'source', context: { sourceType } },
      )
    }
    return provider
  }

  /** True when a provider is registered for `sourceType`. */
  hasProvider(sourceType: string): boolean {
    return this.providers.has(sourceType)
  }

  /** All registered providers (insertion order). */
  listProviders(): RegistryProvider[] {
    return [...this.providers.values()]
  }
}

/** Process-wide default registry. */
export const defaultRegistry = new ProviderRegistry()

/** Convenience wrapper over {@link defaultRegistry}. */
export function registerProvider(provider: RegistryProvider): void {
  defaultRegistry.registerProvider(provider)
}

/** Convenience wrapper over {@link defaultRegistry}. */
export function resolveProvider(sourceType: string): RegistryProvider {
  return defaultRegistry.resolveProvider(sourceType)
}
