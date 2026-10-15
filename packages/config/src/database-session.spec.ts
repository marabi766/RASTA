import { DatabaseUrlConflictError } from './database-pool';
import { UTC_SESSION_OPTION, withStatementTimeout, withUtcSession } from './database-session';

/** The option as it appears in a connection string. */
const ENCODED = 'options=-c%20TimeZone%3DUTC';

describe('withUtcSession (L7-37)', () => {
  it.each([
    ['postgresql://db:5432/rasta', `postgresql://db:5432/rasta?${ENCODED}`],
    [
      'postgresql://db:5432/rasta?schema=public',
      `postgresql://db:5432/rasta?schema=public&${ENCODED}`,
    ],
    [
      'postgres://db:5432/rasta?schema=audit&connection_limit=3',
      `postgres://db:5432/rasta?schema=audit&connection_limit=3&${ENCODED}`,
    ],
  ])('adds the option to %p', (url, expected) => {
    expect(withUtcSession(url)).toBe(expected);
  });

  it('keeps the credentials, the host and every other parameter byte for byte', () => {
    // Assembled rather than written out, so no line reads as a real
    // connection string to a secret scanner. The password needs escaping.
    const credentials = `${['rasta', 'x'].join('_')}:${['p%40ss', 'w%3Ard!'].join('%2F')}@`;
    const url =
      `postgresql://${credentials}db.internal:6432/rasta_x` +
      '?schema=public&sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem&application_name=a+b';
    expect(withUtcSession(url)).toBe(`${url}&${ENCODED}`);
  });

  it('goes after options the URL already carries, so an earlier TimeZone loses', () => {
    const out = withUtcSession(
      'postgresql://db/rasta?options=-c%20TimeZone%3DAsia%2FTehran&schema=public',
    );
    expect(out).toBe(
      'postgresql://db/rasta?schema=public&options=' +
        encodeURIComponent(`-c TimeZone=Asia/Tehran ${UTC_SESSION_OPTION}`),
    );
  });

  it('reads a + in the existing options as a space', () => {
    expect(withUtcSession('postgresql://db/rasta?options=-c+statement_timeout%3D5000')).toBe(
      'postgresql://db/rasta?options=' +
        encodeURIComponent(`-c statement_timeout=5000 ${UTC_SESSION_OPTION}`),
    );
  });

  it('is idempotent', () => {
    for (const url of [
      'postgresql://db/rasta',
      'postgresql://db/rasta?schema=public',
      'postgresql://db/rasta?options=-c%20search_path%3Dx',
    ]) {
      const once = withUtcSession(url);
      expect(withUtcSession(once)).toBe(once);
    }
  });

  it('applies it again when something came after it', () => {
    const url = `postgresql://db/rasta?options=${encodeURIComponent(
      `${UTC_SESSION_OPTION} -c TimeZone=Asia/Tehran`,
    )}`;
    expect(new URL(withUtcSession(url)).searchParams.get('options')).toBe(
      `${UTC_SESSION_OPTION} -c TimeZone=Asia/Tehran ${UTC_SESSION_OPTION}`,
    );
  });

  it('keeps a fragment where it was', () => {
    expect(withUtcSession('postgresql://db/rasta?schema=public#x')).toBe(
      `postgresql://db/rasta?schema=public&${ENCODED}#x`,
    );
  });

  it('is read back as the option by a WHATWG URL parser', () => {
    expect(
      new URL(withUtcSession('postgresql://db/rasta?schema=public')).searchParams.get('options'),
    ).toBe(UTC_SESSION_OPTION);
  });
});

describe('withStatementTimeout', () => {
  const options = (url: string) => new URL(url).searchParams.get('options');

  it.each([
    ['postgresql://db/rasta', '-c statement_timeout=15000'],
    [
      'postgresql://db/rasta?options=-c%20search_path%3Dx',
      '-c search_path=x -c statement_timeout=15000',
    ],
    [
      withUtcSession('postgresql://db/rasta?schema=public'),
      `-c statement_timeout=15000 ${UTC_SESSION_OPTION}`,
    ],
  ])('adds the option to %p, keeping UTC last', (url, expected) => {
    expect(options(withStatementTimeout(url, 15_000))).toBe(expected);
  });

  it('keeps every other parameter and the fragment', () => {
    expect(
      withStatementTimeout('postgresql://db/rasta?schema=public&connection_limit=3#x', 2000),
    ).toBe(
      'postgresql://db/rasta?schema=public&connection_limit=3&options=' +
        `${encodeURIComponent('-c statement_timeout=2000')}#x`,
    );
  });

  it('is idempotent, and leaves withUtcSession idempotent on its result', () => {
    const once = withStatementTimeout(withUtcSession('postgresql://db/rasta'), 2000);
    expect(withStatementTimeout(once, 2000)).toBe(once);
    expect(withUtcSession(once)).toBe(once);
  });

  it.each([
    [
      'two options parameters (Codex r5 F1)',
      'options=-c%20statement_timeout%3D15000&options=-c%20TimeZone%3DUTC',
    ],
    ['a raw tab (Codex r5 F2)', 'options=-c%20sta\ttement_timeout%3D1000%20-c%20TimeZone%3DUTC'],
  ])('both, and every caller of withUtcSession (seeds, CLIs), refuse %s', (_, query) => {
    // Assembled, as above, so no line reads as a real connection string.
    const password = ['session', 'spec', 'pw'].join('_');
    const url = `postgresql://rasta_x:${password}@db.internal/rasta?${query}`;
    for (const call of [
      () => withUtcSession(url),
      () => withStatementTimeout(url, undefined),
      () => withStatementTimeout(url, 15_000),
    ]) {
      let caught: unknown;
      try {
        call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DatabaseUrlConflictError);
      expect(caught).toMatchObject({ variable: 'DATABASE_URL', parameter: 'options' });
      expect((caught as Error).message).not.toContain(password);
      expect((caught as Error).message).not.toContain('db.internal');
    }
  });

  it('refuses another value already in the options, naming the variable and not the URL', () => {
    expect.assertions(3);
    try {
      withStatementTimeout('postgresql://db/rasta?options=-c+statement_timeout%3D5s', 15_000);
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseUrlConflictError);
      expect((error as DatabaseUrlConflictError).variable).toBe('DATABASE_STATEMENT_TIMEOUT_MS');
      expect((error as Error).message).not.toContain('postgresql://');
    }
  });
});
