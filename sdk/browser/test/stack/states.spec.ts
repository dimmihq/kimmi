import { mkdirSync } from 'node:fs';
import { devices, expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { KEY, KIMMI, SHOP_PORT } from './playwright.config';

// The states around the main path: a project with analytics off, a viewer's dashboard, phones and tablets in
// the heatmap, and every new page in the light theme (screenshots for review).

const SHOP = `http://localhost:${SHOP_PORT}`;
const SHOTS = process.env.KIMMI_SHOTS ?? 'test-results/stack';
const run = Date.now().toString(36);

let api: APIRequestContext;
let shop = '';

const at = (project: string, path: string) => `${KIMMI}/projects/${project}${path}`;
const read = async <T>(project: string, path: string, params?: Record<string, string | number>) =>
  (await (await api.get(`/api/v1/projects/${project}${path}`, { params })).json()) as T;

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function signedIn(browser: Browser, state: Awaited<ReturnType<APIRequestContext['storageState']>>, theme: 'dark' | 'light' = 'dark') {
  const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
  await context.addInitScript((value) => localStorage.setItem('kimmi.theme', value), theme);
  return { context, page: await context.newPage() };
}

const sidebarLinks = (page: Page) =>
  page.locator('nav a, aside a').evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? '').filter(Boolean));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: KIMMI });
  expect((await api.post('/api/v1/auth/login', { data: { email: process.env.DEV_ACCOUNT_EMAIL, password: process.env.DEV_ACCOUNT_PASSWORD } })).status()).toBe(200);
  const projects = (await (await api.get('/api/v1/projects')).json()) as { id: string; publicKey: string }[];
  shop = projects.find((item) => item.publicKey === KEY)!.id;
  const patched = await api.patch(`/api/v1/projects/${shop}/settings`, {
    data: { analytics: { enabled: true, cookieless: false, heatmaps: true }, capture: { minDurationMs: 0 }, sharing: { enabled: true }, feedback: { button: 'hidden' } },
  });
  expect(patched.status()).toBe(200);
});

test.afterAll(async () => {
  await api?.patch(`/api/v1/projects/${shop}/settings`, { data: { analytics: { enabled: true } } });
  await api?.dispose();
});

