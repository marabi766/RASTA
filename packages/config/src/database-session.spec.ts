import { UTC_SESSION_OPTION, withUtcSession } from './database-session';

/** The option as it appears in a connection string. */
const ENCODED = 'options=-c%20TimeZone%3DUTC';

describe('withUtcSession (L7-37)', () => {
  it.each([
    ['postgresql://u:p@db:5432/rasta', `postgresql://u:p@db:5432/rasta?${ENCODED}`],
    [
      'postgresql://u:p@db:5432/rasta?schema=public',
      `postgresql://u:p@db:5432/rasta?schema=public&${ENCODED}`,
    ],
    [
      'postgres://u:p@db:5432/rasta?schema=audit&connection_limit=3',
      `postgres://u:p@db:5432/rasta?schema=audit&connection_limit=3&${ENCODED}`,
    ],
  ])('adds the option to %p', (url, expected) => {
    expect(withUtcSession(url)).toBe(expected);
  });

  it('keeps the credentials, the host and every other parameter byte for byte', () => {
    const url =
      'postgresql://rasta_x:p%40ss%2Fw%3Ard!@db.internal:6432/rasta_x' +
      '?schema=public&sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem&application_name=a+b';
    expect(withUtcSession(url)).toBe(`${url}&${ENCODED}`);
  });

  it('goes after options the URL already carries, so an earlier TimeZone loses', () => {
    const out = withUtcSession(
      'postgresql://u:p@db/rasta?options=-c%20TimeZone%3DAsia%2FTehran&schema=public',
    );
    expect(out).toBe(
      'postgresql://u:p@db/rasta?schema=public&options=' +
        encodeURIComponent(`-c TimeZone=Asia/Tehran ${UTC_SESSION_OPTION}`),
    );
  });

  it('reads a + in the existing options as a space', () => {
    expect(withUtcSession('postgresql://u:p@db/rasta?options=-c+statement_timeout%3D5000')).toBe(
      'postgresql://u:p@db/rasta?options=' +
        encodeURIComponent(`-c statement_timeout=5000 ${UTC_SESSION_OPTION}`),
    );
  });

  it('is idempotent', () => {
    for (const url of [
      'postgresql://u:p@db/rasta',
      'postgresql://u:p@db/rasta?schema=public',
      'postgresql://u:p@db/rasta?options=-c%20search_path%3Dx',
    ]) {
      const once = withUtcSession(url);
      expect(withUtcSession(once)).toBe(once);
    }
  });

  it('applies it again when something came after it', () => {
    const url = `postgresql://u:p@db/rasta?options=${encodeURIComponent(
      `${UTC_SESSION_OPTION} -c TimeZone=Asia/Tehran`,
    )}`;
    expect(new URL(withUtcSession(url)).searchParams.get('options')).toBe(
      `${UTC_SESSION_OPTION} -c TimeZone=Asia/Tehran ${UTC_SESSION_OPTION}`,
    );
  });

  it('keeps a fragment where it was', () => {
    expect(withUtcSession('postgresql://u:p@db/rasta?schema=public#x')).toBe(
      `postgresql://u:p@db/rasta?schema=public&${ENCODED}#x`,
    );
  });

  it('is read back as the option by a WHATWG URL parser', () => {
    expect(
      new URL(withUtcSession('postgresql://u:p@db/rasta?schema=public')).searchParams.get(
        'options',
      ),
    ).toBe(UTC_SESSION_OPTION);
  });
});
