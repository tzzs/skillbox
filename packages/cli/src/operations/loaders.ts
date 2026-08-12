import { ErrorCode, SkillboxError } from '@skillbox/core'
import type { RollbackOperationInput, RollbackOperationResult, RollbackProvider } from './types.js'

/** Loads Core as an opaque map so an older build fails safely, not at import time. */
export type CoreOperationsLoader = () => Promise<Record<string, unknown>>

async function loadSkillboxCore(): Promise<Record<string, unknown>> {
  try {
    return (await import('@skillbox/core')) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function mapResult(raw: unknown, requestedOperationId?: string): RollbackOperationResult {
  const record = asRecord(raw)
  const operationId =
    typeof record?.operationId === 'string' ? record.operationId : requestedOperationId
  if (operationId === undefined || operationId.length === 0) {
    throw new SkillboxError(
      ErrorCode.OPERATION_ROLLBACK_INVALID,
      'Core rollback completed without an operation id.',
    )
  }
  return {
    operationId,
    ...(typeof record?.restoredTargets === 'number'
      ? { restoredTargets: record.restoredTargets }
      : Array.isArray(record?.restoredTargets)
        ? { restoredTargets: record.restoredTargets.length }
        : {}),
  }
}

class CoreRollbackProvider implements RollbackProvider {
  private modulePromise?: Promise<Record<string, unknown>>

  constructor(private readonly loadCore: CoreOperationsLoader) {}

  async rollbackOperation(input: RollbackOperationInput): Promise<RollbackOperationResult> {
    this.modulePromise ??= this.loadCore()
    const core = await this.modulePromise
    const rollback = core.rollbackOperation as
      ((options: RollbackOperationInput) => unknown) | undefined
    if (typeof rollback !== 'function') {
      throw new SkillboxError(
        ErrorCode.OPERATION_RECOVERY_REQUIRED,
        'User-level rollback is not available in this build yet. Update Skillbox and try again.',
        { recoverable: true },
      )
    }
    return mapResult(await rollback(input), input.operationId)
  }
}

/** Creates the production adapter over the Core operation rollback export. */
export function createDefaultRollbackProvider(
  loadCore: CoreOperationsLoader = loadSkillboxCore,
): RollbackProvider {
  return new CoreRollbackProvider(loadCore)
}
