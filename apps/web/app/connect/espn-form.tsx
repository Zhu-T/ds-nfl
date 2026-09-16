'use client';

import { useEffect, useRef } from 'react';
import { useFormAction } from '@/lib/use-form-action';
import { connectEspn, type ConnectResult } from './actions';

/**
 * Add a league by id: the first connection, a league the account list above
 * does not show, or a league on a different ESPN account.
 */
export function EspnForm({ hasCookies }: { hasCookies: boolean }) {
  const [result, submit, pending] = useFormAction<ConnectResult | null>(connectEspn, null);
  const form = useRef<HTMLFormElement>(null);

  // Clear the form once a league is added. After a failure everything typed
  // stays, so a mistyped id can be corrected rather than entered again.
  useEffect(() => {
    if (result?.ok) form.current?.reset();
  }, [result]);

  return (
    <form ref={form} onSubmit={submit} className="form">
      {result && (
        <div className={`notice${result.ok ? '' : ' notice--error'}`}>
          <span className={`notice__tag${result.ok ? '' : ' notice__tag--error'}`}>
            {result.ok ? 'Saved' : 'Failed'}
          </span>
          <span>{result.message}</span>
        </div>
      )}

      <div className="form__grid">
        <label className="field">
          <span className="field__label">League id</span>
          <input
            className="field__input"
            name="leagueId"
            placeholder="1662359399"
            inputMode="numeric"
            required
          />
          <span className="field__hint">From the leagueId in your ESPN league URL.</span>
        </label>

        <label className="field">
          <span className="field__label">Team id</span>
          <input className="field__input" name="teamId" placeholder="4" inputMode="numeric" required />
          <span className="field__hint">Your team, from teamId in the URL.</span>
        </label>

        <label className="field">
          <span className="field__label">Season</span>
          <input
            className="field__input"
            name="season"
            defaultValue={new Date().getFullYear()}
            inputMode="numeric"
            required
          />
          <span className="field__hint">The fantasy year, for example 2026.</span>
        </label>
      </div>

      <label className="field">
        <span className="field__label">espn_s2</span>
        <input
          className="field__input field__input--mono"
          name="espnS2"
          type="password"
          placeholder={hasCookies ? 'Saved — leave blank to reuse' : 'AEB...'}
          autoComplete="off"
          required={!hasCookies}
        />
        <span className="field__hint">
          {hasCookies
            ? 'Leave blank to use the cookies saved with your active league. Paste new ones only for a league on a different ESPN account.'
            : 'A long cookie value. In your browser on espn.com: DevTools → Application → Cookies.'}
        </span>
      </label>

      <label className="field">
        <span className="field__label">SWID</span>
        <input
          className="field__input field__input--mono"
          name="swid"
          type="password"
          placeholder={hasCookies ? 'Saved — leave blank to reuse' : '{XXXXXXXX-XXXX-...}'}
          autoComplete="off"
          required={!hasCookies}
        />
        <span className="field__hint">The braces are added for you if you leave them off.</span>
      </label>

      <div className="form__actions">
        <button className="btn btn--primary" type="submit" disabled={pending}>
          {pending ? 'Checking…' : hasCookies ? 'Add league' : 'Connect'}
        </button>
      </div>

      <p className="field__hint">
        The league is read from ESPN before anything is saved, then written to{' '}
        <code>data/credentials.json</code> on this machine. Cookies are never sent anywhere else and
        never returned to this page.
      </p>
    </form>
  );
}
