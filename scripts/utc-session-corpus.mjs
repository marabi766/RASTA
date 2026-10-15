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

/**
 * URLs both copies refuse before reading any option (Codex r5 on #268): more
 * than one `options` parameter (the driver keeps only the last), and a raw
 * control character (a URL parser drops a tab, CR or LF and reads another name).
 */
export const UTC_SESSION_REFUSED = [
  `postgresql://${CREDENTIALS}db.internal/rasta?options=-c%20statement_timeout%3D15000&options=-c%20TimeZone%3DUTC`,
  'postgresql://db/rasta?options=-c%20TimeZone%3DUTC&options=-c%20statement_timeout%3D15000',
  'postgresql://db/rasta?options=-c%20search_path%3Dx&%6Fptions=-c%20TimeZone%3DUTC',
  'postgresql://db/rasta?options=-c%20TimeZone%3DUTC&options=',
  ...['\t', '\r', '\n', '\u0000', '\u001f', '\u007f'].map(
    (char) =>
      `postgresql://${CREDENTIALS}db.internal/rasta?options=-c%20sta${char}tement_timeout%3D1000%20-c%20TimeZone%3DUTC`,
  ),
  'postgresql://db/rasta?schema=public&application_name=a\tb',
];
