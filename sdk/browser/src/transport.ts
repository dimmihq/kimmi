import { envelope, gzip, gzipNow } from './envelope';
import type { BatchMeta } from './types';

interface Item {
  meta: BatchMeta;
  json: string;
  body?: Uint8Array<ArrayBuffer>;
  attempts: number;
  inFlight: boolean;
}

const MAX_RETRIES = 3;
const KEEPALIVE_LIMIT = 60_000;

/** Sends batches one at a time, in order, retrying failures and stopping when the server refuses the session. */
export class Transport {
  private queue: Item[] = [];
  private pumping = false;
  private halted = false;

  constructor(
    private readonly url: string,
    private readonly fetchFn: typeof fetch,
    private readonly onHalt: () => void,
    private readonly retryBaseMs = 1000,
  ) {}

  enqueue(meta: BatchMeta, json: string): void {
    if (this.halted) return;
    this.queue.push({ meta, json, attempts: 0, inFlight: false });
    void this.pump();
  }

  /** Sends everything not already in flight with `sendBeacon`, compressing synchronously: the page is going away. */
  drainWithBeacon(): void {
    if (this.halted) return;
    const pending = this.queue.filter((item) => !item.inFlight);
    this.queue = this.queue.filter((item) => item.inFlight);
    for (const item of pending) {
      const body = item.body ?? envelope(item.meta, gzipNow(item.json));
      const blob = new Blob([body]);
      const queued = typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(this.url, blob);
      if (!queued) void this.post(body).catch(() => undefined);
    }
  }

  clear(): void {
    this.queue = [];
  }

  private post(body: Uint8Array<ArrayBuffer>): Promise<Response> {
    return this.fetchFn(this.url, {
      method: 'POST',
      body,
      credentials: 'omit',
      keepalive: body.length < KEEPALIVE_LIMIT,
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.halted) {
        const item = this.queue[0];
        if (!item) break;
        if (!item.body) {
          try {
            item.body = envelope(item.meta, await gzip(item.json));
          } catch {
            this.queue = this.queue.filter((queued) => queued !== item);
            continue;
          }
        }
        if (this.queue[0] !== item) continue;

        item.inFlight = true;
        let status = 0;
        try {
          status = (await this.post(item.body)).status;
        } catch {
          status = 0;
        }
        item.inFlight = false;

        // A 429 is a rate limit that passes (a whole office can share one
        // address), so it is retried below. Only a refusal ends the session.
        if (status === 403) {
          this.halted = true;
          this.queue = [];
          this.onHalt();
          break;
        }
        if ((status >= 200 && status < 300) || status === 400 || status === 413) {
          this.queue.shift();
          continue;
        }
        item.attempts++;
        if (item.attempts > MAX_RETRIES) {
          this.queue.shift();
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryBaseMs * 2 ** (item.attempts - 1)));
      }
    } finally {
      this.pumping = false;
    }
  }
}
