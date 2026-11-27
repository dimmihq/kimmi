import { describe, expect, it } from 'vitest';
import {
  canvasDensity,
  cellCenter,
  colourise,
  HOT_SHARE,
  MAX_CELLS,
  maxCount,
  palette,
  ramp,
  reach,
  strongest,
} from './heat';

const ACCENT = [10, 200, 30] as const;
const WARM = [250, 40, 20] as const;

describe('maxCount', () => {
  it('is 0 for no cells', () => {
    expect(maxCount([])).toBe(0);
  });

  it('is the one cell’s count', () => {
    expect(maxCount([{ x: 3, y: 4, n: 7 }])).toBe(7);
  });

  it('finds the largest', () => {
    expect(maxCount([{ x: 0, y: 0, n: 2 }, { x: 1, y: 0, n: 9 }, { x: 2, y: 0, n: 4 }])).toBe(9);
  });
});

describe('ramp', () => {
  it('is 0 when there is nothing to compare with', () => {
    expect(ramp(0, 0)).toBe(0);
    expect(ramp(5, 0)).toBe(0);
    expect(ramp(0, 5)).toBe(0);
    expect(ramp(Number.NaN, 5)).toBe(0);
  });

  it('is 1 at the max, and for a single cell', () => {
    expect(ramp(9, 9)).toBe(1);
    expect(ramp(1, 1)).toBe(1);
  });

  it('follows a square root', () => {
    expect(ramp(25, 100)).toBeCloseTo(0.5);
    expect(ramp(1, 100)).toBeCloseTo(0.1);
  });

  it('never passes 1', () => {
    expect(ramp(50, 10)).toBe(1);
  });
});

describe('cellCenter', () => {
  it('puts x in the middle of its percent column', () => {
    expect(cellCenter({ x: 0, y: 0 }, 1000).x).toBe(5);
    expect(cellCenter({ x: 50, y: 0 }, 1000).x).toBe(505);
    expect(cellCenter({ x: 99, y: 0 }, 1000).x).toBe(995);
  });

  it('clamps x to 0..99', () => {
    expect(cellCenter({ x: -4, y: 0 }, 1000).x).toBe(5);
    expect(cellCenter({ x: 100, y: 0 }, 1000).x).toBe(995);
    expect(cellCenter({ x: 250, y: 0 }, 1000).x).toBe(995);
  });

  it('maps y to the middle of its 10 pixel row', () => {
    expect(cellCenter({ x: 0, y: 0 }, 1000).y).toBe(5);
    expect(cellCenter({ x: 0, y: 1 }, 1000).y).toBe(15);
    expect(cellCenter({ x: 0, y: 120 }, 1000).y).toBe(1205);
    expect(cellCenter({ x: 0, y: -3 }, 1000).y).toBe(5);
  });
});

describe('strongest', () => {
  it('is empty for no cells', () => {
    expect(strongest([])).toEqual([]);
  });

  it('drops empty cells and keeps the rest', () => {
    expect(strongest([{ x: 1, y: 1, n: 0 }, { x: 2, y: 2, n: 3 }])).toEqual([{ x: 2, y: 2, n: 3 }]);
  });

  it('keeps the strongest when there are too many', () => {
    const cells = Array.from({ length: MAX_CELLS + 20 }, (_, index) => ({ x: index % 100, y: index, n: index + 1 }));
    const kept = strongest(cells);
    expect(kept).toHaveLength(MAX_CELLS);
    expect(kept[0].n).toBe(MAX_CELLS + 20);
    expect(Math.min(...kept.map((cell) => cell.n))).toBe(21);
  });
});

describe('palette', () => {
  const colours = palette(ACCENT, WARM);
  const at = (index: number) => Array.from(colours.slice(index * 4, index * 4 + 4));

  it('has 256 entries and nothing at 0', () => {
    expect(colours).toHaveLength(1024);
    expect(at(0)).toEqual([0, 0, 0, 0]);
  });

  it('is the accent below the hot share, more opaque as it grows', () => {
    expect(at(40).slice(0, 3)).toEqual([...ACCENT]);
    expect(at(Math.floor(255 * (1 - HOT_SHARE))).slice(0, 3)).toEqual([...ACCENT]);
    expect(at(80)[3]).toBeGreaterThan(at(40)[3]);
  });

  it('is the warm stop at the very top, never fully opaque', () => {
    expect(at(255).slice(0, 3)).toEqual([...WARM]);
    expect(at(255)[3]).toBeLessThan(255);
    expect(at(255)[3]).toBeGreaterThan(at(40)[3]);
  });

  it('blends between the two in the hot share', () => {
    const [red] = at(240);
    expect(red).toBeGreaterThan(ACCENT[0]);
    expect(red).toBeLessThan(WARM[0]);
  });
});

describe('colourise', () => {
  const colours = palette(ACCENT, WARM);

  it('leaves an empty image empty', () => {
    expect(colourise(new Uint8ClampedArray(0), colours)).toHaveLength(0);
  });

  it('picks each pixel’s colour from its alpha', () => {
    const pixels = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 255]);
    colourise(pixels, colours);
    expect(Array.from(pixels.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(pixels.slice(4, 8))).toEqual(Array.from(colours.slice(400, 404)));
    expect(Array.from(pixels.slice(8, 12))).toEqual(Array.from(colours.slice(1020, 1024)));
  });
});

describe('reach', () => {
  it('is ten zeros without views', () => {
    expect(reach([], 0)).toEqual(Array(10).fill(0));
    expect(reach([4, 2], 0)).toEqual(Array(10).fill(0));
  });

  it('is the share of views, capped at 1', () => {
    const shares = reach([10, 5, 20], 10);
    expect(shares).toHaveLength(10);
    expect(shares.slice(0, 4)).toEqual([1, 0.5, 1, 0]);
  });
});

describe('canvasDensity', () => {
  it('is 1 for an ordinary page', () => {
    expect(canvasDensity(900, 3000)).toBe(1);
    expect(canvasDensity(0, 0)).toBe(1);
  });

  it('shrinks a very long page under the limits', () => {
    const density = canvasDensity(1000, 40_000);
    expect(density).toBeLessThan(1);
    expect(1000 * density * 40_000 * density).toBeLessThanOrEqual(8_000_001);
    expect(40_000 * density).toBeLessThanOrEqual(16_000);
  });
});
