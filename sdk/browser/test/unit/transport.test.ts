import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transport } from '../../src/transport';
import type { BatchMeta } from '../../src/types';

function meta(seq: number): BatchMeta {
  return {
    v: 1, sessionId: 's', windowId: 'w', seq, anonymousId: 'a', startedAt: 0, firstTs: 0, lastTs: 0,
    url: '', path: '/', referrer: '', viewport: { w: 1, h: 1 }, language: 'en', timezone: 'UTC',
    counts: { events: 0, clicks: 0, keypresses: 0, rageClicks: 0, deadClicks: 0, errors: 0, pageviews: 0, activeMs: 0 },
    paths: ['/'],
  };
}

function seqOf(body: Uint8Array): number {
  const length = new DataView(body.buffer, body.byteOffset).getUint32(0);
  return (JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length))) as BatchMeta).seq;
}

describe('transport', () => {
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

  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('retries a failed batch up to 3 times with backoff, keeping order', async () => {
    const statuses = [500, 500, 204, 204];
    const sent: number[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(seqOf(init!.body as Uint8Array));
      return new Response(null, { status: statuses.shift() ?? 204 });
    });
    const transport = new Transport('http://k.test/i/v1/batch', fetchFn as unknown as typeof fetch, () => undefined, 10);
    transport.enqueue(meta(0), '[]');
    transport.enqueue(meta(1), '[]');
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual([0, 0, 0, 1]);
  });

  it('gives up on a batch after 3 retries', async () => {
    const sent: number[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const seq = seqOf(init!.body as Uint8Array);
      sent.push(seq);
      return new Response(null, { status: seq === 0 ? 503 : 204 });
    });
    const transport = new Transport('http://k.test/i/v1/batch', fetchFn as unknown as typeof fetch, () => undefined, 10);
    transport.enqueue(meta(0), '[]');
    transport.enqueue(meta(1), '[]');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([0, 0, 0, 0, 1]);
  });

  it('stops everything on 403', async () => {
    const onHalt = vi.fn();
    const fetchFn = vi.fn(async () => new Response(null, { status: 403 }));
    const transport = new Transport('http://k.test/i/v1/batch', fetchFn as unknown as typeof fetch, onHalt, 10);
    transport.enqueue(meta(0), '[]');
    transport.enqueue(meta(1), '[]');
    await vi.advanceTimersByTimeAsync(100);
    transport.enqueue(meta(2), '[]');
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onHalt).toHaveBeenCalledTimes(1);
  });

  it('retries a rate-limited batch instead of ending the session', async () => {
    const onHalt = vi.fn();
    let calls = 0;
    const fetchFn = vi.fn(async () => new Response(null, { status: ++calls === 1 ? 429 : 204 }));
    const transport = new Transport('http://k.test/i/v1/batch', fetchFn as unknown as typeof fetch, onHalt, 10);
    transport.enqueue(meta(0), '[]');
    transport.enqueue(meta(1), '[]');
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(onHalt).not.toHaveBeenCalled();
  });

  it('sends what is queued with sendBeacon when the page goes away', () => {
    const beacon = vi.fn((_url: string, _data: Blob) => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    const fetchFn = vi.fn(() => new Promise<Response>(() => undefined));
    const transport = new Transport('http://k.test/i/v1/batch', fetchFn as unknown as typeof fetch, () => undefined);
    transport.enqueue(meta(0), '[]');
    transport.enqueue(meta(1), '[]');
    transport.drainWithBeacon();
    expect(beacon).toHaveBeenCalledTimes(2);
    expect(beacon.mock.calls[0]![0]).toBe('http://k.test/i/v1/batch');
  });
});
