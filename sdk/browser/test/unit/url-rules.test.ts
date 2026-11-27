import { describe, expect, it } from 'vitest';
import { urlAllowed } from '../../src/url-rules';

describe('url rules', () => {
  const href = 'https://shop.test/checkout/payment?step=2';

  it('allows every URL when there are no rules', () => {
    expect(urlAllowed([], href)).toBe(true);
  });

  it('matches each rule type', () => {
    expect(urlAllowed([{ type: 'contains', pattern: '/checkout' }], href)).toBe(true);
    expect(urlAllowed([{ type: 'contains', pattern: '/cart' }], href)).toBe(false);
    expect(urlAllowed([{ type: 'exact', pattern: '/checkout/payment' }], href)).toBe(true);
    expect(urlAllowed([{ type: 'exact', pattern: '/checkout' }], href)).toBe(false);
    expect(urlAllowed([{ type: 'startsWith', pattern: '/checkout' }], href)).toBe(true);
    expect(urlAllowed([{ type: 'endsWith', pattern: '/payment' }], href)).toBe(true);
    expect(urlAllowed([{ type: 'regex', pattern: 'step=\\d' }], href)).toBe(true);
  });

  it('needs only one matching rule and ignores broken ones', () => {
    const rules = [
      { type: 'regex' as const, pattern: '([' },
      { type: 'contains' as const, pattern: 'payment' },
    ];
    expect(urlAllowed(rules, href)).toBe(true);
    expect(urlAllowed([rules[0]!], href)).toBe(false);
  });
});
