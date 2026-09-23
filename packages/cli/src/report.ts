import type { ReconcileProblem } from '@skillbox/core'

/**
 * Writes one detail line per reconcile problem (`  CODE alias: message`) to the
 * given sink; no alias means no name. Shared by the one-shot commands and the
 * interactive session, which both hold a reconcile result but only the commands
 * live in program.ts — importing it from there would close the
 * program.ts ↔ session.ts cycle.
 */
export function reportProblems(
  write: (chunk: string) => void,
  problems: readonly ReconcileProblem[],
): void {
  for (const problem of problems) {
    const alias = problem.alias === undefined ? '' : ` ${problem.alias}`
    write(`  ${problem.code}${alias}: ${problem.message}\n`)
  }
}
