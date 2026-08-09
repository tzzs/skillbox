import { describe, expect, it } from 'vitest'
import type { AgentInstalledSkill, ImportConflictInfo } from '@skillbox/core'
import {
  buildImportCandidates,
  buildImportPlan,
  conflictResolutionOptions,
  decodeConflictSelection,
  type AgentScanned,
} from './import-plan.js'

function skill(name: string, path: string, managed: boolean): AgentInstalledSkill {
  return { name, path, managedBySkillbox: managed }
}

function scan(
  agentId: string,
  agentName: string,
  installed: AgentInstalledSkill[],
  detected = true,
): AgentScanned {
  return { agentId, agentName, detected, installed }
}

describe('buildImportCandidates', () => {
  it('lists unmanaged external skills across agents', () => {
    const candidates = buildImportCandidates(
      [
        scan('claude', 'Claude Code', [skill('react', '/a/react', false)]),
        scan('codex', 'Codex', [skill('frontend-design', '/b/frontend-design', false)]),
      ],
      [],
    )
    expect(candidates.map((candidate) => candidate.name)).toEqual(['frontend-design', 'react'])
    expect(candidates[0]).toMatchObject({
      sourceDir: '/b/frontend-design',
      presentAgents: ['codex'],
      alreadyManaged: false,
    })
  })

  it('merges the same skill owned by several agents', () => {
    const candidates = buildImportCandidates(
      [
        scan('claude', 'Claude Code', [skill('react', '/a/react', false)]),
        scan('codex', 'Codex', [skill('react', '/b/react', false)]),
      ],
      [],
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.presentAgents).toEqual(['claude', 'codex'])
  })

  it('skips Skillbox-managed skills', () => {
    const candidates = buildImportCandidates(
      [scan('claude', 'Claude Code', [skill('react', '/a/react', true)])],
      [],
    )
    expect(candidates).toHaveLength(0)
  })

  it('skips undetected agents', () => {
    const candidates = buildImportCandidates(
      [scan('claude', 'Claude Code', [skill('react', '/a/react', false)], false)],
      [],
    )
    expect(candidates).toHaveLength(0)
  })

  it('flags skills already declared in the manifest', () => {
    const candidates = buildImportCandidates(
      [scan('claude', 'Claude Code', [skill('react', '/a/react', false)])],
      ['react'],
    )
    expect(candidates[0]?.alreadyManaged).toBe(true)
  })

  it('sorts the result by name', () => {
    const candidates = buildImportCandidates(
      [scan('claude', 'Claude Code', [skill('zeta', '/z', false), skill('alpha', '/a', false)])],
      [],
    )
    expect(candidates.map((candidate) => candidate.name)).toEqual(['alpha', 'zeta'])
  })
})

describe('buildImportPlan', () => {
  it('maps selected names to runnable imports', () => {
    const candidates = buildImportCandidates(
      [scan('claude', 'Claude Code', [skill('react', '/a/react', false)])],
      [],
    )
    const plan = buildImportPlan(candidates, ['react'])
    expect(plan).toEqual([{ alias: 'react', sourceDir: '/a/react', migrateAgents: ['claude'] }])
  })

  it('ignores names that were not offered', () => {
    const candidates = buildImportCandidates(
      [scan('claude', 'Claude Code', [skill('react', '/a/react', false)])],
      [],
    )
    expect(buildImportPlan(candidates, ['missing'])).toEqual([])
  })
})

describe('conflict resolution', () => {
  const conflict: ImportConflictInfo = {
    alias: 'react',
    kind: 'manifest',
    incomingIntegrity: 'abc',
    existingIntegrity: 'def',
    decisions: [
      { kind: 'use-existing' },
      { kind: 'import-incoming' },
      { kind: 'import-both', alias: 'react-2' },
      { kind: 'skip' },
    ],
  }

  it('offers the four resolution choices', () => {
    const options = conflictResolutionOptions(conflict).map((option) => option.value)
    expect(options).toEqual(['keep-existing', 'replace', 'import-both', 'skip'])
  })

  it('decodes each choice back to a Core decision', () => {
    expect(decodeConflictSelection('keep-existing', 'react')).toEqual({ kind: 'use-existing' })
    expect(decodeConflictSelection('replace', 'react')).toEqual({ kind: 'import-incoming' })
    expect(decodeConflictSelection('import-both', 'react')).toEqual({
      kind: 'import-both',
      alias: 'react-2',
    })
    expect(decodeConflictSelection('skip', 'react')).toEqual({ kind: 'skip' })
    expect(decodeConflictSelection('bogus', 'react')).toEqual({ kind: 'skip' })
  })
})
