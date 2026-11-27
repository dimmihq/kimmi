/** Queries and mutations behind the account, workspace and project settings. */
import {
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from './http';
import { keys } from './queries';
import type {
  ApiToken,
  AuthSession,
  Instance,
  Invitation,
  Me,
  Project,
  ProjectMember,
  ProjectSettings,
  Role,
  StorageReport,
  User,
} from './types';

export const settingsKeys = {
  sessions: ['me', 'sessions'] as const,
  preferences: ['me', 'preferences'] as const,
  members: ['members'] as const,
  invitations: ['invitations'] as const,
  tokens: ['tokens'] as const,
  storage: ['storage'] as const,
  instance: ['instance'] as const,
  projectSettings: (projectId: string) => ['project-settings', projectId] as const,
  projectMembers: (projectId: string) => ['project-members', projectId] as const,
};

/** Owners and admins manage people; members and viewers only read. */
export const canManage = (role: Role | undefined) => role === 'owner' || role === 'admin';

/**
 * A mutation that shows its result in the cache before the server answers,
 * puts the old value back when it fails, and refetches once the last of a
 * burst of changes has settled.
 */
function useOptimistic<T, V, R>({
  queryKey,
  mutationFn,
  apply,
  onSuccess,
}: {
  queryKey: QueryKey;
  mutationFn: (variables: V) => Promise<R>;
  apply: (current: T, variables: V) => T;
  onSuccess?: (result: R, variables: V) => void;
}) {
  const client = useQueryClient();
  const mutationKey = ['optimistic', ...queryKey];
  return useMutation({
    mutationKey,
    mutationFn,
    onMutate: async (variables: V) => {
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<T>(queryKey);
      if (previous !== undefined) client.setQueryData<T>(queryKey, apply(previous, variables));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous !== undefined) client.setQueryData<T>(queryKey, context.previous);
    },
    onSuccess: (result, variables) => onSuccess?.(result, variables),
    onSettled: () => {
      if (client.isMutating({ mutationKey }) === 1) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
}

/* ----------------------------------------------------------------- Account */

export function useUpdateMe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; email?: string }) => api.patch<User>('/me', body),
    onSuccess: (user) => {
      client.setQueryData<Me | null>(keys.me, (me) => (me ? { ...me, user } : me));
      client.setQueryData<User[]>(settingsKeys.members, (list) =>
        list?.map((entry) => (entry.id === user.id ? user : entry)),
      );
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { current: string; next: string }) => api.post<void>('/me/password', body),
  });
}

export function useSessions() {
  return useQuery({
    queryKey: settingsKeys.sessions,
    queryFn: () => api.get<AuthSession[]>('/me/sessions'),
  });
}

export function useEndSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/me/sessions/${id}`),
    onSuccess: (_result, id) => {
      client.setQueryData<AuthSession[]>(settingsKeys.sessions, (list) =>
        list?.filter((entry) => entry.id !== id),
      );
    },
  });
}

/* ------------------------------------------------------------- Preferences */

export interface Preferences {
  /** An IANA zone, or `browser` for the zone of the browser in use. */
  timezone: string;
  clock24: boolean;
  playerSpeed: 1 | 2 | 4;
  skipInactivity: boolean;
  autoplayNext: boolean;
  mouseTrail: boolean;
  /** Saved views of the recordings list, per project: a name and the list's query string. */
  savedViews?: Record<string, { name: string; query: string }[]>;
}

export const DEFAULT_PREFERENCES: Preferences = {
  timezone: 'browser',
  clock24: true,
  playerSpeed: 1,
  skipInactivity: true,
  autoplayNext: false,
  mouseTrail: true,
};

/** Your preferences, with defaults for anything never saved. */
export function usePreferences() {
  return useQuery({
    queryKey: settingsKeys.preferences,
    queryFn: async (): Promise<Preferences> => ({
      ...DEFAULT_PREFERENCES,
      ...(await api.get<Partial<Preferences> | null>('/me/preferences')),
    }),
    staleTime: 60_000,
  });
}

/** Saves the whole preferences object; the server stores what it is given. */
export function useSavePreferences() {
  return useOptimistic<Preferences, Preferences, Preferences>({
    queryKey: settingsKeys.preferences,
    mutationFn: (next) => api.put<Preferences>('/me/preferences', next),
    apply: (_current, next) => next,
  });
}

/* -------------------------------------------------------------------- Team */

export function useMembers() {
  return useQuery({
    queryKey: settingsKeys.members,
    queryFn: () => api.get<User[]>('/members'),
  });
}

export function useChangeMemberRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api.patch<User>(`/members/${id}`, { role }),
    onSuccess: (user) => {
      client.setQueryData<User[]>(settingsKeys.members, (list) =>
        list?.map((entry) => (entry.id === user.id ? user : entry)),
      );
    },
  });
}

export function useRemoveMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/members/${id}`),
    onSuccess: (_result, id) => {
      client.setQueryData<User[]>(settingsKeys.members, (list) =>
        list?.filter((entry) => entry.id !== id),
      );
      void client.invalidateQueries({ queryKey: ['project-members'] });
    },
  });
}

