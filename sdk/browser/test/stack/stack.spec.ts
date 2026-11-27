import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { HOOK_PORT, KEY, KIMMI, NEXT_KEY, NEXT_PORT, SHOP_PORT } from './playwright.config';

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
      feedback: { button: 'bottom-left' },
      alerts: { webhookUrl: HOOK, secret: 'stack-test', newErrors: true, errorSpike: 0, rageSpike: 0, feedback: true },
      sharing: { enabled: true },
    },
  });
  expect(settings.status(), await settings.text()).toBe(200);
  // An ingest node reloads projects within 5 seconds; this one is told at once, but be sure.
  await expect
    .poll(async () => ((await (await api.get(`/i/v1/config?key=${KEY}`)).json()) as { feedback: { button: string } }).feedback.button)
    .toBe('bottom-left');
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
    await page.goto(`${SHOP}/?utm_source=newsletter&utm_medium=email&utm_campaign=spring-sale`);
    await page.getByTestId('product-oak-tray').click();
    await page.mouse.wheel(0, 600);
    await page.getByTestId('add-to-cart').click();
    await page.getByTestId('check-stock').click();
    await expect(page.getByText('Stock levels are unavailable right now.')).toBeVisible();
    for (let i = 0; i < 5; i++) await page.getByTestId('dead-button').click();
    await page.waitForTimeout(1800);
    // The project put the feedback button bottom left, so the footer's right corner is free to click.
    const button = page.getByRole('button', { name: 'Feedback', exact: true });
    const box = (await button.boundingBox())!;
    expect(box.x, 'the button sits in the left corner').toBeLessThan(40);
    expect(box.y + box.height, 'at the bottom').toBeGreaterThan(page.viewportSize()!.height - 40);
    await page.getByTestId('trigger-error').click();

    await button.click();
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
    await page.waitForTimeout(1200);
    // Signs in, which identifies them, and hits an error nobody has seen before.
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.getByTestId('login-email').fill('grace@fernhill.dev');
    await page.getByTestId('login-password').fill('correct horse');
    await page.getByTestId('login-submit').click();
    await page.evaluate((id) => {
      setTimeout(() => {
        throw new Error(`Loyalty points failed for batch ${id}`);
      });
    }, run);
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
  expect(traffic.channels.map((channel) => channel.name)).toContain('Email');
  expect(traffic.pages.map((page) => page.path)).toEqual(expect.arrayContaining(['/', '/products/oak-tray', '/checkout', '/thanks']));
  expect(traffic.goals.find((goal) => goal.name === 'Reached thanks')!.conversions).toBeGreaterThan(0);

  const campaign = await get<Traffic>('/analytics', { days: 1, utmCampaign: 'spring-sale' });
  expect(campaign.totals.visits).toBeGreaterThanOrEqual(1);
  expect(campaign.totals.visits, 'the filter narrows the numbers').toBeLessThan(traffic.totals.visits);

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

  expect(events.map((event) => event.name), 'the checkout form was counted without code').toContain('$form');
  expect((await get<{ languages: { name: string }[] }>('/analytics', { days: 1 })).languages.length).toBeGreaterThan(0);
  expect((await get<{ release: string }[]>('/releases', { days: 1 })).map((item) => item.release)).toContain('shop@1.4.0');
  expect((await get<{ domain: string }[]>('/accounts')).map((account) => account.domain)).toContain('fernhill.dev');
  expect((await get<{ daily: number; cohorts: unknown[] }>('/retention')).daily).toBeGreaterThan(0);

  await expect.poll(() => delivered('feedback.new').some((delivery) => delivery.text === feedbackText), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => delivered('error.new').some((delivery) => delivery.text.includes(run)), { timeout: 10_000 }).toBe(true);
  expect(delivered('error.new').find((delivery) => delivery.text.includes(run))!.url).toMatch(/\/errors\/[0-9a-f]{16}$/);
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

