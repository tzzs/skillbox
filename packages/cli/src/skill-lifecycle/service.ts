import { spawn } from 'node:child_process'
import * as path from 'node:path'
import {
  ErrorCode,
  isSkillboxError,
  readLockfile,
  SkillboxError,
  type LockedSkill,
  type RepositoryStatus,
  type SkillStatusEntry,
} from '@skillbox/core'
import { resolveEditorCommand } from '../interactive/editor.js'
import { isCancelResult, type InteractivePrompt } from '../interactive/prompts.js'
import { LIFECYCLE_UNAVAILABLE_CODE, MERGE_CONFLICT_CODE } from './loaders.js'
import type {
  DiffProvider,
  EditAction,
  EditOutcome,
  ForkOutcome,
  ForkResult,
  LifecycleProvider,
  ManagedModifications,
  MergeConflict,
  MergeInput,
  MergeOutcome,
  MergeProvider,
  SkillDiff,
  VendorOutcome,
} from './types.js'

/**
 * V0.4 Skill Lifecycle — command flows behind `fork` / `vendor` / `edit` /
 * `diff` / `merge` (GAP_ANALYSIS §4, M17.1-3, M18, M19.4, M20.6-7). All
 * failures surface as `SkillboxError`s with a recovery hint; the command layer
 * only renders the results.
 */

/** Read-only status aggregation (core `StatusService` satisfies this). */
export interface SkillStatusReader {
  status(): Promise<RepositoryStatus>
}

/** Launches the user's editor on a file; resolves `false` when it cannot. */
export interface EditorLauncher {
  open(filePath: string): Promise<boolean>
}

/**
 * Default editor launcher over `$EDITOR` / `$VISUAL` (same resolution as the
 * V0.2 interactive session). Resolves `true` once the editor process spawned
 * and `false` when no editor is configured or the command cannot start — the
 * service then falls back to printing the file path.
 */
export function createDefaultEditorLauncher(env: NodeJS.ProcessEnv = process.env): EditorLauncher {
  return {
    open(filePath: string): Promise<boolean> {
      const command = resolveEditorCommand(filePath, env)
      if (command === null) {
        return Promise.resolve(false)
      }
      return new Promise<boolean>((resolve) => {
        const child = spawn(command.command, command.args, {
          stdio: 'inherit',
          shell: process.platform === 'win32',
        })
        child.on('spawn', () => resolve(true))
        child.on('error', () => resolve(false))
      })
    },
  }
}

export interface SkillLifecycleServiceOptions {
  repositoryRoot: string
  homeRoot: string
  /** Status aggregation; the edit/diff/merge flows resolve modes from it. */
  status: SkillStatusReader
  /** Agent 1's lifecycle provider (fork / vendor / detect / restore). */
  lifecycle: LifecycleProvider
  /** Agent 2's diff provider. */
  diff: DiffProvider
  /** Agent 2's merge provider. */
  merge: MergeProvider
  /** Clack prompts used by the interactive `edit` flow. */
  prompts: InteractivePrompt
  /** True when the process is attached to a real interactive terminal. */
  isInteractive: boolean
  out: (chunk: string) => void
  /** Editor launcher override (tests inject a fake; defaults to $EDITOR). */
  openEditor?: EditorLauncher
}

