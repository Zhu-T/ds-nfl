/**
 * The facts a model is allowed to talk about.
 *
 * These builders turn engine output into a short plain-text brief. It is the
 * *only* thing the model sees about the league, and the number guard checks
 * the model's text against exactly this string — so anything left out here is
 * something the model cannot mention, by construction.
 */

const n = (x: number): string => x.toFixed(1);
const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;

export interface LineupMoveFact {
  /** The slot being filled, e.g. "WR" or "FLEX". */
  readonly slot: string;
  /** Who currently holds the slot, if anyone. */
  readonly outName: string | null;
  readonly outProjected: number | null;
  /** An injury designation on the outgoing player, e.g. "Out". */
  readonly outNote?: string;
  readonly inName: string;
  readonly inPosition: string;
  readonly inProjected: number;
}

export interface LineupFactsInput {
  readonly leagueName: string;
  readonly format: string;
  readonly week: number;
  readonly currentPoints: number;
  readonly optimizedPoints: number;
  readonly pointsGained: number;
  readonly moves: readonly LineupMoveFact[];
  /** Players whose game has started; the platform will not move them. */
  readonly lockedPlayers: readonly string[];
  /** How many players' projections blend in sportsbook prop lines. */
  readonly marketBlended?: number;
  /** True when the week has not started: nothing is locked, and projections will move. */
  readonly planningAhead?: boolean;
  /** Players whose projection Claude's web findings changed. */
  readonly newsAdjusted?: readonly {
    readonly name: string;
    readonly status: string;
    readonly from: number;
    readonly to: number;
  }[];
  /** Starters who can play but carry a designation such as Questionable. */
  readonly flagged: readonly { readonly name: string; readonly note: string }[];
  /**
   * The recommended starters (by slot) and every bench player ("BENCH"), with
   * projection and notes: injury, matchup, an injured teammate ahead of them.
   */
  readonly roster?: readonly {
    readonly name: string;
    readonly position: string;
    readonly slot: string;
    readonly projected: number;
    readonly note?: string;
  }[];
  readonly matchup: {
    readonly opponent: string;
    readonly opponentProjected: number;
    /** True when the opponent's total is their best possible lineup, not the one they set. */
    readonly opponentBest?: boolean;
    readonly marginNow: number;
    readonly marginAfter: number;
  } | null;
}

export function lineupFacts(input: LineupFactsInput): string {
  const lines = [
    `League: ${input.leagueName} (${input.format}), week ${input.week}.`,
    `The lineup as currently set projects ${n(input.currentPoints)} points. The optimizer's lineup projects ${n(input.optimizedPoints)}, a gain of ${n(input.pointsGained)}.`,
  ];

  if (input.marketBlended && input.marketBlended > 0) {
    lines.push(`Projections for ${input.marketBlended} players blend ESPN with sportsbook player prop lines, half each.`);
  }

  if (input.planningAhead) {
    lines.push(`Planning ahead: week ${input.week} has not started, so no player is locked and projections will keep changing.`);
  }

  if (input.matchup) {
    const m = input.matchup;
    lines.push(
      `Matchup: against ${m.opponent}, who project ${n(m.opponentProjected)}${m.opponentBest ? ' with their best lineup' : ''}. Margin with the current lineup: ${signed(m.marginNow)}. Margin after the changes: ${signed(m.marginAfter)}.`,
    );
  }

  if (input.moves.length === 0) {
    lines.push('Recommended changes: none. The current lineup is already the best one available.');
  } else {
    lines.push('Recommended changes:');
    for (const m of input.moves) {
      const incoming = `start ${m.inName} (${m.inPosition}, projected ${n(m.inProjected)})`;
      if (m.outName !== null && m.outProjected !== null) {
        const note = m.outNote ? `, ${m.outNote}` : '';
        lines.push(
          `- ${m.slot}: ${incoming} in place of ${m.outName} (projected ${n(m.outProjected)}${note}), a difference of ${n(m.inProjected - m.outProjected)}.`,
        );
      } else {
        lines.push(`- ${m.slot}: ${incoming} in a slot that is currently empty.`);
      }
    }
  }

  if (input.lockedPlayers.length > 0) {
    lines.push(
      `Locked because their game has started, so they cannot be moved: ${input.lockedPlayers.join(', ')}.`,
    );
  }
  if (input.flagged.length > 0) {
    lines.push(
      `Starters with an injury designation: ${input.flagged.map((f) => `${f.name} (${f.note})`).join(', ')}.`,
    );
  }
  if (input.roster && input.roster.length > 0) {
    const line = (p: NonNullable<LineupFactsInput['roster']>[number]) =>
      `${p.name} (${p.position}, projected ${n(p.projected)}${p.note ? `; ${p.note}` : ''})`;
    const starting = input.roster.filter((p) => p.slot !== 'BENCH');
    const bench = input.roster.filter((p) => p.slot === 'BENCH');
    if (starting.length > 0) lines.push(`Recommended starters: ${starting.map((p) => `${p.slot} ${line(p)}`).join('; ')}.`);
    lines.push(bench.length > 0 ? `Bench: ${bench.map(line).join('; ')}.` : 'Bench: empty.');
  }
  if (input.newsAdjusted && input.newsAdjusted.length > 0) {
    lines.push(
      `Projections adjusted for web news found by Claude: ${input.newsAdjusted
        .map((a) => `${a.name} (${a.status}, ${n(a.from)} to ${n(a.to)})`)
        .join(', ')}.`,
    );
  }

  return lines.join('\n');
}

