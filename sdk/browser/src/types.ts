export interface InitOptions {
  /** Project public key, `km_pub_...`. */
  key: string;
  /** Base URL of the kimmi server, for example `http://localhost:8700`. */
  host: string;
  /** Release or version of the host app, shown on recordings. */
  release?: string;
  /**
   * Your own scrubbing, run after the built-in rules on every recorded string outside the DOM:
   * console output, network URLs and bodies, errors, navigations, click text and analytics hits. It must not throw.
   */
  scrub?: (text: string) => string;
}

export interface Traits {
  email?: string;
  name?: string;
  [key: string]: unknown;
}

export interface Identity {
  id: string;
  email?: string;
  name?: string;
  traits: Record<string, unknown>;
}

export type UrlRuleType = 'contains' | 'matches' | 'exact' | 'startsWith' | 'endsWith' | 'regex';

export interface UrlRule {
  type: UrlRuleType;
  pattern: string;
}

export interface PrivacyConfig {
  maskAllText: boolean;
  maskAllInputs: boolean;
  blockMedia: boolean;
  recordCanvas: boolean;
  maskSelectors: string[];
  blockSelectors: string[];
  ignoreSelectors: string[];
  respectDnt: boolean;
  requireConsent: boolean;
  ip: string;
  /** Replace email addresses in console, network and error text with `[email]`. */
  scrubEmails: boolean;
  /** Replace phone numbers in console, network and error text with `[phone]`. */
  scrubPhones: boolean;
}

export interface CaptureConfig {
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

export interface AnalyticsConfig {
  enabled: boolean;
  /** Nothing is kept in the browser's storage; the recorder then waits for `optIn()`. */
  cookieless: boolean;
  /** Outbound links, downloads, email and phone links, and form submits become events. */
  autoEvents: boolean;
  /** Every click is sent with its position. */
  heatmaps: boolean;
}

export interface FeedbackConfig {
  /** Show the feedback button without a `showFeedback()` call. */
  /** Where the feedback button sits; `hidden` (or missing) shows none. */
  button?: 'hidden' | 'bottom-right' | 'bottom-left';
}

export interface RemoteConfig {
  recording: boolean;
  sampleRate: number;
  privacy: PrivacyConfig;
  capture: CaptureConfig;
  analytics: AnalyticsConfig;
  feedback: FeedbackConfig;
}

/** One analytics event inside a hit. Keys that do not apply are left out. */
export interface HitEvent {
  /** Timestamp, ms. */
  t: number;
  /** Kind: page, leave, click, track, error, rage, dead, request or vital. */
  k: string;
  /** Path of the page it happened on. */
  p?: string;
  n?: string | undefined;
  l?: string | undefined;
  v?: number | undefined;
  x?: number | undefined;
  y?: number | undefined;
  w?: number | undefined;
  num?: number | undefined;
  d?: Record<string, unknown> | undefined;
}

export interface Hit {
  v: 1;
  visitId: string;
  anonymousId: string;
  startedAt: number;
  url: string;
  landing: string;
  referrer: string;
  viewport: { w: number; h: number };
  language: string;
  timezone: string;
  release?: string;
  events: HitEvent[];
}

export interface FeedbackOptions {
  email?: string;
}

export interface BatchCounts {
  events: number;
  clicks: number;
  keypresses: number;
  rageClicks: number;
  deadClicks: number;
  errors: number;
  pageviews: number;
  activeMs: number;
}

export interface BatchMeta {
  v: 1;
  sessionId: string;
  windowId: string;
  seq: number;
  anonymousId: string;
  identity?: Identity;
  startedAt: number;
  firstTs: number;
  lastTs: number;
  url: string;
  path: string;
  referrer: string;
  viewport: { w: number; h: number };
  language: string;
  timezone: string;
  release?: string;
  counts: BatchCounts;
  paths: string[];
}

/** An rrweb event as the SDK handles it: only the fields it reads are typed. */
export interface RecordedEvent {
  type: number;
  timestamp: number;
  data: unknown;
}

export interface CustomEventPayloads {
  navigate: { href: string; path: string; title: string };
  console: { level: 'log' | 'info' | 'warn' | 'error'; text: string; source: string };
  network: {
    method: string;
    url: string;
    status: number;
    ms: number;
    size: number;
    kind: 'fetch' | 'xhr';
    requestBody?: string;
    responseBody?: string;
  };
  error: { message: string; source: string; stack: string };
  'rage-click': { selector: string; text: string; count: number };
  'dead-click': { selector: string; text: string };
  identify: { id: string; email?: string; name?: string };
  track: { name: string; props: Record<string, unknown> };
}

export type CustomTag = keyof CustomEventPayloads;
