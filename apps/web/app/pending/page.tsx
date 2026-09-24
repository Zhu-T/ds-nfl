import { LoadState } from '@/components/loaded';
import { loadPending, type PendingRow } from '@/lib/league-data';
import { MoveLines } from '@/components/move-lines';
import { TradeOffer } from '@/components/trade-offer';
import { aiStatus } from '@/lib/ai';

export const dynamic = 'force-dynamic';

const TITLE: Record<PendingRow['kind'], string> = {
  waivers: 'Waiver claim',
  'free-agent': 'Add',
  trade: 'Trade',
  lineup: 'Lineup change',
  other: 'Move',
};

/** The tag that carries how a move ended, or that it has not. */
type Tone = 'good' | 'bad' | 'warn' | 'muted' | 'wait';

function outcomeTag(row: PendingRow): { label: string; tone: Tone } {
  if (row.answered) {
    return row.answered === 'accepted' ? { label: 'accepted', tone: 'good' } : { label: 'declined', tone: 'bad' };
  }
  switch (row.status) {
    case 'executed':
      return { label: 'went through', tone: 'good' };
    case 'canceled':
      return { label: 'cancelled', tone: 'muted' };
    case 'failed':
      return { label: 'failed', tone: 'warn' };
    default:
      return { label: 'waiting', tone: 'wait' };
  }
}

/** ESPN's failure codes, in English. Anything unknown is shown as ESPN wrote it. */
const WHY_FAILED: Readonly<Record<string, string>> = {
  INVALIDPLAYERSOURCE: 'another team claimed the player first',
  PLAYERALREADYDROPPED: 'the player had already been dropped',
  PLAYERALREADYROSTERED: 'the player was already on a roster',
  ROSTERFULL: 'your roster was full',
  INVALIDPLAYERDESTINATION: 'the player could not be placed',
};

/** What the move was, without the outcome: the tag says that. */
function moveName(row: PendingRow): string {
  return row.kind === 'trade' ? `Trade with ${row.counterparty}` : TITLE[row.kind];
}

function Tag({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`tag tag--${tone}`}>{label}</span>;
}

/** The card's edge takes the tag's colour, so a list scans by outcome. */
const EDGE: Record<Tone, string> = {
  good: 'var(--gain)',
  bad: 'var(--loss)',
  warn: 'var(--accent)',
  wait: 'var(--accent)',
  muted: 'var(--border-strong)',
};

