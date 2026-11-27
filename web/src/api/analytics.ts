/**
 * Queries and mutations for analytics: traffic, events, errors, friction,
 * performance, funnels, heatmaps, returning visitors, notes, share links and
 * feedback. Keys live under `['projects', projectId, ...]`. See docs/contract.md.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './http';
import type { Recording } from './types';

export type Days = 1 | 7 | 14 | 30 | 90;

/** Narrows analytics to matching visits; the same names filter the recordings list. */
export interface VisitFilter {
  path?: string;
  entry?: string;
  exit?: string;
  /** A source host, or `Direct`. */
  referrer?: string;
  channel?: string;
  utmSource?: string;
  utmCampaign?: string;
  /** Country code. */
  country?: string;
  device?: string;
  browser?: string;
  os?: string;
  language?: string;
}

export interface TrafficTotals {
  visitors: number;
  visits: number;
  pageviews: number;
  /** Visits with one page view, no click or event, under 10 s engaged. */
  bounces: number;
  avgDurationMs: number;
  newVisitors: number;
  returning: number;
}

export interface Breakdown {
  name: string;
  visitors: number;
  visits: number;
}

export interface PageMetric {
  path: string;
  views: number;
  visitors: number;
  avgTimeMs: number;
  exits: number;
  /** Average deepest scroll in percent; 0 when unknown. */
  scroll: number;
}

export type StepKind = 'page' | 'event';

export interface Step {
  kind: StepKind;
  /** A path (a prefix when it ends in `*`) or an event name. */
  value: string;
}

export interface Goal extends Step {
  id: string;
  name: string;
}

export interface GoalStat extends Goal {
  conversions: number;
}

export interface Traffic {
  totals: TrafficTotals;
  previous: TrafficTotals;
  days: { date: string; visitors: number; visits: number; pageviews: number }[];
  sources: Breakdown[];
  channels: Breakdown[];
  campaigns: Breakdown[];
  pages: PageMetric[];
  entryPages: Breakdown[];
  exitPages: Breakdown[];
  /** `name` is a country code. */
  countries: Breakdown[];
  devices: Breakdown[];
  browsers: Breakdown[];
  systems: Breakdown[];
  languages: Breakdown[];
  goals: GoalStat[];
  /** Sources of the goal asked for with `goal`; empty otherwise. */
  goalSources: { name: string; count: number }[];
}

export interface EventStat {
  /** Automatic events start with `$`: `$outbound`, `$download`, `$email`, `$phone`, `$form`. */
  name: string;
  count: number;
  visits: number;
  value: number;
}

export interface ErrorGroup {
  fingerprint: string;
  message: string;
  source: string;
  count: number;
  visits: number;
  firstSeen: number;
  lastSeen: number;
  path: string;
}

export interface Occurrence {
  visitId: string;
  ts: number;
  path: string;
  label: string;
  /** JSON text: `{ "source": ..., "stack": ... }` for an error. */
  props: string;
  browser: string;
  os: string;
  release: string;
  /** A recording with id `visitId` exists; open it at `ts - startedAt`. */
  recorded: boolean;
  startedAt: number;
}

export interface ErrorDetail {
  group: ErrorGroup;
  occurrences: Occurrence[];
}

export interface PageFriction {
  path: string;
  visits: number;
  rage: number;
  dead: number;
  errors: number;
}

export interface ElementFriction {
  kind: 'rage' | 'dead';
  path: string;
  selector: string;
  label: string;
  count: number;
  visits: number;
  visitId: string;
  ts: number;
}

export interface Friction {
  pages: PageFriction[];
  elements: ElementFriction[];
}

export interface RequestStat {
  /** `GET api.acme.dev/cart` */
  name: string;
  count: number;
  failed: number;
  visits: number;
  avgMs: number;
  status: number;
  visitId: string;
  ts: number;
  lastSeen: number;
}

/** 75th percentiles; a negative value was never measured. `path: ''` is the whole site. */
export interface PageVitals {
  path: string;
  samples: number;
  lcp: number;
  inp: number;
  cls: number;
  fcp: number;
  ttfb: number;
}

export interface FunnelStep extends Step {
  visits: number;
  /** Visits that stopped after this step. */
  dropped: number;
  /** How many of them `useFunnelDropoffs` can list (at most 200). */
  watchable: number;
}

export interface Funnel {
  id: string;
  name: string;
  steps: FunnelStep[];
}

export type DeviceClass = '' | 'Desktop' | 'Tablet' | 'Mobile';

export interface Heatmap {
  clicks: number;
  /** `x` is percent of the page width (0 to 99), `y` steps of 10 page pixels. */
  cells: { x: number; y: number; n: number }[];
  elements: { selector: string; label: string; count: number }[];
  views: number;
  /** Views that reached 10%, 20% ... 100% of the page. */
  scroll: number[];
  /** Median page height and viewport width in pixels. */
  height: number;
  width: number;
  /** A recording that shows the page, to draw under the map; null when there is none. */
  snapshot: { recordingId: string; ts: number; startedAt: number } | null;
}

