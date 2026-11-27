import { record } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import { pageContext, startAnalytics, type Analytics } from './analytics';
import { installCapture, installConsole, type CaptureSink } from './capture';
import { fetchConfig } from './config';
import { sanitizeDomEvent, type DomPrivacy } from './dom-privacy';
import { FrustrationDetector, elementText, selectorFor } from './frustration';
import { isSampled } from './sampling';
import { scrubPayload, scrubUrl, type ScrubOptions } from './scrub';
import { anonymousId, isExpired, newSession, resumeSession, saveSession, type Session } from './session';
import { Transport } from './transport';
import type {
  BatchCounts,
  BatchMeta,
  CustomEventPayloads,
  CustomTag,
  FeedbackOptions,
  Identity,
  InitOptions,
  RecordedEvent,
  RemoteConfig,
  Traits,
} from './types';
import { urlAllowed } from './url-rules';
import { listen as addListener, readStorage, safe, writeStorage } from './util';

const FLUSH_INTERVAL_MS = 2000;
const CHECKOUT_MS = 5 * 60_000;
const ERROR_BUFFER_MS = 60_000;
const ERROR_CHECKOUT_MS = 30_000;
const ACTIVE_GAP_MS = 5000;
const MAX_BATCH_CHARS = 4 * 1024 * 1024;
const MUTATION_STORM = 10_000;
const MOUSEMOVE_THROTTLE_MS = 250;
const EARLY_EVENT_LIMIT = 100;
const EARLY_TRACK_LIMIT = 50;

const CONSENT_KEY = 'kimmi.consent';
const IDENTITY_KEY = 'kimmi.identity';
const HALTED_KEY = 'kimmi.halted';

// rrweb event and source numbers, kept local so the bundle does not pull in @rrweb/types at runtime.
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const CUSTOM = 5;
const SOURCE_MUTATION = 0;
const SOURCE_MOUSE_INTERACTION = 2;
const CLICK = 2;

// `image` is the SVG element; CSS background images are stripped separately.
const MEDIA_SELECTORS = ['img', 'picture', 'video', 'audio', 'object', 'embed', 'canvas', 'image', 'input[type=image]'];
// Every type goes through maskInputFn, which decides; hidden and file are here so CSRF tokens and file names do too.
const ALL_INPUTS = {
  color: true, date: true, 'datetime-local': true, email: true, month: true, number: true, range: true,
  search: true, tel: true, text: true, time: true, url: true, week: true, textarea: true, select: true,
  password: true, hidden: true, file: true,
};
const EDITABLE = '[contenteditable]:not([contenteditable="false"])';
const SENSITIVE_AUTOCOMPLETE = /cc-|one-time-code|password/;

interface MutationData {
  source: number;
  adds?: unknown[];
  removes?: unknown[];
  texts?: unknown[];
  attributes?: unknown[];
}

function validSelectors(selectors: string[]): string[] {
  const probe = document.createDocumentFragment();
  return selectors.filter((selector) => {
    try {
      probe.querySelector(selector);
      return true;
    } catch {
      return false;
    }
  });
}

function doNotTrack(): boolean {
  const win = window as Window & { doNotTrack?: string };
  return navigator.doNotTrack === '1' || win.doNotTrack === '1';
}

function loadIdentity(): Identity | undefined {
  const raw = readStorage('localStorage', IDENTITY_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Identity;
  } catch {
    return undefined;
  }
}

export class Kimmi {
  private options: InitOptions | null = null;
  private config: RemoteConfig | null = null;
  private transport: Transport | null = null;
  private session: Session | null = null;
  private anonymousId = '';
  private identity: Identity | undefined;

