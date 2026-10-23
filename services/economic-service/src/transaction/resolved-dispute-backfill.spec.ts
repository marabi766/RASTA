import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import {
  RESOLVED_DISPUTE_BACKFILL_DEFAULTS,
  backfillExitCode,
  backfillResolvedDisputes,
  parseResolvedDisputeBackfillArgs,
  type ResolvedDisputeBackfillEvent,
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

/**
 * The run's control flow over a scripted database: what it counts, when it
 * stops and what it says. What the SQL does to real rows, and under real
 * locks, is the integration spec's.
 */
describe('backfillResolvedDisputes — the run', () => {
  type Row = Record<string, unknown>;
  /** Answers each count with the next of `counts`, each batch with the next of `batches`. */
  function database(counts: Row[][], batches: (Row[] | { throws: unknown })[]) {
    const statements: string[] = [];
    const queryRaw = jest.fn(async (sql: TemplateStringsArray) => {
      const text = sql.join('?');
      statements.push(text);
      if (text.includes('AS n FROM')) return counts.shift() ?? [];
      if (text.includes('set_config')) return [];
      const next = batches.shift() ?? [];
      if ('throws' in next) throw next.throws;
      return next;
    });
    const tx = { $queryRaw: queryRaw };
    const client = {
      $queryRaw: queryRaw,
      $transaction: jest.fn(async (work: (t: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as ExtendedPrismaClient;
    return { client, statements };
  }
  const run = (client: ExtendedPrismaClient, options: object) => {
    const events: ResolvedDisputeBackfillEvent[] = [];
    return backfillResolvedDisputes(
      client,
      { ...RESOLVED_DISPUTE_BACKFILL_DEFAULTS, ...options },
      (event) => events.push(event),
    ).then((summary) => ({ summary, events }));
  };
  const batch = (scanned: number, attributed: number, last_id: string | null) => [
    { scanned, attributed, last_id },
  ];

  it('plans without writing, and without being asked to report', async () => {
    const { client, statements } = database([[{ n: 4 }]], []);
    await expect(
      backfillResolvedDisputes(client, RESOLVED_DISPUTE_BACKFILL_DEFAULTS),
    ).resolves.toMatchObject({ status: 'planned', unattributed: 4, batches: 0 });
    expect(statements.some((sql) => sql.includes('UPDATE'))).toBe(false);
  });

  it('reads batch after batch from where the last stopped, to a short one: done', async () => {
    const { client, statements } = database(
      [[{ n: 3 }], [{ n: 0 }]],
      [batch(2, 2, 'TXN_B'), batch(1, 1, 'TXN_C')],
    );
    const { summary, events } = await run(client, { apply: true, batchSize: 2 });
    expect(summary).toEqual({
      event: 'summary',
      status: 'done',
      batches: 2,
      attributed: 3,
      unattributed: 0,
      lastId: 'TXN_C',
    });
    expect(events.map((event) => event.event)).toEqual(['plan', 'batch', 'batch', 'summary']);
    // Each batch sets its own timeouts first, inside its transaction.
    expect(statements.filter((sql) => sql.includes('set_config'))).toHaveLength(2);
  });

  it('an empty table, or a database that answers nothing: no batch, and nothing claimed', async () => {
    const { client } = database([[], []], [[]]);
    const { summary } = await run(client, { apply: true });
    expect(summary).toMatchObject({ status: 'done', batches: 0, attributed: 0, unattributed: 0 });

    const empty = database([[{ n: 0 }], [{ n: 0 }]], [batch(0, 0, null)]);
    expect((await run(empty.client, { apply: true })).summary.batches).toBe(0);
  });

  it('at the end with rows still unattributed — before a resumed run’s `after` — says so', async () => {
    const { client } = database([[{ n: 2 }], [{ n: 1 }]], [batch(1, 1, 'TXN_Z')]);
    const { summary } = await run(client, { apply: true, after: 'TXN_M', batchSize: 5 });
    expect(summary).toMatchObject({ status: 'incomplete', unattributed: 1, lastId: 'TXN_Z' });
  });

  it('stops after --max-batches, naming where to resume', async () => {
    const { client } = database([[{ n: 9 }], [{ n: 7 }]], [batch(2, 2, 'TXN_B')]);
    const { summary } = await run(client, { apply: true, batchSize: 2, maxBatches: 1 });
    expect(summary).toMatchObject({
      status: 'incomplete',
      batches: 1,
      unattributed: 7,
      lastId: 'TXN_B',
    });
  });

  it('a batch that fails stops the run where it was, with the database’s error code', async () => {
    const lock = Object.assign(new Error('lock timeout'), { meta: { code: '55P03' } });
    const { client } = database([[{ n: 5 }], [{ n: 3 }]], [batch(2, 2, 'TXN_B'), { throws: lock }]);
    const { summary, events } = await run(client, { apply: true, batchSize: 2 });
    expect(summary).toMatchObject({ status: 'failed', batches: 1, attributed: 2, lastId: 'TXN_B' });
    expect(events).toContainEqual({ event: 'failed', batch: 2, after: 'TXN_B', code: '55P03' });

    for (const thrown of [new Error('connection reset'), 'not an error', null]) {
      const failing = database([[{ n: 1 }], [{ n: 1 }]], [{ throws: thrown }]);
      const outcome = await run(failing.client, { apply: true });
      expect(outcome.events).toContainEqual({ event: 'failed', batch: 1, after: '', code: null });
    }
  });

  it('exits 0 only for a plan or a finished run', () => {
    expect(
      ['planned', 'done', 'incomplete', 'failed'].map((status) => backfillExitCode({ status })),
    ).toEqual([0, 0, 1, 1]);
  });
});
