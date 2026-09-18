import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WCAG 2.1 AA contrast, measured rather than asserted in a comment.
 *
 * docs/16 § 16.9 commits this product to AA. A palette written in OKLCH looks
 * even, and evenness is not contrast: two steps that feel one apart can sit on
 * either side of 4.5:1, and the pair that fails is usually the one on a
 * coloured badge nobody re-checks after the colours are tuned. So every pair
 * the design system actually puts together is computed here, in both themes.
 *
 * The conversion is done in full rather than delegated to a library. It is
 * thirty lines, it is exact, and it keeps a colour-space dependency out of a
 * product that does not otherwise need one.
 */

const CSS = readFileSync(join(__dirname, 'app', 'globals.css'), 'utf8');

/** OKLCH → linear-light sRGB. Out-of-gamut components are clamped, which is
 * what a display does anyway and what the contrast formula assumes. */
function oklchToLinearSrgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): [number, number, number] {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);

  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** WCAG relative luminance, which is defined on linear-light sRGB. */
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(
  foreground: [number, number, number],
  background: [number, number, number],
): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

type Palette = Record<string, [number, number, number]>;

/** Every `--token: oklch(L C H)` declaration in a slice of the stylesheet. */
function readTokens(block: string): Palette {
  const palette: Palette = {};
  for (const match of block.matchAll(/(--[\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    palette[match[1]] = oklchToLinearSrgb(Number(match[2]), Number(match[3]), Number(match[4]));
  }
  return palette;
}

function slice(startMarker: string, endMarker: string): string {
  const start = CSS.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = CSS.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return CSS.slice(start, end);
}

const light = readTokens(slice('@theme {', '\n}'));
/** Dark inherits the ramps and overrides the tokens that carry a meaning. */
const dark: Palette = { ...light, ...readTokens(slice("[data-theme='dark'] {", '\n}')) };

/**
 * The pairs the design system puts on screen together. Anything a component is
 * allowed to combine belongs in this list; anything not in it is a combination
 * no component should be making.
 */
const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['content', 'surface-base'],
  ['content', 'surface-raised'],
  ['content', 'surface-overlay'],
  ['content', 'surface-sunken'],
  ['content-muted', 'surface-base'],
  ['content-subtle', 'surface-base'],
  ['success-text', 'success-surface'],
  ['warning-text', 'warning-surface'],
  ['danger-text', 'danger-surface'],
  ['info-text', 'info-surface'],
  ['muted-text', 'muted-surface'],
  ['accent-on-surface', 'surface-base'],
  ['accent-text', 'accent'],
  ['accent-text', 'accent-hover'],
];

/**
 * Non-text contrast (WCAG 2.1 success criterion 1.4.11) asks for 3:1, not
 * 4.5:1 — a focus ring and a border are shapes, not prose.
 */
const NON_TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['focus', 'surface-base'],
  ['focus', 'surface-raised'],
  ['border-strong', 'surface-base'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme', (_themeName, palette) => {
  it.each(TEXT_PAIRS)('reaches AA for %s on %s', (foreground, background) => {
    const fg = palette[`--color-${foreground}`];
    const bg = palette[`--color-${background}`];
    expect(fg).toBeDefined();
    expect(bg).toBeDefined();
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT_PAIRS)('reaches 3:1 for %s against %s', (foreground, background) => {
    const fg = palette[`--color-${foreground}`];
    const bg = palette[`--color-${background}`];
    expect(fg).toBeDefined();
    expect(bg).toBeDefined();
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3);
  });
});

describe('the conversion itself', () => {
  // Without these, a bug in the maths above could make every pair "pass".
  it('puts white and black at the ends of the scale', () => {
    expect(luminance(oklchToLinearSrgb(1, 0, 0))).toBeCloseTo(1, 3);
    expect(luminance(oklchToLinearSrgb(0, 0, 0))).toBeCloseTo(0, 3);
  });

  it('gives black on white the maximum ratio of 21:1', () => {
    expect(contrast(oklchToLinearSrgb(0, 0, 0), oklchToLinearSrgb(1, 0, 0))).toBeCloseTo(21, 1);
  });

  it('gives a colour against itself a ratio of 1', () => {
    const grey = oklchToLinearSrgb(0.5, 0, 0);
    expect(contrast(grey, grey)).toBeCloseTo(1, 6);
  });
});
