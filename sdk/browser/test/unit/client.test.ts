import { gunzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchMeta, RemoteConfig } from '../../src/types';

type Emit = (event: { type: number; timestamp: number; data: unknown }, isCheckout?: boolean) => void;

const rrweb = vi.hoisted(() => {
  const state: { emit: Emit | null; starts: number; snapshots: number } = { emit: null, starts: 0, snapshots: 0 };
  const snapshot = (isCheckout = false) => {
    state.snapshots++;
    state.emit?.({ type: 4, timestamp: Date.now(), data: { href: location.href, width: 1, height: 1 } }, isCheckout);
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
      addCustomEvent: (tag: string, payload: unknown) =>
        state.emit?.({ type: 5, timestamp: Date.now(), data: { tag, payload } }),
      takeFullSnapshot: snapshot,
    },
  );
  return { state, record };
});

vi.mock('rrweb', () => ({ record: rrweb.record }));

const { Kimmi } = await import('../../src/client');

interface Received {
  meta: BatchMeta;
  events: Array<{ type: number; timestamp: number; data: { tag?: string; payload?: unknown } }>;
}

function baseConfig(overrides: { privacy?: Partial<RemoteConfig['privacy']>; capture?: Partial<RemoteConfig['capture']> } = {}) {
  return {
    recording: true,
    sampleRate: 100,
    privacy: { requireConsent: false, ...overrides.privacy },
    capture: { minDurationMs: 0, idleTimeoutMs: 60_000, maxLengthMs: 3_600_000, ...overrides.capture },
  };
}

function decode(body: Uint8Array): Received {
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
  return {
    meta: JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length))) as BatchMeta,
    events: JSON.parse(new TextDecoder().decode(gunzipSync(body.subarray(4 + length)))) as Received['events'],
  };
}

function mockServer(config: unknown, batchStatus = 204) {
  const batches: Received[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/i/v1/config')) return new Response(JSON.stringify(config), { status: 200 });
    if (url.includes('/i/v1/batch')) {
      batches.push(decode(new Uint8Array(init!.body as Uint8Array)));
      return new Response(null, { status: batchStatus });
    }
    return new Response('{}', { status: 200 });
  });
  window.fetch = fetchMock as unknown as typeof fetch;
  return { batches, fetchMock };
}

let client: InstanceType<typeof Kimmi>;

async function startClient(config: unknown, batchStatus?: number) {
  const server = mockServer(config, batchStatus);
  client = new Kimmi();
  client.init({ key: 'km_pub_test', host: 'http://kimmi.test/' });
  await vi.advanceTimersByTimeAsync(0);
  return server;
}

