import Link from 'next/link';
import { loadWaivers } from '@/lib/league-data';
import { LoadState } from '@/components/loaded';
import { positionHue } from '@/lib/sample-league';
import { aiStatus } from '@/lib/ai';
import { WaiverPicksPanel } from '@/components/waiver-picks-panel';
import { Flags } from '@/components/flags';
import { formShort, marketShort, matchupShort } from '@/lib/short-labels';
import { openedRoleNote } from '@ds-nfl/core';
import { TRENDING_MIN, type Trend } from '@/lib/league-data';
import type { CeilingView } from '@/lib/upside';
import { AddPlayerButton, type DropChoice } from '@/components/add-player-button';
import { ProtectedPanel } from '@/components/protected-panel';

export const dynamic = 'force-dynamic';

/** ESPN's rostered +/-, e.g. "+2.2% rostered". */
function trendLabel(t: Trend): string {
  return `${t.change >= 0 ? '+' : ''}${t.change.toFixed(1)}% rostered`;
}

/**
 * A rule of thumb for a FAAB bid, not a fitted model: a few percent of what is
 * left per point the player adds this week, plus a little for the weeks after.
 */
function suggestBid(remaining: number, gain: number, horizonGain: number): number {
  const share = Math.min(0.4, Math.max(0, 0.03 * gain + 0.01 * horizonGain));
  return Math.max(1, Math.round(remaining * share));
}

const pctLabel = (n: number) => `${n < 1 && n > 0 ? '<1' : Math.round(n)}%`;

