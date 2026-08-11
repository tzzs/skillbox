import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentRegistry, ErrorCode, SkillboxError } from '@skillbox/core'
import { CANCEL_RESULT, type InteractivePrompt } from '../interactive/prompts.js'

/** Cancel sentinel recognized by `isCancelResult` (see prompts.ts). */
export const CANCEL = CANCEL_RESULT
import type {
  InstallResult,
  InstallService,
  InstallSkillInput,
  NormalizedSource,
  RegistryClient,
  RegistryProvider,
  RegistrySearchResult,
  ResolvedSource,
  SecurityScanResult,
  SecurityScanner,
  SourceParser,
  UpdateSkillInput,
} from './types.js'

/** Test doubles shared by the marketplace service / wiring tests. */

export class FakeSourceParser implements SourceParser {
  constructor(
    private readonly normalized: NormalizedSource | undefined,
    private readonly error?: Error,
  ) {}

  async parse(source: string): Promise<NormalizedSource> {
    if (this.error !== undefined) {
      throw this.error
    }
    if (this.normalized === undefined) {
      throw new SkillboxError(ErrorCode.SOURCE_INVALID, `Cannot parse "${source}" — unknown format`)
    }
    return this.normalized
  }
}

/** Registry provider fake; `download` writes nothing (the review uses it). */
export class FakeProvider implements RegistryProvider {
  id = 'github'

  constructor(public revision = 'abc1234def5678') {}

  async search(_query: string): Promise<RegistrySearchResult[]> {
    return []
  }

  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    return { source, revision: this.revision }
  }

  async download(_source: NormalizedSource, _revision: string, _targetDir: string): Promise<void> {}

  async getLatestRevision(_source: NormalizedSource): Promise<string> {
    return this.revision
  }
}

export class FakeRegistryClient implements RegistryClient {
  searchResults: RegistrySearchResult[] = []
  /** repo -> latest revision; missing repo makes getLatestRevision fail. */
  latestByRepo = new Map<string, string>()
  resolveError?: Error
  /** providerFor failure (e.g. no provider registered for a source type). */
  providerError?: Error

  constructor(public revision = 'abc1234def5678') {}

  async search(_query: string): Promise<RegistrySearchResult[]> {
    return this.searchResults
  }

  async resolve(source: NormalizedSource): Promise<ResolvedSource> {
    if (this.resolveError !== undefined) {
      throw this.resolveError
    }
    return { source, revision: this.revision }
  }

  async getLatestRevision(source: NormalizedSource): Promise<string> {
    const repo = source.type === 'github' ? source.repo : source.type
    const latest = this.latestByRepo.get(repo)
    if (latest === undefined) {
      throw new Error(`registry unreachable for ${repo}`)
    }
    return latest
  }

  async providerFor(_source: NormalizedSource): Promise<RegistryProvider> {
    if (this.providerError !== undefined) {
      throw this.providerError
    }
    return new FakeProvider(this.revision)
  }
}

/** Agent 2's static scanner fake; the configured review is returned. */
export class FakeScanner implements SecurityScanner {
  scanCalls: string[] = []
  review: SecurityScanResult = { risk: 'low', findings: [], filesScanned: 1, block: false }
  scanError?: Error

  async scan(directory: string): Promise<SecurityScanResult> {
    this.scanCalls.push(directory)
    if (this.scanError !== undefined) {
      throw this.scanError
    }
    return this.review
  }
}

export class FakeInstaller implements InstallService {
  installCalls: InstallSkillInput[] = []
  updateCalls: UpdateSkillInput[] = []
  /** Installer-level failure to throw instead of completing the transaction. */
  installError?: Error
  updateError?: Error
  /** Hook that runs inside updateSkill (lets tests rewrite the lockfile). */
  afterUpdate?: () => Promise<void>
  clearCacheCalls = 0
  cleared = 3

