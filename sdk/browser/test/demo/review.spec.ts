import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { KIMMI } from './playwright.config';

// Opens every page of the seeded demo in both themes, times each API call the page makes and keeps a
// screenshot, so speed and layout under volume can be reviewed:  DEMO_REVIEW=1 playwright test --config ...

const SHOTS = process.env.KIMMI_SHOTS ?? 'test-results/demo';
const KEYS = { rich: `km_pub_${'de30'.repeat(4)}`, replay: `km_pub_${'de31'.repeat(4)}` };

let api: APIRequestContext;
let rich = '';
let replay = '';
let empty = '';
const timings: { page: string; route: string; ms: number }[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: KIMMI });
  expect((await api.post('/api/v1/auth/login', { data: { email: process.env.DEV_ACCOUNT_EMAIL, password: process.env.DEV_ACCOUNT_PASSWORD } })).status()).toBe(200);
  const projects = (await (await api.get('/api/v1/projects')).json()) as { id: string; name: string; publicKey: string }[];
  rich = projects.find((project) => project.publicKey === KEYS.rich)!.id;
  replay = projects.find((project) => project.publicKey === KEYS.replay)!.id;
  empty = projects.find((project) => project.name === 'New landing page')!.id;
  mkdirSync(SHOTS, { recursive: true });
});

test.afterAll(async () => {
  const slow = [...timings].sort((a, b) => b.ms - a.ms);
  writeFileSync(`${SHOTS}/timings.json`, JSON.stringify(slow, null, 1));
  console.log('\nslowest API calls (ms):');
  for (const row of slow.slice(0, 25)) console.log(`${String(Math.round(row.ms)).padStart(6)}  ${row.route}  [${row.page}]`);
  await api.dispose();
});

async function open(page: Page, name: string, url: string, settle = 500) {
  const started = new Map<string, number>();
  const onRequest = (req: { url(): string }) => started.set(req.url(), performance.now());
  const onResponse = (res: { url(): string }) => {
    const begin = started.get(res.url());
    const path = new URL(res.url()).pathname;
    if (begin !== undefined && path.startsWith('/api/')) {
      timings.push({ page: name, route: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id').replace(/\/errors\/[0-9a-f]{16}/, '/errors/:fp') + new URL(res.url()).search.slice(0, 60), ms: performance.now() - begin });
    }
  };
  page.on('request', onRequest);
  page.on('requestfinished', async (req) => onResponse(req));
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(settle);
  page.off('request', onRequest);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const theme of ['dark', 'light'] as const) {
  test(`every page, ${theme}`, async ({ browser }) => {
    test.setTimeout(600_000);
    const context = await browser.newContext({ storageState: await api.storageState(), viewport: { width: 1440, height: 900 } });
    await context.addInitScript((value) => localStorage.setItem('kimmi.theme', value), theme);
    const page = await context.newPage();
    const at = (project: string, path: string) => `${KIMMI}/projects/${project}${path}`;
    const get = async <T>(path: string) => (await (await api.get(`/api/v1/projects/${rich}${path}`)).json()) as T;
    const recording = (await get<{ items: { id: string }[] }>('/recordings?sort=score&limit=1')).items[0]!.id;
    const fingerprint = (await get<{ fingerprint: string }[]>('/errors?days=30'))[0]!.fingerprint;
    const pages: [string, string, number?][] = [
      ['projects', `${KIMMI}/projects`],
      ['overview', at(rich, '')],
      ['overview-30d', at(rich, '?days=30')],
      ['analytics-7d', at(rich, '/analytics?days=7')],
      ['analytics-30d', at(rich, '/analytics?days=30')],
      ['analytics-90d', at(rich, '/analytics?days=90')],
      ['analytics-filtered', at(rich, '/analytics?days=30&channel=Email&goal=')],
      ['funnels-30d', at(rich, '/funnels?days=30')],
      ['heatmap-clicks', at(rich, '/heatmaps?days=30&path=%2Fproducts%2Foak-tray'), 3000],
      ['heatmap-scroll', at(rich, '/heatmaps?days=30&path=%2F&view=scroll'), 3000],
      ['heatmap-mobile', at(rich, '/heatmaps?days=30&path=%2F&device=Mobile'), 3000],
      ['errors-30d', at(rich, '/errors?days=30')],
      ['error-detail', at(rich, `/errors/${fingerprint}?days=30`)],
      ['friction-30d', at(rich, '/friction?days=30')],
      ['performance-30d', at(rich, '/performance?days=30')],
      ['feedback', at(rich, '/feedback')],
      ['recordings', at(rich, '/recordings')],
      ['recordings-score', at(rich, '/recordings?sort=score')],
      ['recordings-filtered', at(rich, '/recordings?event=track%3Apurchase&utmSource=newsletter')],
      ['recordings-page-40', at(rich, '/recordings?page=40')],
      ['player', at(rich, `/recordings/${recording}`), 2500],
      ['live', at(rich, '/live')],
      ['visitors', at(rich, '/visitors')],
      ['visitors-returning', at(rich, '/visitors?tab=returning')],
      ['visitors-accounts', at(rich, '/visitors?tab=accounts')],
      ['settings-analytics', at(rich, '/settings/analytics')],
      ['settings-alerts', at(rich, '/settings/alerts')],
      ['settings-sharing', at(rich, '/settings/sharing')],
      ['replay-only-overview', at(replay, '')],
      ['replay-only-recordings', at(replay, '/recordings')],
      ['replay-only-settings', at(replay, '/settings/analytics')],
      ['empty-overview', at(empty, '')],
      ['empty-recordings', at(empty, '/recordings')],
      ['storage', `${KIMMI}/settings/storage`],
    ];
    for (const [name, url, settle] of pages) await open(page, `${theme}-${name}`, url, settle);
    await context.close();
  });
}
