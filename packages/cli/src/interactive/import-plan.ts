import type { AgentInstalledSkill, ImportConflictInfo, ImportDecision } from '@skillbox/core'
import type { MenuOption } from './menu.js'

/** External skills found for one agent (used to build the import plan). */
export interface AgentScanned {
  agentId: string
  agentName: string
  detected: boolean
  installed: readonly AgentInstalledSkill[]
}

/** One row of the Import multi-select (M9.5). */
export interface ImportCandidate {
  name: string
  /** Absolute path of the first source directory seen for this skill. */
  sourceDir: string
  /** Agent ids holding an external copy named after this skill. */
  presentAgents: string[]
  /** True when the repository manifest already declares this alias. */
  alreadyManaged: boolean
}

/**
 * Builds the list of importable, unmanaged external skills. Hand-written
 * external skills (not owned by Skillbox) are never skipped; the use flat
 * `AgentInstalledSkill` entries directly.
 */
export function buildImportCandidates(
  scans: readonly AgentScanned[],
  manifestAliases: readonly string[],
): ImportCandidate[] {
  const byName = new Map<string, ImportCandidate>()
  for (const scan of scans) {
    if (!scan.detected) {
      continue
    }
    for (const skill of scan.installed) {
      if (skill.managedBySkillbox) {
        continue
      }
      const existing = byName.get(skill.name)
      if (existing !== undefined) {
        const agents = existing.presentAgents.includes(scan.agentId)
          ? existing.presentAgents
          : [...existing.presentAgents, scan.agentId]
        byName.set(skill.name, { ...existing, presentAgents: agents })
      } else {
        byName.set(skill.name, {
          name: skill.name,
          sourceDir: skill.path,
          presentAgents: [scan.agentId],
          alreadyManaged: manifestAliases.includes(skill.name),
        })
      }
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** A concrete import to run once the user picks candidates. */
export interface ImportPlanItem {
  alias: string
  sourceDir: string
  migrateAgents: string[]
}

/**
 * Translates the multi-select result into a runnable plan. External copies in
 * the agent directories are migrated to managed links after the repository
 * copy succeeds (M6.5).
 */
export function buildImportPlan(
  candidates: readonly ImportCandidate[],
  selectedNames: readonly string[],
): ImportPlanItem[] {
  const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]))
  const plan: ImportPlanItem[] = []
  for (const name of selectedNames) {
    const candidate = byName.get(name)
    if (candidate !== undefined) {
      plan.push({
        alias: name,
        sourceDir: candidate.sourceDir,
        migrateAgents: [...candidate.presentAgents],
      })
    }
  }
  return plan
}

/** Select options rendered to resolve an import conflict (M6.6). */
export function conflictResolutionOptions(conflict: ImportConflictInfo): MenuOption[] {
  return [
    { value: 'keep-existing', label: 'Keep the existing skill', hint: conflict.alias },
    { value: 'replace', label: 'Replace with the one being imported' },
    { value: 'import-both', label: 'Import both (alias gets a suffix)' },
    { value: 'skip', label: 'Skip this skill' },
  ]
}

/** Decodes a conflict-resolution choice back into a Core `ImportDecision`. */
export function decodeConflictSelection(choice: string, alias: string): ImportDecision {
  switch (choice) {
    case 'keep-existing':
      return { kind: 'use-existing' }
    case 'replace':
      return { kind: 'import-incoming' }
    case 'import-both':
      return { kind: 'import-both', alias: `${alias}-2` }
    case 'skip':
      return { kind: 'skip' }
    default:
      return { kind: 'skip' }
  }
}
