import type { DiagnosticsInput, DiagnosticsProvider } from './types.js'

/** Loads Core defensively so a stale CLI build has a useful command failure. */
export type CoreDiagnosticsLoader = () => Promise<Record<string, unknown>>

async function loadSkillboxCore(): Promise<Record<string, unknown>> {
  try {
    return (await import('@skillbox/core')) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

class CoreDiagnosticsProvider implements DiagnosticsProvider {
  private modulePromise?: Promise<Record<string, unknown>>

  constructor(private readonly loadCore: CoreDiagnosticsLoader) {}

  async collect(input: DiagnosticsInput) {
    this.modulePromise ??= this.loadCore()
    const core = await this.modulePromise
    const collectDiagnostics = core.collectDiagnostics as
      ((options: DiagnosticsInput) => Promise<unknown>) | undefined
    if (typeof collectDiagnostics !== 'function') {
      throw new Error(
        'Environment diagnostics are not available in this build yet. Update Skillbox and try again.',
      )
    }
    return (await collectDiagnostics(input)) as Awaited<ReturnType<DiagnosticsProvider['collect']>>
  }
}

/** Creates the production adapter over Core's diagnostic collector. */
export function createDefaultDiagnosticsProvider(
  loadCore: CoreDiagnosticsLoader = loadSkillboxCore,
): DiagnosticsProvider {
  return new CoreDiagnosticsProvider(loadCore)
}
