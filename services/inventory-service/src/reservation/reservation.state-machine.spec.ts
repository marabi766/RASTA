import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESERVATION_STATES } from './dto';
import { RESERVATION_TRANSITIONS, canMove } from './reservation.state-machine';

const MIGRATION = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'prisma',
    'migrations',
    '20261013120000_init_inventory',
    'migration.sql',
  ),
  'utf8',
);

describe('the reservation lifecycle (ADR-056 § 3)', () => {
  it('ends an ACTIVE reservation by issue, release or expiry', () => {
    expect(canMove('ACTIVE', 'CONSUMED')).toBe(true);
    expect(canMove('ACTIVE', 'RELEASED')).toBe(true);
    expect(canMove('ACTIVE', 'EXPIRED')).toBe(true);
  });

  it('never moves an ended reservation, and never back to ACTIVE', () => {
    for (const from of ['CONSUMED', 'RELEASED', 'EXPIRED'] as const) {
      for (const to of RESERVATION_STATES) {
        expect([from, to, canMove(from, to)]).toEqual([from, to, false]);
      }
    }
    expect(canMove('ACTIVE', 'ACTIVE')).toBe(false);
  });

  it('names every state the database declares, and no other', () => {
    expect(Object.keys(RESERVATION_TRANSITIONS).sort()).toEqual([...RESERVATION_STATES].sort());
    expect(MIGRATION).toContain(
      `CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');`,
    );
  });
});
