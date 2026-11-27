/** FNV-1a, 32 bit. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Whether a session is recorded at `sampleRate` percent. The same id always gives the same answer. */
export function isSampled(sessionId: string, sampleRate: number): boolean {
  if (sampleRate >= 100) return true;
  if (sampleRate <= 0) return false;
  return (hash(sessionId) % 10_000) / 100 < sampleRate;
}