/** Wraps non-Skillbox failures with a typed code while passing errors through. */
function asSkillboxError(error: unknown, fallback: string): SkillboxError {
  if (isSkillboxError(error)) {
    return error
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new SkillboxError(LIFECYCLE_UNAVAILABLE_CODE, `${fallback}: ${detail}`, { cause: error })
}

export class SkillLifecycleService {
  private readonly openEditor: EditorLauncher

  constructor(private readonly options: SkillLifecycleServiceOptions) {
    this.openEditor = options.openEditor ?? createDefaultEditorLauncher()
  }

  /** M17.1 — fork a managed skill (progress + summary live in the CLI). */
  async fork(input: { name: string }): Promise<ForkOutcome> {
    const locked = await this.requireLockedSkill(input.name)
    if (locked.mode !== 'managed') {
      throw new SkillboxError(
        ErrorCode.SOURCE_UNSUPPORTED,
        `Skill "${input.name}" is ${locked.mode} — only managed (remote) skills can be forked. ` +
          `Run \`skillbox list\` to see the skill modes.`,
        { context: { name: input.name, mode: locked.mode } },
      )
    }
    this.reportPipeline('Copy runtime → Snapshot → Register')
    const result = await this.options.lifecycle.forkSkill({
      name: input.name,
      repositoryRoot: this.options.repositoryRoot,
      homeRoot: this.options.homeRoot,
    })
    return { ...result, fromMode: 'managed' }
  }

  /** M18 — vendor a managed or forked skill (localize + clear upstream). */
  async vendor(input: { name: string }): Promise<VendorOutcome> {
    const locked = await this.requireLockedSkill(input.name)
    if (locked.mode !== 'managed' && locked.mode !== 'forked') {
      throw new SkillboxError(
        ErrorCode.SOURCE_UNSUPPORTED,
        `Skill "${input.name}" is ${locked.mode} — only managed and forked skills can be vendored. ` +
          `Run \`skillbox list\` to see the skill modes.`,
        { context: { name: input.name, mode: locked.mode } },
      )
    }
    this.reportPipeline('Copy runtime → Localize → Clear upstream')
    const result = await this.options.lifecycle.vendorSkill({
      name: input.name,
      repositoryRoot: this.options.repositoryRoot,
      homeRoot: this.options.homeRoot,
    })
    return { ...result, fromMode: locked.mode }
  }

  /**
   * M17.2/17.3 — edit a skill. Managed skills are converted to forks on the
   * first edit: an unmodified runtime gets a confirm ("Editing will create a
   * local fork."); a modified runtime gets a "[Convert to Fork] / [Restore]"
   * choice. Non-interactively, anything but `--yes` degrades to a hint and
   * changes nothing.
   */
  async edit(input: { name: string; yes?: boolean }): Promise<EditOutcome> {
    const entry = await this.findSkill(input.name)
    if (entry === undefined) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${input.name}" is not installed — run \`skillbox list\` to see what is.`,
        { context: { name: input.name } },
      )
    }

    if (entry.mode !== 'managed') {
      // local / forked / vendored — the skill already lives in the repository.
      return this.openEditorAfter(input.name, 'edited', entry.path)
    }

    const modifications = await this.detectModifications(input.name)
    if (modifications.modified) {
      return this.editModifiedManaged(input)
    }
    return this.editPristineManaged(input)
  }

  /** M19.4 — diff: managed → current vs latest; forked → base/local/upstream. */
  async diff(input: { name: string }): Promise<SkillDiff> {
    const entry = await this.findSkill(input.name)
    if (entry === undefined) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${input.name}" is not installed — run \`skillbox list\` to see what is.`,
        { context: { name: input.name } },
      )
    }
    if (entry.mode !== 'managed' && entry.mode !== 'forked') {
      throw new SkillboxError(
        ErrorCode.SOURCE_UNSUPPORTED,
        `Skill "${input.name}" is ${entry.mode} — diff is only available for managed and forked skills.`,
        { context: { name: input.name, mode: entry.mode } },
      )
    }
    const diff = await this.options.diff.diffSkill({
      name: input.name,
      repositoryRoot: this.options.repositoryRoot,
      homeRoot: this.options.homeRoot,
    })
    return { ...diff, unchanged: diff.views.every((view) => view.files.length === 0) }
  }

  /** M20 — 3-way merge (forked only); `--continue` / `--abort` manage it. */
  async merge(input: MergeInput): Promise<MergeOutcome> {
    const entry = await this.findSkill(input.name)
    if (entry === undefined) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${input.name}" is not installed — run \`skillbox list\` to see what is.`,
        { context: { name: input.name } },
      )
    }
    if (entry.mode !== 'forked') {
      throw new SkillboxError(
        ErrorCode.SOURCE_UNSUPPORTED,
        `Skill "${input.name}" is ${entry.mode} — only forked skills can be merged. ` +
          `Managed skills update with \`skillbox update <name>\`.`,
        { context: { name: input.name, mode: entry.mode } },
      )
    }

    const base = {
      name: input.name,
      repositoryRoot: this.options.repositoryRoot,
      homeRoot: this.options.homeRoot,
    }
    if (input.action === 'abort') {
      const result = await this.options.merge.abortMerge(base)
      return { kind: 'aborted', name: input.name, filesRestored: result.filesRestored }
    }
    if (input.action === 'continue') {
      const result = await this.options.merge.continueMerge(base)
      if (!result.resolved) {
        throw this.unresolvedMergeError(input.name, result.remainingConflicts, true)
      }
      return {
        kind: 'continued',
        name: input.name,
        filesMerged: result.filesMerged,
        changes: result.changes,
        ...(result.baseRevision !== undefined ? { baseRevision: result.baseRevision } : {}),
      }
    }
    const result = await this.options.merge.mergeSkill(base)
    if (result.conflicts.length > 0) {
      throw this.unresolvedMergeError(input.name, result.conflicts)
    }
    return {
      kind: 'merged',
      name: input.name,
      filesMerged: result.filesMerged,
      changes: result.changes,
      ...(result.baseRevision !== undefined ? { baseRevision: result.baseRevision } : {}),
    }
  }

  /* ------------------------------------------------------------------ *
   * Edit flow internals
   * ------------------------------------------------------------------ */

  /**
   * M17.2 — local-modification detection via the lifecycle provider
   * (`detectManagedModifications` in `@skillbox/core/lifecycle`). When the
   * provider is unavailable the flow degrades to the unmodified path (safe:
   * the fork-conversion prompt keeps local changes).
   */
  private async detectModifications(name: string): Promise<ManagedModifications> {
    try {
      return await this.options.lifecycle.detectManagedModifications({
        name,
        repositoryRoot: this.options.repositoryRoot,
        homeRoot: this.options.homeRoot,
      })
    } catch (error) {
      if (isSkillboxError(error) && error.code === LIFECYCLE_UNAVAILABLE_CODE) {
        return { name, modified: false }
      }
      throw asSkillboxError(error, `Cannot detect local modifications for "${name}"`)
    }
  }

  /** M17.2 — unmodified managed runtime: confirm the fork, then convert. */
  private async editPristineManaged(input: { name: string; yes?: boolean }): Promise<EditOutcome> {
    const { name } = input
    if (!this.options.isInteractive) {
      if (input.yes !== true) {
        this.options.out(
          `Editing "${name}" would create a local fork.\n` +
            `Run \`skillbox edit ${name} --yes\` to convert "${name}" to a fork and edit it.\n`,
        )
        return { name, action: 'deferred' }
      }
      return this.convertAndEdit(name)
    }
    const answer = await this.options.prompts.confirm({
      message: `Editing will create a local fork. Continue?`,
      initialValue: true,
      active: 'Convert to Fork',
      inactive: 'Cancel',
    })
    if (isCancelResult(answer) || answer !== true) {
      return { name, action: 'cancelled' }
    }
    return this.convertAndEdit(name)
  }

  /** M17.3 — modified managed runtime: choose [Convert to Fork] / [Restore]. */
  private async editModifiedManaged(input: { name: string; yes?: boolean }): Promise<EditOutcome> {
    const { name } = input
    if (!this.options.isInteractive) {
      if (input.yes !== true) {
        this.options.out(
          `Skill "${name}" has local modifications.\n` +
            `Run \`skillbox edit ${name} --yes\` to convert it to a fork (your changes are kept), ` +
            `or restore the runtime with the interactive flow.\n`,
        )
        return { name, action: 'deferred' }
      }
      // `--yes` defaults to the change-preserving action.
      return this.convertAndEdit(name)
    }
    const choice = await this.options.prompts.select({
      message: `"${name}" has local modifications — convert to a fork or restore?`,
      options: [
        {
          value: 'fork',
          label: 'Convert to Fork',
          hint: 'keeps your changes and tracks upstream',
        },
        {
          value: 'restore',
          label: 'Restore',
          hint: 're-download the runtime from the lockfile integrity',
        },
      ],
      initialValue: 'fork',
    })
    if (isCancelResult(choice)) {
      return { name, action: 'cancelled' }
    }
    if (choice === 'restore') {
      const result = await this.options.lifecycle.restoreManagedSkill({
        name,
        repositoryRoot: this.options.repositoryRoot,
      })
      // The restored runtime is pristine managed again; direct editing of the
      // library copy is not supported — convert it to a fork to edit it.
      this.options.out(
        `Restored ${result.filesRestored} file(s) from the lockfile integrity.\n` +
          `"${name}" is pristine again — run \`skillbox edit ${name}\` to convert it to a fork.\n`,
      )
      return { name, action: 'restored' }
    }
    return this.convertAndEdit(name)
  }

  /** Fork conversion shared by the pristine + modified edit paths. */
  private async convertAndEdit(name: string): Promise<EditOutcome> {
    this.reportPipeline('Copy runtime → Snapshot → Register')
    const result: ForkResult = await this.options.lifecycle.forkSkill({
      name,
      repositoryRoot: this.options.repositoryRoot,
      homeRoot: this.options.homeRoot,
    })
    const entry = await this.findSkill(name)
    const skillDir =
      entry?.path ??
      (result.localPath !== ''
        ? path.join(this.options.repositoryRoot, result.localPath)
        : undefined)
    return this.openEditorAfter(name, 'forked', skillDir, result.baseRevision)
  }

  /** Opens SKILL.md under `skillDir`; prints a manual-edit hint when no editor. */
  private async openEditorAfter(
    name: string,
    action: EditAction,
    skillDir: string | undefined,
    baseRevision?: string,
  ): Promise<EditOutcome> {
    const outcome: EditOutcome = { name, action }
    if (baseRevision !== undefined) {
      outcome.baseRevision = baseRevision
    }
    if (skillDir === undefined) {
      this.options.out(`"${name}" has no local directory to edit.\n`)
      return outcome
    }
    const filePath = path.join(skillDir, 'SKILL.md')
    outcome.path = filePath
    if (!(await this.openEditor.open(filePath))) {
      this.options.out(
        `No editor configured (set EDITOR or VISUAL). Edit the skill manually:\n  ${filePath}\n`,
      )
    }
    return outcome
  }

  /* ------------------------------------------------------------------ *
   * Shared helpers
   * ------------------------------------------------------------------ */

  private async findSkill(name: string): Promise<SkillStatusEntry | undefined> {
    const report = await this.options.status.status()
    return report.skills.find((skill) => skill.name === name)
  }

  /** Lockfile entry for a skill; hints at sync when the lockfile is absent. */
  private async requireLockedSkill(name: string): Promise<LockedSkill> {
    let lockfile: Awaited<ReturnType<typeof readLockfile>>
    try {
      lockfile = await readLockfile(this.options.repositoryRoot)
    } catch (error) {
      if (isSkillboxError(error) && error.code === ErrorCode.LOCKFILE_NOT_FOUND) {
        throw new SkillboxError(
          ErrorCode.LOCKFILE_NOT_FOUND,
          `No skillbox.lock found — run \`skillbox sync\` (or \`skillbox install\`) first.`,
          { cause: error },
        )
      }
      throw error
    }
    const locked = lockfile.skills[name]
    if (locked === undefined) {
      throw new SkillboxError(
        ErrorCode.SKILL_NOT_FOUND,
        `Skill "${name}" is not installed — run \`skillbox list\` to see what is.`,
        { context: { name } },
      )
    }
    return locked
  }

  /** Streams one pipeline line to the terminal (interactive-aware). */
  private reportPipeline(label: string): void {
    const line = `  ${label}`
    if (this.options.isInteractive) {
      this.options.prompts.info(line)
    } else {
      this.options.out(`${line}\n`)
    }
  }

  /**
   * MERGE_CONFLICT (exit 3) listing the conflicting files + next step.
   * `continuing` distinguishes a fresh merge run from `--continue` with
   * leftover conflicts.
   */
  private unresolvedMergeError(
    name: string,
    conflicts: readonly MergeConflict[],
    continuing = false,
  ): SkillboxError {
    const rows = conflicts
      .map((conflict) => {
        const hunks = `${conflict.hunks} hunk${conflict.hunks === 1 ? '' : 's'}`
        const reason = conflict.reason !== undefined ? `, ${conflict.reason}` : ''
        return `  ${conflict.path} (${hunks}${reason})`
      })
      .join('\n')
    const heading = continuing
      ? `Merge of "${name}" still has ${conflicts.length} unresolved conflict(s):\n${rows}\n` +
        `Resolve them, then run \`skillbox merge ${name} --continue\`.`
      : `Merge of "${name}" has ${conflicts.length} conflicting file(s):\n${rows}\n` +
        `Resolve the conflicts, then run \`skillbox merge ${name} --continue\`.`
    return new SkillboxError(MERGE_CONFLICT_CODE, heading, { context: { name, conflicts } })
  }
}
