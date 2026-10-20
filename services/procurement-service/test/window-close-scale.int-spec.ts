import { PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS } from '@rasta/config';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { ulid } from 'ulid';
import { MAX_LIVE_DEMANDS_LIMIT } from '../src/config/env';
import { demandIdsDigest } from '../src/events/events';
import { PrismaClient } from '../src/generated/prisma';
import { buyer, client, startApi, TestClock, type ApiHarness } from './api-helpers';
import {
  cleanup,
  newOrganizationId,
  newProductId,
  ownerDatabaseUrl,
  runtimeClient,
} from './helpers';

/**
 * Closing a large window is linear (PR-327 r1 F1).
 *
 * A window that ends under REFER or CLOSE moves every live demand with it in one UPDATE. The
 * totals check is a deferred row trigger on both tables: were every one of those row changes to
 * rescan the window's demands at commit, closing N demands would visit N² rows — 10⁸ here — and
 * the close (and every later submit, which repeats it) would outrun any timeout. The check skips a
 * change that keeps the counted set, so the close is N constant checks.
 *
 * The window is seeded through the owner connection: N inserts would each queue a rescan too (an
 * insert must be checked), so the seed lifts the demand table's totals trigger for its own
 * transaction — the row guard stays on, and the window's own insert still checks the seeded total
 * against the seeded demands at commit. Everything after the seed is the real API.
 *
 * Linear is still synchronous (PR-327 r2 F1): the close must fit the transaction budget, or that
 * submit rolls back with the window OPEN and every later one repeats it. So a window holds at most
 * `PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS` live demands, and the window seeded here holds the largest
 * value that setting accepts: one more is refused, and the close fits.
 */
const HOUR = 3_600_000;
const MAX_QUANTITY = 2_147_483_647;
const T0 = new Date('2031-05-01T08:00:00.000Z');
const DEMANDS = MAX_LIVE_DEMANDS_LIMIT;
/**
 * The close's wall-clock bound: the service's own transaction budget (Prisma's default,
 * `PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS`), which the whole submit must fit in. Linear, this
 * close takes about a quarter of it; a rescan per demand (10⁸ row visits) takes over a minute.
 */
const CLOSE_BOUND_MS = PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS;

/**
 * The limit against the budget, scaled down so that it is quick and does not depend on the
 * machine: a test-only trigger makes moving each demand of one organization take at least
 * `SLOW_DEMAND_MS`, and the submit's transaction gets `REDUCED_BUDGET_MS`. At the limit the close
 * takes a quarter of the budget; the demands offered beyond it would take twice the budget.
 */
const SLOW_DEMAND_MS = 10;
const REDUCED_BUDGET_MS = 1_000;
const REDUCED_LIMIT = 25;
const OFFERED = 200;

jest.setTimeout(180_000);

