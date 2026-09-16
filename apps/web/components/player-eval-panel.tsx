'use client';

import { Fragment, useEffect, useState, useTransition } from 'react';
import type { PlayerEvaluation } from '@/lib/league-data';
import {
  evaluatePlayerAction,
  playerNewsReadAction,
  playerWebNewsAction,
  type EvaluateResult,
  type NewsReadResult,
  type WebNewsResult,
} from '@/app/waivers/evaluate-actions';
import { matchupLabel } from '@/lib/matchup-label';
import { formLabel } from '@/lib/form-label';

const pts = (n: number) => n.toFixed(1);
/** "RB_WR" reads as "RB/WR". */
const slotLabel = (slot: string) => slot.replace('_', '/');
/** "ESPN, Google News and Ollama web search". */
const listSources = (sources: readonly string[]) =>
  sources.length <= 1 ? (sources[0] ?? '') : `${sources.slice(0, -1).join(', ')} and ${sources.at(-1)}`;
const STATUS_LABEL: Record<string, string> = {
  out: 'Out',
  doubtful: 'Doubtful',
  questionable: 'Questionable',
  active: 'Role change',
};

/**
 * Evaluate any one player: type a name, get what they would add to your best
 * lineup this week, on the same numbers as the waiver ranking below it; then
 * the last week of news on them from the web, and, with AI on, a reading of
 * that news that values them again if it changes their outlook.
 */
export function PlayerEvalPanel({
  leagueKey,
  week,
  aiEnabled,
  providerLabel,
}: {
  leagueKey: string;
  week: number;
  aiEnabled: boolean;
  providerLabel: string;
}) {
  const [query, setQuery] = useState('');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<EvaluateResult | null>(null);
  // The web search and the AI read each follow the step before, so the numbers never wait on them.
  const [searching, startSearch] = useTransition();
  const [web, setWeb] = useState<{ id: string; result: WebNewsResult } | null>(null);
  const [reading, startRead] = useTransition();
  const [read, setRead] = useState<{ id: string; result: NewsReadResult } | null>(null);

  const evaluatedId = result?.ok && result.result.kind === 'evaluated' ? result.result.evaluation.id : null;
  useEffect(() => {
    if (!evaluatedId) return;
    let current = true;
    startSearch(async () => {
      const found = await playerWebNewsAction(leagueKey, week, evaluatedId);
      if (current) startSearch(() => setWeb({ id: evaluatedId, result: found }));
    });
    return () => {
      current = false;
    };
  }, [evaluatedId, leagueKey, week]);

  const webForRead = web && web.result.ok && web.result.news.items.length > 0 && aiEnabled ? web.id : null;
  useEffect(() => {
    if (!webForRead) return;
    let current = true;
    startRead(async () => {
      const answer = await playerNewsReadAction(leagueKey, week, webForRead);
      if (current) startRead(() => setRead({ id: webForRead, result: answer }));
    });
    return () => {
      current = false;
    };
  }, [webForRead, leagueKey, week]);

  const run = (id?: string) =>
    start(async () => {
      const answer = await evaluatePlayerAction(leagueKey, week, query, id);
      start(() => setResult(answer));
    });

  return (
    <section className="webnews" aria-live="polite">
      <div className="webnews__head">
        <div>
          <h3 className="webnews__title">Evaluate a player</h3>
          <p className="field__hint">
            Anyone in the league, rostered or not: what they would add to your best lineup for week{' '}
            {week}, or what one of yours is worth to it, with their matchup, injured teammates, and the
            last week of news on them from the web
            {aiEnabled ? `, which ${providerLabel} reads for anything that changes their outlook` : ''}.
          </p>
        </div>
      </div>

      <form
        className="evaluate__form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <input
          type="search"
          className="field__input"
          placeholder="Player name, e.g. Tyler Shough"
          aria-label="Player to evaluate"
          value={query}
          maxLength={60}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn" disabled={pending || query.trim().length < 2}>
          {pending ? 'Evaluating…' : 'Evaluate'}
        </button>
      </form>

      {result && !result.ok && <p className="ai__error">{result.message}</p>}
      {result?.ok && result.result.kind === 'none' && <p className="field__hint">{result.result.message}</p>}
      {result?.ok && result.result.kind === 'choose' && (
        <div className="evaluate__choices">
          <span className="field__hint">Several players match. Which one?</span>
          {result.result.matches.map((m) => (
            <button key={m.id} type="button" className="chip" disabled={pending} onClick={() => run(m.id)}>
              {m.name} · {m.position}
              {m.proTeam ? `, ${m.proTeam}` : ''} · {m.owner}
            </button>
          ))}
        </div>
      )}
      {result?.ok && result.result.kind === 'evaluated' && (
        <Evaluation
          e={result.result.evaluation}
          web={web?.id === result.result.evaluation.id ? web.result : null}
          searching={searching}
          read={read?.id === result.result.evaluation.id ? read.result : null}
          reading={reading}
          aiEnabled={aiEnabled}
          providerLabel={providerLabel}
        />
      )}
    </section>
  );
}

