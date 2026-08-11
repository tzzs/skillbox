import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { Dirent } from 'node:fs'
import type {
  AgentCapabilities,
  AgentDetectionResult,
  AgentInstalledSkill,
} from '../domain/agent.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import {
  FilesystemService,
  createLink,
  validateRelativePath,
  SkillboxFsError,
  FsIoErrorCode,
} from '../fs/index.js'
import type { CreateLinkOptions, LinkStrategy } from '../fs/index.js'

export interface AgentLinkOptions {
  /** Name the skill will appear as in the agent skills directory. */
  name?: string
  /** Link strategy for the directory link (auto / symlink / junction / copy). */
  strategy?: LinkStrategy
  /**
   * Replace an existing Skillbox-owned link of the same name. Overwriting a
   * non-Skillbox (external) skill is never done automatically.
   */
  force?: boolean
}

export interface AgentUnlinkResult {
  name: string
  path: string
  removed: boolean
  reason: 'managed' | 'external' | 'not_found'
}

export interface AgentAdapter {
  id: string
  name: string
  capabilities: AgentCapabilities
  detect(): Promise<AgentDetectionResult>
  getSkillDirectories(): Promise<string[]>
  scanSkills(): Promise<AgentInstalledSkill[]>
  linkSkill(source: string, options?: AgentLinkOptions): Promise<void>
  unlinkSkill(name: string): Promise<AgentUnlinkResult>
}

export interface AgentOwnershipResolver {
  isSkillboxOwned(skillPath: string): Promise<boolean>
}

/**
 * Default ownership rule: a skill is Skillbox-owned when it resolves (through
 * symlinks *and* junctions) to a location inside the managed library root, or
 * when it is a regular directory physically inside that root. Everything else
 * (hand-written external folders, links pointing elsewhere) is treated as
 * external. Passing no `managedRoot` keeps every skill external.
 *
 * Resolution is intentionally done with `fs.realpath`: on Windows a junction
 * is reported by `lstat` as a (non-symlink) directory, so relying only on
 * `isSymbolicLink()` would misclassify linked skills. `realpath` follows both.
 */
export class ManagedRootOwnershipResolver implements AgentOwnershipResolver {
  readonly managedRoot: string | null

  constructor(managedRoot: string | null | undefined) {
    this.managedRoot =
      managedRoot === undefined || managedRoot === null ? null : path.resolve(managedRoot)
  }

  async isSkillboxOwned(skillPath: string): Promise<boolean> {
    if (this.managedRoot === null) {
      return false
    }
    let rootReal: string
    try {
      rootReal = await fs.realpath(this.managedRoot)
    } catch {
      return false
    }
    let targetReal: string
    try {
      targetReal = await fs.realpath(skillPath)
    } catch {
      return false
    }
    return isPathInsideOf(rootReal, targetReal)
  }
}

/** Case-insensitive containment check suitable for Windows drive letters. */
function isPathInsideOf(parent: string, candidate: string): boolean {
  const normalize = (p: string): string => {
    const resolved = path.normalize(path.resolve(p))
    if (path.sep !== '/') {
      return resolved.split(path.sep).join('/')
    }
    return resolved
  }
  const a = normalize(parent)
  const b = normalize(candidate)
  if (process.platform === 'win32') {
    return b.toLowerCase() === a.toLowerCase() || b.toLowerCase().startsWith(`${a.toLowerCase()}/`)
  }
  return b === a || b.startsWith(`${a}/`)
}

export interface CliAgentAdapterConfig {
  executableName: string
  /** Env var holding an explicit path to the CLI binary (e.g. CLAUDE_BIN). */
  executableEnv?: string
  /** Env var holding the agent config directory (e.g. CLAUDE_CONFIG_DIR). */
  configDirEnv: string
  /** Relative path of the skills directory under home ('.claude/skills'). */
  defaultSkillsSubdir: string
  /** Precise skills directory override (highest priority). */
  skillsDir?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
  /** Search PATH for the executable; disable for deterministic fixtures. */
  searchPath?: boolean
  managedRoot?: string
  ownership?: AgentOwnershipResolver
  resolveExecutableInPath?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  resolveVersion?: (executable: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  fsService?: FilesystemService
}

/**
 * Shared logic for CLI-based agent adapters. Paths are derived with
 * `os.homedir()` + `node:path`, overridable through env vars (CLAUDE_CONFIG_DIR,
 * CLAUDE_BIN, ...) or explicit config options; no absolute user paths are
 * hard-coded.
 */
export abstract class CliAgentAdapter implements AgentAdapter {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly capabilities: AgentCapabilities

  protected readonly executableName: string
  protected readonly config: CliAgentAdapterConfig

  constructor(config: CliAgentAdapterConfig) {
    this.executableName = config.executableName
    this.config = config
  }

  protected env(): NodeJS.ProcessEnv {
    return this.config.env ?? process.env ?? {}
  }

