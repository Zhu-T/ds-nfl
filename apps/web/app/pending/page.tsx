import { LoadState } from '@/components/loaded';
import { loadPending, type PendingRow } from '@/lib/league-data';

export const dynamic = 'force-dynamic';

const TITLE: Record<PendingRow['kind'], string> = {
  waivers: 'Waiver claim',
  'free-agent': 'Add',
  trade: 'Trade',
  lineup: 'Lineup change',
  other: 'Move',
};

/** "Tyler Loop in, Eagles D/ST out". */
function swapLine(row: PendingRow): string {
  const parts = [
    row.adds.length > 0 ? `${row.adds.join(', ')} in` : '',
    row.drops.length > 0 ? `${row.drops.join(', ')} out` : '',
  ].filter(Boolean);
  return parts.join(', ') || 'no players named';
}

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

const OUTCOME: Record<Exclude<PendingRow['status'], 'pending'>, string> = {
  executed: 'went through',
  canceled: 'cancelled',
  failed: 'failed',
};

export default async function PendingPage() {
  const res = await loadPending();
  const data = res.state === 'ok' ? res.data : null;
  const live = data?.pending.filter((p) => p.live) ?? [];
  const stale = data?.pending.filter((p) => !p.live) ?? [];
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
              Moves you have put in that the platform has not settled. Your roster does not change until it does, so
              nothing here is counted in projections, lineups or waiver value. This page is read from ESPN each time you
              open it.
            </p>

            {live.length === 0 ? (
              <div className="notice">
                <span className="notice__tag">Clear</span>
                <span>Nothing is waiting. Claims you put in from the Waivers page show up here until they settle.</span>
              </div>
            ) : (
              <div className="slots">
                {live.map((row) => (
                  <div key={row.id} className="slot slot--changed" style={{ ['--slot-hue' as string]: 'var(--accent)' }}>
                    <div className="slot__tag">W{row.week}</div>
                    <div>
                      <div className="slot__name">{swapLine(row)}</div>
                      <div className="slot__sub">
                        {TITLE[row.kind]}
                        {row.bid !== undefined ? ` · $${row.bid}` : ''}
                        {row.at ? ` · put in ${when(row.at)}` : ''}
                        {schedule ? ` · settles ${schedule}` : ''}
                      </div>
                    </div>
                    <div className="slot__pts">
                      <span className="slot__empty">waiting</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {stale.length > 0 && (
              <details className="fold">
                <summary>
                  {stale.length} older {stale.length === 1 ? 'claim' : 'claims'} ESPN still lists as pending but cannot
                  happen
                </summary>
                <div className="slots">
                  {stale.map((row) => (
                    <div key={row.id} className="slot" style={{ ['--slot-hue' as string]: 'var(--border-strong)' }}>
                      <div className="slot__tag">W{row.week}</div>
                      <div>
                        <div className="slot__name">{swapLine(row)}</div>
                        <div className="slot__sub">
                          the player it would drop has already gone, or the one it adds is yours — ESPN leaves these in
                          the list
                        </div>
                      </div>
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
                    className="slot"
                    style={{ ['--slot-hue' as string]: row.status === 'executed' ? 'var(--gain)' : 'var(--border-strong)' }}
                  >
                    <div className="slot__tag">W{row.week}</div>
                    <div>
                      <div className="slot__name">{swapLine(row)}</div>
                      <div className="slot__sub">
                        {TITLE[row.kind]} {OUTCOME[row.status as Exclude<PendingRow['status'], 'pending'>]}
                        {row.failure ? ` · ${row.failure.toLowerCase().replace(/player/g, 'player ')}` : ''}
                        {row.at ? ` · ${when(row.at)}` : ''}
                      </div>
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
