import { expect, test } from '@playwright/test';
import { MOCK_PORT } from './playwright.config';
import { customEvents, received, reset } from './helpers';

const KEY = 'km_pub_script';

test('the kimmi.js script tag auto-inits from its data attributes and exposes window.kimmi', async ({ page }) => {
  await reset();
  await page.goto(`http://localhost:${MOCK_PORT}/_script.html`);
  await expect.poll(() => page.evaluate(() => typeof (window as { kimmi?: unknown }).kimmi)).toBe('object');
  await expect.poll(() => page.evaluate(() => (window as unknown as { kimmi: { getSessionId(): string | null } }).kimmi.getSessionId())).not.toBeNull();

  await page.locator('#hash-link').click();
  await expect
    .poll(async () => customEvents((await received(KEY)).batches, 'navigate').map((e) => e.data.payload!.href), { timeout: 10_000 })
    .toEqual([`http://localhost:${MOCK_PORT}/_script.html`, `http://localhost:${MOCK_PORT}/_script.html#pricing`]);
  const { batches } = await received(KEY);
  expect(batches[0]!.meta.seq).toBe(0);
  expect((batches[0]!.meta as { release?: string }).release).toBe('static@1');
});
