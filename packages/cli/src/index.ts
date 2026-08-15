import { CommanderError } from 'commander'
import {
  defaultEventBus,
  defaultLogFilePath,
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

  const logger = new Logger({
    verbosity,
    emit: (chunk) => ctx.err(chunk),
    logFile: defaultLogFilePath(ctx.homeRoot),
  })
  if (verbosity !== 'normal') {
    logger.verbose('skillbox CLI starting')
    logger.debug('resolved arguments', { args })
  }
  // Core flows (install/update/reconcile) emit lifecycle events onto the
  // default bus; mirror them into the audit log (phases at debug, outcomes
  // at info/warn) so ~/.skillbox/logs/skillbox.log carries the timeline.
  const subscription = defaultEventBus.on((event) => {
    switch (event.type) {
      case 'install:phase':
        logger.debug('install:phase', { phase: event.phase, alias: event.alias })
        return
      case 'install:completed':
        logger.info('install:completed', { alias: event.alias, revision: event.revision })
        return
      case 'install:failed':
        logger.warn('install:failed', { alias: event.alias, error: event.error })
        return
      case 'reconcile:started':
        logger.debug('reconcile:started')
        return
      case 'reconcile:completed':
        logger.info('reconcile:completed', {
          changed: event.changed,
          skills: event.skills,
          problems: event.problems,
        })
        return
    }
  })

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
  } finally {
    subscription.unsubscribe()
  }
}
