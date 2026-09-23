import { LoadState } from '@/components/loaded';
import { loadSeason } from '@/lib/league-data';

export const dynamic = 'force-dynamic';

const pts = (n: number) => n.toFixed(1);

/** "2 RBs and a FLEX" from the slots a week cannot fill. */
function shortLabel(short: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const s of short) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].map(([slot, n]) => `${n} ${slot}${n > 1 ? 's' : ''}`).join(' and ');
}

export default async function SeasonPage() {
  const res = await loadSeason();
  const data = res.state === 'ok' ? res.data : null;

  return (
    <LoadState state={res.state} {...(res.state === 'error' ? { message: res.message } : {})}>
      {data && (
        <>
        {data.odds && (
          <section className="section" style={{ marginTop: 0 }}>
            <div className="section__head">
              <h1 className="section__title">Playoff odds</h1>
              <span className="section__meta">
                top {data.odds.playoffTeams} of {data.odds.rows.length} · through week {data.odds.regularSeasonWeeks}
              </span>
            </div>
            <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
              The rest of the season played out {data.odds.runs.toLocaleString()} times. Each team scores what its best
              lineup projects from here on, with the spread its players carry; nobody&apos;s future lineup or pickups are
              guessed at. The week being played is simulated from scratch, so scores already on the board do
              not count toward it.
            </p>
            <div className="slots">
              {data.odds.rows.map((t) => (
                <div
                  key={t.teamId}
                  className={`slot${t.isMine ? ' slot--changed' : ''}`}
                  style={{ ['--slot-hue' as string]: t.isMine ? 'var(--accent)' : 'var(--border-strong)' }}
                >
                  <div className="slot__tag">{t.wins}-{t.losses}</div>
                  <div>
                    <div className="slot__name">
                      {t.name}
                      {t.isMine ? ' · you' : ''}
                    </div>
                    <div className="slot__sub">
                      {pts(t.averageWins)} wins expected · seed {t.averageSeed.toFixed(1)} · {pts(t.perWeek)} a week
                    </div>
                  </div>
                  <div className="slot__pts">
                    <span className={t.playoffs >= 50 ? 'delta' : 'delta delta--down'}>{Math.round(t.playoffs)}%</span>
                    <span className="slot__alt">playoffs</span>
                  </div>
                </div>
              ))}
            </div>
            {data.odds.swings.length > 0 && (
              <p className="adjust-note">
                Your biggest week: {data.odds.swings[0]!.opponent} in week {data.odds.swings[0]!.week} — winning it puts
                you at {Math.round(data.odds.swings[0]!.ifWin)}%, losing it at {Math.round(data.odds.swings[0]!.ifLose)}%
                ({Math.round(data.odds.swings[0]!.winProbability)}% to win it).
              </p>
            )}
          </section>
        )}

        <section className="section" style={data.odds ? undefined : { marginTop: 0 }}>
          <div className="section__head">
            <h2 className="section__title">Coming weeks</h2>
            <span className="section__meta">
              weeks {data.weeks[0]?.week}–{data.weeks.at(-1)?.week}
            </span>
          </div>
          <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
            Where byes and injuries leave you short of a full lineup, on ESPN&apos;s rest-of-season rates.
            Each hole shows the best available player who does play that week.
          </p>

          <div className="slots">
            {data.weeks.map((w) => (
              <div
                key={w.week}
                className={`slot${w.short.length > 0 ? ' slot--changed' : ''}`}
                style={{ ['--slot-hue' as string]: w.short.length > 0 ? 'var(--loss)' : 'var(--border-strong)' }}
              >
                <div className="slot__tag">W{w.week}</div>
                <div>
                  <div className="slot__name">
                    {w.short.length > 0 ? `Short ${shortLabel(w.short)}` : 'Full lineup'}
                  </div>
                  <div className="slot__sub">
                    {w.missing.length > 0
                      ? `out: ${w.missing.map((m) => `${m.name} (${m.reason})`).join(' · ')}`
                      : 'everyone plays'}
                    {w.covers.map((c) => (
                      <span key={`${c.slot}-${c.name}`} className="flag flag--market">
                        {' · '}
                        {c.slot}: add {c.name} ({c.position}, {pts(c.perGame)}/g,{' '}
                        {c.pickup === 'waivers' ? 'waivers' : 'free agent'})
                      </span>
                    ))}
                  </div>
                </div>
                <div className="slot__pts">
                  {pts(w.projected)}
                  <span className="slot__alt">best lineup</span>
                </div>
              </div>
            ))}
          </div>

          <p className="adjust-note">
            Rates are ESPN&apos;s rest-of-season projections per game, so they are steadier, and lower, than a
            week&apos;s own projection. Players on IR count as unavailable.
          </p>
        </section>
        </>
      )}
    </LoadState>
  );
}
