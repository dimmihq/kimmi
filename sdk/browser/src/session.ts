import { readStorage, uuidv7, writeStorage } from './util';

export interface Session {
  id: string;
  windowId: string;
  seq: number;
  startedAt: number;
  lastActivity: number;
}

const SESSION_KEY = 'kimmi.session';
const ANONYMOUS_KEY = 'kimmi.anonymousId';

export interface SessionLimits {
  idleTimeoutMs: number;
  maxLengthMs: number;
}

export function isExpired(session: Session, limits: SessionLimits, now: number): boolean {
  return now - session.lastActivity > limits.idleTimeoutMs || now - session.startedAt >= limits.maxLengthMs;
}

export function newSession(windowId: string, now: number): Session {
  return { id: uuidv7(now), windowId, seq: 0, startedAt: now, lastActivity: now };
}

function loadSession(): Session | null {
  const raw = readStorage('sessionStorage', SESSION_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Session>;
    if (
      typeof value.id === 'string' &&
      typeof value.windowId === 'string' &&
      typeof value.seq === 'number' &&
      typeof value.startedAt === 'number' &&
      typeof value.lastActivity === 'number'
    ) {
      return value as Session;
    }
  } catch {
    // corrupt entry: start over
  }
  return null;
}

export function saveSession(session: Session): void {
  writeStorage('sessionStorage', SESSION_KEY, JSON.stringify(session));
}

/** The tab's current session, or a new one (same window id, seq 0) when it expired. */
export function resumeSession(limits: SessionLimits, now: number): Session {
  const stored = loadSession();
  if (stored && !isExpired(stored, limits, now)) return stored;
  const session = newSession(stored?.windowId ?? uuidv7(now), now);
  saveSession(session);
  return session;
}

export function anonymousId(): string {
  const existing = readStorage('localStorage', ANONYMOUS_KEY);
  if (existing) return existing;
  const id = uuidv7();
  writeStorage('localStorage', ANONYMOUS_KEY, id);
  return id;
}
