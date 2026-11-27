// @vitest-environment node
import { describe, expect, it } from 'vitest';
import kimmi, { getSessionId, identify, init, optIn, optOut, stop } from '../../src/index';

describe('server-side rendering', () => {
  it('does nothing without a window', () => {
    expect(typeof window).toBe('undefined');
    expect(() => {
      init({ key: 'km_pub_test', host: 'http://localhost:8700' });
      identify('user-1', { email: 'a@b.c' });
      optIn();
      optOut();
      stop();
      kimmi.init({ key: 'km_pub_test', host: 'http://localhost:8700' });
    }).not.toThrow();
    expect(getSessionId()).toBeNull();
    expect(kimmi.getSessionId()).toBeNull();
  });
});
