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
        data: {
          organizationId: org.a,
          id: driverId,
          userId,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
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

  // A fresh, non-overlapping 8-hour window per call, one calendar day apart —
  // so tests that do not care about the exact period (most of them: they
  // exercise dedup, the outbox, correlation propagation) do not collide with
  // each other under the L3-05 overlap check merely for sharing one asset.
  let readingDayOffset = 0;
  const reading = (overrides: Record<string, unknown> = {}) => {
    const base = Date.UTC(2026, 7, 1, 6, 0, 0) + readingDayOffset * 24 * 60 * 60 * 1000;
    readingDayOffset += 1;
    return {
      assetId,
      periodStart: new Date(base).toISOString(),
      periodEnd: new Date(base + 8 * 60 * 60 * 1000).toISOString(),
      hours: '7.50',
      source: 'MANUAL' as const,
      ...overrides,
    };
  };

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

      // Read back inside a context. A scoped model outside one throws by
      // design, and the guard doing exactly that is what caught this
      // assertion the first time it ran against a real database.
      const stored = await asActor({ organizationId: org.a }, () =>
        prisma.client.usageRecord.findMany({ where: { clientReference } }),
      );
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
              organizationId: org.a,
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
              organizationId: org.a,
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
              organizationId: org.a,
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

  describe('overlap policy (L3-05)', () => {
    // Before this, only `periodEnd > periodStart` was checked on each record
    // in isolation — nothing compared a new period against a machine's
    // existing ones. Two records with different `clientReference`s could
    // cover the same hour twice, and maintenance-service accumulates every
    // USAGE_RECORDED into its meter, so an accepted overlap double-counted
    // real hours and could bring a usage-based schedule due early.
    it('refuses a period that overlaps an existing record for the same machine', async () => {
      await asActor({ organizationId: org.a }, async () => {
        await service.record(
          reading({
            periodStart: '2026-08-28T08:00:00.000Z',
            periodEnd: '2026-08-28T10:00:00.000Z',
            hours: '2',
            clientReference: `ovl-a-${id('R')}`,
          }),
        );

        await expect(
          service.record(
            reading({
              periodStart: '2026-08-28T09:00:00.000Z',
              periodEnd: '2026-08-28T11:00:00.000Z',
              hours: '2',
              clientReference: `ovl-b-${id('R')}`,
            }),
          ),
        ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

        // Only the accepted record's hours count — the refused overlap must
        // not have been written at all.
        const stored = await prisma.client.usageRecord.findMany({
          where: { assetId, clientReference: { startsWith: 'ovl-' } },
        });
        expect(stored).toHaveLength(1);
      });
    });

    it('accepts two periods that merely touch at the boundary', async () => {
      // 10:00 is the end of one reading and the start of the next — real
      // back-to-back shifts, not an overlap. The strict `<`/`>` comparison
      // must not refuse this.
      await asActor({ organizationId: org.a }, async () => {
        const first = await service.record(
          reading({
            periodStart: '2026-08-29T08:00:00.000Z',
            periodEnd: '2026-08-29T10:00:00.000Z',
            hours: '2',
            clientReference: `adj-a-${id('R')}`,
          }),
        );
        const second = await service.record(
          reading({
            periodStart: '2026-08-29T10:00:00.000Z',
            periodEnd: '2026-08-29T12:00:00.000Z',
            hours: '2',
            clientReference: `adj-b-${id('R')}`,
          }),
        );

        expect(first.id).not.toBe(second.id);
      });
    });

    it("names the conflicting record only when it is the caller's own", async () => {
      await asActor({ organizationId: org.a }, async () => {
        const first = await service.record(
          reading({
            periodStart: '2026-08-27T08:00:00.000Z',
            periodEnd: '2026-08-27T10:00:00.000Z',
            hours: '2',
            clientReference: `own-a-${id('R')}`,
          }),
        );
        await expect(
          service.record(
            reading({
              periodStart: '2026-08-27T09:00:00.000Z',
              periodEnd: '2026-08-27T11:00:00.000Z',
              hours: '2',
              clientReference: `own-b-${id('R')}`,
            }),
          ),
        ).rejects.toMatchObject({
          internalContext: expect.objectContaining({ conflictingRecordId: first.id }),
        });
      });
    });

    it("refuses an overlap with the previous owner's record, without naming it (review #5)", async () => {
      // A machine transferred from A to B keeps A's history in A. B's
      // overlapping period is still refused: maintenance-service adds every
      // accepted period to one meter per asset, whoever owns it, so accepting
      // it would count the same hour twice. The refusal does not name A's
      // record, which B has no right to see.
      const movedAsset = id('AST');
      const historic = id('USG');
      await asActor({ organizationId: org.b }, () =>
        prisma.client.assetRef.create({
          data: {
            id: movedAsset,
            organizationId: org.b,
            status: 'ACTIVE',
            syncedAt: new Date(),
            sourceEvent: 'ITEST',
          },
        }),
      );
      await asActor({ organizationId: org.a }, () =>
        prisma.client.usageRecord.create({
          data: {
            organizationId: org.a,
            id: historic,
            assetId: movedAsset,
            periodStart: new Date('2026-08-20T08:00:00.000Z'),
            periodEnd: new Date('2026-08-20T10:00:00.000Z'),
            hours: '2',
            recordedBy: 'ITEST',
          },
        }),
      );

      const refusal = await asActor({ organizationId: org.b }, () =>
        service.record(
          reading({
            assetId: movedAsset,
            periodStart: '2026-08-20T09:00:00.000Z',
            periodEnd: '2026-08-20T11:00:00.000Z',
            hours: '2',
            clientReference: `ovl-t-${id('R')}`,
          }),
        ),
      ).then(
        () => null,
        (error: { code?: string; internalContext?: Record<string, unknown> }) => error,
      );
      expect(refusal).toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      expect(JSON.stringify(refusal)).not.toContain(historic);

      // A period after A's record is fine.
      await expect(
        asActor({ organizationId: org.b }, () =>
          service.record(
            reading({
              assetId: movedAsset,
              periodStart: '2026-08-20T10:00:00.000Z',
              periodEnd: '2026-08-20T12:00:00.000Z',
              hours: '2',
              clientReference: `ovl-u-${id('R')}`,
            }),
          ),
        ),
      ).resolves.toMatchObject({ assetId: movedAsset });

      // And tenant A cannot record against a machine that is now B's at all.
      await expect(
        asActor({ organizationId: org.a }, () =>
          service.record(reading({ assetId: movedAsset, clientReference: `ovl-x-${id('R')}` })),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses usage when the machine is transferred between the ownership check and the lock (review #4)', async () => {
      const racedAsset = id('AST');
      await asActor({ organizationId: org.a }, () =>
        prisma.client.assetRef.create({
          data: {
            id: racedAsset,
            organizationId: org.a,
            status: 'ACTIVE',
            syncedAt: new Date(),
            sourceEvent: 'ITEST',
          },
        }),
      );

      // Hold the asset's lock; A's submission passes its ownership check and
      // queues behind it; the transfer to B commits; then A goes on.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const transfer = prisma.client.$transaction(
        async (tx) => {
          await repository.lockAssetRef(tx as never, racedAsset);
          locked();
          await released;
          await tx.$executeRawUnsafe(
            `UPDATE asset_ref SET organization_id = $2 WHERE id = $1`,
            racedAsset,
            org.b,
          );
        },
        { timeout: 30_000 },
      );
      await isLocked;

      const attempt = asActor({ organizationId: org.a }, () =>
        service.record(reading({ assetId: racedAsset, clientReference: `race-t-${id('R')}` })),
      );
      for (let tries = 0; tries < 400; tries++) {
        const rows = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (rows[0]!.n >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();
      await transfer;

      await expect(attempt).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const written = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM usage_record WHERE asset_id = $1`,
        racedAsset,
      );
      expect(written[0]!.n).toBe(0);
    });

    it('refuses one side of two overlapping submissions arriving at the same moment', async () => {
      // The race the audit reproduced: two concurrent inserts, neither having
      // committed while the other checks, both passing a check-then-write
      // done without a lock. The asset-row lock taken before the overlap
      // check is what makes the second submission actually see the first.
      const concurrentAsset = id('AST');
      await asActor({ organizationId: org.a }, () =>
        prisma.client.assetRef.create({
          data: {
            id: concurrentAsset,
            organizationId: org.a,
            status: 'ACTIVE',
            syncedAt: new Date(),
            sourceEvent: 'ITEST',
          },
        }),
      );

      const results = await asActor({ organizationId: org.a }, () =>
        Promise.allSettled([
          service.record(
            reading({
              assetId: concurrentAsset,
              periodStart: '2026-08-30T08:00:00.000Z',
              periodEnd: '2026-08-30T10:00:00.000Z',
              hours: '2',
              clientReference: `race-a-${id('R')}`,
            }),
          ),
          service.record(
            reading({
              assetId: concurrentAsset,
              periodStart: '2026-08-30T09:00:00.000Z',
              periodEnd: '2026-08-30T11:00:00.000Z',
              hours: '2',
              clientReference: `race-b-${id('R')}`,
            }),
          ),
        ]),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
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
