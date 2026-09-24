import type { MovePlayer } from '@/lib/league-data';

/**
 * Who arrives and who leaves, one player per line, with the other side named.
 *
 * Every pending move reads the same way — a claim, a trade, or one that has
 * already settled — so "in" and "out" never have to be worked out from a
 * sentence.
 */
export function MoveLines({
  adds,
  drops,
  from,
  to,
}: {
  adds: readonly MovePlayer[];
  drops: readonly MovePlayer[];
  /** Where the incoming players come from, e.g. "waivers" or a team name. */
  from: string;
  /** Where the outgoing players go. */
  to: string;
}) {
  const where = (p: MovePlayer) => [p.position, p.proTeam].filter(Boolean).join(' · ');
  return (
    <div className="moves">
      {adds.map((p) => (
        <div key={`in-${p.id}`} className="move move--in">
          <span className="move__mark">IN</span>
          <span className="move__who">{p.name}</span>
          <span className="move__where">{where(p)}</span>
          <span className="move__side">← from {from}</span>
        </div>
      ))}
      {drops.map((p) => (
        <div key={`out-${p.id}`} className="move move--out">
          <span className="move__mark">OUT</span>
          <span className="move__who">{p.name}</span>
          <span className="move__where">{where(p)}</span>
          <span className="move__side">→ to {to}</span>
        </div>
      ))}
      {adds.length === 0 && drops.length === 0 && <div className="move move--none">No players named</div>}
    </div>
  );
}
