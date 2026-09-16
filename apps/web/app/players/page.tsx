import { loadPlayers } from '@/lib/league-data';
import { LoadState } from '@/components/loaded';
import { PlayersTable } from '@/components/players-table';

export const dynamic = 'force-dynamic';

export default async function PlayersPage() {
  const res = await loadPlayers();
  const data = res.state === 'ok' ? res.data : null;

  return (
    <LoadState state={res.state} {...(res.state === 'error' ? { message: res.message } : {})}>
      {data && (
        <>
          <section className="section" style={{ marginTop: 0 }}>
            <div className="section__head">
              <h1 className="section__title">Players</h1>
              <span className="section__meta">
                {data.rosteredCount} rostered · {data.unrosteredCount} unrostered · week {data.week}
              </span>
            </div>
            <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
              Every player on a roster in your league and who has him, plus the most-owned players
              nobody has. Those are either on <strong>waivers</strong> — you put in a claim and it
              processes later — or <strong>free agents</strong> you can add right now.
            </p>
          </section>

          <section className="section">
            <PlayersTable rows={data.rows} />
          </section>
        </>
      )}
    </LoadState>
  );
}
