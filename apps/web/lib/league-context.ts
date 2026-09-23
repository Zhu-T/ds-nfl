/**
 * Builds the per-league brief the League AI page shows and the assistant uses.
 */

import 'server-only';
import {
  AdapterFailure,
  EspnReader,
  activeFindings,
  describeError,
  leagueKey,
  readNewsReport,
  readPlayerList,
  resolveLeague,
  type PlayerList,
} from '@ds-nfl/adapters';
import { leagueContext, lineupFacts, type ContextSection } from '@ds-nfl/llm';
import { loadWeek } from './week';
import { loadTrades, loadWaivers } from './league-data';
import { lineupFactsInput } from './ai-facts';
import { newsForPlayers } from './news';
import { playerListFor } from './player-list';
import { weekChoice } from './week-choice';
import { matchupSentence } from './matchup-label';
import { formSentence } from './form-label';
import { openedRoleNote } from '@ds-nfl/core';

export interface LeagueContextView {
  /** Stable per-league key; conversations are saved under it. */
  readonly key: string;
  /** The week the brief describes. */
  readonly week: number;
  readonly leagueName: string;
  readonly teamName: string;
  readonly sections: readonly ContextSection[];
  readonly text: string;
  /** The league's player list the chat looks players up in; null if it could not be built. */
  readonly playerList: PlayerList | null;
}

export type ContextResult =
  | { state: 'ok'; view: LeagueContextView }
  | { state: 'disconnected' }
  | { state: 'error'; message: string };

/**
 * Rebuilding the brief touches ESPN a dozen times, so reuse it briefly: a
 * chat with several quick follow-ups should not refetch the whole league each
 * turn. Two minutes is short enough that a lineup change shows up promptly.
 */
const TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { at: number; view: LeagueContextView; news: string }>();

/**
 * What the saved web news for a league and week currently says, in brief.
 *
 * A cached brief is only reused while this is unchanged, so checking the web
 * again, or ignoring a finding, shows up in the League AI at once. Comparing
 * against the file rather than clearing the cache from the news actions also
 * holds when those actions run in a different copy of this module, as they can
 * in development.
 */
function newsSignature(key: string, week: number): string {
  const report = readNewsReport(key, week);
  return report ? `${report.checkedAt}|${report.disabled.join(',')}` : '';
}

const STORY_LIMIT = 420;

