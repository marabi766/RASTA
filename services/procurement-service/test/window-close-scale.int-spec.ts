import { PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS } from '@rasta/config';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { ulid } from 'ulid';
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
 */
const HOUR = 3_600_000;
const MAX_QUANTITY = 2_147_483_647;
const T0 = new Date('2031-05-01T08:00:00.000Z');
const DEMANDS = 10_000;
/**
 * The close's wall-clock bound: the service's own transaction budget (Prisma's default,
 * `PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS`), which the whole submit must fit in. Linear, this
 * close takes about a quarter of it; a rescan per demand (10⁸ row visits) takes over a minute.
 */
const CLOSE_BOUND_MS = PRISMA_DEFAULT_TRANSACTION_TIMEOUT_MS;

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
    `%s ends a window of ${DEMANDS} demands in one submit, within ${CLOSE_BOUND_MS} ms`,
    async (policy, ended, eventName) => {
      const seeded = await seedWindow(policy);
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
      const as = client(harness, buyer(seeded.organizationId));

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
});
