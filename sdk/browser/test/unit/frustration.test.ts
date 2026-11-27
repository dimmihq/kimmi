import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrustrationDetector, selectorFor } from '../../src/frustration';

function setup() {
  const rage = vi.fn();
  const dead = vi.fn();
  const detector = new FrustrationDetector({
    rage,
    dead,
    describe: (el) => ({ selector: selectorFor(el), text: el.textContent ?? '' }),
  });
  return { rage, dead, detector };
}

describe('frustration detection', () => {
  let button: HTMLButtonElement;
  let plain: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main><button class="buy now">Buy <span>it</span></button><div class="plain">text</div></main>';
    button = document.querySelector('button')!;
    plain = document.querySelector('.plain')!;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports three clicks on one element within 700 ms as one rage click with the burst size', () => {
    const { rage, detector } = setup();
    const span = button.querySelector('span')!;
    detector.click(button, 0);
    vi.advanceTimersByTime(150);
    detector.click(span, 150);
    vi.advanceTimersByTime(150);
    detector.click(button, 300);
    vi.advanceTimersByTime(150);
    detector.click(button, 450);
    expect(rage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700);
    expect(rage).toHaveBeenCalledTimes(1);
    expect(rage).toHaveBeenCalledWith({ selector: 'main > button.buy.now', text: 'Buy it', count: 4 });
  });

  it('does not count slow clicks or clicks on different elements', () => {
    const { rage, detector } = setup();
    detector.click(button, 0);
    detector.click(button, 400);
    detector.click(button, 800);
    vi.advanceTimersByTime(1000);
    detector.click(button, 2000);
    detector.click(plain, 2100);
    detector.click(button, 2200);
    vi.advanceTimersByTime(1000);
    expect(rage).not.toHaveBeenCalled();
  });

  it('reports a click on an interactive element with no reaction within 1.5 s as dead', () => {
    const { dead, detector } = setup();
    detector.click(button, 0);
    vi.advanceTimersByTime(1499);
    expect(dead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dead).toHaveBeenCalledWith({ selector: 'main > button.buy.now', text: 'Buy it' });
  });

  it('does not report a click followed by a DOM change, navigation or request', () => {
    const { dead, detector } = setup();
    detector.click(button, 0);
    vi.advanceTimersByTime(800);
    detector.reaction();
    vi.advanceTimersByTime(2000);
    expect(dead).not.toHaveBeenCalled();
  });

  it('ignores clicks on elements that do not look clickable', () => {
    const { dead, detector } = setup();
    detector.click(plain, 0);
    vi.advanceTimersByTime(2000);
    expect(dead).not.toHaveBeenCalled();
  });

  it('flushes a rage burst immediately when the page goes away', () => {
    const { rage, detector } = setup();
    detector.click(button, 0);
    detector.click(button, 100);
    detector.click(button, 200);
    detector.flush();
    expect(rage).toHaveBeenCalledWith(expect.objectContaining({ count: 3 }));
  });
});
