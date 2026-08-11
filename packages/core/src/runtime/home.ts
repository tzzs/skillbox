import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import {
  HOME_DIRECTORY_NAMES,
  buildSkillboxHomeLayout,
  resolveSkillboxHome,
  type HomeDirectoryName,
  type SkillboxHomeLayout,
} from './paths.js'

export const RUNTIME_CONFIG_FILE_NAME = 'config.json'

export interface SkillboxHomeOptions {
  /**
   * Explicit home root (recommended for tests). Falls back to `SKILLBOX_HOME`
   * and finally `~/.skillbox`.
   */
  root?: string
  env?: NodeJS.ProcessEnv
  filesystem?: FilesystemService
  configFileName?: string
}

/**
 * Skillbox Home (M6.1 / M6.2): owns the runtime directory layout and the
 * machine-specific `config.json`. Home creation is idempotent and never
 * touches user agent directories.
 */
export class SkillboxHome {
  private readonly env: NodeJS.ProcessEnv
  private readonly filesystem: FilesystemService
  private readonly configFileName: string
  private readonly explicitRoot: string | undefined

  constructor(options: SkillboxHomeOptions = {}) {
    this.env = options.env ?? process.env
    this.filesystem = options.filesystem ?? new FilesystemService()
    this.configFileName = options.configFileName ?? RUNTIME_CONFIG_FILE_NAME
    if (options.root !== undefined) {
      this.explicitRoot = options.root
    }
  }

  get root(): string {
    if (this.explicitRoot !== undefined) {
      return path.resolve(this.explicitRoot)
    }
    return resolveSkillboxHome(this.env)
  }

  /** All well-known runtime paths for this home. */
  layout(): SkillboxHomeLayout {
    return buildSkillboxHomeLayout(this.root)
  }

  /** Full path of `~/.skillbox/<name>` for a well-known directory. */
  directory(name: HomeDirectoryName): string {
    return this.layout()[name]
  }

  /** Full path of the runtime config file (`<root>/config.json` by default). */
  configFilePath(): string {
    return path.join(this.root, this.configFileName)
  }

  /** Creates the home, its directories, and `config.json` if missing. */
  async ensure(): Promise<void> {
    const layout = this.layout()
    await this.filesystem.mkdir(layout.root)
    for (const name of HOME_DIRECTORY_NAMES) {
      await this.filesystem.mkdir(layout[name])
    }
    const configFile = this.configFilePath()
    if (!(await this.filesystem.exists(configFile))) {
      await this.filesystem.writeFile(configFile, '{}')
    }
  }
}
