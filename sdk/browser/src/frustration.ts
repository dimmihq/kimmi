import type { CustomEventPayloads } from './types';
import { truncate } from './util';

export const RAGE_WINDOW_MS = 700;
export const RAGE_MIN_CLICKS = 3;
export const DEAD_CLICK_MS = 1500;

const INTERACTIVE =
  'a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],summary,[onclick],' +
  'input[type=button],input[type=submit],input[type=reset],input[type=image]';

/** A short CSS path such as `main > div.card > button.buy`. */
export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && parts.length < 4 && node.tagName !== 'HTML' && node.tagName !== 'BODY') {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${node.id}`);
      break;
    }
    const classes = Array.from(node.classList).slice(0, 2);
    if (classes.length) part += `.${classes.join('.')}`;
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** The element a click on `target` meant to hit, if it looks clickable. */
export function interactiveTarget(target: Element): Element | null {
  const match = target.closest(INTERACTIVE);
  if (match) return match;
  try {
    if (getComputedStyle(target).cursor === 'pointer') return target;
  } catch {
    // detached or foreign element
  }
  return null;
}

export interface FrustrationHooks {
  rage(payload: CustomEventPayloads['rage-click']): void;
  dead(payload: CustomEventPayloads['dead-click']): void;
  describe(el: Element): { selector: string; text: string };
}

interface RageState {
  el: Element;
  times: number[];
  rage: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class FrustrationDetector {
  private current: RageState | null = null;
  private pendingDead = new Map<Element, ReturnType<typeof setTimeout>>();

  constructor(private readonly hooks: FrustrationHooks) {}

  click(target: Element, at: number): void {
    const el = interactiveTarget(target);
    this.trackRage(el ?? target, at);
    if (el) this.trackDead(el);
  }

  /** A DOM change, navigation or network request: pending clicks were not dead. */
  reaction(): void {
    for (const timer of this.pendingDead.values()) clearTimeout(timer);
    this.pendingDead.clear();
  }

  /** Reports a rage burst in progress right away, for when the page is going away. */
  flush(): void {
    this.finishRage();
  }

  dispose(): void {
    if (this.current) clearTimeout(this.current.timer);
    this.current = null;
    this.reaction();
  }

  private trackRage(el: Element, at: number): void {
    const current = this.current;
    if (current && (current.el !== el || at - current.times[current.times.length - 1]! > RAGE_WINDOW_MS)) {
      this.finishRage();
    }
    const state: RageState = this.current ?? { el, times: [], rage: false };
    clearTimeout(state.timer);
    state.times.push(at);
    const n = state.times.length;
    if (n >= RAGE_MIN_CLICKS && at - state.times[n - RAGE_MIN_CLICKS]! <= RAGE_WINDOW_MS) state.rage = true;
    state.timer = setTimeout(() => this.finishRage(), RAGE_WINDOW_MS);
    this.current = state;
  }

  private finishRage(): void {
    const state = this.current;
    if (!state) return;
    clearTimeout(state.timer);
    this.current = null;
    if (state.rage) this.hooks.rage({ ...this.hooks.describe(state.el), count: state.times.length });
  }

  private trackDead(el: Element): void {
    if (this.pendingDead.has(el)) return;
    this.pendingDead.set(
      el,
      setTimeout(() => {
        this.pendingDead.delete(el);
        this.hooks.dead(this.hooks.describe(el));
      }, DEAD_CLICK_MS),
    );
  }
}

export function elementText(el: Element, maskSelector: string | null): string {
  try {
    if (maskSelector && el.closest(maskSelector)) return '';
  } catch {
    // invalid selector from settings
  }
  const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return truncate(text.replace(/\s+/g, ' ').trim(), 80);
}
