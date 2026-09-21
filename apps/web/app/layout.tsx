import type { Metadata } from 'next';
import './globals.css';
import { ThemeToggle, THEME_BOOTSTRAP } from './theme-toggle';
import { NavRail } from '@/components/nav-rail';
import { WeekToggle } from '@/components/week-toggle';
import { loadWeek } from '@/lib/week';
import { leagueSummaries } from '@ds-nfl/adapters';
import { RENDER_STAMP_ID, renderStamp } from '@/lib/render-stamp';

export const metadata: Metadata = {
  title: 'ds-nfl',
  description: 'Local-first NFL fantasy console: lineups, waivers, and trades on a computed engine.',
};

// Reads the live league on every request; nothing here is safe to prerender.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { league, optimal, diff, currentPoints, isSample, matchup, currentWeek, finalWeek } = await loadWeek();
  const gain = diff.pointsGained;

  return (
    // suppressHydrationWarning is required, not a workaround: the script below
    // sets data-theme on <html> before React hydrates, so the server markup and
    // the live DOM differ by design. Scoped to this element only.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the theme before first paint so the page never flashes dark-then-light. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {/* Changes with every render, so a refresh can be seen to have landed (see use-refresh.ts). */}
        <div id={RENDER_STAMP_ID} data-at={renderStamp()} hidden />
        <header className="scorebug">
          <div className="scorebug__seg scorebug__seg--brand">ds·nfl</div>

          <div className="scorebug__seg scorebug__seg--secondary">
            <span className="scorebug__label">League</span>
            <span className="scorebug__value">
              {league.name}
              {isSample ? ' (sample)' : ''}
            </span>
          </div>

          <div className="scorebug__seg scorebug__seg--secondary">
            <span className="scorebug__label">Format</span>
            <span className="scorebug__value">{league.format}</span>
          </div>

          <div className="scorebug__seg scorebug__seg--secondary">
            <span className="scorebug__label">Week</span>
            {isSample ? (
              <span className="scorebug__value">{league.week}</span>
            ) : (
              <WeekToggle currentWeek={currentWeek} finalWeek={finalWeek} showing={league.week} />
            )}
          </div>

          <div className="scorebug__seg scorebug__seg--grow" />

          {matchup ? (
            <>
              <div className="scorebug__seg scorebug__seg--team">
                <span className="scorebug__label">You</span>
                <span className="scorebug__value scorebug__value--big">
                  {matchup.myProjected.toFixed(1)}
                </span>
              </div>

              <div className="scorebug__seg scorebug__seg--vs">vs</div>

              <div className="scorebug__seg scorebug__seg--team">
                <span className="scorebug__label">{matchup.opponentName}</span>
                <span className="scorebug__value scorebug__value--big">
                  {matchup.opponentProjected.toFixed(1)}
                </span>
              </div>

              <div className="scorebug__seg scorebug__seg--secondary">
                <span className="scorebug__label">Margin</span>
                <span
                  className={`scorebug__value delta${matchup.marginNow < 0 ? ' delta--down' : ''}`}
                >
                  {matchup.marginNow > 0 ? '+' : ''}
                  {matchup.marginNow.toFixed(1)}
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="scorebug__seg scorebug__seg--team">
                <span className="scorebug__label">Lineup now</span>
                <span className="scorebug__value scorebug__value--big">
                  {currentPoints.toFixed(1)}
                </span>
              </div>

              <div className="scorebug__seg scorebug__seg--vs">to</div>

              <div className="scorebug__seg scorebug__seg--team">
                <span className="scorebug__label">Optimized</span>
                <span className="scorebug__value scorebug__value--big">
                  {optimal.projectedPoints.toFixed(1)}
                </span>
              </div>

              <div className="scorebug__seg scorebug__seg--secondary">
                <span className="scorebug__label">Available</span>
                <span className={`scorebug__value delta${gain <= 0 ? ' delta--down' : ''}`}>
                  {gain > 0 ? '+' : ''}
                  {gain.toFixed(1)}
                </span>
              </div>
            </>
          )}

          <div className="scorebug__seg scorebug__seg--icon">
            <ThemeToggle />
          </div>
        </header>

        <div className="shell">
          <NavRail pendingMoves={diff.slotsChanged} leagues={leagueSummaries()} />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
