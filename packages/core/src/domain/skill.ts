export type SkillMode = 'managed' | 'forked' | 'local' | 'vendored'

export const SKILL_MODES: readonly SkillMode[] = ['managed', 'forked', 'local', 'vendored']

export type SkillStatus = 'ready' | 'modified' | 'outdated' | 'conflict' | 'missing' | 'broken'

export const SKILL_STATUSES: readonly SkillStatus[] = [
  'ready',
  'modified',
  'outdated',
  'conflict',
  'missing',
  'broken',
]

export interface GitHubSkillSource {
  type: 'github'
  repo: string
  path?: string
  ref?: string
}

export interface GitSkillSource {
  type: 'git'
  url: string
  path?: string
  ref?: string
}

export interface RegistrySkillSource {
  type: 'registry'
  registry: string
  package: string
  version?: string
}

export interface LocalSkillSource {
  type: 'local'
  path: string
}

export type SkillSource =
  GitHubSkillSource | GitSkillSource | RegistrySkillSource | LocalSkillSource

export interface SkillUpstream {
  source: SkillSource
  baseRevision: string
  latestRevision?: string
}

export interface Skill {
  id: string
  name: string
  description?: string
  mode: SkillMode
  source: SkillSource
  localPath: string
  revision?: string
  integrity?: string
  upstream?: SkillUpstream
  agents: string[]
  status: SkillStatus
}
