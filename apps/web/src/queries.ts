import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type SettingsPatch, type SkillStatusEntry } from './api.js'

export const queryKeys = {
  health: ['health'],
  skills: ['skills'],
  skill: (name: string) => ['skills', name],
  skillContent: (name: string) => ['skills', name, 'content'],
  agents: ['agents'],
  status: ['status'],
  settings: ['settings'],
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

export function skillsForAgent(agentId: string, skills: SkillStatusEntry[]): SkillStatusEntry[] {
  return skills.filter((skill) => skill.agents.includes(agentId))
}
