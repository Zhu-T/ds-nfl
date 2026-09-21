'use client';

import { usePathname } from 'next/navigation';

/**
 * Whether betting odds are shaping the projections, where they came from, and
 * a switch. Every page follows the switch: lineup, waivers, and trades.
 */
export function OddsBar({
  enabled,
  available,
  provider,
  error,
  blended,
  players,
  week,
}: {
  enabled: boolean;
  available: boolean;
  provider: string | null;
  error: string | null;
  blended: number;
  players: number;
  week: number;
}) {
  const pathname = usePathname();

  const text = !enabled
    ? "Betting odds are off. Projections are ESPN's alone."
    : error
      ? `Betting lines could not be loaded (${error}). Projections are ESPN's alone for now.`
      : !available
        ? `No betting lines are posted for week ${week} yet. Projections are ESPN's alone.`
        : blended === 0
          ? `${provider ?? 'The sportsbook'} has not posted player prop lines for your players' week ${week} games yet; they usually fill in during the week. Projections are ESPN's alone until then. Team totals come from the game lines.`
          : `Projections for ${blended} of ${players} players blend ESPN with ${provider ?? 'sportsbook'} player prop lines, half each: yards and receptions, rescored under your league's rules. Lines are first calibrated against ESPN, separately for games within 36 hours and later ones, so a player whose props came out first gains nothing from that alone. Team totals come from the game lines.`;

  return (
    <div className="oddsbar">
      <span className="notice__tag">Odds</span>
      <span className="oddsbar__text">{text}</span>
      {/* A plain form, like the week switch: saved, then a full reload. */}
      <form method="post" action="/prefs">
        <input type="hidden" name="back" value={pathname} />
        <button type="submit" name="odds" value={enabled ? 'off' : 'on'} className="btn btn--ghost">
          {enabled ? 'Turn off' : 'Turn on'}
        </button>
      </form>
    </div>
  );
}
