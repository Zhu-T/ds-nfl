'use client';

import { usePathname } from 'next/navigation';

/**
 * Whether a player's own scoring this season is shaping the projections, and a
 * switch. Every page follows it: lineup, waivers, trades, and the League AI.
 */
export function FormBar({
  enabled,
  adjusted,
  players,
}: {
  enabled: boolean;
  adjusted: number;
  players: number;
}) {
  const pathname = usePathname();

  const text = !enabled
    ? 'Recent form is off. Projections do not account for what each player has actually scored this season.'
    : adjusted === 0
      ? 'No projection moves on form yet: your players have either not played this season or their betting lines already price them.'
      : `${adjusted} of ${players} projections move toward what the player has actually scored this season, by at most 10%. A player's own games count for little until they have played a few, and for half, since the projection already reflects some of their form. Players with betting lines are left to the market.`;

  return (
    <div className="oddsbar">
      <span className="notice__tag">Form</span>
      <span className="oddsbar__text">{text}</span>
      {/* A plain form, like the week, odds, and matchup switches: saved, then a full reload. */}
      <form method="post" action="/prefs">
        <input type="hidden" name="back" value={pathname} />
        <button type="submit" name="form" value={enabled ? 'off' : 'on'} className="btn btn--ghost">
          {enabled ? 'Turn off' : 'Turn on'}
        </button>
      </form>
    </div>
  );
}
