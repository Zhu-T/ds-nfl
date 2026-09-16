import { loadSettings } from '@/lib/league-data';
import { LoadState } from '@/components/loaded';
import { slotHue, SLOT_LABEL } from '@/lib/sample-league';
import type { LineupSlot } from '@ds-nfl/core';

export const dynamic = 'force-dynamic';

function starterLabel(slot: LineupSlot): string {
  switch (slot) {
    case 'FLEX':
      return 'Flex (RB/WR/TE)';
    case 'OP':
      return 'Superflex (QB/RB/WR/TE)';
    case 'RB_WR':
      return 'Flex (RB/WR)';
    case 'WR_TE':
      return 'Flex (WR/TE)';
    case 'DST':
      return 'Defense / Special teams';
    default:
      return slot;
  }
}

export default async function SettingsPage() {
  const res = await loadSettings();
  const data = res.state === 'ok' ? res.data : null;

  return (
    <LoadState state={res.state} {...(res.state === 'error' ? { message: res.message } : {})}>
      {data && (
        <>
          <section className="section" style={{ marginTop: 0 }}>
            <div className="section__head">
              <h1 className="section__title">Roster</h1>
              <span className="section__meta">{data.league.formatLabel}</span>
            </div>
            <div className="slots">
              {Object.entries(data.rosterSettings.slots).map(([slot, count]) => (
                <div
                  key={slot}
                  className="slot"
                  style={{ ['--slot-hue' as string]: slotHue(slot as LineupSlot) }}
                >
                  <div className="slot__tag">{SLOT_LABEL[slot as LineupSlot] ?? slot}</div>
                  <div className="slot__name">{starterLabel(slot as LineupSlot)}</div>
                  <div className="slot__pts">{count}</div>
                </div>
              ))}
              <div className="slot" style={{ ['--slot-hue' as string]: 'var(--border-strong)' }}>
                <div className="slot__tag">BN</div>
                <div className="slot__name">Bench</div>
                <div className="slot__pts">{data.rosterSettings.benchSize}</div>
              </div>
              <div className="slot" style={{ ['--slot-hue' as string]: 'var(--border-strong)' }}>
                <div className="slot__tag">IR</div>
                <div className="slot__name">Injured reserve</div>
                <div className="slot__pts">{data.rosterSettings.irSize}</div>
              </div>
            </div>
          </section>

          <hr className="hashrule" style={{ marginTop: '2.25rem' }} />

          <section className="section">
            <div className="section__head">
              <h2 className="section__title">Scoring</h2>
              <span className="section__meta">{data.scoredRuleCount} rules read from ESPN</span>
            </div>
            <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
              Every rule your league scores, exactly as the engine applies it. ESPN publishes no
              statId dictionary, so the ids are shown raw — but the values are verified: scoring
              every player-week with these rules reproduces ESPN&apos;s own totals exactly.
            </p>

            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>ESPN statId</th>
                    <th className="table__num">Points</th>
                    <th>Per-position overrides</th>
                  </tr>
                </thead>
                <tbody>
                  {data.scoring.map((r) => (
                    <tr key={r.statId}>
                      <td className="table__mono">{r.statId}</td>
                      <td className="table__num">{r.points}</td>
                      <td className="table__dim">{r.overrides ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </LoadState>
  );
}
