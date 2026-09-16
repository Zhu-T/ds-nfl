'use client';

import { Fragment, useState, useTransition } from 'react';
import type { MatchedPick, WebPicksReport } from '@ds-nfl/adapters';
import { checkWaiverPicks, clearWaiverPicks, type PicksResult } from '@/app/waivers/picks-actions';

function ago(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function Sources({ pick }: { pick: MatchedPick }) {
  return (
    <p className="webnews__sources">
      {pick.sources.map((s, i) => (
        <Fragment key={`${s.url}-${i}`}>
          {i > 0 && ' · '}
          <a href={s.url} target="_blank" rel="noreferrer">
            {s.title || s.url}
          </a>
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Who the fantasy press says to add this week, compared with who is actually
 * available in this league, and what each available pick would add to your
 * lineup this week.
 */
export function WaiverPicksPanel({
  leagueKey,
  week,
  report,
  gains,
  pickupById,
  provider,
  providerLabel,
}: {
  leagueKey: string;
  week: number;
  report: WebPicksReport | null;
  gains: Readonly<Record<string, number>>;
  pickupById: Readonly<Record<string, 'free-agent' | 'waivers'>>;
  provider: 'off' | 'claude' | 'ollama';
  providerLabel: string;
}) {
  // Clearing is a quick save and must not look like a new search.
  const [checking, startCheck] = useTransition();
  const [clearing, startClear] = useTransition();
  const [result, setResult] = useState<PicksResult | null>(null);
  const pending = checking || clearing;

  const available = report?.picks.filter((p) => p.status === 'free-agent' || p.status === 'waivers') ?? [];
  const rostered = report?.picks.filter((p) => p.status === 'rostered') ?? [];
  const missing = report?.picks.filter((p) => p.status === 'not-found') ?? [];

  const hint =
    provider === 'claude'
      ? `Claude searches this week's waiver wire articles and lists who they recommend; each pick is then checked against your league.`
      : provider === 'ollama'
        ? `${providerLabel} reads this week's waiver wire headlines (and article text, if an Ollama web search key is saved) and lists who they recommend; each pick is then checked against your league.`
        : 'Finding web picks needs an AI provider. Turn one on under Connect a league.';

  const gainLabel = (p: MatchedPick) => {
    const gain = p.playerId ? gains[p.playerId] : undefined;
    if (gain === undefined) return 'not weighed';
    return gain > 0 ? `+${gain.toFixed(1)} to your lineup in week ${week}` : `no gain to your lineup in week ${week}`;
  };
  const howToAdd = (p: MatchedPick) =>
    (p.playerId && pickupById[p.playerId]) === 'waivers' || p.status === 'waivers' ? 'waiver claim' : 'free agent, add now';

  return (
    <section className="webnews" aria-live="polite" style={{ marginBottom: '1rem' }}>
      <div className="webnews__head">
        <div>
          <h2 className="webnews__title">Waiver picks from the web</h2>
          <p className="field__hint">{hint}</p>
        </div>
        {provider !== 'off' && (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() =>
              startCheck(async () => {
                const answer = await checkWaiverPicks(leagueKey, week);
                // Inside the transition, so the message and the refreshed picks appear together.
                startCheck(() => setResult(answer));
              })
            }
          >
            {checking ? 'Finding picks…' : report ? 'Check again' : 'Find picks on the web'}
          </button>
        )}
      </div>

      {result && <p className={result.ok ? 'webnews__result' : 'ai__error'}>{result.message}</p>}

      {report && (
        <>
          <p className="webnews__meta">
            Checked {ago(report.checkedAt)} ·{' '}
            {report.method === 'gathered'
              ? `${report.model} read ${report.itemsRead} ${report.itemsRead === 1 ? 'item' : 'items'} from ${report.sourcesUsed.join(' and ')}`
              : `${report.model} · ${report.itemsRead} web searches`}{' '}
            · {available.length} available in your league
          </p>

          {available.length === 0 ? (
            <p className="field__hint">None of the recommended players is available in your league.</p>
          ) : (
            <div className="webnews__list">
              {available.map((p) => (
                <div key={`${p.name}-${p.playerId}`} className="webnews__item">
                  <div className="webnews__row">
                    <span className="webnews__who">
                      {p.name}
                      {p.position ? ` (${p.position})` : ''}
                    </span>
                    <span className="webnews__status">{howToAdd(p)}</span>
                    <span className="webnews__gain">{gainLabel(p)}</span>
                  </div>
                  <p className="webnews__summary">{p.reason}</p>
                  <Sources pick={p} />
                </div>
              ))}
            </div>
          )}

          {rostered.length > 0 && (
            <details className="webnews__rejected">
              <summary>
                {rostered.length} recommended {rostered.length === 1 ? 'player is' : 'players are'} already rostered
                in your league
              </summary>
              <ul>
                {rostered.map((p) => (
                  <li key={`${p.name}-${p.playerId}`}>
                    {p.name}: {p.rosteredBy === 'you' ? 'on your team' : `on ${p.rosteredBy}`}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {(missing.length > 0 || report.rejected.length > 0) && (
            <details className="webnews__rejected">
              <summary>
                {missing.length + report.rejected.length} not matched or not verified
              </summary>
              <ul>
                {missing.map((p) => (
                  <li key={`m-${p.name}`}>{p.name}: no player by that name in your league</li>
                ))}
                {report.rejected.map((r, i) => (
                  <li key={`r-${r.player}-${i}`}>
                    {r.player}: {r.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <button
            type="button"
            className="btn btn--ghost"
            disabled={pending}
            onClick={() => {
              setResult(null);
              startClear(() => clearWaiverPicks(leagueKey, week));
            }}
          >
            {clearing ? 'Removing…' : 'Remove these picks'}
          </button>
        </>
      )}
    </section>
  );
}
