import { PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS } from '@rasta/config';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { demandIdsDigest } from '../src/events/events';
import { WindowSweepService } from '../src/demand/window-sweep.service';
import { PrismaClient } from '../src/generated/prisma';
import { buyer, client, startApi, TestClock, type ApiHarness } from './api-helpers';
import {
  cleanup,
  newOrganizationId,
  newProductId,
  ownerDatabaseUrl,
  runtimeClient,
  seedOpenWindow,
} from './helpers';

/**
 * Ending a large window is bounded (PR-327 r1 F1; ADR-070 plan PR 2).
 *
 * PR 1 moved every live demand of a window that ended under REFER or CLOSE in one UPDATE, inside
 * the transaction that ended it — a demand's own submit, which must fit its 5 s budget. That is
 * ~0.13 ms a demand: past ~35,000 demands the submit outran its transaction and the window could
 * never end. Now the end moves at most PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE demands (2000 by
 * default) and the sweeper moves the rest, that many per transaction. What still grows with the
 * window inside the end is one count and digest of its live demands in the database: on rasta-dev
 * the whole late submit took 0.84 s at 200,000 demands and 2.85 s at 1,000,000 (a one-off run of
 * this test), ~2.5 µs a demand — so the end's own limit is ~1.8 million live demands, not 35,000.
 *
 * This proves it at 200,000 demands — over five times PR 1's limit: the submit that ends the window
 * stays within the budget, the sweeper's every transaction does too, every demand follows, and one
 * event names them all. The window is seeded through the owner connection (`seedOpenWindow`);
 * everything after the seed is the real API and the real sweeper. The seed is twenty times what
 * PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS lets the API admit (PR 1's technical limit, PR-327 r2 F1):
 * the end no longer depends on that limit, which stays as PR 1 set it.
 */
const HOUR = 3_600_000;
const MAX_QUANTITY = 2_147_483_647;
const T0 = new Date('2031-05-01T08:00:00.000Z');
const DEMANDS = 200_000;
/** PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE's default. */
const BATCH = 2_000;
/**
 * The wall-clock bound of the end and of each later batch: the service's own transaction budget
 * (Prisma's default, `PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS`), which every one must fit in.
 */
const BOUND_MS = PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS;

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

jest.setTimeout(900_000);

describe('ending a large window', () => {
  const organizations: string[] = [];
  const harnesses: ApiHarness[] = [];

  afterAll(async () => {
    await cleanup(organizations);
    for (const harness of harnesses) await harness.close();
  });

  it.each([
    ['REFER', 'REFERRED', 'AGGREGATION_REFERRED'],
    ['CLOSE', 'LAPSED', 'AGGREGATION_LAPSED'],
  ] as const)(
    `%s: a demand ends a window of ${DEMANDS} demands within ${BOUND_MS} ms, and the sweeper moves the rest ${BATCH} a transaction, each within it too`,
    async (policy, ended, eventName) => {
      const organizationId = newOrganizationId();
      organizations.push(organizationId);
      const productId = newProductId();
      const openedAt = new Date(Date.now() - 2 * HOUR);
      const seeded = await seedOpenWindow({
        organizationId,
        productId,
        demands: DEMANDS,
        policy,
        minQuantity: MAX_QUANTITY,
        openedAt,
        hours: 1,
      });

      const clock = new TestClock();
      // The settings of the window the late demand opens; the seeded one ends by its own snapshot.
      const harness = await startApi(
        {
          PROCUREMENT_AGGREGATION_WINDOW_HOURS: '24',
          PROCUREMENT_AGGREGATION_MIN_QUANTITY: '0',
          PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'EXTEND',
        },
        { clock },
      );
      harnesses.push(harness);
      const as = client(harness, buyer(organizationId));

      const started = performance.now();
      const late = await as.submit({ productId, quantity: 1 });
      const endMs = performance.now() - started;

      expect(late.status).toBe(201);
      expect(late.body.aggregationId).not.toBe(seeded.aggregationId);
      expect(endMs).toBeLessThan(BOUND_MS);
      expect((await as.aggregation(seeded.aggregationId)).body).toMatchObject({
        status: ended,
        totalQuantity: DEMANDS,
        demandCount: DEMANDS,
      });

      // The sweeper moves the rest, one bounded transaction a step.
      const service = harness.app.get(WindowSweepService);
      const step = service.step.bind(service);
      const stepMs: number[] = [];
      const timed = jest.spyOn(service, 'step').mockImplementation(async (target, lease) => {
        const begun = performance.now();
        const done = await step(target, lease);
        if (target.aggregationId === seeded.aggregationId) stepMs.push(performance.now() - begun);
        return done;
      });
      const sweeper = harness.sweeper({ batchSize: 500 });
      for (let round = 0; round < 20; round += 1) {
        if ((await sweeper.runOnce()).claimed === 0) break;
      }
      timed.mockRestore();

      expect(stepMs).toHaveLength(Math.ceil((DEMANDS - BATCH) / BATCH));
      expect(Math.max(...stepMs)).toBeLessThan(BOUND_MS);

      const raw = runtimeClient();
      try {
        const rows = await raw.$queryRaw<{ status: string; n: bigint }[]>`
          SELECT status, count(*) AS n FROM demand_request
           WHERE organization_id = ${organizationId} AND aggregation_id = ${seeded.aggregationId}
           GROUP BY status`;
        expect(rows).toEqual([{ status: ended, n: BigInt(DEMANDS) }]);
        const window = await raw.demandAggregation.findFirst({
          where: { organizationId, id: seeded.aggregationId },
        });
        expect(window).toMatchObject({ demandsToFollow: 0, sweepFence: null });
      } finally {
        await raw.$disconnect();
      }
      const events = await harness.prisma.client.outboxMessage.findMany({
        where: { organizationId, eventName },
      });
      expect(events).toHaveLength(1);
      expect(eventEnvelopeSchema.parse(events[0]?.payload).payload).toMatchObject({
        aggregationId: seeded.aggregationId,
        demandCount: DEMANDS,
        demandIdsSha256: demandIdsDigest(seeded.demandIds),
        totalQuantity: DEMANDS,
      });
      // Seen in the log of a local run: what the bound is measured against.
      process.stdout.write(
        `[scale] ${policy} ${DEMANDS} demands: end ${endMs.toFixed(0)} ms, ` +
          `${stepMs.length} follow steps, slowest ${Math.max(...stepMs).toFixed(0)} ms\n`,
      );
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
