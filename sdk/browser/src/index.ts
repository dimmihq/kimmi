import { Kimmi } from './client';
import type { InitOptions, Traits } from './types';
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
}

const kimmi: KimmiApi = { init, identify, optIn, optOut, stop, getSessionId };

export default kimmi;
export type {
  BatchCounts,
  BatchMeta,
  CaptureConfig,
  CustomEventPayloads,
  CustomTag,
  Identity,
  InitOptions,
  PrivacyConfig,
  RemoteConfig,
  Traits,
  UrlRule,
  UrlRuleType,
} from './types';
