import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, request, test, type BrowserContext, type Page } from '@playwright/test';
import { KEY, KIMMI, NEXT_PORT, SHOP_PORT } from './playwright.config';

// Web vitals, checked against Google's own `web-vitals` library measuring the same page load: the example apps
// (the React one also on a slow connection and CPU) and real public websites with kimmi.js added to them.
// kimmi must report a metric exactly when the library does, and the same value within the tolerance below.

const reference = readFileSync(fileURLToPath(new URL('../../node_modules/web-vitals/dist/web-vitals.iife.js', import.meta.url)), 'utf8');

/** How far kimmi may be from the library: milliseconds, or CLS points. Event timing rounds to 8 ms. */
const TOLERANCE = { lcp: 2, fcp: 2, ttfb: 2, inp: 16, cls: 0.002 } as const;
type Metric = keyof typeof TOLERANCE;
const METRICS = Object.keys(TOLERANCE) as Metric[];

type Vitals = Partial<Record<Metric, number>>;

interface Probe {
  ref: Vitals;
  sent: string[];
}

/**
 * Runs before anything of the page: loads the reference library, and keeps a copy of every body kimmi sends,
 * whether through fetch or a beacon.
 */
async function prepare(context: BrowserContext, inject: boolean) {
  // Browsers refuse a public page that talks to localhost, so on real sites kimmi is reached through the
  // site's own origin: /__kimmi/... is answered by the local stack.
  if (inject) {
    await context.route(/\/__kimmi\//, async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `${KIMMI}${url.pathname.replace('/__kimmi', '')}${url.search}` });
      await route.fulfill({ response });
    });
  }
  // Init scripts run in a scope of their own: hand the library to the page explicitly.
  await context.addInitScript({ content: `${reference};window.webVitals = webVitals;` });
  await context.addInitScript(
    ({ key, inject }) => {
      const probe: Probe = { ref: {}, sent: [] };
      (window as unknown as { __probe: Probe }).__probe = probe;
      const lib = (window as unknown as { webVitals: Record<string, (cb: (m: { value: number }) => void, o?: object) => void> }).webVitals;
      for (const name of ['LCP', 'FCP', 'TTFB', 'INP', 'CLS']) {
        lib[`on${name}`]!((metric) => (probe.ref[name.toLowerCase() as Metric] = metric.value), { reportAllChanges: true });
      }
      const keep = (url: unknown, body: unknown) => {
        if (!String(url).includes('/i/v1/hit')) return;
        if (typeof body === 'string') probe.sent.push(body);
        else if (body instanceof Blob) void body.text().then((text) => probe.sent.push(text));
      };
      const beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (url, data) => (keep(url, data), beacon(url, data));
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => (keep(input instanceof Request ? input.url : input, init?.body), nativeFetch(input, init));
      if (inject && window.top === window) {
        const add = () => {
          const script = document.createElement('script');
          script.src = '/__kimmi/kimmi.js';
          script.dataset.key = key;
          script.dataset.host = `${location.origin}/__kimmi`;
          document.documentElement.appendChild(script);
        };
        if (document.documentElement) add();
        else new MutationObserver((_, observer) => document.documentElement && (observer.disconnect(), add())).observe(document, { childList: true });
      }
    },
    { key: KEY, inject },
  );
}

/** Loads a page, makes one slow interaction and a layout shift, hides the page and returns both measurements. */
async function measure(page: Page, url: string): Promise<{ ref: Vitals; kimmi: Vitals; path: string }> {
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForTimeout(2500);
  // A button of ours, so every site has something safe to interact with: its handler blocks for 120 ms,
  // and a block pushed in above it shifts the layout without a recent input.
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'kimmi-vitals-probe';
    button.textContent = 'probe';
    button.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;padding:8px';
    button.addEventListener('click', () => {
      const until = performance.now() + 120;
      while (performance.now() < until);
      button.textContent = 'done';
    });
    document.body.appendChild(button);
  });
  await page.click('#kimmi-vitals-probe');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const block = document.createElement('div');
    block.style.cssText = 'height:160px;background:#ccc';
    document.body.insertBefore(block, document.body.firstChild);
  });
  await page.waitForTimeout(800);
  // Hiding the page is when both report their final values.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1200);
  const probe = await page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
  const kimmi: Vitals = {};
  let path = '';
  for (const body of probe.sent) {
    const hit = JSON.parse(body) as { events: { k: string; n: string; v: number; p: string }[] };
    for (const event of hit.events) {
      if (event.k !== 'vital') continue;
      kimmi[event.n as Metric] = event.v;
      path = event.p;
    }
  }
  return { ref: probe.ref, kimmi, path };
}