export interface Retention {
  daily: number;
  weekly: number;
  monthly: number;
  /** Oldest first. `active[k]` is how many of the cohort came back in week k (0 is its first week). */
  cohorts: { week: string; size: number; active: number[] }[];
}

export interface ReleaseStat {
  release: string;
  firstSeen: number;
  lastSeen: number;
  sessions: number;
  errors: number;
  friction: number;
}

export interface Account {
  domain: string;
  people: number;
  sessions: number;
  lastSeen: number;
}

export interface Note {
  id: string;
  recordingId: string;
  userId: string;
  author: string;
  atMs: number;
  body: string;
  createdAt: number;
}

export type ShareKind = 'recording' | 'dashboard';

export interface Share {
  id: string;
  kind: ShareKind;
  /** Empty for a dashboard link. */
  recordingId: string;
  startMs: number;
  createdBy: string;
  author: string;
  createdAt: number;
  expiresAt: number;
  /** Only in the answer to creating it: the token is not stored. */
  link?: string;
}

export interface Feedback {
  id: string;
  visitId: string;
  path: string;
  body: string;
  email: string;
  createdAt: number;
  seen: boolean;
  recorded: boolean;
  startedAt: number;
}

export interface FeedbackList {
  items: Feedback[];
  total: number;
  unseen: number;
}

/** What a public link shows. `recording` is set for a recording link. */
export interface SharedLink {
  kind: ShareKind;
  project: string;
  expiresAt: number;
  startMs: number;
  recording?: {
    startedAt: number;
    durationMs: number;
    viewport: string;
    pages: number;
    device: string;
    browser: string;
    os: string;
    live: boolean;
  };
}

const base = (projectId: string) => `/projects/${projectId}`;

export const analyticsKeys = {
  all: (projectId: string) => ['projects', projectId, 'analytics'] as const,
  traffic: (projectId: string, days: Days, filter: VisitFilter, goal: string) =>
    ['projects', projectId, 'analytics', 'traffic', days, filter, goal] as const,
  report: (projectId: string, name: string, ...rest: unknown[]) =>
    ['projects', projectId, 'analytics', name, ...rest] as const,
  notes: (projectId: string, recordingId: string) => ['projects', projectId, 'notes', recordingId] as const,
  shares: (projectId: string) => ['projects', projectId, 'shares'] as const,
  feedback: (projectId: string, page: number) => ['projects', projectId, 'feedback', page] as const,
  feedbackAll: (projectId: string) => ['projects', projectId, 'feedback'] as const,
};

/** A report that takes the window and, optionally, visit filters. */
function useReport<T>(projectId: string, name: string, path: string, days: Days, filter: VisitFilter = {}, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.report(projectId, name, days, filter),
    queryFn: () => api.get<T>(`${base(projectId)}${path}`, { days, ...filter }),
    placeholderData: keepPreviousData,
    enabled: enabled && Boolean(projectId),
  });
}

export function useTraffic(projectId: string, days: Days, filter: VisitFilter = {}, goal = '') {
  return useQuery({
    queryKey: analyticsKeys.traffic(projectId, days, filter, goal),
    queryFn: () => api.get<Traffic>(`${base(projectId)}/analytics`, { days, goal, ...filter }),
    placeholderData: keepPreviousData,
    enabled: Boolean(projectId),
  });
}

export const useEventNames = (projectId: string, days: Days) => useReport<EventStat[]>(projectId, 'events', '/events', days);

export const useErrorGroups = (projectId: string, days: Days) => useReport<ErrorGroup[]>(projectId, 'errors', '/errors', days);

export function useErrorGroup(projectId: string, fingerprint: string, days: Days) {
  return useQuery({
    queryKey: analyticsKeys.report(projectId, 'error', fingerprint, days),
    queryFn: () => api.get<ErrorDetail>(`${base(projectId)}/errors/${encodeURIComponent(fingerprint)}`, { days }),
    enabled: Boolean(projectId && fingerprint),
  });
}

export const useFriction = (projectId: string, days: Days) => useReport<Friction>(projectId, 'friction', '/friction', days);

export const useRequests = (projectId: string, days: Days) => useReport<RequestStat[]>(projectId, 'requests', '/requests', days);

export const useVitals = (projectId: string, days: Days) => useReport<PageVitals[]>(projectId, 'vitals', '/vitals', days);

export const useFunnels = (projectId: string, days: Days) => useReport<Funnel[]>(projectId, 'funnels', '/funnels', days);

/** Recordings of visits that reached `step` (0 is the first) and went no further. */
export function useFunnelDropoffs(projectId: string, funnelId: string, step: number, days: Days, enabled: boolean) {
  return useQuery({
    queryKey: analyticsKeys.report(projectId, 'dropoffs', funnelId, step, days),
    queryFn: () =>
      api.get<{ items: Recording[]; visits: number }>(`${base(projectId)}/funnels/${funnelId}/dropoffs`, { step, days }),
    enabled: enabled && Boolean(projectId && funnelId),
  });
}