async function settle(ms = 2000) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('client', () => {
  // Node's CompressionStream finishes on the real event loop, which fake timers never yield to;
  // envelope.test.ts covers it, here the synchronous fflate path keeps timing deterministic.
  const compressionStream = globalThis.CompressionStream;
  beforeEach(() => {
    // @ts-expect-error removed for these tests only
    delete globalThis.CompressionStream;
  });
  afterEach(() => {
    globalThis.CompressionStream = compressionStream;
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, '', '/');
    rrweb.state.starts = 0;
    rrweb.state.snapshots = 0;
    rrweb.state.emit = null;
  });

  afterEach(() => {
    client?.stop();
    vi.useRealTimers();
  });

  it('sends batches with increasing seq, starting with Meta, FullSnapshot and a navigate event', async () => {
    const { batches } = await startClient(baseConfig());
    expect(client.getSessionId()).not.toBeNull();
    await settle();
    history.pushState(null, '', '/products');
    await settle();
    expect(batches.map((b) => b.meta.seq)).toEqual([0, 1]);
    expect(batches[0]!.events.map((e) => e.type)).toEqual([4, 2, 5]);
    expect(batches[0]!.events[2]!.data.tag).toBe('navigate');
    expect(batches[1]!.meta.paths).toEqual(['/products']);
    expect(batches[1]!.meta.counts.pageviews).toBe(1);
    expect(batches.every((b) => b.meta.sessionId === client.getSessionId())).toBe(true);
  });

  it('keeps console output from before the config arrived and sends it after the first snapshot', async () => {
    const server = mockServer(baseConfig());
    client = new Kimmi();
    client.init({ key: 'km_pub_test', host: 'http://kimmi.test' });
    console.warn('booting');
    await settle();
    const events = server.batches[0]!.events;
    expect(events.slice(0, 3).map((e) => e.data.tag ?? e.type)).toEqual([4, 2, 'navigate']);
    expect(events.find((e) => e.data.tag === 'console')!.data.payload).toMatchObject({ level: 'warn', text: 'booting' });
  });

  it('ignores a second init', async () => {
    const { fetchMock } = await startClient(baseConfig());
    client.init({ key: 'km_pub_other', host: 'http://other.test' });
    await settle(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/config'))).toHaveLength(1);
    expect(rrweb.state.starts).toBe(1);
  });

  it('records nothing when the server says recording is off', async () => {
    const { batches } = await startClient({ ...baseConfig(), recording: false });
    await settle(5000);
    expect(rrweb.state.starts).toBe(0);
    expect(batches).toHaveLength(0);
    expect(client.getSessionId()).toBeNull();
  });

  describe('consent', () => {
    it('records and sends nothing until optIn when consent is required, and remembers the answer', async () => {
      const { batches } = await startClient(baseConfig({ privacy: { requireConsent: true } }));
      await settle(5000);
      expect(rrweb.state.starts).toBe(0);
      expect(batches).toHaveLength(0);

      client.optIn();
      expect(localStorage.getItem('kimmi.consent')).toBe('granted');
      await settle();
      expect(rrweb.state.starts).toBe(1);
      expect(batches.length).toBeGreaterThan(0);
    });

    it('starts right away on a later page once consent was given', async () => {
      localStorage.setItem('kimmi.consent', 'granted');
      await startClient(baseConfig({ privacy: { requireConsent: true } }));
      expect(rrweb.state.starts).toBe(1);
    });

    it('stops and drops unsent events on optOut, and stays off', async () => {
      const { batches } = await startClient(baseConfig());
      client.optOut();
      await settle(5000);
      expect(batches).toHaveLength(0);
      expect(localStorage.getItem('kimmi.consent')).toBe('denied');
      client.stop();

      const next = await startClient(baseConfig());
      await settle(5000);
      expect(next.batches).toHaveLength(0);
    });
  });

  it('honours Do Not Track when respectDnt is on', async () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    try {
      await startClient(baseConfig({ privacy: { respectDnt: true } }));
      expect(rrweb.state.starts).toBe(0);
    } finally {
      Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
    }
  });

  describe('url rules', () => {
    it('records only while the URL matches a rule', async () => {
      const { batches } = await startClient(baseConfig({ capture: { urlRules: [{ type: 'contains', pattern: '/checkout' }] } }));
      await settle();
      expect(rrweb.state.starts).toBe(0);
      expect(batches).toHaveLength(0);

      history.pushState(null, '', '/checkout');
      await settle();
      expect(rrweb.state.starts).toBe(1);
      expect(batches).toHaveLength(1);
      expect(batches[0]!.events.find((e) => e.type === 5)!.data.payload).toMatchObject({ path: '/checkout' });

      history.pushState(null, '', '/thanks');
      await settle(4000);
      expect(rrweb.state.emit).toBeNull();
      expect(batches.flatMap((b) => b.meta.paths)).not.toContain('/thanks');
    });
  });

  describe('session rotation', () => {
    it('starts a new session with seq 0 and a fresh snapshot after the idle timeout', async () => {
      const { batches } = await startClient(baseConfig({ capture: { idleTimeoutMs: 10_000 } }));
      const first = client.getSessionId();
      await settle();
      await settle(12_000);
      expect(rrweb.state.emit).toBeNull();

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      await settle();
      const second = client.getSessionId();
      expect(second).not.toBe(first);
      const latest = batches[batches.length - 1]!;
      expect(latest.meta.sessionId).toBe(second);
      expect(latest.meta.seq).toBe(0);
      expect(latest.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
      expect(JSON.parse(sessionStorage.getItem('kimmi.session')!).id).toBe(second);
    });

    it('starts a new session at the maximum length', async () => {
      const { batches } = await startClient(baseConfig({ capture: { maxLengthMs: 10_000, idleTimeoutMs: 600_000 } }));
      const first = client.getSessionId();
      for (let i = 0; i < 6; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
        await settle();
      }
      expect(client.getSessionId()).not.toBe(first);
      expect(new Set(batches.map((b) => b.meta.sessionId)).size).toBe(2);
    });
  });

  it('holds batches in memory until the session lasted minDurationMs', async () => {
    const { batches } = await startClient(baseConfig({ capture: { minDurationMs: 7000 } }));
    await settle(6000);
    expect(batches).toHaveLength(0);
    await settle(2000);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events[0]!.type).toBe(4);
  });

  it('buffers until an error when startOnError is on', async () => {
    const { batches } = await startClient(baseConfig({ capture: { startOnError: true } }));
    await settle(6000);
    expect(batches).toHaveLength(0);
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));
    await settle();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events[0]!.type).toBe(4);
    expect(batches[0]!.events.some((e) => e.data.tag === 'error')).toBe(true);
    expect(batches[0]!.meta.counts.errors).toBe(1);
  });

  it('drops events older than the rolling 60 s window while waiting for an error', async () => {
    const { batches } = await startClient(baseConfig({ capture: { startOnError: true, idleTimeoutMs: 600_000 } }));
    console.info('old');
    await settle(125_000);
    console.info('recent');
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }));
    await settle();
    const texts = batches.flatMap((b) => b.events).filter((e) => e.data.tag === 'console').map((e) => (e.data.payload as { text: string }).text);
    expect(texts).toEqual(['recent']);
    const first = batches[0]!.events[0]!;
    expect(first.type).toBe(4);
    expect(Date.now() - first.timestamp).toBeLessThanOrEqual(92_000);
  });

  it('replaces a mutation storm with a fresh full snapshot', async () => {
    const { batches } = await startClient(baseConfig());
    const before = rrweb.state.snapshots;
    rrweb.state.emit!({ type: 3, timestamp: Date.now(), data: { source: 0, adds: new Array(10_001).fill({}), removes: [], texts: [], attributes: [] } });
    await settle();
    expect(rrweb.state.snapshots).toBe(before + 1);
    const events = batches.flatMap((b) => b.events);
    expect(events.some((e) => e.type === 3)).toBe(false);
  });

  it('computes counts and active time per batch', async () => {
    const { batches } = await startClient(baseConfig());
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.advanceTimersByTimeAsync(7000);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    rrweb.state.emit!({ type: 3, timestamp: Date.now(), data: { source: 2, type: 2, id: 1, x: 0, y: 0 } });
    await settle();
    const counts = batches.reduce(
      (sum, b) => ({ keypresses: sum.keypresses + b.meta.counts.keypresses, clicks: sum.clicks + b.meta.counts.clicks, activeMs: sum.activeMs + b.meta.counts.activeMs }),
      { keypresses: 0, clicks: 0, activeMs: 0 },
    );
    expect(counts).toEqual({ keypresses: 4, clicks: 1, activeMs: 1000 });
  });

  it('splits a flush over 4 MB into several batches with consecutive seq', async () => {
    const { batches } = await startClient(baseConfig());
    await settle();
    const big = 'x'.repeat(1_500_000);
    for (let i = 0; i < 4; i++) rrweb.state.emit!({ type: 3, timestamp: Date.now(), data: { source: 8, big } });
    await settle();
    const split = batches.slice(1);
    expect(split.map((b) => b.meta.seq)).toEqual([1, 2]);
    expect(split.map((b) => b.events.length)).toEqual([2, 2]);
  });

  it('stops for the session on 403', async () => {
    const { batches } = await startClient(baseConfig(), 403);
    await settle();
    expect(batches).toHaveLength(1);
    expect(rrweb.state.emit).toBeNull();
    expect(client.getSessionId()).toBeNull();
    await settle(5000);
    expect(batches).toHaveLength(1);
  });

  it('identifies the visitor in metadata and with a custom event', async () => {
    const { batches } = await startClient(baseConfig());
    client.identify('user-42', { email: 'ada@example.com', name: 'Ada', plan: 'pro' });
    await settle();
    const batch = batches[batches.length - 1]!;
    expect(batch.meta.identity).toEqual({ id: 'user-42', email: 'ada@example.com', name: 'Ada', traits: { plan: 'pro' } });
    expect(batch.events.find((e) => e.data.tag === 'identify')!.data.payload).toEqual({ id: 'user-42', email: 'ada@example.com', name: 'Ada' });
  });

  it('scrubs custom events, metadata URLs and the Meta event, with the site hook last, and leaves identify alone', async () => {
    history.replaceState(null, '', '/reset?token=abc123&step=2');
    const server = mockServer(baseConfig({ privacy: { scrubPhones: false } }));
    client = new Kimmi();
    client.init({ key: 'km_pub_test', host: 'http://kimmi.test', scrub: (text) => text.replace('step=2', 'step=[n]') });
    console.log('early', 'ada@example.com', '+44 20 7946 0958');
    await settle();
    client.identify('ada@example.com', { email: 'ada@example.com' });
    await settle();
    const events = server.batches.flatMap((b) => b.events);
    expect((events[0]!.data as { href: string }).href).toBe('http://localhost:3000/reset?token=[redacted]&step=[n]');
    expect(events.find((e) => e.data.tag === 'console')!.data.payload).toMatchObject({ text: 'early [email] +44 20 7946 0958' });
    expect(events.find((e) => e.data.tag === 'navigate')!.data.payload).toMatchObject({ href: 'http://localhost:3000/reset?token=[redacted]&step=[n]' });
    expect(events.find((e) => e.data.tag === 'identify')!.data.payload).toEqual({ id: 'ada@example.com', email: 'ada@example.com' });
    expect(server.batches[0]!.meta).toMatchObject({ url: 'http://localhost:3000/reset?token=[redacted]&step=[n]', path: '/reset' });
  });
});
