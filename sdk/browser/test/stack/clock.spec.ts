import { createServer, type Server } from 'node:http';
import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { HOOK_PORT, KIMMI } from './playwright.config';

// The alerts that depend on time, against the running stack: spikes within an hour, a day without visits, and
// the Monday digest. The stack must run with KIMMI_TEST_HOOKS=1, which lets a test move the clock alerts go by
// and checks them every 2 seconds.

const PORT = HOOK_PORT + 10;
const HOOK = `http://${process.env.KIMMI_HOOK_HOST ?? 'host.docker.internal'}:${PORT}/hook`;
const run = Date.now().toString(36);

interface Delivery {
  event: string;
  title: string;
  text: string;
  at: number;
  project: { id: string; name: string };
  data?: Record<string, unknown>;
}

let api: APIRequestContext;
let hook: Server;
let project = '';
let key = '';
const deliveries: Delivery[] = [];
const got = (event: string) => deliveries.filter((delivery) => delivery.event === event && delivery.project.id === project);

async function clock(offsetMs: number) {
  const response = await api.post('/api/v1/test/clock', { data: { offsetMs } });
  expect(response.status(), 'POST /api/v1/test/clock exists only with KIMMI_TEST_HOOKS=1').toBe(200);
  return ((await response.json()) as { now: number }).now;
}

async function hit(visit: string, events: object[]) {
  const response = await api.post(`/i/v1/hit?key=${key}`, {
    headers: { 'Content-Type': 'text/plain' },
    data: JSON.stringify({ v: 1, visitId: visit, anonymousId: `clock-${run}`, startedAt: Date.now(), url: 'https://shop.example/pricing', timezone: 'UTC', events }),
  });
  expect(response.status()).toBe(204);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'no browser is involved: once is enough');
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        deliveries.push(JSON.parse(body) as Delivery);
      } catch {
        // not ours
      }
      res.writeHead(204).end();
    });
  }).listen(PORT);
  api = await request.newContext({ baseURL: KIMMI });
  expect((await api.post('/api/v1/auth/login', { data: { email: process.env.DEV_ACCOUNT_EMAIL, password: process.env.DEV_ACCOUNT_PASSWORD } })).status()).toBe(200);
  await clock(0);
  const created = await api.post('/api/v1/projects', { data: { name: `Clock ${run}`, origin: 'https://shop.example', platform: 'script' } });
  expect(created.status()).toBe(201);
  ({ id: project, publicKey: key } = (await created.json()) as { id: string; publicKey: string });
  expect((await api.patch(`/api/v1/projects/${project}`, { data: { timezone: 'UTC' } })).status()).toBe(200);
  const settings = await api.patch(`/api/v1/projects/${project}/settings`, {
    data: {
      analytics: { enabled: true },
      alerts: { webhookUrl: HOOK, newErrors: true, errorSpike: 3, rageSpike: 3, noTraffic: true, weeklyDigest: true, feedback: false },
    },
  });
  expect(settings.status(), await settings.text()).toBe(200);
  await expect
    .poll(async () => ((await (await api.get(`/i/v1/config?key=${key}`)).json()) as { analytics: { enabled: boolean } }).analytics.enabled, { timeout: 10_000 })
    .toBe(true);
});

test.afterAll(async () => {
  if (!api) return;
  await clock(0);
  if (project) await api.delete(`/api/v1/projects/${project}`);
  await api.dispose();
  hook?.close();
});

test('three rage clicks in an hour raise rage.spike, once', async () => {
  await hit(`rage-${run}`, [
    { k: 'page', p: '/pricing' },
    { k: 'rage', p: '/pricing', n: 'button.compare', l: 'Compare', v: 4 },
    { k: 'rage', p: '/pricing', n: 'button.compare', l: 'Compare', v: 3 },
    { k: 'rage', p: '/pricing', n: 'button.buy', l: 'Buy', v: 5 },
  ]);
  await expect.poll(() => got('rage.spike').length, { timeout: 10_000 }).toBe(1);
  expect(got('rage.spike')[0]!.data).toMatchObject({ count: 3, threshold: 3 });
  // More of the same within the hour stays quiet.
  await hit(`rage-${run}`, [{ k: 'rage', p: '/pricing', n: 'button.buy', l: 'Buy', v: 3 }]);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  expect(got('rage.spike')).toHaveLength(1);
});

test('a new kind of error raises error.new, and three in an hour error.spike', async () => {
  const boom = { k: 'error', p: '/pricing', l: `Clock check failed ${run}`, d: { source: 'app.js:1:1', stack: `Error\n    at check${run} (https://shop.example/app.js:1:1)` } };
  await hit(`err-${run}`, [boom, boom, boom]);
  await expect.poll(() => got('error.new').length, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => got('error.spike').length, { timeout: 10_000 }).toBe(1);
  expect(got('error.new')[0]!.text).toContain(run);
});

test('a day without visits raises traffic.none, once a day', async () => {
  expect(got('traffic.none')).toHaveLength(0);
  // Wednesday-proof: 25 hours on is past a day and, unless today is Sunday, not a Monday morning.
  await clock(25 * 3600_000);
  await expect.poll(() => got('traffic.none').length, { timeout: 15_000 }).toBe(1);
  expect(got('traffic.none')[0]!.title).toContain(`Clock ${run}`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  expect(got('traffic.none'), 'not repeated while the day lasts').toHaveLength(1);
});

test('the digest goes out on Monday from 8 in the project time zone, once a week', async () => {
  const day = 86_400_000;
  const now = Date.now();
  const today = new Date(now);
  const untilMonday = (8 - today.getUTCDay()) % 7 || 7;
  const monday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + untilMonday * day;
  const before = got('digest.weekly').length;

  // Monday 07:30: too early.
  await clock(monday + 7.5 * 3600_000 - now);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  expect(got('digest.weekly').length, 'nothing before 8').toBe(before);

  // Monday 08:05.
  await clock(monday + 8 * 3600_000 + 5 * 60_000 - now);
  await expect.poll(() => got('digest.weekly').length, { timeout: 15_000 }).toBe(before + 1);
  const digest = got('digest.weekly').at(-1)!;
  expect(digest.title).toBe(`Your week on Clock ${run}`);
  expect(digest.text).toMatch(/\d+ visitors/);
  expect((digest.data as { totals: { visits: number } }).totals.visits, 'the week it covers includes the visits made above').toBeGreaterThanOrEqual(2);

  // Later the same Monday, and on Tuesday: no second copy.
  await clock(monday + 15 * 3600_000 - now);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await clock(monday + day + 9 * 3600_000 - now);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  expect(got('digest.weekly')).toHaveLength(before + 1);

  // The Monday after: the next one.
  await clock(monday + 7 * day + 8.5 * 3600_000 - now);
  await expect.poll(() => got('digest.weekly').length, { timeout: 15_000 }).toBe(before + 2);
});
