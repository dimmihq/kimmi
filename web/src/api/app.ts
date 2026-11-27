/**
 * Queries and mutations for the main screens: auth, projects, recordings,
 * live and visitors. Every key lives under `['projects', projectId, ...]` so a
 * mutation can invalidate exactly the lists it changed. See docs/contract.md.
 */
import {
  type Query,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, ApiError } from './http';
import { keys, useProject, useProjects } from './queries';
import type {
  Device,
  Live,
  Me,
  Overview,
  Platform,
  Project,
  Recording,
  RecordingDetail,
  RecordingEvents,
  RecordingList,
  Role,
  Visitor,
  VisitorDetail,
  VisitorList,
} from './types';

/** `GET /invitations/lookup/{token}`; not in types.ts. */
export interface InvitationLookup {
  email: string;
  orgName: string;
  role: Role;
}

export type RecordingView = 'all' | 'unwatched' | 'friction' | 'starred';
export type DurationFilter = 'any' | 'short' | 'medium' | 'long';
export type DeviceFilter = 'any' | Device;

export interface RecordingFilters {
  view: RecordingView;
  q: string;
  duration: DurationFilter;
  device: DeviceFilter;
  rage: boolean;
  errors: boolean;
  page: number;
  limit: number;
  /**
   * More filters, sent as they are: `entry`, `exit`, `path`, `referrer`, `channel`, `utmSource`,
   * `utmCampaign`, `country`, `browser`, `os`, `language`, `release`, `event`, `eventPath`, `sort`.
   */
  extra?: Record<string, string>;
}

export const DEFAULT_RECORDING_FILTERS: RecordingFilters = {
  view: 'all',
  q: '',
  duration: 'any',
  device: 'any',
  rage: false,
  errors: false,
  page: 0,
  limit: 25,
};

export type VisitorKind = 'all' | 'identified' | 'anonymous';
export type VisitorSort = 'lastSeen' | 'sessions' | 'firstSeen';

export interface VisitorFilters {
  q: string;
  kind: VisitorKind;
  sort: VisitorSort;
  page: number;
  limit: number;
}

export const appKeys = {
  overview: (projectId: string, days: number) => ['projects', projectId, 'overview', days] as const,
  overviews: (projectId: string) => ['projects', projectId, 'overview'] as const,
  recordingLists: (projectId: string) => ['projects', projectId, 'recordings'] as const,
  recordingList: (projectId: string, filters: RecordingFilters) =>
    ['projects', projectId, 'recordings', filters] as const,
  recording: (projectId: string, recordingId: string) =>
    ['projects', projectId, 'recording', recordingId] as const,
  events: (projectId: string, recordingId: string) =>
    ['projects', projectId, 'events', recordingId] as const,
  live: (projectId: string) => ['projects', projectId, 'live'] as const,
  visitorLists: (projectId: string) => ['projects', projectId, 'visitors'] as const,
  visitorList: (projectId: string, filters: VisitorFilters) =>
    ['projects', projectId, 'visitors', filters] as const,
  visitors: (projectId: string) => ['projects', projectId, 'visitor'] as const,
  visitor: (projectId: string, visitorId: string) =>
    ['projects', projectId, 'visitor', visitorId] as const,
  invitation: (token: string) => ['invitation', token] as const,
};

/** Keeps the last page on screen while the next loads, within one project only. */
const sameProject =
  (projectId: string | undefined) =>
  <T>(previous: T | undefined, query: Query<T, Error, T, readonly unknown[]> | undefined) =>
    query?.queryKey[1] === projectId ? previous : undefined;

/** Who a visitor is, from the most to the least telling thing known about them. */
export const visitorLabel = (visitor: Pick<Visitor, 'name' | 'email' | 'externalId'>) =>
  visitor.name ?? visitor.email ?? (visitor.externalId ? `User ${visitor.externalId}` : 'Anonymous visitor');

export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/* -------------------------------------------------------------------- Auth */

function useSignedIn() {
  const client = useQueryClient();
  return (me: Me) => {
    client.setQueryData(keys.me, me);
    void client.invalidateQueries({ queryKey: keys.status });
  };
}

export function useLogin() {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) => api.post<Me>('/auth/login', body),
    onSuccess: signedIn,
  });
}

export function useSignup() {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: { name: string; email: string; password: string }) =>
      api.post<Me>('/auth/signup', body),
    onSuccess: signedIn,
  });
}

export function useInvitation(token: string) {
  return useQuery({
    queryKey: appKeys.invitation(token),
    queryFn: () => api.get<InvitationLookup>(`/invitations/lookup/${token}`),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useAcceptInvitation() {
  const signedIn = useSignedIn();
  return useMutation({
    mutationFn: (body: { token: string; name: string; password: string }) =>
      api.post<Me>('/invitations/accept', body),
    onSuccess: signedIn,
  });
}

/** Signs out and forgets everything cached for this user. */
export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/auth/logout'),
    onSettled: () => {
      client.clear();
      client.setQueryData(keys.me, null);
    },
  });
}

/* ---------------------------------------------------------------- Projects */

/**
 * The project named in the URL: taken from the project list when it is there,
 * fetched on its own only when the list has loaded without it.
 */
export function useRouteProject() {
  const { projectId } = useParams();
  const projects = useProjects();
  const listed = projects.data?.find((entry) => entry.id === projectId);
  const single = useProject(projectId && projects.isSuccess && !listed ? projectId : undefined);
  const project = listed ?? single.data;
  return {
    projectId,
    project,
    pending: Boolean(projectId) && !project && (projects.isPending || single.isPending),
    notFound: !project && isNotFound(single.error),
    error: project ? null : (single.error ?? projects.error),
    retry: () => (projects.isError ? projects.refetch() : single.refetch()),
  };
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; origin: string; platform: Platform }) =>
      api.post<Project>('/projects', body),
    onSuccess: (project) => {
      client.setQueryData(keys.project(project.id), project);
      void client.invalidateQueries({ queryKey: keys.projects, exact: true });
    },
  });
}

