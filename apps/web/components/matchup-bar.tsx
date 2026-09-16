'use client';

import { usePathname } from 'next/navigation';

/**
 * Whether NFL matchups are shaping the projections, how, and a switch. Every
 * page follows the switch: lineup, waivers, trades, and the League AI.
 */
export function MatchupBar({
  enabled,
  available,
  error,
  adjusted,
  players,
  week,
}: {
  enabled: boolean;
  available: boolean;
  error: string | null;
  adjusted: number;
  players: number;
  week: number;
}) {
  const pathname = usePathname();

  const text = !enabled
    ? 'NFL matchups are off. Projections do not account for how many points each opponent allows.'
    : error
      ? `ESPN's matchup data could not be loaded (${error}). Projections go on without it for now.`
      : !available
        ? `ESPN has no matchup data for week ${week} yet. Projections go on without it.`
        : `${adjusted} of ${players} projections move with the opponent: toward how many points it allows to the player's position, by at most 10%. A defense counts for little until it has played a few games, and for half, since ESPN's projections already account for the matchup. Players with betting lines are left to the market.`;

  return (
    <div className="oddsbar">
      <span className="notice__tag">Matchups</span>
      <span className="oddsbar__text">{text}</span>
      {/* A plain form, like the week and odds switches: saved, then a full reload. */}
      <form method="post" action="/prefs">
        <input type="hidden" name="back" value={pathname} />
        <button type="submit" name="matchups" value={enabled ? 'off' : 'on'} className="btn btn--ghost">
          {enabled ? 'Turn off' : 'Turn on'}
        </button>
      </form>
    </div>
  );
}
