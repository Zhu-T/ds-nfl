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
              Every rule your league scores, biggest first: what one unit is worth, who earns it, and
              how much of it a typical player at that position is projected for this week. ESPN
              publishes no names for its stat ids, so each rule is described by what the numbers do
              rather than by a guessed label. Scoring every player-week with these rules reproduces
              ESPN&apos;s own totals exactly.
            </p>

            <div className="rules">
              {data.scoring.map((r) => (
                <div key={r.statId} className="rule">
                  <span className="rule__pts">
                    {r.points > 0 ? '+' : ''}
                    {r.points}
                  </span>
                  <span className="rule__what">
                    <span className="rule__name">
                      {r.name ?? `Stat #${r.statId}`}
                      {r.name ? <span className="rule__id"> #{r.statId}</span> : null}
                    </span>
                    <span className="rule__who">
                      {r.positions.length > 0
                        ? `${r.positions.slice(0, 3).join(', ')} · about ${r.perGame} a week for a ${r.positions[0]}`
                        : 'nobody on a roster is projected for this'}
                      {r.overrides ? ` · except ${r.overrides}` : ''}
                    </span>
                  </span>
                  <span className="rule__worth">
                    {r.weight > 0 ? `${r.weight} pts a week` : '—'}
                    <span className="rule__worthlabel">to a {r.positions[0] ?? 'player'}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </LoadState>
  );
}
