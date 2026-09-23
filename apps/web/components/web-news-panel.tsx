'use client';

import { Fragment, useState, useTransition } from 'react';
import { useRefresh } from '@/lib/use-refresh';
import type { NewsReport } from '@ds-nfl/adapters';
import { checkWebNews, clearWebNews, toggleFinding, type NewsCheckResult } from '@/app/news-actions';

const STATUS_LABEL = {
  out: 'Out',
  doubtful: 'Doubtful',
  questionable: 'Questionable',
  active: 'Role change',
} as const;

/** "ESPN, Google News and Ollama web search". */
function listSources(sources: readonly string[]): string {
  return sources.length <= 1 ? (sources[0] ?? '') : `${sources.slice(0, -1).join(', ')} and ${sources.at(-1)}`;
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * News for this week: the check button, and every finding with the sources it
 * came from and a switch to ignore it.
 *
 * Claude searches the web itself. A local model reads news the app gathers
 * from ESPN and Google News, so it needs no API key. Findings from an earlier
 * check stay visible, and can be switched, whichever provider is selected now.
 */
export function WebNewsPanel({
  leagueKey,
  week,
  report,
  provider,
  providerLabel,
}: {
  leagueKey: string;
  week: number;
  report: NewsReport | null;
  provider: 'off' | 'claude' | 'ollama';
  providerLabel: string;
}) {
  // Checking and editing findings are separate: ignoring or removing a finding
  // is a quick save that must not look like a new check.
  const [checking, startCheck] = useTransition();
  const [saving, startSave] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<NewsCheckResult | null>(null);
  const pending = checking || saving;
  const refresh = useRefresh();
  const save = (what: string, action: () => Promise<void>) => {
    setBusy(what);
    startSave(async () => {
      await action();
      setBusy(null);
      refresh();
    });
  };
  const local = provider === 'ollama';

  const limits =
    'A finding can only move a projection within set limits, must cite where it came from, and you can ignore any of them.';
  const hint =
    provider === 'claude'
      ? `Claude searches the web for news on your players and top pickups for week ${week}.`
      : local
        ? `Gathers the last week of news on your players and top pickups (ESPN, Google News, and Ollama web search if a key is saved) for ${providerLabel} to read on this computer.`
        : 'Checking news needs an AI provider. Turn one on under Settings.';

  return (
    <section className="webnews" aria-live="polite">
      <div className="webnews__head">
        <div>
          <h3 className="webnews__title">News check</h3>
          <p className="field__hint">{hint}</p>
          {provider !== 'off' && <p className="webnews__limits">{limits}</p>}
        </div>
        {provider !== 'off' && (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() =>
              startCheck(async () => {
                const answer = await checkWebNews(leagueKey, week);
                // Inside the transition, so the message and the refreshed findings appear together.
                startCheck(() => {
                  setResult(answer);
                  refresh();
                });
              })
            }
          >
            {checking
              ? local
                ? 'Gathering and reading news… (a few minutes)'
                : 'Searching the web…'
              : report
                ? 'Check again'
                : 'Check the news'}
          </button>
        )}
      </div>

      {result && <p className={result.ok ? 'webnews__result' : 'ai__error'}>{result.message}</p>}

      {report && (
        <>
          <p className="webnews__meta">
            {report.method === 'gathered'
              ? `Checked ${ago(report.checkedAt)} · ${report.model} read ${report.itemsRead ?? 0} news ${
                  report.itemsRead === 1 ? 'item' : 'items'
                } from ${listSources(report.sourcesUsed ?? ['ESPN', 'Google News'])}`
              : `Checked ${ago(report.checkedAt)} by ${report.model} · ${report.searches} ${
                  report.searches === 1 ? 'web search' : 'web searches'
                }`}
          </p>

          {report.findings.length === 0 ? (
            <p className="field__hint">Nothing found that changes these players&apos; outlook.</p>
          ) : (
            <div className="webnews__list">
              {report.findings.map((f) => {
                const on = !report.disabled.includes(f.playerId);
                return (
                  <div key={f.playerId} className={`webnews__item${on ? '' : ' webnews__item--off'}`}>
                    <div className="webnews__row">
                      <span className="webnews__who">{f.playerName}</span>
                      <span className={`webnews__status webnews__status--${f.status}`}>
                        {STATUS_LABEL[f.status]}
                        {f.status !== 'out' && f.factor !== 1 ? ` · ×${f.factor}` : ''}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost webnews__toggle"
                        disabled={pending}
                        onClick={() => save(f.playerId, () => toggleFinding(leagueKey, week, f.playerId, !on))}
                      >
                        {busy === f.playerId ? 'Saving…' : on ? 'Ignore' : 'Use'}
                      </button>
                    </div>
                    <p className="webnews__summary">{f.summary}</p>
                    <p className="webnews__sources">
                      {f.sources.map((s, i) => (
                        <Fragment key={`${s.url}-${i}`}>
                          {i > 0 && ' · '}
                          <a href={s.url} target="_blank" rel="noreferrer">
                            {s.title || s.url}
                          </a>
                        </Fragment>
                      ))}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {report.rejected.length > 0 && (
            <details className="webnews__rejected">
              <summary>
                {report.rejected.length} {report.rejected.length === 1 ? 'finding was' : 'findings were'} dropped
                because {report.rejected.length === 1 ? 'it' : 'they'} could not be verified
              </summary>
              <ul>
                {report.rejected.map((r, i) => (
                  <li key={`${r.player}-${i}`}>
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
              save('all', () => clearWebNews(leagueKey, week));
            }}
          >
            {busy === 'all' ? 'Removing…' : 'Remove these findings'}
          </button>
        </>
      )}
    </section>
  );
}
