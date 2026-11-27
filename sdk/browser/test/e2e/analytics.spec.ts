import { expect, test, type Page } from '@playwright/test';
import { hitEvents, received, reset, setConfig, type ConfigOverrides } from './helpers';
import { MOCK_PORT, REACT_PORT } from './playwright.config';

// Analytics hits, feedback and web vitals, against the React example and a plain script-tag page the mock serves.

const SHOP = `http://localhost:${REACT_PORT}`;
const LAB = `http://localhost:${MOCK_PORT}/_analytics.html`;
const REACT = 'km_pub_react';
const SCRIPT = 'km_pub_script';

type KimmiWindow = Window & {
  kimmi: {
    track(name: string, props?: Record<string, unknown>): void;
    feedback(text: string, options?: { email?: string }): void;
    showFeedback(): void;
    getSessionId(): string | null;
  };
};

async function openLab(page: Page, overrides: ConfigOverrides = {}) {
  await reset();
  await setConfig(SCRIPT, overrides);
  await page.goto(LAB);
  await expect.poll(async () => (await hitEvents(SCRIPT, 'page')).length, { timeout: 10_000 }).toBe(1);
}

const kimmiKeys = (page: Page) =>
  page.evaluate(() => ({
    local: Object.keys(localStorage).filter((key) => key.startsWith('kimmi.')),
    session: Object.keys(sessionStorage).filter((key) => key.startsWith('kimmi.')),
  }));

