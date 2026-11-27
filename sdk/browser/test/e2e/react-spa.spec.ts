import { expect, test } from '@playwright/test';
import { customEvents, received, reset, type Batch } from './helpers';
import { REACT_PORT } from './playwright.config';

const SHOP = `http://localhost:${REACT_PORT}`;

const KEY = 'km_pub_react';
const typed = { email: 'ada@example.com', name: 'Ada Lovelace', address: '12 Analytical Row', card: '4242 4242 4242 4242' };

test('records a shopping session in the React example', async ({ page }) => {
  await reset();
  const started = Date.now();
  await page.goto(`${SHOP}/`);

  await page.getByTestId('product-oak-tray').click();
  await page.getByTestId('add-to-cart').click();
  await page.getByTestId('check-stock').click();
  await expect(page.getByText('Stock levels are unavailable right now.')).toBeVisible();

  for (let i = 0; i < 4; i++) await page.getByTestId('dead-button').click();
  await page.waitForTimeout(1800);

  await page.getByTestId('trigger-error').click();

  await page.getByTestId('cart-link').click();
  await page.getByTestId('go-checkout').click();
  await page.getByTestId('email').pressSequentially(typed.email);
  await page.getByTestId('name').pressSequentially(typed.name);
  await page.getByTestId('address').fill(typed.address);
  await page.getByTestId('card').fill(typed.card);

  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByTestId('login-email').fill(typed.email);
  await page.getByTestId('login-password').fill('correct horse');
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('link', { name: 'Hi, ada' })).toBeVisible();

  const tags = ['navigate', 'console', 'network', 'error', 'rage-click', 'dead-click', 'identify'];
  await expect
    .poll(async () => {
      const { batches } = await received(KEY);
      return tags.filter((tag) => customEvents(batches, tag).length > 0);
    }, { timeout: 15_000 })
    .toEqual(tags);
  const { batches, rejected } = await received(KEY);
  expect(rejected).toEqual([]);

  // One session, seq 0..n-1 in arrival order.
  expect(new Set(batches.map((b) => b.meta.sessionId)).size).toBe(1);
  expect(batches.map((b) => b.meta.seq)).toEqual(batches.map((_, i) => i));
  expect(batches.some((b) => b.beacon)).toBe(false);

  const firstTypes = batches[0]!.events.map((e) => e.type);
  expect(firstTypes).toContain(4);
  expect(firstTypes).toContain(2);
  expect(firstTypes.indexOf(4)).toBeLessThan(firstTypes.indexOf(2));

  const paths = customEvents(batches, 'navigate').map((e) => e.data.payload!.path);
  expect(paths).toEqual(['/', '/products/oak-tray', '/cart', '/checkout', '/login', '/']);

  const network = customEvents(batches, 'network').map((e) => e.data.payload!);
  expect(network).toContainEqual(expect.objectContaining({ kind: 'fetch', method: 'GET', status: 200, url: `${SHOP}/products.json` }));
  expect(network).toContainEqual(expect.objectContaining({ status: 404, url: `${SHOP}/api/stock/oak-tray.json` }));
  expect(network.every((n) => !String(n.url).includes(':5291'))).toBe(true);

  const errors = customEvents(batches, 'error').map((e) => e.data.payload!);
  expect(errors[0]!.message).toContain('Gift card balance service is unavailable');
  expect(customEvents(batches, 'console').map((e) => e.data.payload!.text)).toContainEqual(expect.stringContaining('Added to cart: oak-tray'));
  expect(customEvents(batches, 'rage-click')[0]!.data.payload).toMatchObject({ text: 'Compare', count: 4 });
  expect(customEvents(batches, 'dead-click')[0]!.data.payload).toMatchObject({ text: 'Compare' });

  // maskAllInputs: no typed value reaches the DOM recording, only asterisks. (The app itself logs the email.)
  const recorded = JSON.stringify(batches.map((b) => b.events.filter((e) => e.type !== 5)));
  // Whole values only: a fragment like "4242" also turns up inside event timestamps.
  for (const value of [typed.email, typed.name, typed.address, typed.card, typed.card.replace(/ /g, ''), 'correct horse']) {
    expect(recorded).not.toContain(value);
  }
  const inputs = batches.flatMap((b) => b.events).filter((e) => e.type === 3 && e.data.source === 5);
  expect(inputs.length).toBeGreaterThan(0);
  for (const input of inputs) expect(input.data.text).toMatch(/^\**$/);

  expect(batches[batches.length - 1]!.meta.identity).toMatchObject({ id: typed.email, email: typed.email, name: 'ada' });

  const total = (field: keyof Batch['meta']['counts']) => batches.reduce((sum, b) => sum + b.meta.counts[field], 0);
  expect(total('events')).toBe(batches.reduce((sum, b) => sum + b.events.length, 0));
  expect(total('clicks')).toBeGreaterThanOrEqual(11);
  expect(total('keypresses')).toBeGreaterThanOrEqual(typed.email.length + typed.name.length);
  expect(total('rageClicks')).toBe(1);
  expect(total('deadClicks')).toBeGreaterThanOrEqual(1);
  expect(total('errors')).toBe(1);
  expect(total('pageviews')).toBe(6);
  expect(total('activeMs')).toBeGreaterThan(1000);
  expect(total('activeMs')).toBeLessThan(Date.now() - started);
  expect(batches.flatMap((b) => b.meta.paths)).toEqual(expect.arrayContaining(['/', '/products/oak-tray', '/cart', '/checkout', '/login']));

  // Leaving the page sends what is left with sendBeacon.
  const before = batches.length;
  await page.getByTestId('product-linen-throw').click();
  await page.close({ runBeforeUnload: true });
  await expect
    .poll(async () => (await received(KEY)).batches.slice(before).filter((b) => b.beacon).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const after = (await received(KEY)).batches;
  expect(after.map((b) => b.meta.seq)).toEqual(after.map((_, i) => i));
  expect(customEvents(after, 'navigate').map((e) => e.data.payload!.path)).toContain('/products/linen-throw');
});
