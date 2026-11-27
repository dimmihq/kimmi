import { describe, expect, it } from 'vitest';
import { derive, type RawEvent, urlAt } from './derive';

const T0 = 1_795_750_000_000;

const at = (ms: number, type: number, data: unknown): RawEvent => ({
  type,
  timestamp: T0 + ms,
  data,
});
const meta = (ms: number, href: string, width = 1440, height = 900) =>
  at(ms, 4, { href, width, height });
const custom = (ms: number, tag: string, payload: unknown) => at(ms, 5, { tag, payload });
const incremental = (ms: number, data: Record<string, unknown>) => at(ms, 3, data);
const click = (ms: number, id: number) => incremental(ms, { source: 2, type: 2, id, x: 10, y: 10 });
const move = (ms: number) => incremental(ms, { source: 1, positions: [] });

/** document > html > body > [button#4 > "Pay now"#5, input#6, a#7 > svg#8] */
const snapshot = (ms: number) =>
  at(ms, 2, {
    node: {
      id: 1,
      type: 0,
      childNodes: [
        {
          id: 2,
          type: 2,
          tagName: 'html',
          attributes: {},
          childNodes: [
            {
              id: 3,
              type: 2,
              tagName: 'body',
              attributes: {},
              childNodes: [
                {
                  id: 4,
                  type: 2,
                  tagName: 'button',
                  attributes: {},
                  childNodes: [{ id: 5, type: 3, textContent: '  Pay\n now ' }],
                },
                { id: 6, type: 2, tagName: 'input', attributes: { placeholder: 'Email' }, childNodes: [] },
                {
                  id: 7,
                  type: 2,
                  tagName: 'a',
                  attributes: { 'aria-label': 'Close' },
                  childNodes: [{ id: 8, type: 2, tagName: 'svg', attributes: {}, childNodes: [] }],
                },
              ],
            },
          ],
        },
      ],
    },
    initialOffset: { left: 0, top: 0 },
  });

const base = () => [meta(0, 'https://shop.acme.dev/'), snapshot(5)];

