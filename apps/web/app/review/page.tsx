import { LoadState } from '@/components/loaded';
import { ENOUGH_PLAYERS, reviewResults, type AdjustmentVerdict, type WeekOutcome } from '@/lib/accuracy';
import { loadReview } from '@/lib/league-data';

export const dynamic = 'force-dynamic';

const pts = (n: number) => n.toFixed(1);
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`;

/** What an adjustment has earned so far, or that it is too early to say. */
function verdict(a: AdjustmentVerdict): string {
  if (a.players === 0) return 'has not moved a projection yet';
  if (a.players < ENOUGH_PLAYERS) return `${a.players} player-week${a.players === 1 ? '' : 's'} so far — too early to tell`;
  const size = Math.abs(a.better).toFixed(2);
  if (Math.abs(a.better) < 0.05) return `no difference over ${a.players} player-weeks`;
  return a.better > 0
    ? `${size} points closer per player over ${a.players} player-weeks`
    : `${size} points further off per player over ${a.players} player-weeks — worth switching off`;
}

/** "Won 122.3–118.6 vs Dark Knights". The scores are the league's own totals. */
function scoreline(o: WeekOutcome): string {
  const verb = o.outcome === 'won' ? 'Won' : o.outcome === 'lost' ? 'Lost' : 'Tied';
  const against = o.outcome === 'won' ? 'vs' : o.outcome === 'lost' ? 'to' : 'with';
  return `${verb} ${pts(o.myScore)}–${pts(o.opponentScore)} ${against} ${o.opponent}`;
}

/** What a better lineup would have done to a week you did not win. */
function wouldHaveWon(o: WeekOutcome): string {
  if (o.outcome === 'won') return '';
  if (o.recommendedWins) return ` — the recommended lineup would have ${o.outcome === 'lost' ? 'won it' : 'won outright'}`;
  if (o.bestWins) return ' — only a perfect lineup would have won it';
  return ` — nothing on your roster beats ${pts(o.opponentScore)}`;
}

/** Green for a week won, red for one lost, plain for one with no opponent recorded. */
function hueFor(o: WeekOutcome | undefined): string {
  if (!o) return 'var(--border-strong)';
  return o.outcome === 'won' ? 'var(--gain)' : o.outcome === 'lost' ? 'var(--loss)' : 'var(--border-strong)';
}

export default async function ReviewPage() {
  const res = await loadReview();
  const data = res.state === 'ok' ? res.data : null;
  const review = data ? reviewResults(data.weeks) : null;

  return (
    <LoadState state={res.state} {...(res.state === 'error' ? { message: res.message } : {})}>
      {review && (
        <>
          <section className="section" style={{ marginTop: 0 }}>
            <div className="section__head">
              <h1 className="section__title">Results</h1>
              <span className="section__meta">
                {review.weeks.length} {review.weeks.length === 1 ? 'week' : 'weeks'} recorded
              </span>
            </div>

            {review.weeks.length === 0 ? (
              <p className="field__hint" style={{ maxWidth: '46rem' }}>
                Nothing is recorded yet. Each week is graded once it finishes: what your lineup scored,
                what the recommended one would have, and whether each adjustment helped.
              </p>
            ) : (
              <>
                <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
                  Every finished week, scored against what actually happened. Only players the app priced
                  before kickoff count, so nothing here is graded with hindsight.
                </p>

                <div className="slots">
                  {review.weeks.map((w) => (
                    <div key={w.week} className="slot" style={{ ['--slot-hue' as string]: hueFor(w.outcome) }}>
                      <div className="slot__tag">W{w.week}</div>
                      <div>
                        <div className="slot__name">
                          {w.outcome ? scoreline(w.outcome) : `You scored ${pts(w.set)}`}
                        </div>
                        <div className="slot__sub">
                          {w.recommendedFrom === 'app' ? 'recommended' : "ESPN's best projected"} {pts(w.recommended)} · best
                          possible {pts(w.best)}
                          {w.outcome ? wouldHaveWon(w.outcome) : ''}
                          {w.snapshotted ? '' : ' · no pre-game record, ESPN projections only'}
                        </div>
                      </div>
                      <div className="slot__pts">
                        <span className={w.leftOnBench > 0 ? 'delta delta--down' : 'delta'}>{pts(w.leftOnBench)}</span>
                        <span className="slot__alt">left on the bench</span>
                      </div>
                    </div>
                  ))}
                </div>

                <p className="adjust-note">
                  {review.record.won + review.record.lost + review.record.tied > 0 && (
                    <>
                      Record {review.record.won}&ndash;{review.record.lost}
                      {review.record.tied > 0 ? `–${review.record.tied}` : ''}
                      {review.record.lost > 0
                        ? review.record.recommendedWins > 0
                          ? `, and the recommended lineup would have won ${review.record.recommendedWins} more`
                          : review.record.bestWins > 0
                            ? `, and only a perfect lineup would have won ${review.record.bestWins} more`
                            : ', and no lineup you could have set would have won more'
                        : ''}
                      {'. '}
                    </>
                  )}
                  Season so far: you {pts(review.totals.set)} · recommended {pts(review.totals.recommended)} · best possible{' '}
                  {pts(review.totals.best)}
                </p>
              </>
            )}
          </section>

          {review.projections.players > 0 && (
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">Projections</h2>
                <span className="section__meta">{review.projections.players} player-weeks</span>
              </div>
              <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
                Average miss per player: ESPN&apos;s projection {pts(review.projections.espn)} points, the app&apos;s{' '}
                {pts(review.projections.app)}. Each adjustment below is judged on its own, by comparing the projection
                that went out with the same projection without that one factor.
              </p>
              <div className="slots">
                {review.adjustments.map((a) => (
                  <div
                    key={a.key}
                    className="slot"
                    style={{ ['--slot-hue' as string]: a.players >= ENOUGH_PLAYERS && a.better < 0 ? 'var(--loss)' : 'var(--border-strong)' }}
                  >
                    <div className="slot__tag">{a.key === 'market' ? 'ODDS' : a.key === 'matchup' ? 'OPP' : 'FORM'}</div>
                    <div>
                      <div className="slot__name">{a.label}</div>
                      <div className="slot__sub">{verdict(a)}</div>
                    </div>
                    <div className="slot__pts">
                      {a.players >= ENOUGH_PLAYERS ? (
                        <>
                          <span className={a.better >= 0 ? 'delta' : 'delta delta--down'}>{signed(a.better)}</span>
                          <span className="slot__alt">
                            {pts(a.without)} → {pts(a.with)} miss
                          </span>
                        </>
                      ) : (
                        <span className="slot__empty">—</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <p className="adjust-note">
                News findings: {review.news.right} of {review.news.findings} pointed the right way.
                {review.picks.picks > 0
                  ? ` Web picks averaged ${pts(review.picks.picked)} points against ${pts(review.picks.pool)} for everyone available at those positions.`
                  : ' No web pick has played yet.'}
                {review.ceilings.players > 0
                  ? ` Ceilings: ${review.ceilings.beat} of ${review.ceilings.players} players beat theirs (about one in ten is right).`
                  : ''}
              </p>
            </section>
          )}
        </>
      )}
    </LoadState>
  );
}