function when(at: string | null): string {
  if (!at) return '';
  const hours = Math.floor((Date.now() - Date.parse(at)) / 3_600_000);
  if (Number.isNaN(hours)) return '';
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "daily at 11:00", or "Wednesdays and Thursdays at 11:00". */
function runsAt(run: { days: readonly string[]; hour: number } | null): string | null {
  if (!run || run.days.length === 0) return null;
  const hour = `${String(run.hour).padStart(2, '0')}:00`;
  if (run.days.length >= 7) return `daily at ${hour}`;
  const days = run.days.map((d) => `${d.charAt(0)}${d.slice(1).toLowerCase()}s`);
  const list = days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days.at(-1)}` : days[0];
  return `${list} at ${hour}`;
}

/** Where the players on each side come from and go to. */
function sides(row: PendingRow): { from: string; to: string } {
  if (row.kind === 'trade') return { from: row.counterparty, to: row.counterparty };
  // A dropped player goes back to the pool, whichever way they came.
  return { from: row.counterparty, to: 'the waiver pool' };
}

/** Who put the move in, in the manager's own words. */
function proposedBy(row: PendingRow): string {
  if (row.kind === 'trade') return row.theirs ? `${row.counterparty} offered this trade` : `You offered this trade to ${row.counterparty}`;
  return row.kind === 'waivers' ? 'You put in this claim' : 'You added this player';
}

export default async function PendingPage() {
  const res = await loadPending();
  const data = res.state === 'ok' ? res.data : null;
  const ai = aiStatus();
  const offers = data?.pending.filter((p) => p.live && p.kind === 'trade') ?? [];
  const claims = data?.pending.filter((p) => p.live && p.kind !== 'trade') ?? [];
  // An answered trade is told in "Just settled"; leaving it here too would say it twice.
  const stale = data?.pending.filter((p) => !p.live && !p.answered) ?? [];
  const schedule = runsAt(data?.waiverRun ?? null);

  return (
    <LoadState state={res.state} {...(res.state === 'error' ? { message: res.message } : {})}>
      {data && (
        <>
          <section className="section" style={{ marginTop: 0 }}>
            <div className="section__head">
              <h1 className="section__title">Pending</h1>
              <span className="section__meta">
                read {when(data.readAt) || 'just now'}
                {schedule ? ` · waivers run ${schedule}` : ''}
              </span>
            </div>
            <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
              Moves waiting to settle: claims you have put in, and trades another manager has offered you. Your roster
              does not change until they settle, so nothing here counts in projections, lineups or waiver value.
            </p>

            {offers.length === 0 && claims.length === 0 && (
              <div className="notice">
                <span className="notice__tag">Clear</span>
                <span>
                  Nothing is waiting. Claims you put in from the Waivers page, and trades another manager offers you,
                  show up here until they settle.
                </span>
              </div>
            )}

            {offers.length > 0 && res.state === 'ok' && (
              <>
                <h2 className="subhead">
                  Trade {offers.length === 1 ? 'offer' : 'offers'} <span className="subhead__meta">yours to answer</span>
                </h2>
                <div className="slots">
                  {offers.map((row) => (
                    <div key={row.id} className="slot movecard" style={{ ['--slot-hue' as string]: 'var(--pos-wr)' }}>
                      <div className="movehead">
                        <Tag label="your call" tone="wait" />
                        <span className="movehead__who">{proposedBy(row)}</span>
                        <span>
                          week {row.week}
                          {row.at ? ` · ${when(row.at)}` : ''}
                        </span>
                      </div>
                      <MoveLines adds={row.adds} drops={row.drops} {...sides(row)} />
                      <TradeOffer
                        row={row}
                        leagueKey={res.key}
                        aiEnabled={ai.provider !== 'off'}
                        providerLabel={ai.judgmentLabel ?? ''}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}

            {claims.length > 0 && (
              <>
                <h2 className="subhead" style={{ marginTop: offers.length > 0 ? '1.5rem' : 0 }}>
                  Waiting to settle <span className="subhead__meta">{schedule ? `waivers run ${schedule}` : ''}</span>
                </h2>
                <div className="slots">
                  {claims.map((row) => (
                    <div key={row.id} className="slot movecard" style={{ ['--slot-hue' as string]: 'var(--accent)' }}>
                      <div className="movehead">
                        <Tag {...outcomeTag(row)} />
                        <span className="movehead__who">{proposedBy(row)}</span>
                        <span>
                          {TITLE[row.kind]} · week {row.week}
                          {row.bid !== undefined ? ` · $${row.bid}` : ''}
                          {row.at ? ` · ${when(row.at)}` : ''}
                        </span>
                      </div>
                      <MoveLines adds={row.adds} drops={row.drops} {...sides(row)} />
                    </div>
                  ))}
                </div>
              </>
            )}

            {stale.length > 0 && (
              <details className="fold">
                <summary>
                  {stale.length} older {stale.length === 1 ? 'move' : 'moves'} ESPN still lists as pending but cannot
                  happen
                </summary>
                <div className="slots">
                  {stale.map((row) => (
                    <div key={row.id} className="slot movecard" style={{ ['--slot-hue' as string]: 'var(--border-strong)' }}>
                      <div className="movehead">
                        <Tag label="closed" tone="muted" />
                        <span>
                          {moveName(row)} · week {row.week}
                          {row.at ? ` · ${when(row.at)}` : ''} ·{' '}
                          {row.answered
                            ? `already ${row.answered}`
                            : row.kind === 'trade'
                              ? 'no longer open: it was answered or withdrawn'
                              : 'the player it would drop has already gone, or the one it adds is yours'}
                        </span>
                      </div>
                      <MoveLines adds={row.adds} drops={row.drops} {...sides(row)} />
                    </div>
                  ))}
                </div>
              </details>
            )}
          </section>

          {data.settled.length > 0 && (
            <section className="section">
              <div className="section__head">
                <h2 className="section__title">Just settled</h2>
                <span className="section__meta">your last {data.settled.length} moves</span>
              </div>
              <div className="slots">
                {data.settled.map((row) => (
                  <div
                    key={row.id}
                    className="slot movecard"
                    style={{ ['--slot-hue' as string]: EDGE[outcomeTag(row).tone] }}
                  >
                    <div className="movehead">
                      <Tag {...outcomeTag(row)} />
                      <span className="movehead__who">{moveName(row)}</span>
                      <span>
                        week {row.week}
                        {row.at ? ` · ${when(row.at)}` : ''}
                        {row.failure ? ` · ${WHY_FAILED[row.failure] ?? row.failure.toLowerCase()}` : ''}
                      </span>
                    </div>
                    <MoveLines adds={row.adds} drops={row.drops} {...sides(row)} />
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