describe('closing a large window', () => {
  const organizations: string[] = [];
  const harnesses: ApiHarness[] = [];

  afterAll(async () => {
    await cleanup(organizations);
    for (const harness of harnesses) await harness.close();
  });

  /** An OPEN window of `DEMANDS` live demands of one unit each, ending at T0 + 10 h. */
  async function seedWindow(policy: 'REFER' | 'CLOSE') {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const productId = newProductId();
    const aggregationId = `AGG_${ulid()}`;
    const demandIds = Array.from({ length: DEMANDS }, () => `DMD_${ulid()}`);
    const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
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
                    ${DEMANDS}, ${DEMANDS}, 0, ${T0}, ${T0}, 1)`;
          await tx.$executeRaw`
            INSERT INTO demand_request
              (id, organization_id, aggregation_id, product_id, quantity, status, submitted_at,
               submitted_by, submitted_correlation_id, created_at, updated_at, version)
            SELECT d.id, ${organizationId}, ${aggregationId}, ${productId}, 1, 'SUBMITTED',
                   ${T0}::timestamptz + make_interval(secs => d.n / 1000.0),
                   'USR-SCALE-SEED', 'corr-scale-seed',
                   ${T0}::timestamptz + make_interval(secs => d.n / 1000.0),
                   ${T0}::timestamptz + make_interval(secs => d.n / 1000.0), 1
              FROM unnest(${demandIds}::text[]) WITH ORDINALITY AS d(id, n)`;
          await tx.$executeRawUnsafe(
            'ALTER TABLE "demand_request" ENABLE TRIGGER "tg_demand_request_totals_check"',
          );
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
    } finally {
      await owner.$disconnect();
    }
    return { organizationId, productId, aggregationId, demandIds };
  }

  it.each([
    ['REFER', 'REFERRED', 'AGGREGATION_REFERRED'],
    ['CLOSE', 'LAPSED', 'AGGREGATION_LAPSED'],
  ] as const)(
    `%s: a window at the largest live-demand limit (${DEMANDS}) refuses one more, and ends in one submit within ${CLOSE_BOUND_MS} ms`,
    async (policy, ended, eventName) => {
      const seeded = await seedWindow(policy);
      const clock = new TestClock();
      // The settings of the window the late demand opens; the seeded one ends by its own snapshot.
      const harness = await startApi(
        {
          PROCUREMENT_AGGREGATION_WINDOW_HOURS: '24',
          PROCUREMENT_AGGREGATION_MIN_QUANTITY: '0',
          PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'EXTEND',
          PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS: String(DEMANDS),
        },
        { clock },
      );
      harnesses.push(harness);
      const as = client(harness, buyer(seeded.organizationId));

      // Still open, and full: one more demand is refused and writes nothing.
      clock.set(new Date(T0.getTime() + 9 * HOUR));
      const over = await as.submit({ productId: seeded.productId, quantity: 1 });
      expect(over.status).toBe(422);
      expect(over.body.details).toEqual([
        expect.objectContaining({ path: 'submission', code: 'AGGREGATION_DEMAND_LIMIT_REACHED' }),
      ]);
      expect((await as.aggregation(seeded.aggregationId)).body).toMatchObject({
        status: 'OPEN',
        demandCount: DEMANDS,
      });

      clock.set(new Date(T0.getTime() + 10 * HOUR));
      const started = performance.now();
      const late = await as.submit({ productId: seeded.productId, quantity: 1 });
      const elapsed = performance.now() - started;

      expect(late.status).toBe(201);
      expect(late.body.aggregationId).not.toBe(seeded.aggregationId);
      expect(elapsed).toBeLessThan(CLOSE_BOUND_MS);

      expect((await as.aggregation(seeded.aggregationId)).body).toMatchObject({
        status: ended,
        totalQuantity: DEMANDS,
        demandCount: DEMANDS,
      });
      const raw = runtimeClient();
      try {
        const rows = await raw.$queryRaw<{ status: string; n: bigint }[]>`
          SELECT status, count(*) AS n FROM demand_request
           WHERE organization_id = ${seeded.organizationId}
             AND aggregation_id = ${seeded.aggregationId}
           GROUP BY status`;
        expect(rows).toEqual([{ status: ended, n: BigInt(DEMANDS) }]);
      } finally {
        await raw.$disconnect();
      }
      const [event] = await harness.prisma.client.outboxMessage.findMany({
        where: { organizationId: seeded.organizationId, eventName },
      });
      expect(eventEnvelopeSchema.parse(event?.payload).payload).toMatchObject({
        aggregationId: seeded.aggregationId,
        demandCount: DEMANDS,
        demandIdsSha256: demandIdsDigest(seeded.demandIds),
        totalQuantity: DEMANDS,
      });
    },
  );

  it(`the limit keeps the close inside the budget: ${REDUCED_LIMIT} demands of ${SLOW_DEMAND_MS} ms each close within ${REDUCED_BUDGET_MS} ms; the ${OFFERED - REDUCED_LIMIT} offered beyond them are refused`, async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const productId = newProductId();
    expect(organizationId).toMatch(/^ORG_[0-9A-Z]{26}$/);
    const slow = `scale_slow_close_${organizationId.slice(4).toLowerCase()}`;
    const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      // Test-only: moving one of this organization's demands takes SLOW_DEMAND_MS. Nothing else
      // updates its demands, and no other organization's row fires it.
      await owner.$executeRawUnsafe(
        `CREATE FUNCTION "${slow}"() RETURNS trigger LANGUAGE plpgsql AS ` +
          `$fn$ BEGIN PERFORM pg_sleep(${SLOW_DEMAND_MS / 1000}); RETURN NEW; END $fn$`,
      );
      await owner.$executeRawUnsafe(
        `CREATE TRIGGER "${slow}" BEFORE UPDATE ON "demand_request" FOR EACH ROW ` +
          `WHEN (OLD."organization_id" = '${organizationId}') EXECUTE FUNCTION "${slow}"()`,
      );

      const clock = new TestClock();
      const harness = await startApi(
        {
          PROCUREMENT_AGGREGATION_WINDOW_HOURS: '10',
          PROCUREMENT_AGGREGATION_MIN_QUANTITY: String(MAX_QUANTITY),
          PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'REFER',
          PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS: String(REDUCED_LIMIT),
        },
        { clock },
      );
      harnesses.push(harness);
      // Every transaction that names no budget of its own — the submit's — gets the reduced one.
      const transaction = harness.prisma.transaction.bind(harness.prisma);
      jest.spyOn(harness.prisma, 'transaction').mockImplementation(((fn, options) =>
        transaction(fn, {
          ...options,
          timeoutMs: options?.timeoutMs ?? REDUCED_BUDGET_MS,
        })) as typeof harness.prisma.transaction);
      const as = client(harness, buyer(organizationId));

      clock.set(T0);
      const offered: number[] = [];
      for (let n = 0; n < OFFERED; n += 1) {
        offered.push((await as.submit({ productId, quantity: 1 })).status);
      }

      // Without the limit this window would hold OFFERED demands: its close would take twice the
      // budget, roll back with a 500 and leave the window OPEN for every later submit to repeat.
      clock.set(new Date(T0.getTime() + 10 * HOUR));
      const started = performance.now();
      const late = await as.submit({ productId, quantity: 1 });
      const elapsed = Math.round(performance.now() - started);
      expect({ status: late.status, withinBudget: elapsed < REDUCED_BUDGET_MS, elapsed }).toEqual({
        status: 201,
        withinBudget: true,
        elapsed: expect.any(Number),
      });

      const raw = runtimeClient();
      try {
        const windows = await raw.$queryRaw<{ status: string; demand_count: number }[]>`
          SELECT status, demand_count FROM demand_aggregation
           WHERE organization_id = ${organizationId} ORDER BY opened_at`;
        expect(windows).toEqual([
          { status: 'REFERRED', demand_count: REDUCED_LIMIT },
          { status: 'OPEN', demand_count: 1 },
        ]);
      } finally {
        await raw.$disconnect();
      }
      expect(offered.filter((status) => status === 201)).toHaveLength(REDUCED_LIMIT);
      expect(offered.filter((status) => status === 422)).toHaveLength(OFFERED - REDUCED_LIMIT);
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${slow}" ON "demand_request"`);
      await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${slow}"()`);
      await owner.$disconnect();
    }
  });
});