function compare(where: string, ref: Vitals, kimmi: Vitals) {
  const rows = METRICS.map((metric) => `${metric} kimmi=${kimmi[metric] ?? '-'} web-vitals=${ref[metric] === undefined ? '-' : Math.round(ref[metric]! * 10000) / 10000}`);
  console.log(`${where}: ${rows.join(' | ')}`);
  for (const metric of METRICS) {
    if (ref[metric] === undefined) {
      expect(kimmi[metric], `${where}: ${metric} is not measurable in this browser, so kimmi must not invent it`).toBeUndefined();
      continue;
    }
    expect(kimmi[metric], `${where}: kimmi sent no ${metric} though the browser measured ${ref[metric]}`).not.toBeUndefined();
    expect(Math.abs(kimmi[metric]! - ref[metric]!), `${where}: ${metric} kimmi ${kimmi[metric]} vs web-vitals ${ref[metric]}`).toBeLessThanOrEqual(TOLERANCE[metric]);
  }
  expect(ref.ttfb, `${where}: the page load was measured at all`).not.toBeUndefined();
}

test.beforeAll(async () => {
  // The project of the stack suite, counting visits and measuring page speed.
  const api = await request.newContext({ baseURL: KIMMI });
  const login = await api.post('/api/v1/auth/login', { data: { email: process.env.DEV_ACCOUNT_EMAIL, password: process.env.DEV_ACCOUNT_PASSWORD } });
  expect(login.status()).toBe(200);
  const projects = (await (await api.get('/api/v1/projects')).json()) as { id: string; publicKey: string }[];
  const project = projects.find((item) => item.publicKey === KEY)!.id;
  const patched = await api.patch(`/api/v1/projects/${project}/settings`, {
    data: { analytics: { enabled: true, cookieless: false }, capture: { performance: true, minDurationMs: 0 }, feedback: { button: 'hidden' } },
  });
  expect(patched.status()).toBe(200);
  await api.dispose();
});

test.describe('the example apps', () => {
  test('React shop', async ({ context, page }) => {
    await prepare(context, false);
    const { ref, kimmi, path } = await measure(page, `http://localhost:${SHOP_PORT}/products/oak-tray`);
    expect(path).toBe('/products/oak-tray');
    compare('React shop', ref, kimmi);
  });

  test('React shop on a slow connection and a slow CPU', async ({ context, page, browserName }) => {
    test.skip(browserName !== 'chromium', 'throttling goes through the Chrome DevTools protocol');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await prepare(context, false);
    const { ref, kimmi } = await measure(page, `http://localhost:${SHOP_PORT}/`);
    compare('React shop, throttled', ref, kimmi);
    expect(ref.lcp!, 'throttling made the load slow enough to mean something').toBeGreaterThan(300);
  });

  test('Next.js site', async ({ context, page }) => {
    await prepare(context, false);
    const { ref, kimmi } = await measure(page, `http://localhost:${NEXT_PORT}/pricing`);
    compare('Next.js site', ref, kimmi);
  });
});

test.describe('real websites with kimmi.js added', () => {
  // Their own content security policies would refuse a script from localhost.
  test.use({ bypassCSP: true });
  for (const url of ['https://example.com/', 'https://en.wikipedia.org/wiki/Web_performance', 'https://developer.mozilla.org/en-US/docs/Web/Performance', 'https://www.gov.uk/', 'https://news.ycombinator.com/']) {
    test(new URL(url).host, async ({ context, page }) => {
      await prepare(context, true);
      const { ref, kimmi, path } = await measure(page, url);
      expect(path, 'kimmi ran on the page and reported under its path').toBe(new URL(url).pathname);
      compare(new URL(url).host, ref, kimmi);
    });
  }
});