  async installSkill(input: InstallSkillInput): Promise<InstallResult> {
    this.installCalls.push(input)
    if (this.installError !== undefined) {
      throw this.installError
    }
    return {
      alias: input.alias ?? 'react-best-practices',
      mode: 'managed',
      source: input.source,
      revision: 'abc1234def5678',
      integrity: 'sha256:test-integrity',
      security: { risk: 'low', scannedAt: '2026-01-01T00:00:00.000Z' },
      agents: [...(input.targetAgents ?? [])],
      materializedPath: '/tmp/skillbox/library/react-best-practices',
      cacheHit: false,
    }
  }

  async updateSkill(input: UpdateSkillInput): Promise<void> {
    this.updateCalls.push(input)
    if (this.updateError !== undefined) {
      throw this.updateError
    }
    if (this.afterUpdate !== undefined) {
      await this.afterUpdate()
    }
  }

  async clearCache(): Promise<{ cleared: number }> {
    this.clearCacheCalls += 1
    return { cleared: this.cleared }
  }
}

/** Records prompts; select/confirm results are configurable per test. */
export class FakePrompts implements InteractivePrompt {
  calls: string[] = []
  selectResult: string | symbol = 'claude'
  confirmResult: boolean | symbol = false

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
    options: readonly { value: string }[]
  }): Promise<string | symbol> {
    this.calls.push(`select:${options.options.map((option) => option.value).join(',')}`)
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

export interface Fixture {
  repositoryRoot: string
  homeRoot: string
  base: string
  /** Overwrites skillbox.lock with the given YAML. */
  writeLockfile(yaml: string): void
  /** Overwrites skillbox.yaml with the given YAML. */
  writeManifest(yaml: string): void
  cleanup(): void
}

/** Temp repo + home; no files until the caller writes them. */
export function createFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skillbox-marketplace-'))
  const repositoryRoot = path.join(base, 'repo')
  const homeRoot = path.join(base, 'home')
  fs.mkdirSync(repositoryRoot)
  fs.mkdirSync(homeRoot)
  return {
    repositoryRoot,
    homeRoot,
    base,
    writeLockfile: (yaml: string) =>
      fs.writeFileSync(path.join(repositoryRoot, 'skillbox.lock'), yaml),
    writeManifest: (yaml: string) =>
      fs.writeFileSync(path.join(repositoryRoot, 'skillbox.yaml'), yaml),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

export const MANAGED_LOCKFILE = (revision: string): string => `lockfileVersion: 1
skills:
  react-best-practices:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
    revision: ${revision}
    integrity: hash-1
  local-skill:
    mode: local
    source:
      type: local
      path: skills/local-skill
    integrity: hash-2
  forked-skill:
    mode: forked
    source:
      type: local
      path: skills/forked-skill
    integrity: hash-3
`

export const LINKED_MANIFEST = `version: 1
skills:
  react-best-practices:
    mode: managed
    source:
      type: github
      repo: vercel-labs/agent-skills
      path: skills/react-best-practices
    agents:
      - claude
`

/**
 * Registry with adapters pre-registered. `detectedIds` controls which agents
 * report as detected; ids registered but not detected stay available.
 */
export function agentRegistry(
  ids: readonly string[] = ['claude', 'codex'],
  detectedIds: readonly string[] = [],
): AgentRegistry {
  const registry = new AgentRegistry()
  for (const id of ids) {
    const detected = detectedIds.includes(id)
    registry.register({
      id,
      name: id,
      capabilities: {
        supportsGlobalSkills: true,
        supportsProjectSkills: false,
        supportsSymlinks: true,
        supportsNestedSkillDirectories: false,
        requiresRestartAfterChange: false,
      },
      detect: async () => ({
        detected,
        confidence: detected ? 'high' : 'low',
        skillDirectories: [],
      }),
      getSkillDirectories: async () => [],
      scanSkills: async () => [],
      linkSkill: async () => {},
      unlinkSkill: async () => ({ name: id, path: '', removed: false, reason: 'not_found' }),
    })
  }
  return registry
}
