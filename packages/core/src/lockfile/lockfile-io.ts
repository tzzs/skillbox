import * as path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import type { ManifestSkillSource } from '../manifest/schema.js'
import {
  LOCKFILE_FILE_NAME,
  LOCKFILE_VERSION,
  skillboxLockfileSchema,
  type LockedSkill,
  type LockedUpstream,
  type SkillboxLockfile,
} from './schema.js'

function sourceToNode(source: ManifestSkillSource): Record<string, unknown> {
  switch (source.type) {
    case 'github': {
      const node: Record<string, unknown> = { type: 'github', repo: source.repo }
      if (source.path !== undefined) node.path = source.path
      if (source.ref !== undefined) node.ref = source.ref
      return node
    }
    case 'git': {
      const node: Record<string, unknown> = { type: 'git', url: source.url }
      if (source.path !== undefined) node.path = source.path
      if (source.ref !== undefined) node.ref = source.ref
      return node
    }
    case 'registry': {
      const node: Record<string, unknown> = {
        type: 'registry',
        registry: source.registry,
        package: source.package,
      }
      if (source.version !== undefined) node.version = source.version
      return node
    }
    case 'local': {
      return { type: 'local', path: source.path }
    }
  }
}

function lockedUpstreamToNode(upstream: LockedUpstream): Record<string, unknown> {
  const node: Record<string, unknown> = {
    source: sourceToNode(upstream.source),
    baseRevision: upstream.baseRevision,
  }
  if (upstream.baseIntegrity !== undefined) node.baseIntegrity = upstream.baseIntegrity
  if (upstream.latestRevision !== undefined) node.latestRevision = upstream.latestRevision
  return node
}

function lockedSkillToNode(skill: LockedSkill): Record<string, unknown> {
  const node: Record<string, unknown> = {
    mode: skill.mode,
    source: sourceToNode(skill.source),
    integrity: skill.integrity,
  }
  if (skill.revision !== undefined) node.revision = skill.revision
  if (skill.upstream !== undefined) node.upstream = lockedUpstreamToNode(skill.upstream)
  if (skill.security !== undefined) node.security = { ...skill.security }
  if (skill.metadata !== undefined) node.metadata = skill.metadata
  return node
}

function lockfileToNode(lockfile: SkillboxLockfile): Record<string, unknown> {
  const node: Record<string, unknown> = { lockfileVersion: lockfile.lockfileVersion }
  if (lockfile.generatedBy !== undefined) node.generatedBy = lockfile.generatedBy
  const skills: Record<string, unknown> = {}
  for (const [alias, skill] of Object.entries(lockfile.skills)) {
    skills[alias] = lockedSkillToNode(skill)
  }
  node.skills = skills
  return node
}

/**
 * Serializes a lockfile to a deterministic YAML document: UTF-8, LF line
 * endings, two-space indentation, fixed top-level field order. Locked skills
 * keep their map insertion order.
 */
export function serializeLockfile(lockfile: SkillboxLockfile): string {
  const parsed = skillboxLockfileSchema.parse(lockfile)
  return stringifyYaml(lockfileToNode(parsed), { indent: 2, lineWidth: 0 })
}

/**
 * Reads and validates `skillbox.lock` from a repository root.
 *
 * Throws:
 * - `LOCKFILE_NOT_FOUND` when the file is missing
 * - `INVALID_LOCKFILE` for invalid YAML or a schema-invalid document
 * - `UNSUPPORTED_LOCKFILE_VERSION` for a version newer/different than 1
 */
export async function readLockfile(repositoryRoot: string): Promise<SkillboxLockfile> {
  const filePath = path.join(repositoryRoot, LOCKFILE_FILE_NAME)
  const fs = new FilesystemService()

  if (!(await fs.exists(filePath))) {
    throw new SkillboxError(
      ErrorCode.LOCKFILE_NOT_FOUND,
      `No ${LOCKFILE_FILE_NAME} found in "${repositoryRoot}"`,
      { context: { path: filePath } },
    )
  }

  let document: unknown
  try {
    document = parseYaml(await fs.readFile(filePath))
  } catch (error) {
    throw new SkillboxError(
      ErrorCode.INVALID_LOCKFILE,
      `${LOCKFILE_FILE_NAME} is not a valid YAML document`,
      { cause: error, context: { path: filePath } },
    )
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new SkillboxError(
      ErrorCode.INVALID_LOCKFILE,
      `${LOCKFILE_FILE_NAME} must be a YAML mapping`,
      { context: { path: filePath } },
    )
  }

  const version = (document as Record<string, unknown>).lockfileVersion
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new SkillboxError(
      ErrorCode.INVALID_LOCKFILE,
      `${LOCKFILE_FILE_NAME} must declare an integer "lockfileVersion"`,
      { context: { path: filePath, version } },
    )
  }
  if (version !== LOCKFILE_VERSION) {
    throw new SkillboxError(
      ErrorCode.UNSUPPORTED_LOCKFILE_VERSION,
      `Unsupported lockfile version ${version} (supported: ${LOCKFILE_VERSION})`,
      { context: { path: filePath, version } },
    )
  }

  const result = skillboxLockfileSchema.safeParse(document)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    throw new SkillboxError(
      ErrorCode.INVALID_LOCKFILE,
      `${LOCKFILE_FILE_NAME} failed schema validation`,
      { context: { path: filePath, issues } },
    )
  }
  return result.data
}

/**
 * Writes `lockfile` to `skillbox.lock` under `repositoryRoot` using an atomic
 * replace. Deterministic: the same input produces byte-identical output.
 */
export async function writeLockfile(
  repositoryRoot: string,
  lockfile: SkillboxLockfile,
): Promise<void> {
  const filePath = path.join(repositoryRoot, LOCKFILE_FILE_NAME)
  await atomicWriteFile(filePath, serializeLockfile(lockfile))
}

/**
 * Idempotent variant: only writes when the serialized form changed. Returns
 * `true` when the file was rewritten. Reconcile relies on this so that a
 * second run produces "no changes".
 */
export async function writeLockfileIfChanged(
  repositoryRoot: string,
  lockfile: SkillboxLockfile,
): Promise<boolean> {
  const filePath = path.join(repositoryRoot, LOCKFILE_FILE_NAME)
  const serialized = serializeLockfile(lockfile)
  const fs = new FilesystemService()
  if (await fs.exists(filePath)) {
    if ((await fs.readFile(filePath)) === serialized) {
      return false
    }
  }
  await atomicWriteFile(filePath, serialized)
  return true
}
