import { devices, test } from '@playwright/test';
import { SHOPS } from './playwright.config';

// Run last: one real visitor per device class walks through every page, now. The newest recording of each
// page is then a real one, which is what a heatmap is drawn over.

const PRODUCTS = ['oak-tray', 'linen-throw', 'stoneware-mug', 'wool-slippers', 'brass-lamp', 'canvas-tote'];
const DEVICES = {
  desktop: { viewport: { width: 1280, height: 720 } },
  tablet: { ...devices['iPad (gen 7)'], defaultBrowserType: undefined },
  phone: devices['Pixel 7'],
};

for (const [name, device] of Object.entries(DEVICES)) {
  test(`a ${name} visitor walks through the shop`, async ({ browser }) => {
    const context = await browser.newContext({ ...device, timezoneId: 'Europe/London', locale: 'en-GB' });
    const page = await context.newPage();
    await page.goto(`${SHOPS.rich}/`);
    await page.waitForTimeout(1500);
    for (const product of PRODUCTS) {
      await page.getByTestId(`product-${product}`).click();
      await page.waitForTimeout(1300);
      if (product === 'oak-tray') await page.getByTestId('add-to-cart').click();
      await page.getByRole('link', { name: 'Shop', exact: true }).click();
      await page.waitForTimeout(900);
    }
    await page.getByTestId('cart-link').click();
    await page.waitForTimeout(1300);
    await page.getByTestId('go-checkout').click();
    await page.waitForTimeout(1500);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.waitForTimeout(2600);
    await page.goto('about:blank');
    await context.close();
  });
}
