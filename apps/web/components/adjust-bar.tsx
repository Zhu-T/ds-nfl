'use client';

import { usePathname } from 'next/navigation';

/**
 * What shapes the projections beyond ESPN's own, in one line: betting odds,
 * opponents (D/STs), and recent form, each a chip that switches it on or off,
 * with the full explanations folded away. Every page follows the switches.
 *
 * The switches are plain forms, like the week switch: saved, then a full
 * reload (see app/prefs/route.ts for why not a server action).
 */

export interface OddsState {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly provider: string | null;
  readonly error: string | null;
  /** Players whose projection blends in prop lines. */
  readonly blended: number;
}

export interface MatchupState {
  readonly enabled: boolean;
  readonly available: boolean;
  readonly error: string | null;
  readonly adjusted: number;
}

export interface FormState {
  readonly enabled: boolean;
  readonly adjusted: number;
}

interface Item {
  readonly name: 'odds' | 'matchups' | 'form';
  readonly label: string;
  readonly enabled: boolean;
  /** Short state on the chip, e.g. "3 of 15" or "off". */
  readonly status: string;
  readonly text: string;
}

export function oddsText(o: OddsState, players: number, week: number): string {
  if (!o.enabled) return "Betting odds are off. Projections are ESPN's alone.";
  if (o.error) return `Betting lines could not be loaded (${o.error}). Projections are ESPN's alone for now.`;
  if (!o.available) return `No betting lines are posted for week ${week} yet. Projections are ESPN's alone.`;
  if (o.blended === 0) {
    return `${o.provider ?? 'The sportsbook'} has not posted player prop lines for your players' week ${week} games yet; they usually fill in during the week. Team totals come from the game lines.`;
  }
  return `Projections for ${o.blended} of ${players} players blend ESPN with ${o.provider ?? 'sportsbook'} player prop lines, half each: yards and receptions, rescored under your league's rules. Lines are first calibrated against ESPN, separately for games within 36 hours and later ones, so a player whose props came out first gains nothing from that alone. Team totals come from the game lines.`;
}

export function matchupText(m: MatchupState, players: number): string {
  if (!m.enabled) return 'Opponent adjustments are off. D/ST projections do not account for how D/STs have done against each offense.';
  if (m.error) return `Opponent data could not be loaded (${m.error}). Projections go on without it for now.`;
  if (!m.available) return 'No finished week yet to measure opponents by. From week 2, D/ST projections move toward how D/STs have scored against each offense.';
  return `${m.adjusted} of ${players} projections move with the opponent. D/STs only: each moves toward how D/STs have scored against that offense, relative to their projections, by at most 20%, counting little until the offense has played a few games. Other positions keep ESPN's projection, which already prices the opponent: in 2024-25 backtests any opponent adjustment made them worse, as did ESPN's opponent ranks.`;
}

export function formText(f: FormState, players: number): string {
  if (!f.enabled) return 'Recent form is off. Projections do not account for what each player has actually scored this season.';
  if (f.adjusted === 0) return 'No projection moves on form yet: your players have either not played this season or their betting lines already price them.';
  return `${f.adjusted} of ${players} projections move toward what the player has actually scored this season, by at most 10%. A player's own games count for little until they have played a few, and for half, since the projection already reflects some of their form. Players with betting lines are left to the market.`;
}

function oddsStatus(o: OddsState, players: number): string {
  if (!o.enabled) return 'off';
  if (o.error) return 'unavailable';
  if (!o.available) return 'no lines yet';
  if (o.blended === 0) return 'no props yet';
  return `${o.blended} of ${players}`;
}

export function AdjustBar({
  odds,
  matchups,
  form,
  players,
  week,
}: {
  odds: OddsState;
  matchups: MatchupState;
  form: FormState;
  players: number;
  week: number;
}) {
  const pathname = usePathname();
  const items: Item[] = [
    { name: 'odds', label: 'Odds', enabled: odds.enabled, status: oddsStatus(odds, players), text: oddsText(odds, players, week) },
    {
      name: 'matchups',
      label: 'Opponents',
      enabled: matchups.enabled,
      status: !matchups.enabled ? 'off' : matchups.error ? 'unavailable' : !matchups.available ? 'no data yet' : `${matchups.adjusted} D/ST`,
      text: matchupText(matchups, players),
    },
    { name: 'form', label: 'Form', enabled: form.enabled, status: form.enabled ? `${form.adjusted} of ${players}` : 'off', text: formText(form, players) },
  ];

  return (
    <div className="adjustbar">
      <span className="adjustbar__lead">Adjusted for</span>
      {items.map((i) => (
        <form key={i.name} method="post" action="/prefs">
          <input type="hidden" name="back" value={pathname} />
          <button
            type="submit"
            name={i.name}
            value={i.enabled ? 'off' : 'on'}
            className={`chip${i.enabled ? ' chip--on' : ''}`}
            title={`${i.text} Click to turn ${i.enabled ? 'off' : 'on'}.`}
            aria-label={`${i.label}: ${i.status}. Turn ${i.enabled ? 'off' : 'on'}.`}
          >
            {i.label} <span className="adjustbar__status">{i.status}</span>
          </button>
        </form>
      ))}
      <details className="adjustbar__how">
        <summary>How these work</summary>
        <dl>
          {items.map((i) => (
            <div key={i.name}>
              <dt>{i.label}</dt>
              <dd>{i.text}</dd>
            </div>
          ))}
        </dl>
        <p>Click a chip to switch it on or off; every page follows.</p>
      </details>
    </div>
  );
}
