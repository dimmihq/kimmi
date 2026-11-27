/**
 * Everything the player's inspector shows, read from the recording's own
 * rrweb events: activity, console, network, inactive stretches, the URL at a
 * moment and the viewport. Pure: the same events always give the same result.
 *
 * Times (`t`) are milliseconds from the first event, the same clock as
 * `Replayer.getCurrentTime()`.
 */

/** An rrweb event as the server returns it. */
export interface RawEvent {
  type: number;
  timestamp: number;
  data: unknown;
}

export type ActivityKind =
  | 'navigate'
  | 'click'
  | 'input'
  | 'scroll'
  | 'rage'
  | 'dead'
  | 'error'
  | 'idle';

export interface ActivityEntry {
  t: number;
  kind: ActivityKind;
  label: string;
  detail?: string;
}

export interface ConsoleEntry {
  t: number;
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  source: string;
}

export interface NetworkEntry {
  t: number;
  method: string;
  url: string;
  status: number;
  ms: number;
  size: number;
  kind: string;
}

export interface Range {
  start: number;
  end: number;
}

export interface Derived {
  /** Timestamp of the first event (Unix ms). */
  startedAt: number;
  durationMs: number;
  /** Enough to hand to the Replayer: two events and a full snapshot. */
  playable: boolean;
  viewport: { width: number; height: number } | null;
  activity: ActivityEntry[];
  console: ConsoleEntry[];
  network: NetworkEntry[];
  inactive: Range[];
  /** Every URL the page was at, oldest first. */
  navigations: { t: number; href: string }[];
}

/* rrweb's numbering (EventType, IncrementalSource, MouseInteractions, NodeType). */
const EVENT = { FullSnapshot: 2, Incremental: 3, Meta: 4, Custom: 5 } as const;
const SOURCE = { Mutation: 0, MouseInteraction: 2, Scroll: 3, Input: 5 } as const;
/** Sources rrweb itself treats as the visitor doing something. */
const USER_SOURCES = new Set([1, 2, 3, 4, 5, 6, 7, 12]);
const CLICK = 2;
const NODE = { Element: 2, Text: 3 } as const;

/** A gap without input longer than this is inactivity. */
export const IDLE_MS = 10_000;
/** Clicks on one element closer than this are one click in the list. */
const CLICK_REPEAT_MS = 700;
const INPUT_BURST_MS = 2000;
const SCROLL_BURST_MS = 1500;
const LABEL_MAX = 48;

/* ------------------------------------------------------------- Node index */

interface SerializedNode {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  textContent?: string;
  childNodes?: SerializedNode[];
}

interface IndexedNode {
  type: number;
  tag: string;
  attributes: Record<string, unknown>;
  text: string;
  parent: number | null;
  children: number[];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const number = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The page's nodes as the snapshot and mutations describe them, kept current in event order. */
class NodeIndex {
  private nodes = new Map<number, IndexedNode>();

  reset() {
    this.nodes.clear();
  }

  add(raw: unknown, parent: number | null) {
    const node = record(raw) as Partial<SerializedNode>;
    if (typeof node.id !== 'number') return;
    this.nodes.set(node.id, {
      type: number(node.type, -1),
      tag: text(node.tagName).toLowerCase(),
      attributes: record(node.attributes),
      text: text(node.textContent),
      parent,
      children: [],
    });
    if (parent !== null) this.nodes.get(parent)?.children.push(node.id);
    for (const child of list(node.childNodes)) this.add(child, node.id);
  }

  remove(id: number) {
    const node = this.nodes.get(id);
    if (!node) return;
    const parent = node.parent === null ? undefined : this.nodes.get(node.parent);
    if (parent) parent.children = parent.children.filter((child) => child !== id);
    const stack = [id];
    while (stack.length) {
      const next = stack.pop() as number;
      stack.push(...(this.nodes.get(next)?.children ?? []));
      this.nodes.delete(next);
    }
  }

  setText(id: number, value: string) {
    const node = this.nodes.get(id);
    if (node) node.text = value;
  }

  setAttributes(id: number, attributes: Record<string, unknown>) {
    const node = this.nodes.get(id);
    if (node) node.attributes = { ...node.attributes, ...attributes };
  }