export function useInvitations() {
  return useQuery({
    queryKey: settingsKeys.invitations,
    queryFn: () => api.get<Invitation[]>('/invitations'),
  });
}

export function useCreateInvitation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: Role }) =>
      api.post<{ invitation: Invitation; link: string }>('/invitations', body),
    onSuccess: ({ invitation }) => {
      client.setQueryData<Invitation[]>(settingsKeys.invitations, (list) =>
        list ? [...list.filter((entry) => entry.id !== invitation.id), invitation] : list,
      );
    },
  });
}

export function useRevokeInvitation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/invitations/${id}`),
    onSuccess: (_result, id) => {
      client.setQueryData<Invitation[]>(settingsKeys.invitations, (list) =>
        list?.filter((entry) => entry.id !== id),
      );
    },
  });
}

/* ------------------------------------------------------------------ Tokens */

export function useTokens() {
  return useQuery({
    queryKey: settingsKeys.tokens,
    queryFn: () => api.get<ApiToken[]>('/tokens'),
  });
}

export function useCreateToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; access: ApiToken['access']; expiresInDays: number | null }) =>
      api.post<{ token: ApiToken; secret: string }>('/tokens', body),
    onSuccess: ({ token }) => {
      client.setQueryData<ApiToken[]>(settingsKeys.tokens, (list) =>
        list ? [token, ...list] : list,
      );
    },
  });
}

export function useRevokeToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tokens/${id}`),
    onSuccess: (_result, id) => {
      client.setQueryData<ApiToken[]>(settingsKeys.tokens, (list) =>
        list?.filter((entry) => entry.id !== id),
      );
    },
  });
}

/* ---------------------------------------------------------------- Instance */

export function useStorage() {
  return useQuery({
    queryKey: settingsKeys.storage,
    queryFn: () => api.get<StorageReport>('/storage'),
  });
}

export function useRunCleanup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ freedBytes: number; deleted: number }>('/storage/cleanup'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: settingsKeys.storage });
      void client.invalidateQueries({ queryKey: keys.projects });
    },
  });
}

export function useInstance() {
  return useQuery({
    queryKey: settingsKeys.instance,
    queryFn: () => api.get<Instance>('/instance'),
    refetchInterval: 10_000,
  });
}

/* ---------------------------------------------------------------- Projects */

/** Writes a project the server returned into the detail and the list. */
function useStoreProject() {
  const client = useQueryClient();
  return (project: Project) => {
    // Keep the stats we have if a mutation answers without them.
    const merge = (current: Project | undefined): Project => ({
      ...project,
      stats: project.stats ?? current?.stats,
    });
    client.setQueryData<Project>(keys.project(project.id), merge);
    client.setQueryData<Project[]>(keys.projects, (list) =>
      list?.map((entry) => (entry.id === project.id ? merge(entry) : entry)),
    );
  };
}

export function useUpdateProject(projectId: string) {
  const store = useStoreProject();
  return useMutation({
    mutationFn: (body: { name?: string; slug?: string; timezone?: string }) =>
      api.patch<Project>(`/projects/${projectId}`, body),
    onSuccess: store,
  });
}

export function useSetOrigins(projectId: string) {
  const store = useStoreProject();
  return useMutation({
    mutationFn: (origins: string[]) => api.put<Project>(`/projects/${projectId}/origins`, { origins }),
    onSuccess: store,
  });
}

export function useRotateKey(projectId: string) {
  const store = useStoreProject();
  return useMutation({
    mutationFn: () => api.post<Project>(`/projects/${projectId}/rotate-key`),
    onSuccess: store,
  });
}

