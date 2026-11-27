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

export interface HitEvent {
  t: number;
  k: string;
  p?: string;
  n?: string;
  l?: string;
  v?: number;
  x?: number;
  y?: number;
  w?: number;
  num?: number;
  d?: Record<string, unknown>;
}

export interface Hit {
  key: string;
  beacon: boolean;
  contentType: string;
  body: {
    v: number;
    visitId: string;
    anonymousId: string;
    startedAt: number;
    url: string;
    landing: string;
    referrer: string;
    viewport: { w: number; h: number };
    release?: string;
    events: HitEvent[];
  };
}

export interface Feedback {
  key: string;
  body: { v: number; visitId: string; anonymousId: string; path: string; text: string; email: string; ts: number };
}

export interface ConfigOverrides {
  sampleRate?: number;
  privacy?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  analytics?: Record<string, unknown>;
  feedback?: Record<string, unknown>;
}

const mock = `http://localhost:${MOCK_PORT}`;

export async function reset(): Promise<void> {
  await fetch(`${mock}/_reset`, { method: 'POST' });
}

/** Project settings for `key`, merged over the mock's defaults, until the next reset. */
export async function setConfig(key: string, overrides: ConfigOverrides): Promise<void> {
  await fetch(`${mock}/_config?key=${key}`, { method: 'POST', body: JSON.stringify(overrides) });
}

export interface Received {
  batches: Batch[];
  rejected: unknown[];
  hits: Hit[];
  feedback: Feedback[];
}

export async function received(key: string): Promise<Received> {
  return (await fetch(`${mock}/_received?key=${key}`)).json() as Promise<Received>;
}

/** Every analytics event received for `key`, in arrival order, optionally of one kind. */
export async function hitEvents(key: string, kind?: string): Promise<HitEvent[]> {
  const { hits } = await received(key);
  return hits.flatMap((hit) => hit.body.events).filter((event) => !kind || event.k === kind);
}

export function customEvents(batches: Batch[], tag: string): KimmiEvent[] {
  return batches.flatMap((batch) => batch.events).filter((event) => event.type === 5 && event.data.tag === tag);
}
