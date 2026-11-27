import { elementText, selectorFor } from './frustration';
import { scrubProps, scrubText, scrubUrl, type ScrubOptions } from './scrub';
import type { Session } from './session';
import type { CustomEventPayloads, Hit, HitEvent, RemoteConfig } from './types';
import { listen, readStorage, safe, uuidv7, writeStorage } from './util';

export const MAX_EVENTS_PER_HIT = 100;
export const MAX_HIT_CHARS = 60_000;
export const MAX_HELD = 300;
const TICK_MS = 2000;
const ENGAGED_GAP_MS = 60_000;
const VISIT_IDLE_MS = 30 * 60_000;
const SLOW_REQUEST_MS = 3000;
const VISIT_KEY = 'kimmi.visit';

const DOWNLOAD = /\.(?:pdf|zip|csv|xlsx?|docx?|pptx?|dmg|exe|mp[34]|gz|tar|rar|7z|apk|pkg|txt|svg)$/i;

export interface AutoEvent {
  n: string;
  d?: Record<string, string>;
}

/** The automatic event for a click on a link to `href`, if any. Addresses and numbers are never part of it. */
export function classifyLink(href: string, here: string = location.host): AutoEvent | null {
  const scheme = /^\s*(mailto|tel):/i.exec(href);
  if (scheme) return { n: scheme[1]!.toLowerCase() === 'tel' ? '$phone' : '$email' };
  let url: URL;
  try {
    url = new URL(href, document.baseURI);
  } catch {
    return null;
  }
  if (!url.protocol.startsWith('http')) return null;
  const path = url.pathname;
  if (DOWNLOAD.test(path)) return { n: '$download', d: { file: path.slice(path.lastIndexOf('/') + 1) } };
  return url.host === here ? null : { n: '$outbound', d: { url: url.host + path } };
}

/** The `request` event for a finished request, or null when it was neither failed nor slow. */
export function requestEvent(payload: CustomEventPayloads['network'], options: ScrubOptions): Omit<HitEvent, 't'> | null {
  const { status, ms } = payload;
  if (status !== 0 && status < 400 && ms < SLOW_REQUEST_MS) return null;
  try {
    const url = new URL(payload.url);
    return { k: 'request', n: `${scrubText(payload.method, options)} ${scrubUrl(url.host + url.pathname, options)}`, v: ms, num: status };
  } catch {
    // Not a URL: nothing safe to say about it.
    return null;
  }
}

export interface Visit {
  id: string;
  anonymousId: string;
  startedAt: number;
  lastActivity: number;
  /** Missing on a session stored by an older SDK. */
  landing?: string | undefined;
  referrer?: string | undefined;
}

/** What a batch and a hit both say about the page they were sent from. */
export function pageContext(scrub: ScrubOptions, release: string | undefined) {
  return {
    url: scrubUrl(location.href, scrub),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(release ? { release } : {}),
  };
}

/** What analytics needs from the recorder that owns it. */
export interface AnalyticsHost {
  /** The URL of an ingest endpoint, key included. */
  endpoint(path: string): string;
  release?: string | undefined;
  fetch: typeof fetch;
  scrub(): ScrubOptions;
  /** The session being recorded, if one is. */
  session(): Session | null;
  /** The visitor's id in localStorage, created on first use. */
  anonymousId(): string;
  maskSelector(): string;
  /** The page title, masked as the recorder masks it. */
  title(): string;
  /** The server refused a hit: analytics has stopped itself. */
  refused(): void;
}

type Config = Pick<RemoteConfig, 'analytics' | 'capture'>;
type Entry = { visit: Visit; e: HitEvent };

interface VitalEntry {
  name: string;
  startTime: number;
  duration: number;
  value: number;
  hadRecentInput?: boolean;
  interactionId?: number;
}

export interface Analytics {
  /** False once stopped: by the SDK, or by the server refusing a hit. */
  active: boolean;
  /** A navigation may have happened: the old page is left and the new one viewed. */
  navigate(): void;
  /** `name` is already trimmed; `props` are scrubbed here. */
  track(name: string, props?: unknown, at?: number): void;
  error(payload: CustomEventPayloads['error']): void;
  frustration(kind: 'rage' | 'dead', payload: { selector: string; text: string; count?: number }): void;
  request(payload: CustomEventPayloads['network']): void;
  feedback(text: string, email?: string): void;
  /** Stops for the page. With `send`, what is buffered leaves first. */
  stop(send: boolean): void;
}

