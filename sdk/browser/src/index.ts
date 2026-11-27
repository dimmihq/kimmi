import { Kimmi } from './client';
import type { FeedbackOptions, InitOptions, Traits } from './types';
import { safe } from './util';

let instance: Kimmi | null = null;

function client(): Kimmi | null {
  if (typeof window === 'undefined') return null;
  instance ??= new Kimmi();
  return instance;
}

/** Starts recording for the project behind `key`. Calling it again does nothing. */
export const init = safe((options: InitOptions): void => client()?.init(options));

/** Attaches a user to this visitor and every later session. */
export const identify = safe((id: string, traits?: Traits): void => client()?.identify(id, traits));

/** Records consent: recording starts if the project requires consent. Remembered in localStorage. */
export const optIn = safe((): void => client()?.optIn());

/** Withdraws consent: stops recording and drops anything not yet sent. Remembered in localStorage. */
export const optOut = safe((): void => client()?.optOut());

/** Stops recording on this page after sending what is buffered. */
export const stop = safe((): void => client()?.stop());

/** Sends a custom analytics event. Props named like a secret are redacted, and props over 1 KB are dropped. */
export const track = safe((name: string, props?: Record<string, unknown>): void => client()?.track(name, props));

/** Sends a visitor's feedback to the dashboard. Does nothing while analytics is off. */
export const feedback = safe((text: string, options?: FeedbackOptions): void => client()?.feedback(text, options));

/** Loads the feedback button and shows it. */
export const showFeedback = safe((): void => client()?.showFeedback());

/** The id of the session being recorded, or null when nothing is recorded. */
export function getSessionId(): string | null {
  try {
    return client()?.getSessionId() ?? null;
  } catch {
    return null;
  }
}

export interface KimmiApi {
  init(options: InitOptions): void;
  identify(id: string, traits?: Traits): void;
  optIn(): void;
  optOut(): void;
  stop(): void;
  getSessionId(): string | null;
  track(name: string, props?: Record<string, unknown>): void;
  feedback(text: string, options?: FeedbackOptions): void;
  showFeedback(): void;
}

const kimmi: KimmiApi = { init, identify, optIn, optOut, stop, getSessionId, track, feedback, showFeedback };

export default kimmi;
export type {
  AnalyticsConfig,
  BatchCounts,
  BatchMeta,
  CaptureConfig,
  CustomEventPayloads,
  CustomTag,
  FeedbackConfig,
  FeedbackOptions,
  Hit,
  HitEvent,
  Identity,
  InitOptions,
  PrivacyConfig,
  RemoteConfig,
  Traits,
  UrlRule,
  UrlRuleType,
} from './types';
