// A stand-in for the kimmi ingest endpoints: serves config, validates and decodes batches, and
// keeps everything it received so the Playwright tests can assert on it.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gunzipSync } from 'node:zlib';

const port = Number(process.env.MOCK_PORT ?? 5291);
const MAX_BODY = 5 * 1024 * 1024;

const config = {
  recording: true,
  sampleRate: 100,
  privacy: {
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
  },
  capture: {
    console: true,
    network: true,
    networkBodies: false,
    performance: true,
    frustration: true,
    crossOriginIframes: false,
    startOnError: false,
    minDurationMs: 1000,
    idleTimeoutMs: 900_000,
    maxLengthMs: 3_600_000,
    urlRules: [],
  },
};

const keys = new Set(['km_pub_react', 'km_pub_next', 'km_pub_script']);

// Per-key project settings a test sets with POST /_config before loading a page; /_reset clears them.
type Overrides = { privacy?: Record<string, unknown>; capture?: Record<string, unknown> };
let overrides = new Map<string, Overrides>();

function configFor(key: string) {
  const extra = overrides.get(key) ?? {};
  return {
    ...config,
    recording: keys.has(key),
    privacy: { ...config.privacy, ...extra.privacy },
    capture: { ...config.capture, ...extra.capture },
  };
}

// A plain page that loads the IIFE bundle the way the install snippet does; host comes from the script's origin.
const scriptPage = `<!doctype html>
<html><head><title>Script tag</title>
<script src="/kimmi.js" data-key="km_pub_script" data-release="static@1" defer></script>
</head><body><h1>Script tag install</h1><a href="#pricing" id="hash-link">Pricing</a></body></html>`;

interface Received {
  key: string;
  beacon: boolean;
  bytes: number;
  meta: Record<string, unknown>;
  events: Array<{ type: number; timestamp: number; data: unknown }>;
}

let received: Received[] = [];
let rejected: Array<{ key: string; reason: string }> = [];

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const numberFields = ['seq', 'startedAt', 'firstTs', 'lastTs'];
const stringFields = ['sessionId', 'windowId', 'anonymousId', 'url', 'path', 'referrer', 'language', 'timezone'];
const countFields = ['events', 'clicks', 'keypresses', 'rageClicks', 'deadClicks', 'errors', 'pageviews', 'activeMs'];

function decode(body: Buffer): Omit<Received, 'key' | 'beacon'> {
  if (body.length < 4) throw new Error('body shorter than the length prefix');
  const length = body.readUInt32BE(0);
  if (4 + length > body.length) throw new Error('metadata length past the end of the body');
  const meta = JSON.parse(body.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>;
  if (meta.v !== 1) throw new Error('v must be 1');
  for (const field of numberFields) if (typeof meta[field] !== 'number') throw new Error(`${field} must be a number`);
  for (const field of stringFields) if (typeof meta[field] !== 'string') throw new Error(`${field} must be a string`);
  const counts = meta.counts as Record<string, unknown> | undefined;
  for (const field of countFields) if (typeof counts?.[field] !== 'number') throw new Error(`counts.${field} must be a number`);
  if (!Array.isArray(meta.paths)) throw new Error('paths must be an array');
  const events = JSON.parse(gunzipSync(body.subarray(4 + length)).toString('utf8')) as Received['events'];
  if (!Array.isArray(events) || events.length === 0) throw new Error('events must be a non-empty array');
  for (const event of events) {
    if (typeof event.type !== 'number' || typeof event.timestamp !== 'number') throw new Error('bad event');
  }
  if (counts?.events !== events.length) throw new Error('counts.events does not match');
  return { bytes: body.length, meta, events };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const key = url.searchParams.get('key') ?? '';
  try {
    if (req.method === 'OPTIONS') return send(res, 204);
    if (url.pathname === '/_health') return send(res, 200, { ok: true });
    if (url.pathname === '/kimmi.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(readFileSync(new URL('../../dist/kimmi.js', import.meta.url)));
    }
    if (url.pathname === '/_script.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(scriptPage);
    }
    if (url.pathname === '/_reset' && req.method === 'POST') {
      received = [];
      rejected = [];
      overrides = new Map();
      return send(res, 204);
    }
    if (url.pathname === '/_config' && req.method === 'POST') {
      overrides.set(key, JSON.parse((await readBody(req)).toString('utf8')) as Overrides);
      return send(res, 204);
    }
    if (url.pathname === '/_received') {
      return send(res, 200, {
        batches: received.filter((batch) => !key || batch.key === key),
        rejected: rejected.filter((entry) => !key || entry.key === key),
      });
    }
    if (url.pathname === '/i/v1/config' && req.method === 'GET') {
      return send(res, 200, configFor(key));
    }
    if (url.pathname === '/i/v1/batch' && req.method === 'POST') {
      if (!keys.has(key)) return send(res, 403);
      const body = await readBody(req);
      if (body.length > MAX_BODY) return send(res, 413);
      try {
        received.push({ key, beacon: req.headers['sec-fetch-mode'] === 'no-cors', ...decode(body) });
      } catch (error) {
        rejected.push({ key, reason: (error as Error).message });
        return send(res, 400);
      }
      return send(res, 204);
    }
    send(res, 404, { error: 'not found' });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
});

server.listen(port, () => console.log(`mock ingest listening on http://localhost:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