/**
 * Sends page views, engagement, clicks, custom events and web vitals as "hits", with or without a recording.
 * State lives in this closure rather than on a class so the minifier can shorten its names.
 */
export function startAnalytics(host: AnalyticsHost, config: Config): Analytics {
  const { autoEvents, heatmaps, cookieless } = config.analytics;
  const text = (value: string) => scrubText(value, host.scrub());
  const url = (value: string) => scrubUrl(value, host.scrub());
  const cleanPath = () => url(location.pathname);

  let queue: Entry[] = [];
  let inFlight = false;
  const teardowns: Array<() => void> = [];

  /** The visit of a page that is not being recorded: in memory when cookieless, else in sessionStorage. */
  let own: Visit | null = null;
  let current: Visit | null = null;

  let href = '';
  let path = '';
  const loadPath = cleanPath();
  let engaged = 0;
  let depth = 0;
  let sentDepth = -1;
  let height = 0;
  let mark = 0;
  let lastInteraction = 0;
  let hidden = document.visibilityState === 'hidden';
  let vitals: Record<string, number> | null = null;

  /** The identity hits are sent under right now, in the order: recording, cookieless, stored visit. */
  const resolve = (now: number): Visit => {
    const session = host.session();
    if (session) return { ...session, anonymousId: host.anonymousId() };
    if (!own && !cookieless) {
      // The recorder only starts analytics for a project that is not cookieless once storage is allowed.
      try {
        const kept = JSON.parse(readStorage('sessionStorage', VISIT_KEY) || '') as Visit;
        if (kept.id && kept.lastActivity > 0) own = kept;
      } catch {
        // none, or corrupt: start over
      }
    }
    // A cookieless visit lasts as long as the page; a stored one ends after 30 minutes without activity.
    if (!own || (!cookieless && now - own.lastActivity > VISIT_IDLE_MS)) {
      // Written to sessionStorage by the next tick, or when the page is hidden.
      own = { id: uuidv7(now), anonymousId: '', startedAt: now, landing: location.href, referrer: document.referrer, lastActivity: now };
    }
    if (!cookieless) own.anonymousId = host.anonymousId();
    return own;
  };

  const saveVisit = () => {
    if (own && !cookieless) writeStorage('sessionStorage', VISIT_KEY, JSON.stringify(own));
  };

  /** Resolves the visit; when it changed, the old one gets its `leave` and the new one its `page`. */
  const sync = (now: number): Visit | null => {
    if (!api.active) return null;
    const next = resolve(now);
    const previous = current;
    current = next;
    if (previous && next.id !== previous.id) {
      leave(now, previous);
      view(now);
    }
    return next;
  };

  const add = (e: HitEvent, visit: Visit | null = sync(e.t)) => {
    // `sync` gives no visit once analytics has stopped.
    if (!visit) return;
    e.p = e.p || path;
    queue.push({ visit, e });
    if (queue.length > MAX_HELD) queue.shift();
  };

  const view = (now: number) => {
    href = location.href;
    path = cleanPath();
    engaged = depth = 0;
    sentDepth = -1;
    mark = lastInteraction = now;
    add({ t: now, k: 'page', l: text(host.title()) });
  };

  /** Adds the visible time since the last call, up to 60 s past the last interaction. */
  const accrue = (now: number) => {
    const end = Math.min(now, lastInteraction + ENGAGED_GAP_MS);
    if (!hidden && end > mark) engaged += end - mark;
    mark = now;
  };

  /** A sign of life. Cheap enough to run on every mousemove: it only moves two timestamps. */
  const interact = () => {
    const now = Date.now();
    accrue(now);
    lastInteraction = now;
    if (own) own.lastActivity = now;
  };

  const measure = () => {
    const viewport = window.innerHeight;
    height = document.documentElement.scrollHeight;
    depth = Math.max(depth, height > viewport ? Math.min(100, Math.round(((window.scrollY + viewport) / height) * 100)) : 100);
  };

  const leave = (now: number, visit: Visit | null = sync(now)) => {
    accrue(now);
    measure();
    if (!engaged && depth === sentDepth) return;
    add({ t: now, k: 'leave', v: engaged, num: depth, y: height, w: window.innerWidth }, visit);
    engaged = 0;
    sentDepth = depth;
  };

  const track = (name: string, props?: unknown, at = Date.now(), d = scrubProps(props || {}, host.scrub())) => {
    const { value, revenue } = (props || {}) as Record<string, unknown>;
    const amount = [value, revenue].find((v) => typeof v === 'number' && isFinite(v)) as number | undefined;
    // JSON leaves out what is undefined.
    add({ t: at, k: 'track', n: text(name), d: d && Object.keys(d).length ? d : undefined, v: amount });
  };

  const auto = (event: AutoEvent | null | false | '', now: number) => {
    if (!event) return;
    const d: Record<string, string> = {};
    for (const field in event.d) d[field] = url(event.d[field]!);
    track(event.n, null, now, d);
  };

  const who = (visit: Visit) => ({ v: 1 as const, visitId: visit.id, anonymousId: visit.anonymousId });

  /** The longest run of queued events of one visit that fits a hit, taken off the queue. */
  const take = (): { body: string; entries: Entry[] } | null => {
    const first = queue[0];
    if (!first) return null;
    const { visit } = first;
    const head: Omit<Hit, 'events'> = {
      ...who(visit),
      startedAt: visit.startedAt,
      // Where the visit began; a session from an older SDK did not note it, so this page stands in.
      landing: url(visit.landing || location.href),
      referrer: url(visit.referrer === undefined ? document.referrer : visit.referrer),
      ...pageContext(host.scrub(), host.release),
    };
    const prefix = `${JSON.stringify(head).slice(0, -1)},"events":[`;
    const parts: string[] = [];
    let size = prefix.length + 2;
    let count = 0;
    for (; count < queue.length && parts.length < MAX_EVENTS_PER_HIT && queue[count]!.visit.id === visit.id; count++) {
      const json = JSON.stringify(queue[count]!.e);
      if (size + json.length + 1 > MAX_HIT_CHARS) {
        // The hit is full, unless this event alone can never fit: then it is dropped.
        if (parts.length) break;
        continue;
      }
      parts.push(json);
      size += json.length + 1;
    }
    const entries = queue.splice(0, count);
    return parts.length ? { body: `${prefix}${parts.join(',')}]}`, entries } : take();
  };

  // A string body is sent as text/plain, which needs no CORS preflight.
  const post = (path: string, body: string): Promise<Response> =>
    host.fetch(host.endpoint(path), { method: 'POST', body, credentials: 'omit', keepalive: true });

  const done = () => {
    inFlight = false;
  };

  /** One hit per tick; when the page is going away, everything, with `sendBeacon`. */
  const flush = (leaving: boolean) => {
    if (!leaving && inFlight) return;
    for (let hit = take(); hit; hit = leaving ? take() : null) {
      const { body, entries } = hit;
      try {
        if (leaving && navigator.sendBeacon(host.endpoint('hit'), new Blob([body], { type: 'text/plain' }))) continue;
      } catch {
        // no sendBeacon: fetch below
      }
      const sent = post('hit', body);
      inFlight = true;
      sent
        .then(
          (response) => {
            if (response.status !== 403 && response.status !== 429) return;
            api.stop(false);
            host.refused();
          },
          () => {
            // The network failed: these wait for the next tick, the oldest giving way past the cap.
            if (!api.active) return;
            queue.unshift(...entries);
            queue.splice(0, queue.length - MAX_HELD);
          },
        )
        .then(done, done);
    }
  };

  const onHidden = () => {
    const now = Date.now();
    leave(now);
    hidden = true;
    // Web vitals, once per page load: the first time the page is hidden.
    const seen = vitals;
    vitals = null;
    try {
      const ttfb = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).responseStart;
      if (seen && ttfb > 0) seen.ttfb = ttfb;
    } catch {
      // no navigation timing
    }
    for (const name in seen) {
      const scale = name === 'cls' ? 1e4 : 1;
      add({ t: now, k: 'vital', n: name, v: Math.round(seen[name]! * scale) / scale, p: loadPath });
    }
    saveVisit();
    flush(true);
  };

  const on = <E extends Event>(target: EventTarget, type: string, handler: (event: E) => void) => {
    teardowns.push(listen(target, type, handler));
  };

  const api: Analytics = {
    active: true,
    navigate() {
      const now = Date.now();
      sync(now);
      if (location.href === href) return;
      leave(now);
      view(now);
    },
    track,
    error(payload) {
      add({ t: Date.now(), k: 'error', l: text(payload.message), d: { source: url(payload.source), stack: text(payload.stack.slice(0, 2000)) } });
    },
    frustration(kind, payload) {
      add({ t: Date.now(), k: kind, n: text(payload.selector), l: text(payload.text), v: payload.count });
    },
    request(payload) {
      const event = requestEvent(payload, host.scrub());
      if (event) add({ t: Date.now(), ...event } as HitEvent);
    },
    feedback(message, email) {
      const now = Date.now();
      const visit = sync(now);
      const clean = text(message.trim().slice(0, 2000)).slice(0, 2000);
      if (!visit || !clean) return;
      post(
        'feedback',
        JSON.stringify({ ...who(visit), path: cleanPath(), text: clean, email: String(email || '').slice(0, 200), ts: now }),
      ).catch(() => undefined);
    },
    stop(send) {
      if (!api.active) return;
      if (send) onHidden();
      api.active = false;
      queue = [];
      for (const teardown of teardowns.splice(0)) teardown();
    },
  };

  for (const type of ['scroll', 'click', 'keydown', 'mousemove', 'touchstart']) on(window, type, interact);
  on(window, 'scroll', measure);
  on<MouseEvent>(document, 'click', (event) => {
    const now = Date.now();
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[data-kimmi-own]')) return;
    if (heatmaps) {
      add({
        t: now,
        k: 'click',
        n: text(selectorFor(target)),
        l: text(elementText(target, host.maskSelector()).slice(0, 40)),
        x: Math.round((event.pageX / (document.documentElement.scrollWidth || 1)) * 10_000),
        y: Math.round(event.pageY),
        w: window.innerWidth,
      });
    }
    const link = autoEvents && target.closest('a[href]');
    // The attribute: an SVG link's `href` property is not a string.
    auto(link && classifyLink(link.getAttribute('href') || ''), now);
  });
  on(document, 'submit', (event) => {
    const form = event.target;
    if (!autoEvents || !(form instanceof Element)) return;
    // Attributes, not properties: a field named "id" or "action" shadows the property.
    const action = new URL(form.getAttribute('action') || '', document.baseURI).pathname;
    auto({ n: '$form', d: { form: form.getAttribute('id') || form.getAttribute('name') || '', action } }, Date.now());
  });
  on(window, 'pagehide', onHidden);
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') return onHidden();
    hidden = false;
    mark = lastInteraction = Date.now();
  });
  const timer = setInterval(
    safe(() => {
      sync(Date.now());
      saveVisit();
      flush(false);
    }),
    TICK_MS,
  );
  teardowns.push(() => clearInterval(timer));

  if (config.capture.performance) {
    const seen: Record<string, number> = (vitals = {});
    const observe = (type: string, handler: (entry: VitalEntry) => void, options?: object): boolean => {
      try {
        if (!PerformanceObserver.supportedEntryTypes.includes(type)) return false;
        const observer = new PerformanceObserver(safe((list) => (list.getEntries() as unknown as VitalEntry[]).forEach(handler)));
        observer.observe({ type, buffered: true, ...options });
        return true;
      } catch {
        return false;
      }
    };
    observe('largest-contentful-paint', (entry) => (seen.lcp = entry.startTime));
    observe('paint', (entry) => {
      if (entry.name === 'first-contentful-paint') seen.fcp = entry.startTime;
    });
    observe(
      'event',
      (entry) => {
        if (entry.interactionId) seen.inp = Math.max(seen.inp || 0, entry.duration);
      },
      { durationThreshold: 40 },
    );
    // The largest burst of shifts: a burst ends after 1 s without one, or at 5 s.
    let burst = 0;
    let first = 0;
    let last = 0;
    const shifts = observe('layout-shift', (entry) => {
      if (entry.hadRecentInput) return;
      const at = entry.startTime;
      if (burst && at - last < 1000 && at - first < 5000) burst += entry.value;
      else {
        burst = entry.value;
        first = at;
      }
      last = at;
      seen.cls = Math.max(seen.cls || 0, burst);
    });
    if (shifts) seen.cls = 0;
  }
  view(Date.now());
  return api;
}