  private running = false;
  private recording = false;
  private stopRecording: (() => void) | null = null;
  private snapshotReady = false;
  private navigatePending = false;
  private teardowns: Array<() => void> = [];
  private captureTeardown: (() => void) | null = null;
  private consoleTeardown: (() => void) | null = null;
  private analytics: Analytics | null = null;
  /** `track` calls from before analytics started; null once it is known whether it will. */
  private earlyTracks: Array<[name: string, props: unknown, at: number]> | null = [];
  /** The feedback button: 0 not asked for, 1 wanted once analytics runs, 2 loaded. */
  private widget = 0;
  private widgetLeft = false;
  /** Console, network and error events from before the first snapshot, replayed right after it. */
  private early: Array<{ tag: CustomTag; payload: unknown }> | null = null;
  private detector: FrustrationDetector | null = null;
  private errorCheckout: ReturnType<typeof setInterval> | null = null;

  private segments: RecordedEvent[][] = [[]];
  private activity: number[] = [];
  private keys: number[] = [];
  private lastActive = 0;
  private lastMouseMove = 0;
  private waitingForError = false;
  private idle = false;
  private lastHref = '';

  /** Regions whose text, text attributes and input values are masked. */
  private textMaskSelector = '';
  private ignoreSelector = '';
  private blockSelector = '';
  private domPrivacy: DomPrivacy | null = null;

  init(options: InitOptions): void {
    if (this.options || !options?.key || !options.host) return;
    this.options = { ...options, host: options.host.replace(/\/+$/, '') };
    const nativeFetch = window.fetch.bind(window);
    this.identity ??= loadIdentity();
    const { host, key } = this.options;
    this.transport = new Transport(this.endpoint('batch'), nativeFetch, () => this.halt());
    this.early = [];
    this.installCapture(true);
    fetchConfig(nativeFetch, host, key)
      .then((config) => {
        if (config) {
          this.config = config;
          this.preparePrivacy(config);
          this.saveIdentity();
          this.start();
          this.startAnalytics();
        } else this.earlyTracks = null;
        if (!this.running) this.dropCapture();
      })
      .catch(() => {
        this.earlyTracks = null;
        this.dropCapture();
      });
  }

  private endpoint(path: string): string {
    const { host, key } = this.options!;
    return `${host}/i/v1/${path}?key=${encodeURIComponent(key)}`;
  }

  /** The visitor's id, created in localStorage the first time something that may store it needs it. */
  private visitorId(): string {
    return (this.anonymousId ||= anonymousId());
  }

  private consent(): string | null {
    return readStorage('localStorage', CONSENT_KEY);
  }

  private saveIdentity(): void {
    const config = this.config;
    // Not before the config arrives: a cookieless project keeps the identity in memory until optIn().
    if (!this.identity || !config || (config.analytics.cookieless && this.consent() !== 'granted')) return;
    writeStorage('localStorage', IDENTITY_KEY, JSON.stringify(this.identity));
  }

  identify(id: string, traits: Traits = {}): void {
    if (!id) return;
    const { email, name, ...rest } = traits;
    const payload: CustomEventPayloads['identify'] = {
      id: String(id),
      ...(typeof email === 'string' ? { email } : {}),
      ...(typeof name === 'string' ? { name } : {}),
    };
    this.identity = { ...payload, traits: rest };
    this.saveIdentity();
    this.emitCustom('identify', payload);
  }

  track(name: string, props?: Record<string, unknown>): void {
    const clean = String(name || '').trim().slice(0, 64);
    if (!clean) return;
    const analytics = this.analytics;
    if (analytics && analytics.active) analytics.track(clean, props);
    else if (this.earlyTracks && this.earlyTracks.length < EARLY_TRACK_LIMIT) {
      this.earlyTracks.push([clean, props, Date.now()]);
    }
    this.emitCustom('track', { name: clean, props: props || {} });
  }

  feedback(text: string, options?: FeedbackOptions): void {
    if (this.analytics && typeof text === 'string') this.analytics.feedback(text, options && options.email);
  }

