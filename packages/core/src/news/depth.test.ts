import { describe, it, expect } from 'vitest';
import { openedRoleNote, openedRoles, type DepthPlayer } from './depth.js';

const p = (id: string, position: string, proTeam: string | null, percentOwned: number, injury?: string): DepthPlayer => ({
  id,
  name: id,
  position,
  proTeam,
  percentOwned,
  ...(injury ? { injury } : {}),
});

describe('openedRoles', () => {
  it('flags the next players up when the one a team leans on will miss the game', () => {
    const roles = openedRoles([
      p('Bijan Robinson', 'RB', 'ATL', 99, 'Out'),
      p('Tyler Allgeier', 'RB', 'ATL', 35),
      p('Third Back', 'RB', 'ATL', 2),
      p('Fourth Back', 'RB', 'ATL', 1),
      p('Other Team Back', 'RB', 'CAR', 20),
      p('ATL Receiver', 'WR', 'ATL', 30),
    ]);
    expect([...roles.keys()]).toEqual(['Tyler Allgeier', 'Third Back']);
    expect(roles.get('Tyler Allgeier')).toEqual({ teammate: 'Bijan Robinson', teammateOwned: 99, status: 'Out' });
    expect(openedRoleNote(roles.get('Tyler Allgeier')!, 'RB')).toBe('Bijan Robinson, ahead of them at RB, is out');
  });

  it('counts doubtful, IR, and suspended as missing, but not questionable', () => {
    for (const status of ['Doubtful', 'Injured reserve', 'Suspended']) {
      expect(openedRoles([p('Lead', 'WR', 'DET', 90, status), p('Next', 'WR', 'DET', 20)]).has('Next')).toBe(true);
    }
    expect(openedRoles([p('Lead', 'WR', 'DET', 90, 'Questionable'), p('Next', 'WR', 'DET', 20)]).size).toBe(0);
  });

  it('ignores lightly rostered leads, near ties, kickers and defenses, and players with no team', () => {
    expect(openedRoles([p('Lead', 'RB', 'NE', 30, 'Out'), p('Next', 'RB', 'NE', 10)]).size).toBe(0);
    expect(openedRoles([p('Lead', 'RB', 'NE', 60, 'Out'), p('Next', 'RB', 'NE', 55)]).size).toBe(0);
    expect(openedRoles([p('Lead', 'K', 'NE', 90, 'Out'), p('Next', 'K', 'NE', 5)]).size).toBe(0);
    expect(openedRoles([p('Lead', 'RB', null, 90, 'Out'), p('Next', 'RB', null, 5)]).size).toBe(0);
  });

  it('never flags a player who is missing the game too', () => {
    const roles = openedRoles([p('Lead', 'TE', 'KC', 95, 'Out'), p('Also Out', 'TE', 'KC', 30, 'Out'), p('Healthy', 'TE', 'KC', 5)]);
    expect([...roles.keys()]).toEqual(['Healthy']);
  });
});
