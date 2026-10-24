import { RastaError } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { UsageService, usageRequestHash } from '../src/fleet/usage.service';
import { recordUsageSchema, type RecordUsageDto, type UsageRecordView } from '../src/fleet/dto';
import {
  asActor,
  cleanup,
  databaseUrl,
  id,
  newPrisma,
  tenants,
  type ActorOptions,
} from './helpers';

/**
 * A `clientReference` is bound to the request that took it (ADR-073 plan, PR 1
 * "fleet A"), against a real database.
 *
 * Before the binding, any submission whose reference was taken got the stored
 * record back: a resend with another body was told its new reading was saved,
 * and a colleague who knew the reference read the record through `POST`. And
 * two identical submissions racing each other could not replay at all: the
 * second waited on the asset lock, then found its twin's period overlapping its
 * own and was refused `422 USAGE_PERIOD_OVERLAP` before the unique index that
 * would have replayed it was ever reached (review of #368, F3). The two
 * interleavings that matter are driven here step by step, with the first
 * request held inside its transaction until the second is seen waiting.
 */
describe('usage replay binding', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: FleetRepository;
  let service: UsageService;

  const assetId = id('AST');
  const otherAssetId = id('AST');
  const transferredAssetId = id('AST');
  const raceAssetId = id('AST');
  /** Tenant B's machine, which tenant A may not touch. */
  const tenantBAssetId = id('AST');
  const driverA = id('DRV');
  const driverB = id('DRV');
  const suffix = id('X').slice(-8);

  const supervisor: ActorOptions = { organizationId: org.a, userId: `USR-ITEST-SUP1-${suffix}` };
  const colleague: ActorOptions = {
    organizationId: org.a,
    userId: `USR-ITEST-SUP2-${suffix}`,
    roles: ['ORGANIZATION_ADMIN'],
  };
  const driverUserA: ActorOptions = {
    organizationId: org.a,
    userId: `USR-ITEST-DRVA-${suffix}`,
    roles: ['DRIVER'],
  };
  const driverUserB: ActorOptions = {
    organizationId: org.a,
    userId: `USR-ITEST-DRVB-${suffix}`,
    roles: ['DRIVER'],
  };
  const tenantBSupervisor: ActorOptions = {
    organizationId: org.b,
    userId: `USR-ITEST-BSUP-${suffix}`,
  };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new FleetRepository(prisma);
    service = new UsageService(repository);
    await cleanup(prisma, [org.a, org.b]);

    await asActor({ organizationId: org.a }, async () => {
      for (const [driverId, actor] of [
        [driverA, driverUserA],
        [driverB, driverUserB],
      ] as const) {
        await prisma.client.driver.create({
          data: {
            organizationId: org.a,
            id: driverId,
            userId: actor.userId!,
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        });
      }
      for (const asset of [assetId, otherAssetId, transferredAssetId, raceAssetId]) {
        await prisma.client.assetRef.create({
          data: {
            id: asset,
            organizationId: org.a,
            status: 'ACTIVE',
            syncedAt: new Date(),
            sourceEvent: 'ITEST',
          },
        });
      }
    });
    await asActor({ organizationId: org.b }, () =>
      prisma.client.assetRef.create({
        data: {
          id: tenantBAssetId,
          organizationId: org.b,
          status: 'ACTIVE',
          syncedAt: new Date(),
          sourceEvent: 'ITEST',
        },
      }),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b]);
    await prisma.onModuleDestroy();
  });

  // A fresh 8-hour window per call, a day apart, so no two tests overlap.
  let day = 0;
  const reading = (overrides: Partial<RecordUsageDto> = {}): RecordUsageDto => {
    const base = Date.UTC(2026, 6, 1, 6, 0, 0) + day++ * 24 * 60 * 60 * 1000;
    return {
      assetId,
      periodStart: new Date(base).toISOString(),
      periodEnd: new Date(base + 8 * 60 * 60 * 1000).toISOString(),
      hours: '7.50',
      source: 'MANUAL',
      clientReference: `bind-${id('R')}`,
      ...overrides,
    };
  };

  /** A row as `creator` would have filed it, written directly. */
  async function seed(
    creator: ActorOptions,
    body: RecordUsageDto,
    row: { driverId?: string | null; legacy?: boolean } = {},
  ) {
    const requestHash = row.legacy
      ? null
      : await asActor(creator, async () => usageRequestHash(body));
    return asActor({ organizationId: org.a }, () =>
      prisma.client.usageRecord.create({
        data: {
          id: id('USG'),
          organizationId: org.a,
          assetId: body.assetId,
          driverId: row.driverId ?? null,
          periodStart: new Date(body.periodStart),
          periodEnd: new Date(body.periodEnd),
          hours: body.hours ?? null,
          source: body.source,
          clientReference: body.clientReference ?? null,
          requestHash,
          recordedBy: creator.userId!,
        },
      }),
    );
  }

  const rowsUnder = (clientReference: string) =>
    asActor({ organizationId: org.a }, () =>
      prisma.client.usageRecord.findMany({ where: { clientReference } }),
    );

  const eventsFor = (usageRecordId: string) =>
    prisma.client.outboxMessage.count({
      where: { organizationId: org.a, aggregateId: usageRecordId },
    });

  async function refused(promise: Promise<unknown>): Promise<RastaError> {
    const error = await promise.then(
      () => {
        throw new Error('expected 409 IDEMPOTENCY_KEY_REUSED');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RastaError);
    expect(error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    expect((error as RastaError).details).toBeUndefined();
    return error as RastaError;
  }

  /** Until `n` sessions of this database wait on a lock. */
  async function waitForBlocked(n: number) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const found = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (found[0]!.n >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${n} sessions ever blocked`);
  }

  /** An open assignment of `driverId` to `asset`, which `end()` closes. */
  async function assign(driverId: string, asset: string) {
    const assignment = await asActor({ organizationId: org.a }, () =>
      prisma.client.assignment.create({
        data: {
          id: id('ASG'),
          organizationId: org.a,
          driverId,
          assetId: asset,
          startedAt: new Date(Date.UTC(2026, 0, 1)),
          assignedBy: 'ITEST',
        },
      }),
    );
    const end = () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE assignment SET ended_at = now(), end_reason = 'COMPLETED', ended_by = 'ITEST'
         WHERE id = $1 AND ended_at IS NULL`,
        assignment.id,
      );
    return { assignment, end };
  }

  /**
   * Holds the next submission inside its transaction, just after its insert,
   * until released: its locks and its uncommitted row stay in place.
   */
  function holdNextSubmission(on: FleetRepository = repository) {
    const enqueue = on.enqueueEvent.bind(on);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const held = new Promise<void>((resolve) => (inserted = resolve));
    jest.spyOn(on, 'enqueueEvent').mockImplementationOnce(async (tx, event) => {
      inserted();
      await released;
      return enqueue(tx, event);
    });
    return { held, release };
  }

  it('replays to the same caller sending the same body, and publishes nothing further', async () => {
    const body = reading();
    const first = await asActor(supervisor, () => service.record(body));
    const again = await asActor(supervisor, () => service.record({ ...body }));

    expect(again).toEqual(first);
    expect(await eventsFor(first.id)).toBe(1);
  });

  it('refuses the same caller sending another body, and keeps the first reading', async () => {
    const body = reading();
    const first = await asActor(supervisor, () => service.record(body));

    await refused(asActor(supervisor, () => service.record({ ...body, hours: '9.25' })));

    const rows = await rowsUnder(body.clientReference!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hours!.toString()).toBe('7.5');
    expect(await eventsFor(first.id)).toBe(1);
  });

  it('refuses another user sending the same body, exactly as a changed body', async () => {
    const body = reading();
    await asActor(supervisor, () => service.record(body));

    const changed = await refused(
      asActor(supervisor, () => service.record({ ...body, hours: '1.00' })),
    );
    const other = await refused(asActor(colleague, () => service.record(body)));

    // Nothing tells the colleague the reference names a record, let alone what.
    expect({ code: other.code, message: other.message }).toEqual({
      code: changed.code,
      message: changed.message,
    });
  });

  it("refuses a DRIVER replaying another driver's reference, and replays it to its own driver", async () => {
    const body = reading();
    const stored = await seed(driverUserA, body, { driverId: driverA });

    await refused(asActor(driverUserB, () => service.record(body)));
    // Before any validation: driver A holds no assignment now, and still gets
    // back the reading accepted then.
    await expect(asActor(driverUserA, () => service.record(body))).resolves.toMatchObject({
      id: stored.id,
    });
  });

  it('refuses the very request that took the reference once its caller may no longer read the record', async () => {
    // Filed by this user as a supervisor, under driver B; the user is now a
    // DRIVER with record A. `GET` answers 404, so the replay returns nothing
    // either, though the binding alone matches.
    const body = reading();
    await seed(driverUserA, body, { driverId: driverB });

    await refused(asActor(driverUserA, () => service.record(body)));
  });

  it('replays the same reading in another spelling, and keeps the canonical one (#372 r1 F1)', async () => {
    const base = reading();
    const first = recordUsageSchema.parse({
      ...base,
      periodStart: base.periodStart.replace('.000Z', 'Z'),
      hours: '7.50',
      notes: 'shift A\r\nmeter checked',
    });
    const again = recordUsageSchema.parse({
      ...base,
      hours: '7.5',
      notes: 'shift A\nmeter checked',
    });

    const a = await asActor(supervisor, () => service.record(first));
    await expect(asActor(supervisor, () => service.record(again))).resolves.toEqual(a);
    expect(a).toMatchObject({ hours: '7.5', notes: 'shift A\nmeter checked' });
    expect(await eventsFor(a.id)).toBe(1);

    // Omitted is not zero.
    await refused(
      asActor(supervisor, () =>
        service.record(recordUsageSchema.parse({ ...again, kilometres: '0' })),
      ),
    );
  });

  it('replays a note sent precomposed, then decomposed, as one request (#372 r2 F1)', async () => {
    const base = reading();
    const first = recordUsageSchema.parse({ ...base, notes: 'caf\u00e9 \u0622' });
    const again = recordUsageSchema.parse({ ...base, notes: 'cafe\u0301 \u0627\u0653' });

    const a = await asActor(supervisor, () => service.record(first));
    await expect(asActor(supervisor, () => service.record(again))).resolves.toEqual(a);
    expect(a.notes).toBe('caf\u00e9 \u0622');
    expect(await rowsUnder(base.clientReference!)).toHaveLength(1);
    expect(await eventsFor(a.id)).toBe(1);
  });

  describe('a twin committed, then the state changed, before this request was validated (#372 r1 F2)', () => {
    /**
     * Lets this request's look before validation run and find nothing, then —
     * before it goes on — runs `meanwhile`: the twin commits, the state moves.
     */
    function afterFirstLookup(meanwhile: () => Promise<void>) {
      const lookup = repository.findUsageByClientReference.bind(repository);
      jest
        .spyOn(repository, 'findUsageByClientReference')
        .mockImplementationOnce(async (reference, tx) => {
          const found = await lookup(reference, tx);
          await meanwhile();
          return found;
        });
    }

    it('replays to a DRIVER whose assignment ended after the twin committed, not 404', async () => {
      const assignment = await asActor({ organizationId: org.a }, () =>
        prisma.client.assignment.create({
          data: {
            id: id('ASG'),
            organizationId: org.a,
            driverId: driverA,
            assetId,
            startedAt: new Date(Date.UTC(2026, 0, 1)),
            assignedBy: 'ITEST',
          },
        }),
      );
      const body = reading();
      let a!: UsageRecordView;
      afterFirstLookup(async () => {
        a = await asActor(driverUserA, () => service.record(body));
        await prisma.client.$executeRawUnsafe(
          `UPDATE assignment SET ended_at = now(), end_reason = 'COMPLETED', ended_by = 'ITEST' WHERE id = $1`,
          assignment.id,
        );
      });

      const b = await asActor(driverUserA, () => service.record(body));

      expect(a.assignmentId).toBe(assignment.id);
      expect(b).toEqual(a);
      expect(await rowsUnder(body.clientReference!)).toHaveLength(1);
      expect(await eventsFor(a.id)).toBe(1);
      // Without a twin, the same state is the refusal it always was.
      await expect(asActor(driverUserA, () => service.record(reading()))).rejects.toMatchObject({
        status: 404,
      });
    });

    it('replays after the machine transferred to another organization, not 404', async () => {
      const body = reading({ assetId: transferredAssetId });
      let a!: UsageRecordView;
      afterFirstLookup(async () => {
        a = await asActor(supervisor, () => service.record(body));
        await prisma.client.$executeRawUnsafe(
          `UPDATE asset_ref SET organization_id = $2 WHERE id = $1`,
          transferredAssetId,
          org.b,
        );
      });

      const b = await asActor(supervisor, () => service.record(body));

      expect(b).toEqual(a);
      expect(await eventsFor(a.id)).toBe(1);
      // Another caller, the same window: the same 409 as ever, not the record.
      await refused(asActor(colleague, () => service.record(body)));
      await expect(
        asActor(supervisor, () => service.record(reading({ assetId: transferredAssetId }))),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('a refusal re-checks under the reference lock, not the asset lock (#372 r2 F3)', () => {
    it("answers tenant A's 404 for tenant B's machine while B holds that machine's lock", async () => {
      // B is mid-submission on its own machine: asset lock taken, row
      // inserted, uncommitted. A names B's machine. Before, A's refusal
      // re-check took that same asset lock and its 404 waited for B.
      const { held, release } = holdNextSubmission();
      const b = asActor(tenantBSupervisor, () =>
        service.record(reading({ assetId: tenantBAssetId })),
      );
      await held;
      let timer: NodeJS.Timeout | undefined;
      try {
        const answered = asActor(supervisor, () =>
          service.record(reading({ assetId: tenantBAssetId })),
        );
        const waited = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("waited on tenant B's lock")), 2000);
        });
        await expect(Promise.race([answered, waited])).rejects.toMatchObject({ status: 404 });
      } finally {
        clearTimeout(timer);
        release();
        await b;
      }
    });

    it('still waits for a twin of its own in flight, and replays it', async () => {
      // A is held inside its transaction under both locks. The assignment
      // then ends, so B — the same driver, the same body — is refused 404
      // before its transaction, re-checks, and must wait for A's reference
      // lock rather than find nothing and let the 404 stand.
      const { end } = await assign(driverA, raceAssetId);
      const body = reading({ assetId: raceAssetId });
      const { held, release } = holdNextSubmission();
      const first = asActor(driverUserA, () => service.record(body));
      await held;
      await end();

      const second = asActor(driverUserA, () => service.record(body));
      await waitForBlocked(1);
      release();
      const [a, b] = await Promise.all([first, second]);

      expect(b).toEqual(a);
      expect(await rowsUnder(body.clientReference!)).toHaveLength(1);
      expect(await eventsFor(a.id)).toBe(1);
    });
  });

  describe('a DRIVER replay under the locks, on a pool of one connection (#372 r2 F2)', () => {
    let narrow: PrismaService;
    let narrowRepository: FleetRepository;
    let narrowService: UsageService;

    beforeAll(async () => {
      const url = new URL(databaseUrl());
      url.searchParams.set('connection_limit', '1');
      url.searchParams.set('pool_timeout', '3');
      narrow = new PrismaService(url.toString());
      await narrow.onModuleInit();
      narrowRepository = new FleetRepository(narrow);
      narrowService = new UsageService(narrowRepository);
    });

    afterAll(() => narrow.onModuleDestroy());

    it("returns the twin's record instead of waiting for a second connection", async () => {
      // B's look before validation finds nothing; then A — the same driver,
      // the same body, on another pool — commits. B is still assigned, enters
      // its transaction holding the pool's only connection, and finds A's
      // record under the locks. Its read rule needs the caller's driver
      // record: on the ordinary client that is a second connection, which
      // never comes while B holds the first.
      const { end } = await assign(driverB, raceAssetId);
      try {
        const body = reading({ assetId: raceAssetId });
        let a!: UsageRecordView;
        const lookup = narrowRepository.findUsageByClientReference.bind(narrowRepository);
        jest
          .spyOn(narrowRepository, 'findUsageByClientReference')
          .mockImplementationOnce(async (reference, tx) => {
            const found = await lookup(reference, tx);
            a = await asActor(driverUserB, () => service.record(body));
            return found;
          });

        const b = await asActor(driverUserB, () => narrowService.record(body));

        expect(b).toEqual(a);
        expect(a.driverId).toBe(driverB);
        expect(await rowsUnder(body.clientReference!)).toHaveLength(1);
        expect(await eventsFor(a.id)).toBe(1);
      } finally {
        await end();
      }
    });
  });

  describe('a row recorded before the binding (request_hash NULL)', () => {
    it('replays to the user who recorded it when every field is equal', async () => {
      const body = reading();
      const stored = await seed(supervisor, body, { legacy: true });

      await expect(asActor(supervisor, () => service.record(body))).resolves.toMatchObject({
        id: stored.id,
        hours: '7.5',
      });
    });

    it('refuses a supervisor who omits driverId when the row names a driver (#372 r1 F3)', async () => {
      // Driver B holds the machine now: a fresh request without `driverId`
      // would be filed under B, so A's record is not its answer.
      const assignment = await asActor({ organizationId: org.a }, () =>
        prisma.client.assignment.create({
          data: {
            id: id('ASG'),
            organizationId: org.a,
            driverId: driverB,
            assetId: otherAssetId,
            startedAt: new Date(Date.UTC(2026, 0, 1)),
            assignedBy: 'ITEST',
          },
        }),
      );
      const body = reading({ assetId: otherAssetId });
      const stored = await seed(supervisor, body, { legacy: true, driverId: driverA });

      await refused(asActor(supervisor, () => service.record(body)));
      await expect(
        asActor(supervisor, () => service.record({ ...body, driverId: driverA })),
      ).resolves.toMatchObject({ id: stored.id, driverId: driverA });
      await prisma.client.$executeRawUnsafe(`DELETE FROM assignment WHERE id = $1`, assignment.id);
    });

    it('refuses that user with another reading, and refuses everyone else', async () => {
      const body = reading();
      await seed(supervisor, body, { legacy: true });

      await refused(asActor(supervisor, () => service.record({ ...body, hours: '7.75' })));
      await refused(asActor(colleague, () => service.record(body)));
      expect(await rowsUnder(body.clientReference!)).toHaveLength(1);
    });
  });

  describe('concurrent twins', () => {
    it('replays a twin that committed while this request waited for the locks, not USAGE_PERIOD_OVERLAP', async () => {
      // A takes the locks and inserts, and is held there. B passes the first
      // lookup (A is uncommitted), then waits on A's lock. A commits. B now
      // holds the locks with A's overlapping period committed — and must
      // replay A's record, not refuse it.
      const body = reading();
      const { held, release } = holdNextSubmission();
      const first = asActor(supervisor, () => service.record(body));
      await held;

      const lookups = jest.spyOn(repository, 'findUsageByClientReference');
      const second = asActor(supervisor, () => service.record(body));
      await waitForBlocked(1);
      // B's look before validation found nothing: only the one under the lock can.
      expect(lookups).toHaveBeenCalledTimes(1);
      await expect(lookups.mock.results[0]!.value).resolves.toBeNull();

      release();
      const [a, b] = await Promise.all([first, second]);

      expect(b).toEqual(a);
      expect(await rowsUnder(body.clientReference!)).toHaveLength(1);
      expect(await eventsFor(a.id)).toBe(1);
    });

    it("refuses another caller's twin under the lock the same way", async () => {
      const body = reading();
      const { held, release } = holdNextSubmission();
      const first = asActor(supervisor, () => service.record(body));
      await held;

      const second = asActor(colleague, () => service.record(body));
      await waitForBlocked(1);
      release();

      await first;
      await refused(second);
    });

    it('serialises a twin under the same reference on another machine, and refuses it', async () => {
      // Two machines, but one reference: B waits on A's reference lock, not
      // on the unique index. A commits; B, under the locks, finds a row that
      // is another request's. The unique index stays the backstop (unit:
      // "after a unique violation").
      const body = reading();
      const { held, release } = holdNextSubmission();
      const first = asActor(supervisor, () => service.record(body));
      await held;

      const second = asActor(supervisor, () => service.record({ ...body, assetId: otherAssetId }));
      await waitForBlocked(1);
      release();

      const a = await first;
      await refused(second);
      const rows = await rowsUnder(body.clientReference!);
      expect(rows.map((row) => row.id)).toEqual([a.id]);
      expect(rows[0]!.assetId).toBe(assetId);
    });
  });
});
