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
            <div className="rosterchips">
              {Object.entries(data.rosterSettings.slots).map(([slot, count]) => (
                <span
                  key={slot}
                  className="rosterchip"
                  title={starterLabel(slot as LineupSlot)}
                  style={{ ['--slot-hue' as string]: slotHue(slot as LineupSlot) }}
                >
                  <b>{count}</b> {SLOT_LABEL[slot as LineupSlot] ?? slot}
                </span>
              ))}
              <span className="rosterchip" style={{ ['--slot-hue' as string]: 'var(--border-strong)' }}>
                <b>{data.rosterSettings.benchSize}</b> Bench
              </span>
              <span className="rosterchip" style={{ ['--slot-hue' as string]: 'var(--border-strong)' }}>
                <b>{data.rosterSettings.irSize}</b> IR
              </span>
            </div>
          </section>


          <section className="section">
            <div className="section__head">
              <h2 className="section__title">Scoring</h2>
              <span className="section__meta">{data.scoredRuleCount} rules read from ESPN</span>
            </div>
            <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
              Every rule your league scores, by ESPN statId (ESPN publishes no names for them), with
              points and any per-position override. Scoring every player-week with these rules
              reproduces ESPN&apos;s own totals exactly.
            </p>

            <div className="rulegrid">
              {data.scoring.map((r) => (
                <div key={r.statId} className="rulegrid__cell" {...(r.overrides ? { title: r.overrides } : {})}>
                  <span className="table__mono">#{r.statId}</span>
                  <span className="rulegrid__pts">{r.points}</span>
                  {r.overrides && <span className="rulegrid__over">{r.overrides}</span>}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </LoadState>
  );
}
