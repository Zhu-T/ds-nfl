import { loadWaivers } from '@/lib/league-data';
import { LoadState } from '@/components/loaded';
import { positionHue } from '@/lib/sample-league';
import { aiStatus } from '@/lib/ai';
import { WaiverPicksPanel } from '@/components/waiver-picks-panel';
import { PlayerEvalPanel } from '@/components/player-eval-panel';
import { matchupLabel } from '@/lib/matchup-label';
import { formLabel } from '@/lib/form-label';
import { openedRoleNote } from '@ds-nfl/core';

export const dynamic = 'force-dynamic';

/** A waiver claim processes later; a free agent can be added immediately. */
function pickupLabel(kind: 'free-agent' | 'waivers' | undefined): string {
  if (kind === 'free-agent') return ' · free agent, add now';
  if (kind === 'waivers') return ' · waiver claim';
  return '';
}

export default async function WaiversPage() {
  const res = await loadWaivers();
  const data = res.state === 'ok' ? res.data : null;
  const helpful = data?.candidates.filter((c) => c.lineupGain > 0) ?? [];
  const ai = aiStatus();
  const picked = new Set((data?.webPicks?.picks ?? []).flatMap((p) => (p.playerId ? [p.playerId] : [])));

  return (
    <LoadState state={res.state} {...(res.state === 'error' ? { message: res.message } : {})}>
      {data && (
        <>
          <section className="section" style={{ marginTop: 0 }}>
            <div className="section__head">
              <h1 className="section__title">Waiver wire</h1>
              <span className="section__meta">
                {data.considered} available players weighed · week {data.week}
                {data.isFuture ? ' (next)' : ''}
              </span>
            </div>

            <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
              Ranked by what each player would add to your <em>starting lineup</em>, not by raw
              projection. A high scorer you would never start is worth nothing. Weighs the
              best-projected available players for the week plus the most-rostered ones.
            </p>

            {res.state === 'ok' && (
              <PlayerEvalPanel
                leagueKey={res.key}
                week={data.week}
                aiEnabled={ai.provider !== 'off'}
                providerLabel={ai.label ?? ''}
              />
            )}

            {res.state === 'ok' && (
              <WaiverPicksPanel
                leagueKey={res.key}
                week={data.week}
                report={data.webPicks}
                gains={data.pickGains}
                pickupById={data.pickupById}
                provider={ai.provider}
                providerLabel={ai.label ?? ''}
              />
            )}

            {data.isFuture && (
              <div className="notice">
                <span className="notice__tag">Next week</span>
                <span>
                  Priced on week {data.week} projections: a player picked up now is on your roster
                  for that game.
                </span>
              </div>
            )}

            {data.lockedOut ? (
              <div className="notice">
                <span className="notice__tag">Locked</span>
                <span>
                  Week {data.week} has kicked off, so no pickup changes this week&apos;s score. The
                  ranking below is value to your lineup going forward, using this week&apos;s
                  projections as the estimate.
                </span>
              </div>
            ) : helpful.length === 0 ? (
              <div className="notice">
                <span className="notice__tag">Clear</span>
                <span>
                  Nobody on the wire improves your lineup. That is a real answer — your starters
                  already beat every available player.
                </span>
              </div>
            ) : null}
          </section>

          <section className="section">
            <div className="slots">
              {(helpful.length > 0 ? helpful : data.candidates.slice(0, 15)).map((c) => (
                <div
                  key={c.player.gsisId}
                  className={`slot${c.lineupGain > 0 ? ' slot--changed' : ''}`}
                  style={{ ['--slot-hue' as string]: positionHue(c.player.position) }}
                >
                  <div className="slot__tag">{c.player.position}</div>
                  <div>
                    <div className="slot__name">{c.player.name}</div>
                    <div className="slot__sub">
                      {c.player.projectedPoints.toFixed(1)} proj
                      {pickupLabel(data.pickupById[c.player.gsisId])}
                      {c.player.matchup ? ` · ${matchupLabel(c.player.matchup, c.player.position)}` : ''}
                      {c.player.form ? ` · ${formLabel(c.player.form)}` : ''}
                      {data.openings[c.player.gsisId]
                        ? ` · role may grow: ${openedRoleNote(data.openings[c.player.gsisId]!, c.player.position)}`
                        : ''}
                      {picked.has(c.player.gsisId) ? ' · web pick' : ''}
                      {c.displaces ? ` · would start over ${c.displaces}` : ''}
                      {c.lineupGain > 0 && c.dropCandidate ? ` · drop ${c.dropCandidate}` : ''}
                    </div>
                  </div>
                  <div className="slot__pts">
                    {c.lineupGain > 0 ? (
                      <span className="delta">+{c.lineupGain.toFixed(1)}</span>
                    ) : (
                      <span className="slot__empty">no gain</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </LoadState>
  );
}
