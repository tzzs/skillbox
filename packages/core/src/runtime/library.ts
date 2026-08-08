import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { validateRelativePath } from '../fs/paths.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import type { SkillMode } from '../domain/skill.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'

export const RUNTIME_LIBRARY_DIR_NAME = 'library'

/** Library sub-directory per skill mode (ARCHITECTURE.md §21). */
export const RUNTIME_MODE_DIRECTORIES: Record<SkillMode, string> = {
  managed: 'managed',
  local: 'local',
  forked: 'forked',
  vendored: 'vendored',
}

export interface RuntimeSkillEntry {
  /** Skill alias used as the directory name under the library root. */
  alias: string
  mode: SkillMode
  /** Absolute path of the materialized directory. */
  path: string
  exists: boolean
}

export interface MaterializeSkillOptions {
  alias: string
  mode: SkillMode
  /** Source directory whose contents are materialized (e.g. `repo/skills/foo`). */
  source: string
}

export type MaterializeSkillStatus = 'created' | 'unchanged' | 'refreshed'

export interface MaterializeSkillResult {
  status: MaterializeSkillStatus
  path: string
}

export interface RemoveRuntimeSkillResult {
  alias: string
  mode: SkillMode
  removed: boolean
}

function assertSafeAlias(alias: string): void {
  if (validateRelativePath(alias) !== alias) {
    throw new SkillboxError(ErrorCode.UNSAFE_PATH, `Unsafe skill alias "${alias}"`, {
      context: { alias },
    })
  }
}

/**
 * M6.3 Runtime Library Service over `~/.skillbox/library/`. Materialized
 * skills are independent copies; comparison is content-based (canonical
 * integrity) so re-materializing an identical skill is a no-op.
 */
export class RuntimeLibraryService {
  private readonly filesystem: FilesystemService

  constructor(
    readonly libraryRoot: string,
    filesystem?: FilesystemService,
  ) {
    this.filesystem = filesystem ?? new FilesystemService()
  }

  /** Absolute path where the given skill is (or would be) materialized. */
  pathFor(alias: string, mode: SkillMode): string {
    assertSafeAlias(alias)
    const modeDir = RUNTIME_MODE_DIRECTORIES[mode]
    return path.join(this.libraryRoot, modeDir, alias)
  }

  async get(alias: string, mode: SkillMode): Promise<RuntimeSkillEntry> {
    const target = this.pathFor(alias, mode)
    const exists = await this.filesystem.exists(target)
    return { alias, mode, path: target, exists }
  }

  /** Lists every materialized skill across all mode directories. */
  async list(): Promise<RuntimeSkillEntry[]> {
    const entries: RuntimeSkillEntry[] = []
    const modes = Object.keys(RUNTIME_MODE_DIRECTORIES) as SkillMode[]
    for (const mode of modes) {
      const modeDir = path.join(this.libraryRoot, RUNTIME_MODE_DIRECTORIES[mode])
      if (!(await this.filesystem.exists(modeDir))) {
        continue
      }
      const children = await this.filesystem.readDir(modeDir)
      for (const child of children) {
        if (!child.isDirectory) {
          continue
        }
        entries.push({
          alias: child.name,
          mode,
          path: child.fullPath,
          exists: true,
        })
      }
    }
    return entries
  }

  async has(alias: string, mode: SkillMode): Promise<boolean> {
    return this.filesystem.exists(this.pathFor(alias, mode))
  }

  /**
   * Materializes `source` into the library. Copies only when the content
   * differs from what is already materialized (compared via canonical hash),
   * keeping repeated calls and Reconcile runs cheap.
   */
  async materializeSkill(input: MaterializeSkillOptions): Promise<MaterializeSkillResult> {
    const target = this.pathFor(input.alias, input.mode)
    if (!(await this.filesystem.exists(input.source))) {
      throw new SkillboxError(
        ErrorCode.SKILL_MISSING,
        `Source skill not found at "${input.source}"`,
        {
          context: { source: input.source, alias: input.alias },
        },
      )
    }

    if (await this.filesystem.exists(target)) {
      const current = await computeSkillIntegrity(target)
      const fresh = await computeSkillIntegrity(input.source)
      if (current === fresh) {
        return { status: 'unchanged', path: target }
      }
      await this.filesystem.remove(target)
      await this.filesystem.copy(input.source, target)
      return { status: 'refreshed', path: target }
    }

    await this.filesystem.mkdir(path.dirname(target))
    await this.filesystem.copy(input.source, target)
    return { status: 'created', path: target }
  }

  /** Removes a materialized skill. Never follows a path outside the library. */
  async remove(alias: string, mode: SkillMode): Promise<RemoveRuntimeSkillResult> {
    const target = this.pathFor(alias, mode)
    if (!(await this.filesystem.exists(target))) {
      return { alias, mode, removed: false }
    }
    await this.filesystem.remove(target)
    return { alias, mode, removed: true }
  }

  /* --- M6.3 public API names --- */

  /** M6.3 `getRuntimeSkill()`: descriptor for one materialized skill. */
  getRuntimeSkill(alias: string, mode: SkillMode): Promise<RuntimeSkillEntry> {
    return this.get(alias, mode)
  }

  /** M6.3 `listRuntimeSkills()`: every materialized skill across all modes. */
  listRuntimeSkills(): Promise<RuntimeSkillEntry[]> {
    return this.list()
  }

  /** M6.3 `removeRuntimeSkill()`: removes one materialized skill. */
  removeRuntimeSkill(alias: string, mode: SkillMode): Promise<RemoveRuntimeSkillResult> {
    return this.remove(alias, mode)
  }
}