test.describe('page views in the React example', () => {
  test('sends a page hit on load and one per SPA navigation, with a leave in between', async ({ page }) => {
    await reset();
    await page.goto(`${SHOP}/`);
    await expect.poll(async () => (await hitEvents(REACT, 'page')).map((e) => e.p), { timeout: 10_000 }).toEqual(['/']);
    await page.waitForTimeout(600);
    await page.getByTestId('product-oak-tray').click();
    await page.waitForTimeout(600);
    await page.getByTestId('cart-link').click();

    const flow = async () => (await hitEvents(REACT)).filter((e) => e.k === 'page' || e.k === 'leave').map((e) => `${e.k} ${e.p}`);
    await expect.poll(flow, { timeout: 10_000 }).toEqual(['page /', 'leave /', 'page /products/oak-tray', 'leave /products/oak-tray', 'page /cart']);

    await expect.poll(async () => (await received(REACT)).batches.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const { hits, rejected, batches } = await received(REACT);
    expect(rejected).toEqual([]);
    expect(hits.every((hit) => hit.contentType.startsWith('text/plain'))).toBe(true);

    // The visit is the recording session, on every hit.
    const first = hits[0]!.body;
    expect(new Set(hits.map((hit) => hit.body.visitId))).toEqual(new Set([batches[0]!.meta.sessionId]));
    expect(first.anonymousId).toBe(await page.evaluate(() => localStorage.getItem('kimmi.anonymousId')));
    expect(first.landing).toBe(`${SHOP}/`);
    expect(first.release).toBe('shop@1.4.0');
    expect(hits[hits.length - 1]!.body.url).toBe(`${SHOP}/cart`);
    expect(hits[hits.length - 1]!.body.landing).toBe(`${SHOP}/`);
    expect((await hitEvents(REACT, 'page'))[0]!.l).toBe('Fernhill Goods');

    const leaves = await hitEvents(REACT, 'leave');
    for (const leave of leaves) {
      expect(leave.v).toBeGreaterThanOrEqual(500);
      expect(leave.v).toBeLessThan(10_000);
      expect(leave.num).toBeGreaterThan(0);
      expect(leave.num).toBeLessThanOrEqual(100);
      expect(leave.y).toBeGreaterThan(0);
      expect(leave.w).toBe(page.viewportSize()!.width);
    }
  });

  test('sends clicks with a position and an uncaught error', async ({ page }) => {
    await reset();
    await page.goto(`${SHOP}/`);
    const link = page.getByTestId('product-oak-tray');
    const box = (await link.boundingBox())!;
    await link.click();
    await page.getByTestId('trigger-error').click();

    await expect.poll(async () => (await hitEvents(REACT, 'error')).length, { timeout: 10_000 }).toBe(1);
    const click = (await hitEvents(REACT, 'click'))[0]!;
    const width = page.viewportSize()!.width;
    expect(click.p).toBe('/');
    expect(click.w).toBe(width);
    // x is in ten-thousandths of the document width, y in pixels from the top of the document.
    expect(click.x).toBeGreaterThanOrEqual(Math.floor((box.x / width) * 10_000));
    expect(click.x).toBeLessThanOrEqual(Math.ceil(((box.x + box.width) / width) * 10_000));
    expect(click.y).toBeGreaterThanOrEqual(Math.floor(box.y));
    expect(click.y).toBeLessThanOrEqual(Math.ceil(box.y + box.height));
    expect(click.n).toBeTruthy();

    const error = (await hitEvents(REACT, 'error'))[0]!;
    expect(error.l).toContain('Gift card balance service is unavailable');
    expect(error.p).toBe('/products/oak-tray');
    expect(String(error.d!.stack).length).toBeLessThanOrEqual(2000);
    expect(typeof error.d!.source).toBe('string');
    expect((await received(REACT)).rejected).toEqual([]);
  });

  test('reports a failed request, and none of its own', async ({ page }) => {
    await reset();
    await page.goto(`${SHOP}/`);
    await page.getByTestId('product-oak-tray').click();
    await page.getByTestId('check-stock').click();
    await expect.poll(async () => (await hitEvents(REACT, 'request')).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const requests = await hitEvents(REACT, 'request');
    expect(requests).toContainEqual(expect.objectContaining({ n: `GET localhost:${REACT_PORT}/api/stock/oak-tray.json`, num: 404 }));
    expect(requests.every((request) => !request.n!.includes(String(MOCK_PORT)))).toBe(true);
  });

  test('keeps hits flowing at sampleRate 0, with no recording at all', async ({ page }) => {
    await reset();
    await setConfig(REACT, { sampleRate: 0 });
    await page.goto(`${SHOP}/`);
    await page.getByTestId('product-oak-tray').click();
    await page.getByTestId('trigger-error').click();
    await expect.poll(async () => (await hitEvents(REACT)).map((e) => e.k), { timeout: 10_000 }).toEqual(expect.arrayContaining(['page', 'leave', 'click', 'error']));
    await page.waitForTimeout(2500);

    const { hits, batches, rejected } = await received(REACT);
    expect(batches).toEqual([]);
    expect(rejected).toEqual([]);
    expect((await hitEvents(REACT, 'page')).map((e) => e.p)).toEqual(['/', '/products/oak-tray']);

    // With nothing recorded the visit is kept in sessionStorage, next to the visitor's id.
    const stored = await page.evaluate(() => ({ visit: JSON.parse(sessionStorage.getItem('kimmi.visit')!) as { id: string }, anonymousId: localStorage.getItem('kimmi.anonymousId') }));
    expect(new Set(hits.map((hit) => hit.body.visitId))).toEqual(new Set([stored.visit.id]));
    expect(hits[0]!.body.anonymousId).toBe(stored.anonymousId);

    // The same visit goes on after a reload.
    await page.reload();
    await expect.poll(async () => (await hitEvents(REACT, 'page')).length, { timeout: 10_000 }).toBe(3);
    expect(new Set((await received(REACT)).hits.map((hit) => hit.body.visitId)).size).toBe(1);
  });

  test('cookieless mode stores nothing, and still sends hits without an anonymous id', async ({ page }) => {
    await reset();
    await setConfig(REACT, { analytics: { cookieless: true } });
    await page.goto(`${SHOP}/`);
    await page.getByTestId('product-oak-tray').click();
    await page.getByTestId('cart-link').click();
    await expect.poll(async () => (await hitEvents(REACT, 'page')).map((e) => e.p), { timeout: 10_000 }).toEqual(['/', '/products/oak-tray', '/cart']);
    await page.waitForTimeout(2500);

    expect(await kimmiKeys(page)).toEqual({ local: [], session: [] });
    const { hits, batches, rejected } = await received(REACT);
    expect(rejected).toEqual([]);
    // The recorder of a cookieless project waits for optIn().
    expect(batches).toEqual([]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.body.anonymousId === '')).toBe(true);
    expect(new Set(hits.map((hit) => hit.body.visitId)).size).toBe(1);

    // A page load is a new visit: nothing ties the two together in the browser.
    const first = hits[0]!.body.visitId;
    await page.reload();
    await expect.poll(async () => (await hitEvents(REACT, 'page')).length, { timeout: 10_000 }).toBe(4);
    const after = (await received(REACT)).hits;
    expect(after[after.length - 1]!.body.visitId).not.toBe(first);
    expect(after[after.length - 1]!.body.anonymousId).toBe('');
    expect(await kimmiKeys(page)).toEqual({ local: [], session: [] });
  });

  test('cookieless mode keeps an identity in memory, and records after optIn', async ({ page }) => {
    await reset();
    await setConfig(REACT, { analytics: { cookieless: true } });
    await page.goto(`${SHOP}/login`);
    await page.getByTestId('login-email').fill('ada@example.com');
    await page.getByTestId('login-password').fill('correct horse');
    await page.getByTestId('login-submit').click();
    await expect(page.getByRole('link', { name: 'Hi, ada' })).toBeVisible();
    await page.waitForTimeout(2500);
    expect(await kimmiKeys(page)).toEqual({ local: [], session: [] });
    expect((await received(REACT)).batches).toEqual([]);

    await page.goto(`${SHOP}/privacy-lab`);
    await page.getByTestId('opt-in').click();
    await expect.poll(async () => (await received(REACT)).batches.length, { timeout: 10_000 }).toBeGreaterThan(0);
    // The visit becomes the recording session, with a page of its own, on the next tick.
    const ofSession = async () => {
      const { hits, batches } = await received(REACT);
      return hits.filter((hit) => hit.body.visitId === batches[0]!.meta.sessionId);
    };
    await expect.poll(async () => (await ofSession()).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const recorded = await ofSession();
    expect(recorded[0]!.body.events[0]!.k).toBe('page');
    expect(recorded[0]!.body.anonymousId).toBe(await page.evaluate(() => localStorage.getItem('kimmi.anonymousId')));
  });
});

test.describe('the script-tag install', () => {
  test('kimmi.track arrives with scrubbed props, and with the recording', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => {
      const { kimmi } = window as unknown as KimmiWindow;
      kimmi.track('plan_selected', { plan: 'pro', email: 'ada@example.com', password: 'hunter2', value: 49 });
      kimmi.track('');
    });
    await expect.poll(async () => (await hitEvents(SCRIPT, 'track')).length, { timeout: 10_000 }).toBe(1);
    expect((await hitEvents(SCRIPT, 'track'))[0]).toMatchObject({
      n: 'plan_selected',
      v: 49,
      p: '/_analytics.html',
      d: { plan: 'pro', email: '[email]', password: '[redacted]', value: 49 },
    });

    await expect
      .poll(async () => (await received(SCRIPT)).batches.flatMap((b) => b.events).filter((e) => e.type === 5 && e.data.tag === 'track').length, { timeout: 10_000 })
      .toBe(1);
    const { batches, hits, rejected } = await received(SCRIPT);
    expect(rejected).toEqual([]);
    const custom = batches.flatMap((b) => b.events).find((e) => e.type === 5 && e.data.tag === 'track')!;
    expect(custom.data.payload).toEqual({ name: 'plan_selected', props: { plan: 'pro', email: '[email]', password: '[redacted]', value: 49 } });
    expect(hits[0]!.body.release).toBe('static@1');
    expect(JSON.stringify(hits)).not.toContain('hunter2');
  });

  test('classifies outbound, download, email and phone links and form submits', async ({ page }) => {
    await openLab(page);
    for (const id of ['outbound', 'download', 'email', 'phone', 'internal', 'subscribe']) await page.locator(`#${id}`).click();
    await expect.poll(async () => (await hitEvents(SCRIPT, 'track')).length, { timeout: 10_000 }).toBe(5);
    expect((await hitEvents(SCRIPT, 'track')).map(({ n, d }) => ({ n, d }))).toEqual([
      { n: '$outbound', d: { url: 'docs.example.com/guide/start' } },
      { n: '$download', d: { file: 'price-list.pdf' } },
      { n: '$email', d: undefined },
      { n: '$phone', d: undefined },
      { n: '$form', d: { form: 'newsletter', action: '/api/subscribe' } },
    ]);
    const clicks = await hitEvents(SCRIPT, 'click');
    expect(clicks.map((e) => e.n)).toEqual(['a#outbound', 'a#download', 'a#email', 'a#phone', 'a#internal', 'button#subscribe']);
    expect(clicks[0]!.l).toBe('Read the docs');

    // Masked text never leaves, and neither do addresses, numbers or field values.
    await page.locator('#private').click();
    await expect.poll(async () => (await hitEvents(SCRIPT, 'click')).length, { timeout: 10_000 }).toBe(7);
    expect((await hitEvents(SCRIPT, 'click'))[6]).toMatchObject({ n: 'p#private', l: '' });
    const sent = JSON.stringify((await received(SCRIPT)).hits);
    for (const secret of ['ada@example.com', '2079460958', 'Lovelace', 'token=abc']) expect(sent).not.toContain(secret);
  });

  test('sends neither clicks nor automatic events when the project turns them off', async ({ page }) => {
    await openLab(page, { analytics: { heatmaps: false, autoEvents: false } });
    await page.locator('#outbound').click();
    await page.locator('#subscribe').click();
    await page.evaluate(() => (window as unknown as KimmiWindow).kimmi.track('marker'));
    await expect.poll(async () => (await hitEvents(SCRIPT, 'track')).map((e) => e.n), { timeout: 10_000 }).toEqual(['marker']);
    expect(await hitEvents(SCRIPT, 'click')).toEqual([]);
  });

  test('sends nothing when analytics is off', async ({ page }) => {
    await reset();
    await setConfig(SCRIPT, { analytics: { enabled: false } });
    await page.goto(LAB);
    await expect.poll(async () => (await received(SCRIPT)).batches.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.evaluate(() => (window as unknown as KimmiWindow).kimmi.track('ignored'));
    await page.locator('#outbound').click();
    await page.waitForTimeout(2500);
    expect((await received(SCRIPT)).hits).toEqual([]);
  });

  test('tracks scroll depth and sends the last leave with a beacon', async ({ page }) => {
    await openLab(page);
    const viewport = page.viewportSize()!;
    await page.mouse.wheel(0, 1500 - viewport.height);
    await page.waitForTimeout(500);
    await page.goto('about:blank');
    await expect.poll(async () => (await hitEvents(SCRIPT, 'leave')).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const leave = (await hitEvents(SCRIPT, 'leave'))[0]!;
    // 3000 px of body, plus the heading's margin above it.
    expect(leave.y).toBeGreaterThanOrEqual(3000);
    expect(leave.y).toBeLessThan(3060);
    expect(leave.num).toBeGreaterThanOrEqual(48);
    expect(leave.num).toBeLessThanOrEqual(52);
    const { hits } = await received(SCRIPT);
    const last = hits.find((hit) => hit.body.events.some((e) => e.k === 'leave'))!;
    expect(last.beacon).toBe(true);
    expect(last.contentType.startsWith('text/plain')).toBe(true);
  });

  test('sends web vitals once the page is hidden', async ({ page }) => {
    await openLab(page);
    await page.locator('#internal').click();
    await page.waitForTimeout(300);
    await page.goto('about:blank');
    await expect.poll(async () => (await hitEvents(SCRIPT, 'vital')).map((e) => e.n), { timeout: 10_000 }).toEqual(expect.arrayContaining(['ttfb', 'fcp']));
    const vitals = await hitEvents(SCRIPT, 'vital');
    expect(new Set(vitals.map((e) => e.n)).size).toBe(vitals.length);
    for (const vital of vitals) {
      expect(['lcp', 'cls', 'inp', 'fcp', 'ttfb']).toContain(vital.n);
      expect(vital.p).toBe('/_analytics.html');
      expect(vital.v).toBeGreaterThanOrEqual(0);
      expect(vital.v).toBeLessThan(60_000);
    }
    const value = (name: string) => vitals.find((e) => e.n === name)!.v!;
    expect(value('ttfb')).toBeGreaterThan(0);
    expect(value('fcp')).toBeGreaterThanOrEqual(value('ttfb'));
  });

  test('sends no web vitals when capture.performance is off', async ({ page }) => {
    await openLab(page, { capture: { performance: false } });
    await page.goto('about:blank');
    await expect.poll(async () => (await hitEvents(SCRIPT, 'leave')).length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await hitEvents(SCRIPT, 'vital')).toEqual([]);
  });

  test('kimmi.feedback posts scrubbed feedback under the visit', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => (window as unknown as KimmiWindow).kimmi.feedback('Checkout lost my card 4242 4242 4242 4242', { email: 'ada@example.com' }));
    await expect.poll(async () => (await received(SCRIPT)).feedback.length, { timeout: 10_000 }).toBe(1);
    const { feedback, hits, rejected } = await received(SCRIPT);
    expect(rejected).toEqual([]);
    expect(feedback[0]!.body).toMatchObject({
      v: 1,
      visitId: hits[0]!.body.visitId,
      anonymousId: hits[0]!.body.anonymousId,
      path: '/_analytics.html',
      text: 'Checkout lost my card [redacted]',
      email: 'ada@example.com',
    });
    expect(Math.abs(feedback[0]!.body.ts - Date.now())).toBeLessThan(60_000);
    // Nothing loads the widget unless it is asked for.
    expect(await page.locator('script[src*="kimmi-feedback"]').count()).toBe(0);
  });

  test('showFeedback loads the widget, which sends feedback and says thanks', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await openLab(page);
    expect(requests.filter((url) => url.includes('kimmi-feedback'))).toEqual([]);

    await page.evaluate(() => {
      const { kimmi } = window as unknown as KimmiWindow;
      kimmi.showFeedback();
      kimmi.showFeedback();
    });
    const open = page.getByRole('button', { name: 'Feedback', exact: true });
    await expect(open).toBeVisible();
    expect(requests.filter((url) => url.includes('kimmi-feedback'))).toEqual([`http://localhost:${MOCK_PORT}/kimmi-feedback.js`]);
    expect(await page.locator('body > div.kimmi-ignore').count()).toBe(1);

    // Bottom right, out of the page's own layout.
    const box = (await open.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(viewport.width - (box.x + box.width)).toBeLessThan(40);
    expect(viewport.height - (box.y + box.height)).toBeLessThan(40);

    // Opening moves focus into the panel; Escape closes it and gives focus back.
    await open.click();
    const text = page.getByRole('textbox', { name: 'What is on your mind?' });
    await expect(text).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(text).toBeHidden();
    await expect(open).toBeFocused();

    // Cancel closes too, and an empty message is not sent.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Send feedback' })).toBeVisible();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(text).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(text).toBeHidden();

    await open.click();
    await text.fill('The price list link is broken');
    await page.getByRole('textbox', { name: 'Email (optional)' }).fill('grace@example.com');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Thanks for your feedback.')).toBeVisible();
    await expect(text).toBeHidden();

    await expect.poll(async () => (await received(SCRIPT)).feedback.length, { timeout: 10_000 }).toBe(1);
    const { feedback, hits, batches, rejected } = await received(SCRIPT);
    expect(rejected).toEqual([]);
    expect(feedback[0]!.body).toMatchObject({ text: 'The price list link is broken', email: 'grace@example.com', path: '/_analytics.html', visitId: hits[0]!.body.visitId });

    // The thanks go away by themselves and the button comes back.
    await expect(open).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Thanks for your feedback.')).toBeHidden();

    // What was typed into the widget is not in the recording.
    await page.evaluate(() => console.info('widget-done'));
    await expect
      .poll(async () => JSON.stringify((await received(SCRIPT)).batches).includes('widget-done'), { timeout: 10_000 })
      .toBe(true);
    const recorded = JSON.stringify((await received(SCRIPT)).batches);
    expect(batches.length).toBeGreaterThan(0);
    expect(recorded).not.toContain('The price list link is broken');
    expect(recorded).not.toContain('grace@example.com');
  });

  test('the widget follows the colour scheme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openLab(page);
    await page.evaluate(() => (window as unknown as KimmiWindow).kimmi.showFeedback());
    const open = page.getByRole('button', { name: 'Feedback', exact: true });
    await expect(open).toBeVisible();
    const dark = await open.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await open.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(dark).not.toBe(light);
    expect(light).toBe('rgb(255, 255, 255)');
  });

  test('the project can show the widget by itself', async ({ page }) => {
    await openLab(page, { feedback: { widget: true } });
    await expect(page.getByRole('button', { name: 'Feedback', exact: true })).toBeVisible();
  });
});
