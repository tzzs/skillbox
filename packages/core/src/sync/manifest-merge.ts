import type { ManifestSkill, SkillboxManifest } from '../manifest/index.js'
import type { ConflictResolution, SyncConflict } from './types.js'

export interface ManifestMergeInput {
  base: SkillboxManifest
  local: SkillboxManifest
  remote: SkillboxManifest
}

export interface ManifestMergeResult {
  manifest: SkillboxManifest
  conflicts: SyncConflict[]
  automaticallyMerged: number
}

/** Semantic three-way merge for the desired state in skillbox.yaml. */
export class ManifestMergeService {
  merge(input: ManifestMergeInput): ManifestMergeResult {
    const aliases = new Set([
      ...Object.keys(input.base.skills),
      ...Object.keys(input.local.skills),
      ...Object.keys(input.remote.skills),
    ])
    const skills: Record<string, ManifestSkill> = {}
    const conflicts: SyncConflict[] = []
    let automaticallyMerged = 0

    for (const alias of [...aliases].sort()) {
      const result = mergeSkill(alias, input.base.skills[alias], input.local.skills[alias], input.remote.skills[alias])
      if (result.skill !== undefined) skills[alias] = result.skill
      conflicts.push(...result.conflicts)
      if (result.automatic) automaticallyMerged += 1
    }

    return {
      manifest: {
        ...input.base,
        ...mergeTopLevel(input.base, input.local, input.remote),
        skills,
      },
      conflicts,
      automaticallyMerged,
    }
  }
}

export function mergeManifests(input: ManifestMergeInput): ManifestMergeResult {
  return new ManifestMergeService().merge(input)
}

type SkillResult = { skill?: ManifestSkill; conflicts: SyncConflict[]; automatic: boolean }

function mergeSkill(alias: string, base: ManifestSkill | undefined, local: ManifestSkill | undefined, remote: ManifestSkill | undefined): SkillResult {
  if (equal(local, remote)) return { ...(local === undefined ? {} : { skill: local }), conflicts: [], automatic: !equal(base, local) }
  if (equal(base, local)) return { ...(remote === undefined ? {} : { skill: remote }), conflicts: [], automatic: true }
  if (equal(base, remote)) return { ...(local === undefined ? {} : { skill: local }), conflicts: [], automatic: true }

  if (local === undefined || remote === undefined) {
    const modified = local ?? remote
    return {
      ...(modified === undefined ? {} : { skill: modified }),
      automatic: false,
      conflicts: [conflict(alias, 'delete-modify', undefined, base, local, remote, ['local', 'remote', 'keep-both', 'delete', 'restore'], 'restore', true)],
    }
  }

  const merged: Record<string, unknown> = {}
  const conflicts: SyncConflict[] = []
  for (const field of new Set([...Object.keys(base ?? {}), ...Object.keys(local), ...Object.keys(remote)])) {
    const result = mergeField(alias, field, base?.[field as keyof ManifestSkill], local[field as keyof ManifestSkill], remote[field as keyof ManifestSkill])
    if (result.conflict !== undefined) conflicts.push(result.conflict)
    else if (result.value !== undefined) merged[field] = result.value
  }
  return { skill: merged as ManifestSkill, conflicts, automatic: conflicts.length === 0 }
}

function mergeField(alias: string, field: string, base: unknown, local: unknown, remote: unknown): { value?: unknown; conflict?: SyncConflict } {
  if (field === 'agents') {
    if (equal(local, remote)) return { value: normalizeAgents(local) }
    if (equal(base, local)) return { value: normalizeAgents(remote) }
    if (equal(base, remote)) return { value: normalizeAgents(local) }
    return mergeAgentSet(alias, base, local, remote)
  }

  if (equal(local, remote)) return { value: local }
  if (equal(base, local)) return { value: remote }
  if (equal(base, remote)) return { value: local }

  if (field === 'metadata') return mergeMetadata(alias, field, base, local, remote)

  if (field === 'mode') return { conflict: conflict(alias, 'mode', field, base, local, remote, ['local', 'remote', 'keep-both'], undefined, true) }
  if (field === 'source') return { conflict: conflict(alias, 'source', field, base, local, remote, ['local', 'remote', 'keep-both'], 'keep-both', true) }
  if (field === 'upstream') return { conflict: conflict(alias, 'lifecycle', field, base, local, remote, ['local', 'remote', 'keep-both'], undefined, true) }
  return { conflict: conflict(alias, 'manifest-field', field, base, local, remote, ['local', 'remote', 'merged'], undefined, false) }
}

