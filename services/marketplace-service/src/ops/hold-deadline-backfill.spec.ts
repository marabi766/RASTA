import { commandFailure } from '@rasta/config';
import {
  BackfillRefused,
  D150_RELEASED_AT,
  backfillLegacyHoldDeadlines,
  checkedOptions,
  parseBackfillArgs,
} from './hold-deadline-backfill';

/** FU-234: what the operator must say before the backfill touches the database. */
const SINCE = '2026-11-08T10:00:00+03:30';
const WHO = ['--operator', 'jane.doe@example.org', '--ticket', 'OPS-1234'];
const args = (...rest: string[]) => ['--economic-rule-since', SINCE, ...WHO, ...rest];
const refusedAs = (code: string, fn: () => unknown) => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BackfillRefused);
  expect(commandFailure(thrown)).toMatch(`command refused (code ${code})`);
};

describe('the hold-deadline backfill’s command line', () => {
  it('takes an explicit, exact instant and who runs it, a dry run by default', () => {
    expect(parseBackfillArgs(args())).toEqual({
      apply: false,
      economicRuleSince: '2026-11-08T06:30:00.000Z',
      operator: 'jane.doe@example.org',
      ticket: 'OPS-1234',
      batchSize: 200,
      maxBatches: 100,
    });
    for (const [given, instant] of [
      ['2026-11-08T06:30Z', '2026-11-08T06:30:00.000Z'],
      ['2026-11-08T06:30:00.5Z', '2026-11-08T06:30:00.500Z'],
      ['2026-11-08T02:00:00-04:30', '2026-11-08T06:30:00.000Z'],
      ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
      [D150_RELEASED_AT, D150_RELEASED_AT],
    ]) {
      expect(parseBackfillArgs(['--economic-rule-since', given!, ...WHO]).economicRuleSince).toBe(
        instant,
      );
    }
  });

  it.each([
    ['a day the month does not have', '2026-02-30T00:00Z'],
    ['November 31st', '2026-11-31T00:00Z'],
    ['not a leap year', '2027-02-29T00:00:00Z'],
    ['hour 24', '2026-11-08T24:00Z'],
    ['minute 60', '2026-11-08T10:60:00Z'],
    ['a leap second', '2026-11-08T10:00:60Z'],
    ['month 13', '2026-13-01T00:00Z'],
    ['day 00', '2026-11-00T00:00Z'],
    ['more than milliseconds', '2026-11-08T10:00:00.1234Z'],
    ['an offset past 14:00', '2026-11-08T10:00:00+14:30'],
    ['an offset hour past 14', '2026-11-08T10:00:00-15:00'],
    ['offset minutes past 59', '2026-11-08T10:00:00+03:60'],
    ['no zone', '2026-11-08T10:00:00'],
    ['a date alone', '2026-11-08'],
    ['year one', '0001-01-01T00:00Z'],
    ['before D-150 reached main', '2026-11-07T16:20:22.999Z'],
    ['the same instant in another zone, before D-150', '2026-11-07T19:50:22+03:30'],
  ])('refuses an instant with %s', (_name, instant) => {
    refusedAs('usage', () => parseBackfillArgs(['--economic-rule-since', instant, ...WHO]));
  });

  it.each([
    ['no operator', ['--economic-rule-since', SINCE, '--ticket', 'OPS-1']],
    ['no ticket', ['--economic-rule-since', SINCE, '--operator', 'jane']],
    ['a blank operator', ['--economic-rule-since', SINCE, '--operator', ' ', '--ticket', 'OPS-1']],
    ['an empty ticket', ['--economic-rule-since', SINCE, '--operator', 'jane', '--ticket', '']],
    ['an operator with a space', [...args(), '--operator', 'jane doe']],
    ['a ticket with a newline', [...args(), '--ticket', 'OPS-1\nOPS-2']],
    ['an operator of 129 characters', [...args(), '--operator', `j${'a'.repeat(128)}`]],
    ['no instant', WHO],
    ['--apply alone', ['--apply']],
    ['--dry-run with --apply', args('--apply', '--dry-run')],
    ['a zero batch', args('--batch-size', '0')],
    ['an exponent', args('--max-batches', '1e3')],
    ['an unknown option', args('--force')],
    ['a prototype name', args('toString', '1')],
    ['a flag without its value', args('--ticket')],
  ])('refuses %s', (_name, argv) => {
    refusedAs('usage', () => parseBackfillArgs(argv));
  });

  it('a caller that skips the parser is held to the same options, before any query', async () => {
    const options = parseBackfillArgs(args('--apply'));
    const untouched = new Proxy(
      {},
      {
        get() {
          throw new Error('the database was reached');
        },
      },
    ) as Parameters<typeof backfillLegacyHoldDeadlines>[0];
    for (const bad of [
      { operator: '' },
      { ticket: '   ' },
      { operator: undefined as unknown as string },
      { economicRuleSince: '2026-02-30T00:00:00.000Z' },
      { economicRuleSince: '2026-11-08T10:00:00+03:30' },
      { economicRuleSince: '0001-01-01T00:00:00.000Z' },
      { batchSize: 0 },
      { maxBatches: 1.5 },
    ]) {
      refusedAs('usage', () => checkedOptions({ ...options, ...bad }));
      await expect(
        backfillLegacyHoldDeadlines(untouched, { ...options, ...bad }),
      ).rejects.toBeInstanceOf(BackfillRefused);
    }
    expect(checkedOptions(options)).toBe(options);
  });
});
