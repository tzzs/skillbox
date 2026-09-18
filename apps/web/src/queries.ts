import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  type FleetHostInput,
  type FleetHostPatch,
  type FleetRunRequest,
  type InstallInput,
  type LifecycleOperationResult,
  type MergeAction,
  type RegistrySearchParams,
  type ResolveSyncConflictsInput,
  type SettingsPatch,
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
  fleetHosts: ['fleet', 'hosts'],
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

export function useRollbacks() {
  return useQuery({ queryKey: ['rollbacks'], queryFn: () => api.rollbacks() })
}

export function useRestoreRollback() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.restoreRollback(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
      void queryClient.invalidateQueries({ queryKey: queryKeys.status })
      void queryClient.invalidateQueries({ queryKey: ['rollbacks'] })
    },
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

interface ToggleSkillContext {
  previousSkill: SkillStatusEntry | undefined
  previousSkills: SkillStatusEntry[] | undefined
}

/**
 * Flips the button label/icon the instant it's clicked instead of waiting on
 * the round trip — this is the most-clicked mutation in the app, so a
 * flipped-then-flipped-back flash on error is a better trade than a spinner
 * on every click. Rolled back from the snapshot in `onError`.
 */
export function useToggleSkill() {
  const queryClient = useQueryClient()
  return useMutation<
    Awaited<ReturnType<typeof api.enableSkill>>,
    unknown,
    { name: string; agent: string; enable: boolean },
    ToggleSkillContext
  >({
    mutationFn: (input) =>
      input.enable
        ? api.enableSkill(input.name, input.agent)
        : api.disableSkill(input.name, input.agent),
    onMutate: async (input) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.skill(input.name) }),
        queryClient.cancelQueries({ queryKey: queryKeys.skills }),
      ])
      const previousSkill = queryClient.getQueryData<SkillStatusEntry>(queryKeys.skill(input.name))
      const previousSkills = queryClient.getQueryData<SkillStatusEntry[]>(queryKeys.skills)
      const applyToggle = (agents: string[]): string[] =>
        input.enable
          ? agents.includes(input.agent)
            ? agents
            : [...agents, input.agent]
          : agents.filter((agent) => agent !== input.agent)
      if (previousSkill !== undefined) {
        queryClient.setQueryData<SkillStatusEntry>(queryKeys.skill(input.name), {
          ...previousSkill,
          agents: applyToggle(previousSkill.agents),
        })
      }
      if (previousSkills !== undefined) {
        queryClient.setQueryData<SkillStatusEntry[]>(
          queryKeys.skills,
          previousSkills.map((skill) =>
            skill.name === input.name ? { ...skill, agents: applyToggle(skill.agents) } : skill,
          ),
        )
      }
      return { previousSkill, previousSkills }
    },
    onError: (_error, input, context) => {
      if (context?.previousSkill !== undefined) {
        queryClient.setQueryData(queryKeys.skill(input.name), context.previousSkill)
      }
      if (context?.previousSkills !== undefined) {
        queryClient.setQueryData(queryKeys.skills, context.previousSkills)
      }
    },
    onSettled: (_data, _error, input) => {
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

/**
 * Live event stream (GAP §4.4): subscribes to the web server's SSE endpoint
 * and reports the latest core event (install/reconcile progress) for a
 * lightweight activity indicator.
 */
export function useEventStream(): { latest: string | null } {
  const [latest, setLatest] = useState<string | null>(null)
  useEffect(() => {
    const source = new EventSource('/api/events')
    const show = (event: MessageEvent): void => {
      setLatest(`${event.type}: ${event.data}`)
    }
    for (const type of [
      'install:phase',
      'install:completed',
      'install:failed',
      'reconcile:started',
      'reconcile:completed',
    ]) {
      source.addEventListener(type, show)
    }
    return () => source.close()
  }, [])
  return { latest }
}

export function skillsForAgent(agentId: string, skills: SkillStatusEntry[]): SkillStatusEntry[] {
  return skills.filter((skill) => skill.agents.includes(agentId))
}

/* ---- V0.4 lifecycle API (M17 fork/vendor/restore, M20 merge) ---- */

/** Refreshes every skill-scoped view after a lifecycle mutation. */
function invalidateSkillViews(queryClient: ReturnType<typeof useQueryClient>, name: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.skill(name) })
  void queryClient.invalidateQueries({ queryKey: queryKeys.skillDiff(name) })
  void queryClient.invalidateQueries({ queryKey: queryKeys.skills })
  void queryClient.invalidateQueries({ queryKey: queryKeys.status })
}

/**
 * Fork / Vendor / Restore mutations (M17.1 / M18 / M17.3). A fork flips the
 * mode to `forked`, vendor freezes content as `vendored`, restore re-fetches
 * the pinned revision of a modified managed skill.
 */
export function useLifecycleAction(action: 'fork' | 'vendor' | 'restore') {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string): Promise<LifecycleOperationResult> => {
      if (action === 'fork') return api.forkSkill(name)
      if (action === 'vendor') return api.vendorSkill(name)
      return api.restoreSkill(name)
    },
    onSuccess: (_data, name) => invalidateSkillViews(queryClient, name),
  })
}

/** 3-way merge / continue / abort (M20.6). */
export function useMergeSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; action?: MergeAction }) =>
      api.mergeSkill(input.name, input.action),
    onSuccess: (_data, input) => invalidateSkillViews(queryClient, input.name),
  })
}

/* ---- Fleet API: multi-host SSH orchestration ---- */

/** The hosts configured in `.skillbox/fleet.yaml` (`[]` when the file doesn't exist yet). */
export function useFleetHosts() {
  return useQuery({
    queryKey: queryKeys.fleetHosts,
    queryFn: () => api.fleetHosts(),
  })
}

/** Runs `install` / `update` / `status` across the selected hosts over SSH. */
export function useFleetRun() {
  return useMutation({
    mutationFn: (input: FleetRunRequest) => api.fleetRun(input),
  })
}

/** Adds a host to `.skillbox/fleet.yaml`, creating the file if needed. */
export function useAddFleetHost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: FleetHostInput) => api.addFleetHost(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.fleetHosts })
    },
  })
}

/** Edits a host in `.skillbox/fleet.yaml`; `patch.name` renames it. */
export function useUpdateFleetHost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ name, patch }: { name: string; patch: FleetHostPatch }) =>
      api.updateFleetHost(name, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.fleetHosts })
    },
  })
}

/** Removes a host from `.skillbox/fleet.yaml`. */
export function useRemoveFleetHost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.removeFleetHost(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.fleetHosts })
    },
  })
}

/* ---- Multi-device sync API (RepositorySync) ---- */

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

/** Removes only local GitHub credentials/connection metadata — never touches the repository. */
export function useDisconnectSync() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.disconnectSync(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus })
    },
  })
}
