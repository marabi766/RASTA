import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every instant this schema stores is `timestamptz(3)` (D-048).
 *
 * `20261012120000_document_instants_timestamptz` converted all seventeen; this
 * keeps the next column from arriving as a plain `DateTime`, which Prisma maps
 * to `timestamp(3)` — a wall time whose meaning depends on the session that
 * wrote it. The schema holds no calendar day; one would be `@db.Date`.
 */

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

const dateTimeFields = (): string[] =>
  [...SCHEMA.matchAll(/^\s*(\w+)\s+DateTime\??\s.*$/gm)].map((match) => match[0].trim());

describe('instants are timestamptz (D-048)', () => {
  it('finds the seventeen DateTime fields it is checking', () => {
    // Guards the guard: a pattern that stopped matching would pass vacuously.
    expect(dateTimeFields()).toHaveLength(17);
  });

  it('declares every DateTime as @db.Timestamptz(3)', () => {
    const plain = dateTimeFields().filter((line) => !/@db\.Timestamptz\(3\)/.test(line));
    expect(plain).toEqual([]);
  });
});
