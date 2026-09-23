/**
 * The full brief the league assistant works from.
 *
 * One plain-text document per league. It is shown to the user verbatim on the
 * League AI page — so what the model knows is never a mystery — and every chat
 * answer is checked against it by the number guard.
 */

const n = (x: number): string => x.toFixed(1);

export interface ContextRosterPlayer {
  readonly name: string;
  readonly position: string;
  /** The slot on the platform right now: QB, RB, FLEX, BENCH, IR, ... */
  readonly slot: string;
  readonly projected: number;
  readonly proTeam: string | null;
  /** Injury designation and/or "locked". */
  readonly note?: string;
}

export interface ContextWaiver {
  readonly name: string;
  readonly position: string;
  readonly projected: number;
  /** Points added to the best possible lineup. */
  readonly gain: number;
  /** Points added across the coming weeks named by `LeagueContextInput.horizon`. */
  readonly horizonGain?: number;
  readonly pickup?: 'free-agent' | 'waivers';
}

/** A player no one in the league has rostered. */
export interface ContextAvailable {
  readonly name: string;
  readonly position: string;
  readonly proTeam: string | null;
  readonly projected: number;
  readonly pickup: 'free-agent' | 'waivers';
  /** Points added to the best possible lineup; 0 when they would not start. */
  readonly gain: number;
  /** Points added across the coming weeks named by `LeagueContextInput.horizon`. */
  readonly horizonGain?: number;
  /** Injury designation, or that waiver articles recommend them. */
  readonly note?: string;
  /** ESPN's rostered +/-: the change in the percent of ESPN leagues rostering them, in percentage points. */
  readonly rosteredChange?: number;
}

export interface ContextUpside {
  readonly opponent: string;
  /** Your best-projected lineup's total minus theirs. */
  readonly margin: number;
  readonly chance: number;
  readonly picks: readonly { readonly name: string; readonly position: string; readonly ceiling: number; readonly after: number }[];
}

export interface ContextTrade {
  readonly give: string;
  readonly get: string;
  readonly opponent: string;
  readonly myGain: number;
  readonly theirGain: number;
}

export interface ContextNews {
  readonly player: string;
  /** YYYY-MM-DD. */
  readonly published: string;
  readonly headline: string;
  readonly story: string;
}

export interface ContextWebFinding {
  readonly player: string;
  readonly status: string;
  readonly factor: number;
  readonly summary: string;
  readonly sources: readonly string[];
}

export interface LeagueContextInput {
  readonly teamName: string;
  /** The lineup facts brief, from `lineupFacts`. */
  readonly lineupFacts: string;
  readonly roster: readonly ContextRosterPlayer[];
  readonly waivers: readonly ContextWaiver[];
  /** Unrostered players the app loaded; the section is left out when absent. */
  readonly available?: readonly ContextAvailable[];
  /** The coming weeks that `horizonGain` covers, e.g. "weeks 2–5". */
  readonly horizon?: string;
  /** Your chance of winning this week's matchup, in percent, and the pickups that raise it most. */
  readonly upside?: ContextUpside;
  readonly trades: readonly ContextTrade[];
  readonly news: readonly ContextNews[];
  /** Title for the first section, e.g. "Week 2 (next week, not started)". */
  readonly weekLabel?: string;
  /**
   * News findings in effect for the week; null or absent when none were checked.
   * `by` says who checked and how, e.g. "deepseek-r1:14b read the news gathered
   * from ESPN and Google News".
   */
  readonly webNews?: {
    readonly checkedAt: string;
    readonly by: string;
    readonly findings: readonly ContextWebFinding[];
  } | null;
}

export interface ContextSection {
  readonly title: string;
  readonly body: string;
}

