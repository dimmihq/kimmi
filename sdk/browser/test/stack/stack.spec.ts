import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { HOOK_PORT, KEY, KIMMI, SHOP_PORT } from './playwright.config';

// Visitors use the example shop; then the API and the dashboard are checked for what they did.

const SHOP = `http://localhost:${SHOP_PORT}`;
const EMAIL = process.env.DEV_ACCOUNT_EMAIL ?? '';
const PASSWORD = process.env.DEV_ACCOUNT_PASSWORD ?? '';
const SHOTS = process.env.KIMMI_SHOTS ?? 'test-results/stack';
// The container reaches a server on this machine through Docker's host name.
const HOOK = `http://${process.env.KIMMI_HOOK_HOST ?? 'host.docker.internal'}:${HOOK_PORT}/hook`;

interface Delivery {
  event: string;
  title: string;
  text: string;
  url: string;
  data?: Record<string, unknown>;
  signature: string;
}

let api: APIRequestContext;
let project: string;
let hook: Server;
const deliveries: Delivery[] = [];
const run = Date.now().toString(36);
const feedbackText = `The gift card box is confusing (${run})`;
let buyer = '';
let shareLink = '';

const get = async <T>(path: string, params?: Record<string, string | number>) => {
  const response = await api.get(`/api/v1/projects/${project}${path}`, { params });
  expect(response.status(), `GET ${path}`).toBe(200);
  return (await response.json()) as T;
};

const delivered = (event: string) => deliveries.filter((delivery) => delivery.event === event);

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** Gives the SDK its 2 s tick, then leaves, which flushes what is left with a beacon. */
async function leave(page: Page) {
  await page.waitForTimeout(2600);
  await page.goto('about:blank');
  await page.waitForTimeout(300);
}

async function visitor(browser: Browser, journey: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await journey(page);
  await leave(page);
  await context.close();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(EMAIL, 'DEV_ACCOUNT_EMAIL and DEV_ACCOUNT_PASSWORD come from the repository .env').not.toBe('');
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        deliveries.push({ ...(JSON.parse(body) as Delivery), signature: String(req.headers['x-kimmi-signature'] ?? '') });
      } catch {
        // not JSON: not ours
      }
      res.writeHead(204).end();
    });
  }).listen(HOOK_PORT);

  api = await request.newContext({ baseURL: KIMMI });
  const login = await api.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  expect(login.status(), 'sign in with the test account').toBe(200);
  const projects = (await (await api.get('/api/v1/projects')).json()) as { id: string; publicKey: string }[];
  project = projects.find((item) => item.publicKey === KEY)?.id ?? '';
  expect(project, 'the project the global setup created').not.toBe('');

  const settings = await api.patch(`/api/v1/projects/${project}/settings`, {
    data: {
      capture: { minDurationMs: 0 },
      analytics: {
        enabled: true,
        cookieless: false,
        goals: [
          { id: '', name: 'Purchase', kind: 'event', value: 'purchase' },
          { id: '', name: 'Reached thanks', kind: 'page', value: '/thanks' },
        ],
        funnels: [
          {
            id: '',
            name: 'Buy something',
            steps: [
              { kind: 'page', value: '/' },
              { kind: 'page', value: '/products/*' },
              { kind: 'event', value: 'add_to_cart' },
              { kind: 'page', value: '/checkout' },
              { kind: 'event', value: 'purchase' },
            ],
          },
        ],
      },
      feedback: { widget: true },
      alerts: { webhookUrl: HOOK, secret: 'stack-test', newErrors: true, errorSpike: 0, rageSpike: 0, feedback: true },
      sharing: { enabled: true },
    },
  });
  expect(settings.status(), await settings.text()).toBe(200);
  // An ingest node reloads projects within 5 seconds; this one is told at once, but be sure.
  await expect
    .poll(async () => ((await (await api.get(`/i/v1/config?key=${KEY}`)).json()) as { feedback: { widget: boolean } }).feedback.widget)
    .toBe(true);
});

test.afterAll(async () => {
  await api?.patch(`/api/v1/projects/${project}/settings`, { data: { analytics: { cookieless: false }, alerts: { webhookUrl: '' } } });
  await api?.dispose();
  hook?.close();
});

