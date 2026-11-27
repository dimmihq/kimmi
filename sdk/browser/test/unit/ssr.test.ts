// @vitest-environment node
import { describe, expect, it } from 'vitest';
import kimmi, { feedback, getSessionId, identify, init, optIn, optOut, showFeedback, stop, track } from '../../src/index';

describe('server-side rendering', () => {
  it('does nothing without a window', () => {
    expect(typeof window).toBe('undefined');
    expect(() => {
      init({ key: 'km_pub_test', host: 'http://localhost:8700' });
      identify('user-1', { email: 'a@b.c' });
      optIn();
      optOut();
      track('signup', { plan: 'pro' });
      feedback('Hello', { email: 'a@b.c' });
      showFeedback();
      kimmi.track('signup');
      stop();
      kimmi.init({ key: 'km_pub_test', host: 'http://localhost:8700' });
    }).not.toThrow();
    expect(getSessionId()).toBeNull();
    expect(kimmi.getSessionId()).toBeNull();
  });
});
