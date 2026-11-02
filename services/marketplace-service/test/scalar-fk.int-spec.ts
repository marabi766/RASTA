import { runUnscoped, runWithNestedTenantWrite } from '@rasta/nest-common';
import { asActor, cleanup, id, key, newPrisma, publishOffer, tenants, wire } from './helpers';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { Prisma } from '../src/generated/prisma';

describe('scalar FK tenant policy (real PostgreSQL)', () => {
  const org = tenants();
  let prisma: PrismaService;
  let own: string;
  let foreign: string;
  let line: Prisma.OrderLineUncheckedCreateInput;
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
      await asBuyer(() => wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('scalar')))
    ).id;
    const parent = await asBuyer(() =>
      prisma.client.order.findUniqueOrThrow({ where: { id: own } }),
    );
    foreign = id('ORD');
    await asBuyer(
      () =>
        prisma.client.order.create({
          data: {
            ...parent,
            id: foreign,
            organizationId: org.other,
            idempotencyKey: key('foreign'),
          },
        }),
      org.other,
    );
    const row = await asBuyer(() =>
      prisma.client.orderLine.findFirstOrThrow({ where: { orderId: own } }),
    );
    line = { ...row };
  });
  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

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
    const data = { ...line, id: id('OLN'), orderId: target };
    const where = { id: line.id };
    switch (shape) {
      case 'create':
        return prisma.client.orderLine.create({ data });
      case 'createMany':
        return prisma.client.orderLine.createMany({ data: [data] });
      case 'createManyAndReturn':
        return prisma.client.orderLine.createManyAndReturn({ data: [data] });
      case 'update':
        return prisma.client.orderLine.update({ where, data: { orderId: target } });
      case 'updateMany':
        return prisma.client.orderLine.updateMany({ where, data: { orderId: target } });
      case 'updateManyAndReturn':
        return prisma.client.orderLine.updateManyAndReturn({ where, data: { orderId: target } });
      case 'upsert-create':
        return prisma.client.orderLine.upsert({ where: { id: data.id }, create: data, update: {} });
      case 'upsert-update':
        return prisma.client.orderLine.upsert({
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
        prisma.client.orderLine.findMany({ orderBy: { id: 'asc' } }),
      );
      await expect(asBuyer(() => write(shape, foreign))).rejects.toMatchObject({ code: 'P2003' });
      expect(
        await asBuyer(() => prisma.client.orderLine.findMany({ orderBy: { id: 'asc' } })),
      ).toEqual(before);
    },
  );
  it.each(shapes)('%s permits the same-tenant link', async (shape) => {
    // A fresh same-tenant order avoids (orderId, offerId) uniqueness collisions.
    const parent = await asBuyer(() =>
      prisma.client.order.findUniqueOrThrow({ where: { id: own } }),
    );
    const target = id('ORD');
    await runUnscoped('scalar positive fixture copies only the same tenant parent', () =>
      prisma.client.order.create({ data: { ...parent, id: target, idempotencyKey: id('key') } }),
    );
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
  it('cannot bypass atomic enforcement through runUnscoped', async () => {
    await expect(
      runUnscoped('prove database ownership enforcement survives explicit guard bypass', () =>
        prisma.client.orderLine.update({ where: { id: line.id }, data: { orderId: foreign } }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
