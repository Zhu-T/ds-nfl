import { loadRosterNews } from '@/lib/news';
import { positionHue } from '@/lib/sample-league';

/** Updates shown before the rest fold away. */
const SHOWN = 4;

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Recent news for the roster. Rendered inside Suspense, so the lineup never
 * waits on the news feed.
 */
export async function RosterNews({ leagueKey }: { leagueKey: string | null }) {
  let news;
  try {
    news = await loadRosterNews(leagueKey);
  } catch {
    return (
      <p className="ai__error" style={{ marginTop: '1.25rem' }}>
        ESPN player updates could not be loaded. The lineup above is unaffected.
      </p>
    );
  }
  if (!news) return null;

  const item = (n: (typeof news.items)[number]) => (
    <details key={n.item.id} className="news__item" style={{ ['--slot-hue' as string]: positionHue(n.position) }}>
      <summary>
        <span className="news__who">{n.player}</span>
        <span className="news__when">{ago(n.item.published)}</span>
        <span className="news__headline">{n.item.headline}</span>
      </summary>
      {n.item.story && <p className="news__story">{n.item.story}</p>}
    </details>
  );

  return (
    <div className="newsfeed">
      <h3 className="subhead">
        ESPN player updates <span className="subhead__meta">your roster · last 7 days</span>
      </h3>

      {news.items.length === 0 ? (
        <p className="field__hint">No news in the last 7 days for your players.</p>
      ) : (
        <div className="news">
          {news.items.slice(0, SHOWN).map(item)}
          {news.items.length > SHOWN && (
            <details className="fold fold--inline">
              <summary>
                {news.items.length - SHOWN} older {news.items.length - SHOWN === 1 ? 'update' : 'updates'}
              </summary>
              <div className="news">{news.items.slice(SHOWN).map(item)}</div>
            </details>
          )}
        </div>
      )}

      {news.failed > 0 && (
        <p className="field__hint" style={{ marginTop: '0.5rem' }}>
          News for {news.failed} {news.failed === 1 ? 'player' : 'players'} could not be loaded.
        </p>
      )}
    </div>
  );
}
