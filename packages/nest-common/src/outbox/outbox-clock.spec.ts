import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTBOX_NOW } from './outbox-sql';

/**
 * One clock (FU-188, PR-881 r1 F2): a write and the comparison against it cannot drift
 * apart if there is only one text. Precision, format or row type edited in one place
 * would otherwise show only on the column type that place was tested with.
 */
describe('OUTBOX_NOW is the only database clock of the outbox statements', () => {
  const source = readFileSync(join(__dirname, 'outbox-sql.ts'), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/export const OUTBOX_NOW = `[\s\S]*?`;/, '');

  it('it is UTC, floored, decoded through the table, and evaluated once', () => {
    expect(OUTBOX_NOW).toContain("date_trunc('milliseconds', now() AT TIME ZONE 'UTC')");
    expect(OUTBOX_NOW).toContain('jsonb_populate_record(NULL::outbox_message');
    expect(OUTBOX_NOW.startsWith('(SELECT ')).toBe(true);
  });

  it.each([
    'now()',
    'clock_timestamp',
    'statement_timestamp',
    'transaction_timestamp',
    'CURRENT_TIMESTAMP',
    'jsonb_populate_record',
  ])('no statement spells %s itself', (clock) => {
    expect(code.toLowerCase()).not.toContain(clock.toLowerCase());
  });

  it('every write and every comparison reaches for it', () => {
    const sites = code.match(/\$\{OUTBOX_NOW\}/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(13);
  });
});
