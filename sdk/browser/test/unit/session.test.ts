import { beforeEach, describe, expect, it } from 'vitest';
import { anonymousId, isExpired, resumeSession, saveSession } from '../../src/session';

const limits = { idleTimeoutMs: 15 * 60_000, maxLengthMs: 60 * 60_000 };

describe('session storage', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('creates a session with seq 0 and keeps it in sessionStorage', () => {
    const session = resumeSession(limits, 1_000_000);
    expect(session.seq).toBe(0);
    expect(session.startedAt).toBe(1_000_000);
    expect(JSON.parse(sessionStorage.getItem('kimmi.session')!)).toEqual(session);
  });

  it('resumes the same session while it is active', () => {
    const session = resumeSession(limits, 1_000_000);
    session.seq = 4;
    session.lastActivity = 1_000_000 + 10 * 60_000;
    saveSession(session);
    expect(resumeSession(limits, 1_000_000 + 20 * 60_000)).toEqual(session);
  });

  it('starts a new session after the idle timeout, keeping the window id', () => {
    const first = resumeSession(limits, 1_000_000);
    const next = resumeSession(limits, 1_000_000 + limits.idleTimeoutMs + 1);
    expect(next.id).not.toBe(first.id);
    expect(next.windowId).toBe(first.windowId);
    expect(next.seq).toBe(0);
  });

  it('starts a new session at the maximum length even when active', () => {
    const first = resumeSession(limits, 1_000_000);
    first.lastActivity = 1_000_000 + limits.maxLengthMs - 1000;
    saveSession(first);
    expect(isExpired(first, limits, 1_000_000 + limits.maxLengthMs)).toBe(true);
    expect(resumeSession(limits, 1_000_000 + limits.maxLengthMs).id).not.toBe(first.id);
  });

  it('keeps one anonymous id in localStorage', () => {
    const id = anonymousId();
    expect(anonymousId()).toBe(id);
    expect(localStorage.getItem('kimmi.anonymousId')).toBe(id);
  });
});