  showFeedback(position?: 'bottom-right' | 'bottom-left'): void {
    if (position) this.widgetLeft = position === 'bottom-left';
    if (this.widget > 1) return;
    this.widget = 1;
    if (!this.analytics || !this.analytics.active) return;
    this.widget = 2;
    (window as Window & { __kimmiFeedback?: unknown }).__kimmiFeedback = {
      send: safe((text: string, email?: string) => this.feedback(text, { email })),
      labels: {},
      left: this.widgetLeft,
    };
    const script = document.createElement('script');
    script.src = `${this.options!.host}/kimmi-feedback.js`;
    (document.head || document.documentElement).appendChild(script);
  }

  optIn(): void {
    writeStorage('localStorage', CONSENT_KEY, 'granted');
    this.saveIdentity();
    this.start();
    this.startAnalytics();
  }

  optOut(): void {
    writeStorage('localStorage', CONSENT_KEY, 'denied');
    this.stopAnalytics(false);
    this.shutdown(false);
  }

  stop(): void {
    this.stopAnalytics(true);
    this.shutdown(true);
  }

  getSessionId(): string | null {
    return this.running && this.session ? this.session.id : null;
  }

  private start(): void {
    const config = this.config;
    if (!config?.recording || this.running) return;
    const consent = this.consent();
    if (consent === 'denied') return;
    // A cookieless project stores nothing unasked, and a recording needs storage: it waits for optIn() too.
    if ((config.privacy.requireConsent || config.analytics.cookieless) && consent !== 'granted') return;
    if (config.privacy.respectDnt && doNotTrack()) return;

    const session = resumeSession(config.capture, Date.now());
    if (readStorage('sessionStorage', HALTED_KEY) === session.id) return;
    if (!isSampled(session.id, config.sampleRate)) return;

    this.session = session;
    this.running = true;
    this.waitingForError = config.capture.startOnError;
    this.installCapture(true);
    this.installListeners(config);
    if (urlAllowed(config.capture.urlRules, location.href)) this.startRecorder();
  }

  /**
   * Analytics runs on its own terms: sampling, URL rules and the minimum duration do not apply to it.
   * A recording gives it its identity; without one a cookieless project keeps the visit in memory, and
   * any other project needs consent to store it (see `resolve` in analytics.ts).
   */
  private startAnalytics(): void {
    const config = this.config;
    if (!config || this.analytics) return;
    if (!config.analytics.enabled || this.consent() === 'denied' || (config.privacy.respectDnt && doNotTrack())) {
      this.earlyTracks = null;
      return;
    }
    // With no recording and no cookieless mode the visit lives in storage, which may need optIn() first:
    // early track calls are kept for it. (A visitor who opted out never gets this far.)
    if (!this.running && !config.analytics.cookieless && config.privacy.requireConsent && this.consent() !== 'granted') return;
    this.installCapture(false);
    this.analytics = startAnalytics(
      {
        endpoint: (path) => this.endpoint(path),
        release: this.options!.release,
        // The page's own fetch, from before it was patched.
        fetch: this.transport!.fetchFn,
        scrub: () => this.scrubbing(),
        session: () => (this.running ? this.session : null),
        anonymousId: () => this.visitorId(),
        maskSelector: () => this.textMaskSelector,
        title: () => this.title(),
        refused: () => {
          if (!this.running) this.dropCapture();
        },
      },
      config,
    );
    const analytics = this.analytics;
    (this.earlyTracks || []).forEach((call) => analytics.track(...call));
    this.earlyTracks = null;
    const button = config.feedback.button;
    if (button === 'bottom-left' || button === 'bottom-right') this.showFeedback(this.widget ? undefined : button);
    else if (this.widget) this.showFeedback();
  }

  private stopAnalytics(send: boolean): void {
    this.analytics?.stop(send);
    // Gone, not just stopped, so a later optIn() can start it again. A refusal by the server keeps it.
    this.analytics = null;
    this.earlyTracks = null;
  }

