import { describe, it, expect } from 'vitest';
import { POST } from './route';

/** As the packaged server sees it: its own address is "localhost". */
function post(fields: Record<string, string>): Promise<Response> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return POST(new Request('http://localhost:3100/prefs', { method: 'POST', body }));
}

describe('POST /prefs', () => {
  it('saves the week choice and goes back to the page it came from', async () => {
    const res = await post({ week: 'next', back: '/waivers' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/waivers');
    expect(res.headers.get('set-cookie')).toMatch(/ds-week=next/);
  });

  it('redirects relatively, so the browser stays on the host that holds the cookie', async () => {
    // The app runs on 127.0.0.1; an absolute redirect built from the server's
    // own "localhost" address lost the cookie on the first switch.
    expect((await post({ week: 'next', back: '/' })).headers.get('location')).not.toMatch(/^https?:/);
  });

  it('switches odds off, and back on by clearing the cookie', async () => {
    expect((await post({ odds: 'off', back: '/' })).headers.get('set-cookie')).toMatch(/ds-odds=off/);
    expect((await post({ odds: 'on', back: '/' })).headers.get('set-cookie')).toMatch(/ds-odds=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
  });

  it('switches matchups off, and back on by clearing the cookie', async () => {
    expect((await post({ matchups: 'off', back: '/' })).headers.get('set-cookie')).toMatch(/ds-matchups=off/);
    expect((await post({ matchups: 'on', back: '/' })).headers.get('set-cookie')).toMatch(
      /ds-matchups=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/i,
    );
  });

  it('switches recent form off, and back on by clearing the cookie', async () => {
    expect((await post({ form: 'off', back: '/' })).headers.get('set-cookie')).toMatch(/ds-form=off/);
    expect((await post({ form: 'on', back: '/' })).headers.get('set-cookie')).toMatch(
      /ds-form=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/i,
    );
  });

  it('switches the upside lineup on, since it is off by default, and back off by clearing the cookie', async () => {
    expect((await post({ upside: 'on', back: '/' })).headers.get('set-cookie')).toMatch(/ds-upside=on/);
    expect((await post({ upside: 'off', back: '/' })).headers.get('set-cookie')).toMatch(
      /ds-upside=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/i,
    );
  });

  it('ignores values it does not know', async () => {
    const res = await post({ week: 'last-year', back: '/' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('never redirects off the app', async () => {
    for (const back of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      expect((await post({ week: 'this', back })).headers.get('location')).toBe('/');
    }
  });
});
