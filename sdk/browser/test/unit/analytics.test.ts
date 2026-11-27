import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyLink, MAX_HIT_CHARS, requestEvent } from '../../src/analytics';
import { normalizeConfig } from '../../src/config';
import { REDACTED, scrubPayload, scrubProps, type ScrubOptions } from '../../src/scrub';
import type { Hit, HitEvent } from '../../src/types';

type Emit = (event: { type: number; timestamp: number; data: unknown }, isCheckout?: boolean) => void;

const rrweb = vi.hoisted(() => {
  const state: { emit: Emit | null; starts: number } = { emit: null, starts: 0 };
  const snapshot = () => {
    state.emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href, width: 1, height: 1 } });
    state.emit?.({ type: 2, timestamp: Date.now(), data: { node: {}, initialOffset: { top: 0, left: 0 } } });
  };
  const record = Object.assign(
    (options: { emit: Emit }) => {
      state.starts++;
      state.emit = options.emit;
      snapshot();
      return () => {
        state.emit = null;
      };
    },
    {
      addCustomEvent: (tag: string, payload: unknown) => state.emit?.({ type: 5, timestamp: Date.now(), data: { tag, payload } }),
      takeFullSnapshot: snapshot,
    },
  );
  return { state, record };
});

vi.mock('rrweb', () => ({ record: rrweb.record }));

const { Kimmi } = await import('../../src/client');

const on: ScrubOptions = { emails: true, phones: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Overrides {
  recording?: boolean;
  sampleRate?: number;
  privacy?: Record<string, unknown>;
  capture?: Record<string, unknown>;
  analytics?: Record<string, unknown> | null;
  feedback?: Record<string, unknown>;
}

/** A project with analytics on and recording off, unless a test says otherwise. */
function config(overrides: Overrides = {}) {
  return {
    recording: overrides.recording ?? false,
    sampleRate: overrides.sampleRate ?? 100,
    privacy: { requireConsent: false, ...overrides.privacy },
    capture: { minDurationMs: 0, idleTimeoutMs: 600_000, maxLengthMs: 3_600_000, ...overrides.capture },
    ...(overrides.analytics === null
      ? {}
      : { analytics: { enabled: true, cookieless: false, autoEvents: true, heatmaps: true, ...overrides.analytics } }),
    feedback: { button: 'hidden', ...overrides.feedback },
  };
}

interface Server {
  hits: Hit[];
  feedback: Array<Record<string, unknown>>;
  batches: number;
  requests: Array<{ url: string; init: RequestInit | undefined }>;
  /** What the next hits answer with: a status, or 'fail' for a network error. */
  hitAnswer: number | 'fail';
}

function mockServer(remote: unknown): Server {
  const server: Server = { hits: [], feedback: [], batches: 0, requests: [], hitAnswer: 204 };
  window.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    server.requests.push({ url, init });
    if (url.includes('/i/v1/config')) return new Response(JSON.stringify(remote), { status: 200 });
    if (url.includes('/i/v1/batch')) {
      server.batches++;
      return new Response(null, { status: 204 });
    }
    if (url.includes('/i/v1/hit')) {
      if (server.hitAnswer === 'fail') throw new TypeError('network');
      if (server.hitAnswer < 300) server.hits.push(JSON.parse(init!.body as string) as Hit);
      return new Response(null, { status: server.hitAnswer });
    }
    if (url.includes('/i/v1/feedback')) {
      server.feedback.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: Number(new URL(url).searchParams.get('status') ?? 200) });
  }) as unknown as typeof fetch;
  return server;
}

let client: InstanceType<typeof Kimmi>;

async function startClient(remote: unknown, options: { scrub?: (text: string) => string; release?: string } = {}) {
  const server = mockServer(remote);
  client = new Kimmi();
  client.init({ key: 'km_pub_test', host: 'http://kimmi.test/', ...options });
  await vi.advanceTimersByTimeAsync(0);
  return server;
}

const settle = (ms = 2000) => vi.advanceTimersByTimeAsync(ms);
// A batch is compressed off the timers the tests fake, so on a slow machine it can outlast them:
// wait for it on the real clock.
const realTimeout = globalThis.setTimeout;
async function batchSent(server: Server) {
  for (let i = 0; i < 300 && server.batches === 0; i++) {
    await vi.advanceTimersByTimeAsync(100);
    await new Promise((resolve) => realTimeout(resolve, 10));
  }
}
const events = (server: Server, kind?: string): HitEvent[] => server.hits.flatMap((hit) => hit.events).filter((e) => !kind || e.k === kind);
const kimmiKeys = (storage: Storage) => Object.keys(storage).filter((key) => key.startsWith('kimmi.'));

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function setScroll(scrollHeight: number, innerHeight: number, scrollY: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
  document.title = 'Home';
  document.body.innerHTML = '';
  rrweb.state.starts = 0;
  rrweb.state.emit = null;
  setScroll(0, 768, 0);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  // happy-dom does not load scripts: the feedback widget's tag is only looked at.
  (window as unknown as { happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
  // No beacon: the page-hide flush then goes through fetch, which the mock server reads synchronously.
  Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: true });
});

afterEach(() => {
  client?.stop();
  vi.useRealTimers();
});

describe('remote config', () => {
  it('reads a config without the analytics and feedback objects as both off', () => {
    const normal = normalizeConfig({ recording: true });
    expect(normal.analytics.enabled).toBeFalsy();
    expect(normal.analytics.cookieless).toBeFalsy();
    expect(normal.feedback.button).toBeFalsy();
  });

  it('sends no hits to a server from before analytics', async () => {
    const server = await startClient(config({ recording: true, analytics: null }));
    client.track('signup');
    await settle(6000);
    await batchSent(server);
    expect(server.hits).toEqual([]);
    expect(server.batches).toBeGreaterThan(0);
  });

  it('sends no hits when analytics is off, and forgets early track calls', async () => {
    const server = mockServer(config({ analytics: { enabled: false } }));
    client = new Kimmi();
    client.init({ key: 'km_pub_test', host: 'http://kimmi.test' });
    client.track('early');
    await settle(6000);
    expect(server.requests.filter((r) => r.url.includes('/hit'))).toEqual([]);
  });
});

