/**
 * @jest-environment node
 */
import { CSRF_FIELD, verifyCsrf } from './csrf';
import { newCsrfToken, type WebSession } from './session';

/**
 * The CSRF check, at the boundary where a write is accepted or refused
 * (ADR-059 § 5).
 *
 * `SameSite=Strict` stops most cross-site submissions, and "most" is what
 * this test is about: every case below is a request that arrives *with* the
 * cookie — because the browser sent it — and must still be refused.
 */

const token = newCsrfToken();

const session = { csrfToken: token } as WebSession;

function formWith(value?: unknown): FormData {
  const form = new FormData();
  if (value !== undefined) form.set(CSRF_FIELD, value as string);
  return form;
}

describe('verifyCsrf', () => {
  it('accepts the token the session carries', () => {
    expect(verifyCsrf(session, formWith(token))).toEqual({ ok: true });
  });

  it('refuses a form with no token at all', () => {
    expect(verifyCsrf(session, formWith())).toEqual({ ok: false, reason: 'MISSING' });
  });

  it('refuses an empty token', () => {
    expect(verifyCsrf(session, formWith(''))).toEqual({ ok: false, reason: 'MISSING' });
  });

  it('refuses a token from another session — the stale case after a re-login', () => {
    expect(verifyCsrf(session, formWith(newCsrfToken()))).toEqual({
      ok: false,
      reason: 'MISMATCH',
    });
  });

  it('refuses a token that is right except for one character', () => {
    const almost = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyCsrf(session, formWith(almost))).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('refuses a truncated token rather than matching its prefix', () => {
    expect(verifyCsrf(session, formWith(token.slice(0, 8)))).toEqual({
      ok: false,
      reason: 'MISMATCH',
    });
  });

  it('refuses a non-string field, which is what a file upload posts', () => {
    const form = new FormData();
    form.set(CSRF_FIELD, new Blob(['not-a-token']));
    expect(verifyCsrf(session, form)).toEqual({ ok: false, reason: 'MISSING' });
  });

  it('mints a token that is not guessable and not reused', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newCsrfToken()));
    expect(tokens.size).toBe(50);
    for (const value of tokens) expect(value.length).toBeGreaterThanOrEqual(43);
  });
});