  private preparePrivacy(config: RemoteConfig): void {
    const { privacy } = config;
    const mask = ['[data-private]', '.kimmi-mask', ...privacy.maskSelectors, ...(privacy.maskAllInputs ? [EDITABLE] : [])];
    this.textMaskSelector = privacy.maskAllText ? '*' : validSelectors(mask).join(',');
    // rrweb ignores only the element that matches, not inputs inside a matching container.
    this.ignoreSelector = validSelectors(['.kimmi-ignore', ...privacy.ignoreSelectors])
      .map((selector) => `${selector},${selector} *`)
      .join(',');
    this.blockSelector = validSelectors([
      '[data-kimmi-block]',
      '.kimmi-block',
      ...privacy.blockSelectors,
      ...(privacy.blockMedia ? MEDIA_SELECTORS : []),
    ]).join(',');
    this.domPrivacy = { mask: this.textMaskSelector, stripImages: privacy.blockMedia };
  }

  private scrubbing(): ScrubOptions {
    const privacy = this.config?.privacy;
    return { emails: privacy?.scrubEmails !== false, phones: privacy?.scrubPhones !== false, custom: this.options?.scrub };
  }

  private shouldMaskInput(el: HTMLElement): boolean {
    if (this.config?.privacy.maskAllInputs) return true;
    const input = el as HTMLInputElement;
    if (input.type === 'password' || input.type === 'hidden' || el.hasAttribute('data-rr-is-password')) return true;
    if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')) return true;
    try {
      return el.closest(`${this.textMaskSelector}${this.ignoreSelector ? `,${this.ignoreSelector}` : ''}`) !== null;
    } catch {
      return true;
    }
  }

  /** Errors, navigations and requests feed the recording and analytics; the console only the recording. */
  private installCapture(withConsole: boolean): void {
    const sink: CaptureSink = {
      console: (payload) => this.emitCustom('console', payload),
      network: (payload) => {
        this.emitCustom('network', payload);
        this.analytics?.request(payload);
      },
      error: (payload) => {
        this.onError(payload);
        this.analytics?.error(payload);
      },
      navigate: () => {
        this.onNavigate();
        this.analytics?.navigate();
      },
      request: () => this.detector?.reaction(),
      isOwnUrl: (url) => url.startsWith(`${this.options?.host}/i/`),
    };
    this.captureTeardown ??= installCapture(sink, { bodies: () => this.config?.capture.networkBodies === true });
    if (withConsole) this.consoleTeardown ??= installConsole(sink);
  }

  /** Removes the patches nothing needs any more: all of them, or only the console's while analytics runs. */
  private dropCapture(): void {
    this.consoleTeardown?.();
    this.consoleTeardown = null;
    this.early = null;
    if (this.analytics?.active) return;
    this.captureTeardown?.();
    this.captureTeardown = null;
  }

  private installListeners(config: RemoteConfig): void {
    const { capture } = config;

    const listen = <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void) => {
      this.teardowns.push(addListener(window, type, handler));
    };
    const active = () => this.onActivity(Date.now(), false);
    listen('mousemove', () => {
      const now = Date.now();
      if (now - this.lastMouseMove < MOUSEMOVE_THROTTLE_MS) return;
      this.lastMouseMove = now;
      this.onActivity(now, false);
    });
    listen('mousedown', active);
    listen('scroll', active);
    listen('wheel', active);
    listen('touchstart', active);
    listen('keydown', () => this.onActivity(Date.now(), true));
    listen('pagehide', () => this.onHidden());
    const onVisibility = safe(() => {
      if (document.visibilityState === 'hidden') this.onHidden();
    });
    document.addEventListener('visibilitychange', onVisibility);
    this.teardowns.push(() => document.removeEventListener('visibilitychange', onVisibility));

    if (capture.frustration) {
      listen('click', (event) => {
        if (this.recording && event.target instanceof Element && !event.target.closest('[data-kimmi-own]')) {
          this.detector?.click(event.target, Date.now());
        }
      });
    }

