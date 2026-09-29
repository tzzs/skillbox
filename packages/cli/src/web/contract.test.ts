import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type * as CliTypes from './types.js'
import type {
  AgentAssignmentResponse,
  ApiErrorBody,
  BackupRecord,
  ConflictResolution,
  ConflictSessionDto,
  ConflictType,
  CreateSkillInput,
  FleetRunRequest,
  LifecycleOperationResult,
  ReconcileProblem,
  ReconcileResult,
  RegistrySearchResult,
  ResolveSyncConflictsInput,
  SettingsPatch,
  SettingsResponse,
  SkillDiff,
  SyncBlocker,
  SyncConflictDto,
  SyncOutcomeDto,
  SyncRollbackDto,
  SyncStatusResponse,
} from '@skillbox/shared'

/**
 * The contract has exactly one definition, and this file is what keeps it that
 * way.
 *
 * Two kinds of check, because they catch different things:
 *
 *  - **Type-level assertions** are the only thing that can pin a *shape*. Types
 *    are erased long before vitest runs, so no runtime expectation — however
 *    clever — can notice that a union lists six members on one side and three on
 *    the other, or that a field the server sends is absent from the client's
 *    copy. Those bugs surface as a value arriving that the receiving code's type
 *    says cannot happen. Only `tsc` sees them, which is why the assignments
 *    below *are* the assertion and the `expect(...)` beside them is
 *    deliberately trivial: this file is compiled by `pnpm typecheck` and a
 *    regression there is the failure signal.
 *  - **Source-text checks** can be ordinary runtime tests, because they read the
 *    modules as text instead of as types: they fail the moment either side
 *    writes a local `interface`/`type` for something the contract module owns.
 *    That is the exact regression that produced the six-vs-three sync-resolution
 *    bug, and a re-declaration would quietly reintroduce it while every request
 *    kept returning valid JSON.
 */

const here = dirname(fileURLToPath(import.meta.url))
/** Repo root, seen from `packages/cli/src/web`. */
const root = resolve(here, '../../../..')
const CONTRACT = '@skillbox/shared'

async function sourceOf(relative: string): Promise<string> {
  return readFile(join(root, relative), 'utf8')
}

/** Escape a module specifier for use inside a `RegExp`. */
function escapeModule(module: string): string {
  return module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Type names a module *declares* itself: `export interface X` / `export type X = …`. */
function declaredTypes(source: string): string[] {
  return [...source.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z0-9_$]+)[\s={]/gm)].map(
    (match) => match[1] as string,
  )
}

/** Entries of an `export type { … } from '<module>'` block (post-`as` names). */
function reexportedFrom(source: string, module: string): string[] {
  return specifiers(
    source,
    `export\\s+type\\s*\\{([^{}]*)\\}\\s*from\\s*'${escapeModule(module)}'`,
    'target',
  )
}

/** Entries of an `import type { … } from '<module>'` block (pre-`as` names). */
function importedFrom(source: string, module: string): string[] {
  return specifiers(
    source,
    `import\\s+type\\s*\\{([^{}]*)\\}\\s*from\\s*'${escapeModule(module)}'`,
    'source',
  )
}

/** Renamed pairs (`A as B`) in a module's type import block. */
function renamedImports(source: string, module: string): Array<[string, string]> {
  const block = new RegExp(
    `import\\s+type\\s*\\{([^{}]*)\\}\\s*from\\s*'${escapeModule(module)}'`,
  ).exec(source)
  if (block === null) return []
  const [, body = ''] = block
  return body
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /\s+as\s+/.test(entry))
    .map((entry) => entry.split(/\s+as\s+/) as [string, string])
}

function specifiers(source: string, pattern: string, side: 'source' | 'target'): string[] {
  const block = new RegExp(pattern).exec(source)
  if (block === null) return []
  const [, body = ''] = block
  return body
    .split(',')
    .map((entry) => {
      const parts = entry.trim().split(/\s+as\s+/)
      const picked = side === 'source' ? parts[0] : parts[parts.length - 1]
      return (picked ?? '').trim()
    })
    .filter((name) => /^[A-Za-z0-9_$]+$/.test(name))
}

