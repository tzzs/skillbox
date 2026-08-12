import type { DebugBundleInput, DebugBundleProvider, DebugBundleResult } from './types.js'

export type CoreDebugBundleLoader = () => Promise<Record<string, unknown>>

async function loadSkillboxCore(): Promise<Record<string, unknown>> {
  try {
    return (await import('@skillbox/core')) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

class CoreDebugBundleProvider implements DebugBundleProvider {
  private modulePromise?: Promise<Record<string, unknown>>

  constructor(private readonly loadCore: CoreDebugBundleLoader) {}

  async create(input: DebugBundleInput): Promise<DebugBundleResult> {
    this.modulePromise ??= this.loadCore()
    const createDebugBundle = (await this.modulePromise).createDebugBundle as
      ((input: DebugBundleInput) => Promise<DebugBundleResult>) | undefined
    if (typeof createDebugBundle !== 'function') {
      throw new Error(
        'Debug bundle support is not available in this build yet. Update Skillbox and try again.',
      )
    }
    return createDebugBundle(input)
  }
}

/** Creates the production adapter over Core's redacted debug-bundle writer. */
export function createDefaultDebugBundleProvider(
  loadCore: CoreDebugBundleLoader = loadSkillboxCore,
): DebugBundleProvider {
  return new CoreDebugBundleProvider(loadCore)
}
