import { MOCK_PORT } from './playwright.config';

export interface KimmiEvent {
  type: number;
  timestamp: number;
  data: { tag?: string; payload?: Record<string, unknown>; source?: number; text?: string };
}

export interface Batch {
  key: string;
  beacon: boolean;
  meta: {
    sessionId: string;
    seq: number;
    identity?: { id: string; email?: string };
    counts: Record<'events' | 'clicks' | 'keypresses' | 'rageClicks' | 'deadClicks' | 'errors' | 'pageviews' | 'activeMs', number>;
    paths: string[];
  };
  events: KimmiEvent[];
}

const mock = `http://localhost:${MOCK_PORT}`;

export async function reset(): Promise<void> {
  await fetch(`${mock}/_reset`, { method: 'POST' });
}

/** Project settings for `key`, merged over the mock's defaults, until the next reset. */
export async function setConfig(key: string, overrides: { privacy?: Record<string, unknown>; capture?: Record<string, unknown> }): Promise<void> {
  await fetch(`${mock}/_config?key=${key}`, { method: 'POST', body: JSON.stringify(overrides) });
}

export async function received(key: string): Promise<{ batches: Batch[]; rejected: unknown[] }> {
  return (await fetch(`${mock}/_received?key=${key}`)).json() as Promise<{ batches: Batch[]; rejected: unknown[] }>;
}

export function customEvents(batches: Batch[], tag: string): KimmiEvent[] {
  return batches.flatMap((batch) => batch.events).filter((event) => event.type === 5 && event.data.tag === tag);
}