/** Names the contract module owns: what it declares, plus what it takes from Core. */
function contractOwnedNames(webApi: string): Set<string> {
  return new Set([...declaredTypes(webApi), ...reexportedFrom(webApi, '@skillbox/core')])
}

type Assert<T extends true> = T
/** Both-directions assignability: identical shapes pass, a widened copy fails. */
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe('web API contract has one definition', () => {
  it('the server module re-declares nothing the contract owns', async () => {
    const [webApi, serverTypes] = await Promise.all([
      sourceOf('packages/shared/src/web-api.ts'),
      sourceOf('packages/cli/src/web/types.ts'),
    ])
    const owned = contractOwnedNames(webApi)
    // What stays here is what never crosses the wire: the Core service
    // interfaces the routes delegate to, plus the server host options.
    expect(declaredTypes(serverTypes).filter((name) => owned.has(name))).toEqual([])
    expect(owned.size).toBeGreaterThan(80)

    const reexported = reexportedFrom(serverTypes, CONTRACT)
    expect(reexported.length).toBeGreaterThan(60)
    expect(reexported.filter((name) => !owned.has(name))).toEqual([])
  })

  it('the client module re-declares nothing the contract owns', async () => {
    const [webApi, clientApi] = await Promise.all([
      sourceOf('packages/shared/src/web-api.ts'),
      sourceOf('apps/web/src/api.ts'),
    ])
    const owned = contractOwnedNames(webApi)
    // `ApiClient` is the client's own surface (it names the calling methods, not
    // a wire shape), so it is the one declaration the module may still write.
    expect(declaredTypes(clientApi).filter((name) => owned.has(name))).toEqual([])

    // Every name the client hands to its screens must be an alias of a contract
    // name. The renames are how the old client-side vocabulary (`AgentSummary`,
    // `ConflictChoice`, `SyncStatusView`, …) survives without a second copy.
    const imported = importedFrom(clientApi, CONTRACT)
    expect(imported.length).toBeGreaterThan(60)
    expect(imported.filter((name) => !owned.has(name))).toEqual([])
    const renamed = renamedImports(clientApi, CONTRACT)
    expect(renamed.length).toBeGreaterThan(10)
    expect(renamed.map(([origin]) => origin).filter((name) => !owned.has(name))).toEqual([])
  })

  it('every contract name the web layer imports resolves to the contract module', async () => {
    const serverTypes = await sourceOf('packages/cli/src/web/types.ts')
    const available = new Set([
      ...reexportedFrom(serverTypes, CONTRACT),
      ...declaredTypes(serverTypes),
    ])
    // Every module in the web directory, handlers and tests alike: a name that
    // resolves for one of them but not the other is a half-moved contract.
    const modules = (await readdir(here))
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => `packages/cli/src/web/${entry}`)
      .filter((entry) => !entry.endsWith('contract.test.ts'))
    expect(modules.length).toBeGreaterThan(4)
    for (const module of modules) {
      const unresolved = importedFrom(await sourceOf(module), './types.js').filter(
        (name) => !available.has(name),
      )
      expect([module, unresolved]).toEqual([module, []])
    }
  })
})

