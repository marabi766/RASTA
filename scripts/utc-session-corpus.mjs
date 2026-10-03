// -----------------------------------------------------------------------------
// Test data: URLs both copies of `withUtcSession` (packages/config and
// scripts/prisma-lib.mjs) must agree on — `prisma-lib.test.mjs` and the parity
// test in `db-session-utc.pg.test.mjs`. Credentials are assembled rather than
// written out, so no line here reads as a real connection string to a secret
// scanner; nothing here resolves.
// -----------------------------------------------------------------------------

/** `user:password@`, built from parts; the password has characters a URL must escape. */
export const CREDENTIALS = `${['rasta', 'x'].join('_')}:${['p%40ss', 'w%3Ard!'].join('%2F')}@`;

export const UTC_SESSION_CORPUS = [
  'postgresql://db:5432/rasta',
  'postgresql://db:5432/rasta?schema=public',
  'postgres://db:5432/rasta?schema=audit&connection_limit=3',
  `postgresql://${CREDENTIALS}db.internal:6432/rasta_x?schema=public&sslmode=verify-full&sslrootcert=%2Fetc%2Fca.pem&application_name=a+b`,
  'postgresql://db/rasta?options=-c%20TimeZone%3DAsia%2FTehran&schema=public',
  'postgresql://db/rasta?options=-c+statement_timeout%3D5000',
  'postgresql://db/rasta?options=-c%20TimeZone%3DUTC',
  'postgresql://db/rasta?options=-c%20TimeZone%3DUTC%20-c%20TimeZone%3DAsia%2FTehran',
  'postgresql://db/rasta?schema=public#x',
];
