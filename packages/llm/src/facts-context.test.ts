import { describe, it, expect } from 'vitest';
import { lineupFacts, type LineupFactsInput } from './facts.js';
import { newsDigestRequest, type ResearchPlayer } from './research.js';

const base: LineupFactsInput = {
  leagueName: 'L',
  format: 'PPR',
  week: 2,
  currentPoints: 100,
  optimizedPoints: 104,
  pointsGained: 4,
  moves: [],
  lockedPlayers: [],
  flagged: [],
  matchup: null,
};

describe('lineupFacts roster', () => {
  it('lists the recommended starters and every bench player, with their notes', () => {
    const text = lineupFacts({
      ...base,
      roster: [
        { name: 'Bo Nix', position: 'QB', slot: 'BENCH', projected: 20.2 },
        { name: 'Matthew Stafford', position: 'QB', slot: 'QB', projected: 20.3, note: 'vs NYG' },
        { name: 'Tyler Allgeier', position: 'RB', slot: 'BENCH', projected: 6.6, note: 'Bijan Robinson, ahead of them at RB, is out' },
      ],
    });
    expect(text).toContain('Recommended starters: QB Matthew Stafford (QB, projected 20.3; vs NYG).');
    expect(text).toContain(
      'Bench: Bo Nix (QB, projected 20.2); Tyler Allgeier (RB, projected 6.6; Bijan Robinson, ahead of them at RB, is out).',
    );
  });

  it('says when the bench is empty, and leaves the roster out when not given', () => {
    expect(lineupFacts({ ...base, roster: [{ name: 'A', position: 'QB', slot: 'QB', projected: 1 }] })).toContain('Bench: empty.');
    expect(lineupFacts(base)).not.toContain('Bench');
  });
});

describe('news check context', () => {
  it("tells the model about an injured lead teammate, and how to treat it", () => {
    const players: ResearchPlayer[] = [
      {
        id: '1',
        name: 'Tyler Allgeier',
        position: 'RB',
        proTeam: 'ATL',
        projected: 6.6,
        role: 'pickup',
        context: 'Bijan Robinson, ahead of them at RB, is out',
      },
      { id: '2', name: 'Bo Nix', position: 'QB', proTeam: 'DEN', projected: 20.2, role: 'rostered' },
    ];
    const { request } = newsDigestRequest({ leagueName: 'L', week: 2, today: '2026-09-15', players, items: [] });
    expect(request.user).toContain(
      'Tyler Allgeier (RB, ATL): a possible waiver pickup, ESPN projects 6.6; Bijan Robinson, ahead of them at RB, is out',
    );
    expect(request.user).toContain('Bo Nix (QB, DEN): on your roster, ESPN projects 20.2');
    expect(request.system).toContain('a teammate ahead of a player is out');
  });
});
