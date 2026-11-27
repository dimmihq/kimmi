/**
 * The drawing math of a heatmap: where a cell lands on the page, how strong
 * it is, and what colour a strength becomes. Pure: no DOM, no canvas.
 */

export interface Cell {
  /** Percent of the page width, 0 to 99. */
  x: number;
  /** Steps of 10 page pixels from the top. */
  y: number;
  n: number;
}

export type Rgb = readonly [number, number, number];

/** A blob's radius in page pixels. */
export const BLOB_RADIUS = 24;
/** More cells than this are not drawn: the strongest are kept. */
export const MAX_CELLS = 5000;
/** The share of the scale, from the top, that turns warm. */
export const HOT_SHARE = 0.15;
/** The most opaque a blob gets, so the page stays readable under it. */
const PEAK_OPACITY = 0.85;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** The largest count among the cells; 0 when there are none. */
export function maxCount(cells: readonly Cell[]) {
  let max = 0;
  for (const cell of cells) if (cell.n > max) max = cell.n;
  return max;
}

/**
 * How strong a cell is, 0 to 1. A square root, so a page with one very busy
 * button still shows the quieter places.
 */
export function ramp(n: number, max: number) {
  if (!(max > 0) || !(n > 0)) return 0;
  return Math.sqrt(clamp(n / max, 0, 1));
}

/** The middle of a cell in page pixels. */
export function cellCenter(cell: Pick<Cell, 'x' | 'y'>, pageWidth: number) {
  const column = clamp(Math.floor(cell.x), 0, 99);
  const row = Math.max(0, Math.floor(cell.y));
  return { x: ((column + 0.5) / 100) * pageWidth, y: row * 10 + 5 };
}

/** At most `limit` cells, the strongest first. */
export function strongest(cells: readonly Cell[], limit = MAX_CELLS) {
  const real = cells.filter((cell) => cell.n > 0);
  if (real.length <= limit) return real;
  return real.sort((a, b) => b.n - a.n).slice(0, limit);
}

/**
 * The colour of every strength, as 256 RGBA entries. Nothing at 0, the accent
 * growing more opaque above it, and a blend into `warm` over the top
 * `HOT_SHARE` of the scale.
 */
export function palette(accent: Rgb, warm: Rgb) {
  const out = new Uint8ClampedArray(256 * 4);
  const hotFrom = 1 - HOT_SHARE;
  for (let index = 1; index < 256; index++) {
    const strength = index / 255;
    const heat = strength <= hotFrom ? 0 : (strength - hotFrom) / HOT_SHARE;
    for (let channel = 0; channel < 3; channel++) {
      out[index * 4 + channel] = Math.round(accent[channel] + (warm[channel] - accent[channel]) * heat);
    }
    out[index * 4 + 3] = Math.round(255 * PEAK_OPACITY * Math.min(1, strength * 1.5));
  }
  return out;
}

/** Recolours RGBA pixels in place: each pixel's alpha picks its colour from `colours`. */
export function colourise(pixels: Uint8ClampedArray, colours: Uint8ClampedArray) {
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    const from = pixels[offset + 3] * 4;
    pixels[offset] = colours[from];
    pixels[offset + 1] = colours[from + 1];
    pixels[offset + 2] = colours[from + 2];
    pixels[offset + 3] = colours[from + 3];
  }
  return pixels;
}

/** The share of views that reached each tenth of the page, 0 to 1, always ten entries. */
export function reach(scroll: readonly number[], views: number) {
  return Array.from({ length: 10 }, (_, index) =>
    views > 0 ? clamp((scroll[index] ?? 0) / views, 0, 1) : 0,
  );
}

/**
 * How many canvas pixels per CSS pixel a canvas of this size can afford: 1,
 * or less when the page is so long the canvas would be too big to allocate.
 */
export function canvasDensity(width: number, height: number, maxSide = 16_000, maxArea = 8_000_000) {
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.min(1, maxSide / width, maxSide / height, Math.sqrt(maxArea / (width * height)));
}