describe('derive', () => {
  it('handles no events', () => {
    const result = derive([]);
    expect(result.playable).toBe(false);
    expect(result.durationMs).toBe(0);
    expect(result.activity).toEqual([]);
    expect(result.viewport).toBeNull();
  });

  it('needs two events and a full snapshot to play', () => {
    expect(derive([meta(0, 'https://a.dev/')]).playable).toBe(false);
    expect(derive([meta(0, 'https://a.dev/'), move(10)]).playable).toBe(false);
    expect(derive(base()).playable).toBe(true);
  });

  it('takes duration from the events and the viewport from the first meta event', () => {
    const result = derive([...base(), move(4200), meta(4300, 'https://shop.acme.dev/b', 390, 844)]);
    expect(result.startedAt).toBe(T0);
    expect(result.durationMs).toBe(4300);
    expect(result.viewport).toEqual({ width: 1440, height: 900 });
  });

  it('labels clicks with the element text from the snapshot', () => {
    const { activity } = derive([...base(), click(1000, 5), click(2000, 8), click(3000, 6), click(4000, 99)]);
    expect(activity.map((entry) => [entry.kind, entry.label])).toEqual([
      ['click', 'Clicked Pay now'],
      ['click', 'Clicked Close'],
      ['click', 'Clicked Email'],
      ['click', 'Clicked'],
    ]);
  });

  it('follows mutations when labelling clicks', () => {
    const { activity } = derive([
      ...base(),
      incremental(500, { source: 0, texts: [{ id: 5, value: 'Paid' }], attributes: [], removes: [], adds: [] }),
      click(600, 4),
      incremental(700, {
        source: 0,
        texts: [],
        attributes: [],
        removes: [],
        adds: [
          { parentId: 3, nextId: null, node: { id: 20, type: 2, tagName: 'span', attributes: {}, childNodes: [] } },
          { parentId: 20, nextId: null, node: { id: 21, type: 3, textContent: 'New item' } },
        ],
      }),
      click(800, 20),
      incremental(900, { source: 0, texts: [], attributes: [], removes: [{ parentId: 3, id: 20 }], adds: [] }),
      click(1000, 21),
    ]);
    expect(activity.map((entry) => entry.label)).toEqual(['Clicked Paid', 'Clicked New item', 'Clicked']);
  });

  it('collapses repeated clicks, typing and scrolling into one entry each', () => {
    const { activity } = derive([
      ...base(),
      click(1000, 4),
      click(1200, 4),
      click(1400, 4),
      incremental(2000, { source: 5, id: 6, text: 'a', isChecked: false }),
      incremental(2300, { source: 5, id: 6, text: 'ad', isChecked: false }),
      incremental(2600, { source: 5, id: 6, text: 'ada', isChecked: false }),
      incremental(3000, { source: 3, id: 1, x: 0, y: 200 }),
      incremental(3200, { source: 3, id: 1, x: 0, y: 600 }),
      incremental(6000, { source: 3, id: 1, x: 0, y: 100 }),
      incremental(7000, { source: 5, id: 6, text: '****', isChecked: false }),
    ]);
    expect(activity.map((entry) => [entry.kind, entry.label, entry.detail])).toEqual([
      ['click', 'Clicked Pay now', undefined],
      ['input', 'Typed in a field', 'Email'],
      ['scroll', 'Scrolled down', undefined],
      ['scroll', 'Scrolled up', undefined],
      ['input', 'Typed in a field', 'Masked in the browser'],
    ]);
  });

  it('reads navigation, console, network, error and frustration events', () => {
    const result = derive([
      ...base(),
      custom(100, 'navigate', { href: 'https://shop.acme.dev/checkout?step=2', path: '/checkout', title: 'Checkout' }),
      custom(200, 'console', { level: 'warn', text: 'Slow', source: 'app.js:1' }),
      custom(300, 'console', { level: 'trace', text: 'Odd level', source: '' }),
      custom(400, 'network', { method: 'post', url: '/api/pay', status: 502, ms: 812.4, size: 120, kind: 'fetch' }),
      custom(500, 'error', { message: 'TypeError: x is undefined', source: 'pay.js:9', stack: '' }),
      custom(600, 'rage-click', { selector: '#pay', text: 'Pay now', count: 5 }),
      custom(700, 'dead-click', { selector: '#help', text: '' }),
      custom(800, 'identify', { id: 'u1' }),
    ]);
    expect(result.activity).toEqual([
      { t: 100, kind: 'navigate', label: '/checkout', detail: 'Checkout' },
      { t: 500, kind: 'error', label: 'TypeError: x is undefined', detail: 'pay.js:9' },
      { t: 600, kind: 'rage', label: 'Rage click on Pay now', detail: '5 clicks in under a second' },
      { t: 700, kind: 'dead', label: 'Dead click on #help', detail: 'Nothing changed after the click' },
    ]);
    expect(result.console).toEqual([
      { t: 200, level: 'warn', text: 'Slow', source: 'app.js:1' },
      { t: 300, level: 'log', text: 'Odd level', source: '' },
    ]);
    expect(result.network).toEqual([
      { t: 400, method: 'POST', url: '/api/pay', status: 502, ms: 812, size: 120, kind: 'fetch' },
    ]);
  });

  it('lists tracked events by name, with their props on one line', () => {
    const { activity } = derive([
      ...base(),
      custom(100, 'track', { name: 'signup', props: { plan: 'pro', seats: 3, trial: false, coupon: '' } }),
      custom(200, 'track', { name: 'checkout' }),
      custom(300, 'track', { name: '$outbound', props: { url: 'https://docs.acme.dev/' } }),
      custom(400, 'track', { name: '$download', props: { file: 'report.pdf' } }),
      custom(500, 'track', { name: '$email' }),
      custom(600, 'track', { name: '$phone' }),
      custom(700, 'track', { name: '$form', props: { form: { id: 'newsletter' } } }),
      custom(800, 'track', { name: 'long', props: { note: 'x'.repeat(200) } }),
      custom(900, 'track', {}),
    ]);
    expect(activity.slice(0, 7)).toEqual([
      { t: 100, kind: 'track', label: 'signup', detail: 'plan: pro, seats: 3, trial: false' },
      { t: 200, kind: 'track', label: 'checkout', detail: undefined },
      { t: 300, kind: 'track', label: 'Outbound link', detail: 'url: https://docs.acme.dev/' },
      { t: 400, kind: 'track', label: 'Download', detail: 'file: report.pdf' },
      { t: 500, kind: 'track', label: 'Email link', detail: undefined },
      { t: 600, kind: 'track', label: 'Phone link', detail: undefined },
      { t: 700, kind: 'track', label: 'Form submitted', detail: 'form: {"id":"newsletter"}' },
    ]);
    expect(activity[7].detail).toHaveLength(80);
    expect(activity[7].detail?.endsWith('…')).toBe(true);
    expect(activity[8]).toEqual({ t: 900, kind: 'track', label: 'Event', detail: undefined });
  });

  it('marks gaps over 10 s without input as inactive, in time order', () => {
    const result = derive([
      ...base(),
      move(2000),
      custom(5000, 'console', { level: 'log', text: 'tick', source: '' }),
      custom(6000, 'error', { message: 'Boom', source: '' }),
      move(17_000),
      move(20_000),
      move(40_000),
    ]);
    expect(result.inactive).toEqual([
      { start: 2000, end: 17_000 },
      { start: 20_000, end: 40_000 },
    ]);
    expect(result.activity.map((entry) => [entry.t, entry.kind, entry.detail])).toEqual([
      [2000, 'idle', '15s without input'],
      [6000, 'error', undefined],
      [20_000, 'idle', '20s without input'],
    ]);
  });

  it('counts the stretch before the first input as inactive', () => {
    expect(derive([...base(), move(12_000)]).inactive).toEqual([{ start: 0, end: 12_000 }]);
  });
});

describe('urlAt', () => {
  const result = derive([
    meta(0, 'https://shop.acme.dev/'),
    snapshot(5),
    custom(1000, 'navigate', { href: 'https://shop.acme.dev/cart', path: '/cart', title: '' }),
    custom(5000, 'navigate', { href: 'https://shop.acme.dev/checkout', path: '/checkout', title: '' }),
  ]);

  it('gives the URL the page was at', () => {
    expect(urlAt(result, 0)).toBe('https://shop.acme.dev/');
    expect(urlAt(result, 999)).toBe('https://shop.acme.dev/cart');
    expect(urlAt(result, 4000)).toBe('https://shop.acme.dev/cart');
    expect(urlAt(result, 9000)).toBe('https://shop.acme.dev/checkout');
  });

  it('is null before any URL is known', () => {
    expect(urlAt({ navigations: [] }, 100)).toBeNull();
  });
});