test('the webhook receives a signed test delivery', async () => {
  const response = await api.post(`/api/v1/projects/${project}/alerts/test`);
  expect(response.status(), await response.text()).toBe(204);
  await expect.poll(() => delivered('test').length).toBeGreaterThan(0);
  expect(delivered('test')[0]!.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
});

test('a visitor buys something, hits an error, rage-clicks and leaves feedback', async ({ browser }) => {
  await visitor(browser, async (page) => {
    await page.goto(`${SHOP}/?utm_source=newsletter&utm_medium=email&utm_campaign=spring-${run}`);
    await page.getByTestId('product-oak-tray').click();
    await page.mouse.wheel(0, 600);
    await page.getByTestId('add-to-cart').click();
    await page.getByTestId('check-stock').click();
    await expect(page.getByText('Stock levels are unavailable right now.')).toBeVisible();
    for (let i = 0; i < 5; i++) await page.getByTestId('dead-button').click();
    await page.waitForTimeout(1800);
    // The feedback button floats over the footer's corner, where this link sits.
    await page.getByTestId('trigger-error').dispatchEvent('click');

    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Send feedback' });
    await dialog.getByRole('textbox').first().fill(feedbackText);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Thanks for your feedback.')).toBeVisible();

    await page.getByTestId('cart-link').click();
    await page.getByTestId('go-checkout').click();
    await page.getByTestId('email').fill('ada@example.com');
    await page.getByTestId('name').fill('Ada Lovelace');
    await page.getByTestId('address').fill('12 Analytical Row');
    await page.getByTestId('card').fill('4242 4242 4242 4242');
    await page.getByTestId('place-order').click();
    await expect(page).toHaveURL(/\/thanks$/);
    buyer = (await page.evaluate(() => (window as unknown as { kimmi?: { getSessionId(): string | null } }).kimmi?.getSessionId?.() ?? '')) || '';
  });
});

test('a second visitor looks at a product and leaves', async ({ browser }) => {
  await visitor(browser, async (page) => {
    await page.goto(`${SHOP}/`);
    await page.getByTestId('product-oak-tray').click();
    await page.getByTestId('add-to-cart').click();
    await page.waitForTimeout(500);
  });
});

test('cookieless counting stores nothing in the browser and still counts the visit', async ({ browser }) => {
  // The server writes hits every 2 seconds: let the earlier visitors' last ones land before counting.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const before = await get<{ totals: { pageviews: number } }>('/analytics', { days: 1 });
  await api.patch(`/api/v1/projects/${project}/settings`, { data: { analytics: { cookieless: true } } });
  await expect
    .poll(async () => ((await (await api.get(`/i/v1/config?key=${KEY}`)).json()) as { analytics: { cookieless: boolean } }).analytics.cookieless)
    .toBe(true);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${SHOP}/`);
  await page.getByTestId('product-oak-tray').click();
  await page.waitForTimeout(2600);
  const keys = await page.evaluate(() => ({
    local: Object.keys(localStorage).filter((key) => key.startsWith('kimmi.')),
    session: Object.keys(sessionStorage).filter((key) => key.startsWith('kimmi.')),
    cookies: document.cookie,
  }));
  expect(keys).toEqual({ local: [], session: [], cookies: '' });
  await leave(page);
  await context.close();
  // Two pages were viewed. They join the visit of the same address and browser when one is under 30 minutes old
  // (an earlier run of this test), so page views are what is sure to grow.
  await expect.poll(async () => (await get<{ totals: { pageviews: number } }>('/analytics', { days: 1 })).totals.pageviews, { timeout: 15_000 }).toBe(before.totals.pageviews + 2);
  await api.patch(`/api/v1/projects/${project}/settings`, { data: { analytics: { cookieless: false } } });
});

test('the API shows what the visitors did', async () => {
  interface Traffic {
    totals: { visits: number; visitors: number; pageviews: number };
    sources: { name: string; visitors: number }[];
    campaigns: { name: string }[];
    channels: { name: string }[];
    pages: { path: string; views: number; scroll: number }[];
    goals: { name: string; conversions: number }[];
  }
  await expect.poll(async () => (await get<Traffic>('/analytics', { days: 1 })).goals.find((goal) => goal.name === 'Purchase')?.conversions ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  const traffic = await get<Traffic>('/analytics', { days: 1 });
  expect(traffic.totals.visits).toBeGreaterThanOrEqual(3);
  expect(traffic.sources.map((source) => source.name)).toContain('newsletter');
  expect(traffic.campaigns.map((campaign) => campaign.name)).toContain(`spring-${run}`);
  expect(traffic.channels.map((channel) => channel.name)).toContain('Email');
  expect(traffic.pages.map((page) => page.path)).toEqual(expect.arrayContaining(['/', '/products/oak-tray', '/checkout', '/thanks']));
  expect(traffic.goals.find((goal) => goal.name === 'Reached thanks')!.conversions).toBeGreaterThan(0);

  const campaign = await get<Traffic>('/analytics', { days: 1, utmCampaign: `spring-${run}` });
  expect(campaign.totals.visits).toBe(1);

  const events = await get<{ name: string; count: number; value: number }[]>('/events', { days: 1 });
  expect(events.find((event) => event.name === 'add_to_cart')!.count).toBeGreaterThanOrEqual(2);
  expect(events.find((event) => event.name === 'purchase')!.value).toBeGreaterThan(0);

  const funnels = await get<{ id: string; name: string; steps: { visits: number; dropped: number; watchable: number }[] }[]>('/funnels', { days: 1 });
  const funnel = funnels.find((item) => item.name === 'Buy something')!;
  const counts = funnel.steps.map((step) => step.visits);
  expect(counts[0]).toBeGreaterThanOrEqual(3);
  expect(counts[2]).toBeGreaterThanOrEqual(2);
  expect(counts[4]).toBeGreaterThanOrEqual(1);
  expect(counts[2]! - counts[3]!).toBeGreaterThanOrEqual(1);
  const dropoffs = await get<{ items: { id: string }[]; visits: number }>(`/funnels/${funnel.id}/dropoffs`, { days: 1, step: 2 });
  expect(dropoffs.visits).toBeGreaterThanOrEqual(1);
  expect(dropoffs.items.length, 'the visitor who stopped after adding to the cart was recorded').toBeGreaterThanOrEqual(1);

  const errors = await get<{ fingerprint: string; message: string; visits: number }[]>('/errors', { days: 1 });
  const group = errors.find((item) => item.message.includes('Gift card balance service is unavailable'))!;
  expect(group, 'the error group').toBeTruthy();
  const detail = await get<{ occurrences: { recorded: boolean; visitId: string }[] }>(`/errors/${group.fingerprint}`, { days: 1 });
  expect(detail.occurrences.some((occurrence) => occurrence.recorded), 'an occurrence links to its replay').toBe(true);

  const friction = await get<{ elements: { kind: string; selector: string; path: string }[] }>('/friction', { days: 1 });
  expect(friction.elements.some((element) => element.kind === 'rage' && element.path === '/products/oak-tray')).toBe(true);

  const requests = await get<{ name: string; failed: number }[]>('/requests', { days: 1 });
  expect(requests.some((item) => item.name.includes('/api/stock/oak-tray.json') && item.failed > 0)).toBe(true);

  const vitals = await get<{ path: string; ttfb: number; fcp: number }[]>('/vitals', { days: 1 });
  expect(vitals[0]!.path).toBe('');
  expect(vitals[0]!.ttfb).toBeGreaterThanOrEqual(0);
  expect(vitals[0]!.fcp).toBeGreaterThan(0);

  const heat = await get<{ clicks: number; cells: { x: number; y: number; n: number }[]; scroll: number[]; views: number; snapshot: { recordingId: string } | null }>(
    '/heatmap', { days: 1, path: '/products/oak-tray', device: 'Desktop' });
  expect(heat.clicks).toBeGreaterThanOrEqual(7);
  const hottest = heat.cells.reduce((best, cell) => (cell.n > best.n ? cell : best));
  expect(hottest.n, 'the rage-clicked button is the hottest cell').toBeGreaterThanOrEqual(5);
  expect(heat.views).toBeGreaterThan(0);
  expect(heat.snapshot, 'a recording shows the page').not.toBeNull();

  const feedback = await get<{ items: { body: string; recorded: boolean; path: string }[] }>('/feedback');
  const message = feedback.items.find((item) => item.body === feedbackText)!;
  expect(message, 'the feedback').toBeTruthy();
  expect(message.recorded).toBe(true);
  expect(message.path).toBe('/products/oak-tray');

  const recordings = await get<{ total: number; items: { id: string }[] }>('/recordings', { event: `error:${group.fingerprint}` });
  expect(recordings.total).toBeGreaterThanOrEqual(1);
  const watch = await get<{ items: { id: string; errors: number }[] }>('/recordings', { sort: 'score', limit: 5 });
  expect(watch.items[0]!.errors, 'the recording most worth watching has the error').toBeGreaterThan(0);

  await expect.poll(() => delivered('feedback.new').some((delivery) => delivery.text === feedbackText), { timeout: 10_000 }).toBe(true);
  // The first run on a fresh project also delivers error.new; later runs have seen the error before.
  const digest = await api.post(`/api/v1/projects/${project}/alerts/digest`);
  expect(digest.status(), await digest.text()).toBe(204);
  await expect.poll(() => delivered('digest.weekly').length).toBeGreaterThan(0);
  expect(delivered('digest.weekly')[0]!.text).toMatch(/\d+ visitors/);
});

test('the dashboard shows it', async ({ browser }) => {
  // Signed in as the test account, with the session the API calls above use.
  const context = await browser.newContext({ storageState: await api.storageState(), viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const at = (path: string) => `${KIMMI}/projects/${project}${path}`;

  await page.goto(at('/analytics?days=1'));
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
  await expect(page.getByText('newsletter').first()).toBeVisible();
  await expect(page.getByText('Purchase').first()).toBeVisible();
  await expect(page.getByText('/products/oak-tray').first()).toBeVisible();
  await shot(page, '01-analytics');

  await page.goto(at(''));
  await expect(page.getByText('Worth watching').first()).toBeVisible();
  await shot(page, '02-overview');

  await page.goto(at('/funnels?days=1'));
  await expect(page.getByText('Buy something')).toBeVisible();
  // The visitor who added to the cart and left was recorded; the cookieless ones further up were not.
  await page.getByRole('button', { name: 'Watch', exact: true }).last().click();
  await expect(page.locator('a[href*="/recordings/"]').first()).toBeVisible();
  await shot(page, '03-funnels');

  await page.goto(at('/errors?days=1'));
  await page.getByText('Gift card balance service is unavailable').first().click();
  await expect(page).toHaveURL(/\/errors\/[0-9a-f]+/);
  await expect(page.getByRole('link', { name: /watch/i }).first()).toBeVisible();
  await shot(page, '04-error-detail');
  await page.getByRole('link', { name: /watch/i }).first().click();
  await expect(page).toHaveURL(/\/recordings\/[0-9a-f-]+/);
  await expect(page.locator('iframe').first()).toBeVisible({ timeout: 20_000 });

  // A note on a moment, then a public link to it.
  await page.getByRole('tab', { name: /notes/i }).click();
  await page.getByPlaceholder(/add a note/i).fill(`Look at this (${run})`);
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Look at this (${run})`)).toBeVisible();
  await shot(page, '05-player-notes');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('button', { name: 'Create link' }).click();
  const link = page.getByText(/\/shared\/[0-9a-f]{64}/);
  await expect(link).toBeVisible();
  shareLink = (await link.textContent())!.trim();
  await shot(page, '06-share-dialog');

  await page.goto(at('/friction?days=1'));
  await expect(page.getByText(/Compare/).first()).toBeVisible();
  await shot(page, '07-friction');

  await page.goto(at('/heatmaps?days=1&path=%2Fproducts%2Foak-tray'));
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2500);
  await shot(page, '08-heatmap-clicks');
  await page.goto(at('/heatmaps?days=1&path=%2Fproducts%2Foak-tray&view=scroll'));
  await page.waitForTimeout(2500);
  await shot(page, '09-heatmap-scroll');

  await page.goto(at('/performance?days=1'));
  await expect(page.getByText('TTFB').first()).toBeVisible();
  await expect(page.getByText(/api\/stock/).first()).toBeVisible();
  await shot(page, '10-performance');

  await page.goto(at('/feedback'));
  await expect(page.getByText(feedbackText)).toBeVisible();
  await shot(page, '11-feedback');

  await page.goto(at('/recordings?sort=score'));
  await expect(page.locator('a[href*="/recordings/"]').first()).toBeVisible();
  await shot(page, '12-recordings-score');

  await page.goto(at('/visitors?tab=returning'));
  await expect(page.getByText(/week/i).first()).toBeVisible();
  await shot(page, '13-visitors-returning');

  for (const [name, path] of [['14-settings-analytics', '/settings/analytics'], ['15-settings-alerts', '/settings/alerts'], ['16-settings-sharing', '/settings/sharing']] as const) {
    await page.goto(at(path));
    await page.waitForLoadState('networkidle');
    await shot(page, name);
  }
});

test('a signed-out visitor can watch the shared recording, until it is revoked', async ({ browser }) => {
  expect(shareLink, 'the link the dashboard created').toMatch(/\/shared\//);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(shareLink);
  await expect(page.getByText(/shared recording/i)).toBeVisible();
  await expect(page.locator('iframe').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, '17-shared-recording');
  // Signed out: the dashboard itself is closed.
  const closed = await context.request.get(`${KIMMI}/api/v1/projects/${project}/recordings`);
  expect(closed.status()).toBe(401);

  const shares = await get<{ id: string }[]>('/shares');
  for (const share of shares) await api.delete(`/api/v1/projects/${project}/shares/${share.id}`);
  await page.reload();
  await expect(page.getByText(/expired or was revoked/i)).toBeVisible();
  await context.close();
  expect(buyer).not.toBeUndefined();
});
