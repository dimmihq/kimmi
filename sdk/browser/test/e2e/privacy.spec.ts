import { expect, test, type Page } from '@playwright/test';
import { customEvents, received, reset, setConfig, type Batch, type KimmiEvent } from './helpers';
import { REACT_PORT } from './playwright.config';

// Drives the privacy lab page of the React example (examples/react-spa/src/pages/PrivacyLabPage.tsx)
// under each privacy setting and searches everything the mock server decoded for what must not be there.

const KEY = 'km_pub_react';
const LAB = `http://localhost:${REACT_PORT}/privacy-lab`;
const JWT_PARTS = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiJhZGEtbGFiIiwicm9sZSI6ImFkbWluIn0', 'dGhpc0lzVGhlTGFiU2lnbmF0dXJlNDI'];

interface SNode {
  type: number;
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SNode[];
  textContent?: string;
}

interface Mutation {
  source: number;
  adds?: Array<{ parentId: number; node: SNode }>;
  texts?: Array<{ id: number; value: string }>;
  attributes?: Array<{ id: number; attributes: Record<string, unknown> }>;
}

const mask = (text: string) => text.replace(/\S/g, '*');
const events = (batches: Batch[]) => batches.flatMap((batch) => batch.events);
const incremental = (batches: Batch[], source: number) =>
  events(batches).filter((event) => event.type === 3 && event.data.source === source) as unknown as Array<KimmiEvent & { data: Mutation & { id: number; text: string } }>;

/** Every serialized node: full snapshots and nodes added by mutations. */
function nodes(batches: Batch[]): SNode[] {
  const out: SNode[] = [];
  const visit = (node: SNode) => {
    out.push(node);
    node.childNodes?.forEach(visit);
  };
  for (const event of events(batches)) {
    if (event.type === 2) visit((event.data as unknown as { node: SNode }).node);
  }
  for (const mutation of incremental(batches, 0)) mutation.data.adds?.forEach((add) => visit(add.node));
  return out;
}

function byTestId(batches: Batch[], testId: string): SNode {
  const node = nodes(batches).find((n) => n.attributes?.['data-testid'] === testId);
  expect(node, `node with data-testid=${testId}`).toBeDefined();
  return node!;
}

function textOf(node: SNode): string {
  return (node.textContent ?? '') + (node.childNodes ?? []).map(textOf).join('');
}

function expectAbsent(batches: Batch[], secrets: string[]): void {
  const recorded = JSON.stringify(batches);
  expect(secrets.filter((secret) => recorded.includes(secret)), 'leaked into the recording').toEqual([]);
}

async function openLab(page: Page, settings: { privacy?: Record<string, unknown>; capture?: Record<string, unknown> } = {}, referer?: string) {
  await reset();
  await setConfig(KEY, settings);
  await page.goto(LAB, referer ? { referer } : {});
  await expect(page.getByTestId('visible-text')).toBeVisible();
}

let markers = 0;

/** Logs a marker and waits until it arrives: everything recorded before it has arrived too. */
async function collect(page: Page): Promise<Batch[]> {
  const marker = `lab-done-${++markers}`;
  await page.evaluate((text) => console.info(text), marker);
  await expect
    .poll(async () => customEvents((await received(KEY)).batches, 'console').some((e) => e.data.payload?.text === marker), { timeout: 15_000 })
    .toBe(true);
  const { batches, rejected } = await received(KEY);
  expect(rejected).toEqual([]);
  return batches;
}

