import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'kimmi.theme';
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

let current: Theme = read();
document.documentElement.dataset.theme = current;

export function setTheme(next: Theme) {
  current = next;
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private windows refuse storage; the theme still applies for this visit.
  }
  for (const listener of listeners) listener();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
