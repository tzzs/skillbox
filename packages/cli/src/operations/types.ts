/**
 * CLI contract for a retained OperationRuntime backup rollback.  This stays
 * deliberately small: Core owns backup selection, validation, and restore.
 */
export interface RollbackOperationInput {
  repositoryRoot: string
  homeRoot: string
  /** Omit to let Core select the most recent eligible operation. */
  operationId?: string
}

export interface RollbackOperationResult {
  operationId: string
  /** Number of snapshot targets restored, when reported by Core. */
  restoredTargets?: number
}

/** Injectable boundary over Core's user-level operation rollback API. */
export interface RollbackProvider {
  rollbackOperation(input: RollbackOperationInput): Promise<RollbackOperationResult>
}