export function leagueContext(input: LeagueContextInput): {
  sections: ContextSection[];
  text: string;
} {
  const sections: ContextSection[] = [
    { title: input.weekLabel ?? 'This week', body: input.lineupFacts },
    { title: 'Your roster', body: rosterBody(input.roster) },
    { title: 'Waiver wire', body: waiverBody(input.waivers, input.horizon) + (input.upside ? `\n${upsideBody(input.upside)}` : '') },
    ...(input.available ? [{ title: 'Available players', body: availableBody(input.available, input.horizon) }] : []),
    { title: 'Trade ideas', body: tradeBody(input.trades) },
    { title: 'Recent news', body: newsBody(input.news) },
  ];
  if (input.webNews) sections.push({ title: 'News check', body: webNewsBody(input.webNews) });
  const text = [`Team: ${input.teamName}.`, ...sections.map((s) => `## ${s.title}\n${s.body}`)].join(
    '\n\n',
  );
  return { sections, text };
}

const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'RB_WR', 'WR_TE', 'OP', 'K', 'DST', 'BENCH', 'IR'];
const slotRank = (slot: string): number => {
  const i = SLOT_ORDER.indexOf(slot);
  return i === -1 ? SLOT_ORDER.length : i;
};

function rosterBody(players: readonly ContextRosterPlayer[]): string {
  if (players.length === 0) return 'No players on the roster.';
  return [...players]
    .sort((a, b) => slotRank(a.slot) - slotRank(b.slot))
    .map((p) => {
      const slot = p.slot === 'BENCH' ? 'Bench' : p.slot;
      const team = p.proTeam ? `, ${p.proTeam}` : '';
      const note = p.note ? `; ${p.note}` : '';
      return `- ${slot}: ${p.name} (${p.position}${team}), projected ${n(p.projected)}${note}`;
    })
    .join('\n');
}

/** "adds 0.7" or, with a horizon, "adds 0.7 this week and 2.4 over weeks 2–5". */
function adds(gain: number, later: number | undefined, horizon: string | undefined): string {
  return later !== undefined && horizon ? `adds ${n(gain)} this week and ${n(later)} over ${horizon}` : `adds ${n(gain)}`;
}

function waiverBody(waivers: readonly ContextWaiver[], horizon?: string): string {
  if (waivers.length === 0) return 'No available player improves your best possible lineup.';
  return [
    // Without this the model reads "the lineup is already the best one available"
    // (this week, with started games locked) as "no pickup can help", which is wrong.
    `Available players ranked by how many points they add to your best possible lineup, valued as if no game had kicked off: a pickup pays off in the weeks after it is made, separately from whether this week's lineup can still change.${horizon ? ` Where a second number is given, it is what they add across ${horizon}, from ESPN's rest-of-season projections with bye weeks.` : ''}`,
    ...waivers.map((w) => {
      const how =
        w.pickup === 'waivers'
          ? '; needs a waiver claim'
          : w.pickup === 'free-agent'
            ? '; free agent, can be added now'
            : '';
      return `- ${w.name} (${w.position}): projected ${n(w.projected)}, ${adds(w.gain, w.horizonGain, horizon)}${how}`;
    }),
  ].join('\n');
}

function upsideBody(u: ContextUpside): string {
  const lead = `Playing for the win this week: your best lineup is projected ${u.margin < 0 ? `to lose by ${n(-u.margin)}` : `to win by ${n(u.margin)}`} to ${u.opponent}, about a ${Math.round(u.chance)}% chance to win (each player's spread is the one typical for their position and projection; the ceiling is the score beaten one week in ten).`;
  if (u.picks.length === 0) return `${lead} No available player whose game is still to come raises that chance.`;
  return [
    `${lead} Pickups that raise it most, whose games are still to come:`,
    ...u.picks.map((p) => `- ${p.name} (${p.position}): ceiling ${n(p.ceiling)}, win chance to ${Math.round(p.after)}%`),
  ].join('\n');
}

/** How many available players the brief lists per position: enough to answer "who is out there", short enough for a local model. */
const AVAILABLE_PER_POSITION: Record<string, number> = { QB: 5, RB: 8, WR: 8, TE: 5, K: 3, DST: 3 };
const POSITION_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
/** The most-added players are listed too, however they project: likely streamers. */
const TRENDING_LISTED = 8;
const TRENDING_MIN = 0.25;