describe('web API contract holds its shape', () => {
  it('the server module and the contract are the same type, both directions', () => {
    // A hand-written copy that grows or loses an optional field passes one
    // direction and fails the other, so both assignments have to compile.
    const conflictToContract: SyncConflictDto = {} as CliTypes.SyncConflictDto
    const conflictToServer: CliTypes.SyncConflictDto = {} as SyncConflictDto
    const sessionToContract: ConflictSessionDto = {} as CliTypes.ConflictSessionDto
    const sessionToServer: CliTypes.ConflictSessionDto = {} as ConflictSessionDto
    const outcomeToContract: SyncOutcomeDto = {} as CliTypes.SyncOutcomeDto
    const outcomeToServer: CliTypes.SyncOutcomeDto = {} as SyncOutcomeDto
    const errorToContract: ApiErrorBody = {} as CliTypes.ApiErrorBody
    const errorToServer: CliTypes.ApiErrorBody = {} as ApiErrorBody
    const rollbackToContract: SyncRollbackDto = {} as CliTypes.SyncRollbackDto
    const rollbackToServer: CliTypes.SyncRollbackDto = {} as SyncRollbackDto
    const statusToContract: SyncStatusResponse = {} as CliTypes.SyncStatusResponse
    const statusToServer: CliTypes.SyncStatusResponse = {} as SyncStatusResponse
    expect(
      [
        conflictToContract,
        conflictToServer,
        sessionToContract,
        sessionToServer,
        outcomeToContract,
        outcomeToServer,
        errorToContract,
        errorToServer,
        rollbackToContract,
        rollbackToServer,
        statusToContract,
        statusToServer,
      ].length,
    ).toBe(12)
  })

  it('the sync vocabulary comes from Core, not from a copy of it', () => {
    // This is the pair that drifted once: the client listed six resolutions,
    // Core's `ConflictResolution` — the choices `SyncTransaction.resolve` can
    // actually carry out — lists three, and a conflict closed on a value the
    // engine silently dropped.
    const offered: Assert<SameShape<SyncConflictDto['allowedResolutions'], ConflictResolution[]>> =
      true
    const kind: Assert<SameShape<SyncConflictDto['type'], ConflictType>> = true
    expect([offered, kind].length).toBe(2)

    const resolution: SyncConflictDto['allowedResolutions'][number] = 'keep-both'
    const conflictKind: SyncConflictDto['type'] = 'delete-modify'
    const recommended: ConflictSessionDto['conflicts'][number]['recommendedResolution'] = 'remote'
    // A rollback may name only Core's `CleanupStep` values.
    const step: SyncRollbackDto['failures'][number]['step'] = 'remove-worktree'
    // So may a blocked sync name only Core's blockers: `reason` used to be
    // `string` on the wire copy, which left the UI unable to tell
    // "retry the push" apart from "a journal is stuck, run `skillbox recover`".
    type BlockedOutcome = Extract<SyncOutcomeDto, { kind: 'blocked' }>
    const blocker: Assert<SameShape<BlockedOutcome['reason'], SyncBlocker>> = true
    const stuckJournal: BlockedOutcome['reason'] = 'recovery-required'
    expect([resolution, conflictKind, recommended, step, blocker, stuckJournal].length).toBe(6)
  })

  it('fields the server really sends stay in the contract', () => {
    // Every value below is one a running server answers with. If a line stops
    // compiling, a client typed against the narrower copy is about to receive
    // something its own types call impossible.
    const pingRun: FleetRunRequest = { operation: 'ping', retries: 2 }
    const metadataBackup: BackupRecord['kind'] = 'repo-metadata'
    const assignmentField: keyof AgentAssignmentResponse['assignment'] = 'reconcile'
    const linkStrategy: ReconcileResult['linkStrategy'] = 'symlink'
    const problem: ReconcileProblem = { code: 'AGENT_NOT_DETECTED', message: 'no agent' }
    const aliasProblem: ReconcileProblem = { code: 'X', alias: 'a', message: 'm' }
    const settings: SettingsResponse = { settings: { github: { login: 'tzzs' } } }
    const editable: SettingsPatch = { linkStrategy: 'junction' }
    // A diff carries the full mode union even though only two modes are diffable
    // (the route refuses the others with DIFF_UPSTREAM_UNAVAILABLE).
    const diffMode: SkillDiff['mode'] = 'vendored'
    const action: LifecycleOperationResult['action'] = 'continued'
    const searched: RegistrySearchResult = { name: 'n', source: 'github:a/b', provider: 'github' }
    const createdSkill: CreateSkillInput = { name: 'n' }
    const resolutions: ResolveSyncConflictsInput = { resolutions: { 'c-1': 'local' } }
    expect(
      [
        pingRun,
        metadataBackup,
        assignmentField,
        linkStrategy,
        problem,
        aliasProblem,
        settings,
        editable,
        diffMode,
        action,
        searched,
        createdSkill,
        resolutions,
      ].length,
    ).toBe(13)
  })
})
