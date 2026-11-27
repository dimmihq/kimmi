/** Formatting shared by every page. Times are Unix milliseconds. */

export function duration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function ago(timestamp: number | null | undefined) {
  if (!timestamp) return 'never';
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

export function compact(value: number) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`;
  return String(value);
}

export function bytes(value: number) {
  if (value >= 1e12) return `${(value / 1e12).toFixed(1)} TB`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} KB`;
  return `${value} B`;
}

export function clock(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function day(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** A country code as its flag. */
export const flag = (code: string) =>
  code && code.length === 2
    ? String.fromCodePoint(...[...code.toUpperCase()].map((char) => 0x1f1a5 + char.charCodeAt(0)))
    : '';

/** "2026-11-27" as "27 Nov", in the viewer's locale. */
export const shortDay = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** A part of a whole as "12.3%". */
export const rate = (part: number, whole: number) =>
  `${whole > 0 ? ((part / whole) * 100).toFixed(1) : '0.0'}%`;

/** The change from `previous` to `current` in percent; null when there is nothing to compare with. */
export const change = (current: number, previous: number) =>
  previous > 0 && Number.isFinite(current) ? ((current - previous) / previous) * 100 : null;

/** A change in percent as "+4.2%". */
export const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

const displayNames = (type: 'region' | 'language') => {
  try {
    return new Intl.DisplayNames(undefined, { type });
  } catch {
    return null;
  }
};
const REGIONS = displayNames('region');
const LANGUAGES = displayNames('language');

const named = (names: Intl.DisplayNames | null, code: string) => {
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
};

/** A country code as the country's name: "DE" is "Germany". */
export const countryName = (code: string) => (code ? named(REGIONS, code.toUpperCase()) : 'Unknown');

/** A language tag as the language's name: "pt-BR" is "Brazilian Portuguese". */
export const languageName = (tag: string) => (tag ? named(LANGUAGES, tag) : 'Unknown');

export const PLATFORM_LABEL = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  astro: 'Astro',
  svelte: 'Svelte',
  script: 'Script tag',
} as const;

export const PLATFORM_COLOR = {
  react: '#58c4dc',
  next: '#e5e5e5',
  vue: '#42b883',
  astro: '#ff7a45',
  svelte: '#ff5d33',
  script: '#c8f560',
} as const;
