import type { CliContext } from '../program.js'
import { ExitCode } from '../exit-codes.js'
import { InteractiveSession } from './session.js'
import type { InteractivePrompt } from './prompts.js'
import { createClackPrompts, isInteractiveTTY } from './prompts.js'

export { createClackPrompts, isInteractiveTTY } from './prompts.js'
export type { InteractivePrompt, PromptOption } from './prompts.js'
export { InteractiveSession } from './session.js'

export interface RunInteractiveOptions {
  /** Prompt implementation; defaults to the real `@clack/prompts`. */
  prompts?: InteractivePrompt
  /** Override the interactive-terminal check (used by tests). */
  isInteractive?: boolean
}

/**
 * The M9 entry point. When the terminal is not interactive (CI, piped output)
 * it refuses to run instead of crashing, printing a clear hand-off to the
 * non-interactive command surface.
 */
export async function runInteractive(
  ctx: CliContext,
  options: RunInteractiveOptions = {},
): Promise<number> {
  const interactive = options.isInteractive ?? isInteractiveTTY()
  if (!interactive) {
    ctx.err('skillbox: interactive mode needs an interactive terminal (TTY).\n')
    ctx.err('Use the non-interactive commands instead, e.g.: skillbox --help\n')
    return ExitCode.GENERIC
  }

  const prompts = options.prompts ?? createClackPrompts()
  try {
    await new InteractiveSession({ ctx, prompts }).run()
    return ExitCode.SUCCESS
  } catch (error) {
    ctx.err(
      error instanceof Error ? `skillbox: ${error.message}\n` : `skillbox: ${String(error)}\n`,
    )
    return ExitCode.GENERIC
  }
}
