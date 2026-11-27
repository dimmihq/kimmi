import { describe, expect, it } from 'vitest';
import { isSampled } from '../../src/sampling';
import { uuidv7 } from '../../src/util';

describe('sampling', () => {
  it('gives the same answer for the same session id every time', () => {
    for (let i = 0; i < 200; i++) {
      const id = uuidv7(Date.now() + i);
      const first = isSampled(id, 37);
      for (let j = 0; j < 5; j++) expect(isSampled(id, 37)).toBe(first);
    }
  });

  it('records everything at 100 and nothing at 0', () => {
    const id = uuidv7();
    expect(isSampled(id, 100)).toBe(true);
    expect(isSampled(id, 0)).toBe(false);
  });

  it('records roughly the requested share of sessions', () => {
    let sampled = 0;
    const total = 20_000;
    for (let i = 0; i < total; i++) if (isSampled(uuidv7(), 25)) sampled++;
    expect(sampled / total).toBeGreaterThan(0.23);
    expect(sampled / total).toBeLessThan(0.27);
  });

  it('keeps every session sampled at a lower rate sampled at a higher one', () => {
    for (let i = 0; i < 500; i++) {
      const id = uuidv7();
      if (isSampled(id, 10)) expect(isSampled(id, 50)).toBe(true);
    }
  });
});
