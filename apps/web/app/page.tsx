import { slotHue, positionHue, SLOT_LABEL } from '@/lib/sample-league';
import { loadWeek } from '@/lib/week';
import { ApplyButton } from './apply-button';
import { Suspense } from 'react';
import { RosterNews } from '@/components/roster-news';
import { ExplainPanel } from './explain-panel';
import { WebNewsPanel } from '@/components/web-news-panel';
import { AdjustBar } from '@/components/adjust-bar';
import { UpsidePanel } from '@/components/upside-panel';
import { Flags, type Flag } from '@/components/flags';
import { formShort, gameShort, marketShort, matchupShort } from '@/lib/short-labels';
import { openedRoleNote } from '@ds-nfl/core';
import type { GameLine } from '@/lib/week';
import { aiStatus } from '@/lib/ai';
import type { LineupSlot, OptimizerPlayer } from '@ds-nfl/core';

export const dynamic = 'force-dynamic';

/**
 * What the change is worth in matchup terms. Points gained are abstract;
 * "this flips the week" is the thing worth acting on.
 */
function matchupNote(marginNow: number, marginAfter: number, week: number): string {
  const behind = marginNow < 0;
  if (behind && marginAfter > 0) {
    return `Week ${week}: you're behind by ${Math.abs(marginNow).toFixed(
      1,
    )}. These moves put you ahead by ${marginAfter.toFixed(1)}.`;
  }
  if (behind) {
    return `Week ${week}: you're behind by ${Math.abs(marginNow).toFixed(
      1,
    )}. These moves close it to ${Math.abs(marginAfter).toFixed(1)}.`;
  }
  return `Week ${week}: you're ahead by ${marginNow.toFixed(
    1,
  )}. These moves extend it to ${marginAfter.toFixed(1)}.`;
}

function pts(n: number): string {
  return n.toFixed(1);
}

/**
 * How web news changed a player, e.g. "news: questionable, 7.6 → 6.1".
 * Empty for a player ruled out, whose reason already reads "Out (news check)".
 */
function newsLabel(p: OptimizerPlayer): string {
  if (!p.news || p.news.status === 'out') return '';
  return `news: ${p.news.status}, ${pts(p.news.from)} → ${pts(p.projectedPoints)}`;
}

/**
 * A player's notes on a row: news, betting lines, opponent, form, a teammate's
 * injury, the game, and why they cannot play. Short, with the full wording on hover.
 */
function playerFlags(p: OptimizerPlayer, opening: string | undefined, game: GameLine | undefined): (Flag | null)[] {
  const matchup = matchupShort(p.matchup, p.position);
  return [
    newsLabel(p) ? { text: newsLabel(p), tone: 'news' } : null,
    marketShort(p) && { ...marketShort(p)!, tone: 'market' },
    // The opponent is named once: by the D/ST adjustment when there is one, else by the game line.
    matchup ? { ...matchup, tone: 'game' } : gameShort(game) && { ...gameShort(game)!, tone: 'game' },
    formShort(p.form) && { ...formShort(p.form)!, tone: 'market' },
    opening ? { text: 'role may grow', title: opening, tone: 'news' } : null,
    p.unavailableReason ? { text: p.unavailableReason } : null,
  ];
}

