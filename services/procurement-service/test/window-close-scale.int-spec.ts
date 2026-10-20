import { PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS } from '@rasta/config';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { demandIdsDigest } from '../src/events/events';
import { DemandRepository } from '../src/demand/demand.repository';
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
 * Ending a large window is bounded (PR-327 r1 F1, PR-338 r1 F1; ADR-070 plan PR 2).
 *
 * PR 1 moved every live demand of a window that ended under REFER or CLOSE in one UPDATE, inside
 * the transaction that ended it — a demand's own submit, which must fit its 5 s budget. That is
 * ~0.13 ms a demand: past ~35,000 demands the submit outran its transaction and the window could
 * never end. PR 2's first round moved at most PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE demands (2000 by
 * default) in the end and the rest by the sweeper, but still counted and digested every demand of
 * the window in the end's transaction — the same cliff, further out (~2.5 µs a demand). Now nothing
 * in any transaction grows with the window: the end decides on the window's own row, and it and
 * every sweeper step move and digest one batch each (the digest's state stored between them); the
 * transaction that digests the last batch writes the end's one event.
 *
 * This proves it at 200,000 demands — PROCUREMENT_WINDOW_MAX_LIVE_DEMANDS's default, the most one
 * window admits: the submit that ends the window stays within the budget, the sweeper's every
 * transaction does too, every demand follows, and one event names them all. The window is seeded
 * through the owner connection (`seedOpenWindow`); everything after the seed is the real API and
 * the real sweeper. Then, scaled down so that it does not depend on the machine, a close at the
 * limit within a reduced budget that the same close done at once would outrun.
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
 * A close at the limit against a reduced budget, scaled down so that it is quick and does not
 * depend on the machine: digesting each id of one organization's window takes at least
 * `SLOW_DIGEST_MS` (the application's read is slowed) and moving each of its demands at least
 * `SLOW_MOVE_MS` (a test-only trigger), and every transaction of the service gets
 * `REDUCED_BUDGET_MS`. One batch of `REDUCED_BATCH` is half the budget; the whole window at
 * `REDUCED_LIMIT`, done in one transaction, would be 1.3 times it.
 */
const SLOW_DIGEST_MS = 20;
const SLOW_MOVE_MS = 5;
const REDUCED_BUDGET_MS = 1_000;
const REDUCED_LIMIT = 60;
const REDUCED_BATCH = 20;
const OFFERED = 100;

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
      // The end digested one batch, not the window: its event waits for the rest.
      const peek = runtimeClient();
      try {
        expect(
          await peek.demandAggregation.findFirst({
            where: { organizationId, id: seeded.aggregationId },
          }),
        ).toMatchObject({ endDigestCounted: BATCH, demandIdsSha256: null });
      } finally {
        await peek.$disconnect();
      }
      expect(
        await harness.prisma.client.outboxMessage.count({ where: { organizationId, eventName } }),
      ).toBe(0);

      // The sweeper does the rest, one bounded transaction a step.
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
        expect(window).toMatchObject({
          demandsToFollow: 0,
          sweepFence: null,
          endDigestState: null,
          demandIdsSha256: demandIdsDigest(seeded.demandIds),
        });
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

  it(`a close at the limit inside a reduced budget: ${REDUCED_LIMIT} demands, ${REDUCED_BATCH} a transaction, each within ${REDUCED_BUDGET_MS} ms — at once they would not fit; the ${OFFERED - REDUCED_LIMIT} offered beyond the limit are refused`, async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const productId = newProductId();
    expect(organizationId).toMatch(/^ORG_[0-9A-Z]{26}$/);
    const slow = `scale_slow_close_${organizationId.slice(4).toLowerCase()}`;
    const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
    try {
      // Test-only: moving one of this organization's demands takes SLOW_MOVE_MS. Nothing else
      // updates its demands, and no other organization's row fires it.
      await owner.$executeRawUnsafe(
        `CREATE FUNCTION "${slow}"() RETURNS trigger LANGUAGE plpgsql AS ` +
          `$fn$ BEGIN PERFORM pg_sleep(${SLOW_MOVE_MS / 1000}); RETURN NEW; END $fn$`,
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
          PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE: String(REDUCED_BATCH),
        },
        { clock },
      );
      harnesses.push(harness);
      // Every transaction that names no budget of its own — the submit's, the sweeper's — gets
      // the reduced one: past it Prisma rolls the transaction back.
      const transaction = harness.prisma.transaction.bind(harness.prisma);
      jest.spyOn(harness.prisma, 'transaction').mockImplementation(((fn, options) =>
        transaction(fn, {
          ...options,
          timeoutMs: options?.timeoutMs ?? REDUCED_BUDGET_MS,
        })) as typeof harness.prisma.transaction);
      // Digesting each id of this organization's windows takes SLOW_DIGEST_MS, inside the
      // transaction that reads it.
      const repository = harness.app.get(DemandRepository);
      const nextDemandIds = repository.nextDemandIds.bind(repository);
      const read: number[] = [];
      jest.spyOn(repository, 'nextDemandIds').mockImplementation(async (tx, window, limit) => {
        const ids = await nextDemandIds(tx, window, limit);
        if (window.organizationId === organizationId) {
          read.push(ids.length);
          await new Promise((resolve) => setTimeout(resolve, ids.length * SLOW_DIGEST_MS));
        }
        return ids;
      });
      const as = client(harness, buyer(organizationId));

      clock.set(T0);
      const offered: number[] = [];
      const admitted: string[] = [];
      for (let n = 0; n < OFFERED; n += 1) {
        const submitted = await as.submit({ productId, quantity: 1 });
        offered.push(submitted.status);
        if (submitted.status === 201) admitted.push(submitted.body.id as string);
      }
      expect(offered.filter((status) => status === 201)).toHaveLength(REDUCED_LIMIT);
      expect(offered.filter((status) => status === 422)).toHaveLength(OFFERED - REDUCED_LIMIT);
      const aggregationId = (await as.demand(admitted[0]!)).body.aggregationId as string;

      // The late demand ends the full window: one batch moved and digested in its own
      // transaction, inside the reduced budget.
      clock.set(new Date(T0.getTime() + 10 * HOUR));
      const started = performance.now();
      const late = await as.submit({ productId, quantity: 1 });
      const elapsed = Math.round(performance.now() - started);
      expect({ status: late.status, withinBudget: elapsed < REDUCED_BUDGET_MS, elapsed }).toEqual({
        status: 201,
        withinBudget: true,
        elapsed: expect.any(Number),
      });

      // The sweeper does the rest, a batch a transaction: none fails, none outruns the budget.
      const service = harness.app.get(WindowSweepService);
      const step = service.step.bind(service);
      const steps: { result: string; ms: number }[] = [];
      jest.spyOn(service, 'step').mockImplementation(async (target, lease) => {
        const begun = performance.now();
        try {
          const done = await step(target, lease);
          if (target.aggregationId === aggregationId) {
            steps.push({ result: done.result, ms: performance.now() - begun });
          }
          return done;
        } catch (error) {
          if (target.aggregationId === aggregationId) steps.push({ result: 'FAILED', ms: 0 });
          throw error;
        }
      });
      const sweeper = harness.sweeper({ batchSize: 500 });
      for (let round = 0; round < 20; round += 1) {
        if ((await sweeper.runOnce()).claimed === 0) break;
      }

      const batches = REDUCED_LIMIT / REDUCED_BATCH;
      expect(steps.map((s) => s.result)).toEqual(Array(batches - 1).fill('FOLLOWED'));
      expect(Math.max(...steps.map((s) => s.ms))).toBeLessThan(REDUCED_BUDGET_MS);
      // Every transaction read at most one batch; together, every demand once.
      expect(read).toEqual(Array(batches).fill(REDUCED_BATCH));

      const raw = runtimeClient();
      try {
        const windows = await raw.$queryRaw<
          { status: string; demand_count: number; demand_ids_sha256: string | null }[]
        >`
          SELECT status, demand_count, demand_ids_sha256 FROM demand_aggregation
           WHERE organization_id = ${organizationId} ORDER BY opened_at`;
        expect(windows).toEqual([
          {
            status: 'REFERRED',
            demand_count: REDUCED_LIMIT,
            demand_ids_sha256: demandIdsDigest(admitted),
          },
          { status: 'OPEN', demand_count: 1, demand_ids_sha256: null },
        ]);
      } finally {
        await raw.$disconnect();
      }
      const events = await harness.prisma.client.outboxMessage.findMany({
        where: { organizationId, eventName: 'AGGREGATION_REFERRED' },
      });
      expect(events).toHaveLength(1);
      expect(eventEnvelopeSchema.parse(events[0]?.payload).payload).toMatchObject({
        aggregationId,
        demandCount: REDUCED_LIMIT,
        demandIdsSha256: demandIdsDigest(admitted),
      });
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${slow}" ON "demand_request"`);
      await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${slow}"()`);
      await owner.$disconnect();
    }
  });
});
