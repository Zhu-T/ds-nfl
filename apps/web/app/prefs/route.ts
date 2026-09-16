import { NextResponse } from 'next/server';
import { FORM_COOKIE, MATCHUP_COOKIE, ODDS_COOKIE, WEEK_COOKIE } from '../../lib/pref-cookies';

/**
 * Save a display preference (the week shown, or whether betting odds or NFL
 * matchups are used)
 * and send the browser back to the page it came from.
 *
 * A plain form post and a full page load, on purpose. The switches first used a
 * server action that re-rendered the page in place; in the packaged app that
 * refresh sometimes never applied, leaving the buttons stuck and the old week
 * on screen, while a full load always showed the new choice.
 *
 * The redirect is relative. The server sees itself as "localhost" while the app
 * runs on 127.0.0.1, and browsers keep cookies per host name, so an absolute
 * redirect moved the page to localhost, where the cookie just set did not exist:
 * the first switch after opening the app silently did nothing.
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: safePath(String(form.get('back') ?? '/')) },
  });
  const options = { path: '/', sameSite: 'lax' as const, httpOnly: true };

  const week = form.get('week');
  if (week === 'this' || week === 'next') {
    response.cookies.set(WEEK_COOKIE, week, { ...options, maxAge: 60 * 60 * 24 * 30 });
  }

  const odds = form.get('odds');
  if (odds === 'off') response.cookies.set(ODDS_COOKIE, 'off', { ...options, maxAge: 60 * 60 * 24 * 365 });
  if (odds === 'on') response.cookies.delete(ODDS_COOKIE);

  const matchups = form.get('matchups');
  if (matchups === 'off') response.cookies.set(MATCHUP_COOKIE, 'off', { ...options, maxAge: 60 * 60 * 24 * 365 });
  if (matchups === 'on') response.cookies.delete(MATCHUP_COOKIE);

  const recentForm = form.get('form');
  if (recentForm === 'off') response.cookies.set(FORM_COOKIE, 'off', { ...options, maxAge: 60 * 60 * 24 * 365 });
  if (recentForm === 'on') response.cookies.delete(FORM_COOKIE);

  return response;
}

/** Only a path on this app: never another site, whatever the form says. */
function safePath(back: string): string {
  return back.startsWith('/') && !back.startsWith('//') && !back.startsWith('/\\') ? back : '/';
}
