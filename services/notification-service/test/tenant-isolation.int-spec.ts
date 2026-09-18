import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import {
  asUser,
  cleanup,
  databaseUrl,
  deliver,
  insuranceExpiring,
  newOrganizationId,
  newUserId,
  rowsFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * Tenant isolation — mandatory, build-breaking (AGENTS.md § 4, ADR-054 § 11).
 *
 * NTF-001 has no HTTP surface yet; the read API is NTF-002. What this story
 * owns is the data layer, and the guarantee proven here is the one every
 * later endpoint inherits: a query issued while acting for organization A
 * cannot read or change a row organization B owns, whether it asks politely
 * (a filter that would match B's rows) or bluntly (B's primary key). The
 * negative control asserts on the returned **rows**, not on a status code.
 */
describe('tenant isolation', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let a: string;
  let b: string;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    w = wire();
    await w.prisma.onModuleInit();

    a = newOrganizationId();
    b = newOrganizationId();
    organizations.push(a, b);
    userA = newUserId();
    userB = newUserId();
    w.recipients.answers.set(a, [{ userId: userA, role: 'FLEET_MANAGER' }]);
    w.recipients.answers.set(b, [{ userId: userB, role: 'FLEET_MANAGER' }]);

    await deliver(
      w,
      insuranceExpiring({ organizationId: a, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );
    await deliver(
      w,
      insuranceExpiring({ organizationId: b, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );
    await w.worker.tick();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  it("delivers each tenant's event to that tenant's recipients and nobody else", async () => {
    const rowsA = await rowsFor(w.prisma, a);
    const rowsB = await rowsFor(w.prisma, b);
    expect(rowsA.inApp.map((row) => row.userId)).toEqual([userA]);
    expect(rowsB.inApp.map((row) => row.userId)).toEqual([userB]);
    // Resolution asked identity about each tenant separately. Other suites'
    // intents may be claimed by the same (cross-tenant) worker, so only the
    // queries for these two tenants are counted.
    const asked = w.recipients.queries
      .map((query) => query.organizationId)
      .filter((organizationId) => organizationId === a || organizationId === b);
    expect(asked.sort()).toEqual([a, b].sort());
  });

  it("a list issued as tenant A contains none of tenant B's rows — asserted on the body", async () => {
    const seenByA = await asUser(a, userA, () => w.prisma.client.inAppNotification.findMany({}));
    expect(seenByA).toHaveLength(1);
    expect(seenByA.map((row) => row.organizationId)).toEqual([a]);
    expect(seenByA.some((row) => row.userId === userB)).toBe(false);

    for (const table of [
      'notificationIntent',
      'notificationDelivery',
      'recipientResolution',
      'deliveryAttempt',
      'notificationDedupe',
    ] as const) {
      const rows = await asUser(a, userA, () =>
        (
          w.prisma.client[table] as {
            findMany: (args: object) => Promise<{ organizationId: string }[]>;
          }
        ).findMany({}),
      );
      expect(rows.every((row) => row.organizationId === a)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it("a direct read of B's row by primary key, as A, finds nothing", async () => {
    const target = (await rowsFor(w.prisma, b)).inApp[0]!;
    const found = await asUser(a, userA, () =>
      w.prisma.client.inAppNotification.findUnique({ where: { id: target.id } }),
    );
    expect(found).toBeNull();
  });

  it("a mutation of B's row as A changes nothing", async () => {
    const target = (await rowsFor(w.prisma, b)).inApp[0]!;
    const updated = await asUser(a, userA, () =>
      w.prisma.client.inAppNotification.updateMany({
        where: { id: target.id },
        data: { readAt: new Date() },
      }),
    );
    expect(updated.count).toBe(0);
    const after = (await rowsFor(w.prisma, b)).inApp[0]!;
    expect(after.readAt).toBeNull();
  });

  it('a filter that names another tenant is refused outright, never resolved', async () => {
    await expect(
      asUser(a, userA, () =>
        w.prisma.client.inAppNotification.findMany({ where: { organizationId: b } }),
      ),
    ).rejects.toThrow(/acts for/);
    await expect(
      asUser(a, userA, () =>
        w.prisma.client.notificationIntent.create({
          data: {
            id: `NTI_${ulid()}`,
            organizationId: b,
            sourceEventId: `EVT_${ulid()}`,
            sourceEventName: 'X',
            sourceTopic: 't',
            sourcePartitionKey: 'k',
            occurredAt: new Date(),
            correlationId: 'c',
            ruleKey: 'r',
            templateKey: 't',
            severity: 'INFO',
            classification: 'ROUTINE',
            subjectType: 's',
            subjectId: 'i',
            dedupeKey: 'a'.repeat(64),
            contextData: {},
          },
        }),
      ),
    ).rejects.toThrow(/Cross-tenant writes are never implicit/);
  });

  it('a query with no tenant context fails loudly instead of running unscoped', async () => {
    await expect(w.prisma.client.inAppNotification.findMany({})).rejects.toThrow(
      /No RequestContext/,
    );
  });

  it("the same human in two organizations sees each organization's rows only under that hat", async () => {
    // One user id, two memberships: what they see is decided by the tenant
    // they act for, not by who they are (ADR-054 § 5 "one human, three
    // dehyaris").
    const shared = newUserId();
    const c = newOrganizationId();
    const d = newOrganizationId();
    organizations.push(c, d);
    w.recipients.answers.set(c, [{ userId: shared, role: 'FLEET_MANAGER' }]);
    w.recipients.answers.set(d, [{ userId: shared, role: 'FLEET_MANAGER' }]);
    await deliver(
      w,
      insuranceExpiring({ organizationId: c, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );
    await deliver(
      w,
      insuranceExpiring({ organizationId: d, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
    );
    await w.worker.tick();

    const underC = await asUser(c, shared, () =>
      w.prisma.client.inAppNotification.findMany({ where: { userId: shared } }),
    );
    const underD = await asUser(d, shared, () =>
      w.prisma.client.inAppNotification.findMany({ where: { userId: shared } }),
    );
    expect(underC.map((row) => row.organizationId)).toEqual([c]);
    expect(underD.map((row) => row.organizationId)).toEqual([d]);
  });

  it('every in-app row carries the user it belongs to, so object-level ownership is enforceable', async () => {
    // NTF-002's filter is `userId = ctx.userId AND organizationId = ctx.organizationId`.
    // The column has to be there and populated for that predicate to mean anything.
    const rows = await runUnscoped('assertion reads every row this suite wrote', () =>
      w.prisma.client.inAppNotification.findMany({
        where: { organizationId: { in: organizations } },
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.userId.length > 0 && row.organizationId.length > 0)).toBe(true);
  });

  it("the notification database role cannot reach another service's database", async () => {
    // AGENTS.md A-01, checked at the role rather than trusted at the code: the
    // same credentials, pointed at `rasta_audit`, are refused by PostgreSQL.
    const url = new URL(databaseUrl());
    if (!url.pathname.endsWith('/rasta_notification')) {
      // A CI or developer database named differently cannot prove this claim;
      // say so rather than pass vacuously.
      throw new Error(
        `Expected the notification database url to name rasta_notification, got ${url.pathname}`,
      );
    }
    url.pathname = '/rasta_audit';
    const foreign = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      await expect(foreign.$queryRaw`SELECT 1`).rejects.toThrow(
        /denied|does not exist|permission/i,
      );
    } finally {
      await foreign.$disconnect();
    }
  });
});