test('settings, filters and the analytics link work from the dashboard', async ({ browser }) => {
  const context = await browser.newContext({ storageState: await api.storageState(), viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const at = (path: string) => `${KIMMI}/projects/${project}${path}`;

  // A goal added in the dialog is counted at once.
  await page.goto(at('/settings/analytics'));
  await page.getByRole('button', { name: 'Add goal' }).click();
  const goal = page.getByRole('dialog');
  await goal.getByPlaceholder('Signed up').fill(`Saw the cart ${run}`);
  await goal.getByPlaceholder('/thanks').fill('/cart');
  await shot(page, '18-goal-dialog');
  await goal.getByRole('button', { name: 'Add goal' }).click();
  await expect(page.getByText(`Saw the cart ${run}`)).toBeVisible();
  const traffic = await get<{ goals: { name: string; conversions: number }[] }>('/analytics', { days: 1 });
  expect(traffic.goals.find((item) => item.name === `Saw the cart ${run}`)!.conversions).toBeGreaterThan(0);

  // The test button reaches the receiver.
  const tests = delivered('test').length;
  await page.goto(at('/settings/alerts'));
  await page.getByRole('button', { name: /send a test|send test/i }).click();
  await expect.poll(() => delivered('test').length).toBe(tests + 1);
  await expect(page.getByText('Delivered')).toBeVisible();

  // A public link to the analytics page, opened signed out, then revoked.
  await page.goto(at('/settings/sharing'));
  await page.getByRole('button', { name: 'Create link' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
  const link = page.getByText(/\/shared\/[0-9a-f]{64}/);
  await expect(link).toBeVisible();
  const url = (await link.textContent())!.trim();
  await page.getByRole('button', { name: 'Done' }).click();
  await shot(page, '19-sharing-links');
  const stranger = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const outside = await stranger.newPage();
  await outside.goto(url);
  await expect(outside.getByText(/shared analytics/i)).toBeVisible();
  await expect(outside.getByText('Visitors').first()).toBeVisible();
  await expect(outside.getByText('newsletter').first()).toBeVisible();
  await shot(outside, '20-shared-analytics');
  expect(await outside.locator('a[href*="/recordings"]').count(), 'a public page links to no recording').toBe(0);
  for (const share of await get<{ id: string; kind: string }[]>('/shares')) {
    if (share.kind === 'dashboard') await api.delete(`/api/v1/projects/${project}/shares/${share.id}`);
  }
  await outside.reload();
  await expect(outside.getByText(/expired or was revoked/i)).toBeVisible();
  await stranger.close();

  // A number's link filters the recordings; the view can be saved.
  await page.goto(at('/recordings?event=track%3Apurchase'));
  await expect(page.getByText(/purchase/).first()).toBeVisible();
  await expect(page.locator('a[href*="/recordings/"]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Saved' }).click();
  await page.getByRole('menuitem', { name: /save this view/i }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(`Buyers ${run}`);
  await page.getByRole('dialog').getByRole('button', { name: /^save/i }).click();
  await page.getByRole('button', { name: 'Saved' }).click();
  await expect(page.getByRole('menuitem', { name: `Buyers ${run}`, exact: true })).toBeVisible();
  await shot(page, '21-recordings-filtered');
  await page.keyboard.press('Escape');

  await page.goto(at('/visitors?tab=accounts'));
  await expect(page.getByText('fernhill.dev')).toBeVisible();
  await shot(page, '22-visitors-accounts');
  await context.close();
});

test('the Next.js example is counted and recorded too', async ({ browser }) => {
  const projects = (await (await api.get('/api/v1/projects')).json()) as { id: string; publicKey: string }[];
  const site = projects.find((item) => item.publicKey === NEXT_KEY)!.id;
  const config = await api.patch(`/api/v1/projects/${site}/settings`, { data: { capture: { minDurationMs: 0 }, analytics: { enabled: true, cookieless: false } } });
  expect(config.status(), await config.text()).toBe(200);
  const read = async <T>(path: string, params?: Record<string, string | number>) =>
    (await (await api.get(`/api/v1/projects/${site}${path}`, { params })).json()) as T;
  const before = (await read<{ totals: { pageviews: number } }>('/analytics', { days: 1 })).totals.pageviews;
  const recorded = (await read<{ total: number }>('/recordings')).total;

  await visitor(browser, async (page) => {
    await page.goto(`http://localhost:${NEXT_PORT}/?utm_source=stack-test`);
    await page.waitForTimeout(800);
    await page.getByTestId('nav-pricing').click();
    await expect(page.getByRole('heading', { name: 'Pricing' })).toBeVisible();
    await page.evaluate((id) => {
      setTimeout(() => {
        throw new Error(`Plan table failed to load ${id}`);
      });
    }, run);
    await page.waitForTimeout(800);
  });

  await expect.poll(async () => (await read<{ totals: { pageviews: number } }>('/analytics', { days: 1 })).totals.pageviews, { timeout: 15_000 }).toBe(before + 2);
  const traffic = await read<{ pages: { path: string }[]; sources: { name: string }[] }>('/analytics', { days: 1 });
  expect(traffic.pages.map((page) => page.path)).toEqual(expect.arrayContaining(['/', '/pricing']));
  expect(traffic.sources.map((source) => source.name)).toContain('stack-test');
  const errors = await read<{ message: string; fingerprint: string }[]>('/errors', { days: 1 });
  const group = errors.find((item) => item.message.includes(run))!;
  expect(group, 'the error thrown in the Next.js page').toBeTruthy();
  const detail = await read<{ occurrences: { recorded: boolean; path: string }[] }>(`/errors/${group.fingerprint}`, { days: 1 });
  expect(detail.occurrences[0]).toMatchObject({ recorded: true, path: '/pricing' });
  expect((await read<{ total: number }>('/recordings')).total).toBe(recorded + 1);

  // Its dashboard pages render with that data.
  const context = await browser.newContext({ storageState: await api.storageState(), viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${KIMMI}/projects/${site}/analytics?days=1`);
  await expect(page.getByText('/pricing').first()).toBeVisible();
  await expect(page.getByText('stack-test').first()).toBeVisible();
  await page.goto(`${KIMMI}/projects/${site}/errors?days=1`);
  await page.getByText(`Plan table failed to load ${run}`).first().click();
  await page.getByRole('link', { name: /watch/i }).first().click();
  await expect(page.locator('iframe').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, '23-nextjs-replay');
  await context.close();
});

test('a signed-out visitor can watch the shared recording, until it is revoked', async ({ browser }) => {
  expect(shareLink, 'the link the dashboard created').toMatch(/\/shared\//);
  const context = await browser.newContext();
  const page = await context.newPage();
  // Everything the public page is sent, to check it against what it shows.
  const sent: { url: string; body: string }[] = [];
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (url.origin !== new URL(KIMMI).origin || !/^\/(api|i|mcp)\b/.test(url.pathname)) return;
    sent.push({ url: url.pathname, body: await response.text().catch(() => '') });
  });
  await page.goto(shareLink);
  await expect(page.getByText(/shared recording/i)).toBeVisible();
  await expect(page.locator('iframe').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, '17-shared-recording');
  // Signed out: the dashboard itself is closed.
  const closed = await context.request.get(`${KIMMI}/api/v1/projects/${project}/recordings`);
  expect(closed.status()).toBe(401);

  // The page asked for the link and its events, and for nothing else.
  const token = shareLink.slice(shareLink.lastIndexOf('/') + 1);
  await expect.poll(() => sent.some((response) => response.url.endsWith('/events'))).toBe(true);
  expect([...new Set(sent.map((response) => response.url))].sort()).toEqual([`/api/v1/shared/${token}`, `/api/v1/shared/${token}/events`]);
  const link = JSON.parse(sent.find((response) => response.url === `/api/v1/shared/${token}`)!.body) as Record<string, unknown>;
  expect(Object.keys(link).sort()).toEqual(['expiresAt', 'kind', 'project', 'recording', 'startMs']);
  expect(Object.keys(link.recording as object).sort()).toEqual(['browser', 'device', 'durationMs', 'live', 'os', 'pages', 'startedAt', 'viewport']);
  const stream = sent.find((response) => response.url.endsWith('/events'))!.body;
  const events = (JSON.parse(stream) as { events: { type: number; data: { tag?: string; payload?: Record<string, unknown> } }[] }).events;
  expect(events.length).toBeGreaterThan(10);
  expect([...new Set(events.map((event) => event.type))].every((type) => type >= 0 && type <= 5)).toBe(true);
  const custom = events.filter((event) => event.type === 5);
  expect(custom.length, 'navigations are sent').toBeGreaterThan(0);
  for (const event of custom) {
    expect(event.data.tag).toBe('navigate');
    expect(Object.keys(event.data.payload!).sort()).toEqual(['href', 'path', 'title']);
  }
  // The same recording, signed in, does hold the console and network data the public answer must not.
  const share = (await get<{ recordingId: string }[]>('/shares')).find((item) => item.recordingId)!;
  const full = await (await api.get(`/api/v1/projects/${project}/recordings/${share.recordingId}/events`, { params: { after: -1 } })).text();
  for (const hidden of ['"tag":"console"', '"tag":"network"', '"tag":"error"', '"tag":"rage-click"', '"tag":"track"', 'Stock lookup failed', '/api/stock/', 'Gift card balance service']) {
    expect(full, `the signed-in stream holds ${hidden}`).toContain(hidden);
    expect(stream, `the public stream must not hold ${hidden}`).not.toContain(hidden);
  }
  for (const response of sent) expect(response.body).not.toContain(share.recordingId);

  const shares = await get<{ id: string }[]>('/shares');
  for (const share of shares) await api.delete(`/api/v1/projects/${project}/shares/${share.id}`);
  await page.reload();
  await expect(page.getByText(/expired or was revoked/i)).toBeVisible();
  await context.close();
  expect(buyer).not.toBeUndefined();
});