export interface TradeFactsInput {
  readonly week: number;
  readonly myTeam: string;
  readonly opponentTeam: string;
  readonly give: string;
  readonly giveProjected: number;
  readonly get: string;
  readonly getProjected: number;
  /** How much the *other* team's best lineup improves. */
  readonly theirGain: number;
}

export interface TradeOfferFactsInput {
  readonly week: number;
  readonly myTeam: string;
  readonly theirTeam: string;
  /** Coming to you, and leaving you, with each player's projection for the week. */
  readonly incoming: readonly { readonly name: string; readonly position: string; readonly projected: number }[];
  readonly outgoing: readonly { readonly name: string; readonly position: string; readonly projected: number }[];
  /** What the trade does to your best lineups: this week, and across `weeks`. */
  readonly myThisWeek: number;
  readonly myTotal: number;
  readonly weeks: string;
  /** What it does to theirs, this week. */
  readonly theirThisWeek: number;
  /** How many of each position you would hold afterwards, where it changes. */
  readonly depth: readonly string[];
}

/**
 * Facts for advice on an offer you have received. Both sides' numbers are
 * given, unlike a pitch: the point here is to judge the deal, not sell it.
 */
export function tradeOfferFacts(input: TradeOfferFactsInput): string {
  const list = (players: TradeOfferFactsInput['incoming']) =>
    players.map((p) => `${p.name} (${p.position}, projected ${n(p.projected)})`).join(', ') || 'nobody';
  return [
    `${input.theirTeam} has offered ${input.myTeam} a trade, valued on week ${input.week} projections.`,
    `${input.myTeam} would receive ${list(input.incoming)}.`,
    `${input.myTeam} would send ${list(input.outgoing)}.`,
    `The best possible starting lineup for ${input.myTeam} changes by ${n(input.myThisWeek)} points in week ${input.week}, and by ${n(input.myTotal)} points across ${input.weeks}.`,
    `The best possible starting lineup for ${input.theirTeam} changes by ${n(input.theirThisWeek)} points in week ${input.week}.`,
    ...input.depth.map((d) => `After the trade, ${input.myTeam} would hold ${d}.`),
    'This offer has not been accepted: the decision belongs to the manager.',
  ].join('\n');
}

/**
 * Facts for a trade pitch.
 *
 * The sender's own gain is deliberately absent. A pitch should sell the other
 * manager on what they get, and the surest way to keep the model from
 * advertising what you get is not to tell it.
 */
export function tradeFacts(input: TradeFactsInput): string {
  const them = input.opponentTeam;
  // Written from the recipient's side, because the message addresses them. When
  // the facts were phrased from the sender's side, a local model had to flip
  // "I send" into "you get" and once reversed the whole trade.
  return [
    `A message from the manager of ${input.myTeam} to the manager of ${them}, proposing a trade valued on week ${input.week} projections.`,
    `${them} would receive ${input.give} (projected ${n(input.giveProjected)}).`,
    `${them} would send ${input.get} (projected ${n(input.getProjected)}) to ${input.myTeam}.`,
    `With ${input.give}, the best possible starting lineup for ${them} improves by ${n(input.theirGain)} points.`,
    // Stated as a fact, not only as an instruction: the same model also wrote the
    // pitch as confirmation of a deal that was never made.
    `This is a first offer: it has not been discussed, and ${them} has not agreed to anything.`,
  ].join('\n');
}

/**
 * The terms of a trade offer, stated by the app rather than the model.
 *
 * A local model reversed the trade in two of six live drafts even with the facts
 * written from the recipient's side. Who sends which player is the one part of a
 * pitch that must never be wrong, so it is never model-generated: the model only
 * writes the sentence about *why*, and is not allowed to name the players.
 */
export function tradeTerms(input: TradeFactsInput): string {
  return `Trade offer: you'd get ${input.give} (projected ${n(input.giveProjected)}) for ${input.get} (projected ${n(input.getProjected)}).`;
}

/** The message as sent: the app's exact terms, then the model's reason, if any. */
export function composePitch(terms: string, reason: string | null): string {
  return reason ? `${terms} ${reason}` : terms;
}