describe('hits', () => {
  it('posts a page hit as text/plain JSON with the visit and page context', async () => {
    history.replaceState(null, '', '/pricing?plan=pro&token=abc');
    document.title = 'Pricing';
    const server = await startClient(config(), { release: 'web@1' });
    await settle();
    const request = server.requests.find((r) => r.url.includes('/hit'))!;
    expect(request.url).toBe('http://kimmi.test/i/v1/hit?key=km_pub_test');
    expect(request.init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit' });
    expect(typeof request.init!.body).toBe('string');
    expect(request.init!.headers).toBeUndefined();

    const hit = server.hits[0]!;
    expect(hit).toMatchObject({
      v: 1,
      url: `http://localhost:3000/pricing?plan=pro&token=${REDACTED}`,
      landing: `http://localhost:3000/pricing?plan=pro&token=${REDACTED}`,
      referrer: '',
      viewport: { w: window.innerWidth, h: window.innerHeight },
      language: navigator.language,
      release: 'web@1',
    });
    expect(typeof hit.timezone).toBe('string');
    expect(hit.visitId).toMatch(UUID);
    expect(hit.startedAt).toBe(Date.now() - 2000);
    expect(hit.events).toEqual([{ t: hit.startedAt, k: 'page', p: '/pricing', l: 'Pricing' }]);
  });

  it('sends nothing on a tick with an empty buffer', async () => {
    const server = await startClient(config());
    await settle(10_000);
    expect(server.requests.filter((r) => r.url.includes('/hit'))).toHaveLength(1);
  });

  it('puts at most 100 events in a hit and keeps the rest for the next tick', async () => {
    const server = await startClient(config());
    for (let i = 0; i < 249; i++) client.track(`event-${i}`);
    await settle();
    expect(server.hits.map((hit) => hit.events.length)).toEqual([100]);
    await settle(4000);
    expect(server.hits.map((hit) => hit.events.length)).toEqual([100, 100, 50]);
    expect(events(server, 'track').map((e) => e.n)).toEqual(Array.from({ length: 249 }, (_, i) => `event-${i}`));
  });

  it('keeps a hit body under 60,000 characters by sending fewer events', async () => {
    const server = await startClient(config());
    for (let i = 0; i < 99; i++) client.track(`big-${i}`, { note: 'x'.repeat(900) });
    await settle(6000);
    const bodies = server.requests.filter((r) => r.url.includes('/hit')).map((r) => r.init!.body as string);
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) expect(body.length).toBeLessThan(MAX_HIT_CHARS);
    expect(Math.max(...bodies.map((body) => body.length))).toBeGreaterThan(50_000);
    expect(events(server, 'track')).toHaveLength(99);
  });

  it('keeps events through a network failure, holding at most 300 and dropping the oldest', async () => {
    const server = await startClient(config());
    server.hitAnswer = 'fail';
    for (let i = 0; i < 150; i++) client.track(`first-${i}`);
    await settle(4000);
    expect(server.hits).toEqual([]);
    for (let i = 0; i < 250; i++) client.track(`second-${i}`);
    await settle(4000);
    server.hitAnswer = 204;
    await settle(10_000);
    const names = events(server).map((e) => e.n);
    expect(names).toHaveLength(300);
    expect(names[names.length - 1]).toBe('second-249');
    expect(names).not.toContain('first-0');
    expect(names).toContain('first-149');
  });

  it.each([403, 429])('stops for the page on %i', async (status) => {
    const server = await startClient(config());
    server.hitAnswer = status;
    await settle();
    server.hitAnswer = 204;
    client.track('after');
    history.pushState(null, '', '/next');
    await settle(6000);
    expect(server.requests.filter((r) => r.url.includes('/hit'))).toHaveLength(1);
    expect(server.hits).toEqual([]);
  });

  it('flushes with sendBeacon as text/plain when the page is hidden', async () => {
    const beacons: Array<{ url: string; blob: Blob }> = [];
    Object.defineProperty(navigator, 'sendBeacon', {
      value: (url: string, blob: Blob) => beacons.push({ url, blob }) > 0,
      configurable: true,
    });
    const server = await startClient(config());
    client.track('goodbye');
    setVisibility('hidden');
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.url).toBe('http://kimmi.test/i/v1/hit?key=km_pub_test');
    expect(beacons[0]!.blob.type).toBe('text/plain');
    await settle(4000);
    expect(server.hits).toEqual([]);
  });

  it('flows when no recording does: sampled out, held back for an error, or outside the URL rules', async () => {
    for (const overrides of [
      { recording: true, sampleRate: 0 },
      { recording: true, capture: { startOnError: true } },
      { recording: true, capture: { minDurationMs: 600_000 } },
      { recording: true, capture: { urlRules: [{ type: 'contains', pattern: '/never' }] } },
    ]) {
      localStorage.clear();
      sessionStorage.clear();
      const server = await startClient(config(overrides));
      client.track('still here');
      await settle(4000);
      expect(server.batches).toBe(0);
      expect(events(server).map((e) => e.k)).toEqual(['page', 'track']);
      client.stop();
    }
  });

  it('keeps errors, navigations and failed requests flowing with no recorder, without touching the console', async () => {
    const log = console.log;
    const server = await startClient(config());
    expect(console.log).toBe(log);
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom ada@example.com', filename: 'http://localhost:3000/app.js?token=abc', lineno: 3, colno: 9, error: new Error('boom') }));
    await window.fetch('http://api.test/orders/7?status=500&email=ada@example.com', { method: 'post' });
    await window.fetch('http://api.test/ok');
    await window.fetch('http://kimmi.test/i/v1/other');
    await settle(4000);
    const error = events(server, 'error')[0]!;
    expect(error.l).toBe('boom [email]');
    // The line and column end up inside the redacted value, as in the recording's error event.
    expect(error.d!.source).toBe(`http://localhost:3000/app.js?token=${REDACTED}`);
    expect(String(error.d!.stack).length).toBeLessThanOrEqual(2000);
    expect(events(server, 'request')).toEqual([expect.objectContaining({ n: 'POST api.test/orders/7', num: 500, p: '/' })]);
  });
});

