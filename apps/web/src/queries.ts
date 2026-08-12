import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  type InstallInput,
  type RegistrySearchParams,
  type SettingsPatch,
  type ResolveSyncConflictsInput,
  type SkillStatusEntry,
} from './api.js'

export const queryKeys = {
  health: ['health'],
  skills: ['skills'],
  skill: (name: string) => ['skills', name],
  skillContent: (name: string) => ['skills', name, 'content'],
  skillDiff: (name: string) => ['skills', name, 'diff'],
  agents: ['agents'],
  status: ['status'],
  settings: ['settings'],
  /* V0.3 registry API */
  registrySearch: (params: RegistrySearchParams) => [
    'registry',
    'search',
    params.q ?? '',
    params.provider ?? '',
    params.sort ?? '',
    params.trending === true ? 'trending' : '',
    params.official === true ? 'official' : '',
  ],
  outdated: ['registry', 'outdated'],
  syncStatus: ['sync', 'status'],
  conflicts: ['sync', 'conflicts'],
  conflict: (id: string) => ['sync', 'conflicts', id],
} as const

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => api.health(),
    retry: 1,
  })
}

export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: () => api.skills(),
  })
}

export function useSkill(name: string | undefined) {
  const id = name ?? ''
  return useQuery({
    queryKey: queryKeys.skill(id),
    queryFn: () => api.skill(id),
    enabled: id !== '',
  })
}

export function useSkillContent(name: string | undefined) {
  const id = name ?? ''
  return useQuery({
    queryKey: queryKeys.skillContent(id),
    queryFn: () => api.skillContent(id),
    enabled: id !== '',
  })
}

/** Skill diff views against the upstream (M19.5). */
export function useSkillDiff(name: string | undefined) {
  const id = name ?? ''
  return useQuery({
    queryKey: queryKeys.skillDiff(id),
    queryFn: () => api.skillDiff(id),
    enabled: id !== '',
  })
}

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents,
    queryFn: () => api.agents(),
  })
}

export function useStatus() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: () => api.status(),
  })
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => api.settings(),
  })
}

export function useSaveSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.saveSettings(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings })
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
    },
  })
}

export function useCreateSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { name: string; description?: string; agents?: string[] }) => {
      const { agents, ...rest } = input
      const created = await api.createSkill(rest)
      for (const agent of agents ?? []) {
        await api.enableSkill(created.name, agent)
      }
      return created
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
    },
  })
}

export function useSaveSkillContent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; content: string }) =>
      api.saveSkillContent(input.name, input.content),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillContent(input.name) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.skill(input.name) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
    },
  })
}

export function useRemoveSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.removeSkill(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
    },
  })
}

export function useToggleSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; agent: string; enable: boolean }) =>
      input.enable
        ? api.enableSkill(input.name, input.agent)
        : api.disableSkill(input.name, input.agent),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skill(input.name) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
    },
  })
}

export function useReconcile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.reconcile(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
    },
  })
}

/* ---- V0.3 registry API (M14.7 Explore / M16.3 Updates) ---- */

/**
 * Aggregated registry search (M14.7). The caller debounces the input; every
 * param change is a fresh cached query key so the Explore filters compose.
 */
export function useRegistrySearch(params: RegistrySearchParams) {
  return useQuery({
    queryKey: queryKeys.registrySearch(params),
    queryFn: () => api.registrySearch(params),
  })
}

/** Installed-but-outdated skills (M16.3). */
export function useOutdated() {
  return useQuery({
    queryKey: queryKeys.outdated,
    queryFn: () => api.outdated(),
  })
}

export function useSyncStatus() {
  return useQuery({ queryKey: queryKeys.syncStatus, queryFn: () => api.syncStatus() })
}

export function useSync() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.sync(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus })
      void queryClient.invalidateQueries({ queryKey: queryKeys.conflicts })
    },
  })
}

export function useConflict(id: string | undefined) {
  const sessionId = id ?? ''
  return useQuery({
    queryKey: queryKeys.conflict(sessionId),
    queryFn: () => api.conflict(sessionId),
    enabled: sessionId !== '',
  })
}

export function useResolveConflicts(sessionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ResolveSyncConflictsInput) => api.resolveConflicts(sessionId, input),
    onSuccess: () => {
      for (const key of [
        queryKeys.syncStatus,
        queryKeys.conflicts,
        queryKeys.skills,
        queryKeys.agents,
        queryKeys.status,
      ]) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
    },
  })
}

export function useRestoreSyncSnapshot() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (snapshotId: string) => api.restoreSyncSnapshot(snapshotId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus })
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
    },
  })
}

/**
 * Remote install / update transaction (M15 + M16.3 Update button). On success
 * the library, status and outdated views are refreshed.
 */
export function useInstallRegistrySkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: InstallInput) => api.installRegistrySkill(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents })
      void queryClient.invalidateQueries({ queryKey: queryKeys.outdated })
      void queryClient.invalidateQueries({ queryKey: ['registry', 'search'] })
    },
  })
}

export function skillsForAgent(agentId: string, skills: SkillStatusEntry[]): SkillStatusEntry[] {
  return skills.filter((skill) => skill.agents.includes(agentId))
}
