import { expect, test } from '@playwright/test';
import { customEvents, received, reset } from './helpers';
import { NEXT_PORT } from './playwright.config';

const KEY = 'km_pub_next';

test('records the Next.js example and sees client-side navigation', async ({ page }) => {
  await reset();
  await page.goto(`http://localhost:${NEXT_PORT}/`);

  await expect.poll(async () => (await received(KEY)).batches.length, { timeout: 15_000 }).toBeGreaterThan(0);
  const first = (await received(KEY)).batches[0]!;
  expect(first.meta.seq).toBe(0);
  expect(first.events.map((e) => e.type)).toEqual(expect.arrayContaining([4, 2]));

  await page.getByTestId('nav-pricing').click();
  await expect(page.getByRole('heading', { name: 'Pricing' })).toBeVisible();
  await expect
    .poll(async () => customEvents((await received(KEY)).batches, 'navigate').map((e) => e.data.payload!.path), { timeout: 10_000 })
    .toEqual(['/', '/pricing']);

  const { batches, rejected } = await received(KEY);
  expect(rejected).toEqual([]);
  expect(new Set(batches.map((b) => b.meta.sessionId)).size).toBe(1);
  expect(batches.map((b) => b.meta.seq)).toEqual(batches.map((_, i) => i));
});
