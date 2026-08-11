# Skillbox P0–P2 Optimization Roadmap Design

> Status: approved design
>
> Date: 2026-08-12
>
> Baseline: `375411d`, with the refreshed gap analysis committed as `02df942`
>
> Source: `GAP_ANALYSIS.md`

## 1. Purpose

This design turns the current P0–P2 gap analysis into a risk-first optimization roadmap. The
roadmap restores the real GitHub/Git user journey first, establishes trustworthy end-to-end
validation, then unifies source and lifecycle behavior before adding reliability, publishing, and
Agent expansion work.

The roadmap covers all current P0–P2 gaps. It intentionally does not give every gap equal urgency:
work is ordered by user impact, dependency direction, and the cost of building further features on
unstable production wiring.

## 2. Design principles

1. Production wiring is a first-class test surface. A module is not complete when only injected
   fakes work.
2. CLI, Interactive CLI, and Web consume the same Core interfaces and receive the same error
   semantics.
3. GitHub, Git, source resolution, lifecycle transactions, and operation runtime become deep
   modules. Callers must not reproduce their implementation details.
4. Every persistent write is locked, recoverable, and followed by postcondition verification.
5. Each roadmap phase has entry conditions, deliverables, validation, and an explicit exit gate.
6. Documentation and acceptance evidence ship with the behavior they describe.
7. Conditional architecture work does not block a stable release unless a demonstrated use case
   requires it.

## 3. Roadmap structure

The roadmap uses seven ordered phases.

| Phase | Name | Primary outcome |
| --- | --- | --- |
| 0 | Trusted baseline | Current production wiring and validation failures are visible and reproducible |
| 1 | GitHub/Git main journey | Connect, bind, sync, push, clone, install, and pull work through real adapters |
| 2 | Transactional lifecycle | Managed Restore and common backup/rollback semantics are complete |
| 3 | End-to-end acceptance | Main user journeys become repeatable release gates |
| 4 | Unified sources and surfaces | Source behavior is consistent and Web reaches CLI lifecycle parity |
| 5 | Reliability and diagnostics | Locking, migrations, events, doctor, and debug bundles protect operations |
| 6 | Distribution and P2 expansion | Packages are publishable and additional Agents can be added safely |

Phases are sequential at the exit-gate level. Tasks inside a phase may run in parallel only when
they do not change the same interface or persistent state model.

## 4. Target modules and seams

### 4.1 RepositorySync module

`RepositorySync` owns the complete repository transport journey behind a small interface:

```ts
interface RepositorySync {
  status(): Promise<RepositorySyncStatus>
  connect(options?: ConnectOptions): Promise<ConnectResult>
  disconnect(): Promise<DisconnectResult>
  sync(): Promise<SyncResult>
  pull(): Promise<PullResult>
  push(): Promise<PushResult>
}
```

Its implementation hides:

- GitHub Device Flow
- GitHub API and Client ID configuration
- Credential Store and TokenStore construction
- private repository creation or selection
- local Git initialization and origin binding
- remote and ahead/behind inspection
- credential injection for Git transport
- commit/pull/push ordering
- redacted error translation

CLI, Interactive CLI, and future Web synchronization routes call this interface. They do not
construct GitHub or Git collaborators independently.

### 4.2 SkillSourceResolver module

`SkillSourceResolver` presents one source model to every consumer:

```text
github / git / registry / local
```

Its interface covers parsing, normalization, provider selection, revision resolution, download,
latest-revision lookup, and materialization. Marketplace, Install, Reconcile, Diff, Merge, Restore,
and Outdated consume the same interface.

Provider-specific knowledge remains inside adapters. A caller never branches on provider id to
reconstruct URLs, revisions, or cache paths.

### 4.3 SkillLifecycle module

`SkillLifecycle` owns all mode-changing or content-replacing operations:

```ts
interface SkillLifecycle {
  fork(input: ForkInput): Promise<ForkResult>
  vendor(input: VendorInput): Promise<VendorResult>
  restore(input: RestoreInput): Promise<RestoreResult>
  merge(input: MergeInput): Promise<MergeResult>
  continueMerge(input: ContinueMergeInput): Promise<ContinueMergeResult>
  abortMerge(input: AbortMergeInput): Promise<AbortMergeResult>
  rollback(input: RollbackInput): Promise<RollbackResult>
}
```

