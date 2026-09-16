/**
 * Contrast guard for the palette.
 *
 * A colour change that looks fine on a card can quietly fail against the page
 * ground behind it — which is exactly what happened to the light-theme QB red
 * during this palette's first pass. This reads the real tokens out of
 * globals.css so the check cannot drift from what actually ships.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');

function block(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  if (start === -1) throw new Error(`theme.test: selector not found: ${selector}`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  const out: Record<string, string> = {};
  for (const line of CSS.slice(open + 1, close).split('\n')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/.exec(line);
    if (m) out[m[1]!] = m[2]!.toLowerCase();
  }
  return out;
}

function luminance(hex: string): number {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function channels(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return [r!, g!, b!];
}

function hue(hex: string): number {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return Math.round(sector * 60 + 360) % 360;
}

/** Shortest distance around the colour wheel, in degrees. */
function hueDistance(a: string, b: string): number {
  const raw = Math.abs(hue(a) - hue(b));
  return Math.min(raw, 360 - raw);
}

function saturation(hex: string): number {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
}

const dark = block(':root {');
// Light only overrides some tokens; the rest inherit from :root.
const light = { ...dark, ...block(":root[data-theme='light']") };

/** Foreground tokens that render as text or as a meaningful coloured mark. */
const FOREGROUNDS = [
  '--text',
  '--text-muted',
  '--text-dim',
  '--accent',
  '--pos-qb',
  '--pos-rb',
  '--pos-wr',
  '--pos-te',
  '--pos-k',
  '--pos-dst',
  '--gain',
  '--loss',
];

/** Both grounds a foreground can land on: card stock and the page behind it. */
const GROUNDS = ['--surface', '--bg'];

describe.each([
  ['dark', dark],
  ['light', light],
])('%s theme contrast', (_name, theme) => {
  it('defines every token the check depends on', () => {
    for (const token of [...FOREGROUNDS, ...GROUNDS]) {
      expect(theme[token], `${token} missing`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it.each(FOREGROUNDS)('%s clears 4.5:1 on both surface and page ground', (fg) => {
    for (const ground of GROUNDS) {
      const ratio = contrast(theme[fg]!, theme[ground]!);
      expect(ratio, `${fg} on ${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps button ink legible on the accent fill', () => {
    expect(contrast(theme['--accent-ink']!, theme['--accent']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('separates the two surface levels from the page ground', () => {
    // If these collapse, cards stop reading as cards.
    expect(theme['--surface']).not.toBe(theme['--bg']);
    expect(theme['--surface-2']).not.toBe(theme['--surface']);
  });

  it('keeps the low-leverage slot colours from reading as the accent', () => {
    // A slot edge tinted near the accent hue at high chroma reads as a FLEX
    // edge, which is what --pos-dst did at #d0a15c (7 degrees off the gold).
    // Muted metals are fine near that hue; saturated ones are not.
    for (const token of ['--pos-k', '--pos-dst']) {
      const confusable =
        hueDistance(theme[token]!, theme['--accent']!) < 20 && saturation(theme[token]!) > 0.4;
      expect(confusable, `${token} (${theme[token]}) reads as the accent`).toBe(false);
    }
  });

  it('gives every scoring position a visually distinct hue', () => {
    const scoring = ['--pos-qb', '--pos-rb', '--pos-wr', '--pos-te'];
    for (let i = 0; i < scoring.length; i++) {
      for (let j = i + 1; j < scoring.length; j++) {
        const d = hueDistance(theme[scoring[i]!]!, theme[scoring[j]!]!);
        expect(d, `${scoring[i]} and ${scoring[j]} are ${d} degrees apart`).toBeGreaterThan(25);
      }
    }
  });
});
