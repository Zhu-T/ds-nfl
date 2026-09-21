import { readConversation } from '@ds-nfl/adapters';
import { LoadState } from '@/components/loaded';
import { aiStatus } from '@/lib/ai';
import { buildLeagueContext } from '@/lib/league-context';
import { Chat } from './chat';
import { RefreshListForm } from './refresh-list';

function ago(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export const dynamic = 'force-dynamic';

export default async function LeagueAiPage() {
  const ai = aiStatus();
  const ctx = await buildLeagueContext();

  if (ctx.state !== 'ok') {
    return (
      <LoadState state={ctx.state} {...(ctx.state === 'error' ? { message: ctx.message } : {})}>
        {null}
      </LoadState>
    );
  }

  const { view } = ctx;

  return (
    <>
      <section className="section" style={{ marginTop: 0 }}>
        <div className="section__head">
          <h1 className="section__title">League AI</h1>
          <span className="section__meta">{view.leagueName} · week {view.week}</span>
        </div>
        <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
          An assistant for this league. It answers from the brief at the bottom of this page — the
          exact text it receives, rebuilt from ESPN as you ask — and it cannot change anything on
          ESPN. This league&apos;s conversation is saved on this computer, separate from any other
          league.
        </p>
        <div className="ai__list">
          <p className="field__hint">
            {view.playerList
              ? `For each question it also looks up the players, fantasy teams, and positions you name in the league's player list: ${view.playerList.players.length} players, updated ${ago(view.playerList.updatedAt)}. The list is rebuilt when it is over 10 minutes old or the news check or web picks change.`
              : "The league's player list could not be loaded, so questions are answered from the brief alone."}
          </p>
          <RefreshListForm leagueKey={view.key} />
        </div>
      </section>

      <section className="section">
        <Chat
          leagueKey={view.key}
          week={view.week}
          initial={readConversation(view.key)}
          enabled={ai.provider !== 'off'}
          providerLabel={ai.chatLabel ?? ai.label ?? ''}
        />
      </section>

      <hr className="hashrule" style={{ marginTop: '2.25rem' }} />

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">What the AI knows</h2>
          <span className="section__meta">{view.text.length.toLocaleString()} characters</span>
        </div>
        {view.sections.map((s) => (
          <details key={s.title} className="ctx" open={s.title === 'This week'}>
            <summary>{s.title}</summary>
            <pre className="ctx__body">{s.body}</pre>
          </details>
        ))}
      </section>
    </>
  );
}