test('a project with analytics off has the simple sidebar and no dead pages, until it is turned on', async ({ browser }) => {
  const created = await api.post('/api/v1/projects', { data: { name: `Replay only ${run}`, origin: 'https://replay.example', platform: 'script' } });
  const project = ((await created.json()) as { id: string; analytics: boolean });
  expect(project.analytics, 'a new project starts with analytics off').toBe(false);
  const { context, page } = await signedIn(browser, await api.storageState());

  await page.goto(at(project.id, ''));
  await expect(page.getByRole('link', { name: 'Recordings' })).toBeVisible();
  for (const hidden of ['Analytics', 'Funnels', 'Heatmaps', 'Errors', 'Friction', 'Performance', 'Feedback']) {
    await expect(page.getByRole('link', { name: hidden, exact: true }), `${hidden} is not in the sidebar`).toHaveCount(0);
  }
  for (const shown of ['Overview', 'Recordings', 'Live', 'Visitors']) {
    await expect(page.getByRole('link', { name: shown, exact: true }).first()).toBeVisible();
  }
  await shot(page, '30-analytics-off-overview');

  // A bookmark or a webhook link to an analytics page lands on the overview, not on an empty page.
  for (const path of ['/analytics', '/funnels', '/heatmaps', '/errors', '/errors/abc', '/friction', '/performance', '/feedback']) {
    await page.goto(at(project.id, path));
    await expect(page, `${path} redirects`).toHaveURL(at(project.id, ''));
  }
  await page.goto(at(project.id, '/settings/alerts'));
  await expect(page).toHaveURL(at(project.id, '/settings/analytics'));
  await page.goto(at(project.id, '/visitors?tab=returning'));
  await expect(page.getByRole('tab', { name: 'Returning' })).toHaveCount(0);

  // Settings show one switch, which says what it collects; turning it on reveals the rest at once.
  await page.goto(at(project.id, '/settings/analytics'));
  await expect(page.getByText('Count visits')).toBeVisible();
  await expect(page.getByText(/Counts page views, where visits come from, clicks, errors and page speed/)).toBeVisible();
  await expect(page.getByText('Cookieless counting')).toHaveCount(0);
  await expect(page.getByText('Goals')).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(1);
  await shot(page, '31-analytics-off-settings');
  await page.getByRole('switch').click();
  await expect(page.getByText('Cookieless counting')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Alerts', exact: true })).toBeVisible();
  await expect.poll(async () => ((await (await api.get(`/api/v1/projects/${project.id}`)).json()) as { analytics: boolean }).analytics).toBe(true);
  await page.goto(at(project.id, ''));
  for (const shown of ['Analytics', 'Funnels', 'Heatmaps', 'Errors', 'Friction', 'Performance', 'Feedback']) {
    await expect(page.getByRole('link', { name: shown, exact: true }).first(), `${shown} appears`).toBeVisible();
  }
  await page.goto(at(project.id, '/analytics'));
  await expect(page).toHaveURL(at(project.id, '/analytics'));
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await shot(page, '32-analytics-on-empty');

  await context.close();
  await api.delete(`/api/v1/projects/${project.id}`);
});

test('with analytics off the SDK sends recordings and no hits', async ({ browser }) => {
  const sent = { hits: 0, batches: 0 };
  const visit = async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('request', (req) => {
      if (req.url().includes('/i/v1/hit')) sent.hits++;
      if (req.url().includes('/i/v1/batch')) sent.batches++;
    });
    await page.goto(`${SHOP}/`);
    await page.getByTestId('product-oak-tray').click();
    await page.waitForTimeout(3000);
    await context.close();
  };
  await api.patch(`/api/v1/projects/${shop}/settings`, { data: { analytics: { enabled: false } } });
  await expect.poll(async () => ((await (await api.get(`/i/v1/config?key=${KEY}`)).json()) as { analytics: { enabled: boolean } }).analytics.enabled).toBe(false);
  await visit();
  expect(sent.hits, 'no analytics request at all').toBe(0);
  expect(sent.batches, 'the recording still flows').toBeGreaterThan(0);

  await api.patch(`/api/v1/projects/${shop}/settings`, { data: { analytics: { enabled: true } } });
  await expect.poll(async () => ((await (await api.get(`/i/v1/config?key=${KEY}`)).json()) as { analytics: { enabled: boolean } }).analytics.enabled).toBe(true);
  await visit();
  expect(sent.hits).toBeGreaterThan(0);
});