export function useDeleteProject(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/projects/${projectId}`),
    onSuccess: () => {
      client.setQueryData<Project[]>(keys.projects, (list) =>
        list?.filter((entry) => entry.id !== projectId),
      );
      client.removeQueries({ queryKey: keys.project(projectId) });
      client.removeQueries({ queryKey: settingsKeys.projectSettings(projectId) });
      client.removeQueries({ queryKey: settingsKeys.projectMembers(projectId) });
      void client.invalidateQueries({ queryKey: settingsKeys.storage });
    },
  });
}

/* --------------------------------------------------------- Project settings */

export function useProjectSettings(projectId: string) {
  return useQuery({
    queryKey: settingsKeys.projectSettings(projectId),
    queryFn: () => api.get<ProjectSettings>(`/projects/${projectId}/settings`),
    enabled: Boolean(projectId),
  });
}

/** Part of the settings: the server deep-merges it into what it has. */
export type SettingsPatch = { [K in keyof ProjectSettings]?: Partial<ProjectSettings[K]> };

const mergeSettings = (current: ProjectSettings, patch: SettingsPatch): ProjectSettings => ({
  privacy: { ...current.privacy, ...patch.privacy },
  capture: { ...current.capture, ...patch.capture },
  retention: { ...current.retention, ...patch.retention },
  analytics: { ...current.analytics, ...patch.analytics },
  feedback: { ...current.feedback, ...patch.feedback },
  alerts: { ...current.alerts, ...patch.alerts },
  sharing: { ...current.sharing, ...patch.sharing },
});

export function useUpdateProjectSettings(projectId: string) {
  const client = useQueryClient();
  return useOptimistic<ProjectSettings, SettingsPatch, ProjectSettings>({
    queryKey: settingsKeys.projectSettings(projectId),
    mutationFn: (patch) => api.patch<ProjectSettings>(`/projects/${projectId}/settings`, patch),
    apply: mergeSettings,
    // Retention also shows on the project and in the storage report; whether
    // visits are counted decides which pages the project has.
    onSuccess: (_settings, patch) => {
      const counting = patch.analytics?.enabled;
      if (counting !== undefined) {
        // The sidebar follows at once, before the refetch answers.
        const set = (project: Project) =>
          project.id === projectId ? { ...project, analytics: counting } : project;
        client.setQueryData<Project>(keys.project(projectId), (project) => project && set(project));
        client.setQueryData<Project[]>(keys.projects, (projects) => projects?.map(set));
      }
      if (!patch.retention && counting === undefined) return;
      void client.invalidateQueries({ queryKey: keys.project(projectId), exact: true });
      void client.invalidateQueries({ queryKey: keys.projects, exact: true });
      if (patch.retention) void client.invalidateQueries({ queryKey: settingsKeys.storage });
    },
  });
}

/** After recordings are deleted: the project's stats, its lists and storage. */
function useRecordingsGone(projectId: string) {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: keys.project(projectId) });
    void client.invalidateQueries({ queryKey: keys.projects, exact: true });
    void client.invalidateQueries({ queryKey: settingsKeys.storage });
  };
}

export function useEraseVisitor(projectId: string) {
  const gone = useRecordingsGone(projectId);
  return useMutation({
    mutationFn: (query: string) =>
      api.post<{ deleted: number }>(`/projects/${projectId}/visitors/erase`, { query }),
    onSuccess: gone,
  });
}

export function useDeleteRecordings(projectId: string) {
  const gone = useRecordingsGone(projectId);
  return useMutation({
    mutationFn: () => api.post<{ deleted: number }>(`/projects/${projectId}/delete-recordings`, {}),
    onSuccess: gone,
  });
}

/* ---------------------------------------------------------- Project members */

export function useProjectMembers(projectId: string) {
  return useQuery({
    queryKey: settingsKeys.projectMembers(projectId),
    queryFn: () => api.get<ProjectMember[]>(`/projects/${projectId}/members`),
    enabled: Boolean(projectId),
  });
}

export function useAddProjectMember(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { userId: string; role: Role }) =>
      api.post<ProjectMember>(`/projects/${projectId}/members`, body),
    onSuccess: (member) => {
      client.setQueryData<ProjectMember[]>(settingsKeys.projectMembers(projectId), (list) =>
        list ? [...list.filter((entry) => entry.userId !== member.userId), member] : list,
      );
    },
  });
}

export function useChangeProjectMemberRole(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api.patch<ProjectMember>(`/projects/${projectId}/members/${userId}`, { role }),
    onSuccess: (member) => {
      client.setQueryData<ProjectMember[]>(settingsKeys.projectMembers(projectId), (list) =>
        list?.map((entry) => (entry.userId === member.userId ? member : entry)),
      );
    },
  });
}

export function useRemoveProjectMember(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
    onSuccess: (_result, userId) => {
      client.setQueryData<ProjectMember[]>(settingsKeys.projectMembers(projectId), (list) =>
        list?.filter((entry) => entry.userId !== userId),
      );
    },
  });
}
