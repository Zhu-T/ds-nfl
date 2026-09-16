'use client';

import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

/** Applied before paint by the inline script in layout.tsx, so there is no flash. */
export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('ds-nfl-theme');if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}})();`;

/**
 * Shows the theme you would switch *to*, which is the convention people expect
 * from a toggle: a moon while you are in daylight, a sun while you are in the dark.
 */
function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2" />
        <path d="M5.4 5.4 7 7M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6" />
      </g>
    </svg>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    try {
      localStorage.setItem('ds-nfl-theme', next);
    } catch {
      // Private browsing or blocked storage; the toggle still works for this session.
    }
  }

  const label = theme === 'dark' ? 'Switch to the day theme' : 'Switch to the night theme';

  return (
    <button
      type="button"
      className="iconbtn"
      onClick={toggle}
      aria-label={label}
      title={label}
      aria-pressed={theme === 'light'}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
