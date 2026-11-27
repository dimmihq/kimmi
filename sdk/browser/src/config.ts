import type { CaptureConfig, PrivacyConfig, RemoteConfig } from './types';

const defaultPrivacy: PrivacyConfig = {
  maskAllText: false,
  maskAllInputs: true,
  blockMedia: false,
  recordCanvas: false,
  maskSelectors: [],
  blockSelectors: [],
  ignoreSelectors: [],
  respectDnt: false,
  requireConsent: false,
  ip: 'truncate',
  scrubEmails: true,
  scrubPhones: true,
};

const defaultCapture: CaptureConfig = {
  console: true,
  network: true,
  networkBodies: false,
  performance: true,
  frustration: true,
  crossOriginIframes: false,
  startOnError: false,
  minDurationMs: 2000,
  idleTimeoutMs: 900_000,
  maxLengthMs: 3_600_000,
  urlRules: [],
};

/** Fills anything the server left out with the contract defaults. */
export function normalizeConfig(raw: unknown): RemoteConfig {
  const value = (raw ?? {}) as Partial<RemoteConfig>;
  const sampleRate = typeof value.sampleRate === 'number' ? value.sampleRate : 100;
  return {
    recording: value.recording === true,
    sampleRate: Math.min(100, Math.max(0, sampleRate)),
    privacy: { ...defaultPrivacy, ...(value.privacy ?? {}) },
    capture: { ...defaultCapture, ...(value.capture ?? {}) },
  };
}

export async function fetchConfig(
  fetchFn: typeof fetch,
  host: string,
  key: string,
): Promise<RemoteConfig | null> {
  const response = await fetchFn(`${host}/i/v1/config?key=${encodeURIComponent(key)}`, {
    credentials: 'omit',
  });
  if (!response.ok) return null;
  return normalizeConfig(await response.json());
}