describe('visit identity', () => {
  it('uses the recording session while one runs', async () => {
    document.title = 'Home';
    const server = await startClient(config({ recording: true }));
    await settle();
    const session = JSON.parse(sessionStorage.getItem('kimmi.session')!) as { id: string; startedAt: number; landing: string; referrer: string };
    expect(client.getSessionId()).toBe(session.id);
    expect(server.hits[0]).toMatchObject({
      visitId: session.id,
      anonymousId: localStorage.getItem('kimmi.anonymousId'),
      startedAt: session.startedAt,
      landing: 'http://localhost:3000/',
    });
    expect(session).toMatchObject({ landing: 'http://localhost:3000/', referrer: '' });
    expect(sessionStorage.getItem('kimmi.visit')).toBeNull();
  });

  it('keeps the landing page of the recording session across navigations', async () => {
    const server = await startClient(config({ recording: true }));
    history.pushState(null, '', '/pricing');
    await settle();
    expect(server.hits[0]).toMatchObject({ url: 'http://localhost:3000/pricing', landing: 'http://localhost:3000/' });
  });

  it('follows the recorder to a new session, leaving the old visit first', async () => {
    const server = await startClient(config({ recording: true, capture: { idleTimeoutMs: 10_000 } }));
    const first = client.getSessionId();
    await settle(14_000);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await settle(4000);
    const second = client.getSessionId();
    expect(second).not.toBe(first);
    const byVisit = (id: string | null) => server.hits.filter((hit) => hit.visitId === id).flatMap((hit) => hit.events.map((e) => e.k));
    expect(byVisit(first)).toEqual(['page', 'leave']);
    expect(byVisit(second)).toEqual(['page']);
    const order = server.hits.map((hit) => hit.visitId);
    expect(order.lastIndexOf(first!)).toBeLessThan(order.indexOf(second!));
  });

  it('keeps a cookieless visit in memory only: a new id per page load, no anonymous id, nothing stored', async () => {
    const first = await startClient(config({ recording: true, analytics: { cookieless: true } }));
    client.identify('user-42', { email: 'ada@example.com' });
    history.pushState(null, '', '/pricing');
    client.track('signup');
    await settle(4000);
    client.stop();
    expect(rrweb.state.starts).toBe(0);
    expect(first.batches).toBe(0);
    expect(first.hits.length).toBeGreaterThan(0);
    expect(new Set(first.hits.map((hit) => hit.visitId)).size).toBe(1);
    expect(first.hits.every((hit) => hit.anonymousId === '')).toBe(true);
    expect(first.hits[0]!.visitId).toMatch(UUID);
    expect(first.hits[0]!.landing).toBe('http://localhost:3000/');

    const second = await startClient(config({ recording: true, analytics: { cookieless: true } }));
    await settle();
    expect(second.hits[0]!.visitId).not.toBe(first.hits[0]!.visitId);
    expect(kimmiKeys(localStorage)).toEqual([]);
    expect(kimmiKeys(sessionStorage)).toEqual([]);
  });

  it('does not renew a cookieless visit after 30 idle minutes', async () => {
    const server = await startClient(config({ analytics: { cookieless: true } }));
    await settle(45 * 60_000);
    client.track('back');
    await settle();
    expect(new Set(server.hits.map((hit) => hit.visitId)).size).toBe(1);
  });

  it('starts the recorder of a cookieless project on optIn, and the visit becomes the session', async () => {
    const server = await startClient(config({ recording: true, analytics: { cookieless: true } }));
    client.identify('user-42');
    await settle();
    const memory = server.hits[0]!.visitId;
    client.optIn();
    await settle(4000);
    await batchSent(server);
    expect(rrweb.state.starts).toBe(1);
    expect(server.batches).toBeGreaterThan(0);
    const session = client.getSessionId();
    expect(session).not.toBe(memory);
    const recorded = server.hits.filter((hit) => hit.visitId === session);
    expect(recorded[0]!.events[0]!.k).toBe('page');
    expect(recorded[0]!.anonymousId).toBe(localStorage.getItem('kimmi.anonymousId'));
    expect(JSON.parse(localStorage.getItem('kimmi.identity')!)).toMatchObject({ id: 'user-42' });
  });

  it('stores the visit in sessionStorage when nothing is recorded, and resumes it on the next page', async () => {
    const first = await startClient(config({ recording: true, sampleRate: 0 }));
    await settle();
    client.stop();
    const stored = JSON.parse(sessionStorage.getItem('kimmi.visit')!) as { id: string; startedAt: number; landing: string; referrer: string; lastActivity: number };
    expect(stored).toMatchObject({ id: first.hits[0]!.visitId, startedAt: first.hits[0]!.startedAt, landing: 'http://localhost:3000/', referrer: '' });
    expect(first.hits[0]!.anonymousId).toBe(localStorage.getItem('kimmi.anonymousId'));
    expect(first.hits[0]!.anonymousId).toMatch(UUID);

    history.replaceState(null, '', '/second');
    await settle(20 * 60_000);
    const second = await startClient(config({ recording: true, sampleRate: 0 }));
    await settle();
    expect(second.hits[0]).toMatchObject({ visitId: stored.id, startedAt: stored.startedAt, landing: 'http://localhost:3000/', anonymousId: first.hits[0]!.anonymousId });
  });

  it('renews a stored visit after 30 minutes without activity', async () => {
    const first = await startClient(config());
    await settle();
    client.stop();
    await settle(31 * 60_000);
    history.replaceState(null, '', '/later');
    const second = await startClient(config());
    await settle();
    expect(second.hits[0]!.visitId).not.toBe(first.hits[0]!.visitId);
    expect(second.hits[0]!.landing).toBe('http://localhost:3000/later');
    expect(second.hits[0]!.anonymousId).toBe(first.hits[0]!.anonymousId);
  });

  it('does not run without consent when the project requires it, until optIn', async () => {
    const server = await startClient(config({ privacy: { requireConsent: true } }));
    client.track('before consent');
    await settle(6000);
    expect(server.requests.filter((r) => r.url.includes('/hit'))).toEqual([]);
    expect(kimmiKeys(sessionStorage)).toEqual([]);
    expect(localStorage.getItem('kimmi.anonymousId')).toBeNull();

    client.optIn();
    await settle(4000);
    expect(events(server).map((e) => e.k)).toEqual(['page', 'track']);
    expect(events(server, 'track')[0]!.n).toBe('before consent');
  });

  it('runs right away once consent was given', async () => {
    localStorage.setItem('kimmi.consent', 'granted');
    const server = await startClient(config({ privacy: { requireConsent: true } }));
    await settle();
    expect(events(server, 'page')).toHaveLength(1);
  });

  it.each([false, true])('never runs for a visitor who opted out (cookieless: %s)', async (cookieless) => {
    localStorage.setItem('kimmi.consent', 'denied');
    const server = await startClient(config({ analytics: { cookieless } }));
    client.track('nope');
    await settle(6000);
    expect(server.requests.filter((r) => r.url.includes('/hit'))).toEqual([]);
  });

  it('stops and clears its queue on optOut', async () => {
    const server = await startClient(config());
    client.track('unsent');
    client.optOut();
    client.track('after');
    await settle(6000);
    expect(server.requests.filter((r) => r.url.includes('/hit'))).toEqual([]);
  });

  it('honours Do Not Track when respectDnt is on', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    try {
      const server = await startClient(config({ privacy: { respectDnt: true } }));
      await settle(6000);
      expect(server.requests.filter((r) => r.url.includes('/hit'))).toEqual([]);
    } finally {
      Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
    }
  });

  it('creates the anonymous id only when something that may store it needs it', async () => {
    mockServer(config({ recording: true }));
    client = new Kimmi();
    client.init({ key: 'km_pub_test', host: 'http://kimmi.test' });
    expect(localStorage.getItem('kimmi.anonymousId')).toBeNull();
    await settle();
    expect(localStorage.getItem('kimmi.anonymousId')).toMatch(UUID);
  });
});

