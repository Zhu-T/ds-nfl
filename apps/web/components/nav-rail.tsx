'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LeagueSummary } from '@ds-nfl/adapters';
import { LeagueSwitcher } from './league-switcher';

const THIS_WEEK = [
  { href: '/', label: 'Lineup' },
  { href: '/waivers', label: 'Waivers' },
  { href: '/trades', label: 'Trades' },
  { href: '/players', label: 'Players' },
];

const LEAGUE = [
  { href: '/ai', label: 'League AI' },
  { href: '/settings', label: 'Scoring & roster' },
  { href: '/connect', label: 'Connect a league' },
];

export function NavRail({
  pendingMoves,
  leagues,
}: {
  pendingMoves: number;
  leagues: readonly LeagueSummary[];
}) {
  const pathname = usePathname();

  function link(item: { href: string; label: string }, badge?: number) {
    const active = pathname === item.href;
    return (
      <Link
        key={item.href}
        href={item.href}
        className="rail__link"
        aria-current={active ? 'page' : undefined}
      >
        <span>{item.label}</span>
        {badge ? <span className="rail__badge">{badge}</span> : null}
      </Link>
    );
  }

  return (
    <nav className="rail" aria-label="Sections">
      <LeagueSwitcher leagues={leagues} />

      <div className="rail__group">
        <span className="rail__eyebrow">This week</span>
        {THIS_WEEK.map((item) => link(item, item.href === '/' ? pendingMoves : undefined))}
      </div>

      <div className="rail__group">
        <span className="rail__eyebrow">League</span>
        {LEAGUE.map((item) => link(item))}
      </div>
    </nav>
  );
}