test.describe('privacy settings in a real browser', () => {
  test('maskSelectors masks text in matching elements, nested and changed later, and nothing else', async ({ page }) => {
    await openLab(page, { privacy: { maskSelectors: ['.secret-note'] } });
    await page.getByTestId('change-text').click();
    await expect(page.getByText('Visible later: linen throws are back')).toBeVisible();
    const batches = await collect(page);

    expectAbsent(batches, ['Ada prefers deliveries', 'the blue door', 'leave parcels with Grace', 'Grace works nights', 'ring the bell twice']);
    const recorded = JSON.stringify(batches);
    expect(recorded).toContain('Visible: oak trays restocked');
    expect(recorded).toContain('Visible later: linen throws are back');

    const note = byTestId(batches, 'secret-note');
    expect(textOf(note)).toContain(mask('Masked note: Ada prefers deliveries after six'));
    expect(textOf(note)).toContain(mask('Nested secret: the blue door'));
    const changed = incremental(batches, 0).flatMap((m) => [...(m.data.texts ?? []).map((t) => t.value), ...(m.data.adds ?? []).map((a) => textOf(a.node))]);
    expect(changed).toContain(mask('Updated note: leave parcels with Grace'));
    expect(changed).toContain(mask('Extra note: Grace works nights'));
    expect(changed).toContain(mask('Added note: ring the bell twice'));
  });

  test('text attributes inside masked regions are masked too', async ({ page }) => {
    await openLab(page, { privacy: { maskSelectors: ['.secret-note'] } });
    const batches = await collect(page);
    expectAbsent(batches, ['Title secret', 'Placeholder secret', 'Aria secret', 'Alt secret', 'Value secret']);
    const inNote = nodes(batches).filter((n) => n.attributes);
    const attr = (name: string) => inNote.map((n) => n.attributes![name]).filter((v) => typeof v === 'string');
    expect(attr('title')).toContain(mask('Title secret Ada'));
    expect(attr('placeholder')).toContain(mask('Placeholder secret Ada'));
    expect(attr('aria-label')).toContain(mask('Aria secret Ada'));
    expect(attr('alt')).toContain(mask('Alt secret Ada'));
    expect(attr('value')).toContain(mask('Value secret Ada'));
  });

  test('data-private and kimmi-mask mask, kimmi-block blocks and kimmi-ignore ignores with no settings', async ({ page }) => {
    await openLab(page, { privacy: { maskAllInputs: false } });
    await page.getByTestId('lab-kimmi-ignore').pressSequentially('WrappedTyping42');
    await page.getByTestId('lab-plain').pressSequentially('PlainTyping42');
    const batches = await collect(page);

    expectAbsent(batches, ["shoe size", 'birthday is', 'support PIN hint']);
    expect(JSON.stringify(batches)).toContain(mask("Data private: Ada's shoe size is six"));
    const ignored = byTestId(batches, 'lab-kimmi-ignore').id;
    const plain = byTestId(batches, 'lab-plain').id;
    const inputs = incremental(batches, 5);
    expect(inputs.filter((e) => e.data.id === ignored)).toEqual([]);
    expectAbsent(batches, ['WrappedTyping']);
    expect(inputs.filter((e) => e.data.id === plain).map((e) => e.data.text)).toContain('PlainTyping42');
    const block = nodes(batches).find((n) => n.attributes?.class === 'kimmi-block')!;
    expect(block.attributes).toMatchObject({ rr_width: expect.stringMatching(/px$/), rr_height: expect.stringMatching(/px$/) });
    expect(block.childNodes).toEqual([]);
  });

  test('blockSelectors records a sized placeholder and nothing inside, then or later', async ({ page }) => {
    await openLab(page, { privacy: { blockSelectors: ['.blocked-panel'] } });
    await page.getByTestId('change-blocked').click();
    await expect(page.getByText('Blocked later: Ada redeemed 300 points')).toBeVisible();
    const batches = await collect(page);

    expectAbsent(batches, ['loyalty balance', 'redeemed 300', 'swatch.svg?in=blocked']);
    // A placeholder keeps only its class and size.
    const panel = nodes(batches).find((n) => n.attributes?.class === 'blocked-panel')!;
    expect(panel.attributes).toEqual({ class: 'blocked-panel', rr_width: expect.stringMatching(/^[1-9]\d*(\.\d+)?px$/), rr_height: expect.stringMatching(/^[1-9]\d*(\.\d+)?px$/) });
    expect(panel.childNodes).toEqual([]);
    expect(incremental(batches, 0).flatMap((m) => m.data.adds ?? []).filter((add) => add.parentId === panel.id)).toEqual([]);
    expect(JSON.stringify(batches)).toContain('Visible: oak trays restocked');
  });

  test('ignoreSelectors records no input events for matching inputs', async ({ page }) => {
    await openLab(page, { privacy: { maskAllInputs: false, ignoreSelectors: ['.ignored-field'] } });
    await page.getByTestId('lab-ignored').pressSequentially('IgnoredTyping42');
    await page.getByTestId('lab-plain').pressSequentially('PlainTyping42');
    const batches = await collect(page);

    const ignored = byTestId(batches, 'lab-ignored').id;
    const inputs = incremental(batches, 5);
    expect(inputs.filter((e) => e.data.id === ignored)).toEqual([]);
    expectAbsent(batches, ['IgnoredTyping']);
    expect(inputs.filter((e) => e.data.id === byTestId(batches, 'lab-plain').id).length).toBeGreaterThan(0);
  });

  test('maskAllInputs masks every input type, textarea, select and contenteditable', async ({ page }) => {
    await openLab(page);
    const typed: Record<string, string> = {
      'lab-email': 'ada.lab@example.com',
      'lab-tel': '+44 20 7946 0958',
      'lab-number': '8675309421',
      'lab-search': 'oak secret search',
      'lab-text': 'Typed text secret',
      'lab-textarea': 'Textarea secret words',
      'lab-password': 'Password secret 99',
    };
    for (const [testId, value] of Object.entries(typed)) await page.getByTestId(testId).pressSequentially(value);
    await page.getByTestId('lab-select').selectOption('platinum');
    await page.getByTestId('lab-editable').click();
    await page.keyboard.type('Editable secret words');
    const batches = await collect(page);

    expectAbsent(batches, [...Object.values(typed), '7946 0958', '8675309421', 'Editable secret', 'csrf-HiddenSecret123']);
    const inputs = incremental(batches, 5);
    for (const testId of Object.keys(typed)) {
      const own = inputs.filter((e) => e.data.id === byTestId(batches, testId).id);
      expect(own.length, `${testId} input events`).toBeGreaterThan(0);
      for (const event of own) expect(event.data.text).toMatch(/^\*+$/);
    }
    const select = byTestId(batches, 'lab-select').id;
    expect(inputs.filter((e) => e.data.id === select).map((e) => e.data.text)).toEqual(['***']);
    const options = nodes(batches).filter((n) => n.tagName === 'option');
    expect(options.length).toBe(3);
    for (const option of options) expect(option.attributes).not.toHaveProperty('selected');
    const editable = incremental(batches, 0).flatMap((m) => (m.data.texts ?? []).map((t) => t.value));
    expect(editable.some((value) => /^[*\s]{20,}$/.test(value))).toBe(true);
  });

  test('password and hidden fields are masked even when maskAllInputs is off', async ({ page }) => {
    await openLab(page, { privacy: { maskAllInputs: false } });
    await page.getByTestId('lab-password').pressSequentially('Password secret 99');
    await page.getByTestId('lab-text').pressSequentially('Typed text kept');
    const batches = await collect(page);

    expectAbsent(batches, ['Password secret', 'csrf-HiddenSecret123']);
    const inputs = incremental(batches, 5);
    expect(inputs.filter((e) => e.data.id === byTestId(batches, 'lab-password').id).every((e) => /^\*+$/.test(e.data.text))).toBe(true);
    expect(inputs.map((e) => e.data.text)).toContain('Typed text kept');
  });

  test('blockMedia records no images, video, audio, svg images, canvas or CSS backgrounds', async ({ page }) => {
    await openLab(page, { privacy: { blockMedia: true, recordCanvas: true } });
    await page.getByTestId('add-media').click();
    await page.waitForTimeout(500);
    const batches = await collect(page);

    const media = ['img', 'source', 'picture', 'poster', 'video', 'audio', 'svg', 'inline', 'css', 'later-style', 'later'];
    expectAbsent(batches, [...media.map((m) => `swatch.svg?in=${m}`), 'swatch.svg', '/lab/', 'data:image', 'rr_dataURL']);
    expect(incremental(batches, 9)).toEqual([]);
    const placeholders = nodes(batches).filter((n) => n.attributes?.rr_width !== undefined).map((n) => n.tagName);
    for (const tag of ['img', 'picture', 'video', 'audio', 'image', 'canvas']) expect(placeholders, tag).toContain(tag);
    const recorded = JSON.stringify(batches);
    expect(recorded).toContain('background-image: none');
    expect(recorded).toMatch(/\.lab-css-bg\s*\{\s*background-image:\s*none/);
  });

  test('maskAllText masks all text, text attributes, inputs and the page title', async ({ page }) => {
    await openLab(page, { privacy: { maskAllText: true, maskAllInputs: false } });
    await expect(page).toHaveTitle('Privacy lab for Ada Lovelace');
    await page.getByTestId('lab-plain').pressSequentially('PlainTyping42');
    await page.evaluate(() => history.pushState({}, '', '/privacy-lab?tab=2'));
    const batches = await collect(page);

    expectAbsent(batches, ['Ada Lovelace', 'Privacy lab', 'oak trays', 'Fernhill', 'Title secret', 'Placeholder secret', 'PlainTyping']);
    const titles = customEvents(batches, 'navigate').map((e) => String(e.data.payload!.title));
    expect(titles.length).toBe(2);
    for (const title of titles) expect(title).toMatch(/^[*\s]+$/);
    expect(customEvents(batches, 'navigate').map((e) => e.data.payload!.path)).toEqual(['/privacy-lab', '/privacy-lab']);
  });

  test('requireConsent sends nothing before optIn, and optOut stops and clears', async ({ page }) => {
    await openLab(page, { privacy: { requireConsent: true } });
    await page.getByTestId('log-secrets').click();
    await page.getByTestId('call-api').click();
    await page.getByTestId('throw-secret').click();
    await page.evaluate(() => console.info('before-consent'));
    await page.waitForTimeout(3500);
    expect((await received(KEY)).batches).toEqual([]);

    await page.getByTestId('opt-in').click();
    const batches = await collect(page);
    expect(batches[0]!.meta.seq).toBe(0);
    expect(batches[0]!.events.map((e) => e.type)).toEqual(expect.arrayContaining([4, 2]));
    expectAbsent(batches, ['before-consent', 'Session expired', 'api/echo']);

    await page.getByTestId('opt-out').click();
    const count = (await received(KEY)).batches.length;
    await page.getByTestId('change-text').click();
    await page.evaluate(() => console.info('after-opt-out'));
    await page.waitForTimeout(3500);
    expect((await received(KEY)).batches.length).toBe(count);
    expect(await page.evaluate(() => localStorage.getItem('kimmi.consent'))).toBe('denied');

    await page.reload();
    await expect(page.getByTestId('visible-text')).toBeVisible();
    await page.waitForTimeout(3500);
    expect((await received(KEY)).batches.length).toBe(count);
  });

  test('respectDnt records nothing when the browser sends Do Not Track', async ({ browser }) => {
    const context = await browser.newContext();
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: () => '1' }));
    const page = await context.newPage();
    await openLab(page, { privacy: { respectDnt: true } });
    await page.getByTestId('log-secrets').click();
    await page.getByTestId('change-text').click();
    await page.waitForTimeout(3500);
    expect((await received(KEY)).batches).toEqual([]);

    // The same browser is recorded once the project stops honouring the signal.
    await setConfig(KEY, { privacy: { respectDnt: false } });
    await page.reload();
    expect((await collect(page)).length).toBeGreaterThan(0);
    await context.close();
  });
});

