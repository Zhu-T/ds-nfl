import { describe, it, expect } from 'vitest';
import { droppedNote, fitToWindow, fitsWindow } from './trim.js';
import type { ContextSection } from './context.js';

const body = (chars: number) => 'x'.repeat(chars);
const sections: ContextSection[] = [
  { title: 'This week', body: body(2_000) },
  { title: 'Your roster', body: body(4_000) },
  { title: 'Waiver wire', body: body(4_000) },
  { title: 'Available players', body: body(8_000) },
  { title: 'Trade ideas', body: body(4_000) },
  { title: 'Recent news', body: body(4_000) },
];
const history = Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, content: `turn ${i} ${body(1_000)}` }));

describe('fitToWindow', () => {
  it('changes nothing when it already fits', () => {
    const fit = fitToWindow({ sections, lead: 'Team: mine.', history, question: 'who do I start?', max: 32_768 });
    expect(fit.dropped).toEqual([]);
    expect(fit.history).toHaveLength(6);
    expect(fit.text).toContain('## Available players');
  });

  it('gives up the oldest turns before any of the brief', () => {
    // Just too small for the whole thing: a couple of turns is all it takes.
    const fit = fitToWindow({ sections, lead: 'Team: mine.', history, question: 'q', max: 13_312 });
    expect(fit.history.length).toBeGreaterThan(0);
    expect(fit.history.length).toBeLessThan(6);
    // The newest turn survives.
    expect(fit.history.at(-1)!.content).toContain('turn 5');
    expect(fit.dropped[0]).toMatch(/oldest message/);
    expect(fit.text).toContain('## Available players');
  });

  it('then drops whole sections, least useful first, and keeps the roster', () => {
    const fit = fitToWindow({ sections, lead: 'Team: mine.', history, question: 'q', max: 8_192 });
    expect(fit.text).not.toContain('## Available players');
    expect(fit.text).toContain('## Your roster');
    expect(fit.text).toContain('## This week');
    expect(fit.dropped).toContain('the list of available players');
  });

  it('counts the question and its rows, which are never dropped', () => {
    const quoted = body(6_000);
    const fit = fitToWindow({
      sections,
      lead: 'Team: mine.',
      history: [],
      question: 'should I trade Adams?',
      fixed: quoted,
      max: 8_192,
    });
    expect(fit.dropped.length).toBeGreaterThan(0);
    expect(fit.text).toContain('## Your roster');
  });
});

describe('droppedNote', () => {
  it('says what went, or nothing at all', () => {
    expect(droppedNote([])).toBe('');
    expect(droppedNote(['the trade ideas'])).toBe("Left out to fit this model's context: the trade ideas.");
    expect(droppedNote(['the oldest messages in this chat', 'the trade ideas'])).toBe(
      "Left out to fit this model's context: the oldest messages in this chat and the trade ideas.",
    );
  });
});

describe('fitsWindow', () => {
  it('measures a prompt against a window, leaving room to answer', () => {
    expect(fitsWindow([body(1_000)], 8_192)).toBe(true);
    expect(fitsWindow([body(100_000)], 8_192)).toBe(false);
  });
});