describe('page views and engagement', () => {
  it('sends a page per navigation with a leave for the page before it', async () => {
    const server = await startClient(config());
    document.title = 'Pricing';
    history.pushState(null, '', '/pricing');
    history.pushState(null, '', '/pricing');
    history.replaceState(null, '', '/pricing#plans');
    await settle();
    expect(events(server).map((e) => [e.k, e.p])).toEqual([
      ['page', '/'],
      ['leave', '/'],
      ['page', '/pricing'],
      ['leave', '/pricing'],
      ['page', '/pricing'],
    ]);
    expect(events(server, 'page').map((e) => e.l)).toEqual(['Home', 'Pricing', 'Pricing']);
  });

  it('masks the title the way the recorder does', async () => {
    document.head.innerHTML = '<title>Ada Lovelace</title>';
    const server = await startClient(config({ privacy: { maskAllText: true } }));
    await settle();
    expect(events(server, 'page')[0]!.l).toBe('*** ********');
  });

  it('counts engaged time while visible, stopping 60 s after the last interaction', async () => {
    const server = await startClient(config());
    await settle(10_000);
    history.pushState(null, '', '/b');
    await settle(90_000);
    history.pushState(null, '', '/c');
    await settle(50_000);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await settle(30_000);
    history.pushState(null, '', '/d');
    await settle();
    expect(events(server, 'leave').map((e) => [e.p, e.v])).toEqual([
      ['/', 10_000],
      ['/b', 60_000],
      ['/c', 80_000],
    ]);
  });

  it('counts every kind of interaction', async () => {
    const server = await startClient(config());
    for (const event of [new Event('scroll'), new MouseEvent('click'), new KeyboardEvent('keydown'), new MouseEvent('mousemove'), new Event('touchstart')]) {
      await settle(50_000);
      window.dispatchEvent(event);
    }
    await settle(50_000);
    history.pushState(null, '', '/b');
    await settle();
    expect(events(server, 'leave')[0]!.v).toBe(300_000);
  });

  it('does not count hidden time, and sends additive leaves', async () => {
    const server = await startClient(config());
    await settle(4000);
    setVisibility('hidden');
    await settle(20_000);
    setVisibility('visible');
    await settle(6000);
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(events(server, 'leave').map((e) => e.v)).toEqual([4000, 6000]);
  });

  it('reports the deepest scroll of the page view, the document height and the viewport width', async () => {
    const server = await startClient(config());
    setScroll(2000, 500, 500);
    window.dispatchEvent(new Event('scroll'));
    setScroll(2000, 500, 0);
    window.dispatchEvent(new Event('scroll'));
    await settle(1000);
    setVisibility('hidden');
    setVisibility('visible');
    await settle(1000);
    history.pushState(null, '', '/short');
    setScroll(400, 500, 0);
    await settle(1000);
    history.pushState(null, '', '/next');
    await settle();
    expect(events(server, 'leave')).toEqual([
      expect.objectContaining({ p: '/', v: 1000, num: 50, y: 2000, w: window.innerWidth }),
      expect.objectContaining({ p: '/', v: 1000, num: 50 }),
      expect.objectContaining({ p: '/short', v: 1000, num: 100, y: 400 }),
    ]);
  });
});