The implementation owns bases, merge state, backups, atomic Manifest/Lockfile updates, library
materialization, Agent link reconciliation, and postcondition checks. Callers receive stable result
objects and recovery errors, not filesystem paths they must orchestrate themselves.

### 4.4 OperationRuntime module

`OperationRuntime` supplies shared guarantees to write-capable modules:

```ts
interface OperationRuntime {
  runExclusive<T>(operation: OperationDescriptor, run: () => Promise<T>): Promise<T>
  emitProgress(event: OperationEvent): void
  diagnose(options?: DiagnoseOptions): Promise<DiagnosisReport>
  createDebugBundle(options?: DebugBundleOptions): Promise<DebugBundleResult>
  migrate(options?: MigrationOptions): Promise<MigrationResult>
}
```

Its implementation owns the runtime lock, operation journal, progress events, structured redacted
logging, diagnosis probes, debug bundle generation, and schema migration registry.

The event mechanism starts in-process. Cross-process or network event transport is out of scope
until a demonstrated Web or TUI requirement needs it.

## 5. Production factory strategy

Each external seam has an explicit typed production factory and test adapters:

- `createRepositorySync()`
- `createSkillSourceResolver()`
- `createSkillLifecycle()`
- `createOperationRuntime()`

Factories accept the repository root, Skillbox home, machine environment, and narrowly scoped
platform collaborators. They return the public module interface.

The migration removes production reliance on:

- `Record<string, unknown>` module maps
- method-name guessing
- function arity checks
- stale expected interfaces documented in loader comments

Dependency injection remains supported at the module seam. Tests may provide in-memory or local
adapters, but at least one integration suite must exercise each default production factory.

## 6. Write transaction and recovery model

Every persistent write uses this operation flow:

```text
Validate
  → Acquire runtime lock
  → Resolve dependencies or source
  → Create recovery snapshot
  → Apply filesystem changes
  → Atomically update Manifest, Lockfile, or machine config
  → Reconcile Agent links
  → Verify postconditions
  → Record success and emit result
  → Release runtime lock
```

### 6.1 Failure semantics

- Validation or resolution failures produce no persistent change.
- Failures after snapshot creation restore files, Manifest, Lockfile, machine config, and Agent
  links to their recorded pre-operation state.
- GitHub authorization failure cannot create a remote, change origin, or persist a half-connected
  configuration.
- Git push failure preserves the valid local commit and returns a retryable result. It does not
  roll back Skill content.
- Merge conflicts are recoverable workflow state, not transaction failure. Merge state remains
  available for continue or abort.
- A process crash leaves a journal record. The next mutating command refuses unsafe continuation
  and directs the user to automatic recovery or `skillbox doctor`.
- Every surfaced error includes a stable code, phase, recoverability flag, recovery hint, and
  redacted context.

### 6.2 Sources of truth

- Manifest: desired Skills and Agent assignments
- Lockfile: resolved revision, integrity, upstream, and security metadata
- Machine config: local paths, Web settings, and non-sensitive GitHub metadata
- Credential Store: the only persistent token location
- Operation state: short-lived lock, journal, merge state, and backup index

No interface layer may infer a second truth source from rendered output or partially duplicated
state.

## 7. Phase design

### 7.1 Phase 0 — Trusted baseline

Entry condition: the refreshed gap analysis is accepted.

Deliverables:

- restore dependencies with the committed lockfile
- run lint, typecheck, tests, and build
- classify existing failures before feature changes
- add failing integration tests for the current GitHub production factory mismatch
- add tests proving Git status currently lacks real remote and ahead/behind facts
- inventory and remove misleading “not landed” comments only after confirming the real interface
- document the baseline command output and platform environment

Exit gate:

- all pre-existing failures are either fixed or recorded with an owner and phase
- production wiring failures are reproducible without fake providers
- no known regression is hidden by an unavailable dependency