function verdictFor(e: PlayerEvaluation): string {
  const v = e.value;
  if (v.onRoster) {
    return v.value > 0
      ? `Worth ${pts(v.value)} to your best lineup: starts at ${slotLabel(v.slot ?? '')}${v.replacedBy ? `; without them, ${v.replacedBy} would start` : ''}.`
      : 'On your bench in your best lineup: losing them costs nothing this week.';
  }
  return v.value > 0
    ? `Adds ${pts(v.value)} to your best lineup: would start at ${slotLabel(v.slot ?? '')}${v.displaces ? `, pushing ${v.displaces} out of your lineup` : ''}.`
    : e.injury && !e.value.slot && e.projection === 0
      ? `No gain in week ${e.week}: ${e.injury.toLowerCase()}, so they cannot start.`
      : `No gain in week ${e.week}: your current starters all project higher, so they would sit on your bench.`;
}

function Evaluation({
  e,
  web,
  searching,
  read,
  reading,
  aiEnabled,
  providerLabel,
}: {
  e: PlayerEvaluation;
  web: WebNewsResult | null;
  searching: boolean;
  read: NewsReadResult | null;
  reading: boolean;
  aiEnabled: boolean;
  providerLabel: string;
}) {
  const v = e.value;
  const how =
    e.ownerKind === 'free-agent'
      ? 'Free agent: you can add them now.'
      : e.ownerKind === 'waivers'
        ? 'On waivers: needs a claim, which processes later.'
        : e.ownerKind === 'team'
          ? `On ${e.owner}: only a trade gets them.`
          : null;

  const projection = [
    `ESPN ${pts(e.espnProjection)}`,
    e.market ? `betting lines blended in, ${pts(e.market.blended)}` : null,
    e.matchup && e.matchup.factor !== 1 ? `matchup ×${e.matchup.factor.toFixed(2)}` : null,
    e.form && e.form.factor !== 1 ? `form ×${e.form.factor.toFixed(2)}` : null,
    e.news ? `news check: ${e.news.status}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="webnews__list">
      <div className="webnews__item">
        <div className="webnews__row">
          <span className="webnews__who">{e.name}</span>
          <span className="webnews__status">
            {e.position}
            {e.proTeam ? `, ${e.proTeam}` : ''} · {e.owner}
          </span>
          {v.value > 0 && (
            <span className="delta" style={{ marginLeft: 'auto' }}>
              {v.onRoster ? '' : '+'}
              {pts(v.value)}
            </span>
          )}
        </div>
        <p className="evaluate__verdict">{verdictFor(e)}</p>
        <ul className="evaluate__facts">
          <li>
            Week {e.week}
            {e.isFuture ? ' (next week)' : ''} projection {pts(e.projection)} ({projection})
          </li>
          {e.game && (
            <li>
              {e.game.home ? 'vs' : 'at'} {e.game.opponent}; team expected to score {pts(e.game.impliedPoints)} (spread{' '}
              {e.game.spread > 0 ? `+${e.game.spread}` : e.game.spread})
            </li>
          )}
          {e.matchup && (
            <li>
              {matchupLabel(e.matchup, e.position)}; that defense allows {pts(e.matchup.allowed)} per game, against a
              league average of {pts(e.matchup.average)}
            </li>
          )}
          {e.form && <li>{formLabel(e.form)}, against {pts(e.espnProjection)} projected</li>}
          {e.injury && <li>Status: {e.injury}</li>}
          {e.opening && (
            <li>
              Role may grow: {e.opening}. ESPN&apos;s projection may already include that
              {aiEnabled ? '; the news reading below says whether reports confirm it.' : '.'}
            </li>
          )}
          {e.news && <li>News check: {e.news.summary}</li>}
          <li>
            Your best lineup: {pts(v.withoutPlayer)} without them, {pts(v.withPlayer)} with them
          </li>
          {!v.onRoster && v.value > 0 && v.dropCandidate && <li>Weakest player to drop for them: {v.dropCandidate}</li>}
          {how && <li>{how}</li>}
          {e.ownerKind === 'team' &&
            (e.trade ? (
              <li>
                Trade idea: give {e.trade.give}. Your best lineup gains {pts(e.trade.myGain)}, theirs gains{' '}
                {pts(e.trade.theirGain)}.
              </li>
            ) : (
              <li>No one-for-one trade for them improves both lineups.</li>
            ))}
        </ul>
        <WebNews
          e={e}
          result={web}
          searching={searching}
          read={read}
          reading={reading}
          aiEnabled={aiEnabled}
          providerLabel={providerLabel}
        />
      </div>
    </div>
  );
}

/** The last week of news on the player from the web, and the AI's reading of it. */
function WebNews({
  e,
  result,
  searching,
  read,
  reading,
  aiEnabled,
  providerLabel,
}: {
  e: PlayerEvaluation;
  result: WebNewsResult | null;
  searching: boolean;
  read: NewsReadResult | null;
  reading: boolean;
  aiEnabled: boolean;
  providerLabel: string;
}) {
  return (
    <div className="evaluate__web">
      <div className="evaluate__web-head">On the web, last 7 days</div>
      {!result ? (
        <p className="field__hint">{searching ? 'Searching the web…' : 'The web search did not run.'}</p>
      ) : !result.ok ? (
        <p className="ai__error">{result.message}</p>
      ) : (
        <>
          {result.news.items.length === 0 ? (
            <p className="field__hint">Nothing on them in the last {result.news.days} days.</p>
          ) : (
            <ul className="evaluate__news">
              {result.news.items.map((i, n) => (
                <li key={`${i.url}-${n}`}>
                  <a href={i.url} target="_blank" rel="noreferrer">
                    {i.title}
                  </a>{' '}
                  <span className="evaluate__src">
                    {i.source} · {i.published}
                  </span>
                  {i.text && <p className="evaluate__snippet">{i.text}</p>}
                </li>
              ))}
            </ul>
          )}
          <p className="field__hint">
            Searched {listSources(result.news.sourcesUsed)}.
            {result.news.warnings.map((w) => (
              <Fragment key={w}> {w}</Fragment>
            ))}
          </p>
          {aiEnabled && result.news.items.length > 0 && <NewsRead e={e} read={read} reading={reading} providerLabel={providerLabel} />}
          {!aiEnabled && result.news.items.length > 0 && (
            <p className="field__hint">
              Turn on AI under Connect a league to have these read for anything that changes their outlook.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function NewsRead({
  e,
  read,
  reading,
  providerLabel,
}: {
  e: PlayerEvaluation;
  read: NewsReadResult | null;
  reading: boolean;
  providerLabel: string;
}) {
  if (!read) return <p className="field__hint">{reading ? `${providerLabel} is reading these…` : ''}</p>;
  if (!read.ok) return <p className="ai__error">{read.message}</p>;
  if (!read.finding) {
    return (
      <div className="evaluate__read">
        <p>
          {read.model} read {read.itemsRead} {read.itemsRead === 1 ? 'item' : 'items'} and found nothing that changes their
          outlook for week {e.week}
          {read.rejected.length > 0 ? ` (${read.rejected.length} unverified finding dropped)` : ''}.
        </p>
      </div>
    );
  }
  const f = read.finding;
  const after = read.evaluation;
  return (
    <div className="evaluate__read">
      <p>
        <strong>
          {read.model}: {STATUS_LABEL[f.status] ?? f.status}
          {f.status !== 'out' && f.factor !== 1 ? `, projection ×${f.factor}` : ''}.
        </strong>{' '}
        {f.summary}
      </p>
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
      {after && (
        <p>
          With this news: projection {pts(after.projection)} (was {pts(e.projection)}),{' '}
          {after.value.onRoster ? 'worth' : 'adds'} {pts(after.value.value)} to your best lineup (was {pts(e.value.value)}).
        </p>
      )}
      <p className="field__hint">
        Not saved. Run the news check on the lineup page to apply news to your lineup, waivers, and trades.
      </p>
    </div>
  );
}