  protected envValue(key: string): string | undefined {
    const value = this.env()[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  protected fsService(): FilesystemService {
    return this.config.fsService ?? new FilesystemService()
  }

  protected ownershipResolver(): AgentOwnershipResolver {
    return this.config.ownership ?? new ManagedRootOwnershipResolver(this.config.managedRoot)
  }

  /**
   * Skills directories for this agent. Global skills live in
   * `<configDir>/skills`, where `configDir` honours the agent's config-dir
   * environment variable and falls back to `~/.<name>`.
   */
  async getSkillDirectories(): Promise<string[]> {
    return [await this.resolveSkillsDirectory()]
  }

  protected async resolveSkillsDirectory(): Promise<string> {
    if (this.config.skillsDir !== undefined) {
      return path.resolve(this.config.skillsDir)
    }
    const home = this.config.homeDir ?? homedir()
    const configDir = this.envValue(this.config.configDirEnv)
    if (configDir !== undefined) {
      return path.join(configDir, 'skills')
    }
    return path.join(home, ...this.config.defaultSkillsSubdir.split('/'))
  }

  async detect(): Promise<AgentDetectionResult> {
    const skillDirectories = await this.getSkillDirectories()
    const executable = await this.resolveExecutable()
    const skillDirPresent = await this.anyDirectoryExists(skillDirectories)
    const detected = executable !== null || skillDirPresent

    const result: AgentDetectionResult = {
      detected,
      skillDirectories,
      confidence: executable === null ? 'low' : skillDirPresent ? 'high' : 'medium',
    }
    if (executable !== null) {
      result.executable = executable
      const version = await this.readVersion(executable)
      if (version !== null) {
        result.version = version
      }
    }
    return result
  }

  async scanSkills(): Promise<AgentInstalledSkill[]> {
    const dirs = await this.getSkillDirectories()
    const skills: AgentInstalledSkill[] = []
    const seen = new Set<string>()
    for (const dir of dirs) {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue
        }
        const skillPath = path.join(dir, entry.name)
        if (seen.has(skillPath)) {
          continue
        }
        seen.add(skillPath)
        skills.push({
          name: entry.name,
          path: skillPath,
          managedBySkillbox: await this.ownershipResolver().isSkillboxOwned(skillPath),
        })
      }
    }
    return skills
  }

  async linkSkill(source: string, options: AgentLinkOptions = {}): Promise<void> {
    const rawName = options.name ?? path.basename(source.replace(/[\\/]+$/, ''))
    const name = assertSafeSkillName(rawName)
    const dir = await this.requireSkillsDirectory()
    const fsService = this.fsService()
    await fsService.mkdir(dir)
    const destination = path.join(dir, name)

    if (await fsService.exists(destination)) {
      const owned = await this.ownershipResolver().isSkillboxOwned(destination)
      if (owned && (await sameResolvedPath(source, destination))) {
        return
      }
      if (!owned && options.force !== true) {
        throw new SkillboxFsError(
          FsIoErrorCode.ALREADY_EXISTS,
          `Refusing to overwrite external skill "${name}"`,
          { path: destination },
        )
      }
      await fsService.remove(destination)
    }

    const linkOptions: CreateLinkOptions = {}
    if (options.strategy !== undefined) {
      linkOptions.strategy = options.strategy
    }
    await createLink(source, destination, linkOptions)
  }

  async unlinkSkill(name: string): Promise<AgentUnlinkResult> {
    const safe = assertSafeSkillName(name)
    const dir = await this.requireSkillsDirectory()
    const fsService = this.fsService()
    const destination = path.join(dir, safe)

    if (!(await fsService.exists(destination))) {
      return { name: safe, path: destination, removed: false, reason: 'not_found' }
    }
    const owned = await this.ownershipResolver().isSkillboxOwned(destination)
    if (!owned) {
      // External skills are preserved - never removed automatically.
      return { name: safe, path: destination, removed: false, reason: 'external' }
    }
    await fsService.remove(destination)
    return { name: safe, path: destination, removed: true, reason: 'managed' }
  }

  private async readVersion(executable: string): Promise<string | null> {
    if (this.config.resolveVersion !== undefined) {
      return this.config.resolveVersion(executable, this.env())
    }
    return defaultReadCliVersion(executable, this.env())
  }

  private async resolveExecutable(): Promise<string | null> {
    const aliasKey = this.config.executableEnv
    if (aliasKey !== undefined) {
      const explicit = this.envValue(aliasKey)
      if (explicit !== undefined && (await this.fsService().exists(explicit))) {
        return explicit
      }
    }
    if (this.config.resolveExecutableInPath === undefined && this.config.searchPath === false) {
      return null
    }
    const resolver = this.config.resolveExecutableInPath ?? defaultResolveExecutableInPath
    return resolver(this.executableName, this.env())
  }

  private async requireSkillsDirectory(): Promise<string> {
    const dirs = await this.getSkillDirectories()
    const dir = dirs[0]
    if (dir === undefined) {
      throw new SkillboxError(
        ErrorCode.AGENT_NOT_DETECTED,
        `No skills directory available for agent "${this.name}"`,
      )
    }
    return dir
  }

  private async anyDirectoryExists(dirs: string[]): Promise<boolean> {
    for (const dir of dirs) {
      if (await this.fsService().exists(dir)) {
        return true
      }
    }
    return false
  }
}

function assertSafeSkillName(name: string): string {
  try {
    const normalized = validateRelativePath(name)
    if (normalized !== name) {
      throw new Error('normalized mismatch')
    }
    return normalized
  } catch (error) {
    if (error instanceof SkillboxError) {
      throw error
    }
    throw new SkillboxError(ErrorCode.UNSAFE_PATH, `Unsafe skill name: "${name}"`)
  }
}

async function sameResolvedPath(a: string, b: string): Promise<boolean> {
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b))
  } catch {
    return path.resolve(a) === path.resolve(b)
  }
}

/** Looks up `command` on the OS PATH (where/which). */
async function defaultResolveExecutableInPath(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    const stdout = execFileSync(probe, [command], { encoding: 'utf8', env })
    const line = stdout
      .split(/\r?\n/)
      .map((chunk) => chunk.trim())
      .find((chunk) => chunk.length > 0)
    return line ?? null
  } catch {
    return null
  }
}

/** Runs `<executable> --version` and extracts a semver-like string. */
async function defaultReadCliVersion(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const stdout = execFileSync(executable, ['--version'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const version = stdout.match(/\d+\.\d+\.\d+/)?.[0]
    return version ?? null
  } catch {
    return null
  }
}

export { defaultResolveExecutableInPath, defaultReadCliVersion }
