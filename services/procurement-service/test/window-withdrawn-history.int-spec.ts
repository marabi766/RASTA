import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { PrismaClient } from '../src/generated/prisma';
import { buyer, client, startApi, TestClock, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId, ownerDatabaseUrl } from './helpers';

/**
 * A window's withdrawn history costs its commands nothing (PR-327 r3 F1).
 *
 * The live-demand limit bounds what a window counts, not what it ever held: a withdrawal frees a
 * place, but the withdrawn row stays. Submitting and withdrawing keeps a window small while its
 * history grows without end — under EXTEND below its threshold, for ever. Every submit and every
 * withdrawal queues the deferred totals check, which rescans the window's counted demands under
 * the window's lock; were that rescan to read the withdrawn rows too, each command would grow with
 * the history until it outran its budget, and the late EXTEND submit that rolled back with it
 * would repeat on the next one.
 *
 * So each window here holds `HISTORY` withdrawn demands and `LIVE` live ones, and every
 * transaction the service runs is measured from inside: the rows and index entries of
 * `demand_request` it read — its statements and, forced at its end, its deferred checks — as
 * PostgreSQL counts them for the transaction itself (`pg_stat_get_xact_tuples_returned`). That
 * number does not depend on the machine, and it must stay a few times `LIVE` while the history is
 * `HISTORY`: before the fix the rescan read every withdrawn row, twice per command.
 *
 * The history is seeded through the owner connection, as `window-close-scale` seeds, then vacuumed
 * and analysed as autovacuum keeps a table of that size. Vacuumed, because the seed withdraws
 * 100,000 demands in one go: their earlier SUBMITTED versions are dead rows whose index entries a
 * scan visits until it has found them dead or vacuum removed them — one visit per withdrawal, once,
 * when they come one by one. Plans are measured with those statistics, and for an organization
 * whose whole history arrived after the last ANALYZE: the statistics do not know it, which is what
 * made the end's id query read the organization's history in id order.
 *
 * Not measured: a table of this size with no statistics at all, which autovacuum never leaves it
 * with. There the planner costed every index of the table alike and was seen taking even a
 * lookup by (organization, id) through `ix_demand_request_aggregation`.
 */
const HOUR = 3_600_000;
const MAX_QUANTITY = 2_147_483_647;
const T0 = new Date('2031-06-01T08:00:00.000Z');
const HISTORY = 100_000;
const LIVE = 3;
/** The most `demand_request` rows and entries one transaction may read: a few times `LIVE`. */
const READ_BOUND = 10 * (LIVE + 1);

jest.setTimeout(180_000);