describe('track', () => {
  it('sends the name, scrubbed props and a value', async () => {
    const server = await startClient(config(), { scrub: (text) => text.replace('ACME', '[org]') });
    client.track('  purchase  ', { plan: 'pro', email: 'ada@example.com', org: 'ACME', password: 'hunter2', nested: { note: 'call +44 20 7946 0958' }, value: 49.5, revenue: 1 });
    client.track('refund', { revenue: 12 });
    client.track('odd', { value: Infinity, revenue: 'lots' });
    client.track('bare');
    await settle();
    const [purchase, refund, odd, bare] = events(server, 'track');
    expect(purchase).toMatchObject({
      n: 'purchase',
      v: 49.5,
      p: '/',
      d: { plan: 'pro', email: '[email]', org: '[org]', password: REDACTED, nested: { note: 'call [phone]' }, value: 49.5, revenue: 1 },
    });
    expect(refund).toMatchObject({ n: 'refund', v: 12 });
    expect(odd!.v).toBeUndefined();
    expect(bare).toEqual({ t: expect.any(Number), k: 'track', n: 'bare', p: '/' });
  });

  it('ignores an empty name and cuts a long one to 64 characters', async () => {
    const server = await startClient(config());
    client.track('');
    client.track('   ');
    client.track(undefined as unknown as string);
    client.track('n'.repeat(200));
    await settle();
    expect(events(server, 'track').map((e) => e.n)).toEqual(['n'.repeat(64)]);
  });

  it('drops props whose JSON is over 1024 characters, or that cannot be serialised', async () => {
    const server = await startClient(config());
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    client.track('big', { note: 'x '.repeat(600), value: 3 });
    client.track('loop', loop);
    client.track('fits', { note: 'x '.repeat(500) });
    await settle();
    const [big, circular, fits] = events(server, 'track');
    expect(big).toMatchObject({ n: 'big', v: 3 });
    expect(big!.d).toBeUndefined();
    expect(circular!.d).toBeUndefined();
    expect(fits!.d).toBeDefined();
  });

  it('queues calls made before the config arrived, at most 50, with their own timestamps', async () => {
    const server = mockServer(config());
    client = new Kimmi();
    client.init({ key: 'km_pub_test', host: 'http://kimmi.test' });
    const called = Date.now();
    for (let i = 0; i < 60; i++) client.track(`early-${i}`, { email: 'ada@example.com' });
    await settle(1000);
    client.track('late');
    await settle(2000);
    const tracked = events(server, 'track');
    expect(tracked.map((e) => e.n)).toEqual([...Array.from({ length: 50 }, (_, i) => `early-${i}`), 'late']);
    expect(tracked[0]).toMatchObject({ t: called, d: { email: '[email]' } });
    expect(tracked[50]!.t).toBe(called + 1000);
  });

  it('adds a scrubbed track event to a running recording', async () => {
    const seen: Array<{ tag: string; payload: unknown }> = [];
    const server = await startClient(config({ recording: true }));
    const emit = rrweb.state.emit!;
    rrweb.state.emit = (event, isCheckout) => {
      const data = event.data as { tag?: string; payload?: unknown };
      if (event.type === 5 && data.tag) seen.push({ tag: data.tag, payload: data.payload });
      emit(event, isCheckout);
    };
    client.track('purchase', { email: 'ada@example.com', token: 'abc' });
    await settle();
    expect(seen).toContainEqual({ tag: 'track', payload: { name: 'purchase', props: { email: '[email]', token: REDACTED } } });
    expect(events(server, 'track')).toHaveLength(1);
  });
});

describe('scrubProps', () => {
  it('scrubs strings at any depth and redacts values under secret-looking keys', () => {
    expect(scrubProps({ a: 'ada@example.com', list: ['+44 20 7946 0958', 4], deep: { api_key: 'k', pin: 1234, ok: true, none: null } }, on)).toEqual({
      a: '[email]',
      list: ['[phone]', 4],
      deep: { api_key: REDACTED, pin: REDACTED, ok: true, none: null },
    });
  });

  it('gives nothing for props that are not a plain object', () => {
    for (const props of [undefined, null, 'text', 4, ['a'], () => 1]) expect(scrubProps(props, on)).toBeUndefined();
  });

  it('survives a custom scrubber that throws', () => {
    const custom = () => {
      throw new Error('bad scrubber');
    };
    expect(scrubProps({ a: 'ada@example.com' }, { ...on, custom })).toEqual({ a: '[email]' });
  });

  it('scrubs the props of a track payload', () => {
    expect(scrubPayload('track', { name: 'x', props: { email: 'ada@example.com' } }, on)).toEqual({ name: 'x', props: { email: '[email]' } });
  });
});

