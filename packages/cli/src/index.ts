import { CommanderError } from 'commander'
import { isSkillboxError, SkillboxFsError } from '@skillbox/core'
import { buildContext, buildProgram, type CliDeps } from './program.js'
import { ExitCode, exitCodeForError } from './exit-codes.js'

export * from './exit-codes.js'
export { buildContext, buildProgram } from './program.js'
export type { CliContext, CliDeps } from './program.js'

/**
 * Runs the CLI. Returns the process exit code:
 * 0 success / 1 generic / 2 validation / 3 conflict / 4 security.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  deps: CliDeps = {},
): Promise<number> {
  const ctx = buildContext(deps)
  const program = buildProgram(ctx)

  try {
    await program.parseAsync(argv, { from: 'user' })
    return ExitCode.SUCCESS
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode
    }
    if (isSkillboxError(error) || error instanceof SkillboxFsError) {
      ctx.err(`skillbox: ${error.message}\n`)
      return exitCodeForError(error)
    }
    if (error instanceof Error) {
      ctx.err(`skillbox: ${error.message}\n`)
      return ExitCode.GENERIC
    }
    ctx.err(`skillbox: ${String(error)}\n`)
    return ExitCode.GENERIC
  }
}