/** The brief for the named league, or the active one. */
export async function buildLeagueContext(
  requested?: string | null,
  requestedWeek?: number | null,
): Promise<ContextResult> {
  const espn = resolveLeague(requested);
  if (!espn) return { state: 'disconnected' };

  const key = leagueKey(espn);
  // One brief per league and week; the week switch picks which when none is named.
  const cacheKey = `${key}:${requestedWeek ?? (await weekChoice())}`;
  const hit = cache.get(cacheKey);
  if (
    hit &&
    Date.now() - hit.at < TTL_MS &&
    hit.news === newsSignature(key, hit.view.week) &&
    // A refreshed or rebuilt player list shows up at once, as news does.
    hit.view.playerList?.updatedAt === readPlayerList(key, hit.view.week)?.updatedAt
  ) {
    return { state: 'ok', view: hit.view };
  }

  try {
    const reader = new EspnReader({ espnS2: espn.espnS2, swid: espn.swid });
    const ref = { platform: 'espn' as const, leagueId: espn.leagueId, season: espn.season, teamId: espn.teamId };

    const [week, waivers, trades] = await Promise.all([
      loadWeek(key, requestedWeek),
      loadWaivers(key, requestedWeek),
      loadTrades(key, requestedWeek),
    ]);
    if (week.isSample) {
      return { state: 'error', message: week.error ?? 'The league could not be read from ESPN.' };
    }

    const [roster, playerList] = await Promise.all([
      reader.getRoster(ref, week.league.week),
      playerListFor(key, week.league.week, waivers.state === 'ok' ? waivers.data : null),
    ]);
    const news = await newsForPlayers(roster.players);
    // Projections as the optimizer saw them, web news included.
    const adjusted = new Map(
      [...week.optimal.starters.flatMap((s) => (s.player ? [s.player] : [])), ...week.optimal.bench].map((p) => [
        p.gsisId,
        p,
      ]),
    );

    const { sections, text } = leagueContext({
      teamName: trades.state === 'ok' ? trades.data.myTeam : 'your team',
      weekLabel: week.isFuture
        ? `Week ${week.league.week} (next week, not started)`
        : `Week ${week.league.week} (this week)`,
      webNews: week.news
        ? {
            checkedAt: week.news.checkedAt.slice(0, 10),
            by:
              week.news.method === 'gathered'
                ? `${week.news.model} read the news gathered from ESPN and Google News`
                : `${week.news.model} searched the web`,
            findings: activeFindings(week.news).map((f) => ({
              player: f.playerName,
              status: f.status,
              factor: f.factor,
              summary: f.summary,
              sources: f.sources.map((s) => s.url),
            })),
          }
        : null,
      lineupFacts: lineupFacts(lineupFactsInput(week)),
      roster: roster.players.map((p) => {
        const adjustedPlayer = adjusted.get(p.platformPlayerId);
        const note = [
          p.unavailableReason,
          p.locked && !week.isFuture ? 'locked' : undefined,
          adjustedPlayer?.news ? `news check: ${adjustedPlayer.news.status}` : undefined,
          adjustedPlayer?.market ? `betting lines blended in, ESPN alone ${adjustedPlayer.market.espn.toFixed(1)}` : undefined,
          adjustedPlayer?.matchup ? matchupSentence(adjustedPlayer.matchup, p.position) : undefined,
          adjustedPlayer?.form ? formSentence(adjustedPlayer.form) : undefined,
          week.openings[p.platformPlayerId]
            ? `role may grow: ${openedRoleNote(week.openings[p.platformPlayerId]!, p.position)}`
            : undefined,
          week.games[p.platformPlayerId]
            ? `${week.games[p.platformPlayerId]!.home ? 'vs' : 'at'} ${week.games[p.platformPlayerId]!.opponent}, team expected to score ${week.games[p.platformPlayerId]!.impliedPoints.toFixed(1)}`
            : undefined,
        ]
          .filter(Boolean)
          .join(', ');
        return {
          name: p.name,
          position: p.position,
          slot: p.currentSlot,
          projected: adjustedPlayer?.projectedPoints ?? p.projectedPoints,
          proTeam: p.proTeam,
          ...(note ? { note } : {}),
        };
      }),
      waivers:
        waivers.state === 'ok'
          ? [
              ...waivers.data.candidates.filter((c) => c.lineupGain > 0).slice(0, 5),
              // Players who would sit this week but help across the coming weeks.
              ...waivers.data.candidates
                .filter((c) => c.lineupGain <= 0 && (waivers.data.horizonById[c.player.gsisId]?.total ?? 0) > 0)
                .sort(
                  (a, b) =>
                    (waivers.data.horizonById[b.player.gsisId]?.total ?? 0) -
                    (waivers.data.horizonById[a.player.gsisId]?.total ?? 0),
                )
                .slice(0, 3),
            ].map((c) => {
              const pickup = waivers.data.pickupById[c.player.gsisId];
              const later = waivers.data.horizonById[c.player.gsisId];
              return {
                name: c.player.name,
                position: c.player.position,
                projected: c.player.projectedPoints,
                gain: c.lineupGain,
                ...(later ? { horizonGain: later.total } : {}),
                ...(pickup ? { pickup } : {}),
              };
            })
          : [],
      ...(waivers.state === 'ok'
        ? {
            available: waivers.data.available.map((p) => {
              const note = [
                p.injury,
                p.webPick ? 'recommended in waiver articles' : undefined,
                p.opening ? `role may grow: ${p.opening}` : undefined,
              ]
                .filter(Boolean)
                .join(', ');
              return {
                name: p.name,
                position: p.position,
                proTeam: p.proTeam,
                projected: p.projected,
                pickup: p.pickup,
                gain: p.gain,
                ...(p.horizonGain > 0 ? { horizonGain: p.horizonGain } : {}),
                ...(p.rosteredChange !== null ? { rosteredChange: p.rosteredChange } : {}),
                ...(note ? { note } : {}),
              };
            }),
          }
        : {}),
      ...(waivers.state === 'ok' && waivers.data.ceiling
        ? {
            upside: {
              opponent: waivers.data.ceiling.opponentName,
              margin: waivers.data.ceiling.margin,
              chance: waivers.data.ceiling.chance,
              picks: waivers.data.ceiling.rows.slice(0, 3).map((r) => ({ name: r.name, position: r.position, ceiling: r.ceiling, after: r.after })),
            },
          }
        : {}),
      ...(waivers.state === 'ok' && waivers.data.horizonWeeks.length > 1
        ? { horizon: `weeks ${waivers.data.horizonWeeks[0]}–${waivers.data.horizonWeeks.at(-1)}` }
        : {}),
      trades:
        trades.state === 'ok'
          ? trades.data.ideas.slice(0, 5).map((t) => ({
              give: t.give,
              get: t.get,
              opponent: t.opponentTeam,
              myGain: t.myGain,
              theirGain: t.theirGain,
            }))
          : [],
      news: news.items.map((n) => ({
        player: n.player,
        published: n.item.published.slice(0, 10),
        headline: n.item.headline,
        story: n.item.story.length > STORY_LIMIT ? `${n.item.story.slice(0, STORY_LIMIT).trimEnd()}…` : n.item.story,
      })),
    });

    const view: LeagueContextView = {
      key,
      week: week.league.week,
      leagueName: week.league.name,
      teamName: trades.state === 'ok' ? trades.data.myTeam : 'your team',
      sections,
      text,
      playerList,
    };
    cache.set(cacheKey, { at: Date.now(), view, news: newsSignature(key, view.week) });
    return { state: 'ok', view };
  } catch (error) {
    const message =
      error instanceof AdapterFailure
        ? describeError(error.error)
        : error instanceof Error
          ? error.message
          : String(error);
    return { state: 'error', message };
  }
}
