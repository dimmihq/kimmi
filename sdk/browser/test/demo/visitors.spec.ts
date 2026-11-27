import { devices, test, type Page } from '@playwright/test';
import { SHOPS } from './playwright.config';

// Each test is one visitor with a device, a place, a source and a way of using the shop, at a moment in the
// past two weeks. Everything is derived from the visitor's number, so a run can be repeated.

const RICH = Number(process.env.DEMO_VISITORS ?? 220);
const REPLAY = Number(process.env.DEMO_REPLAY_VISITORS ?? 40);
const DAY = 86_400_000;

/** A small deterministic generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, list: readonly T[]) => list[Math.floor(rand() * list.length)]!;

const PLACES = [
  ['America/New_York', 'en-US'], ['America/Chicago', 'en-US'], ['America/Los_Angeles', 'en-US'], ['America/Toronto', 'en-CA'],
  ['Europe/London', 'en-GB'], ['Europe/Berlin', 'de-DE'], ['Europe/Paris', 'fr-FR'], ['Europe/Madrid', 'es-ES'],
  ['Europe/Amsterdam', 'nl-NL'], ['Europe/Stockholm', 'sv-SE'], ['Africa/Lagos', 'en-NG'], ['Africa/Nairobi', 'en-KE'],
  ['Africa/Johannesburg', 'en-ZA'], ['America/Sao_Paulo', 'pt-BR'], ['Asia/Kolkata', 'en-IN'], ['Asia/Tokyo', 'ja-JP'],
  ['Asia/Singapore', 'en-SG'], ['Australia/Sydney', 'en-AU'],
] as const;

const SOURCES = [
  { referer: '', query: '' }, { referer: '', query: '' }, { referer: '', query: '' },
  { referer: 'https://www.google.com/', query: '' }, { referer: 'https://www.google.com/', query: '' },
  { referer: 'https://www.bing.com/', query: '' }, { referer: 'https://duckduckgo.com/', query: '' },
  { referer: 'https://t.co/', query: '' }, { referer: 'https://www.linkedin.com/', query: '' }, { referer: 'https://www.reddit.com/', query: '' },
  { referer: 'https://chatgpt.com/', query: '' }, { referer: 'https://homeandhearth.example/gift-guide', query: '' },
  { referer: '', query: '?utm_source=newsletter&utm_medium=email&utm_campaign=autumn-restock' },
  { referer: '', query: '?utm_source=newsletter&utm_medium=email&utm_campaign=gift-guide' },
  { referer: 'https://www.google.com/', query: '?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=demo' },
] as const;

const PEOPLE = [
  ['Ada Okafor', 'ada@northwind.example'], ['Jonas Weber', 'jonas@northwind.example'], ['Mei Tanaka', 'mei@lumen-studio.example'],
  ['Sofia Marin', 'sofia@lumen-studio.example'], ['Liam Carter', 'liam@harbourandco.example'], ['Zainab Bello', 'zainab@harbourandco.example'],
  ['Noah Lindqvist', 'noah@fjordworks.example'], ['Priya Nair', 'priya@fjordworks.example'], ['Tom Becker', 'tom@oakfield.example'],
  ['Chloe Martin', 'chloe@oakfield.example'], ['Grace Hall', 'grace.hall@gmail.com'], ['Omar Haddad', 'omar.h@outlook.com'],
] as const;

const PRODUCTS = ['oak-tray', 'oak-tray', 'oak-tray', 'linen-throw', 'linen-throw', 'stoneware-mug', 'stoneware-mug', 'wool-slippers', 'brass-lamp', 'canvas-tote'] as const;

const FEEDBACK = [
  'The Compare button does nothing when I click it.',
  'I could not find the delivery cost before checkout.',
  'Stock check keeps saying unavailable for the oak tray.',
  'Love the shop. Could you add gift wrapping?',
  'Checkout asked for my address twice on my phone.',
  'The product photos are just coloured blocks for me.',
  'Is there a discount code box? I have one from the newsletter.',
  'Great prices, but the cart forgot my items after I signed in.',
] as const;

const DEVICES = [
  { viewport: { width: 1440, height: 900 } }, { viewport: { width: 1280, height: 720 } }, { viewport: { width: 1920, height: 1080 } },
  { viewport: { width: 1536, height: 864 } }, { viewport: { width: 1366, height: 768 } },
  devices['Pixel 7'], devices['Pixel 7'], devices['Galaxy S9+'],
  { ...devices['iPhone 14'], defaultBrowserType: undefined }, { ...devices['iPad (gen 7)'], defaultBrowserType: undefined },
] as const;

const pause = (page: Page, rand: () => number, from = 350, to = 1400) => page.waitForTimeout(from + rand() * (to - from));

async function visit(page: Page, shop: string, rand: () => number, feedback: boolean) {
  const source = pick(rand, SOURCES);
  await page.goto(`${shop}/${source.query}`, source.referer ? { referer: source.referer } : {});
  await pause(page, rand, 900, 2200);
  await page.mouse.wheel(0, 300 + rand() * 900);
  await pause(page, rand);
  if (rand() < 0.18) return; // looked and left

  if (rand() < 0.16) {
    const [name, email] = pick(rand, PEOPLE);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.getByTestId('login-email').fill(email);
    await page.getByTestId('login-password').fill(`demo-${name.length}-password`);
    await page.getByTestId('login-submit').click();
    await pause(page, rand);
    await page.getByRole('link', { name: 'Shop' }).click();
    await pause(page, rand);
  }

  let inCart = 0;
  const looks = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < looks; i++) {
    await page.getByTestId(`product-${pick(rand, PRODUCTS)}`).click();
    await pause(page, rand, 700, 2400);
    if (rand() < 0.3) {
      for (let k = 0; k < 4 + Math.floor(rand() * 3); k++) await page.getByTestId('dead-button').click({ delay: 20 });
      await page.waitForTimeout(1700);
    }
    if (rand() < 0.25) {
      await page.getByTestId('check-stock').click();
      await pause(page, rand);
    }
    if (rand() < 0.55) {
      await page.getByTestId('add-to-cart').click();
      inCart++;
      await pause(page, rand);
    }
    if (rand() < 0.1) {
      await page.getByTestId('trigger-error').dispatchEvent('click');
      await pause(page, rand, 300, 700);
    }
    if (i + 1 < looks) {
      await page.getByRole('link', { name: 'Shop' }).click();
      await pause(page, rand);
    }
  }

  if (feedback && rand() < 0.1) {
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    await page.getByRole('dialog', { name: 'Send feedback' }).getByRole('textbox').first().fill(pick(rand, FEEDBACK));
    if (rand() < 0.4) await page.getByRole('textbox', { name: 'Email (optional)' }).fill(pick(rand, PEOPLE)[1]);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await pause(page, rand, 600, 1000);
  }

  if (!inCart || rand() < 0.3) return; // left with a full cart, or never added
  await page.getByTestId('cart-link').click();
  await pause(page, rand, 600, 1800);
  if (rand() < 0.3) return;
  await page.getByTestId('go-checkout').click();
  await pause(page, rand);
  const [name, email] = pick(rand, PEOPLE);
  await page.getByTestId('email').fill(email);
  await page.getByTestId('name').fill(name);
  await pause(page, rand, 300, 800);
  if (rand() < 0.22) return; // gave up at the form
  await page.getByTestId('address').fill('12 Analytical Row, London');
  // A short card number is refused once, as it is for people who mistype.
  if (rand() < 0.2) {
    await page.getByTestId('card').fill('4242 4242');
    await page.getByTestId('place-order').click();
    await pause(page, rand);
  }
  await page.getByTestId('card').fill('4242 4242 4242 4242');
  await page.getByTestId('place-order').click();
  await pause(page, rand, 700, 1500);
}

function visitors(label: string, shop: string, count: number, offset: number, feedback: boolean) {
  for (let i = 0; i < count; i++) {
    test(`${label} visitor ${i + 1}`, async ({ browser }) => {
      const rand = random(offset + i * 7919);
      const [timezoneId, locale] = pick(rand, PLACES);
      const device = pick(rand, DEVICES);
      const context = await browser.newContext({ ...device, timezoneId, locale });
      const page = await context.newPage();
      // Most visits are recent; a few visitors are on the site right now.
      const ago = i < 3 ? 0 : Math.floor(rand() ** 2 * 14) * DAY + rand() * 20 * 3_600_000 + 60_000;
      if (ago > 0) await page.clock.install({ time: new Date(Date.now() - ago) });
      try {
        await visit(page, shop, rand, feedback);
      } finally {
        // The SDK sends every 2 seconds; leaving the page sends what is left.
        await page.waitForTimeout(2400);
        await page.goto('about:blank').catch(() => undefined);
        await page.waitForTimeout(200);
        await context.close();
      }
    });
  }
}

visitors('shop', SHOPS.rich, RICH, 1, true);
visitors('replay-only shop', SHOPS.replay, REPLAY, 500_000, false);
