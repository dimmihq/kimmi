/** Queries every part of the dashboard shares: who you are and your projects. */
import { QueryClient, useQuery } from '@tanstack/react-query';
import { api, ApiError } from './http';
import type { AuthStatus, Me, Project } from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, error) =>
        !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

export const keys = {
  me: ['me'] as const,
  status: ['auth-status'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
};

/** The signed-in user and their workspace; `data` is null when signed out. */
export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export function useAuthStatus() {
  return useQuery({
    queryKey: keys.status,
    queryFn: () => api.get<AuthStatus>('/auth/status'),
  });
}

export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: () => api.get<Project[]>('/projects'),
    refetchInterval: 15_000,
  });
}

/** One project, served from the list when it is already loaded. */
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: keys.project(id ?? ''),
    queryFn: () => api.get<Project>(`/projects/${id}`),
    enabled: Boolean(id),
    initialData: () =>
      queryClient.getQueryData<Project[]>(keys.projects)?.find((entry) => entry.id === id),
  });
}