/** Pickups ranked by how much each raises your chance of winning this week's matchup. */
function CeilingList({
  view,
  pickupById,
  position,
}: {
  view: CeilingView | null;
  pickupById: Readonly<Record<string, 'free-agent' | 'waivers'>>;
  position: string | null;
}) {
  if (!view) {
    return <p className="field__hint">There is no matchup this week to play for, so there is no win chance to raise.</p>;
  }
  const rows = position ? view.rows.filter((r) => r.position === position) : view.rows;
  const behind = view.margin < 0;
  return (
    <>
      <p className="field__hint" style={{ marginBottom: '0.75rem', maxWidth: '46rem' }}>
        {behind ? `Projected to lose by ${(-view.margin).toFixed(1)}` : `Projected to win by ${view.margin.toFixed(1)}`} to{' '}
        {view.opponentName} on the app&apos;s projections for both lineups: about <b>{pctLabel(view.chance)}</b> to win.{' '}
        {rows.length > 0
          ? `The best ${position ? `${position} ` : ''}pickup below raises it to ${pctLabel(rows[0]!.after)}.`
          : `No available ${position ?? 'player'} whose game is still to come raises it.`}
        {!behind && rows.length > 0 ? ' When you are ahead, This week is usually the safer ranking.' : ''}{' '}
        <span
          className="hovernote"
          title="Each player is treated as independent, with the spread typical for their position and projection; the ceiling is the score beaten one week in ten. Games already over count as scored.">
          How this works
        </span>
      </p>
      <div className="slots">
        {rows.slice(0, 25).map((r) => (
          <div key={r.id} className="slot slot--changed" style={{ ['--slot-hue' as string]: positionHue(r.position as never) }}>
            <div className="slot__tag">{r.position}</div>
            <div>
              <div className="slot__name">{r.name}</div>
              <div className="slot__sub">
                ceiling {r.ceiling.toFixed(1)} · {r.projected.toFixed(1)} proj
                {pickupLabel(pickupById[r.id])}
                <Flags items={[r.displaces && { text: `starts over ${r.displaces}`, tone: 'plain' }]} />
              </div>
            </div>
            <div className="slot__pts">
              <span className="delta">
                {pctLabel(r.before)} → {pctLabel(r.after)}
              </span>
              <span className="slot__alt">win chance</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** A waiver claim processes later; a free agent can be added immediately. */
function pickupLabel(kind: 'free-agent' | 'waivers' | undefined): string {
  if (kind === 'free-agent') return ' · free agent';
  if (kind === 'waivers') return ' · waivers';
  return '';
}

/** The positions a waiver list can be narrowed to, in lineup order. */
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;

export default async function WaiversPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string | string[]; pos?: string | string[] }>;
}) {
  const params = await searchParams;
  const sort = params.sort;
  const byWeeks = sort === 'weeks';
  const byTrend = sort === 'trending';
  const byCeiling = sort === 'ceiling';
  const position = POSITIONS.find((p) => p === String(params.pos ?? '').toUpperCase()) ?? null;
  // Links keep whichever of the two choices is not being changed.
  const href = (next: { sort?: string | null; pos?: string | null }) => {
    const query = new URLSearchParams();
    const wanted = next.sort === undefined ? (typeof sort === 'string' ? sort : null) : next.sort;
    const wantedPos = next.pos === undefined ? position : next.pos;
    if (wanted) query.set('sort', wanted);
    if (wantedPos) query.set('pos', wantedPos);
    const q = query.toString();
    return q ? `/waivers?${q}` : '/waivers';
  };
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
  // Players already in a pending claim: the app should not offer them again.
  const claimedIn = new Map((data?.pending ?? []).flatMap((c) => c.adds.map((a) => [a.id, c] as const)));
  const claimedOut = new Set((data?.pending ?? []).flatMap((c) => c.drops.map((d) => d.id)));
  const change = (id: string) => data?.trendById[id]?.change ?? 0;
  // Trending: the players managers across ESPN are adding most, whatever they add to your lineup. Likely streamers.
  const rising = (data?.candidates ?? [])
    .filter((c) => change(c.player.gsisId) >= TRENDING_MIN)
    .sort((a, b) => change(b.player.gsisId) - change(a.player.gsisId));
  // Protected players are left out of the drop list entirely, not just disabled.
  const drops: DropChoice[] = (data?.myRoster ?? [])
    .filter((p) => !p.protected && !claimedOut.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      position: p.position,
      locked: p.locked,
      cost: data?.dropCostById[p.id] ?? 0,
    }))
    .sort((a, b) => a.cost - b.cost);
  const atPosition = <T extends { player: { position: string } }>(rows: readonly T[]) =>
    position ? rows.filter((r) => r.player.position === position) : rows;
  const shown = byTrend
    ? atPosition(rising).slice(0, 25)
    : atPosition(ordered).length > 0
      ? atPosition(ordered).slice(0, 25)
      : atPosition(data?.candidates ?? []).slice(0, 15);
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
              Ranked by what each player adds to your <em>starting lineup</em>, this week or {through}.
              Hover a note for details.
            </p>

            {data.pending.length > 0 && (
              <p className="adjust-note">
                {data.pending.length === 1 ? '1 move is' : `${data.pending.length} moves are`} waiting to settle:{' '}
                {data.pending.map((c) => `${c.adds.map((a) => a.name).join(', ') || 'nobody'} in${c.drops.length > 0 ? `, ${c.drops.map((d) => d.name).join(', ')} out` : ''}`).join('; ')}.{' '}
                <Link href="/pending">See Pending</Link>
              </p>
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
            ) : byTrend || byCeiling ? null : atPosition(worth).length === 0 ? (
              <div className="notice">
                <span className="notice__tag">Clear</span>
                <span>
                  {position ? `No available ${position} improves` : 'Nobody on the wire improves'} your lineup, this week
                  or {through}. That is a real answer — your players already beat every available one
                  {position ? ` at ${position}` : ''}.
                </span>
              </div>
            ) : null}
          </section>

          <section className="section">
            <nav className="sortbar" aria-label="Rank by">
              <span className="field__hint">Rank by</span>
              <Link
                href={href({ sort: null })}
                className={`chip${byWeeks || byTrend || byCeiling ? '' : ' chip--on'}`}
                aria-current={byWeeks || byTrend || byCeiling ? undefined : 'true'}
              >
                This week
              </Link>
              <Link
                href={href({ sort: 'weeks' })}
                className={`chip${byWeeks ? ' chip--on' : ''}`}
                aria-current={byWeeks ? 'true' : undefined}
              >
                {through.charAt(0).toUpperCase() + through.slice(1)}
              </Link>
              <Link
                href={href({ sort: 'trending' })}
                className={`chip${byTrend ? ' chip--on' : ''}`}
                aria-current={byTrend ? 'true' : undefined}
              >
                Trending adds
              </Link>
              <Link
                href={href({ sort: 'ceiling' })}
                className={`chip${byCeiling ? ' chip--on' : ''}`}
                aria-current={byCeiling ? 'true' : undefined}
                title="Pickups ranked by how much they raise your chance of winning this week's matchup"
              >
                High ceiling
              </Link>
            </nav>
            <nav className="sortbar" aria-label="Position">
              <span className="field__hint">Position</span>
              <Link href={href({ pos: null })} className={`chip${position ? '' : ' chip--on'}`} aria-current={position ? undefined : 'true'}>
                All
              </Link>
              {POSITIONS.map((p) => (
                <Link
                  key={p}
                  href={href({ pos: p })}
                  className={`chip${position === p ? ' chip--on' : ''}`}
                  aria-current={position === p ? 'true' : undefined}
                >
                  {p}
                </Link>
              ))}
            </nav>
            {byCeiling && <CeilingList view={data.ceiling} pickupById={data.pickupById} position={position} />}
            {byTrend && (
              <p className="field__hint" style={{ marginBottom: '0.75rem', maxWidth: '46rem' }}>
                The available players managers across ESPN are adding most (ESPN&apos;s rostered +/-):
                likely streamers, often before their projection catches up. Each still shows what
                they would add to your lineup this week.
                {rising.length === 0 ? ' Nobody available is rising by a quarter-point or more right now.' : ''}
              </p>
            )}
            <div className="slots" hidden={byCeiling}>
              {shown.map((c) => {
                const later = reach(c.player.gsisId);
                const primary = byWeeks ? later : c.lineupGain;
                const trend = data.trendById[c.player.gsisId];
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
                        <Flags
                          items={[
                            claimedIn.has(c.player.gsisId) && { text: 'claim pending', tone: 'news' },
                            trend && trend.change >= TRENDING_MIN && !byTrend && { text: trendLabel(trend), tone: 'news' },
                            picked.has(c.player.gsisId) && { text: 'web pick', tone: 'news' },
                            data.openings[c.player.gsisId] && {
                              text: 'role may grow',
                              title: openedRoleNote(data.openings[c.player.gsisId]!, c.player.position),
                              tone: 'news',
                            },
                            marketShort(c.player) && { ...marketShort(c.player)!, tone: 'market' },
                            matchupShort(c.player.matchup, c.player.position) && {
                              ...matchupShort(c.player.matchup, c.player.position)!,
                              tone: 'game',
                            },
                            formShort(c.player.form) && { ...formShort(c.player.form)!, tone: 'market' },
                            c.displaces && { text: `starts over ${c.displaces}`, tone: 'plain' },
                            drop
                              ? { text: `drop ${drop.name}`, title: `Costs your lineups ${drop.total.toFixed(1)} ${through}`, tone: 'plain' }
                              : c.lineupGain > 0 && c.dropCandidate && { text: `drop ${c.dropCandidate}`, tone: 'plain' },
                          ]}
                        />
                      </div>
                      {claimedIn.has(c.player.gsisId) ? (
                        <div className="slot__actions">
                          <span className="field__hint">Already claimed — waiting for the waiver run.</span>
                        </div>
                      ) : data.pickupById[c.player.gsisId] && res.state === 'ok' ? (
                        <div className="slot__actions">
                          <AddPlayerButton
                            leagueKey={res.key}
                            week={data.week}
                            player={{
                              id: c.player.gsisId,
                              name: c.player.name,
                              position: c.player.position,
                              proTeam: data.proTeamById[c.player.gsisId] ?? null,
                              projected: c.player.projectedPoints,
                              gain: c.lineupGain,
                              horizonGain: later,
                              displaces: c.displaces,
                            }}
                            pickup={data.pickupById[c.player.gsisId]!}
                            drops={drops}
                            suggestedDropId={drop?.playerId ?? undefined}
                            faab={data.faab}
                            suggestedBid={
                              data.faab ? suggestBid(data.faab.remaining, c.lineupGain, later) : undefined
                            }
                            horizonLabel={through}
                            spots={data.spots}
                          />
                        </div>
                      ) : null}
                    </div>
                    <div className="slot__pts">
                      {byTrend && trend ? (
                        <span className="delta">{trendLabel(trend)}</span>
                      ) : primary > 0 ? (
                        <span className="delta">+{primary.toFixed(1)}</span>
                      ) : (
                        <span className="slot__empty">no gain</span>
                      )}
                      <span className="slot__alt">
                        {byTrend
                          ? `${c.lineupGain > 0 ? `+${c.lineupGain.toFixed(1)}` : 'no gain'} this week · ${trend ? trend.rostered.toFixed(0) : '?'}% rostered`
                          : byWeeks
                            ? `${c.lineupGain > 0 ? '+' : ''}${c.lineupGain.toFixed(1)} this week`
                            : `+${later.toFixed(1)} ${through}`}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="section">
            <div className="section__head">
              <h2 className="section__title">Look further</h2>
            </div>
            {res.state === 'ok' && data.myRoster.length > 0 && (
              <ProtectedPanel leagueKey={res.key} players={data.myRoster} />
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

          </section>
        </>
      )}
    </LoadState>
  );
}
