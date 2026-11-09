import {
  createTenantGuardExtension,
  runUnscoped,
  runWithNestedTenantWrite,
} from '@rasta/nest-common';
import { asActor, cleanup, id, key, newPrisma, publishOffer, tenants, wire } from './helpers';
import { databaseUrl } from './helpers';
import { eligibilityClockWrite } from '@rasta/testing';
import { TENANT_SCOPED_MODELS, type PrismaService } from '../src/prisma/prisma.service';
import { Prisma, PrismaClient } from '../src/generated/prisma';

describe('scalar FK tenant policy (real PostgreSQL)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let own: string;
  let foreign: string;
  let line: Prisma.OrderLineUncheckedCreateInput;
  /**
   * The scalar-FK specimen. Not an order line: those are written only by their order's placement
   * and never updated (D-156, tg_order_line_price_guard, fk_order_line_placement).
   */
  let child: Prisma.FulfillmentUncheckedCreateInput;
  const asBuyer = <T>(fn: () => Promise<T>, organizationId = org.buyer): Promise<T> =>
    asActor({ organizationId, roles: ['PROCUREMENT_USER'] }, async () => await fn());
  beforeAll(async () => {
    prisma = newPrisma();
    const wiring = wire(prisma);
    const { productId } = await publishOffer(wiring, org.other);
    const offer = await asActor({ organizationId: org.supplier, roles: ['SUPPLIER'] }, () =>
      wiring.catalogue.createOffer({
        productId,
        unitPriceMinor: '250000',
        currency: 'IRR',
        availableQuantity: 10,
        leadTimeDays: 3,
        minimumQuantity: 1,
        publish: true,
      }),
    );
    const offerId = offer.id;
    own = (
      await asBuyer(() =>
        wiring.orders.place({ lines: [{ offerId, offerVersion: 1, quantity: 1 }] }, key('scalar')),
      )
    ).id;
    foreign = id('ORD');
    await copyParent(foreign, org.other);
    const row = await asBuyer(() =>
      prisma.client.orderLine.findFirstOrThrow({ where: { orderId: own } }),
    );
    line = { ...row };
    child = await asBuyer(() =>
      prisma.client.fulfillment.create({
        data: {
          id: id('FUL'),
          organizationId: org.buyer,
          orderId: own,
          fulfilledBy: 'USR-SCALAR',
          fulfilledByOrganizationId: org.supplier,
        },
      }),
    );
  });
  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  /** FK-only parents: copy explicit non-clock fields; park saga eligibility on the DB clock. */
  async function copyParent(target: string, organizationId: string): Promise<void> {
    const inserted = await runUnscoped(
      'scalar FK fixture copies one explicitly scoped parent',
      () =>
        eligibilityClockWrite(prisma.client)`
        INSERT INTO "order" (
          id, organization_id, supplier_organization_id, placed_by, total_amount_minor,
          currency, idempotency_key, correlation_id, created_by, created_at, updated_at,
          saga_start_next_attempt_at
        )
        SELECT ${target}, ${organizationId}, supplier_organization_id, placed_by,
          total_amount_minor, currency, ${key('scalar-copy')}, correlation_id, created_by,
          now(), now(), now() + interval '24 hours'
        FROM "order" WHERE organization_id = ${org.buyer} AND id = ${own}
      `,
    );
    expect(inserted).toBe(1);
  }

  const shapes = [
    'create',
    'createMany',
    'createManyAndReturn',
    'update',
    'updateMany',
    'updateManyAndReturn',
    'upsert-create',
    'upsert-update',
  ] as const;
  async function write(shape: (typeof shapes)[number], target: string): Promise<unknown> {
    const data = { ...child, id: id('FUL'), orderId: target };
    const where = { id: child.id };
    switch (shape) {
      case 'create':
        return prisma.client.fulfillment.create({ data });
      case 'createMany':
        return prisma.client.fulfillment.createMany({ data: [data] });
      case 'createManyAndReturn':
        return prisma.client.fulfillment.createManyAndReturn({ data: [data] });
      case 'update':
        return prisma.client.fulfillment.update({ where, data: { orderId: target } });
      case 'updateMany':
        return prisma.client.fulfillment.updateMany({ where, data: { orderId: target } });
      case 'updateManyAndReturn':
        return prisma.client.fulfillment.updateManyAndReturn({ where, data: { orderId: target } });
      case 'upsert-create':
        return prisma.client.fulfillment.upsert({
          where: { id: data.id },
          create: data,
          update: {},
        });
      case 'upsert-update':
        return prisma.client.fulfillment.upsert({
          where,
          create: { ...data, orderId: own },
          update: { orderId: target },
        });
    }
  }
  it.each(shapes)(
    '%s refuses cross-tenant order injection and preserves existing rows',
    async (shape) => {
      const before = await asBuyer(() =>
        prisma.client.fulfillment.findMany({ orderBy: { id: 'asc' } }),
      );
      await expect(asBuyer(() => write(shape, foreign))).rejects.toMatchObject({ code: 'P2003' });
      expect(
        await asBuyer(() => prisma.client.fulfillment.findMany({ orderBy: { id: 'asc' } })),
      ).toEqual(before);
    },
  );
  it.each(shapes)('%s permits the same-tenant link', async (shape) => {
    // A fresh same-tenant order each time, so no shape depends on another's move.
    const target = id('ORD');
    await copyParent(target, org.buyer);
    await expect(asBuyer(() => write(shape, target))).resolves.toBeDefined();
  });
  it('refuses a foreign tenant inside reviewed nested create data', async () => {
    const data = { ...line, id: id('OLN'), orderId: undefined, organizationId: org.other };
    await expect(
      asBuyer(() =>
        runWithNestedTenantWrite(
          { relation: 'Order.lines', reason: 'Scalar nested tenant isolation negative control' },
          () =>
            prisma.client.order.update({ where: { id: own }, data: { lines: { create: data } } }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  });
  it.each([undefined, 'analytics'] as const)(
    'transaction batches refuse implicit FK writes with family %s (real DMMF)',
    async (scalarFkFamily) => {
      const base = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
      const client = base.$extends(
        createTenantGuardExtension({
          datamodel: Prisma.dmmf.datamodel,
          scopedModels: TENANT_SCOPED_MODELS,
          scalarFkFamily,
        }),
      );
      try {
        await expect(
          asBuyer(() =>
            runWithNestedTenantWrite(
              {
                relation: 'Order.lines',
                reason: 'Batch implicit FK classification regression control',
              },
              () =>
                client.$transaction([
                  client.order.findUnique({ where: { id: own } }),
                  client.order.update({
                    where: { id: own },
                    data: { lines: { connect: { id: line.id } } },
                  }),
                ]),
            ),
          ),
        ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
      } finally {
        await base.$disconnect();
      }
    },
  );
  it('cannot bypass atomic enforcement through runUnscoped', async () => {
    await expect(
      runUnscoped('prove database ownership enforcement survives explicit guard bypass', () =>
        prisma.client.fulfillment.update({ where: { id: child.id }, data: { orderId: foreign } }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