function availableBody(players: readonly ContextAvailable[], horizon?: string): string {
  if (players.length === 0) return 'No unrostered players were loaded.';
  const byPosition = new Map<string, ContextAvailable[]>();
  for (const p of players) byPosition.set(p.position, [...(byPosition.get(p.position) ?? []), p]);
  const rank = (pos: string) => {
    const i = POSITION_ORDER.indexOf(pos);
    return i === -1 ? POSITION_ORDER.length : i;
  };
  const rising = (p: ContextAvailable) => (p.rosteredChange ?? 0) >= TRENDING_MIN;
  const trending = new Set(
    players.filter(rising).sort((a, b) => b.rosteredChange! - a.rosteredChange!).slice(0, TRENDING_LISTED),
  );
  const lines = [...byPosition.keys()]
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((pos) => {
      const sorted = [...byPosition.get(pos)!].sort((a, b) => b.projected - a.projected);
      const top = sorted.slice(0, AVAILABLE_PER_POSITION[pos] ?? 3);
      return [...top, ...sorted.filter((p) => trending.has(p) && !top.includes(p))].map((p) => {
        const team = p.proTeam ? `, ${p.proTeam}` : '';
        const how = p.pickup === 'waivers' ? 'needs a waiver claim' : 'free agent, can be added now';
        const trend = rising(p) ? `; trending: rostered in ${n(p.rosteredChange!)}% more ESPN leagues` : '';
        const note = p.note ? `; ${p.note}` : '';
        return `- ${p.name} (${p.position}${team}): projected ${n(p.projected)}, ${adds(p.gain, p.horizonGain, horizon)}; ${how}${trend}${note}`;
      });
    });
  return [
    "The best-projected players no team in the league has rostered, by position, on this week's projections, plus the ones managers across ESPN are adding most (\"trending\"): likely streamers, often before their projection catches up. \"Adds\" is what each would add to your best possible lineup, valued as if no game had kicked off; 0 means they would not start for you.",
    ...lines,
  ].join('\n');
}

function tradeBody(trades: readonly ContextTrade[]): string {
  if (trades.length === 0) return 'No one-for-one trade improves both starting lineups.';
  return [
    "One-for-one trades that improve both teams' best possible lineups, valued on this week's projections as if no game had kicked off:",
    ...trades.map(
      (t) =>
        `- Give ${t.give}, get ${t.get} from ${t.opponent}: your best lineup gains ${n(t.myGain)}, theirs gains ${n(t.theirGain)}.`,
    ),
  ].join('\n');
}

function newsBody(news: readonly ContextNews[]): string {
  if (news.length === 0) return 'No news in the last 7 days for your players.';
  return [
    "From ESPN's fantasy news feed, newest first:",
    ...news.map((x) => `- ${x.player} (${x.published}): ${x.headline}${x.story ? ` ${x.story}` : ''}`),
  ].join('\n');
}

const WEB_STATUS: Record<string, string> = {
  out: 'ruled out',
  doubtful: 'doubtful',
  questionable: 'questionable',
  active: 'role change',
};

function webNewsBody(web: {
  readonly checkedAt: string;
  readonly by: string;
  readonly findings: readonly ContextWebFinding[];
}): string {
  if (web.findings.length === 0) {
    return `${web.by} on ${web.checkedAt}, and found nothing that changes these players' outlook.`;
  }
  return [
    `${web.by} on ${web.checkedAt}. These findings are already applied to the projections above:`,
    ...web.findings.map(
      (f) =>
        `- ${f.player}: ${WEB_STATUS[f.status] ?? f.status}${f.status === 'out' ? '' : `, projection multiplied by ${f.factor}`}. ${f.summary} Sources: ${f.sources.join(', ')}`,
    ),
  ].join('\n');
}