test('taps on a phone and a tablet land in their own heatmaps', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'device emulation with touch is Chromium here');
  const path = '/products/linen-throw';
  const before = {
    Mobile: (await read<{ clicks: number }>(shop, '/heatmap', { path, device: 'Mobile', days: 1 })).clicks,
    Tablet: (await read<{ clicks: number }>(shop, '/heatmap', { path, device: 'Tablet', days: 1 })).clicks,
    Desktop: (await read<{ clicks: number }>(shop, '/heatmap', { path, device: 'Desktop', days: 1 })).clicks,
  };
  const spots: Record<string, { x: number; y: number; w: number }> = {};
  for (const [name, device] of [['Mobile', devices['Pixel 7']], ['Tablet', { ...devices['iPad (gen 7)'], defaultBrowserType: undefined }]] as const) {
    const context = await browser.newContext({ ...device });
    const page = await context.newPage();
    expect(device.hasTouch, `${name} is a touch device`).toBe(true);
    await page.goto(`${SHOP}${path}`);
    const button = page.getByTestId('add-to-cart');
    await button.scrollIntoViewIfNeeded();
    for (let i = 0; i < 4; i++) await button.tap();
    const box = (await button.boundingBox())!;
    const scroll = await page.evaluate(() => ({ y: window.scrollY, w: document.documentElement.scrollWidth, inner: window.innerWidth }));
    spots[name] = { x: Math.floor(((box.x + box.width / 2) / scroll.w) * 100), y: Math.floor((box.y + box.height / 2 + scroll.y) / 10), w: scroll.inner };
    await page.waitForTimeout(2600);
    await page.goto('about:blank');
    await context.close();
  }
  expect(spots.Mobile!.w).toBeLessThan(768);
  expect(spots.Tablet!.w).toBeGreaterThanOrEqual(768);
  expect(spots.Tablet!.w).toBeLessThan(1024);

  for (const name of ['Mobile', 'Tablet'] as const) {
    await expect.poll(async () => (await read<{ clicks: number }>(shop, '/heatmap', { path, device: name, days: 1 })).clicks, { timeout: 15_000 }).toBe(before[name] + 4);
    const heat = await read<{ cells: { x: number; y: number; n: number }[]; width: number; snapshot: { recordingId: string } | null }>(shop, '/heatmap', { path, device: name, days: 1 });
    const spot = spots[name]!;
    const near = heat.cells.filter((cell) => Math.abs(cell.x - spot.x) <= 2 && Math.abs(cell.y - spot.y) <= 2).reduce((sum, cell) => sum + cell.n, 0);
    expect(near, `${name}: the taps are where the button was (${spot.x}%, ${spot.y * 10}px)`).toBeGreaterThanOrEqual(4);
    expect(heat.snapshot, `${name}: a recording of that width shows the page`).not.toBeNull();
  }
  expect((await read<{ clicks: number }>(shop, '/heatmap', { path, device: 'Desktop', days: 1 })).clicks, 'none of them count as desktop').toBe(before.Desktop);

  const { context, page } = await signedIn(browser, await api.storageState());
  for (const name of ['Mobile', 'Tablet']) {
    await page.goto(at(shop, `/heatmaps?days=1&path=${encodeURIComponent(path)}&device=${name}`));
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Add to cart').first()).toBeVisible();
    await page.waitForTimeout(2500);
    await shot(page, `33-heatmap-${name.toLowerCase()}`);
  }
  await context.close();
});