/** One project, polled until its first recording arrives. */
export function useProjectUntilRecorded(projectId: string | undefined) {
  return useQuery({
    queryKey: keys.project(projectId ?? ''),
    queryFn: () => api.get<Project>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
    refetchInterval: (query) => ((query.state.data?.stats.recordings ?? 0) > 0 ? false : 3000),
  });
}

export function useOverview(projectId: string, days: number) {
  return useQuery({
    queryKey: appKeys.overview(projectId, days),
    queryFn: () => api.get<Overview>(`/projects/${projectId}/overview`, { days }),
    placeholderData: sameProject(projectId),
  });
}

/* -------------------------------------------------------------- Recordings */

export function useRecordings(
  projectId: string | undefined,
  filters: RecordingFilters,
  options: { refetchInterval?: number; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: appKeys.recordingList(projectId ?? '', filters),
    queryFn: () =>
      api.get<RecordingList>(`/projects/${projectId}/recordings`, { ...filters, extra: undefined, ...filters.extra }),
    enabled: Boolean(projectId) && (options.enabled ?? true),
    placeholderData: sameProject(projectId),
    refetchInterval: options.refetchInterval,
  });
}

export function useRecording(projectId: string, recordingId: string) {
  return useQuery({
    queryKey: appKeys.recording(projectId, recordingId),
    queryFn: () => api.get<RecordingDetail>(`/projects/${projectId}/recordings/${recordingId}`),
  });
}

/**
 * Every event of a recording. The first fetch asks for everything
 * (`after=-1`); while the recording is still live it polls every 2 s for the
 * blocks after the last one it has and appends them.
 */
export function useRecordingEvents(projectId: string, recordingId: string) {
  const client = useQueryClient();
  const key = appKeys.events(projectId, recordingId);
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<RecordingEvents> => {
      const previous = client.getQueryData<RecordingEvents>(key);
      const next = await api.get<RecordingEvents>(
        `/projects/${projectId}/recordings/${recordingId}/events`,
        { after: previous?.lastSeq ?? -1 },
      );
      if (!previous) return next;
      if (next.events.length === 0 && next.complete === previous.complete) return previous;
      return {
        events: next.events.length ? [...previous.events, ...next.events] : previous.events,
        lastSeq: Math.max(previous.lastSeq, next.lastSeq),
        complete: next.complete,
      };
    },
    // Appending thousands of events: comparing them deeply every poll is waste.
    structuralSharing: false,
    staleTime: (query) => (query.state.data?.complete ? Number.POSITIVE_INFINITY : 0),
    refetchInterval: (query) => (query.state.data?.complete ? false : 2000),
  });
}

/** What a deleted recording or visitor changes: lists, totals and live. */
function invalidateRecordingViews(client: QueryClient, projectId: string) {
  void client.invalidateQueries({ queryKey: appKeys.recordingLists(projectId) });
  void client.invalidateQueries({ queryKey: appKeys.overviews(projectId) });
  void client.invalidateQueries({ queryKey: appKeys.live(projectId) });
  void client.invalidateQueries({ queryKey: keys.projects, exact: true });
}

export function useUpdateRecording(projectId: string, recordingId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { starred?: boolean; seen?: boolean }) =>
      api.patch<Recording>(`/projects/${projectId}/recordings/${recordingId}`, body),
    onSuccess: (recording) => {
      client.setQueryData<RecordingDetail>(appKeys.recording(projectId, recordingId), (old) =>
        old ? { ...old, ...recording } : old,
      );
      void client.invalidateQueries({ queryKey: appKeys.recordingLists(projectId) });
    },
  });
}

export function useDeleteRecording(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (recordingId: string) =>
      api.delete(`/projects/${projectId}/recordings/${recordingId}`),
    onSuccess: (_, recordingId) => {
      invalidateRecordingViews(client, projectId);
      void client.invalidateQueries({ queryKey: appKeys.visitors(projectId) });
      // The open player is leaving; mark it stale without refetching a 404.
      void client.invalidateQueries({
        queryKey: appKeys.recording(projectId, recordingId),
        refetchType: 'none',
      });
    },
  });
}

/* -------------------------------------------------------------------- Live */

export function useLive(projectId: string) {
  return useQuery({
    queryKey: appKeys.live(projectId),
    queryFn: () => api.get<Live>(`/projects/${projectId}/live`),
    refetchInterval: 3000,
  });
}

/* ---------------------------------------------------------------- Visitors */

export function useVisitors(projectId: string, filters: VisitorFilters) {
  return useQuery({
    queryKey: appKeys.visitorList(projectId, filters),
    queryFn: () => api.get<VisitorList>(`/projects/${projectId}/visitors`, { ...filters }),
    placeholderData: sameProject(projectId),
  });
}

export function useVisitor(projectId: string, visitorId: string) {
  return useQuery({
    queryKey: appKeys.visitor(projectId, visitorId),
    queryFn: () => api.get<VisitorDetail>(`/projects/${projectId}/visitors/${visitorId}`),
  });
}

export function useDeleteVisitor(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (visitorId: string) => api.delete(`/projects/${projectId}/visitors/${visitorId}`),
    onSuccess: (_, visitorId) => {
      invalidateRecordingViews(client, projectId);
      void client.invalidateQueries({ queryKey: appKeys.visitorLists(projectId) });
      void client.invalidateQueries({
        queryKey: appKeys.visitor(projectId, visitorId),
        refetchType: 'none',
      });
    },
  });
}
