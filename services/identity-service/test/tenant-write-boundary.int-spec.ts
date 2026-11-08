import { runUnscoped, runWithNestedTenantWrite } from '@rasta/nest-common';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/** Real extended client, including its transaction client: no mocked query boundary. */
describe('tenant write boundary', () => {
  const org = tenants();
  let prisma: PrismaService;
  const userId = id('USR-WRITE');
  const membershipId = id('MBR-WRITE');
  const actor = { organizationId: org.a };
  const row = (rowId = membershipId, organizationId = org.a) => ({
    id: rowId,
    organizationId,
    userId,
    roles: ['OPERATOR'],
    createdBy: 'test',
    updatedBy: 'test',
  });
  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    await prisma.client.user.create({
      data: {
        id: userId,
        username: userId,
        email: `${userId}@example.invalid`,
        firstName: 'Before',
        lastName: 'Test',
        createdBy: 'test',
        updatedBy: 'test',
      },
    });
    await asActor(actor, async () => prisma.client.membership.create({ data: row() }));
  });
  afterAll(async () => {
    if (!prisma) return;
    await runUnscoped('Cleanup only this tenant write regression fixture', async () => {
      await prisma.client.membership.deleteMany({ where: { userId } });
      await prisma.client.user.delete({ where: { id: userId } });
    });
    await prisma.stop();
  });
  it('refuses a foreign upsert create branch before inserting anything', async () => {
    const newId = id('MBR-FOREIGN');
    await expect(
      asActor(actor, async () =>
        prisma.client.membership.upsert({
          where: { id: newId },
          create: row(newId, org.b),
          update: {},
        }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(
      await runUnscoped('Verify refused upsert inserted no row under either tenant', () =>
        prisma.client.membership.count({ where: { id: newId } }),
      ),
    ).toBe(0);
  });
  it.each(['update', 'updateMany', 'updateManyAndReturn', 'upsert'] as const)(
    'refuses %s tenant reassignment',
    async (operation) => {
      await expect(
        asActor(actor, async () => {
          if (operation === 'upsert')
            return prisma.client.membership.upsert({
              where: { id: membershipId },
              create: row(),
              update: { organizationId: { set: org.b } },
            });
          const data = { organizationId: { set: org.b } };
          const where = { id: membershipId };
          if (operation === 'update') return prisma.client.membership.update({ where, data });
          if (operation === 'updateMany')
            return prisma.client.membership.updateMany({ where, data });
          return prisma.client.membership.updateManyAndReturn({
            where: { id: membershipId },
            data: { organizationId: { set: org.b } },
          });
        }),
      ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
      expect(
        (
          await asActor(actor, async () =>
            prisma.client.membership.findUniqueOrThrow({ where: { id: membershipId } }),
          )
        ).organizationId,
      ).toBe(org.a);
    },
  );
  it.each(['createMany', 'createManyAndReturn'] as const)(
    'refuses all of a mixed %s batch',
    async (operation) => {
      const ids = [id('MBR-BATCH-A'), id('MBR-BATCH-B')];
      await expect(
        asActor(actor, async () =>
          operation === 'createMany'
            ? prisma.client.membership.createMany({ data: [row(ids[0]), row(ids[1], org.b)] })
            : prisma.client.membership.createManyAndReturn({
                data: [row(ids[0]), row(ids[1], org.b)],
              }),
        ),
      ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
      expect(
        await runUnscoped('Verify neither tenant received a row from the refused batch', () =>
          prisma.client.membership.count({ where: { id: { in: ids } } }),
        ),
      ).toBe(0);
    },
  );
  it('refuses nested tenant creation under unscoped User without changing parent or child', async () => {
    const child = id('MBR-NESTED');
    await expect(
      asActor(actor, async () =>
        prisma.client.user.update({
          where: { id: userId },
          data: {
            firstName: 'Changed',
            memberships: {
              create: {
                id: child,
                organizationId: org.a,
                roles: ['OPERATOR'],
                createdBy: 'test',
                updatedBy: 'test',
              },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect((await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).firstName).toBe(
      'Before',
    );
    expect(
      await runUnscoped('Verify refused nested create left no child row', () =>
        prisma.client.membership.count({ where: { id: child } }),
      ),
    ).toBe(0);
  });
  it('reviewed connect cannot select another tenant and leaves the parent unchanged', async () => {
    const foreign = id('MBR-CONNECT');
    await asActor({ organizationId: org.b }, async () =>
      prisma.client.membership.create({ data: row(foreign, org.b) }),
    );
    await expect(
      asActor(actor, async () =>
        runWithNestedTenantWrite(
          {
            relation: 'User.memberships',
            reason: 'Regression: connect remains limited to the acting tenant',
          },
          () =>
            prisma.client.user.update({
              where: { id: userId },
              data: {
                firstName: 'Changed',
                memberships: { connect: { id: foreign } },
              },
            }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2018' });
    expect((await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).firstName).toBe(
      'Before',
    );
    await expect(
      asActor(actor, async () =>
        runWithNestedTenantWrite(
          {
            relation: 'User.memberships',
            reason: 'Regression: reviewed set cannot detach a foreign membership implicitly',
          },
          () =>
            prisma.client.user.update({
              where: { id: userId },
              data: {
                firstName: 'Changed',
                memberships: { set: [{ id: membershipId }] },
              },
            }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect((await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).firstName).toBe(
      'Before',
    );
    expect(
      (
        await asActor({ organizationId: org.b }, async () =>
          prisma.client.membership.findUniqueOrThrow({ where: { id: foreign } }),
        )
      ).userId,
    ).toBe(userId);
  });
  it('reviewed nested creation still refuses foreign data before changing either row', async () => {
    const child = id('MBR-REVIEWED');
    await expect(
      asActor(actor, async () =>
        runWithNestedTenantWrite(
          {
            relation: 'User.memberships',
            reason: 'Regression: reviewed creation must still enforce the acting organization',
          },
          () =>
            prisma.client.user.update({
              where: { id: userId },
              data: {
                firstName: 'Changed',
                memberships: {
                  create: {
                    id: child,
                    organizationId: org.b,
                    roles: ['OPERATOR'],
                    createdBy: 'test',
                    updatedBy: 'test',
                  },
                },
              },
            }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect((await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).firstName).toBe(
      'Before',
    );
    expect(
      await runUnscoped('Verify reviewed refusal left no foreign membership row', () =>
        prisma.client.membership.count({ where: { id: child } }),
      ),
    ).toBe(0);
  });
  it('missing context refuses a guarded write before changing the row', async () => {
    await expect(
      prisma.client.membership.updateMany({
        where: { id: membershipId },
        data: { roles: ['OPERATOR'] },
      }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(
      (
        await asActor(actor, async () =>
          prisma.client.membership.findUniqueOrThrow({ where: { id: membershipId } }),
        )
      ).organizationId,
    ).toBe(org.a);
  });
  it('retains refusal inside an interactive transaction and rolls back earlier writes, outbox and key', async () => {
    const outboxId = id('OUT-WRITE');
    const key = id('KEY-WRITE');
    await expect(
      asActor(actor, async () =>
        prisma.transaction(async (tx) => {
          await tx.user.update({ where: { id: userId }, data: { firstName: 'Changed' } });
          await tx.outboxMessage.create({
            data: {
              id: outboxId,
              aggregateType: 'User',
              aggregateId: userId,
              eventName: 'REGRESSION',
              topic: 'regression',
              partitionKey: userId,
              payload: {},
              headers: {},
              organizationId: org.a,
              correlationId: key,
            },
          });
          await tx.idempotencyKey.create({
            data: {
              key,
              organizationId: org.a,
              endpoint: 'regression',
              requestHash: 'hash',
              state: 'IN_PROGRESS',
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
          await tx.membership.update({
            where: { id: membershipId },
            data: { organizationId: org.b },
          });
        }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect((await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).firstName).toBe(
      'Before',
    );
    expect(await prisma.client.outboxMessage.count({ where: { id: outboxId } })).toBe(0);
    expect(
      await asActor(actor, async () => prisma.client.idempotencyKey.count({ where: { key } })),
    ).toBe(0);
  });
});