describe('automatic events', () => {
  const here = 'shop.test';

  it.each([
    ['https://other.test/path/page?utm=1#top', { n: '$outbound', d: { url: 'other.test/path/page' } }],
    ['http://sub.shop.test/', { n: '$outbound', d: { url: 'sub.shop.test/' } }],
    ['//cdn.test/a/b', { n: '$outbound', d: { url: 'cdn.test/a/b' } }],
    ['https://shop.test/files/Price%20List.PDF?download=1', { n: '$download', d: { file: 'Price%20List.PDF' } }],
    ['https://other.test/files/report.xlsx', { n: '$download', d: { file: 'report.xlsx' } }],
    ['/exports/data.csv', { n: '$download', d: { file: 'data.csv' } }],
    ['archive.tar.gz', { n: '$download', d: { file: 'archive.tar.gz' } }],
    ['mailto:ada@example.com?subject=Hi', { n: '$email' }],
    ['MAILTO:ada@example.com', { n: '$email' }],
    ['tel:+442079460958', { n: '$phone' }],
    ['  tel:123', { n: '$phone' }],
  ])('classifies %s', (href, expected) => expect(classifyLink(href, here)).toEqual(expected));

  it.each(['https://shop.test/pricing', 'https://shop.test/docs/pdf', 'https://shop.test/a.pdf/view', 'javascript:void(0)', 'ftp://other.test/a.zip', 'sms:123', 'http://[bad'])(
    'ignores %s',
    (href) => expect(classifyLink(href, here)).toBeNull(),
  );

  // Relative links resolve against the page, which is on localhost:3000 here.
  it.each(['/pricing', 'pricing', '#top', '?page=2', '', 'http://localhost:3000/x'])('ignores %s on the page itself', (href) => expect(classifyLink(href)).toBeNull());

  it.each(['pdf', 'zip', 'csv', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'dmg', 'exe', 'mp3', 'mp4', 'gz', 'tar', 'rar', '7z', 'apk', 'pkg', 'txt', 'svg'])(
    'treats .%s as a download',
    (extension) => expect(classifyLink(`/f/file.${extension}`, here)?.n).toBe('$download'),
  );

  it('sends link clicks and form submits as track events, without addresses or field values', async () => {
    document.body.innerHTML = `
      <a id="out" href="https://other.test/docs?email=ada@example.com"><span>Docs</span></a>
      <a id="file" href="/files/guide.pdf">Guide</a>
      <a id="mail" href="mailto:ada@example.com">Write</a>
      <a id="phone" href="tel:+442079460958">Call</a>
      <a id="inside" href="/pricing">Pricing</a>
      <form id="signup" action="/api/signup?token=abc"><input name="id" value="secret-value"><input name="email" value="ada@example.com"></form>
      <form name="search"><input name="q" value="private query"></form>`;
    const server = await startClient(config({ analytics: { heatmaps: false } }));
    for (const id of ['out', 'file', 'mail', 'phone', 'inside']) {
      const link = document.getElementById(id)!;
      link.addEventListener('click', (event) => event.preventDefault());
      (link.firstElementChild ?? link).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
    for (const form of Array.from(document.forms)) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(events(server, 'track').map(({ n, d }) => ({ n, d }))).toEqual([
      { n: '$outbound', d: { url: 'other.test/docs' } },
      { n: '$download', d: { file: 'guide.pdf' } },
      { n: '$email', d: undefined },
      { n: '$phone', d: undefined },
      { n: '$form', d: { form: 'signup', action: '/api/signup' } },
      { n: '$form', d: { form: 'search', action: '/' } },
    ]);
    const sent = JSON.stringify(server.hits);
    for (const secret of ['ada@example.com', '2079460958', 'secret-value', 'private query', 'abc']) expect(sent).not.toContain(secret);
    expect(events(server, 'click')).toEqual([]);
  });

  it('sends none of them when autoEvents is off', async () => {
    document.body.innerHTML = '<a id="out" href="https://other.test/">Out</a><form id="f"></form>';
    const server = await startClient(config({ analytics: { autoEvents: false } }));
    document.getElementById('out')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    document.getElementById('f')!.dispatchEvent(new Event('submit', { bubbles: true }));
    await settle();
    expect(events(server, 'track')).toEqual([]);
    expect(events(server, 'click')).toHaveLength(1);
  });
});

describe('clicks', () => {
  it('sends the selector, text and position of every click, with masked text left out', async () => {
    document.body.innerHTML = `
      <main><button id="buy" class="cta">Buy the ${'very '.repeat(20)}large tray</button>
      <p class="note" data-private>Ada Lovelace</p><input id="field" value="typed secret"></main>`;
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: 2000, configurable: true });
    const server = await startClient(config());
    const click = (id: string, pageX: number, pageY: number) => {
      const event = new MouseEvent('click', { bubbles: true });
      Object.defineProperty(event, 'pageX', { value: pageX });
      Object.defineProperty(event, 'pageY', { value: pageY });
      document.querySelector(id)!.dispatchEvent(event);
    };
    click('#buy', 500, 1234.4);
    click('.note', 2000, 10);
    click('#field', 0, 0);
    await settle();
    const [buy, note, field] = events(server, 'click');
    expect(buy).toMatchObject({ n: 'button#buy', x: 2500, y: 1234, w: window.innerWidth, p: '/' });
    expect(buy!.l).toHaveLength(40);
    expect(buy!.l!.startsWith('Buy the very very')).toBe(true);
    expect(note).toMatchObject({ n: 'main > p.note', l: '', x: 10_000, y: 10 });
    expect(field).toMatchObject({ n: 'input#field', l: '' });
    expect(JSON.stringify(server.hits)).not.toContain('typed secret');
    expect(JSON.stringify(server.hits)).not.toContain('Lovelace');
  });

  it('sends no click events when heatmaps is off', async () => {
    document.body.innerHTML = '<button id="buy">Buy</button>';
    const server = await startClient(config({ analytics: { heatmaps: false } }));
    document.getElementById('buy')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(events(server, 'click')).toEqual([]);
  });

  it('sends rage and dead clicks while recording', async () => {
    document.body.innerHTML = '<button id="buy">Buy now</button>';
    const server = await startClient(config({ recording: true }));
    const button = document.getElementById('buy')!;
    for (let i = 0; i < 4; i++) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle(100);
    }
    await settle(4000);
    expect(events(server, 'rage')).toEqual([expect.objectContaining({ n: 'button#buy', l: 'Buy now', v: 4 })]);
    const dead = events(server, 'dead');
    expect(dead).toEqual([expect.objectContaining({ n: 'button#buy', l: 'Buy now' })]);
    expect(dead[0]!.v).toBeUndefined();
  });
});

describe('requests', () => {
  const base = { method: 'GET', url: 'https://api.test/v1/orders/7?email=ada@example.com&token=abc#frag', size: 0, kind: 'fetch' as const };

  it.each([
    [0, 10],
    [400, 10],
    [404, 10],
    [500, 2999],
    [200, 3000],
    [204, 9000],
  ])('reports status %i after %i ms', (status, ms) => {
    expect(requestEvent({ ...base, status, ms }, on)).toEqual({ k: 'request', n: 'GET api.test/v1/orders/7', v: ms, num: status });
  });

  it.each([
    [200, 10],
    [204, 2999],
    [301, 100],
    [399, 2999],
  ])('ignores status %i after %i ms', (status, ms) => expect(requestEvent({ ...base, status, ms }, on)).toBeNull());

  it('scrubs the path and never sends the query', () => {
    const event = requestEvent({ ...base, url: 'https://user:pw@api.test/users/ada@example.com/keys?x=1', status: 500, ms: 5 }, on)!;
    expect(event.n).toBe('GET api.test/users/[email]/keys');
  });
});