export default async function LineupPage() {
  const { league, optimal, diff, current, currentPoints, isSample, error, matchup, allLocked, lockedCount, leagueKey, isFuture, news, odds, matchups, openings, form, lastResult, upside, games } =
    await loadWeek();
  const ai = aiStatus();
  const everyone = [...optimal.starters.flatMap((s) => (s.player ? [s.player] : [])), ...optimal.bench];
  const blendedCount = everyone.filter((p) => p.market).length;
  const newsApplied = everyone.filter((p) => p.news);

  const currentStarterIds = new Set(
    current.filter((a) => a.player).map((a) => a.player!.gsisId),
  );
  const optimalStarterIds = new Set(
    optimal.starters.filter((s) => s.player).map((s) => s.player!.gsisId),
  );

  // Players coming out, still holding the slot they occupy now, so an incoming
  // player can be paired against the one they actually replace.
  const outgoing = current
    .filter((a) => a.player && !optimalStarterIds.has(a.player.gsisId))
    .map((a) => ({ slot: a.slot, player: a.player! }));

  const claimed = new Set<string>();
  function replaces(slot: LineupSlot): OptimizerPlayer | null {
    const match =
      outgoing.find((o) => o.slot === slot && !claimed.has(o.player.gsisId)) ??
      outgoing.find((o) => !claimed.has(o.player.gsisId));
    if (!match) return null;
    claimed.add(match.player.gsisId);
    return match.player;
  }

  return (
    <>
      {error && (
        <div className="notice notice--error">
          <span className="notice__tag notice__tag--error">Error</span>
          <span>
            {error} Showing the sample roster below so the app stays usable — it is not your
            league.
          </span>
        </div>
      )}

      {isSample && !error && (
        <div className="notice">
          <span className="notice__tag">Sample</span>
          <span>
            No league is connected, so this roster is invented. The lineup itself is real
            optimizer output.{' '}
            <a href="/connect" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
              Connect a league
            </a>{' '}
            to replace it.
          </span>
        </div>
      )}

      {!isSample && allLocked && (
        <div className="notice">
          <span className="notice__tag">Locked</span>
          <span>
            Every player&apos;s game has started, so ESPN will not accept lineup changes for week{' '}
            {league.week}. The lineup below is what you are locked into.
          </span>
        </div>
      )}

      {!isSample && !allLocked && lockedCount > 0 && (
        <div className="notice">
          <span className="notice__tag">Locked</span>
          <span>
            {lockedCount} {lockedCount === 1 ? 'player has' : 'players have'} already played and
            cannot be moved. They are held in their current slots below.
          </span>
        </div>
      )}

      {!isSample && isFuture && (
        <div className="notice">
          <span className="notice__tag">Next week</span>
          <span>
            Planning week {league.week}
            {matchup ? ` against ${matchup.opponentName}` : ''}. Nothing is locked yet, and ESPN&apos;s
            projections will keep moving until kickoff.
            {matchup ? ' Their total is the best lineup their roster can field.' : ''}
          </span>
        </div>
      )}

      <section
        className={`verdict${diff.alreadyOptimal ? ' verdict--settled' : ''}`}
        aria-labelledby="verdict-title"
      >
        <div className="verdict__figure">
          {diff.alreadyOptimal ? '✓' : `+${pts(diff.pointsGained)}`}
        </div>
        <div className="verdict__body">
          <h1 className="verdict__title" id="verdict-title">
            {diff.alreadyOptimal
              ? 'Your lineup is already optimal'
              : `${diff.slotsChanged} ${
                  diff.slotsChanged === 1 ? 'change' : 'changes'
                } worth ${pts(diff.pointsGained)} points`}
          </h1>
          <p className="verdict__note">
            {diff.alreadyOptimal
              ? `Nothing to change for week ${league.week}. Projected ${pts(
                  optimal.projectedPoints,
                )}.`
              : matchup
                ? matchupNote(matchup.marginNow, matchup.marginAfter, league.week)
                : `Week ${league.week}: your lineup projects ${pts(
                    currentPoints,
                  )}. These moves take it to ${pts(optimal.projectedPoints)}.`}
          </p>
          <p className="verdict__note verdict__note--sub">
            {pts(currentPoints)} projected now · {pts(optimal.projectedPoints)} after
          </p>
        </div>
        <ApplyButton
          disabled={isSample || diff.alreadyOptimal}
          week={league.week}
          leagueKey={leagueKey}
          {...(isSample
            ? { disabledReason: 'Connect a league first — this is the sample roster.' }
            : diff.alreadyOptimal
              ? { disabledReason: 'Nothing to change.' }
              : {})}
          label={isFuture ? `Apply for week ${league.week}` : 'Apply all changes'}
        />
      </section>

      {!isSample && (
        <ExplainPanel
          enabled={ai.provider !== 'off'}
          providerLabel={ai.label ?? ''}
          leagueKey={leagueKey ?? ''}
          week={league.week}
        />
      )}

      {!isSample && newsApplied.length > 0 && (
        <p className="adjust-note">
          The news check changed {newsApplied.length === 1 ? 'one projection' : `${newsApplied.length} projections`}:{' '}
          {newsApplied.map((p) => p.name).join(', ')}. <a href="#news">Review</a>
        </p>
      )}

      {!isSample && lastResult && (
        <p className="adjust-note">
          Week {lastResult.week} as played: you scored {pts(lastResult.set)} ·{' '}
          {lastResult.recommendedFrom === 'app' ? 'recommended' : "ESPN's best projected"} {pts(lastResult.recommended)} · best
          possible {pts(lastResult.best)}
        </p>
      )}

      {!isSample && (
        <AdjustBar
          odds={{ enabled: odds.enabled, available: odds.available, provider: odds.provider, error: odds.error, blended: blendedCount }}
          matchups={{
            enabled: matchups.enabled,
            available: matchups.available,
            error: matchups.error,
            adjusted: everyone.filter((p) => p.matchup && p.matchup.factor !== 1).length,
          }}
          form={{ enabled: form.enabled, adjusted: everyone.filter((p) => p.form && p.form.factor !== 1).length }}
          players={everyone.length}
          week={league.week}
        />
      )}

      {!isSample && (
        <UpsidePanel enabled={upside.enabled} view={upside.view} leagueKey={leagueKey} week={league.week} disabled={allLocked} />
      )}

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Starting lineup</h2>
          <span className="section__meta">{pts(optimal.projectedPoints)} projected</span>
        </div>

        <div className="slots">
          {optimal.starters.map((s) => {
            const incoming = Boolean(s.player && !currentStarterIds.has(s.player.gsisId));
            const replaced = incoming ? replaces(s.slot) : null;
            const label = SLOT_LABEL[s.slot] ?? s.slot;

            return (
              <div
                key={s.slotIndex}
                className={`slot${incoming ? ' slot--changed' : ''}`}
                style={{ ['--slot-hue' as string]: slotHue(s.slot) }}
              >
                <div className="slot__tag">{label}</div>

                {!s.player ? (
                  <div className="slot__name slot__empty">No eligible player</div>
                ) : incoming ? (
                  <div className="swap">
                    {replaced && (
                      <div className="swap__row swap__out">
                        <span className="swap__mark swap__mark--out">OUT</span>
                        <span className="swap__who">{replaced.name}</span>
                        <span className="swap__pts">
                          {replaced.available
                            ? `${pts(replaced.projectedPoints)} proj`
                            : replaced.unavailableReason}
                        </span>
                      </div>
                    )}
                    <div className="swap__row swap__in">
                      <span className="swap__mark swap__mark--in">IN</span>
                      <span className="swap__who">{s.player.name}</span>
                      <span className="swap__pts">
                        {s.player.position} · {pts(s.player.projectedPoints)} proj
                        <Flags
                          items={playerFlags(
                            s.player,
                            openings[s.player.gsisId] ? openedRoleNote(openings[s.player.gsisId]!, s.player.position) : undefined,
                            games[s.player.gsisId],
                          )}
                        />
                      </span>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="slot__name">{s.player.name}</div>
                    <div className="slot__sub">
                      {s.player.position}
                      <Flags
                        items={playerFlags(
                          s.player,
                          openings[s.player.gsisId] ? openedRoleNote(openings[s.player.gsisId]!, s.player.position) : undefined,
                          games[s.player.gsisId],
                        )}
                      />
                    </div>
                  </div>
                )}

                <div className="slot__pts">
                  {!s.player ? (
                    <span className="slot__empty">—</span>
                  ) : incoming && replaced ? (
                    <span
                      className={`delta${
                        s.player.projectedPoints < replaced.projectedPoints ? ' delta--down' : ''
                      }`}
                    >
                      {s.player.projectedPoints >= replaced.projectedPoints ? '+' : ''}
                      {pts(s.player.projectedPoints - replaced.projectedPoints)}
                    </span>
                  ) : (
                    pts(s.player.projectedPoints)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <hr className="hashrule" style={{ marginTop: '2.25rem' }} />

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Bench</h2>
          <span className="section__meta">{optimal.bench.length} players</span>
        </div>

        <div className="bench">
          {optimal.bench.map((b) => (
            <div
              key={b.gsisId}
              className={`benchcard${b.available ? '' : ' benchcard--out'}`}
              style={{ ['--slot-hue' as string]: positionHue(b.position) }}
            >
              <div>
                <div className="slot__name">{b.name}</div>
                <div className="slot__sub">
                  {b.position}
                  <Flags items={playerFlags(b, openings[b.gsisId] ? openedRoleNote(openings[b.gsisId]!, b.position) : undefined, games[b.gsisId])} />
                </div>
              </div>
              <div className="benchcard__pts">{b.available ? pts(b.projectedPoints) : '—'}</div>
            </div>
          ))}
        </div>
      </section>

      {!isSample && leagueKey && (
        <section className="section" id="news">
          <div className="section__head">
            <h2 className="section__title">News</h2>
            <span className="section__meta">week {league.week}</span>
          </div>
          <WebNewsPanel
            leagueKey={leagueKey}
            week={league.week}
            report={news}
            provider={ai.provider}
            providerLabel={ai.judgmentLabel ?? ''}
          />
          <Suspense fallback={<p className="field__hint" style={{ marginTop: '1.25rem' }}>Loading ESPN player updates…</p>}>
            <RosterNews leagueKey={leagueKey} />
          </Suspense>
        </section>
      )}
    </>
  );
}
