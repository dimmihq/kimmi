/** Runs `fn` and swallows anything it throws: the SDK must never break the host page. */
export function safe<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R | undefined {
  return (...args: A) => {
    try {
      return fn(...args);
    } catch {
      return undefined;
    }
  };
}

export function readStorage(storage: 'localStorage' | 'sessionStorage', key: string): string | null {
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(storage: 'localStorage' | 'sessionStorage', key: string, value: string | null): void {
  try {
    if (value === null) window[storage].removeItem(key);
    else window[storage].setItem(key, value);
  } catch {
    // Storage can be full or disabled; the SDK keeps working from memory.
  }
}

/** A UUIDv7: time-ordered, so the server's ids and the SDK's sort the same way. */
export function uuidv7(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
