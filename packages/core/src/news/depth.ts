/**
 * Injured starters: when the player an NFL team leans on at a position will
 * miss the game, the next one up usually gets the work.
 *
 * Who a team leans on is read from how widely each player is rostered across
 * ESPN leagues, and who will miss the game from ESPN's injury report; no model
 * is involved. This is context, not a projection change: ESPN's projection
 * often already reflects the injury, so a number is moved only by the news
 * check, which must cite reporting that says who takes over.
 */

export interface DepthPlayer {
  readonly id: string;
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  /** Percent of ESPN leagues that roster the player. */
  readonly percentOwned?: number | undefined;
  /** ESPN's injury designation as shown, e.g. "Out" or "Questionable". */
  readonly injury?: string | undefined;
}

export interface OpenedRole {
  /** The injured teammate ahead of this player. */
  readonly teammate: string;
  readonly teammateOwned: number;
  readonly status: string;
}

/** Designations that mean the player will very likely miss the game. */
const MISSING = new Set(['Out', 'Injured reserve', 'Suspended', 'Doubtful', 'Not active']);
/** Positions where one player's absence hands work to a teammate. */
const DEPTH_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
/** A teammate this widely rostered is someone the team leans on. */
const LEAD_OWNED = 40;
/** And must be clearly ahead of the player who inherits the role. */
const LEAD_GAP = 10;
/** Healthy teammates below the injured one who are flagged. */
const NEXT_UP = 2;

/** For each healthy player next in line behind an injured lead teammate, that teammate. */
export function openedRoles(players: readonly DepthPlayer[]): Map<string, OpenedRole> {
  const groups = new Map<string, DepthPlayer[]>();
  for (const p of players) {
    if (!p.proTeam || p.proTeam === 'FA' || !DEPTH_POSITIONS.has(p.position)) continue;
    const key = `${p.proTeam}|${p.position}`;
    const group = groups.get(key) ?? [];
    if (!group.some((q) => q.id === p.id)) group.push(p);
    groups.set(key, group);
  }

  const out = new Map<string, OpenedRole>();
  for (const group of groups.values()) {
    const byOwned = [...group].sort((a, b) => (b.percentOwned ?? 0) - (a.percentOwned ?? 0));
    for (const lead of byOwned) {
      const owned = lead.percentOwned ?? 0;
      if (!lead.injury || !MISSING.has(lead.injury) || owned < LEAD_OWNED) continue;
      const nextUp = byOwned
        .filter((p) => p !== lead && (!p.injury || !MISSING.has(p.injury)) && (p.percentOwned ?? 0) <= owned - LEAD_GAP)
        .slice(0, NEXT_UP);
      for (const p of nextUp) {
        if (!out.has(p.id)) out.set(p.id, { teammate: lead.name, teammateOwned: owned, status: lead.injury });
      }
    }
  }
  return out;
}

/** "Bijan Robinson, ahead of them at RB, is out". */
export function openedRoleNote(role: OpenedRole, position: string): string {
  return `${role.teammate}, ahead of them at ${position}, is ${role.status.toLowerCase()}`;
}