function mergeAgentSet(alias: string, base: unknown, local: unknown, remote: unknown): { value?: unknown; conflict?: SyncConflict } {
  if (!arraysOfStrings(base) || !arraysOfStrings(local) || !arraysOfStrings(remote)) {
    return { conflict: conflict(alias, 'manifest-field', 'agents', base, local, remote, ['local', 'remote', 'merged'], undefined, false) }
  }
  const merged = new Set<string>()
  for (const agent of new Set([...base, ...local, ...remote])) {
    const result = mergeMembership(base.includes(agent), local.includes(agent), remote.includes(agent))
    if (result === undefined) {
      return { conflict: conflict(alias, 'manifest-field', `agents.${agent}`, base, local, remote, ['local', 'remote', 'merged'], undefined, false) }
    }
    if (result) merged.add(agent)
  }
  return { value: [...merged].sort() }
}

function mergeMembership(base: boolean, local: boolean, remote: boolean): boolean | undefined {
  if (local === remote || local === base) return remote
  if (remote === base) return local
  return undefined
}

function mergeMetadata(alias: string, field: string, base: unknown, local: unknown, remote: unknown): { value?: unknown; conflict?: SyncConflict } {
  if (!record(base) || !record(local) || !record(remote)) return { conflict: conflict(alias, 'manifest-field', field, base, local, remote, ['local', 'remote', 'merged'], undefined, false) }
  const result: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const child = mergeMetadataValue(alias, `${field}.${key}`, base[key], local[key], remote[key])
    if (child.conflict !== undefined) return child
    if (child.value !== undefined) result[key] = child.value
  }
  return { value: result }
}

function mergeMetadataValue(alias: string, field: string, base: unknown, local: unknown, remote: unknown): { value?: unknown; conflict?: SyncConflict } {
  if (equal(local, remote)) return { value: local }
  if (equal(base, local)) return { value: remote }
  if (equal(base, remote)) return { value: local }
  if (record(base) && record(local) && record(remote)) return mergeMetadata(alias, field, base, local, remote)
  return { conflict: conflict(alias, 'manifest-field', field, base, local, remote, ['local', 'remote', 'merged'], undefined, false) }
}

function mergeTopLevel(base: SkillboxManifest, local: SkillboxManifest, remote: SkillboxManifest): Partial<SkillboxManifest> {
  const merged: Partial<SkillboxManifest> = { version: base.version }
  for (const field of ['name', 'description', 'settings'] as const) {
    const value = mergeScalar(base[field], local[field], remote[field])
    if (value !== undefined) merged[field] = value as never
  }
  return merged
}

function mergeScalar(base: unknown, local: unknown, remote: unknown): unknown {
  if (equal(local, remote)) return local
  if (equal(base, local)) return remote
  if (equal(base, remote)) return local
  return base
}

function conflict(alias: string, type: SyncConflict['type'], field: string | undefined, base: unknown, local: unknown, remote: unknown, allowedResolutions: ConflictResolution[], recommendedResolution: ConflictResolution | undefined, destructive: boolean): SyncConflict {
  return {
    id: `${alias}:${field ?? type}`,
    type,
    skillAlias: alias,
    ...(field === undefined ? {} : { field }),
    base: { value: base, preview: preview(base) },
    local: { value: local, preview: preview(local) },
    remote: { value: remote, preview: preview(remote) },
    allowedResolutions,
    ...(recommendedResolution === undefined ? {} : { recommendedResolution }),
    destructive,
  }
}

function preview(value: unknown): string {
  const serialized = stableStringify(value)
  return serialized.length > 512 ? `${serialized.slice(0, 509)}...` : serialized
}

function equal(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function arraysOfStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function normalizeAgents(value: unknown): unknown {
  return arraysOfStrings(value) ? [...value].sort() : value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