### 7.2 Phase 1 — GitHub/Git main journey

Entry condition: Phase 0 exit gate passes.

Deliverables:

- implement the typed GitHub production factory
- map Core authorization states and Device Flow timing correctly
- add Git remote URL, upstream branch, ahead, and behind inspection
- make `status`, `pull`, and `push` consume truthful remote state
- extend connect to create or select a private repository
- initialize Git when appropriate and bind or verify origin safely
- inject Credential Bridge into private Git transport without persisting tokens
- preserve disconnect semantics: remove local credentials and connection metadata only
- expose RepositorySync to CLI and Interactive CLI
- update help text and README claims to match real behavior

Exit gate:

```text
connect → repository bind → sync → push
clone → connect/install → pull
```

Both journeys pass integration tests through default production wiring, with network calls replaced
only at the GitHub HTTP adapter seam.

### 7.3 Phase 2 — Transactional lifecycle

Entry condition: remote source materialization is reliable.

Deliverables:

- implement `restoreManagedSkill`
- introduce common snapshot and rollback primitives
- apply common transaction semantics to Restore, Vendor, Remove, and Merge where applicable
- define a user-facing rollback record and retention policy
- implement the first `skillbox rollback` interface for recorded lifecycle operations
- verify integrity, Lockfile metadata, library materialization, and Agent links after recovery
- preserve unresolved merge semantics for continue/abort

Exit gate:

- Convert to Fork and Restore Upstream both work from `skillbox edit`
- injected failures at every write phase restore the pre-operation state
- rollback cannot target an incomplete, expired, or unrelated operation

### 7.4 Phase 3 — End-to-end acceptance

Entry condition: P0 user journeys are functionally complete.

Deliverables:

- hermetic CLI E2E harness with temporary HOME and repository
- local bare Git remote for transport flows
- controlled Registry and GitHub HTTP adapters
- real CLI subprocess coverage for Local Management, Sync, Marketplace, and Lifecycle
- Windows, macOS, and Linux manual acceptance template
- recorded checks for Credential Store, link strategies, Agent detection, and browser launch
- CI jobs that separate fast module tests from slower E2E tests

Exit gate:

- every P0 journey is an automated release gate where platform-independent
- every platform-specific behavior has current acceptance evidence
- `docs/e2e-acceptance.md` records results rather than unchecked intentions

### 7.5 Phase 4 — Unified sources and surfaces

Entry condition: E2E harness can protect source and lifecycle changes.

Deliverables:

- define one canonical source type and serialization contract
- add Git source provider support to add/install/outdated/update
- map Registry manifest sources through provider dispatch
- decide GitLab and Bitbucket behavior through the Git provider rather than adding premature
  first-party registry integrations
- remove duplicate CLI and Web provider registration logic
- route Reconcile, Diff, Merge, Restore, and Marketplace through SkillSourceResolver
- add Web routes and UI for Fork, Vendor, Edit, Restore, Merge, Continue, Abort, and Rollback
- keep all mutation logic in Core modules

Exit gate:

- a supported source has consistent behavior across CLI, Interactive CLI, and Web
- unsupported sources fail at parse/resolve time with one shared error contract
- CLI and Web lifecycle actions produce equivalent persistent results

### 7.6 Phase 5 — Reliability and diagnostics

Entry condition: all main mutation flows use the target modules.

Deliverables:

- implement cross-process `runtime.lock` with stale-lock recovery
- add operation journal and crash recovery
- add Manifest, Lockfile, and Runtime Config migration registry
- expose `skillbox migrate`
- emit structured progress from Sync, Install, Reconcile, Registry, and Lifecycle
- connect verbosity levels to business events
- implement `skillbox doctor`
- implement redacted debug bundle generation
- validate that tokens, authorization headers, and credential-bearing URLs never appear in logs or
  bundles

Exit gate:

- concurrent mutation tests cannot corrupt persistent state
- old supported fixtures migrate deterministically and idempotently
- doctor identifies deliberately injected environment and consistency failures
- secret-leak regression tests pass

