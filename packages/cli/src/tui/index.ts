import type { CliContext } from '../program.js'
import {
  createTuiService,
  NativeTuiTerminal,
  TuiSession,
  type TuiService,
  type TuiTerminal,
} from './session.js'

export { createTuiService, NativeTuiTerminal, TuiSession } from './session.js'
export type { TuiService, TuiTerminal } from './session.js'

export interface RunFullscreenTuiOptions {
  terminal?: TuiTerminal
  service?: TuiService
}

/** Starts the keyboard-first alternate-screen TUI, or gives a useful non-TTY error. */
export async function runFullscreenTui(
  ctx: CliContext,
  options: RunFullscreenTuiOptions = {},
): Promise<void> {
  const terminal = options.terminal ?? new NativeTuiTerminal()
  if (!terminal.isInteractive())
    throw new Error('fullscreen TUI needs an interactive terminal (TTY)')
  await new TuiSession({ terminal, service: options.service ?? createTuiService(ctx) }).run()
}
