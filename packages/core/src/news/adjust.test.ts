import { describe, it, expect } from 'vitest';
import { applyNewsFindings, boundFactor, type NewsFinding } from './adjust.js';
import { optimizeLineup, type OptimizerPlayer } from '../lineup/optimize.js';
import type { RosterSettings } from '../types.js';

const player = (id: string, position: OptimizerPlayer['position'], projectedPoints: number): OptimizerPlayer => ({
  gsisId: id,
  name: `Player ${id}`,
  position,
  projectedPoints,
  available: true,
});

const finding = (playerId: string, status: NewsFinding['status'], factor: number): NewsFinding => ({
  playerId,
  playerName: `Player ${playerId}`,
  status,
  factor,
  summary: 'Reported on Thursday.',
  sources: [{ url: 'https://example.com/a', title: 'A' }],
});

describe('boundFactor', () => {
  it('keeps each status inside its range', () => {
    expect(boundFactor('out', 0.9)).toBe(0);
    expect(boundFactor('doubtful', 0.8)).toBe(0.5);
    expect(boundFactor('questionable', 0.2)).toBe(0.5);
    expect(boundFactor('questionable', 0.85)).toBe(0.85);
    expect(boundFactor('active', 3)).toBe(1.25);
    expect(boundFactor('active', 0.1)).toBe(0.75);
  });

  it('treats a missing number as the mildest effect for the status', () => {
    expect(boundFactor('questionable', Number.NaN)).toBe(1);
    expect(boundFactor('doubtful', Number.NaN)).toBe(0.5);
  });
});

describe('applyNewsFindings', () => {
  const roster = [player('1', 'WR', 14), player('2', 'WR', 10), player('3', 'RB', 12)];

  it('rules an Out player unavailable at zero, and records what changed', () => {
    const [wr] = applyNewsFindings(roster, [finding('1', 'out', 1)]);
    expect(wr).toMatchObject({ available: false, projectedPoints: 0, unavailableReason: 'Out (news check)' });
    expect(wr!.news).toEqual({ status: 'out', from: 14, factor: 0, summary: 'Reported on Thursday.' });
  });

  it('scales other statuses within their bounds', () => {
    const out = applyNewsFindings(roster, [finding('1', 'questionable', 0.5), finding('3', 'active', 9)]);
    expect(out[0]!.projectedPoints).toBe(7);
    expect(out[2]!.projectedPoints).toBe(15);
  });

  it('leaves players without findings exactly as they were', () => {
    const out = applyNewsFindings(roster, [finding('1', 'out', 0)]);
    expect(out[1]).toBe(roster[1]);
    expect(out[2]).toBe(roster[2]);
  });

  it('changes the lineup the optimizer picks', () => {
    const settings: RosterSettings = { slots: { WR: 1 }, benchSize: 5, irSize: 0 };
    expect(optimizeLineup(roster, settings).starters[0]!.player?.gsisId).toBe('1');
    const adjusted = applyNewsFindings(roster, [finding('1', 'out', 0)]);
    expect(optimizeLineup(adjusted, settings).starters[0]!.player?.gsisId).toBe('2');
  });
});
