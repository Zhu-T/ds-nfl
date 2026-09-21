import {
  AdapterFailure,
  describeError,
  discoverEspnLeagues,
  leagueKey,
  leagueSummaries,
  savedEspnCookies,
} from '@ds-nfl/adapters';
import { listOllamaModels } from '@ds-nfl/llm';
import { aiStatus } from '@/lib/ai';
import { AiForm } from './ai-form';
import { CookieForm } from './cookie-form';
import { DiscoveredLeague } from './discovered-league';
import { EspnForm } from './espn-form';
import { LeagueRowActions } from './league-row-actions';

export const dynamic = 'force-dynamic';

export default async function ConnectPage() {
  // Names and ids only. Cookie values are never sent to the browser.
  const leagues = leagueSummaries();
  const cookies = savedEspnCookies();
  const ai = aiStatus();

  const [ollama, discovered] = await Promise.all([
    listOllamaModels(ai.ollamaUrl).then(
      (models) => ({ reachable: true, models }),
      () => ({ reachable: false, models: [] as string[] }),
    ),
    // With cookies saved, list every football league on that ESPN account, so
    // adding another is one click instead of hunting for ids in URLs.
    cookies
      ? discoverEspnLeagues(cookies).then(
          (found) => ({ ok: true as const, found }),
          (e: unknown) => ({
            ok: false as const,
            message:
              e instanceof AdapterFailure ? describeError(e.error) : e instanceof Error ? e.message : String(e),
          }),
        )
      : Promise.resolve(null),
  ]);
  const connected = new Set(leagues.map((l) => l.key));

  return (
    <>
      <section className="section" style={{ marginTop: 0 }}>
        <div className="section__head">
          <h1 className="section__title">Connect a league</h1>
          <span className="section__meta">
            {leagues.length === 0 ? 'none connected' : `${leagues.length} connected`}
          </span>
        </div>

        {leagues.length === 0 ? (
          <div className="notice">
            <span className="notice__tag">Sample</span>
            <span>Nothing is connected, so the app is showing a sample roster.</span>
          </div>
        ) : (
          <>
            <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
              Every page shows the active league. Switch here or from the sidebar. Each league keeps
              its own AI conversation.
            </p>
            <div className="slots">
              {leagues.map((l) => (
                <div
                  key={l.key}
                  className="slot"
                  style={{ ['--slot-hue' as string]: l.active ? 'var(--gain)' : 'var(--border-strong)' }}
                >
                  <div className="slot__tag">{l.active ? 'ACTIVE' : 'ESPN'}</div>
                  <div>
                    <div className="slot__name">{l.leagueName}</div>
                    <div className="slot__sub">
                      {l.teamName ?? `Team ${l.teamId}`} · league {l.leagueId} · {l.season} season
                    </div>
                  </div>
                  <div className="slot__pts">
                    <LeagueRowActions leagueKey={l.key} leagueName={l.leagueName} active={l.active} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">{leagues.length === 0 ? 'Connect ESPN' : 'Add a league'}</h2>
        </div>

        {discovered?.ok && discovered.found.length > 0 && (
          <>
            <p className="field__hint" style={{ marginBottom: '0.75rem' }}>
              Football leagues on the ESPN account you are signed in with:
            </p>
            <div className="slots" style={{ marginBottom: '1.5rem' }}>
              {discovered.found.map((d) => {
                const key = leagueKey(d);
                return (
                  <div key={key} className="slot" style={{ ['--slot-hue' as string]: 'var(--pos-wr)' }}>
                    <div className="slot__tag">ESPN</div>
                    <div>
                      <div className="slot__name">{d.leagueName}</div>
                      <div className="slot__sub">
                        {d.teamName ?? `Your team: ${d.teamId}`} · {d.season} season
                      </div>
                    </div>
                    <div className="slot__pts">
                      {connected.has(key) ? (
                        <span className="slot__sub">connected</span>
                      ) : (
                        <DiscoveredLeague leagueId={d.leagueId} teamId={d.teamId} season={d.season} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {discovered && !discovered.ok && (
          <div className="notice notice--error" style={{ marginBottom: '1rem' }}>
            <span className="notice__tag notice__tag--error">Error</span>
            <span>Could not list the leagues on your ESPN account: {discovered.message}</span>
          </div>
        )}

        {cookies && (
          <p className="field__hint" style={{ marginBottom: '0.75rem' }}>
            Or add one by id, for a league not listed here or one on another ESPN account.
          </p>
        )}
        <EspnForm hasCookies={cookies !== null} />
      </section>

      {leagues.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Renew ESPN cookies</h2>
          </div>
          <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
            When ESPN starts rejecting the saved cookies, paste fresh ones here. They are checked
            against the active league, then saved for every connected league on the same ESPN
            account.
          </p>
          <CookieForm />
        </section>
      )}

      <section className="section" id="ai">
        <div className="section__head">
          <h2 className="section__title">AI explanations</h2>
          <span className="section__meta">optional</span>
        </div>
        <p className="field__hint" style={{ marginBottom: '1rem', maxWidth: '46rem' }}>
          A language model can explain a lineup recommendation or draft a trade message in plain
          English, from the numbers the engine already computed. It never picks a lineup or changes
          anything on ESPN, and any text containing a number the engine did not produce is withheld.
        </p>
        <AiForm
          provider={ai.provider}
          anthropicKeySet={ai.anthropicKeySet}
          ollamaUrl={ai.ollamaUrl}
          ollamaModel={ai.ollamaModel}
          ollamaJudgmentModel={ai.ollamaJudgmentModel}
          ollamaChatModel={ai.ollamaChatModel}
          ollamaSearchKeySet={ai.ollamaSearchKeySet}
          installedModels={ollama.models}
          ollamaReachable={ollama.reachable}
        />
      </section>

      <hr className="hashrule" style={{ marginTop: '2.25rem' }} />

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">How connecting works</h2>
        </div>

        <div className="slots">
          <div className="slot" style={{ ['--slot-hue' as string]: 'var(--pos-wr)' }}>
            <div className="slot__tag">ESPN</div>
            <div>
              <div className="slot__name">Two cookies, then plain HTTP</div>
              <div className="slot__sub">
                Reading a league needs <code>espn_s2</code> and <code>SWID</code> from a signed-in
                browser session. ESPN has no login API — it is a Disney OAuth flow behind a bot
                wall — so the cookies have to be captured from a real sign-in. They belong to your
                ESPN account, so every league on it shares them. After that every read, and every
                lineup change, is an ordinary request. Credentials stay in{' '}
                <code>data/credentials.json</code> on this machine.
              </div>
            </div>
            <div className="slot__pts">
              <span className="slot__sub">read + lineups</span>
            </div>
          </div>

          <div className="slot" style={{ ['--slot-hue' as string]: 'var(--pos-rb)' }}>
            <div className="slot__tag">SLPR</div>
            <div>
              <div className="slot__name">Sleeper needs no credentials at all</div>
              <div className="slot__sub">
                Its read API is public, and the adapter is built. Sleeper publishes no point
                projections though, so lineup advice there needs a projection source of our own.
                Writing is not possible on any Sleeper league, so those actions stay disabled
                rather than failing when you click them.
              </div>
            </div>
            <div className="slot__pts">
              <span className="slot__sub">no form yet</span>
            </div>
          </div>

          <div className="slot" style={{ ['--slot-hue' as string]: 'var(--pos-k)' }}>
            <div className="slot__tag">NEXT</div>
            <div>
              <div className="slot__name">Sign-in from inside the app</div>
              <div className="slot__sub">
                Capturing cookies currently means pasting them in by hand. The desktop app runs on
                Electron, so it can open a real ESPN sign-in window and read the session directly,
                which will remove that step. Not wired up yet.
              </div>
            </div>
            <div className="slot__pts">
              <span className="slot__sub">planned</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
