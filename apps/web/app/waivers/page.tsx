import Link from 'next/link';
import { loadWaivers } from '@/lib/league-data';
import { LoadState } from '@/components/loaded';
import { positionHue } from '@/lib/sample-league';
import { aiStatus } from '@/lib/ai';
import { WaiverPicksPanel } from '@/components/waiver-picks-panel';
import { PlayerEvalPanel } from '@/components/player-eval-panel';
import { matchupLabel } from '@/lib/matchup-label';
import { formLabel } from '@/lib/form-label';
import { marketLabel } from '@/lib/market-label';
import { openedRoleNote } from '@ds-nfl/core';

export const dynamic = 'force-dynamic';

/** A waiver claim processes later; a free agent can be added immediately. */
function pickupLabel(kind: 'free-agent' | 'waivers' | undefined): string {
  if (kind === 'free-agent') return ' · free agent, add now';
  if (kind === 'waivers') return ' · waiver claim';
  return '';
}

export default async function WaiversPage({ searchParams }: { searchParams: Promise<{ sort?: string | string[] }> }) {
  const byWeeks = (await searchParams).sort === 'weeks';
  const res = await loadWaivers();
  const data = res.state === 'ok' ? res.data : null;
  const ai = aiStatus();
  const picked = new Set((data?.webPicks?.picks ?? []).flatMap((p) => (p.playerId ? [p.playerId] : [])));
  const reach = (id: string) => data?.horizonById[id]?.total ?? 0;
  // Worth a look: helps this week, or across the coming weeks.
  const worth = (data?.candidates ?? []).filter((c) => c.lineupGain > 0 || reach(c.player.gsisId) > 0);
  const ordered = [...worth].sort((a, b) =>
    byWeeks
      ? reach(b.player.gsisId) - reach(a.player.gsisId) || b.lineupGain - a.lineupGain
      : b.lineupGain - a.lineupGain || reach(b.player.gsisId) - reach(a.player.gsisId),
  );
  const shown = ordered.length > 0 ? ordered.slice(0, 25) : (data?.candidates ?? []).slice(0, 15);
  // A running total from this week on: "through week 5".
  const through = data && data.horizonWeeks.length > 1 ? `through week ${data.horizonWeeks.at(-1)}` : 'this week';

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
              projection: this week alone, or from now {through}, which uses ESPN&apos;s rest-of-season
              projections and bye weeks, so a player who would sit now but helps later still shows.
              Suggested drops are the players your lineups would miss least over those weeks.
            </p>

            {res.state === 'ok' && (
              <PlayerEvalPanel
                leagueKey={res.key}
                week={data.week}
                aiEnabled={ai.provider !== 'off'}
                providerLabel={ai.judgmentLabel ?? ''}
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
                providerLabel={ai.judgmentLabel ?? ''}
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
            ) : worth.length === 0 ? (
              <div className="notice">
                <span className="notice__tag">Clear</span>
                <span>
                  Nobody on the wire improves your lineup, this week or {through}. That is a real
                  answer — your players already beat every available one.
                </span>
              </div>
            ) : null}
          </section>

          <section className="section">
            <nav className="sortbar" aria-label="Rank by">
              <span className="field__hint">Rank by</span>
              <Link href="/waivers" className={`chip${byWeeks ? '' : ' chip--on'}`} aria-current={byWeeks ? undefined : 'true'}>
                This week
              </Link>
              <Link
                href="/waivers?sort=weeks"
                className={`chip${byWeeks ? ' chip--on' : ''}`}
                aria-current={byWeeks ? 'true' : undefined}
              >
                {through.charAt(0).toUpperCase() + through.slice(1)}
              </Link>
            </nav>
            <div className="slots">
              {shown.map((c) => {
                const later = reach(c.player.gsisId);
                const primary = byWeeks ? later : c.lineupGain;
                const drop = data.dropById[c.player.gsisId];
                return (
                  <div
                    key={c.player.gsisId}
                    className={`slot${primary > 0 ? ' slot--changed' : ''}`}
                    style={{ ['--slot-hue' as string]: positionHue(c.player.position) }}
                  >
                    <div className="slot__tag">{c.player.position}</div>
                    <div>
                      <div className="slot__name">{c.player.name}</div>
                      <div className="slot__sub">
                        {c.player.projectedPoints.toFixed(1)} proj
                        {pickupLabel(data.pickupById[c.player.gsisId])}
                        {c.player.market ? ` · ${marketLabel(c.player)}` : ''}
                        {c.player.matchup ? ` · ${matchupLabel(c.player.matchup, c.player.position)}` : ''}
                        {c.player.form ? ` · ${formLabel(c.player.form)}` : ''}
                        {data.openings[c.player.gsisId]
                          ? ` · role may grow: ${openedRoleNote(data.openings[c.player.gsisId]!, c.player.position)}`
                          : ''}
                        {picked.has(c.player.gsisId) ? ' · web pick' : ''}
                        {c.displaces ? ` · would start over ${c.displaces}` : ''}
                        {drop
                          ? ` · drop ${drop.name} (costs ${drop.total.toFixed(1)} ${through})`
                          : c.lineupGain > 0 && c.dropCandidate
                            ? ` · drop ${c.dropCandidate}`
                            : ''}
                      </div>
                    </div>
                    <div className="slot__pts">
                      {primary > 0 ? (
                        <span className="delta">+{primary.toFixed(1)}</span>
                      ) : (
                        <span className="slot__empty">no gain</span>
                      )}
                      <span className="slot__alt">
                        {byWeeks ? `${c.lineupGain > 0 ? '+' : ''}${c.lineupGain.toFixed(1)} this week` : `+${later.toFixed(1)} ${through}`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </LoadState>
  );
}
