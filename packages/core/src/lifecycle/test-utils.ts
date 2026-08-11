import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { computeSkillIntegrity } from '../integrity/canonical-hash.js'
import { createLockedSkill, emptyLockfile, writeLockfile } from '../lockfile/index.js'
import { addSkill, emptyManifest, writeManifest } from '../manifest/index.js'
import type { ManifestSkillSource } from '../manifest/schema.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'

export interface SeedManagedSkillOptions {
  alias?: string
  /** Extra files written into the managed runtime copy (`name` → content). */
  files?: Record<string, string>
  /** Manifest skill-level agents. */
  agents?: string[]
  /** When false, the managed runtime copy is not created on disk. */
  withManagedCopy?: boolean
  /** When true, the manifest entry exists but no locked entry is written. */
  noLockEntry?: boolean
}

export interface SeededSkill {
  alias: string
  revision: string
  upstream: ManifestSkillSource
  lockedIntegrity: string
  managedPath: string
  repositoryRoot: string
  homeRoot: string
  layout: ReturnType<typeof buildSkillboxHomeLayout>
}

/**
 * Seeds a repository with one managed skill: Manifest entry + Lockfile entry
 * (revision `abc123`, upstream recorded) plus the managed runtime copy at
 * `home/library/managed/<alias>`.
 */
export async function seedManagedSkill(
  dir: string,
  options: SeedManagedSkillOptions = {},
): Promise<SeededSkill> {
  const alias = options.alias ?? 'hello'
  const repositoryRoot = path.join(dir, 'repo')
  const homeRoot = path.join(dir, 'home')
  await fs.mkdir(repositoryRoot, { recursive: true })
  const layout = buildSkillboxHomeLayout(homeRoot)

  const managedPath = path.join(layout.library, 'managed', alias)
  if (options.withManagedCopy !== false) {
    await fs.mkdir(managedPath, { recursive: true })
    await fs.writeFile(path.join(managedPath, 'SKILL.md'), '# hello\n', 'utf8')
    await fs.writeFile(path.join(managedPath, 'notes.md'), 'original\n', 'utf8')
    for (const [name, content] of Object.entries(options.files ?? {})) {
      await fs.writeFile(path.join(managedPath, name), content, 'utf8')
    }
  }
  const lockedIntegrity =
    options.withManagedCopy === false ? 'sha256:missing' : await computeSkillIntegrity(managedPath)

  const upstream: ManifestSkillSource = {
    type: 'github',
    repo: 'acme/skillz',
    path: 'skills/hello',
    ref: 'main',
  }
  const manifest = addSkill(emptyManifest(), alias, {
    source: upstream,
    mode: 'managed',
    ...(options.agents !== undefined ? { agents: options.agents } : {}),
  })
  await writeManifest(repositoryRoot, manifest)

  const lockfile = emptyLockfile()
  if (options.noLockEntry !== true) {
    const locked = createLockedSkill({
      mode: 'managed',
      source: upstream,
      integrity: lockedIntegrity,
      revision: 'abc123',
    })
    locked.upstream = {
      source: upstream,
      baseRevision: 'abc123',
      baseIntegrity: lockedIntegrity,
      latestRevision: 'abc123',
    }
    lockfile.skills[alias] = locked
  }
  await writeLockfile(repositoryRoot, lockfile)

  return {
    alias,
    revision: 'abc123',
    upstream,
    lockedIntegrity,
    managedPath,
    repositoryRoot,
    homeRoot,
    layout,
  }
}

/** Edits the managed runtime copy so it diverges from the locked integrity. */
export async function modifyManagedCopy(seeded: SeededSkill): Promise<void> {
  await fs.writeFile(path.join(seeded.managedPath, 'edited.md'), 'changed\n', 'utf8')
}

/**
 * Fault-injecting filesystem for rollback tests: fails `copy` (and optionally
 * `remove`) for targets matched by `failCopyWhen` / `failRemoveWhen`.
 */
export class FailingFilesystem extends FilesystemService {
  constructor(
    private readonly failCopyWhen: (destination: string) => boolean = () => false,
    private readonly failRemoveWhen: (target: string) => boolean = () => false,
  ) {
    super()
  }

  override async copy(source: string, destination: string): Promise<void> {
    if (this.failCopyWhen(destination)) {
      throw new Error('injected copy failure')
    }
    return super.copy(source, destination)
  }

  override async remove(target: string): Promise<void> {
    if (this.failRemoveWhen(target)) {
      throw new Error('injected remove failure')
    }
    return super.remove(target)
  }
}

const slash = (value: string): string => value.replace(/\\/g, '/')

/** Matches destinations containing the given portable path fragment. */
export function matches(fragment: string): (target: string) => boolean {
  return (target: string) => slash(target).includes(fragment)
}