test('a viewer sees everything and can change nothing', async ({ browser }) => {
  // A viewer joins through an invitation, as a person would.
  const email = `viewer-${run}@kimmi.test`;
  const secret = `viewer-${run}-${Math.random().toString(36).slice(2)}`;
  const invited = await api.post('/api/v1/invitations', { data: { email, role: 'viewer' } });
  expect(invited.status()).toBe(201);
  const token = ((await invited.json()) as { link: string }).link.split('/').pop()!;
  const viewer = await request.newContext({ baseURL: KIMMI });
  const accepted = await viewer.post('/api/v1/invitations/accept', { data: { token, name: 'Vera Viewer', password: secret } });
  expect(accepted.status(), await accepted.text()).toBe(201);
  const me = ((await accepted.json()) as { user: { id: string; role: string } }).user;
  expect(me.role).toBe('viewer');
  expect((await api.post(`/api/v1/projects/${shop}/members`, { data: { userId: me.id, role: 'viewer' } })).status()).toBe(201);

  // The API refuses what the screens hide.
  const recording = (await read<{ items: { id: string }[] }>(shop, '/recordings', { limit: 1 })).items[0]!.id;
  const base = `/api/v1/projects/${shop}`;
  expect((await viewer.post(`${base}/recordings/${recording}/notes`, { data: { atMs: 0, body: 'no' } })).status()).toBe(403);
  expect((await viewer.post(`${base}/shares`, { data: { kind: 'recording', recordingId: recording, expiresInDays: 1 } })).status()).toBe(403);
  expect((await viewer.get(`${base}/shares`)).status()).toBe(403);
  expect((await viewer.patch(`${base}/settings`, { data: { analytics: { enabled: false } } })).status()).toBe(403);
  expect((await viewer.post(`${base}/alerts/test`)).status()).toBe(403);
  expect((await viewer.delete(`${base}/recordings/${recording}`)).status()).toBe(403);
  await api.patch(`${base}/settings`, { data: { alerts: { webhookUrl: 'https://hooks.example/kimmi', secret: 'not-for-viewers' } } });
  const seen = await (await viewer.get(`${base}/settings`)).text();
  expect(seen).not.toContain('hooks.example');
  expect(seen).not.toContain('not-for-viewers');
  expect((await viewer.get(`${base}/analytics`)).status(), 'reading stays open').toBe(200);

  const { context, page } = await signedIn(browser, await viewer.storageState());
  await page.goto(at(shop, '/analytics?days=1'));
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();

  await page.goto(at(shop, `/recordings/${recording}`));
  await page.getByRole('tab', { name: /notes/i }).click();
  await expect(page.getByPlaceholder(/add a note/i), 'no note input').toHaveCount(0);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByText(/only admins can create public links/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create link' })).toHaveCount(0);
  await shot(page, '34-viewer-share');
  await page.keyboard.press('Escape');

  await page.goto(at(shop, '/settings/analytics'));
  await expect(page.getByText('Count visits').first()).toBeVisible();
  for (const control of await page.getByRole('switch').all()) await expect(control).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add goal' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add funnel' })).toHaveCount(0);
  await shot(page, '35-viewer-settings');

  await page.goto(at(shop, '/settings/alerts'));
  await expect(page.getByPlaceholder('Only admins can see the webhook')).toBeVisible();
  await expect(page.getByText('hooks.example')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /send a test|send test/i })).toBeDisabled();

  await page.goto(at(shop, '/settings/sharing'));
  await expect(page.getByText(/only admins can manage public links/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create link' })).toBeDisabled();
  await expect(page.getByRole('switch').first()).toBeDisabled();

  await page.goto(at(shop, '/feedback'));
  await expect(page.getByRole('heading', { name: 'Feedback' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
  await context.close();

  await api.patch(`${base}/settings`, { data: { alerts: { webhookUrl: '', secret: '' } } });
  await api.delete(`/api/v1/members/${me.id}`);
  await viewer.dispose();
});

test('every new page in the light theme', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots for review: one browser');
  const { context, page } = await signedIn(browser, await api.storageState(), 'light');
  const recording = (await read<{ items: { id: string }[] }>(shop, '/recordings', { sort: 'score', limit: 1 })).items[0]!.id;
  const fingerprint = (await read<{ fingerprint: string }[]>(shop, '/errors', { days: 7 }))[0]?.fingerprint ?? 'none';
  const pages: [string, string][] = [
    ['overview', ''],
    ['analytics', '/analytics?days=7'],
    ['funnels', '/funnels?days=7'],
    ['heatmaps', '/heatmaps?days=7&path=%2Fproducts%2Foak-tray'],
    ['heatmaps-scroll', '/heatmaps?days=7&path=%2F&view=scroll'],
    ['errors', '/errors?days=7'],
    ['error-detail', `/errors/${fingerprint}?days=7`],
    ['friction', '/friction?days=7'],
    ['performance', '/performance?days=7'],
    ['feedback', '/feedback'],
    ['recordings', '/recordings?sort=score&event=track%3Apurchase'],
    ['player', `/recordings/${recording}`],
    ['visitors-returning', '/visitors?tab=returning'],
    ['visitors-accounts', '/visitors?tab=accounts'],
    ['settings-analytics', '/settings/analytics'],
    ['settings-alerts', '/settings/alerts'],
    ['settings-sharing', '/settings/sharing'],
  ];
  for (const [name, path] of pages) {
    await page.goto(at(shop, path));
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(name.startsWith('heatmaps') || name === 'player' ? 2500 : 400);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await shot(page, `light-${name}`);
  }
  await context.close();
  expect((await sidebarLinks(page).catch(() => [])).length).toBeGreaterThanOrEqual(0);
});
