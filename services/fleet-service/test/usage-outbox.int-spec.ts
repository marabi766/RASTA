import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { UsageService } from '../src/fleet/usage.service';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

/**
 * Usage recording against a real database: idempotency, the outbox, and the
 * constraints that keep a maintenance schedule honest.
 *
 * The idempotency property is the one that would be invisible to a mock. The
 * product asks for offline capture that syncs later, so the same reading
 * *will* arrive twice, and the second arrival must not publish a second
 * USAGE_RECORDED — maintenance-service accumulates hours off that event and
 * would count them twice, deferring a service that is actually due.
 */
describe('usage recording', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let service: UsageService;

  const driverId = id('DRV');
  const assetId = id('AST');
  const userId = `USR-ITEST-${id('X').slice(-8)}`;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    service = new UsageService(repository);
    await cleanup(prisma, [org.a, org.b]);

    await asActor({ organizationId: org.a }, async () => {
      await prisma.client.driver.create({
        data: { id: driverId, userId, createdBy: 'ITEST', updatedBy: 'ITEST' },
      });
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
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  const reading = (overrides: Record<string, unknown> = {}) => ({
    assetId,
    periodStart: '2026-08-27T06:00:00.000Z',
    periodEnd: '2026-08-27T14:00:00.000Z',
    hours: '7.50',
    source: 'MANUAL' as const,
    ...overrides,
  });

  describe('the state change and the event commit together', () => {
    it('writes the record and its outbox row in one transaction', async () => {
      // This is the property ADR-021 exists for: without it, "save the usage"
      // and "publish USAGE_RECORDED" are two non-atomic operations, and a
      // crash between them either loses the maintenance trigger or invents one.
      const created = await asActor({ organizationId: org.a }, () =>
        service.record(reading({ clientReference: `ref-${id('R')}` })),
      );

      const row = await asActor({ organizationId: org.a }, () =>
        repository.findUsageById(created.id),
      );
      expect(row).not.toBeNull();

      const outbox = await prisma.client.outboxMessage.findMany({
        where: { organizationId: org.a, aggregateId: created.id },
      });

      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.eventName).toBe('USAGE_RECORDED');
      // Keyed by asset, not by the record's own id: every consumer reasons
      // about one machine's readings in order, and Kafka guarantees ordering
      // only within a partition (docs/07 § 7.7).
      expect(outbox[0]!.partitionKey).toBe(assetId);
      expect(outbox[0]!.publishedAt).toBeNull();
    });

    it('carries quantities as strings in the envelope', async () => {
      const created = await asActor({ organizationId: org.a }, () =>
        service.record(reading({ hours: '3.25', clientReference: `ref-${id('R')}` })),
      );

      const outbox = await prisma.client.outboxMessage.findFirstOrThrow({
        where: { aggregateId: created.id },
      });
      const envelope = outbox.payload as { payload: { hours: unknown } };

      expect(typeof envelope.payload.hours).toBe('string');
      expect(envelope.payload.hours).toBe('3.25');
    });

    it('propagates the correlation id from the request onto the event', async () => {
      // The traceability property § 40 asks for: one correlation id links the
      // HTTP call to the outbox row, and from there to Kafka and every
      // consumer.
      const created = await asActor({ organizationId: org.a }, () =>
        service.record(reading({ clientReference: `ref-${id('R')}` })),
      );

      const outbox = await prisma.client.outboxMessage.findFirstOrThrow({
        where: { aggregateId: created.id },
      });
      const envelope = outbox.payload as { correlationId: string; tenantId: string };

      expect(outbox.correlationId).toMatch(/^itest-/);
      expect(envelope.correlationId).toBe(outbox.correlationId);
      expect(envelope.tenantId).toBe(org.a);
    });
  });

  describe('idempotent submission', () => {
    it('returns the original record and publishes nothing further on a replay', async () => {
      const clientReference = `offline-${id('R')}`;

      const first = await asActor({ organizationId: org.a }, () =>
        service.record(reading({ clientReference })),
      );
      const second = await asActor({ organizationId: org.a }, () =>
        service.record(reading({ clientReference })),
      );

      expect(second.id).toBe(first.id);

      const events = await prisma.client.outboxMessage.findMany({
        where: { organizationId: org.a, aggregateId: first.id },
      });
      // One event, not two. maintenance-service would otherwise count these
      // hours twice.
      expect(events).toHaveLength(1);
    });

    it('survives two replays arriving at the same moment', async () => {
      // Both pass the replay check, one commits, and the loser reads back the
      // winner's row rather than reporting a conflict the caller cannot act on.
      const clientReference = `race-${id('R')}`;

      const results = await asActor({ organizationId: org.a }, () =>
        Promise.all([
          service.record(reading({ clientReference })),
          service.record(reading({ clientReference })),
        ]),
      );

      expect(results[0].id).toBe(results[1].id);

      const stored = await prisma.client.usageRecord.findMany({
        where: { organizationId: org.a, clientReference },
      });
      expect(stored).toHaveLength(1);
    });

    it('scopes the deduplication key per organization', async () => {
      // Two dehyaris generating the same client reference must not collide;
      // the unique index is (organization_id, client_reference).
      const clientReference = 'shared-reference-value';
      const otherAsset = id('AST');

      await asActor({ organizationId: org.a }, () => service.record(reading({ clientReference })));

      await asActor({ organizationId: org.b }, async () => {
        await prisma.client.assetRef.create({
          data: {
            id: otherAsset,
            organizationId: org.b,
            status: 'ACTIVE',
            syncedAt: new Date(),
            sourceEvent: 'ITEST',
          },
        });
        const created = await service.record(reading({ assetId: otherAsset, clientReference }));
        expect(created.organizationId).toBe(org.b);
      });

      const rows = await prisma.client.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS count FROM usage_record WHERE client_reference = $1`,
        clientReference,
      );
      expect(Number(rows[0]!.count)).toBe(2);
    });
  });

  describe('database constraints', () => {
    it('refuses a record that measures nothing', async () => {
      // A row with neither hours nor kilometres records that a machine was
      // used for an unknown amount — worse than no row, because it inflates
      // the count that "we have no readings" is distinguished from.
      await asActor({ organizationId: org.a }, async () => {
        await expect(
          prisma.client.usageRecord.create({
            data: {
              id: id('USG'),
              assetId,
              periodStart: new Date('2026-08-27T06:00:00Z'),
              periodEnd: new Date('2026-08-27T14:00:00Z'),
              recordedBy: 'ITEST',
            },
          }),
        ).rejects.toThrow(/ck_usage_has_measure/);
      });
    });

    it('refuses a negative quantity', async () => {
      // A negative reading would subtract from a maintenance schedule's
      // accumulated total, deferring a service that is actually due.
      await asActor({ organizationId: org.a }, async () => {
        await expect(
          prisma.client.usageRecord.create({
            data: {
              id: id('USG'),
              assetId,
              periodStart: new Date('2026-08-27T06:00:00Z'),
              periodEnd: new Date('2026-08-27T14:00:00Z'),
              hours: '-5',
              recordedBy: 'ITEST',
            },
          }),
        ).rejects.toThrow(/ck_usage_non_negative/);
      });
    });

    it('refuses a period that ends before it starts', async () => {
      await asActor({ organizationId: org.a }, async () => {
        await expect(
          prisma.client.usageRecord.create({
            data: {
              id: id('USG'),
              assetId,
              periodStart: new Date('2026-08-27T14:00:00Z'),
              periodEnd: new Date('2026-08-27T06:00:00Z'),
              hours: '8',
              recordedBy: 'ITEST',
            },
          }),
        ).rejects.toThrow(/ck_usage_period/);
      });
    });
  });

  describe('cross-tenant asset references', () => {
    it("refuses usage against another organization's machine", async () => {
      // Reported as absent, not forbidden: confirming the machine exists
      // elsewhere would let a caller enumerate another organization's fleet.
      await expect(
        asActor({ organizationId: org.b }, () =>
          service.record(reading({ clientReference: `x-${id('R')}` })),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
