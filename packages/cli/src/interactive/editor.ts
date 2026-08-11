export interface OpenCommand {
  command: string
  args: string[]
}

/**
 * Resolves the editor command from `EDITOR` / `VISUAL`. Returns `null` when no
 * editor is configured, so the caller falls back to a plain hint.
 */
export function resolveEditorCommand(filePath: string, env: NodeJS.ProcessEnv): OpenCommand | null {
  const raw = env.EDITOR ?? env.VISUAL
  if (raw === undefined || raw.trim().length === 0) {
    return null
  }
  const parts = raw
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
  const command = parts[0]
  if (command === undefined) {
    return null
  }
  return { command, args: [...parts.slice(1), filePath] }
}
