import { createOperationRuntime } from './runtime.js'
import type { IncompleteOperation, OperationRecoveryResult } from './runtime.js'

export {
  RECOVERY_COMMAND,
  createOperationRuntime,
  rollbackOperation,
  type IncompleteOperation,
  type OperationRecoveryResult,
  type OperationRuntimeOptions,
  type RollbackOperationOptions,
  type RollbackOperationResult,
} from './runtime.js'

/**
 * Public surface for the crash state `OperationRuntime` leaves behind.
 *
 * There is deliberately no automatic heal: a journal record carries no
 * heartbeat, so nothing can tell a process that died mid-mutation from one that
 * is still writing, and unlocking on a timer would let a second mutation race
 * the first. Instead the state is reported (`listIncompleteOperations`) and a
 * human picks one of exactly two endings: keep the interrupted operation's
 * files (`abandonOperation`) or put them back (`rollbackOperation`).
 */
export interface OperationRecoveryOptions {
  repositoryRoot: string
  homeRoot?: string
}

/** Options for a recovery choice, which always names one operation. */
export interface RecoverOperationOptions extends OperationRecoveryOptions {
  operationId: string
}

/** Lists the operations that never reached a terminal journal status. */
export async function listIncompleteOperations(
  options: OperationRecoveryOptions,
): Promise<IncompleteOperation[]> {
  return createOperationRuntime(options).listIncomplete()
}

/**
 * Closes an unfinished record as `abandoned` so mutations can run again.
 * No user file is read or written: the interrupted operation keeps whatever it
 * had already changed.
 */
export async function abandonOperation(
  options: RecoverOperationOptions & { reason?: string },
): Promise<OperationRecoveryResult> {
  const { operationId, reason, ...runtime } = options
  return createOperationRuntime(runtime).abandon(operationId, reason)
}
