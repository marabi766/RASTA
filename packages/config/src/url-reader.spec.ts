import { inspect } from 'node:util';
import { z } from 'zod';
import { loadEnv, serviceUrlSchema, URL_CREDENTIALS_REFUSED } from './env';
import { UNREADABLE_URL, UnreadableUrlError, readUrl, tryReadUrl } from './url-reader';

/**
 * The shared URL reader refuses with a fixed text and nothing else (#385 r5):
 * `new URL`'s own TypeError keeps the input on `.input` and the base on
 * `.base`, which an uncaught throw prints — a password included.
 */

/** The two sentinels of `scripts/refusal-probes.mjs`: a username and a password. */
const USER = 'private-sentinel-79';
const PASSWORD = 'JZ97-another-secret';
const SENTINEL = /sentinel|jz97|another[-_]secret/i;
/** Valid credentials, a port that is not one. */
const UNREADABLE = `postgresql://${USER}:${PASSWORD}@127.0.0.1:bad/db`;

/** Everything a thrown value can print: message, stack, own properties, inspection. */
function everythingOf(error: unknown): string {
  const value = error as Error;
  return [
    value.message,
    value.stack ?? '',
    JSON.stringify(value, Object.getOwnPropertyNames(value)),
    inspect(value, { depth: 10, showHidden: true }),
    value.cause === undefined ? '' : inspect(value.cause, { depth: 10, showHidden: true }),
  ].join('\n');
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('readUrl', () => {
  it('the control: new URL itself carries the input and the base', () => {
    const native = thrownBy(() => new URL(UNREADABLE));
    expect(everythingOf(native)).toMatch(SENTINEL);
    const withBase = thrownBy(() => new URL('/x', UNREADABLE));
    expect(everythingOf(withBase)).toMatch(SENTINEL);
  });

  it.each([
    ['an unreadable URL', () => readUrl(UNREADABLE)],
    ['an unreadable base', () => readUrl('/v1/users', { base: UNREADABLE })],
    ['a value that is not a string', () => readUrl({ toString: () => UNREADABLE })],
    ['a base that is not a string or URL', () => readUrl('/x', { base: 42 as unknown as string })],
  ])('refuses %s with a fresh fixed error and nothing else', (_name, read) => {
    const error = thrownBy(read);
    expect(error).toBeInstanceOf(UnreadableUrlError);
    expect((error as Error).message).toBe(UNREADABLE_URL);
    expect((error as Error).cause).toBeUndefined();
    expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'name', 'stack']);
    expect(everythingOf(error)).not.toMatch(SENTINEL);
  });

  it("refuses with the caller's fixed text when given one", () => {
    const error = thrownBy(() => readUrl(UNREADABLE, { refusal: 'DATABASE_URL_X cannot be read' }));
    expect((error as Error).message).toBe('DATABASE_URL_X cannot be read');
    expect(everythingOf(error)).not.toMatch(SENTINEL);
  });

  it('reads what new URL reads, against a base too', () => {
    const url = readUrl(`postgresql://${USER}:${PASSWORD}@db:5432/x?schema=s`);
    expect([url.username, url.password, url.host, url.searchParams.get('schema')]).toEqual([
      USER,
      PASSWORD,
      'db:5432',
      's',
    ]);
    expect(readUrl('/v1/users', { base: 'http://identity:3101' }).href).toBe(
      'http://identity:3101/v1/users',
    );
    expect(readUrl('/v1', { base: new URL('http://h/') }).href).toBe('http://h/v1');
  });

  it('tryReadUrl answers null for anything readUrl refuses', () => {
    expect(tryReadUrl(UNREADABLE)).toBeNull();
    expect(tryReadUrl(undefined)).toBeNull();
    expect(tryReadUrl('/x', UNREADABLE)).toBeNull();
    expect(tryReadUrl('http://h/')?.href).toBe('http://h/');
  });
});

describe('serviceUrlSchema', () => {
  const schema = z.object({ IDENTITY_SERVICE_URL: serviceUrlSchema });

  it('takes an http(s) URL without credentials', () => {
    expect(loadEnv(schema, { IDENTITY_SERVICE_URL: 'http://identity:3101' })).toEqual({
      IDENTITY_SERVICE_URL: 'http://identity:3101',
    });
  });

  it.each([
    `http://${USER}:${PASSWORD}@identity:3101`,
    `http://${USER}@identity:3101`,
    `https://:${PASSWORD}@identity`,
  ])('refuses a URL with a username or password, by name only: %#', (value) => {
    const error = thrownBy(() => loadEnv(schema, { IDENTITY_SERVICE_URL: value }));
    expect((error as Error).message).toContain(`IDENTITY_SERVICE_URL: ${URL_CREDENTIALS_REFUSED}`);
    expect(everythingOf(error)).not.toMatch(SENTINEL);
  });

  it('still refuses what httpUrlSchema refuses, by name only', () => {
    for (const value of [UNREADABLE, `ftp://${USER}@h/`, 'localhost:3101']) {
      const error = thrownBy(() => loadEnv(schema, { IDENTITY_SERVICE_URL: value }));
      expect((error as Error).message).toContain('IDENTITY_SERVICE_URL');
      expect(everythingOf(error)).not.toMatch(SENTINEL);
    }
  });
});