describe('errors', () => {
  it('sends uncaught errors and unhandled rejections with a stack of at most 2000 characters', async () => {
    const server = await startClient(config());
    const error = new Error('card 4242 4242 4242 4242 declined');
    error.stack = `Error: card 4242 4242 4242 4242 declined\n${'    at frame (http://localhost:3000/app.js:1:1)\n'.repeat(100)}`;
    window.dispatchEvent(new ErrorEvent('error', { message: error.message, error }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('rejected');
    window.dispatchEvent(rejection);
    await settle();
    const [thrown, rejected] = events(server, 'error');
    expect(thrown!.l).toBe(`card ${REDACTED} declined`);
    expect(String(thrown!.d!.stack).length).toBeLessThanOrEqual(2000);
    expect(String(thrown!.d!.stack)).not.toContain('4242 4242');
    expect(rejected).toMatchObject({ l: 'rejected', d: { source: 'unhandledrejection' } });
  });
});

describe('web vitals', () => {
  interface FakeEntry {
    name?: string;
    startTime: number;
    duration?: number;
    value?: number;
    hadRecentInput?: boolean;
    interactionId?: number;
  }
  let observers: Map<string, (entries: FakeEntry[]) => void>;
  let options: Map<string, Record<string, unknown>>;

  beforeEach(() => {
    observers = new Map();
    options = new Map();
    class FakeObserver {
      static supportedEntryTypes = ['largest-contentful-paint', 'paint', 'event', 'layout-shift'];
      constructor(private readonly callback: (list: { getEntries(): FakeEntry[] }) => void) {}
      observe(init: { type: string }) {
        options.set(init.type, init);
        observers.set(init.type, (entries) => this.callback({ getEntries: () => entries }));
      }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    vi.spyOn(performance, 'getEntriesByType').mockImplementation((type) => (type === 'navigation' ? ([{ responseStart: 123.6 }] as unknown as PerformanceEntryList) : []));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports each metric once, the first time the page is hidden, for the path the page loaded at', async () => {
    history.replaceState(null, '', '/landing');
    const server = await startClient(config());
    expect(options.get('event')).toMatchObject({ durationThreshold: 40, buffered: true });
    observers.get('paint')!([{ name: 'first-paint', startTime: 80 }, { name: 'first-contentful-paint', startTime: 101.4 }]);
    observers.get('largest-contentful-paint')!([{ startTime: 300 }, { startTime: 812.7 }]);
    observers.get('event')!([{ startTime: 1, duration: 500 }, { startTime: 2, duration: 96, interactionId: 7 }, { startTime: 3, duration: 48, interactionId: 8 }]);
    observers.get('layout-shift')!([
      { startTime: 1000, value: 0.1 },
      { startTime: 1500, value: 0.05 },
      { startTime: 1600, value: 0.9, hadRecentInput: true },
      // More than 1 s later: a new burst.
      { startTime: 3000, value: 0.12345 },
      // Bursts are capped at 5 s.
      { startTime: 3900, value: 0.01 },
      { startTime: 4800, value: 0.01 },
      { startTime: 5700, value: 0.01 },
      { startTime: 6600, value: 0.01 },
      { startTime: 7500, value: 0.01 },
      { startTime: 8400, value: 0.5 },
    ]);
    history.pushState(null, '', '/elsewhere');
    setVisibility('hidden');
    setVisibility('visible');
    setVisibility('hidden');
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    const vitals = events(server, 'vital');
    expect(Object.fromEntries(vitals.map((e) => [e.n, e.v]))).toEqual({ lcp: 813, fcp: 101, inp: 96, cls: 0.5, ttfb: 124 });
    expect(vitals.every((e) => e.p === '/landing')).toBe(true);
  });

  it('reports a CLS of zero, and no INP without an interaction', async () => {
    const server = await startClient(config());
    setVisibility('hidden');
    await settle();
    expect(events(server, 'vital').map((e) => [e.n, e.v])).toEqual([
      ['cls', 0],
      ['ttfb', 124],
    ]);
  });

  it('keeps the 5 s cap of a burst of layout shifts', async () => {
    const server = await startClient(config());
    observers.get('layout-shift')!(Array.from({ length: 12 }, (_, i) => ({ startTime: 1000 + i * 900, value: 0.1 })));
    setVisibility('hidden');
    await settle();
    // Shifts 900 ms apart: six fit in 5 s (0 to 4500 ms).
    expect(events(server, 'vital').find((e) => e.n === 'cls')!.v).toBe(0.6);
  });

  it('skips what the browser does not support, and everything when capture.performance is off', async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.stubGlobal('PerformanceObserver', undefined);
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(() => {
      throw new Error('unsupported');
    });
    const bare = await startClient(config());
    setVisibility('hidden');
    await settle();
    expect(events(bare, 'vital')).toEqual([]);
    expect(events(bare, 'page')).toHaveLength(1);
    client.stop();

    setVisibility('visible');
    vi.restoreAllMocks();
    const off = await startClient(config({ capture: { performance: false } }));
    setVisibility('hidden');
    await settle();
    expect(events(off, 'vital')).toEqual([]);
  });
});

describe('feedback', () => {
  it('posts scrubbed feedback under the visit', async () => {
    history.replaceState(null, '', '/checkout');
    const server = await startClient(config());
    client.feedback(`The form lost my card 4242 4242 4242 4242. ${'x'.repeat(3000)}`, { email: 'ada@example.com' });
    client.feedback('No email');
    client.feedback('');
    client.feedback('   ');
    client.feedback(undefined as unknown as string);
    await settle();
    const request = server.requests.find((r) => r.url.includes('/feedback'))!;
    expect(request.url).toBe('http://kimmi.test/i/v1/feedback?key=km_pub_test');
    expect(typeof request.init!.body).toBe('string');
    expect(server.feedback).toHaveLength(2);
    const [first, second] = server.feedback;
    expect(first).toMatchObject({ v: 1, visitId: server.hits[0]!.visitId, anonymousId: server.hits[0]!.anonymousId, path: '/checkout', email: 'ada@example.com', ts: Date.now() - 2000 });
    expect(String(first!.text).startsWith(`The form lost my card ${REDACTED}.`)).toBe(true);
    expect(String(first!.text).length).toBeLessThanOrEqual(2000);
    expect(second).toMatchObject({ text: 'No email', email: '' });
  });

  it('cuts the email to 200 characters', async () => {
    const server = await startClient(config());
    client.feedback('Hello', { email: `${'a'.repeat(300)}@example.com` });
    expect(String(server.feedback[0]!.email)).toHaveLength(200);
  });

  it('does nothing while analytics is not running', async () => {
    const server = await startClient(config({ analytics: { enabled: false } }));
    client.feedback('Hello');
    client.showFeedback();
    await settle();
    expect(server.feedback).toEqual([]);
    expect(document.querySelector('script[src*="kimmi-feedback"]')).toBeNull();
  });

  it('loads the widget once on showFeedback and hands it a sender', async () => {
    const server = await startClient(config());
    client.showFeedback();
    client.showFeedback();
    const scripts = document.querySelectorAll('script[src="http://kimmi.test/kimmi-feedback.js"]');
    expect(scripts).toHaveLength(1);
    const bridge = (window as unknown as { __kimmiFeedback: { send(text: string, email?: string): void; labels: object } }).__kimmiFeedback;
    expect(bridge.labels).toEqual({});
    bridge.send('From the widget', 'ada@example.com');
    bridge.send('No email');
    expect(server.feedback.map((f) => [f.text, f.email])).toEqual([
      ['From the widget', 'ada@example.com'],
      ['No email', ''],
    ]);
    scripts[0]!.remove();
  });

  it('loads the widget by itself when the project turns it on, and waits for analytics when asked early', async () => {
    await startClient(config({ feedback: { button: 'bottom-right' } }));
    expect(document.querySelectorAll('script[src*="kimmi-feedback"]')).toHaveLength(1);
    document.querySelector('script[src*="kimmi-feedback"]')!.remove();
    client.stop();

    mockServer(config());
    client = new Kimmi();
    client.init({ key: 'km_pub_test', host: 'http://kimmi.test' });
    client.showFeedback();
    expect(document.querySelector('script[src*="kimmi-feedback"]')).toBeNull();
    await settle(0);
    expect(document.querySelectorAll('script[src*="kimmi-feedback"]')).toHaveLength(1);
    document.querySelector('script[src*="kimmi-feedback"]')!.remove();
  });

  it('shows no button while the project keeps it hidden, and puts it where the project says', async () => {
    const bridge = () => (window as unknown as { __kimmiFeedback?: { left?: boolean } }).__kimmiFeedback;
    delete (window as unknown as { __kimmiFeedback?: unknown }).__kimmiFeedback;
    await startClient(config({ feedback: { button: 'hidden' } }));
    expect(document.querySelector('script[src*="kimmi-feedback"]')).toBeNull();
    expect(bridge()).toBeUndefined();
    client.stop();

    await startClient(config({ feedback: { button: 'bottom-left' } }));
    expect(document.querySelectorAll('script[src*="kimmi-feedback"]')).toHaveLength(1);
    expect(bridge()!.left).toBe(true);
    document.querySelector('script[src*="kimmi-feedback"]')!.remove();
    client.stop();

    await startClient(config({ feedback: { button: 'bottom-right' } }));
    expect(bridge()!.left).toBe(false);
    document.querySelector('script[src*="kimmi-feedback"]')!.remove();
  });
});

describe('linear time on large input', () => {
  const props = (keys: number) => Object.fromEntries(Array.from({ length: keys }, (_, i) => [`key${i}`, i % 2 ? `ada${i}@example.com eyJ.eyJ +44 20` : { token: 'abc', list: ['a.', '4 4 4'] }]));
  const cases: Record<string, (scale: number) => () => unknown> = {
    'scrubbing track props with many keys': (scale) => {
      const input = props(2000 * scale);
      return () => scrubProps(input, on, Infinity);
    },
    'scrubbing one long track prop': (scale) => {
      const input = { note: 'a.'.repeat(25_000 * scale) + '@' };
      return () => scrubProps(input, on, Infinity);
    },
    'refusing track props over the limit': (scale) => {
      const input = props(2000 * scale);
      return () => scrubProps(input, on);
    },
    'classifying a link with a long path': (scale) => {
      const href = `https://other.test/${'a.pdf/'.repeat(20_000 * scale)}`;
      return () => classifyLink(href, 'shop.test');
    },
    'classifying a link with a long query': (scale) => {
      const href = `/file.zip?${'a.pdf&'.repeat(20_000 * scale)}`;
      return () => classifyLink(href, 'shop.test');
    },
    'classifying a long mailto': (scale) => {
      const href = `${' '.repeat(50_000 * scale)}mailto:${'a@'.repeat(25_000 * scale)}`;
      return () => classifyLink(href, 'shop.test');
    },
    'naming a request with a long URL': (scale) => {
      const url = `https://api.test/${'a@b.c/'.repeat(10_000 * scale)}?${'token=x&'.repeat(10_000 * scale)}`;
      return () => requestEvent({ method: 'GET', url, status: 500, ms: 1, size: 0, kind: 'fetch' }, on);
    },
  };

  // A time limit alone passes a quadratic pattern on a fast machine. Quadrupling
  // the input must not much more than quadruple the time.
  it.each(Object.keys(cases))('scales linearly when %s', (name) => {
    const time = (scale: number) => {
      const run = cases[name]!(scale);
      const started = performance.now();
      run();
      return performance.now() - started;
    };
    time(1);
    const small = Math.max(time(2), 1);
    const large = time(8);
    expect(large / small).toBeLessThan(12);
  });
});