  mutate(data: Record<string, unknown>) {
    for (const entry of list(data.removes)) this.remove(number(record(entry).id, -1));
    for (const entry of list(data.adds)) {
      const add = record(entry);
      this.add(add.node, number(add.parentId, -1));
    }
    for (const entry of list(data.texts)) {
      const change = record(entry);
      this.setText(number(change.id, -1), text(change.value));
    }
    for (const entry of list(data.attributes)) {
      const change = record(entry);
      this.setAttributes(number(change.id, -1), record(change.attributes));
    }
  }

  private textOf(id: number, budget = 200): string {
    const node = this.nodes.get(id);
    if (!node) return '';
    if (node.type === NODE.Text) return node.text;
    if (node.tag === 'script' || node.tag === 'style' || node.tag === 'noscript') return '';
    let out = '';
    for (const child of node.children) {
      out += ` ${this.textOf(child, budget - out.length)}`;
      if (out.length >= budget) break;
    }
    return out;
  }

  private named(node: IndexedNode) {
    const { attributes } = node;
    for (const name of ['aria-label', 'title', 'alt', 'placeholder', 'name']) {
      const value = text(attributes[name]).trim();
      if (value) return value;
    }
    const kind = text(attributes.type);
    if (node.tag === 'input' && (kind === 'submit' || kind === 'button')) {
      return text(attributes.value).trim();
    }
    return '';
  }

  /** What a visitor would call this element: its text, else its accessible name. */
  label(id: number): string | null {
    let current: number | null = id;
    for (let depth = 0; current !== null && depth < 4; depth++) {
      const node = this.nodes.get(current);
      if (!node) return null;
      const content = this.textOf(current).replace(/\s+/g, ' ').trim();
      // rrweb masks text as asterisks: a masked label says nothing.
      const value = content && !/^[*\s]+$/.test(content) ? content : this.named(node);
      if (value) return value.length > LABEL_MAX ? `${value.slice(0, LABEL_MAX - 1)}…` : value;
      current = node.parent;
    }
    return null;
  }

