import type { RollbackOperationResult } from './types.js'

export function renderRollbackSummary(result: RollbackOperationResult): string {
  const count = result.restoredTargets
  return `Rolled back operation "${result.operationId}"${
    count === undefined ? '.' : ` — restored ${count} target${count === 1 ? '' : 's'}.`
  }`
}
