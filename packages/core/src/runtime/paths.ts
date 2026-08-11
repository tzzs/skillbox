import * as os from 'node:os'
import * as path from 'node:path'

/** Env var that overrides the Skillbox home root (`SKILLBOX_HOME`). */
export const SKILLBOX_HOME_ENV = 'SKILLBOX_HOME'

/** Directory name under the user home used by default: `~/.skillbox`. */
export const DEFAULT_SKILLBOX_DIR_NAME = '.skillbox'

/** Top-level directories created inside the Skillbox home (M6.1). */
export const HOME_DIRECTORY_NAMES = ['library', 'cache', 'state', 'tmp', 'logs'] as const

export type HomeDirectoryName = (typeof HOME_DIRECTORY_NAMES)[number]

/**
 * Resolves the Skillbox home root. Precedence:
 * 1. the `SKILLBOX_HOME` env var (so tests and embedded installs can point at a
 *    fixture directory),
 * 2. `$HOME/.skillbox`.
 */
export function resolveSkillboxHome(env: NodeJS.ProcessEnv = process.env): string {
  const envValue = env[SKILLBOX_HOME_ENV]
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return path.resolve(envValue.trim())
  }
  return path.join(os.homedir(), DEFAULT_SKILLBOX_DIR_NAME)
}

export interface SkillboxHomeLayout {
  root: string
  library: string
  cache: string
  state: string
  tmp: string
  logs: string
  /** `config.json` inside the home root (M6.2). */
  configFile: string
  /** `state/links.json` recording Skillbox-created Agent Links (M6.4). */
  linksFile: string
}

/** Derives every well-known runtime location from the Skillbox home root. */
export function buildSkillboxHomeLayout(root: string): SkillboxHomeLayout {
  const resolvedRoot = path.resolve(root)
  return {
    root: resolvedRoot,
    library: path.join(resolvedRoot, 'library'),
    cache: path.join(resolvedRoot, 'cache'),
    state: path.join(resolvedRoot, 'state'),
    tmp: path.join(resolvedRoot, 'tmp'),
    logs: path.join(resolvedRoot, 'logs'),
    configFile: path.join(resolvedRoot, 'config.json'),
    linksFile: path.join(resolvedRoot, 'state', 'links.json'),
  }
}