test.describe('scrubbing outside the DOM', () => {
  test('console, network, errors, navigations, clicks and metadata carry no secrets', async ({ page }) => {
    await openLab(page, { capture: { networkBodies: true } }, 'https://mail.example.com/open?token=LabReferrerToken&uid=7');
    await page.getByTestId('log-secrets').click();
    await page.getByTestId('call-api').click();
    await expect.poll(async () => customEvents((await received(KEY)).batches, 'network').length, { timeout: 15_000 }).toBe(2);
    await page.getByTestId('throw-secret').click();
    for (let i = 0; i < 4; i++) await page.getByTestId('dead-contact').click();
    await page.waitForTimeout(1800);
    await page.getByTestId('reset-link').click();
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    const batches = await collect(page);

    expectAbsent(batches, [
      ...JWT_PARTS, 'ada.scrub@example.com', '4242 4242 4242 4242', 'Hunter2-lab', 'sk_live_51LabSecret', '7946 0958', '123-45-6789',
      'LabQueryToken77', 'a@b.c', 'a%40b.c', 'LabBearerSecret99', 'LabBodyPassword', 'LabResponseToken55', 'LabXhrKey31',
      'LabXhrHeaderKey', '4000056655665556', '4000 0566 5566 5556', 'cvc=123', 'LabResetToken123', 'ada.reset', 'LabReferrerToken',
      'FH-204817',
    ]);

    const consoleText = customEvents(batches, 'console').map((e) => String(e.data.payload!.text));
    expect(consoleText).toContainEqual('Session token [redacted] for [email], card [redacted]');
    expect(consoleText).toContainEqual('{"password":"[redacted]","apiKey":"[redacted]","note":"kept note"}');
    expect(consoleText).toContainEqual('Call Ada on [phone], SSN [redacted], account [account]');

    const [fetched, xhr] = customEvents(batches, 'network').map((e) => e.data.payload!);
    expect(fetched).toMatchObject({
      kind: 'fetch',
      status: 200,
      url: `http://localhost:${REACT_PORT}/api/echo?token=[redacted]&email=[email]`,
      requestBody: '{"password":"[redacted]","note":"hi"}',
    });
    expect(fetched!.responseBody).toBe('{"ok":true,"access_token":"[redacted]","echo":"{\\"password\\":\\"[redacted]\\",\\"note\\":\\"hi\\"}"}');
    expect(xhr).toMatchObject({
      kind: 'xhr',
      url: `http://localhost:${REACT_PORT}/api/echo?api_key=[redacted]`,
      requestBody: 'card_number=[redacted]&cvc=[redacted]&plan=gold',
    });

    const errors = customEvents(batches, 'error').map((e) => String(e.data.payload!.message));
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining('Session expired for [redacted]'), 'Card [redacted] was declined']));

    expect(customEvents(batches, 'rage-click').map((e) => e.data.payload)).toContainEqual(expect.objectContaining({ text: 'Contact [email]', count: 4 }));
    expect(customEvents(batches, 'dead-click').map((e) => e.data.payload!.text)).toContain('Contact [email]');

    const reset = customEvents(batches, 'navigate').at(-1)!.data.payload!;
    expect(reset).toMatchObject({ path: '/reset', href: `http://localhost:${REACT_PORT}/reset?token=[redacted]&email=[email]` });
    const meta = batches.at(-1)!.meta as unknown as { url: string; path: string; referrer: string };
    expect(meta.url).toBe(`http://localhost:${REACT_PORT}/reset?token=[redacted]&email=[email]`);
    expect(meta.path).toBe('/reset');
    expect(meta.referrer).toBe('https://mail.example.com/open?token=[redacted]&uid=7');
    const metaEvents = events(batches).filter((e) => e.type === 4).map((e) => (e.data as { href?: string }).href);
    expect(metaEvents.every((href) => !href?.includes('Lab'))).toBe(true);
  });

  test('emails and phone numbers stay when the project turns their scrubbing off', async ({ page }) => {
    await openLab(page, { privacy: { scrubEmails: false, scrubPhones: false } });
    await page.getByTestId('log-secrets').click();
    const batches = await collect(page);
    const consoleText = customEvents(batches, 'console').map((e) => String(e.data.payload!.text));
    expect(consoleText).toContainEqual('Session token [redacted] for ada.scrub@example.com, card [redacted]');
    expect(consoleText).toContainEqual('Call Ada on +44 20 7946 0958, SSN [redacted], account [account]');
  });
});
