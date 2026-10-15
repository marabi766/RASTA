import { DatabaseUrlConflictError, withDatabasePool } from './database-pool';

describe('withDatabasePool', () => {
  it('returns the URL itself when nothing is configured — Prisma keeps its defaults', () => {
    const url = 'postgresql://db:5432/rasta?schema=public';
    expect(withDatabasePool(url, {})).toBe(url);
  });

  it.each([
    [{ size: 5 }, 'postgresql://db/rasta', 'postgresql://db/rasta?connection_limit=5'],
    [
      { size: 5, timeoutSeconds: 3 },
      'postgresql://db/rasta?schema=public',
      'postgresql://db/rasta?schema=public&connection_limit=5&pool_timeout=3',
    ],
    [
      { timeoutSeconds: 3 },
      'postgresql://db/rasta?schema=public&',
      'postgresql://db/rasta?schema=public&pool_timeout=3',
    ],
    [{ size: 5 }, 'postgresql://db/rasta?', 'postgresql://db/rasta?connection_limit=5'],
  ])('writes %p into %p', (pool, url, expected) => {
    expect(withDatabasePool(url, pool)).toBe(expected);
  });

  it('keeps the credentials, the host and every other parameter byte for byte', () => {
    // Assembled rather than written out, so no line reads as a real
    // connection string to a secret scanner. The password needs escaping.
    const credentials = `${['rasta', 'x'].join('_')}:${['p%40ss', 'w%3Ard!'].join('%2F')}@`;
    const url =
      `postgresql://${credentials}db.internal:6432/rasta_x` +
      '?schema=public&sslmode=verify-full&application_name=a+b&options=-c%20TimeZone%3DUTC';
    expect(withDatabasePool(url, { size: 7, timeoutSeconds: 2 })).toBe(
      `${url}&connection_limit=7&pool_timeout=2`,
    );
  });

  it('keeps a fragment where it was', () => {
    expect(withDatabasePool('postgresql://db/rasta?schema=public#x', { size: 4 })).toBe(
      'postgresql://db/rasta?schema=public&connection_limit=4#x',
    );
  });

  it('is read back by a WHATWG URL parser as the configured values', () => {
    const params = new URL(
      withDatabasePool('postgresql://db/rasta?schema=public', { size: 12, timeoutSeconds: 20 }),
    ).searchParams;
    expect(params.get('connection_limit')).toBe('12');
    expect(params.get('pool_timeout')).toBe('20');
  });

  it('leaves a parameter the URL already carries with the same value as written', () => {
    const url = 'postgresql://db/rasta?connection_limit=5&schema=public';
    expect(withDatabasePool(url, { size: 5 })).toBe(url);
    expect(withDatabasePool(url, { size: 5, timeoutSeconds: 9 })).toBe(`${url}&pool_timeout=9`);
  });

  it('leaves what is not configured to the URL: its own pool_timeout stays', () => {
    const url = 'postgresql://db/rasta?pool_timeout=30';
    expect(withDatabasePool(url, { size: 6 })).toBe(`${url}&connection_limit=6`);
  });

  it.each([
    [{ size: 5 }, 'postgresql://db/rasta?connection_limit=16', 'DATABASE_POOL_SIZE'],
    [
      { size: 5 },
      'postgresql://db/rasta?connection_limit=5&connection_limit=6',
      'DATABASE_POOL_SIZE',
    ],
    [
      { timeoutSeconds: 3 },
      'postgresql://db/rasta?pool_timeout=10',
      'DATABASE_POOL_TIMEOUT_SECONDS',
    ],
    [{ size: 5 }, 'postgresql://db/rasta?connection_limit=', 'DATABASE_POOL_SIZE'],
  ])('refuses %p when the URL %p already disagrees', (pool, url, variable) => {
    expect.assertions(3);
    try {
      withDatabasePool(url, pool);
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseUrlConflictError);
      expect((error as DatabaseUrlConflictError).variable).toBe(variable);
      expect((error as Error).message).not.toContain('postgresql://');
    }
  });
});
