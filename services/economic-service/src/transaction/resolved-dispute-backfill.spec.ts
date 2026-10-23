import {
  RESOLVED_DISPUTE_BACKFILL_DEFAULTS,
  parseResolvedDisputeBackfillArgs,
} from './resolved-dispute-backfill';

/** The backfill's command line (Codex on #352, finding 1). Its effect: test/transaction-resolved-dispute.int-spec.ts. */
describe('parseResolvedDisputeBackfillArgs', () => {
  it('plans by default: writing needs --apply', () => {
    expect(parseResolvedDisputeBackfillArgs([])).toEqual(RESOLVED_DISPUTE_BACKFILL_DEFAULTS);
    expect(RESOLVED_DISPUTE_BACKFILL_DEFAULTS.apply).toBe(false);
  });

  it('reads every option', () => {
    expect(
      parseResolvedDisputeBackfillArgs([
        '--apply',
        '--batch-size',
        '200',
        '--max-batches',
        '10',
        '--after',
        'TXN_01J',
        '--statement-timeout-ms',
        '1500',
        '--lock-timeout-ms',
        '300',
      ]),
    ).toEqual({
      apply: true,
      batchSize: 200,
      maxBatches: 10,
      after: 'TXN_01J',
      statementTimeoutMs: 1500,
      lockTimeoutMs: 300,
    });
  });

  it.each([
    [['--batch-size', '0'], /--batch-size must be an integer in 1..5000/],
    [['--batch-size', '5001'], /1..5000/],
    [['--batch-size', '1e3'], /--batch-size must be an integer/],
    [['--statement-timeout-ms', '60001'], /100..60000/],
    [['--lock-timeout-ms', '99'], /100..10000/],
    [['--max-batches'], /--max-batches needs a value/],
    [['--after', '--apply'], /--after needs a value/],
    [['--dry'], /Unknown option --dry/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseResolvedDisputeBackfillArgs(argv)).toThrow(message);
  });
});
