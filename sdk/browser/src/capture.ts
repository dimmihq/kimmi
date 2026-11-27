import type { CustomEventPayloads } from './types';
import { truncate } from './util';

export const BODY_LIMIT = 10 * 1024;
const CONSOLE_LIMIT = 2000;

export interface CaptureSink {
  console(payload: CustomEventPayloads['console']): void;
  network(payload: CustomEventPayloads['network']): void;
  error(payload: CustomEventPayloads['error']): void;
  navigate(): void;
  /** A request started: used by dead-click detection. */
  request(): void;
  isOwnUrl(url: string): boolean;
}

export interface CaptureOptions {
  /** Read on every request: the project setting arrives after the patches are installed. */
  bodies: () => boolean;
}

type Teardown = () => void;

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

/** `file:line:col` of whoever called the patched function. */
function callerSource(): string {
  const lines = (new Error().stack ?? '').split('\n').filter((line) => /\d+:\d+/.test(line));
  const frame = lines[2] ?? lines[lines.length - 1] ?? '';
  const match = /((?:https?|file):\/\/[^\s)]+:\d+:\d+)/.exec(frame);
  return match?.[1] ?? '';
}

function absoluteUrl(url: string): string {
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}

function patch<T extends object, K extends keyof T>(target: T, key: K, wrap: (original: T[K]) => T[K]): Teardown {
  const original = target[key];
  const wrapped = wrap(original);
  target[key] = wrapped;
  return () => {
    if (target[key] === wrapped) target[key] = original;
  };
}

function captureConsole(sink: CaptureSink): Teardown[] {
  const levels = ['log', 'info', 'warn', 'error'] as const;
  let reporting = false;
  return levels.map((level) =>
    patch(console, level, (original) => (...args: unknown[]) => {
      original.apply(console, args);
      if (reporting) return;
      reporting = true;
      try {
        sink.console({ level, text: truncate(args.map(formatArg).join(' '), CONSOLE_LIMIT), source: callerSource() });
      } catch {
        // never let reporting break the host's logging
      } finally {
        reporting = false;
      }
    }),
  );
}

function isTextual(contentType: string | null): boolean {
  return !contentType || /json|text|xml|javascript|x-www-form-urlencoded/.test(contentType);
}

function captureFetch(sink: CaptureSink, captureBodies: () => boolean): Teardown {
  return patch(window, 'fetch', (original) =>
    function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const response = original.call(window, input, init);
      try {
        const request = input instanceof Request ? input : null;
        const url = absoluteUrl(request ? request.url : input instanceof URL ? input.href : String(input));
        if (sink.isOwnUrl(url)) return response;
        const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
        const bodies = captureBodies();
        const requestBody = bodies && typeof init?.body === 'string' ? truncate(init.body, BODY_LIMIT) : undefined;
        const started = performance.now();
        sink.request();
        const report = (status: number, size: number, responseBody?: string) =>
          sink.network({
            method,
            url,
            status,
            ms: Math.round(performance.now() - started),
            size,
            kind: 'fetch',
            ...(requestBody !== undefined ? { requestBody } : {}),
            ...(responseBody !== undefined ? { responseBody } : {}),
          });
        response.then(
          (res) => {
            const length = Number(res.headers.get('content-length') ?? 0) || 0;
            if (!bodies || !isTextual(res.headers.get('content-type'))) return report(res.status, length);
            return res
              .clone()
              .text()
              .then(
                (text) => report(res.status, length || text.length, truncate(text, BODY_LIMIT)),
                () => report(res.status, length),
              );
          },
          () => report(0, 0),
        ).catch(() => undefined);
      } catch {
        // reporting is best effort
      }
      return response;
    } as typeof fetch,
  );
}

function captureXhr(sink: CaptureSink, captureBodies: () => boolean): Teardown[] {
  const proto = XMLHttpRequest.prototype;
  const requests = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  const unpatchOpen = patch(proto, 'open', (original) =>
    function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        requests.set(this, { method: String(args[0]).toUpperCase(), url: absoluteUrl(String(args[1])) });
      } catch {
        // ignore
      }
      return (original as (...a: unknown[]) => void).apply(this, args);
    } as typeof proto.open,
  );
  const unpatchSend = patch(proto, 'send', (original) =>
    function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      try {
        const info = requests.get(this);
        if (info && !sink.isOwnUrl(info.url)) {
          const started = performance.now();
          const bodies = captureBodies();
          const requestBody = bodies && typeof body === 'string' ? truncate(body, BODY_LIMIT) : undefined;
          sink.request();
          this.addEventListener('loadend', () => {
            try {
              const textual = this.responseType === '' || this.responseType === 'text';
              const text = textual ? this.responseText : '';
              const length = Number(this.getResponseHeader('content-length') ?? 0) || text.length;
              sink.network({
                method: info.method,
                url: info.url,
                status: this.status,
                ms: Math.round(performance.now() - started),
                size: length,
                kind: 'xhr',
                ...(requestBody !== undefined ? { requestBody } : {}),
                ...(bodies && textual ? { responseBody: truncate(text, BODY_LIMIT) } : {}),
              });
            } catch {
              // ignore
            }
          });
        }
      } catch {
        // ignore
      }
      return original.call(this, body);
    },
  );
  return [unpatchOpen, unpatchSend];
}

function captureErrors(sink: CaptureSink): Teardown {
  const onError = (event: ErrorEvent) => {
    if (!event.message && !event.error) return;
    const error = event.error as Error | undefined;
    sink.error({
      message: truncate(event.message || String(error), CONSOLE_LIMIT),
      source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '',
      stack: truncate(error?.stack ?? '', BODY_LIMIT),
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    sink.error({
      message: truncate(reason instanceof Error ? reason.message : formatArg(reason), CONSOLE_LIMIT),
      source: 'unhandledrejection',
      stack: truncate(reason instanceof Error ? (reason.stack ?? '') : '', BODY_LIMIT),
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

function captureHistory(sink: CaptureSink): Teardown[] {
  const wrap = (key: 'pushState' | 'replaceState') =>
    patch(history, key, (original) =>
      function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        try {
          sink.navigate();
        } catch {
          // ignore
        }
        return result;
      },
    );
  const onChange = () => sink.navigate();
  window.addEventListener('popstate', onChange);
  window.addEventListener('hashchange', onChange);
  return [
    wrap('pushState'),
    wrap('replaceState'),
    () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener('hashchange', onChange);
    },
  ];
}

/** Patches the page's console, fetch, XHR, History API and error handlers. Returns a function that undoes it. */
export function installCapture(sink: CaptureSink, options: CaptureOptions): Teardown {
  const teardowns: Teardown[] = [captureErrors(sink), ...captureHistory(sink), ...captureConsole(sink)];
  if (typeof window.fetch === 'function') teardowns.push(captureFetch(sink, options.bodies));
  if (typeof XMLHttpRequest !== 'undefined') teardowns.push(...captureXhr(sink, options.bodies));
  return () => {
    for (const teardown of teardowns) teardown();
  };
}
