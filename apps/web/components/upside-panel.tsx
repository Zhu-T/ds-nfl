import { ApplyButton } from '@/app/apply-button';
import type { UpsideMove, UpsideView } from '@/lib/upside';

const pts = (n: number) => n.toFixed(1);
const pct = (n: number) => `${n < 1 && n > 0 ? '<1' : Math.round(n)}%`;
const who = (m: UpsideMove) => `${m.name} (${m.position}, ${pts(m.projected)} proj, ceiling ${pts(m.ceiling)})`;

/**
 * The upside lineup: the one with the best chance of beating this week's
 * opponent, beside the best-projected lineup the page leads with. Behind a
 * switch that is off by default, so it never becomes the main recommendation.
 */
export function UpsidePanel({
  enabled,
  view,
  leagueKey,
  week,
  disabled,
}: {
  enabled: boolean;
  view: UpsideView | null;
  leagueKey: string | null;
  week: number;
  /** When nothing can be applied (a sample roster). */
  disabled: boolean;
}) {
  return (
    <div className="upside">
      {/* A plain form, like the other switches: saved, then a full reload. */}
      <form method="post" action="/prefs" className="upside__switch">
        <input type="hidden" name="back" value="/" />
        <button
          type="submit"
          name="upside"
          value={enabled ? 'off' : 'on'}
          className={`chip${enabled ? ' chip--on' : ''}`}
          title="The lineup with the best chance of winning this week, which may start boom-or-bust players over steadier ones. Shown beside the main lineup; it never replaces it."
        >
          Upside lineup <span className="adjustbar__status">{enabled ? 'on' : 'off'}</span>
        </button>
      </form>

      {enabled && !view && <p className="upside__note">There is no matchup this week to play for.</p>}

      {enabled && view && !view.worthIt && (
        <p className="upside__note">
          Your best-projected lineup already gives your best chance against {view.opponentName}: {pct(view.bestChance)}.
        </p>
      )}

      {enabled && view && view.worthIt && (
        <div className="upside__box">
          <p>
            {view.margin < 0 ? `Behind by ${pts(-view.margin)}` : `Ahead by ${pts(view.margin)}`} against {view.opponentName}
            {view.opponentBasis === 'best' ? ' (their best lineup)' : ''}: about <b>{pct(view.bestChance)}</b> with the
            best-projected lineup, <b>{pct(view.upsideChance)}</b> with this one.
          </p>
          <ul className="upside__moves">
            {view.startIn.map((m) => (
              <li key={`in-${m.name}`}>
                <span className="swap__mark swap__mark--in">IN</span> {who(m)}
              </li>
            ))}
            {view.sitOut.map((m) => (
              <li key={`out-${m.name}`}>
                <span className="swap__mark swap__mark--out">OUT</span> {who(m)}
              </li>
            ))}
          </ul>
          <ApplyButton
            leagueKey={leagueKey}
            week={week}
            disabled={disabled}
            label="Apply upside lineup"
            mode="upside"
            secondary
          />
          <p className="upside__fine">
            Chances treat each player as independent, with the spread typical for their position and projection (the
            90th percentile is the ceiling); games already over count as scored.
          </p>
        </div>
      )}
    </div>
  );
}