### 7.7 Phase 6 — Distribution and P2 expansion

Entry condition: Phases 0–5 pass release gates.

Deliverables:

- choose public npm package names and ownership
- remove `private` only from publishable packages
- add repository, homepage, bugs, license, provenance, and publish metadata
- validate workspace dependency rewriting and bundled Web assets with `pnpm pack`
- install packed artifacts in a clean temporary environment
- replace README repository placeholders and align roadmap status
- add Gemini CLI, OpenCode, Windsurf, and GitHub Copilot adapters one at a time
- reuse capability model, path override, detection, scan, link, unlink, and copy fallback suites

Conditional deliverables:

- Fullscreen TUI only when a validated workflow needs persistent multi-pane interaction
- standalone Web Server package only when independent deployment or reuse is required

Exit gate:

- packed CLI runs all supported local commands from a clean environment
- publish metadata is complete and release automation can produce a dry run
- every new Agent adapter passes the shared adapter conformance suite

## 8. Validation strategy

### 8.1 Module tests

Tests cross the public module interface and cover success, stable error codes, rollback, and
invariants. Internal adapters are tested only for behavior that varies by platform or provider.

### 8.2 Integration tests

Integration tests use temporary directories, the real filesystem, local Git repositories, bare
remotes, and controlled HTTP servers. Every default production factory has direct coverage.

### 8.3 Hermetic CLI E2E

The harness executes the packaged CLI as a subprocess and covers:

```text
create/import/install/status
connect/sync/pull/push
search/add/outdated/update
edit/fork/restore/diff/merge/continue/abort/rollback
```

Real interactive GitHub authorization is not automated. Device Flow protocol behavior is tested at
the HTTP adapter seam; repository orchestration and Git transport remain real and local.

### 8.4 Platform acceptance

Windows, macOS, and Linux acceptance records include date, operating system, Node/pnpm/Git version,
Credential Store result, link strategy result, detected Agents, browser launch result, and evidence
location.

### 8.5 Common quality gate

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

`pnpm pack` becomes mandatory when publishing work starts. Earlier phases may use a scoped pack
smoke test when their changes affect package contents.

## 9. Delivery strategy

- Each phase uses one or more focused branches and pull requests; the complete roadmap is never one
  large change.
- Interface changes land before caller migration only when temporary compatibility is explicit and
  tested. Otherwise interface and callers land atomically.
- Each behavior change starts with a failing test at the relevant seam.
- Documentation, errors, and acceptance evidence land in the same phase as the behavior.
- A phase cannot exit with a failing blocking test.
- A later phase may begin exploratory work, but it cannot merge changes that depend on an unmet
  earlier exit gate.

## 10. Risks and controls

| Risk | Control |
| --- | --- |
| GitHub production wiring exposes credentials | Typed factory, Credential Bridge, redaction tests, no token-bearing remote URLs |
| Source unification becomes a broad rewrite | Migrate one consumer at a time behind SkillSourceResolver with parity tests |
| Transaction abstraction changes stable flows | Introduce through Restore first, then migrate existing operations with fault injection |
| E2E becomes slow or flaky | Local remotes and controlled HTTP; keep live authorization in manual acceptance |
| runtime.lock strands users after crashes | Lock owner metadata, stale detection, journal recovery, doctor integration |
| Schema migrations destroy unknown data | Versioned fixtures, backup before migration, idempotence and downgrade diagnostics |
| P2 expansion delays release | Publish core product before optional Agent adapters and conditional package splits |

## 11. Completion definition

The optimization roadmap is complete when:

1. P0 GitHub/Git and Managed Restore journeys work through default production wiring.
2. Main user journeys are protected by hermetic E2E and current platform acceptance evidence.
3. Source and lifecycle behavior is consistent across CLI, Interactive CLI, and Web.
4. Mutating operations are locked, recoverable, migratable, and diagnosable.
5. Packages can be packed and installed from a clean environment with accurate release metadata.
6. P2 Agent adapters included in the roadmap pass a shared conformance suite.
7. Conditional TUI and Web Server splits are either justified and implemented or explicitly left
   out with no unmet user requirement.
