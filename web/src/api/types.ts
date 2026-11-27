/** Shapes returned by the server. Mirrors docs/contract.md. */

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Platform = 'react' | 'next' | 'vue' | 'astro' | 'svelte' | 'script';
export type Device = 'Desktop' | 'Mobile' | 'Tablet';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface Org {
  id: string;
  name: string;
}

export interface Me {
  user: User;
  org: Org;
}

export interface AuthStatus {
  signups: 'open' | 'closed';
  hasUsers: boolean;
}

export interface AuthSession {
  id: string;
  browser: string;
  os: string;
  ip: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  createdAt: number;
  expiresAt: number;
  link: string;
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  access: 'read' | 'write';
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export interface ProjectStats {
  recordings24h: number;
  live: number;
  avgDurationMs: number;
  storageBytes: number;
  recordings: number;
  series: number[];
  lastRecordingAt: number | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  platform: Platform;
  origin: string;
  timezone: string;
  publicKey: string;
  origins: string[];
  retentionDays: number;
  createdAt: number;
  /** Visit counting is on: the analytics pages exist only then. */
  analytics: boolean;
  stats: ProjectStats;
}

export interface PrivacySettings {
  maskAllText: boolean;
  maskAllInputs: boolean;
  blockMedia: boolean;
  recordCanvas: boolean;
  maskSelectors: string[];
  blockSelectors: string[];
  ignoreSelectors: string[];
  scrubEmails: boolean;
  scrubPhones: boolean;
  respectDnt: boolean;
  requireConsent: boolean;
  ip: 'full' | 'truncate' | 'none';
}

export interface UrlRule {
  type: 'contains' | 'matches';
  pattern: string;
}

export interface CaptureSettings {
  sampleRate: number;
  console: boolean;
  network: boolean;
  networkBodies: boolean;
  performance: boolean;
  frustration: boolean;
  crossOriginIframes: boolean;
  startOnError: boolean;
  minDurationMs: number;
  idleTimeoutMs: number;
  maxLengthMs: number;
  urlRules: UrlRule[];
}

/** A goal or funnel step: a page (a path, or a prefix ending in `*`) or a tracked event's name. */
export interface StepSetting {
  kind: 'page' | 'event';
  value: string;
}

export interface GoalSetting extends StepSetting {
  /** Leave empty for a new goal; the server names it. */
  id: string;
  name: string;
}

export interface FunnelSetting {
  id: string;
  name: string;
  /** 2 to 6 steps. */
  steps: StepSetting[];
}

export interface AnalyticsSettings {
  enabled: boolean;
  /** Count visits without storing anything in the browser; recording then waits for consent. */
  cookieless: boolean;
  /** Outbound links, downloads, email and phone links, form submissions. */
  autoEvents: boolean;
  heatmaps: boolean;
  retentionDays: 30 | 90 | 365 | 730;
  /** At most 20. Send the whole list to change it. */
  goals: GoalSetting[];
  /** At most 10. Send the whole list to change it. */
  funnels: FunnelSetting[];
}

export interface AlertSettings {
  /** Empty: nothing is sent. Reads `hidden` for people who are not admins. */
  webhookUrl: string;
  /** Signs deliveries when set. */
  secret: string;
  newErrors: boolean;
  /** Errors in an hour; 0 is off. */
  errorSpike: number;
  /** Rage clicks in an hour; 0 is off. */
  rageSpike: number;
  noTraffic: boolean;
  feedback: boolean;
  weeklyDigest: boolean;
}

export interface ProjectSettings {
  privacy: PrivacySettings;
  capture: CaptureSettings;
  retention: { days: 7 | 30 | 90 | 365; keepStarred: boolean };
  analytics: AnalyticsSettings;
  /** Where the feedback button sits on the site; `hidden` shows none. */
  feedback: { button: 'hidden' | 'bottom-right' | 'bottom-left' };
  alerts: AlertSettings;
  sharing: { enabled: boolean };
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  lastActiveAt: number | null;
}

export interface Visitor {
  id: string;
  name: string | null;
  email: string | null;
  anonymousId: string;
  externalId: string | null;
  country: string;
  countryCode: string;
  city: string;
  device: Device;
  browser: string;
  os: string;
  firstSeen: number;
  lastSeen: number;
  sessions: number;
}

export interface Recording {
  id: string;
  projectId: string;
  visitor: Visitor;
  startedAt: number;
  lastAt: number;
  durationMs: number;
  activeMs: number;
  pages: number;
  entry: string;
  exit: string;
  currentPath: string;
  clicks: number;
  keypresses: number;
  rageClicks: number;
  deadClicks: number;
  errors: number;
  viewport: string;
  sizeBytes: number;
  seen: boolean;
  live: boolean;
  starred: boolean;
  release: string | null;
  referrer: string | null;
}

export interface RecordingDetail extends Recording {
  newerId: string | null;
  olderId: string | null;
}

export interface RecordingList {
  items: Recording[];
  total: number;
  counts: { all: number; unwatched: number; friction: number; starred: number };
}

export interface RecordingEvents {
  // rrweb events, passed straight to the Replayer.
  events: { type: number; timestamp: number; data: unknown }[];
  lastSeq: number;
  complete: boolean;
}

export interface Tally {
  code?: string;
  name: string;
  count: number;
}

export interface Overview {
  totals: {
    recordings: number;
    today: number;
    avgDurationMs: number;
    avgActiveMs: number;
    frictionSessions: number;
    errorSessions: number;
    trendPercent: number;
  };
  days: { date: string; clean: number; friction: number; errors: number }[];
  topPages: { path: string; views: number; rage: number }[];
  devices: { name: string; count: number }[];
  countries: { code: string; name: string; count: number }[];
}

export interface Live {
  visitors: number;
  activeLast5m: number;
  pages: { path: string; count: number }[];
  countries: { code: string; name: string; count: number }[];
  sessions: Recording[];
}

export interface VisitorList {
  items: Visitor[];
  total: number;
  counts: { all: number; identified: number; anonymous: number };
}

export interface VisitorDetail {
  visitor: Visitor;
  stats: { sessions: number; totalDurationMs: number; rageClicks: number; errors: number };
  activity: { date: string; count: number }[];
  recordings: Recording[];
}

export interface StorageReport {
  totalBytes: number;
  recordings: number;
  projects: {
    id: string;
    name: string;
    platform: Platform;
    bytes: number;
    recordings: number;
    retentionDays: number;
  }[];
  ages: { label: string; bytes: number; expiringBytes: number }[];
  nextCleanupFreesBytes: number;
}

export interface Instance {
  version: string;
  commit: string;
  startedAt: number;
  roles: string[];
  database: { driver: string; version: string };
  storage: { driver: string; location: string };
  publicUrl: string;
  health: { name: string; status: 'healthy' | 'degraded' | 'down'; detail: string }[];
}
