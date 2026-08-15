import * as path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { atomicWriteFile } from '../fs/atomic-write.js'
import { FilesystemService } from '../fs/filesystem-service.js'
import { ensureGitAttributes } from '../integrity/gitattributes.js'
import { SkillboxError, ErrorCode } from '../errors.js'
import { manifestMigrations } from '../migrations/manifest.js'
import {
  MANIFEST_FILE_NAME,
  MANIFEST_VERSION,
  skillboxManifestSchema,
  type ManifestSkill,
  type ManifestSkillSource,
  type ManifestSettings,
  type SkillboxManifest,
} from './schema.js'

/**
 * Serializes a manifest to a deterministic, canonical YAML document:
 * UTF-8, LF line endings, two-space indentation, fixed top-level field order
 * and fixed per-node field order. Skills keep their map insertion order.
 */
export function serializeManifest(manifest: SkillboxManifest): string {
  const parsed = skillboxManifestSchema.parse(manifest)
  return stringifyYaml(manifestToNode(parsed), { indent: 2, lineWidth: 0 })
}

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

function skillToNode(skill: ManifestSkill): Record<string, unknown> {
  const node: Record<string, unknown> = { source: sourceToNode(skill.source) }
  if (skill.mode !== undefined) node.mode = skill.mode
  if (skill.upstream !== undefined) node.upstream = sourceToNode(skill.upstream)
  if (skill.agents !== undefined) node.agents = [...skill.agents]
  if (skill.enabled !== undefined) node.enabled = skill.enabled
  if (skill.metadata !== undefined) node.metadata = skill.metadata
  return node
}

function settingsToNode(settings: ManifestSettings): Record<string, unknown> {
  const node: Record<string, unknown> = {}
  if (settings.defaultAgents !== undefined) node.defaultAgents = [...settings.defaultAgents]
  return node
}

function manifestToNode(manifest: SkillboxManifest): Record<string, unknown> {
  const node: Record<string, unknown> = { version: manifest.version }
  if (manifest.name !== undefined) node.name = manifest.name
  if (manifest.description !== undefined) node.description = manifest.description
  if (manifest.settings !== undefined) node.settings = settingsToNode(manifest.settings)

  const skills: Record<string, unknown> = {}
  for (const [alias, skill] of Object.entries(manifest.skills)) {
    skills[alias] = skillToNode(skill)
  }
  node.skills = skills

  if (manifest.agents !== undefined) {
    const agents: Record<string, unknown> = {}
    for (const [alias, config] of Object.entries(manifest.agents)) {
      const entry: Record<string, unknown> = {}
      if (config.enabled !== undefined) entry.enabled = config.enabled
      agents[alias] = entry
    }
    node.agents = agents
  }
  return node
}

function readUnknownManifest(file: string, fs: FilesystemService): Promise<unknown> {
  return fs.readFile(file).then(parseYaml)
}

/**
 * Reads and validates `skillbox.yaml` from a repository root.
 *
 * Throws:
 * - `MANIFEST_NOT_FOUND` when the file is missing
 * - `INVALID_MANIFEST` for invalid YAML or a schema-invalid document
 * - `UNSUPPORTED_MANIFEST_VERSION` for a version newer/different than 1
 */
export async function readManifest(repositoryRoot: string): Promise<SkillboxManifest> {
  const filePath = path.join(repositoryRoot, MANIFEST_FILE_NAME)
  const fs = new FilesystemService()

  if (!(await fs.exists(filePath))) {
    throw new SkillboxError(
      ErrorCode.MANIFEST_NOT_FOUND,
      `No ${MANIFEST_FILE_NAME} found in "${repositoryRoot}"`,
      { context: { path: filePath } },
    )
  }

  let document: unknown
  try {
    document = await readUnknownManifest(filePath, fs)
  } catch (error) {
    throw new SkillboxError(
      ErrorCode.INVALID_MANIFEST,
      `${MANIFEST_FILE_NAME} is not a valid YAML document`,
      { cause: error, context: { path: filePath } },
    )
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new SkillboxError(
      ErrorCode.INVALID_MANIFEST,
      `${MANIFEST_FILE_NAME} must be a YAML mapping`,
      { context: { path: filePath } },
    )
  }

  const version = (document as Record<string, unknown>).version
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new SkillboxError(
      ErrorCode.INVALID_MANIFEST,
      `${MANIFEST_FILE_NAME} must declare an integer "version"`,
      { context: { path: filePath, version } },
    )
  }
  if (version > MANIFEST_VERSION) {
    throw new SkillboxError(
      ErrorCode.UNSUPPORTED_MANIFEST_VERSION,
      `Unsupported manifest version ${version} (supported: ${MANIFEST_VERSION})`,
      { context: { path: filePath, version } },
    )
  }
  // Older manifests are migrated in memory (roadmap 5.2): the registry
  // applies registered migrations up to the current version; an unregistered
  // older version surfaces MIGRATION_MISSING instead of guessing. The next
  // write persists the migrated shape.
  const migrated = manifestMigrations.apply(
    version,
    MANIFEST_VERSION,
    document as Record<string, unknown>,
  )

  const result = skillboxManifestSchema.safeParse(migrated.document)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    throw new SkillboxError(
      ErrorCode.INVALID_MANIFEST,
      `${MANIFEST_FILE_NAME} failed schema validation`,
      { context: { path: filePath, issues } },
    )
  }
  return result.data
}

/**
 * Writes `manifest` to `skillbox.yaml` under `repositoryRoot` using an atomic
 * replace. Also ensures recommended `.gitattributes` exists in the repository
 * so text files are stored with LF on every platform.
 */
export async function writeManifest(
  repositoryRoot: string,
  manifest: SkillboxManifest,
): Promise<void> {
  const filePath = path.join(repositoryRoot, MANIFEST_FILE_NAME)
  await ensureGitAttributes(repositoryRoot)
  await atomicWriteFile(filePath, serializeManifest(manifest))
}
