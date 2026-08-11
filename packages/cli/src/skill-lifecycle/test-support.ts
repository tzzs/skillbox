import { CANCEL_RESULT, type InteractivePrompt } from '../interactive/prompts.js'
import type {
  AbortMergeResult,
  ContinueMergeResult,
  DiffProvider,
  ForkResult,
  ForkSkillInput,
  LifecycleProvider,
  ManagedModifications,
  MergeProvider,
  MergeResult,
  RestoreResult,
  SkillDiff,
  VendorResult,
  VendorSkillInput,
} from './types.js'

/** Cancel sentinel recognized by `isCancelResult` (see prompts.ts). */
export const CANCEL = CANCEL_RESULT

/** Test doubles shared by the skill-lifecycle service / wiring tests. */

/** Agent 1 fake: fork / vendor / detect / restore with recorded calls. */
export class FakeLifecycleProvider implements LifecycleProvider {
  forkCalls: ForkSkillInput[] = []
  vendorCalls: VendorSkillInput[] = []
  detectCalls: { name: string; repositoryRoot: string; homeRoot?: string }[] = []
  restoreCalls: { name: string; repositoryRoot: string }[] = []

  forkError?: Error
  vendorError?: Error
  detectError?: Error
  restoreError?: Error

  /** Overrides returned by the matching call; defaults below. */
  forkResult?: ForkResult
  vendorResult?: VendorResult
  modifications: ManagedModifications = { name: '', modified: false, files: [] }
  restoreResult: RestoreResult = { name: '', filesRestored: 4 }

  async forkSkill(input: ForkSkillInput): Promise<ForkResult> {
    this.forkCalls.push(input)
    if (this.forkError !== undefined) {
      throw this.forkError
    }
    return (
      this.forkResult ?? {
        alias: input.name,
        mode: 'forked',
        localPath: `skills/${input.name}`,
        upstreamSource: 'github:vercel-labs/agent-skills@skills/react-best-practices',
        baseRevision: 'abc1234def5678',
        materializedPath: `/repo/skills/${input.name}`,
        manifestChanged: true,
        lockfileChanged: true,
      }
    )
  }

  async vendorSkill(input: VendorSkillInput): Promise<VendorResult> {
    this.vendorCalls.push(input)
    if (this.vendorError !== undefined) {
      throw this.vendorError
    }
    return (
      this.vendorResult ?? {
        alias: input.name,
        mode: 'vendored',
        localPath: `skills/${input.name}`,
        upstreamCleared: true,
        manifestChanged: true,
        lockfileChanged: true,
      }
    )
  }

  async detectManagedModifications(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<ManagedModifications> {
    this.detectCalls.push(input)
    if (this.detectError !== undefined) {
      throw this.detectError
    }
    return { ...this.modifications, name: input.name }
  }

  async restoreManagedSkill(input: {
    name: string
    repositoryRoot: string
  }): Promise<RestoreResult> {
    this.restoreCalls.push(input)
    if (this.restoreError !== undefined) {
      throw this.restoreError
    }
    return { ...this.restoreResult, name: input.name }
  }
}

/** Agent 2 diff fake with a configurable diff result. */
export class FakeDiffProvider implements DiffProvider {
  diffCalls: { name: string; repositoryRoot: string; homeRoot?: string }[] = []
  diffError?: Error
  diffResult: SkillDiff = {
    name: '',
    mode: 'managed',
    views: [],
    unchanged: true,
  }

  async diffSkill(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<SkillDiff> {
    this.diffCalls.push(input)
    if (this.diffError !== undefined) {
      throw this.diffError
    }
    return { ...this.diffResult, name: input.name }
  }
}

/** Agent 2 merge fake; merge/continue/abort results are configurable. */
export class FakeMergeProvider implements MergeProvider {
  mergeCalls: { name: string; repositoryRoot: string; homeRoot?: string }[] = []
  continueCalls: { name: string; repositoryRoot: string; homeRoot?: string }[] = []
  abortCalls: { name: string; repositoryRoot: string; homeRoot?: string }[] = []

  mergeError?: Error
  continueError?: Error
  abortError?: Error

  mergeResult: MergeResult = { name: '', conflicts: [], filesMerged: 3, changes: 42 }
  continueResult: ContinueMergeResult = {
    name: '',
    resolved: true,
    remainingConflicts: [],
    filesMerged: 3,
    changes: 42,
    baseRevision: 'def56789abcd',
  }
  abortResult: AbortMergeResult = { name: '', filesRestored: 5 }

  async mergeSkill(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<MergeResult> {
    this.mergeCalls.push(input)
    if (this.mergeError !== undefined) {
      throw this.mergeError
    }
    return { ...this.mergeResult, name: input.name }
  }

  async continueMerge(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<ContinueMergeResult> {
    this.continueCalls.push(input)
    if (this.continueError !== undefined) {
      throw this.continueError
    }
    return { ...this.continueResult, name: input.name }
  }

  async abortMerge(input: {
    name: string
    repositoryRoot: string
    homeRoot?: string
  }): Promise<AbortMergeResult> {
    this.abortCalls.push(input)
    if (this.abortError !== undefined) {
      throw this.abortError
    }
    return { ...this.abortResult, name: input.name }
  }
}

/** Records prompts; select/confirm results are configurable per test. */
export class FakePrompts implements InteractivePrompt {
  calls: string[] = []
  selectResult: string | symbol = 'fork'
  confirmResult: boolean | symbol = true

  intro(): void {}
  outro(): void {}
  note(_message: string, title?: string): void {
    this.calls.push(`note:${title ?? ''}`)
  }
  info(message: string): void {
    this.calls.push(`info:${message}`)
  }
  success(): void {}
  warn(): void {}
  error(): void {}
  async select(options: {
    message: string
    options: readonly { value: string; label?: string }[]
  }): Promise<string | symbol> {
    // Records the labels the flow offers (e.g. "Convert to Fork,Restore").
    this.calls.push(
      `select:${options.options.map((option) => option.label ?? option.value).join(',')}`,
    )
    return this.selectResult
  }
  async multiselect(): Promise<string[]> {
    return []
  }
  async confirm(options: { message: string }): Promise<boolean | symbol> {
    this.calls.push(`confirm:${options.message}`)
    return this.confirmResult
  }
  async text(): Promise<string> {
    return ''
  }
}

/** Records editor-open requests without launching anything. */
export class FakeEditorLauncher {
  opened: string[] = []
  /** When `false`, the service falls back to the manual-edit hint. */
  canOpen = true

  async open(filePath: string): Promise<boolean> {
    this.opened.push(filePath)
    return this.canOpen
  }
}
