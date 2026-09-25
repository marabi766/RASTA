import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { UsageService } from '../src/fleet/usage.service';
import { SOURCE_FACT_CALLER, UsageFactService } from '../src/fleet/source-fact';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * The internal read economic-service rewards `USAGE_RECORDED` from
 * (ADR-061 § 4), against a real PostgreSQL.
 *
 * The reward consumer takes the organization, the subject and the quantities
 * from this answer and nothing from the event. So the answer must be the
 * record's own (including `recordedBy`, the user who recorded it) and must
 * be given only to economic-service, only inside the organization signed into
 * its token.
 */
describe('usage source fact', () => {
  const org = tenants();
  let prisma: PrismaService;
  let facts: UsageFactService;
  let usageId: string;

  const assetId = id('AST');
  const recorder = `USR-ITEST-${ulid().slice(-8)}`;

  function asService<T>(
    callerService: string,
    organizationId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const context: RequestContext = {
      correlationId: `itest-${ulid()}`,
      requestId: `itest-${ulid()}`,
      organizationId,
      roles: ['SERVICE'],
      organizationIds: [],
      authType: 'SERVICE',
      callerService,
      startedAt: Date.now(),
    };
    return runWithContext(context, async () => fn());
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    const repository = new FleetRepository(prisma);
    facts = new UsageFactService(repository);
    await cleanup(prisma, [org.a, org.b]);

    await asActor({ organizationId: org.a }, async () => {
      await prisma.client.assetRef.create({
        data: {
          id: assetId,
          organizationId: org.a,
          status: 'ACTIVE',
          syncedAt: new Date(),
          sourceEvent: 'ITEST',
        },
      });
    });

    const created = await asActor({ organizationId: org.a, userId: recorder }, () =>
      new UsageService(repository).record({
        assetId,
        periodStart: '2026-08-01T06:00:00.000Z',
        periodEnd: '2026-08-01T14:00:00.000Z',
        hours: '7.50',
        source: 'MANUAL',
      }),
    );
    usageId = created.id;
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  it('states the record as fleet-service stored it, with the user who recorded it', async () => {
    const fact = await asService(SOURCE_FACT_CALLER, org.a, () => facts.usageFact(usageId));

    expect(fact).toMatchObject({
      id: usageId,
      organizationId: org.a,
      assetId,
      periodStart: '2026-08-01T06:00:00.000Z',
      periodEnd: '2026-08-01T14:00:00.000Z',
      source: 'MANUAL',
      recordedBy: recorder,
    });
    // NUMERIC as a string, never a float.
    expect(typeof fact.hours).toBe('string');
    expect(Number(fact.hours)).toBe(7.5);
    for (const field of ['notes', 'clientReference']) {
      expect(fact).not.toHaveProperty(field);
    }
  });

  it('does not find a record in another organization — the tenant is the signed one', async () => {
    await expect(
      asService(SOURCE_FACT_CALLER, org.b, () => facts.usageFact(usageId)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses every other service, and every user', async () => {
    await expect(
      asService('maintenance-service', org.a, () => facts.usageFact(usageId)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      asActor({ organizationId: org.a, roles: ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'] }, () =>
        facts.usageFact(usageId),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a service token that names no organization, before any query', async () => {
    await expect(
      asService(SOURCE_FACT_CALLER, undefined, () => facts.usageFact(usageId)),
    ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
  });
});
