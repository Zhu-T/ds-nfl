'use client';

import { usePathname } from 'next/navigation';

/**
 * This week or next. While a week is being played, next week's lineup,
 * pickups, and trades can already be planned; every page follows the switch.
 *
 * A plain form: the choice is saved and the page reloads in full, which always
 * shows the new week (see app/prefs/route.ts for why not an in-place refresh).
 */
export function WeekToggle({
  currentWeek,
  finalWeek,
  showing,
}: {
  currentWeek: number;
  finalWeek: number;
  showing: number;
}) {
  const pathname = usePathname();
  if (currentWeek >= finalWeek) return <span className="scorebug__value">{currentWeek}</span>;
  const next = currentWeek + 1;

  return (
    <form method="post" action="/prefs" className="weektoggle" aria-label="Week to plan">
      <input type="hidden" name="back" value={pathname} />
      <button type="submit" name="week" value="this" className="weektoggle__opt" aria-pressed={showing === currentWeek}>
        {currentWeek}
      </button>
      <button
        type="submit"
        name="week"
        value="next"
        className="weektoggle__opt"
        aria-pressed={showing === next}
        title="Plan next week while this one is being played"
      >
        {next} · next
      </button>
    </form>
  );
}
