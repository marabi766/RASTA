import { PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS } from '@rasta/config';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { demandIdsDigest } from '../src/events/events';
import { WindowSweepService } from '../src/demand/window-sweep.service';
import { buyer, client, startApi, TestClock, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId, runtimeClient, seedOpenWindow } from './helpers';

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
 * everything after the seed is the real API and the real sweeper.
 */
const HOUR = 3_600_000;
const MAX_QUANTITY = 2_147_483_647;
const DEMANDS = 200_000;
/** PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE's default. */
const BATCH = 2_000;
/**
 * The wall-clock bound of the end and of each later batch: the service's own transaction budget
 * (Prisma's default, `PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS`), which every one must fit in.
 */
const BOUND_MS = PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS;

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
});
