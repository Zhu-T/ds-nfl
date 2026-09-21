/**
 * The moves a chat question asks about, worked out before the model sees it:
 * adding, dropping, or trading for the players it names, and a named
 * one-for-one trade. See packages/llm/src/what-if.ts.
 */

import 'server-only';
import type { PlayerList } from '@ds-nfl/adapters';
import { lookUpPlayers, whatIfBlock, type WhatIfRow } from '@ds-nfl/llm';
import { evaluatePlayer, tradeWhatIf } from './league-data';

/** A question about a move rather than about a player. */
const MOVE = /\b(add|adding|pick(ing)? ?up|claim|grab|stream|drop|dropping|cut|release|trade|trading|swap|deal|offer|worth|keep|should i)\b/i;
const TRADE = /\b(trade|trading|swap|deal|offer)\b/i;
/** Most players one question works out moves for: each takes a few ESPN reads. */
const MOST = 3;

const through = (weeks: readonly number[]) => (weeks.length > 1 ? `through week ${weeks.at(-1)}` : 'this week');

/** The computed moves for a question, as the model reads them, and the players they cover. */
export async function whatIfsFor(
  key: string,
  week: number,
  question: string,
  list: PlayerList | null,
): Promise<{ readonly block: string; readonly names: readonly string[] }> {
  if (!list || !MOVE.test(question)) return { block: '', names: [] };
  const named = lookUpPlayers(question, list.players, { includeMine: true, namesOnly: true });
  if (named.length === 0) return { block: '', names: [] };

  const rows: WhatIfRow[] = [];
  let span = '';
  const mine = named.filter((p) => p.ownerKind === 'mine');
  const theirs = named.filter((p) => p.ownerKind === 'team');
  if (TRADE.test(question) && mine[0] && theirs[0]) {
    const res = await tradeWhatIf(key, week, mine[0].id, theirs[0].id);
    if (res.state === 'ok' && res.data) {
      const t = res.data;
      span = through(t.weeks);
      rows.push({ kind: 'trade', give: t.give, get: t.get, owner: t.owner, mine: t.mine.byWeek[0] ?? 0, mineAhead: t.mine.total, theirs: t.theirs });
    }
  }

  for (const p of named.slice(0, MOST)) {
    const res = await evaluatePlayer(key, week, '', p.id);
    if (res.state !== 'ok' || res.data.kind !== 'evaluated') continue;
    const e = res.data.evaluation;
    span ||= through(e.horizon.weeks);
    if (e.ownerKind === 'mine') {
      rows.push({ kind: 'drop', name: e.name, position: e.position, thisWeek: e.value.value, ahead: e.horizon.total });
    } else if (e.ownerKind === 'team') {
      rows.push({
        kind: 'acquire',
        name: e.name,
        position: e.position,
        owner: e.owner,
        thisWeek: e.value.value,
        ahead: e.horizon.total,
        bestTrade: e.trade,
      });
    } else {
      rows.push({
        kind: 'add',
        name: e.name,
        position: e.position,
        pickup: e.ownerKind,
        thisWeek: e.value.value,
        ahead: e.horizon.total,
        drop: e.horizon.drop ? { name: e.horizon.drop.name, cost: e.horizon.drop.total } : null,
      });
    }
  }
  return { block: whatIfBlock(rows, span || 'this week'), names: named.slice(0, MOST).map((p) => p.name) };
}
