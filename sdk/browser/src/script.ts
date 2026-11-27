import kimmi, { type KimmiApi } from './index';

declare global {
  interface Window {
    kimmi?: KimmiApi;
  }
}

try {
  if (!window.kimmi) {
    window.kimmi = kimmi;
    const script = document.currentScript as HTMLScriptElement | null;
    const key = script?.dataset.key;
    if (script && key) {
      const { host, release } = script.dataset;
      kimmi.init({ key, host: host || new URL(script.src, location.href).origin, ...(release ? { release } : {}) });
    }
  }
} catch {
  // never break the page that included the script
}
