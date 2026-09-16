'use client';

import { useEffect, useRef } from 'react';
import { useFormAction } from '@/lib/use-form-action';
import { renewCookies, type ConnectResult } from './actions';

/** Paste fresh ESPN cookies once; every league on that account picks them up. */
export function CookieForm() {
  const [result, submit, pending] = useFormAction<ConnectResult | null>(renewCookies, null);
  const form = useRef<HTMLFormElement>(null);

  // Saved cookies are not left in the fields; rejected ones stay to be checked.
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
          <span className="field__label">espn_s2</span>
          <input
            className="field__input field__input--mono"
            name="espnS2"
            type="password"
            placeholder="AEB..."
            autoComplete="off"
            required
          />
        </label>
        <label className="field">
          <span className="field__label">SWID</span>
          <input
            className="field__input field__input--mono"
            name="swid"
            type="password"
            placeholder="{XXXXXXXX-XXXX-...}"
            autoComplete="off"
            required
          />
        </label>
      </div>

      <div className="form__actions">
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Check and save'}
        </button>
      </div>
    </form>
  );
}
