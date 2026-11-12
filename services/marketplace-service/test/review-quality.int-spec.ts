import { runUnscoped } from '@rasta/nest-common';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  cleanup,
  id,
  key,
  newPrisma,
  outboxFor,
  publishOffer,
  tenants,
  wire,
  type Wiring,
} from './helpers';

describe('separate review quality answer (real PostgreSQL)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let wiring: Wiring;
  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.buyer, roles: ['PROCUREMENT_USER'] }, async () => fn());

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });
  afterAll(async () => {
    await cleanup(prisma, Object.values(org));
    await prisma.stop();
  });

  async function completedOrder(): Promise<string> {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, offerVersion: 1, quantity: 1 }] }, key('quality')),
    );
    await runUnscoped(
      'the suite supplies a completed order satisfying the existing CHECKs',
      () =>
        prisma.client.$executeRaw`
        UPDATE "order" SET status='COMPLETED', economic_transaction_id=${id('TXN')},
          economic_settlement_id=${id('STL')}, receipt_confirmed_at=now(),
          receipt_confirmed_by='USR-ITEST', completed_at=now()
        WHERE id=${order.id} AND organization_id=${org.buyer}`,
    );
    return order.id;
  }

  const reviewRows = (orderId: string) =>
    asBuyer(() => prisma.client.review.findMany({ where: { orderId, organizationId: org.buyer } }));
  const events = async (orderId: string) =>
    (await outboxFor(prisma, org.buyer)).filter(
      (row) =>
        row.eventName === 'REVIEW_SUBMITTED' &&
        (row.payload as { payload: { orderId: string } }).payload.orderId === orderId,
    );

  it.each([undefined, 1, 5])(
    'atomically persists and emits qualityRating %s, keeping general rating separate',
    async (qualityRating) => {
      const orderId = await completedOrder();
      await asBuyer(() =>
        wiring.orders.submitReview(orderId, {
          rating: 4,
          ...(qualityRating !== undefined ? { qualityRating } : {}),
        }),
      );
      const rows = await reviewRows(orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rating: 4, qualityRating: qualityRating ?? null });
      const outbox = await events(orderId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].eventVersion).toBe(1);
      const payload = (outbox[0].payload as { payload: object }).payload;
      expect(payload).toMatchObject({
        rating: 4,
        buyerOrganizationId: org.buyer,
        supplierOrganizationId: org.supplier,
      });
      if (qualityRating === undefined) expect(payload).not.toHaveProperty('qualityRating');
      else expect(payload).toHaveProperty('qualityRating', qualityRating);
    },
  );

  it.each([0, 6])(
    'the DB CHECK refuses qualityRating %s when the DTO is bypassed',
    async (qualityRating) => {
      const orderId = await completedOrder();
      await expect(
        asBuyer(() => wiring.orders.submitReview(orderId, { rating: 4, qualityRating })),
      ).rejects.toThrow(/ck_review_quality_rating/);
      expect(await reviewRows(orderId)).toHaveLength(0);
      expect(await events(orderId)).toHaveLength(0);
    },
  );

  it('rolls back both the quality answer and event on a post-enqueue failure', async () => {
    const orderId = await completedOrder();
    await expect(
      asBuyer(() =>
        wiring.orders.submitReview(orderId, { rating: 4, qualityRating: 2 }, async () => {
          throw new Error('record response failed');
        }),
      ),
    ).rejects.toThrow('record response failed');
    expect(await reviewRows(orderId)).toHaveLength(0);
    expect(await events(orderId)).toHaveLength(0);
  });

  it.each([
    ['another buyer', 'other', 'PROCUREMENT_USER', 'NOT_FOUND'],
    ['the supplier', 'supplier', 'SUPPLIER', 'FORBIDDEN'],
  ] as const)(
    'refuses %s without writing a quality answer or event',
    async (_label, tenant, role, code) => {
      const orderId = await completedOrder();
      await expect(
        asActor({ organizationId: org[tenant], roles: [role] }, () =>
          wiring.orders.submitReview(orderId, { rating: 4, qualityRating: 2 }),
        ),
      ).rejects.toMatchObject({ code });
      expect(await reviewRows(orderId)).toHaveLength(0);
      expect(await events(orderId)).toHaveLength(0);
    },
  );

  it('concurrent submissions store only one review and quality event', async () => {
    const orderId = await completedOrder();
    const results = await Promise.allSettled(
      [1, 5].map((qualityRating) =>
        asBuyer(() => wiring.orders.submitReview(orderId, { rating: 4, qualityRating })),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await reviewRows(orderId)).toHaveLength(1);
    expect(await events(orderId)).toHaveLength(1);
  });
});
