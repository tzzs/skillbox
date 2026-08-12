import { CommanderError } from 'commander'
import {
  Logger,
  isSkillboxError,
  setGlobalVerbosity,
  type Verbosity,
  SkillboxFsError,
} from '@skillbox/core'
import { buildContext, buildProgram, type CliDeps } from './program.js'
import { ExitCode, exitCodeForError } from './exit-codes.js'
import type { RunInteractiveOptions } from './interactive/index.js'
import { runInteractive } from './interactive/index.js'

export * from './exit-codes.js'
export { buildContext, buildProgram } from './program.js'
export type { CliContext, CliDeps } from './program.js'
export { runInteractive, isInteractiveTTY } from './interactive/index.js'
export { InteractiveSession } from './interactive/session.js'
export type { InteractivePrompt } from './interactive/prompts.js'
export { runFullscreenTui, NativeTuiTerminal, TuiSession } from './tui/index.js'
export type { TuiService, TuiTerminal } from './tui/index.js'

/**
 * Splits `--verbose` / `--debug` (and their `=true` forms) out of the argv.
 * Commander never sees them, so they stay valid global flags regardless of
 * where they appear, while the remaining tokens are forwarded untouched.
 * Tokens after a literal `--` are treated as operator and kept verbatim.
 */
export function splitVerbosityFlags(argv: readonly string[]): {
  args: string[]
  verbosity: Verbosity
} {
  const args: string[] = []
  let verbosity: Verbosity = 'normal'
  let afterSeparator = false
  for (const token of argv) {
    if (afterSeparator) {
      args.push(token)
      continue
    }
    if (token === '--') {
      afterSeparator = true
      args.push(token)
      continue
    }
    if (token === '--debug' || token === '--debug=true') {
      verbosity = 'debug'
      continue
    }
    if (token === '--verbose' || token === '--verbose=true') {
      if (verbosity !== 'debug') {
        verbosity = 'verbose'
      }
      continue
    }
    args.push(token)
  }
  return { args, verbosity }
}

/**
 * Runs the CLI. Returns the process exit code:
 * 0 success / 1 generic / 2 validation / 3 conflict / 4 security.
 *
 * Invoked with no arguments it opens the M9 interactive menu instead of the
 * one-shot commands. `--verbose` / `--debug` raise the global Logger level so
 * debug detail is streamed to stderr without touching the normal stdout.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  deps: CliDeps = {},
): Promise<number> {
  const { args, verbosity } = splitVerbosityFlags(argv)
  setGlobalVerbosity(verbosity)
  const ctx = buildContext(deps)

  if (verbosity !== 'normal') {
    const logger = new Logger({ verbosity, emit: (chunk) => ctx.err(chunk) })
    logger.verbose('skillbox CLI starting')
    logger.debug('resolved arguments', { args })
  }

  if (args.length === 0) {
    const interactiveOptions: RunInteractiveOptions = {}
    if (deps.prompts !== undefined) {
      interactiveOptions.prompts = deps.prompts
    }
    if (deps.isInteractive !== undefined) {
      interactiveOptions.isInteractive = deps.isInteractive
    }
    return runInteractive(ctx, interactiveOptions)
  }

  const program = buildProgram(ctx)

  try {
    await program.parseAsync(args, { from: 'user' })
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