/** `demand_request` rows and index entries the current transaction has read so far. */
async function demandRowsRead(tx: ExtendedPrismaClient): Promise<number> {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT coalesce(sum(pg_stat_get_xact_tuples_returned(c.oid)), 0)::bigint AS n
      FROM pg_class AS c
     WHERE c.oid = 'demand_request'::regclass
        OR c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid = 'demand_request'::regclass)`;
  return Number(rows[0]?.n ?? 0);
}

const bounded = (read: number) => ({ read, bounded: read <= READ_BOUND });

describe("a window's withdrawn history", () => {
  const organizations: string[] = [];
  const harnesses: ApiHarness[] = [];
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  let extendWindow: Seeded;
  let referWindow: Seeded;

  type Seeded = { organizationId: string; productId: string; aggregationId: string };

  beforeAll(async () => {
    extendWindow = await seedWindow('EXTEND');
    referWindow = await seedWindow('REFER');
    await owner.$executeRawUnsafe('VACUUM ANALYZE "demand_request"');
  }, 300_000);

  afterAll(async () => {
    try {
      // The seeded history first, in a transaction of its own size; then the usual cleanup.
      await owner.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "demand_request" DISABLE TRIGGER "tg_demand_request_guard"',
          );
          await tx.$executeRaw`
            DELETE FROM demand_request
             WHERE organization_id = ANY(${organizations}::text[]) AND status = 'WITHDRAWN'`;
          await tx.$executeRawUnsafe(
            'ALTER TABLE "demand_request" ENABLE TRIGGER "tg_demand_request_guard"',
          );
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      await cleanup(organizations);
    } finally {
      await owner.$disconnect();
      for (const harness of harnesses) await harness.close();
    }
  });

  /**
   * An OPEN window ending at T0 + 10 h under `policy`, never reaching its threshold: `HISTORY`
   * demands submitted and withdrawn, then `LIVE` still SUBMITTED.
   */
  async function seedWindow(policy: 'EXTEND' | 'REFER'): Promise<Seeded> {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const productId = newProductId();
    const tag = organizationId.slice(4);
    const aggregationId = `AGG_HIST_${tag}`;
    await owner.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "demand_request" DISABLE TRIGGER "tg_demand_request_totals_check"',
        );
        await tx.$executeRaw`
          INSERT INTO demand_aggregation
            (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
             min_quantity, shortfall_policy, setting_version, total_quantity, demand_count,
             extension_count, created_at, updated_at, version)
          VALUES (${aggregationId}, ${organizationId}, ${productId}, 'OPEN', ${T0},
                  ${new Date(T0.getTime() + 10 * HOUR)}, 10, ${MAX_QUANTITY}, ${policy}, NULL,
                  ${LIVE}, ${LIVE}, 0, ${T0}, ${T0}, 1)`;
        // Demand n is submitted at T0 + n ms; the first HISTORY are withdrawn a second later.
        await tx.$executeRaw`
          INSERT INTO demand_request
            (id, organization_id, aggregation_id, product_id, quantity, status, submitted_at,
             submitted_by, submitted_correlation_id, created_at, updated_at, version)
          SELECT 'DMD_HIST_' || lpad(n::text, 8, '0') || '_' || ${tag},
                 ${organizationId}, ${aggregationId}, ${productId}, 1, 'SUBMITTED',
                 ${T0}::timestamptz + make_interval(secs => n / 1000.0),
                 'USR-HISTORY-SEED', 'corr-history-seed',
                 ${T0}::timestamptz + make_interval(secs => n / 1000.0),
                 ${T0}::timestamptz + make_interval(secs => n / 1000.0), 1
            FROM generate_series(1, ${HISTORY + LIVE}::int) AS n`;
        const withdrawn = await tx.$executeRaw`
          UPDATE demand_request
             SET status = 'WITHDRAWN', withdrawn_at = submitted_at + interval '1 second',
                 withdrawn_by = 'USR-HISTORY-SEED', withdraw_reason = 'seeded withdrawal history',
                 updated_at = submitted_at + interval '1 second', version = 2
           WHERE organization_id = ${organizationId} AND aggregation_id = ${aggregationId}
             AND id <= 'DMD_HIST_' || lpad(${HISTORY}::text, 8, '0') || '_' || ${tag}`;
        expect(withdrawn).toBe(HISTORY);
        await tx.$executeRawUnsafe(
          'ALTER TABLE "demand_request" ENABLE TRIGGER "tg_demand_request_totals_check"',
        );
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    return { organizationId, productId, aggregationId };
  }

  /** The API, every transaction of which records the `demand_request` rows it read. */
  async function measuredApi(policy: 'EXTEND' | 'REFER', clock: TestClock) {
    const harness = await startApi(
      {
        PROCUREMENT_AGGREGATION_WINDOW_HOURS: '10',
        PROCUREMENT_AGGREGATION_MIN_QUANTITY: String(MAX_QUANTITY),
        PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: policy,
      },
      { clock },
    );
    harnesses.push(harness);
    const reads: number[] = [];
    const transaction = harness.prisma.transaction.bind(harness.prisma);
    jest.spyOn(harness.prisma, 'transaction').mockImplementation(((fn, options) =>
      transaction(async (tx) => {
        const before = await demandRowsRead(tx);
        const result = await fn(tx);
        // The deferred checks run here instead of at commit, so they are counted too.
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        reads.push((await demandRowsRead(tx)) - before);
        return result;
      }, options)) as typeof harness.prisma.transaction);
    /** The most any transaction since the last call read; cleared. */
    const mostRead = () => Math.max(0, ...reads.splice(0));
    return { harness, mostRead };
  }

  /** The late submit that ends a REFER window; what its transactions read at most. */
  async function referLate(seeded: Seeded): Promise<number> {
    const clock = new TestClock();
    const { harness, mostRead } = await measuredApi('REFER', clock);
    const as = client(harness, buyer(seeded.organizationId));
    clock.set(new Date(T0.getTime() + 10 * HOUR));
    const late = await as.submit({ productId: seeded.productId, quantity: 1 });
    expect(late.status).toBe(201);
    expect(late.body.aggregationId).not.toBe(seeded.aggregationId);
    const read = mostRead();
    expect((await as.aggregation(seeded.aggregationId)).body).toMatchObject({
      status: 'REFERRED',
      demandCount: LIVE,
      totalQuantity: LIVE,
    });
    return read;
  }

  it(`EXTEND below its threshold: with ${HISTORY} withdrawn demands and ${LIVE} live, submits, withdrawals and the late submit that extends the window each read at most ${READ_BOUND} demand rows`, async () => {
    const seeded = extendWindow;
    const clock = new TestClock();
    const { harness, mostRead } = await measuredApi('EXTEND', clock);
    const as = client(harness, buyer(seeded.organizationId));

    clock.set(new Date(T0.getTime() + 9 * HOUR));
    const churn: { submit: number; withdraw: number }[] = [];
    for (let round = 0; round < 3; round += 1) {
      const submitted = await as.submit({ productId: seeded.productId, quantity: 1 });
      expect(submitted.status).toBe(201);
      expect(submitted.body.aggregationId).toBe(seeded.aggregationId);
      const submit = mostRead();
      const withdrawn = await as.withdraw(submitted.body.id, submitted.body.version);
      expect(withdrawn.status).toBe(200);
      churn.push({ submit, withdraw: mostRead() });
    }

    // The window's end, under EXTEND short of its threshold: it moves on, and the demand joins.
    clock.set(new Date(T0.getTime() + 10 * HOUR));
    const late = await as.submit({ productId: seeded.productId, quantity: 1 });
    expect(late.status).toBe(201);
    expect(late.body.aggregationId).toBe(seeded.aggregationId);
    const extend = mostRead();

    const reads = [...churn.flatMap(({ submit, withdraw }) => [submit, withdraw]), extend];
    expect(reads.map(bounded)).toEqual(reads.map((read) => ({ read, bounded: true })));
    expect((await as.aggregation(seeded.aggregationId)).body).toMatchObject({
      status: 'OPEN',
      extensionCount: 1,
      demandCount: LIVE + 1,
      totalQuantity: LIVE + 1,
    });
  });

  it(`REFER: with ${HISTORY} withdrawn demands and ${LIVE} live, the late submit that ends the window reads at most ${READ_BOUND} demand rows`, async () => {
    expect(bounded(await referLate(referWindow))).toEqual(
      expect.objectContaining({ bounded: true }),
    );
  });

  it(`REFER, for an organization whose ${HISTORY} withdrawn demands arrived after the last ANALYZE: the late submit that ends its window reads at most ${READ_BOUND} demand rows`, async () => {
    const unseen = await seedWindow('REFER');
    // Vacuumed, not analysed: the dead rows are gone, and the statistics still do not know it.
    await owner.$executeRawUnsafe('VACUUM "demand_request"');
    expect(bounded(await referLate(unseen))).toEqual(expect.objectContaining({ bounded: true }));
  });
});
