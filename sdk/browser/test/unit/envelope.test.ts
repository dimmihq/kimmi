import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { envelope, gzip, gzipNow } from '../../src/envelope';
import type { BatchMeta } from '../../src/types';

const meta: BatchMeta = {
  v: 1,
  sessionId: 's-1',
  windowId: 'w-1',
  seq: 3,
  anonymousId: 'a-1',
  startedAt: 1,
  firstTs: 2,
  lastTs: 3,
  url: 'https://shop.test/ünïcode',
  path: '/ünïcode',
  referrer: '',
  viewport: { w: 1440, h: 900 },
  language: 'en-GB',
  timezone: 'Africa/Lagos',
  counts: { events: 2, clicks: 0, keypresses: 0, rageClicks: 0, deadClicks: 0, errors: 0, pageviews: 1, activeMs: 0 },
  paths: ['/ünïcode'],
};

const events = [
  { type: 4, timestamp: 2, data: { href: 'https://shop.test/', width: 1440, height: 900 } },
  { type: 5, timestamp: 3, data: { tag: 'navigate', payload: { href: 'https://shop.test/', path: '/', title: 'Shop – 🛒' } } },
];

function decode(body: Uint8Array) {
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, false);
  const decodedMeta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + length))) as BatchMeta;
  const decodedEvents = JSON.parse(new TextDecoder().decode(gunzipSync(body.subarray(4 + length)))) as unknown;
  return { length, meta: decodedMeta, events: decodedEvents };
}

describe('envelope', () => {
  it('writes a big-endian length prefix, the metadata JSON and the gzipped events (sync gzip)', () => {
    const body = envelope(meta, gzipNow(JSON.stringify(events)));
    const decoded = decode(body);
    expect(decoded.length).toBe(new TextEncoder().encode(JSON.stringify(meta)).length);
    expect(body[0]).toBe(0);
    expect(decoded.meta).toEqual(meta);
    expect(decoded.events).toEqual(events);
    expect(body[4 + decoded.length]).toBe(0x1f);
    expect(body[5 + decoded.length]).toBe(0x8b);
  });

  it('round-trips through CompressionStream', async () => {
    expect(typeof CompressionStream).toBe('function');
    const decoded = decode(envelope(meta, await gzip(JSON.stringify(events))));
    expect(decoded.meta).toEqual(meta);
    expect(decoded.events).toEqual(events);
  });

  it('falls back to fflate when CompressionStream is missing', async () => {
    const original = globalThis.CompressionStream;
    // @ts-expect-error simulating an older browser
    delete globalThis.CompressionStream;
    try {
      const decoded = decode(envelope(meta, await gzip(JSON.stringify(events))));
      expect(decoded.events).toEqual(events);
    } finally {
      globalThis.CompressionStream = original;
    }
  });
});
