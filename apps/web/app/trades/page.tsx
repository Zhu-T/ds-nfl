import { loadTrades } from '@/lib/league-data';
import { LoadState } from '@/components/loaded';
import { aiStatus } from '@/lib/ai';
import { PitchButton } from './pitch-button';

export const dynamic = 'force-dynamic';

export default async function TradesPage() {
  const res = await loadTrades();
  const data = res.state === 'ok' ? res.data : null;
  const key = res.state === 'ok' ? res.key : '';
  const ai = aiStatus();

  return (
    <LoadState state={res.state} {...(res.state === 'error' ? { message: res.message } : {})}>
      {data && (
        <>
          <section className="section" style={{ marginTop: 0 }}>
            <div className="section__head">
              <h1 className="section__title">Trade finder</h1>
              <span className="section__meta">
                week {data.week}
                {data.isFuture ? ' (next)' : ''} · {data.evaluated.toLocaleString()} swaps evaluated
              </span>
            </div>
            <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
              One-for-one trades where <em>both</em> starting lineups improve. A trade the other
              manager loses on is one they will decline, so those are not shown. Valued on this
              week&apos;s projections with kickoff locks ignored, since a trade pays off over the
              weeks that follow.
            </p>

            {data.ideas.length === 0 && (
              <div className="notice">
                <span className="notice__tag">None</span>
                <span>
                  No one-for-one swap helps both sides right now. That usually means rosters are
                  evenly built — multi-player trades are where the value would be.
                </span>
              </div>
            )}
          </section>

          {data.ideas.length > 0 && (
            <section className="section">
              <div className="slots">
                {data.ideas.map((t, i) => (
                  <div
                    key={`${t.give}-${t.get}-${i}`}
                    className="slot slot--changed"
                    style={{ ['--slot-hue' as string]: 'var(--accent)' }}
                  >
                    <div className="slot__tag">SWAP</div>
                    <div className="swap">
                      <div className="swap__row swap__out">
                        <span className="swap__mark swap__mark--out">GIVE</span>
                        <span className="swap__who">
                          {t.giveProtected ? '🔒 ' : ''}
                          {t.give}
                        </span>
                        <span className="swap__pts">{t.giveProjected.toFixed(1)} proj</span>
                      </div>
                      <div className="swap__row swap__in">
                        <span className="swap__mark swap__mark--in">GET</span>
                        <span className="swap__who">{t.get}</span>
                        <span className="swap__pts">
                          {t.getProjected.toFixed(1)} proj · {t.opponentTeam}
                        </span>
                      </div>
                      {t.giveProtected ? (
                        <p className="field__hint">
                          {t.give} is protected, so there is no message to draft. Unprotect them under
                          &ldquo;Protected from drops&rdquo; on the Waivers page to trade them.
                        </p>
                      ) : (
                        ai.provider !== 'off' && (
                        <PitchButton
                          give={t.give}
                          get={t.get}
                          opponent={t.opponentTeam}
                          leagueKey={key}
                          week={data.week}
                          providerLabel={ai.label ?? ''}
                        />
                        )
                      )}
                    </div>
                    <div className="slot__pts">
                      <span className="delta">+{t.myGain.toFixed(1)}</span>
                      <div className="slot__sub">they gain {t.theirGain.toFixed(1)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </LoadState>
  );
}