    const timer = setInterval(safe(() => this.tick()), FLUSH_INTERVAL_MS);
    this.teardowns.push(() => clearInterval(timer));
  }

  private startRecorder(): void {
    const config = this.config;
    if (!config || this.recording) return;
    const { privacy, capture } = config;

    this.segments = [[]];
    this.snapshotReady = false;
    this.navigatePending = true;
    this.lastHref = '';
    if (capture.frustration) {
      this.detector = new FrustrationDetector({
        rage: (payload) => {
          this.emitCustom('rage-click', payload);
          this.analytics?.frustration('rage', payload);
        },
        dead: (payload) => {
          this.emitCustom('dead-click', payload);
          this.analytics?.frustration('dead', payload);
        },
        describe: (el) => ({ selector: selectorFor(el), text: elementText(el, this.textMaskSelector) }),
      });
    }
    this.recording = true;
    this.stopRecording =
      record<eventWithTime>({
        emit: (event, isCheckout) => {
          try {
            this.onEvent(event as RecordedEvent, isCheckout === true);
          } catch {
            // a bad event must not stop recording
          }
        },
        checkoutEveryNms: CHECKOUT_MS,
        recordAfter: 'DOMContentLoaded',
        maskInputOptions: ALL_INPUTS,
        // A select's masked length would tell its options apart, so it is always the same.
        maskInputFn: (text, el) =>
          !this.shouldMaskInput(el) ? text : el.tagName === 'SELECT' && text ? '***' : '*'.repeat(text.length),
        maskTextSelector: this.textMaskSelector || undefined,
        blockSelector: this.blockSelector || undefined,
        ignoreSelector: this.ignoreSelector || undefined,
        recordCanvas: privacy.recordCanvas,
        ...(privacy.recordCanvas
          ? { sampling: { canvas: 2 }, dataURLOptions: { type: 'image/webp', quality: 0.6 } }
          : {}),
        recordCrossOriginIframes: capture.crossOriginIframes,
        slimDOMOptions: { script: true, comment: true, headFavicon: true, headWhitespace: true },
        errorHandler: () => true,
      }) ?? null;
    if (this.waitingForError) {
      this.errorCheckout = setInterval(
        safe(() => record.takeFullSnapshot(true)),
        ERROR_CHECKOUT_MS,
      );
    }
  }

  private stopRecorder(): void {
    this.stopRecording?.();
    this.stopRecording = null;
    this.recording = false;
    this.snapshotReady = false;
    this.detector?.dispose();
    this.detector = null;
    if (this.errorCheckout) clearInterval(this.errorCheckout);
    this.errorCheckout = null;
  }

  private onEvent(event: RecordedEvent, isCheckout: boolean): void {
    if (event.type === INCREMENTAL) {
      const data = event.data as MutationData;
      if (data.source === SOURCE_MUTATION) {
        const size =
          (data.adds?.length ?? 0) + (data.removes?.length ?? 0) + (data.texts?.length ?? 0) + (data.attributes?.length ?? 0);
        if (size > MUTATION_STORM) {
          record.takeFullSnapshot();
          return;
        }
        this.detector?.reaction();
      }
    }
    if (event.type === META && isCheckout && this.waitingForError) this.rollErrorBuffer(event.timestamp);
    if (this.domPrivacy) sanitizeDomEvent(event, this.domPrivacy);
    if (event.type === META) {
      const data = event.data as { href?: string };
      if (data.href) data.href = scrubUrl(data.href, this.scrubbing());
    }
    this.segments[this.segments.length - 1]!.push(event);
    if (event.type === FULL_SNAPSHOT) {
      this.snapshotReady = true;
      if (this.navigatePending) {
        this.navigatePending = false;
        // rrweb refuses custom events until record() has finished its first snapshot.
        queueMicrotask(safe(() => this.emitNavigate()));
      }
    }
  }

  /** Keeps whole checkout segments covering at least the last 60 s. */
  private rollErrorBuffer(now: number): void {
    this.segments.push([]);
    while (this.segments.length > 2 && (this.segments[1]![0]?.timestamp ?? now) <= now - ERROR_BUFFER_MS) {
      this.segments.shift();
    }
    const from = this.segments[0]![0]?.timestamp ?? now;
    this.activity = this.activity.filter((t) => t >= from);
    this.keys = this.keys.filter((t) => t >= from);
  }

  private emitCustom<T extends CustomTag>(tag: T, payload: CustomEventPayloads[T]): void {
    const capture = this.config?.capture;
    if ((tag === 'console' && capture?.console === false) || (tag === 'network' && capture?.network === false)) return;
    if (this.recording && this.snapshotReady) {
      record.addCustomEvent(tag, scrubPayload(tag, payload, this.scrubbing()));
    }
    else if (this.early && this.early.length < EARLY_EVENT_LIMIT) this.early.push({ tag, payload });
  }

  private emitNavigate(): void {
    this.lastHref = location.href;
    this.detector?.reaction();
    this.emitCustom('navigate', { href: location.href, path: location.pathname, title: this.title() });
    const early = this.early;
    this.early = null;
    for (const { tag, payload } of early ?? []) {
      if (tag === 'error') this.onError(payload as CustomEventPayloads['error']);
      else this.emitCustom(tag, payload as never);
    }
  }

  /** The document title, masked when the page's text is. */
  private title(): string {
    try {
      const masked = document.querySelector('title')?.closest(this.textMaskSelector);
      return masked ? document.title.replace(/\S/g, '*') : document.title;
    } catch {
      return '';
    }
  }

  private onNavigate(): void {
    const config = this.config;
    if (!config || !this.running || location.href === this.lastHref) return;
    if (!urlAllowed(config.capture.urlRules, location.href)) {
      if (this.recording) {
        this.flush();
        this.stopRecorder();
      }
      return;
    }
    if (this.recording) this.emitNavigate();
    else if (!this.idle) this.startRecorder();
  }

  private onError(payload: CustomEventPayloads['error']): void {
    this.emitCustom('error', payload);
    if (this.waitingForError && this.recording) {
      this.waitingForError = false;
      if (this.errorCheckout) clearInterval(this.errorCheckout);
      this.errorCheckout = null;
    }
  }

  private onActivity(at: number, key: boolean): void {
    const session = this.session;
    const config = this.config;
    if (!session || !config || !this.running) return;
    if (this.idle || isExpired(session, config.capture, at)) this.rotate(at);
    if (!this.running || !this.session) return;
    this.session.lastActivity = at;
    this.activity.push(at);
    if (key) this.keys.push(at);
  }

  private tick(): void {
    const session = this.session;
    const config = this.config;
    if (!session || !config) return;
    const now = Date.now();
    if (this.recording && now - session.lastActivity > config.capture.idleTimeoutMs) {
      this.flush();
      this.stopRecorder();
      this.idle = true;
    } else if (this.recording && now - session.startedAt >= config.capture.maxLengthMs) {
      this.rotate(now);
    }
    this.flush();
    saveSession(session);
  }

  /** Ends the current session and starts a new one with a fresh full snapshot. */
  private rotate(at: number): void {
    const config = this.config;
    const previous = this.session;
    if (!config || !previous) return;
    this.flush();
    this.session = newSession(previous.windowId, at);
    saveSession(this.session);
    this.segments = [[]];
    this.activity = [];
    this.keys = [];
    this.lastActive = 0;
    this.idle = false;
    this.waitingForError = config.capture.startOnError;
    if (!isSampled(this.session.id, config.sampleRate)) {
      this.shutdown(false);
      return;
    }
    if (!urlAllowed(config.capture.urlRules, location.href)) {
      this.stopRecorder();
      return;
    }
    this.stopRecorder();
    this.startRecorder();
  }

  private onHidden(): void {
    this.detector?.flush();
    this.flush();
    this.transport?.drainWithBeacon();
    if (this.session) saveSession(this.session);
  }

  /** Turns everything buffered into batches, unless the session is still held back. */
  private flush(): void {
    const session = this.session;
    const config = this.config;
    const transport = this.transport;
    if (!session || !config || !transport || this.waitingForError) return;
    if (Date.now() - session.startedAt < config.capture.minDurationMs) return;
    const events = this.segments.flat();
    if (events.length === 0) return;
    this.segments = [[]];

    const chunks: Array<{ events: RecordedEvent[]; parts: string[] }> = [];
    let size = 0;
    for (const event of events) {
      const json = JSON.stringify(event);
      let chunk = chunks[chunks.length - 1];
      if (!chunk || (size + json.length > MAX_BATCH_CHARS && chunk.parts.length > 0)) {
        chunk = { events: [], parts: [] };
        chunks.push(chunk);
        size = 0;
      }
      chunk.events.push(event);
      chunk.parts.push(json);
      size += json.length + 1;
    }
    chunks.forEach((chunk, index) => {
      const meta = this.meta(session, chunk.events, index === chunks.length - 1);
      session.seq++;
      transport.enqueue(meta, `[${chunk.parts.join(',')}]`);
    });
    saveSession(session);
  }

  private takeUntil(list: number[], until: number, all: boolean): number[] {
    const cut = all ? list.length : list.findIndex((t) => t > until);
    const end = cut === -1 ? list.length : cut;
    return list.splice(0, end);
  }

  private meta(session: Session, events: RecordedEvent[], last: boolean): BatchMeta {
    const firstTs = events[0]!.timestamp;
    const lastTs = events[events.length - 1]!.timestamp;
    const counts: BatchCounts = {
      events: events.length,
      clicks: 0,
      keypresses: this.takeUntil(this.keys, lastTs, last).length,
      rageClicks: 0,
      deadClicks: 0,
      errors: 0,
      pageviews: 0,
      activeMs: 0,
    };
    const paths = new Set<string>();
    for (const event of events) {
      if (event.type === INCREMENTAL) {
        const data = event.data as { source: number; type?: number };
        if (data.source === SOURCE_MOUSE_INTERACTION && data.type === CLICK) counts.clicks++;
      } else if (event.type === CUSTOM) {
        const { tag, payload } = event.data as { tag: string; payload: { path?: string } };
        if (tag === 'rage-click') counts.rageClicks++;
        else if (tag === 'dead-click') counts.deadClicks++;
        else if (tag === 'error') counts.errors++;
        else if (tag === 'navigate') {
          counts.pageviews++;
          if (payload.path) paths.add(payload.path);
        }
      }
    }
    let previous = this.lastActive;
    for (const t of this.takeUntil(this.activity, lastTs, last)) {
      if (previous && t - previous <= ACTIVE_GAP_MS && t >= previous) counts.activeMs += t - previous;
      previous = t;
    }
    this.lastActive = previous;
    const scrub = this.scrubbing();
    if (paths.size === 0) paths.add(scrubUrl(location.pathname, scrub));

    return {
      v: 1,
      sessionId: session.id,
      windowId: session.windowId,
      seq: session.seq,
      anonymousId: this.visitorId(),
      ...(this.identity ? { identity: this.identity } : {}),
      startedAt: session.startedAt,
      firstTs,
      lastTs,
      path: scrubUrl(location.pathname, scrub),
      referrer: document.referrer && scrubUrl(document.referrer, scrub),
      ...pageContext(scrub, this.options?.release),
      counts,
      paths: [...paths],
    };
  }

  private halt(): void {
    if (this.session) writeStorage('sessionStorage', HALTED_KEY, this.session.id);
    this.shutdown(false);
  }

  /** Stops recording and removes every hook; `send` flushes what is buffered first. */
  private shutdown(send: boolean): void {
    if (send) this.onHidden();
    else {
      this.segments = [[]];
      this.transport?.clear();
    }
    this.stopRecorder();
    this.dropCapture();
    for (const teardown of this.teardowns.splice(0)) teardown();
    this.running = false;
    this.idle = false;
  }
}