export const useHeatmapPages = (projectId: string, days: Days) =>
  useReport<{ path: string; count: number }[]>(projectId, 'heatmaps', '/heatmaps', days);

export function useHeatmap(projectId: string, path: string, device: DeviceClass, days: Days) {
  return useQuery({
    queryKey: analyticsKeys.report(projectId, 'heatmap', path, device, days),
    queryFn: () => api.get<Heatmap>(`${base(projectId)}/heatmap`, { path, device, days }),
    placeholderData: keepPreviousData,
    enabled: Boolean(projectId && path),
  });
}

export function useRetention(projectId: string) {
  return useQuery({
    queryKey: analyticsKeys.report(projectId, 'retention'),
    queryFn: () => api.get<Retention>(`${base(projectId)}/retention`),
    enabled: Boolean(projectId),
  });
}

export const useReleases = (projectId: string, days: Days) => useReport<ReleaseStat[]>(projectId, 'releases', '/releases', days);

export function useAccounts(projectId: string) {
  return useQuery({
    queryKey: analyticsKeys.report(projectId, 'accounts'),
    queryFn: () => api.get<Account[]>(`${base(projectId)}/accounts`),
    enabled: Boolean(projectId),
  });
}

/* ------------------------------------------------------------------- Notes */

export function useNotes(projectId: string, recordingId: string) {
  return useQuery({
    queryKey: analyticsKeys.notes(projectId, recordingId),
    queryFn: () => api.get<Note[]>(`${base(projectId)}/recordings/${recordingId}/notes`),
    enabled: Boolean(projectId && recordingId),
  });
}

export function useCreateNote(projectId: string, recordingId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { atMs: number; body: string }) =>
      api.post<Note>(`${base(projectId)}/recordings/${recordingId}/notes`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: analyticsKeys.notes(projectId, recordingId) }),
  });
}

export function useDeleteNote(projectId: string, recordingId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) => api.delete(`${base(projectId)}/recordings/${recordingId}/notes/${noteId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: analyticsKeys.notes(projectId, recordingId) }),
  });
}

/* ------------------------------------------------------------- Share links */

/** Admins only; others get 403. */
export function useShares(projectId: string, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.shares(projectId),
    queryFn: () => api.get<Share[]>(`${base(projectId)}/shares`),
    enabled: enabled && Boolean(projectId),
  });
}

export interface NewShare {
  kind: ShareKind;
  recordingId?: string;
  startMs?: number;
  expiresInDays: 1 | 7 | 30;
}

/** The answer carries `link`, shown once. 403 when the project has public links off. */
export function useCreateShare(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: NewShare) => api.post<Share>(`${base(projectId)}/shares`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: analyticsKeys.shares(projectId) }),
  });
}

export function useDeleteShare(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => api.delete(`${base(projectId)}/shares/${shareId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: analyticsKeys.shares(projectId) }),
  });
}

/** Public: works signed out. 404 once the link expired, was revoked or its recording is gone. */
export function useSharedLink(token: string) {
  return useQuery({
    queryKey: ['shared', token] as const,
    queryFn: () => api.get<SharedLink>(`/shared/${token}`),
    retry: false,
  });
}

export function useSharedTraffic(token: string, days: Days, enabled: boolean) {
  return useQuery({
    queryKey: ['shared', token, 'analytics', days] as const,
    queryFn: () => api.get<Traffic>(`/shared/${token}/analytics`, { days }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/* ---------------------------------------------------------------- Feedback */

export function useFeedback(projectId: string, page: number) {
  return useQuery({
    queryKey: analyticsKeys.feedback(projectId, page),
    queryFn: () => api.get<FeedbackList>(`${base(projectId)}/feedback`, { page }),
    placeholderData: keepPreviousData,
    enabled: Boolean(projectId),
  });
}

export function useSetFeedbackSeen(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; seen: boolean }) =>
      api.patch(`${base(projectId)}/feedback/${input.id}`, { seen: input.seen }),
    onSuccess: () => client.invalidateQueries({ queryKey: analyticsKeys.feedbackAll(projectId) }),
  });
}

export function useDeleteFeedback(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`${base(projectId)}/feedback/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: analyticsKeys.feedbackAll(projectId) }),
  });
}

/* ------------------------------------------------------------------ Alerts */

/** Sends a test delivery to the project's webhook; fails with the reason when it is refused. */
export const useTestWebhook = (projectId: string) =>
  useMutation({ mutationFn: () => api.post(`${base(projectId)}/alerts/test`) });

/** Sends the weekly digest now. */
export const useSendDigest = (projectId: string) =>
  useMutation({ mutationFn: () => api.post(`${base(projectId)}/alerts/digest`) });

/** The recordings list with visit filters applied, as a link target. */
export function recordingsHref(projectId: string, filter: VisitFilter & { event?: string; eventPath?: string; sort?: 'score'; release?: string }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  const text = params.toString();
  return `/projects/${projectId}/recordings${text ? `?${text}` : ''}`;
}