  /** A form field's name, for "Typed in a field". */
  field(id: number): string | null {
    const node = this.nodes.get(id);
    return node ? this.named(node) || null : null;
  }
}

/* ----------------------------------------------------------------- Derive */

const LEVELS = new Set(['log', 'info', 'warn', 'error']);

const pathOf = (href: string) => {
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}`;
  } catch {
    return href;
  }
};

export function derive(events: readonly RawEvent[]): Derived {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let hasSnapshot = false;
  for (const event of events) {
    start = Math.min(start, event.timestamp);
    end = Math.max(end, event.timestamp);
    if (event.type === EVENT.FullSnapshot) hasSnapshot = true;
  }
  if (!events.length) start = end = 0;

  const activity: ActivityEntry[] = [];
  const consoleEntries: ConsoleEntry[] = [];
  const network: NetworkEntry[] = [];
  const inactive: Range[] = [];
  const navigations: Derived['navigations'] = [];
  let viewport: Derived['viewport'] = null;

  const nodes = new NodeIndex();
  let lastClick: { id: number; t: number } | null = null;
  let typing: { id: number; t: number } | null = null;
  let scrolling: { entry: ActivityEntry; from: number; t: number } | null = null;
  const scrollTop = new Map<number, number>();
  let lastInput = 0;

  for (const event of events) {
    const t = event.timestamp - start;
    const data = record(event.data);

    if (event.type === EVENT.Meta) {
      const width = number(data.width);
      const height = number(data.height);
      if (!viewport && width > 0 && height > 0) viewport = { width, height };
      const href = text(data.href);
      if (href) navigations.push({ t, href });
      continue;
    }

    if (event.type === EVENT.FullSnapshot) {
      nodes.reset();
      nodes.add(data.node, null);
      continue;
    }

    if (event.type === EVENT.Custom) {
      const payload = record(data.payload);
      switch (text(data.tag)) {
        case 'navigate': {
          const href = text(payload.href);
          if (href) navigations.push({ t, href });
          const path = text(payload.path) || pathOf(href);
          const title = text(payload.title);
          activity.push({ t, kind: 'navigate', label: path || '/', detail: title || undefined });
          break;
        }
        case 'console': {
          const level = text(payload.level, 'log');
          consoleEntries.push({
            t,
            level: (LEVELS.has(level) ? level : 'log') as ConsoleEntry['level'],
            text: text(payload.text),
            source: text(payload.source),
          });
          break;
        }
        case 'network':
          network.push({
            t,
            method: text(payload.method, 'GET').toUpperCase(),
            url: text(payload.url),
            status: number(payload.status),
            ms: Math.round(number(payload.ms)),
            size: number(payload.size),
            kind: text(payload.kind, 'fetch'),
          });
          break;
        case 'error':
          activity.push({
            t,
            kind: 'error',
            label: text(payload.message) || 'Error',
            detail: text(payload.source) || undefined,
          });
          break;
        case 'rage-click': {
          const target = text(payload.text) || text(payload.selector);
          const count = number(payload.count, 3);
          activity.push({
            t,
            kind: 'rage',
            label: target ? `Rage click on ${target}` : 'Rage click',
            detail: `${count} clicks in under a second`,
          });
          break;
        }
        case 'dead-click': {
          const target = text(payload.text) || text(payload.selector);
          activity.push({
            t,
            kind: 'dead',
            label: target ? `Dead click on ${target}` : 'Dead click',
            detail: 'Nothing changed after the click',
          });
          break;
        }
      }
      continue;
    }

    if (event.type !== EVENT.Incremental) continue;
    const source = number(data.source, -1);

    if (USER_SOURCES.has(source)) {
      const since = t - lastInput;
      if (since > IDLE_MS) {
        inactive.push({ start: lastInput, end: t });
        activity.push({
          t: lastInput,
          kind: 'idle',
          label: 'Inactive',
          detail: `${Math.round(since / 1000)}s without input`,
        });
      }
      lastInput = t;
    }

    if (source === SOURCE.Mutation) {
      nodes.mutate(data);
    } else if (source === SOURCE.MouseInteraction && number(data.type, -1) === CLICK) {
      const id = number(data.id, -1);
      const repeat = lastClick && lastClick.id === id && t - lastClick.t < CLICK_REPEAT_MS;
      lastClick = { id, t };
      if (!repeat) {
        const label = nodes.label(id);
        activity.push({ t, kind: 'click', label: label ? `Clicked ${label}` : 'Clicked' });
      }
    } else if (source === SOURCE.Input) {
      const id = number(data.id, -1);
      const burst = typing && typing.id === id && t - typing.t < INPUT_BURST_MS;
      typing = { id, t };
      if (!burst) {
        const value = text(data.text);
        const masked = value.length > 0 && /^\*+$/.test(value);
        activity.push({
          t,
          kind: 'input',
          label: 'Typed in a field',
          detail: masked ? 'Masked in the browser' : (nodes.field(id) ?? undefined),
        });
      }
    } else if (source === SOURCE.Scroll) {
      const id = number(data.id, -1);
      const y = number(data.y);
      const from = scrollTop.get(id) ?? 0;
      scrollTop.set(id, y);
      if (scrolling && t - scrolling.t < SCROLL_BURST_MS) {
        scrolling.t = t;
      } else {
        const entry: ActivityEntry = { t, kind: 'scroll', label: 'Scrolled down' };
        activity.push(entry);
        scrolling = { entry, from, t };
      }
      scrolling.entry.label = y >= scrolling.from ? 'Scrolled down' : 'Scrolled up';
    }
  }

  // Idle stretches are found when input resumes, after what happened inside them.
  activity.sort((a, b) => a.t - b.t);

  return {
    startedAt: start,
    durationMs: Math.max(0, end - start),
    playable: events.length >= 2 && hasSnapshot,
    viewport,
    activity,
    console: consoleEntries,
    network,
    inactive,
    navigations,
  };
}

/** The URL the page was at `t` ms in, or null before the first one is known. */
export function urlAt(derived: Pick<Derived, 'navigations'>, t: number): string | null {
  let href: string | null = null;
  for (const entry of derived.navigations) {
    if (entry.t > t + 50) break;
    href = entry.href;
  }
  return href;
}
