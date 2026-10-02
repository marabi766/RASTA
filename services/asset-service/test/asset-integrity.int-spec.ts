import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { TransferClearanceClient } from '../src/asset/transfer-clearance';
import { ASSET_EVENTS, INSURANCE_EVENTS } from '../src/asset/events';
import { createAssetSchema } from '../src/asset/dto';
import { InsuranceService } from '../src/insurance/insurance.service';
import { ClaimService } from '../src/insurance/claim.service';
import { TimelineConsumer } from '../src/consumers/timeline.consumer';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, databaseUrl, id, newPrisma, tenants } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * Asset integrity under concurrency, against a real PostgreSQL.
 *
 * Every property here is decided by the database: a compare-and-set, a row
 * lock, a partial unique index, or a transaction rolling back. A mock would
 * only return what it is told.
 *
 *   L3-07  two transitions from one state: the terminal one wins for good
 *   L3-09  a third location no longer violates the unique index
 *   L3-10  one live asset tag and policy number, whatever the spelling
 *   L3-08  a transfer moves the whole dossier, insurance and inspection included
 *   L3-03  a transfer refuses an asset with open work on it
 *   L4-03  the consumer's marker commits with the status change, or not at all
 *
 * The races are made deterministic, not left to timing. A third transaction
 * holds the asset's row lock while both contenders do their reads and then
 * queue behind it. The test waits until PostgreSQL reports them blocked, then
 * releases the lock. Tuple-lock waiters are served in arrival order, so the
 * contender started first wins.
 */
describe('asset integrity', () => {
  const org = tenants();
  const day = 86_400_000;

  let prisma: PrismaService;
  let repository: AssetRepository;
  let assets: AssetService;
  let insurance: InsuranceService;
  let claims: ClaimService;
  let consumer: TimelineConsumer;

  const manager = (organizationId: string) => ({ organizationId, roles: ['FLEET_MANAGER'] });
  const admin = (organizationId: string) => ({
    organizationId,
    roles: ['ORGANIZATION_ADMIN'],
    userId: `USR-ADMIN-${organizationId.slice(-4)}`,
  });

  async function machine(organizationId: string, extra: Record<string, unknown> = {}) {
    const created = await asActor(manager(organizationId), () =>
      assets.create({ name: 'لودر آزمون', type: 'LOADER', specifications: {}, ...extra } as never),
    );
    return created.id;
  }

  /** Puts an asset straight into a status, skipping the dossier checks this suite is not about. */
  async function setStatus(assetId: string, status: string) {
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET status = $2::"OperationalStatus" WHERE id = $1`,
      assetId,
      status,
    );
  }

  async function statusOf(assetId: string): Promise<{ status: string; organizationId: string }> {
    const rows = await prisma.client.$queryRawUnsafe<{ status: string; organization_id: string }[]>(
      `SELECT status::text AS status, organization_id FROM asset WHERE id = $1`,
      assetId,
    );
    return { status: rows[0]!.status, organizationId: rows[0]!.organization_id };
  }

  /** The version a read would show now: what a command is made against. */
  async function versionOf(assetId: string): Promise<number> {
    const rows = await prisma.client.$queryRawUnsafe<{ version: number }[]>(
      `SELECT version FROM asset WHERE id = $1`,
      assetId,
    );
    return rows[0]!.version;
  }

  /** Holds the asset's row lock until released, so contenders queue behind it. */
  async function holdRowLock(assetId: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    const done = prisma.client.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT id FROM asset WHERE id = $1 FOR UPDATE`, assetId);
        locked();
        await released;
      },
      { timeout: 30_000 },
    );

    await isLocked;
    return async () => {
      release();
      await done;
    };
  }

  /** Waits until `n` sessions of this database are blocked on a lock. */
  async function waitForBlocked(n: number) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const rows = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows[0]!.n >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${n} sessions ever blocked`);
  }

  const outboxFor = (aggregateId: string) =>
    runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  function envelope(eventName: string, assetId: string, tenantId: string): EventEnvelope {
    return {
      eventId: `EVT_${ulid()}`,
      eventName,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'maintenance-service',
      producerVersion: '0.1.0',
      aggregateType: 'MaintenanceRequest',
      aggregateId: id('MNT'),
      tenantId,
      correlationId: `itest-${ulid()}`,
      payload: { assetId, organizationId: tenantId },
    };
  }

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();

    repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners());
    insurance = new InsuranceService(repository, assets, 30);
    claims = new ClaimService(repository, assets, {
      decisionRoles: ['ORGANIZATION_ADMIN'],
      approvalCeilingMinor: null,
    });
    consumer = new TimelineConsumer(null, repository, assets);

    for (const organizationId of [org.a, org.b]) {
      await repository.upsertOrganizationRef({
        id: organizationId,
        name: 'سازمان آزمون',
        type: 'DEHYARI',
        status: 'ACTIVE',
        sourceEvent: 'itest',
      });
    }
  });

  afterAll(async () => {
    const orgs = [org.a, org.b];
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM processed_event WHERE event_id IN (
         SELECT source_event_id FROM asset_timeline_entry WHERE organization_id = ANY($1::text[]))`,
      orgs,
    );
    for (const table of [
      'asset_timeline_entry',
      'insurance_claim',
      'insurance_policy',
      'technical_inspection',
      'asset_transfer',
      'asset_location',
      'asset_document_ref',
      'asset',
    ]) {
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id = ANY($1::text[])`,
        orgs,
      );
    }
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM organization_ref WHERE id = ANY($1::text[])`,
      orgs,
    );
    await prisma.onModuleDestroy();
  });

  // ---------------------------------------------------------------------------
  // L3-07 — compare-and-set
  // ---------------------------------------------------------------------------

  describe('two transitions from the same state (audit L3-07)', () => {
    it('lets the decommission win and fails the stale change, which cannot revive the asset', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');

      const version = await versionOf(assetId);
      const release = await holdRowLock(assetId);
      // Both requests read ACTIVE, at the same version, now and then block on
      // the row lock.
      const decommission = asActor(manager(org.a), () =>
        assets.decommission(assetId, { reason: 'فرسودگی کامل', expectedVersion: version }),
      );
      await waitForBlocked(1);
      const idle = asActor(manager(org.a), () =>
        assets.changeStatus(assetId, {
          status: 'IDLE',
          reason: 'فصل غیرکاری',
          expectedVersion: version,
        }),
      );
      // Settle-tracking starts before the release: the loser can be refused
      // while release() still awaits the holder's commit, and an expected
      // rejection with no handler yet fails the test as unhandled.
      const settled = Promise.allSettled([decommission, idle]);
      await waitForBlocked(2);
      await release();

      const [won, lost] = await settled;
      expect(won.status).toBe('fulfilled');
      expect(lost).toMatchObject({
        status: 'rejected',
        reason: { code: 'OPTIMISTIC_LOCK_FAILED' },
      });

      expect((await statusOf(assetId)).status).toBe('DECOMMISSIONED');
      const events = (await outboxFor(assetId)).map((e) => e.eventName);
      expect(events).toContain(ASSET_EVENTS.ASSET_DECOMMISSIONED);
      expect(events).not.toContain(ASSET_EVENTS.ASSET_STATUS_CHANGED);
    });

    it('lets a stale event change find the terminal state and leave it alone', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');

      const version = await versionOf(assetId);
      const release = await holdRowLock(assetId);
      const decommission = asActor(manager(org.a), () =>
        assets.decommission(assetId, { reason: 'فرسودگی کامل', expectedVersion: version }),
      );
      await waitForBlocked(1);
      // The consumer locks the row before it reads, so it waits behind the
      // decommission and then judges the transition against what committed.
      const started = asActor(manager(org.a), () =>
        consumer.handle(envelope('MAINTENANCE_STARTED', assetId, org.a)),
      );
      await waitForBlocked(2);
      await release();
      await Promise.all([decommission, started]);

      expect((await statusOf(assetId)).status).toBe('DECOMMISSIONED');
      // The history is still recorded, only the status change is refused.
      const entries = await asActor(manager(org.a), () =>
        assets.timeline(assetId, { limit: 50 } as never),
      );
      expect(entries.items.map((e) => e.eventName)).toContain('MAINTENANCE_STARTED');
    });

    it('refuses an edit that races a decommission', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');

      const { version } = await asActor(manager(org.a), () => assets.get(assetId));
      const release = await holdRowLock(assetId);
      const decommission = asActor(manager(org.a), () =>
        assets.decommission(assetId, { reason: 'فرسودگی کامل', expectedVersion: version }),
      );
      await waitForBlocked(1);
      const edit = asActor(manager(org.a), () =>
        assets.update(assetId, { name: 'نام تازه', expectedVersion: version }),
      );
      const settled = Promise.allSettled([decommission, edit]); // before release(), as above
      await waitForBlocked(2);
      await release();

      const [, edited] = await settled;
      expect(edited).toMatchObject({
        status: 'rejected',
        reason: { code: 'OPTIMISTIC_LOCK_FAILED' },
      });
    });

    describe('two editors of the same machine (PR #158 review)', () => {
      const read = (assetId: string, organization = org.a) =>
        asActor(manager(organization), () => assets.get(assetId));

      it('lets the first save win and refuses the second, which would have restored the old tag', async () => {
        const assetId = await machine(org.a, { assetTag: `TAG-${ulid().slice(-8)}` });
        const opened = await read(assetId);

        // Both editors open the form at the same version.
        const editorA = asActor(manager(org.a), () =>
          assets.update(assetId, { name: 'نام از ویرایشگر یک', expectedVersion: opened.version }),
        );
        const editorB = asActor(manager(org.a), () =>
          assets.update(assetId, {
            assetTag: opened.assetTag,
            name: 'نام از ویرایشگر دو',
            expectedVersion: opened.version,
          }),
        );

        const results = await Promise.allSettled([editorA, editorB]);
        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const rejected = results.filter((result) => result.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({ reason: { code: 'OPTIMISTIC_LOCK_FAILED' } });

        // Exactly one version was written, and the machine holds the winner's name.
        const after = await read(assetId);
        expect(after.version).toBe(opened.version + 1);
        expect(['نام از ویرایشگر یک', 'نام از ویرایشگر دو']).toContain(after.name);
      });

      it('refuses an edit made against a version somebody else has since replaced, and keeps their change', async () => {
        const assetId = await machine(org.a, { assetTag: `TAG-${ulid().slice(-8)}` });
        const opened = await read(assetId);

        // Editor A saves a new tag.
        const newTag = `NEW-${ulid().slice(-8)}`;
        await asActor(manager(org.a), () =>
          assets.update(assetId, { assetTag: newTag, expectedVersion: opened.version }),
        );

        // Editor B, still on the old form, changes the name and — as the old
        // portal did — sends the tag it saw too.
        await expect(
          asActor(manager(org.a), () =>
            assets.update(assetId, {
              name: 'نام ویرایشگر دو',
              assetTag: opened.assetTag,
              expectedVersion: opened.version,
            }),
          ),
        ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

        const after = await read(assetId);
        expect(after.assetTag).toBe(newTag);
        expect(after.name).toBe(opened.name);
        expect(after.version).toBe(opened.version + 1);
      });

      it('announces only what changed, and a repeat of the same values changes and announces nothing', async () => {
        const assetId = await machine(org.a, { assetTag: `TAG-${ulid().slice(-8)}` });
        const opened = await read(assetId);

        const edited = await asActor(manager(org.a), () =>
          assets.update(assetId, {
            name: opened.name,
            assetTag: opened.assetTag,
            manufacturer: 'ایسوزو',
            expectedVersion: opened.version,
          }),
        );
        const updatedEvents = async () =>
          (await outboxFor(assetId)).filter((e) => e.eventName === ASSET_EVENTS.ASSET_UPDATED);

        const [event] = await updatedEvents();
        expect(event?.payload).toMatchObject({ payload: { changedFields: ['manufacturer'] } });

        const repeated = await asActor(manager(org.a), () =>
          assets.update(assetId, { manufacturer: 'ایسوزو', expectedVersion: edited.version }),
        );
        expect(repeated.version).toBe(edited.version);
        expect(await updatedEvents()).toHaveLength(1);
      });

      it("answers an edit to another organization's machine as a missing one, whatever version it names", async () => {
        const assetId = await machine(org.a);
        const opened = await read(assetId);

        for (const dto of [
          { name: 'ربوده', expectedVersion: opened.version },
          { name: 'ربوده', expectedVersion: opened.version + 7 },
        ]) {
          await expect(
            asActor(manager(org.b), () => assets.update(assetId, dto)),
          ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        }
        expect((await read(assetId)).name).toBe(opened.name);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // L3-09 — location history
  // ---------------------------------------------------------------------------

  describe('location history (audit L3-09)', () => {
    const locationsOf = (assetId: string) =>
      prisma.client.$queryRawUnsafe<{ is_current: boolean }[]>(
        `SELECT is_current FROM asset_location WHERE asset_id = $1`,
        assetId,
      );

    it('keeps one current location and every earlier one, past the third', async () => {
      const assetId = await machine(org.a, { location: { siteName: 'انبار مرکزی' } });

      for (const siteName of ['کارگاه یک', 'کارگاه دو', 'کارگاه سه']) {
        await asActor(manager(org.a), () =>
          assets.recordLocation(assetId, { siteName, source: 'MANUAL' } as never),
        );
      }

      const rows = await locationsOf(assetId);
      expect(rows).toHaveLength(4);
      expect(rows.filter((r) => r.is_current)).toHaveLength(1);
    });

    it('serialises two concurrent recordings so exactly one stays current', async () => {
      const assetId = await machine(org.a, { location: { siteName: 'انبار مرکزی' } });

      await Promise.all(
        ['کارگاه شمالی', 'کارگاه جنوبی'].map((siteName) =>
          asActor(manager(org.a), () =>
            assets.recordLocation(assetId, { siteName, source: 'MANUAL' } as never),
          ),
        ),
      );

      const rows = await locationsOf(assetId);
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.is_current)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // L3-10 — uniqueness of live rows
  // ---------------------------------------------------------------------------

  describe('one live asset tag and policy number (audit L3-10)', () => {
    const liveWithTag = (assetTag: string) =>
      prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM asset
         WHERE organization_id = $1 AND asset_tag = $2 AND deleted_at IS NULL`,
        org.a,
        assetTag,
      );

    it('keeps one asset when two creates with the same tag race', async () => {
      const assetTag = `TAG-${ulid().slice(-8)}`;
      const results = await Promise.allSettled([
        machine(org.a, { assetTag }),
        machine(org.a, { assetTag }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { code: 'ALREADY_EXISTS' },
      });
      expect((await liveWithTag(assetTag))[0]!.n).toBe(1);
    });

    it('treats the Arabic and Persian spellings of a tag as one tag', async () => {
      const suffix = ulid().slice(-6);
      // As the API receives them: the DTO canonicalises at the boundary.
      const persian = createAssetSchema.parse({
        name: 'لودر',
        type: 'LOADER',
        assetTag: `ماشین-۱-${suffix}`,
      });
      const arabic = createAssetSchema.parse({
        name: 'لودر',
        type: 'LOADER',
        assetTag: `ماشين-١-${suffix}`,
      });

      await asActor(manager(org.a), () => assets.create(persian));
      await expect(asActor(manager(org.a), () => assets.create(arabic))).rejects.toMatchObject({
        code: 'ALREADY_EXISTS',
      });
      expect((await liveWithTag(`ماشین-1-${suffix}`))[0]!.n).toBe(1);
    });

    it('frees a tag once its asset is soft-deleted', async () => {
      const assetTag = `TAG-${ulid().slice(-8)}`;
      const first = await machine(org.a, { assetTag });
      await prisma.client.$executeRawUnsafe(
        `UPDATE asset SET deleted_at = now() WHERE id = $1`,
        first,
      );

      await expect(machine(org.a, { assetTag })).resolves.toMatch(/^AST_/);
    });

    it('keeps one policy when the same policy number is recorded twice at once', async () => {
      const assetId = await machine(org.a);
      const policyNumber = `POL-${ulid().slice(-8)}`;
      const record = () =>
        asActor(manager(org.a), () =>
          insurance.recordPolicy(assetId, {
            policyNumber,
            insurerName: 'بیمه نمونه',
            coverage: 'THIRD_PARTY',
            validFrom: new Date(Date.now() - day).toISOString(),
            validTo: new Date(Date.now() + 300 * day).toISOString(),
          }),
        );

      const results = await Promise.allSettled([record(), record()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rows = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM insurance_policy WHERE policy_number = $1 AND deleted_at IS NULL`,
        policyNumber,
      );
      expect(rows[0]!.n).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // L3-08 and L3-03 — transfer
  // ---------------------------------------------------------------------------

  describe('transfer of ownership (audit L3-08, L3-03)', () => {
    const transfer = (assetId: string) =>
      asActor(admin(org.a), () =>
        assets.transfer(assetId, {
          toOrganizationId: org.b,
          reason: 'واگذاری به دهیاری همجوار طبق صورتجلسه',
        }),
      );

    it.each(['ASSIGNED', 'IN_MAINTENANCE'])(
      'refuses an asset that is %s and leaves it with its owner',
      async (status) => {
        const assetId = await machine(org.a);
        await setStatus(assetId, status);

        await expect(transfer(assetId)).rejects.toMatchObject({
          code: 'BUSINESS_RULE_VIOLATION',
        });
        expect(await statusOf(assetId)).toEqual({ status, organizationId: org.a });
      },
    );

    // ADR-062, docs/23 D-033: the status above is built from events. Work its
    // owners have not published yet is found by asking them.
    describe('clearance from the owners of the work (ADR-062)', () => {
      const transferWith = (service: AssetService, assetId: string) =>
        asActor(admin(org.a), () =>
          service.transfer(assetId, { toOrganizationId: org.b, reason: 'واگذاری آزمون' }),
        );

      const nothingMoved = async (assetId: string) => {
        expect(await statusOf(assetId)).toEqual({ status: 'ACTIVE', organizationId: org.a });
        const transfers = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM asset_transfer WHERE asset_id = $1`,
          assetId,
        );
        expect(transfers[0]!.n).toBe(0);
        expect(
          (await outboxFor(assetId)).filter((row) => row.eventName === 'ASSET_TRANSFERRED'),
        ).toEqual([]);
      };

      it('keeps an ACTIVE asset whose repair maintenance has not published yet', async () => {
        const assetId = await machine(org.a);
        await setStatus(assetId, 'ACTIVE');
        const owners = clearingOwners();
        owners.ask = async (owner) => {
          owners.asked.push(owner);
          return owner === 'maintenance-service'
            ? { clear: false, open: { openRequests: 1, openRepairOrders: 1 } }
            : { clear: true };
        };

        await expect(
          transferWith(new AssetService(repository, undefined, owners), assetId),
        ).rejects.toMatchObject({
          code: 'BUSINESS_RULE_VIOLATION',
          internalContext: expect.objectContaining({ owner: 'maintenance-service' }),
        });
        await nothingMoved(assetId);
        expect(owners.released.sort()).toEqual(['fleet-service', 'maintenance-service']);
      });

      it('rolls back every write of a transfer that commits after half the fence', async () => {
        const assetId = await machine(org.a);
        await setStatus(assetId, 'ACTIVE');
        const owners = clearingOwners();
        // Asked at 0; by the end of the transaction, 400 s have passed on the
        // monotonic clock, past half of the 600 s fence.
        let reads = 0;
        owners.now = () => (reads++ === 0 ? 0 : 400_000);

        await expect(
          transferWith(new AssetService(repository, undefined, owners), assetId),
        ).rejects.toThrow(/took too long to confirm/);
        await nothingMoved(assetId);
        expect(owners.released.sort()).toEqual(['fleet-service', 'maintenance-service']);
      });

      it('fails closed when the owners cannot be reached, with the real client', async () => {
        const assetId = await machine(org.a);
        await setStatus(assetId, 'ACTIVE');
        // Port 9 (discard): nothing listens, so the connection is refused.
        const unreachable = new TransferClearanceClient({
          baseUrls: {
            'fleet-service': 'http://127.0.0.1:9',
            'maintenance-service': 'http://127.0.0.1:9',
          },
          timeoutMs: 500,
          fenceTtlSeconds: 600,
          tokens: { issue: async () => 'itest-token' },
        });

        await expect(
          transferWith(new AssetService(repository, undefined, unreachable), assetId),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/^UPSTREAM_(UNAVAILABLE|TIMEOUT)$/),
        });
        await nothingMoved(assetId);
      });
    });

    it('moves the insurance and inspection record with the asset, and only then', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');

      await asActor(manager(org.a), () =>
        assets.attachDocument(assetId, {
          documentId: id('DOC'),
          kind: 'OWNERSHIP_TITLE',
          title: 'سند مالکیت',
        }),
      );
      const policy = await asActor(manager(org.a), () =>
        insurance.recordPolicy(assetId, {
          policyNumber: `POL-${ulid().slice(-8)}`,
          insurerName: 'بیمه نمونه',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - 100 * day).toISOString(),
          validTo: new Date(Date.now() + 200 * day).toISOString(),
        }),
      );
      await asActor(manager(org.a), () =>
        insurance.recordInspection(assetId, {
          certificateNo: `INSP-${ulid().slice(-8)}`,
          inspectedAt: new Date(Date.now() - 10 * day).toISOString(),
          validTo: new Date(Date.now() + 300 * day).toISOString(),
          result: 'PASSED',
        }),
      );
      const claim = await asActor(manager(org.a), () =>
        claims.submitClaim(assetId, {
          policyId: policy.id,
          description: 'برخورد با مانع در جاده روستایی',
          incidentAt: new Date(Date.now() - 5 * day).toISOString(),
          claimedAmountMinor: '50000000',
        }),
      );

      // An open claim is decided under the current owner's authority.
      await expect(transfer(assetId)).rejects.toThrow(/claim that is still open/);
      expect((await statusOf(assetId)).organizationId).toBe(org.a);

      await asActor(admin(org.a), () => claims.startReview(assetId, claim.id, {}));
      await asActor(admin(org.a), () =>
        claims.decide(assetId, claim.id, { decision: 'REJECTED', notes: 'خارج از پوشش بیمه‌نامه' }),
      );
      await transfer(assetId);

      // The new owner sees the whole dossier.
      await asActor(manager(org.b), async () => {
        expect(await insurance.listPolicies(assetId)).toHaveLength(1);
        expect(await insurance.listInspections(assetId)).toHaveLength(1);
        expect(await claims.listClaims(assetId)).toHaveLength(1);
      });

      // The previous owner keeps no tenant-scoped row of it.
      await expect(
        asActor(manager(org.a), () => insurance.listPolicies(assetId)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      for (const table of [
        'insurance_policy',
        'insurance_claim',
        'technical_inspection',
        'asset_transfer',
        'asset_location',
        'asset_document_ref',
        'asset_timeline_entry',
      ]) {
        const left = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${table} WHERE asset_id = $1 AND organization_id = $2`,
          assetId,
          org.a,
        );
        expect({ table, n: left[0]!.n }).toEqual({ table, n: 0 });
      }

      // docs/24 Q-66, the project owner's decision (2026-09-25): the insurance
      // follows the vehicle. First a deployment that narrowed the rule to no
      // coverage at all: the inherited policy is history there.
      const narrowAssets = new AssetService(
        repository,
        { coveragesFollowingVehicle: [] },
        clearingOwners(),
      );
      const narrowClaims = new ClaimService(repository, narrowAssets, {
        decisionRoles: ['ORGANIZATION_ADMIN'],
        approvalCeilingMinor: null,
      });
      await expect(
        asActor(manager(org.b), async () =>
          narrowAssets.activate(assetId, { expectedVersion: await versionOf(assetId) }),
        ),
      ).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: expect.objectContaining({
          rule: 'INCOMPLETE_DOSSIER',
          missing: ['an insurance policy currently in force'],
        }),
      });
      expect(
        (await asActor(manager(org.b), () => narrowAssets.dossier(assetId))).compliance
          .activeInsurance,
      ).toBeNull();
      await expect(
        asActor(manager(org.b), () =>
          narrowClaims.submitClaim(assetId, {
            policyId: policy.id,
            description: 'خسارت پس از انتقال مالکیت',
            incidentAt: new Date(Date.now() - day).toISOString(),
          }),
        ),
      ).rejects.toMatchObject({
        internalContext: expect.objectContaining({ rule: 'POLICY_FROM_PREVIOUS_OWNER' }),
      });

      // Under the default, every coverage follows: the inherited policy is
      // the new owner's active insurance, and takes the new owner's claim.
      const dossier = await asActor(manager(org.b), () => assets.dossier(assetId));
      expect(dossier.compliance.activeInsurance).toMatchObject({ id: policy.id });
      expect(dossier.transferCount).toBe(1);
      const inherited = await asActor(manager(org.b), () =>
        claims.submitClaim(assetId, {
          policyId: policy.id,
          description: 'خسارت پس از انتقال مالکیت',
          incidentAt: new Date(Date.now() - day).toISOString(),
        }),
      );
      // Filed under the new owner: it is their claim.
      const filed = await prisma.client.$queryRawUnsafe<{ organization_id: string }[]>(
        `SELECT organization_id FROM insurance_claim WHERE id = $1`,
        inherited.id,
      );
      expect(filed[0]!.organization_id).toBe(org.b);

      // The previous owner's policy, even dated to the transfer's very
      // millisecond, is still the previous owner's: ownership is a generation,
      // not a timestamp (PR #108 round 2 #5).
      await prisma.client.$executeRawUnsafe(
        `UPDATE insurance_policy p SET created_at = t.transferred_at
           FROM asset_transfer t WHERE p.id = $1 AND t.asset_id = p.asset_id`,
        policy.id,
      );
      expect(
        (await asActor(manager(org.b), () => narrowAssets.dossier(assetId))).compliance
          .activeInsurance,
      ).toBeNull();

      // Narrowed again: a policy the new owner records after the transfer
      // counts. It is stamped with the generation the transfer started.
      const own = await asActor(manager(org.b), () =>
        insurance.recordPolicy(assetId, {
          policyNumber: `POL-${ulid().slice(-8)}`,
          insurerName: 'بیمه نمونه',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - day).toISOString(),
          validTo: new Date(Date.now() + 300 * day).toISOString(),
        }),
      );
      expect(
        (await asActor(manager(org.b), () => narrowAssets.dossier(assetId))).compliance
          .activeInsurance,
      ).toMatchObject({ id: own.id });
      const generations = await prisma.client.$queryRawUnsafe<{ id: string; g: number }[]>(
        `SELECT id, ownership_generation AS g FROM asset WHERE id = $1
         UNION ALL
         SELECT id, ownership_generation AS g FROM insurance_policy WHERE id = ANY($2::text[])`,
        assetId,
        [policy.id, own.id],
      );
      expect(Object.fromEntries(generations.map((row) => [row.id, row.g]))).toEqual({
        [assetId]: 1,
        [policy.id]: 0,
        [own.id]: 1,
      });

      const activated = await asActor(manager(org.b), async () =>
        assets.activate(assetId, { expectedVersion: await versionOf(assetId) }),
      );
      expect(activated.status).toBe('ACTIVE');
    });

    it('fails the second of two concurrent transfers', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');

      const release = await holdRowLock(assetId);
      const first = transfer(assetId);
      await waitForBlocked(1);
      const second = transfer(assetId);
      const settled = Promise.allSettled([first, second]); // before release(), as above
      await waitForBlocked(2);
      await release();

      const [won, lost] = await settled;
      expect(won.status).toBe('fulfilled');
      expect(lost).toMatchObject({
        status: 'rejected',
        reason: { code: 'OPTIMISTIC_LOCK_FAILED' },
      });
      const transfers = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM asset_transfer WHERE asset_id = $1`,
        assetId,
      );
      expect(transfers[0]!.n).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // L4-03 — the consumer's marker and its effects
  // ---------------------------------------------------------------------------

  describe('a status event replayed on .retry (D-039)', () => {
    const retry = (topic: string) => Object.freeze({ topic: `${topic}.retry`, partition: 0 });
    const source = (state: { activeAssignment: boolean; inMaintenance: boolean }) => ({
      read: jest.fn(async () => state),
    });
    const replayer = (state: { activeAssignment: boolean; inMaintenance: boolean }) =>
      new TimelineConsumer(null, repository, assets, source(state));
    const entries = async (assetId: string) =>
      (
        await prisma.client.$queryRawUnsafe<{ event_name: string }[]>(
          `SELECT event_name FROM asset_timeline_entry WHERE asset_id = $1`,
          assetId,
        )
      ).map((row) => row.event_name);

    it('does not apply a stale MAINTENANCE_STARTED: the status follows what the owners say now', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      // The repair started and completed since; the STARTED that failed is replayed.
      const state = { activeAssignment: false, inMaintenance: false };

      await asActor(manager(org.a), () =>
        replayer(state).handle(
          envelope('MAINTENANCE_STARTED', assetId, org.a),
          retry('rasta.maintenance.v1'),
        ),
      );

      expect((await statusOf(assetId)).status).toBe('ACTIVE');
      // The dossier entry is a fact and is written.
      expect(await entries(assetId)).toContain('MAINTENANCE_STARTED');
    });

    it('catches the status up for a genuinely failed MAINTENANCE_STARTED or ASSET_ASSIGNED', async () => {
      const inRepair = await machine(org.a);
      await setStatus(inRepair, 'ACTIVE');
      await asActor(manager(org.a), () =>
        replayer({ activeAssignment: false, inMaintenance: true }).handle(
          envelope('MAINTENANCE_STARTED', inRepair, org.a),
          retry('rasta.maintenance.v1'),
        ),
      );
      expect((await statusOf(inRepair)).status).toBe('IN_MAINTENANCE');

      const assigned = await machine(org.a);
      await setStatus(assigned, 'ACTIVE');
      await asActor(manager(org.a), () =>
        replayer({ activeAssignment: true, inMaintenance: false }).handle(
          envelope('ASSET_ASSIGNED', assigned, org.a),
          retry('rasta.fleet.v1'),
        ),
      );
      expect((await statusOf(assigned)).status).toBe('ASSIGNED');

      // And the release that failed is replayed once the assignment has ended.
      await asActor(manager(org.a), () =>
        replayer({ activeAssignment: false, inMaintenance: false }).handle(
          envelope('ASSIGNMENT_ENDED', assigned, org.a),
          retry('rasta.fleet.v1'),
        ),
      );
      expect((await statusOf(assigned)).status).toBe('ACTIVE');
    });

    it('never forces a transition the table forbids', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'DECOMMISSIONED');

      await asActor(manager(org.a), () =>
        replayer({ activeAssignment: false, inMaintenance: true }).handle(
          envelope('MAINTENANCE_STARTED', assetId, org.a),
          retry('rasta.maintenance.v1'),
        ),
      );

      expect((await statusOf(assetId)).status).toBe('DECOMMISSIONED');
    });

    it('fails closed: with either owner unreachable nothing is applied and no marker is left', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const event = envelope('MAINTENANCE_STARTED', assetId, org.a);
      const unreachable = {
        read: jest.fn(async () => {
          throw new Error('maintenance-service unreachable');
        }),
      };

      await expect(
        asActor(manager(org.a), () =>
          new TimelineConsumer(null, repository, assets, unreachable).handle(
            event,
            retry('rasta.maintenance.v1'),
          ),
        ),
      ).rejects.toThrow(/unreachable/);
      // A consumer built without its peers refuses the replay too.
      await expect(
        asActor(manager(org.a), () =>
          new TimelineConsumer(null, repository, assets).handle(
            event,
            retry('rasta.maintenance.v1'),
          ),
        ),
      ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });

      expect((await statusOf(assetId)).status).toBe('ACTIVE');
      expect(await entries(assetId)).not.toContain('MAINTENANCE_STARTED');
      const markers = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM processed_event WHERE event_id = $1`,
        event.eventId,
      );
      expect(markers[0]!.n).toBe(0);
    });

    it('H3: a newer original-topic event that arrives while the owners are being asked waits, and is applied after — the retry cannot move the status back', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      // At the moment the retry reads fleet-service, the assignment is open.
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const held = {
        read: jest.fn(async () => {
          entered();
          await released;
          return { activeAssignment: true, inMaintenance: false };
        }),
      };

      const replay = asActor(manager(org.a), () =>
        new TimelineConsumer(null, repository, assets, held).handle(
          envelope('ASSET_ASSIGNED', assetId, org.a),
          retry('rasta.fleet.v1'),
        ),
      );
      await enteredPromise; // the retry holds the asset lock and waits on the owners
      const newer = asActor(manager(org.a), () =>
        // The original ASSIGNMENT_ENDED, in order, on the original topic.
        consumer.handle(
          envelope('ASSIGNMENT_ENDED', assetId, org.a),
          Object.freeze({ topic: 'rasta.fleet.v1', partition: 0 }),
        ),
      );
      await waitForBlocked(1); // queued behind the lock
      release();
      await Promise.all([replay, newer]);

      // The ended assignment was applied last.
      expect((await statusOf(assetId)).status).toBe('ACTIVE');
    });

    it('needs no second connection: a replay completes on a one-connection pool', async () => {
      // Everything inside the refresh transaction must go through `tx`; a read
      // through the pool from there would wait for a connection the open
      // transaction holds, until the pool timeout (here 3 s).
      const url = databaseUrl();
      const tiny = new PrismaService(
        `${url}${url.includes('?') ? '&' : '?'}connection_limit=1&pool_timeout=3`,
      );
      await tiny.onModuleInit();
      try {
        const tinyRepository = new AssetRepository(tiny);
        const tinyConsumer = new TimelineConsumer(
          null,
          tinyRepository,
          new AssetService(tinyRepository, undefined, clearingOwners()),
          source({ activeAssignment: false, inMaintenance: true }),
        );
        const assetId = await machine(org.a);
        await setStatus(assetId, 'ACTIVE');
        const started = Date.now();

        await asActor(manager(org.a), () =>
          tinyConsumer.handle(
            envelope('MAINTENANCE_STARTED', assetId, org.a),
            retry('rasta.maintenance.v1'),
          ),
        );

        expect(Date.now() - started).toBeLessThan(2500);
        expect((await statusOf(assetId)).status).toBe('IN_MAINTENANCE');
      } finally {
        await tiny.onModuleDestroy();
      }
    }, 30_000);

    it('M5: an asset absent from the event’s organization is SOURCE_UNCONFIRMED on a retry — no marker, nothing written — and still a skip on the original topic', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const foreign = envelope('MAINTENANCE_STARTED', assetId, org.b);

      await expect(
        asActor(manager(org.b), () =>
          replayer({ activeAssignment: false, inMaintenance: true }).handle(
            foreign,
            retry('rasta.maintenance.v1'),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'SOURCE_UNCONFIRMED' });

      const markers = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM processed_event WHERE event_id = $1`,
        foreign.eventId,
      );
      expect(markers[0]!.n).toBe(0);
      expect((await statusOf(assetId)).status).toBe('ACTIVE');
      expect(await entries(assetId)).not.toContain('MAINTENANCE_STARTED');

      await expect(
        asActor(manager(org.b), () =>
          consumer.handle(
            envelope('MAINTENANCE_STARTED', assetId, org.b),
            Object.freeze({ topic: 'rasta.maintenance.v1', partition: 0 }),
          ),
        ),
      ).resolves.toBe('SKIPPED');
    });

    it('leaves a delivery on the original topic exactly as before', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const reads = source({ activeAssignment: false, inMaintenance: false });

      await asActor(manager(org.a), () =>
        new TimelineConsumer(null, repository, assets, reads).handle(
          envelope('MAINTENANCE_STARTED', assetId, org.a),
          Object.freeze({ topic: 'rasta.maintenance.v1', partition: 0 }),
        ),
      );

      expect(reads.read).not.toHaveBeenCalled();
      expect((await statusOf(assetId)).status).toBe('IN_MAINTENANCE');
    });
  });

  describe('the timeline consumer (audit L4-03)', () => {
    const markerExists = async (eventId: string) => {
      const rows = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM processed_event WHERE event_id = $1`,
        eventId,
      );
      return rows[0]!.n > 0;
    };

    it('rolls the marker back when the status change fails, so the redelivery applies it', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const event = envelope('MAINTENANCE_STARTED', assetId, org.a);

      const spy = jest
        .spyOn(assets, 'applyEventStatusChange')
        .mockRejectedValueOnce(new Error('simulated crash before the status change'));

      await expect(asActor(manager(org.a), () => consumer.handle(event))).rejects.toThrow(
        /simulated crash/,
      );
      expect(await markerExists(event.eventId)).toBe(false);
      expect((await statusOf(assetId)).status).toBe('ACTIVE');

      spy.mockRestore();
      // Kafka redelivers the same event.
      await asActor(manager(org.a), () => consumer.handle(event));

      expect(await markerExists(event.eventId)).toBe(true);
      expect((await statusOf(assetId)).status).toBe('IN_MAINTENANCE');
      const statusEvents = (await outboxFor(assetId)).filter(
        (e) => e.eventName === ASSET_EVENTS.ASSET_STATUS_CHANGED,
      );
      expect(statusEvents).toHaveLength(1);

      // And a third delivery changes nothing.
      await expect(asActor(manager(org.a), () => consumer.handle(event))).resolves.toBe('SKIPPED');
    });
  });

  // ---------------------------------------------------------------------------
  // L3-04 — the expiry sweep and its outbox
  // ---------------------------------------------------------------------------

  describe('the insurance expiry sweep (audit L3-04)', () => {
    /** A policy of this suite's organization whose term ended yesterday. */
    async function lapsedPolicy(): Promise<string> {
      const assetId = await machine(org.a);
      const policy = await asActor(manager(org.a), () =>
        insurance.recordPolicy(assetId, {
          policyNumber: `POL-${ulid().slice(-8)}`,
          insurerName: 'بیمه نمونه',
          coverage: 'COMPREHENSIVE',
          validFrom: new Date(Date.now() - 400 * day).toISOString(),
          validTo: new Date(Date.now() + day).toISOString(),
        }),
      );
      // recordPolicy refuses a policy that has already lapsed, so the term is
      // moved into the past afterwards.
      await prisma.client.$executeRawUnsafe(
        `UPDATE insurance_policy SET valid_to = now() - interval '1 day' WHERE id = $1`,
        policy.id,
      );
      return policy.id;
    }

    const policyStatus = async (policyId: string) =>
      (
        await prisma.client.$queryRawUnsafe<{ status: string }[]>(
          `SELECT status::text AS status FROM insurance_policy WHERE id = $1`,
          policyId,
        )
      )[0]!.status;

    const expiredEvents = async (policyId: string) =>
      (await outboxFor(policyId)).filter((e) => e.eventName === INSURANCE_EVENTS.INSURANCE_EXPIRED);

    it('rolls the expiry back with its event, so the next sweep still announces it', async () => {
      const policyId = await lapsedPolicy();

      // The outbox write fails after the rows were claimed. Before the fix,
      // the EXPIRED status had already committed on its own at this point.
      const spy = jest
        .spyOn(repository, 'enqueueEvent')
        .mockRejectedValueOnce(new Error('simulated crash while writing the outbox'));
      await expect(insurance.runExpirySweep()).rejects.toThrow(/simulated crash/);
      spy.mockRestore();

      expect(await policyStatus(policyId)).toBe('ACTIVE');
      expect(await expiredEvents(policyId)).toHaveLength(0);

      await insurance.runExpirySweep();

      expect(await policyStatus(policyId)).toBe('EXPIRED');
      const events = await expiredEvents(policyId);
      expect(events).toHaveLength(1);
      // #103's contract: fleet resolves lapses per coverage.
      // The outbox row holds the whole envelope; the event's own fields are
      // under its `payload`.
      expect(events[0]!.payload).toMatchObject({
        payload: { policyId, coverage: 'COMPREHENSIVE' },
      });
    });

    it('announces each lapse once when two sweeps run at the same time', async () => {
      const policyIds = [await lapsedPolicy(), await lapsedPolicy()];

      await Promise.all([insurance.runExpirySweep(), insurance.runExpirySweep()]);

      for (const policyId of policyIds) {
        expect(await policyStatus(policyId)).toBe('EXPIRED');
        expect(await expiredEvents(policyId)).toHaveLength(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle commands are made against a version (EXP-002 slice 5)
  // ---------------------------------------------------------------------------

  describe('a lifecycle command sent twice', () => {
    /** The events and timeline entries a machine holds, by name — what actually happened to it. */
    async function history(assetId: string) {
      const outbox = (await outboxFor(assetId)).map((event) => event.eventName);
      const timeline = await asActor(manager(org.a), () =>
        assets.timeline(assetId, { limit: 50 } as never),
      );
      return { outbox, timeline: timeline.items.map((entry) => entry.eventName) };
    }
    const count = (names: string[], name: string) => names.filter((n) => n === name).length;

    async function withDossier(assetId: string) {
      await asActor(manager(org.a), () =>
        insurance.recordPolicy(assetId, {
          policyNumber: `POL-${ulid().slice(-8)}`,
          insurerName: 'بیمه نمونه',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - day).toISOString(),
          validTo: new Date(Date.now() + 300 * day).toISOString(),
        }),
      );
      await asActor(manager(org.a), () =>
        assets.attachDocument(assetId, {
          documentId: id('DOC'),
          kind: 'OWNERSHIP_TITLE',
          title: 'سند مالکیت',
        }),
      );
    }

    it('applies a decommission once: the replay is a 409 and writes no second event or entry', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const expectedVersion = await versionOf(assetId);
      const command = { reason: 'فرسودگی کامل ماشین', expectedVersion };

      await asActor(admin(org.a), () => assets.decommission(assetId, command));
      const afterFirst = await versionOf(assetId);
      await expect(
        asActor(admin(org.a), () => assets.decommission(assetId, command)),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      expect(await versionOf(assetId)).toBe(afterFirst);
      expect(afterFirst).toBe(expectedVersion + 1);
      const { outbox, timeline } = await history(assetId);
      expect(count(outbox, ASSET_EVENTS.ASSET_DECOMMISSIONED)).toBe(1);
      expect(count(timeline, ASSET_EVENTS.ASSET_DECOMMISSIONED)).toBe(1);
    });

    it('applies a status change once, and a stale one cannot apply it again after the machine moved back', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const first = await versionOf(assetId);
      const idle = { status: 'IDLE' as const, reason: 'فصل غیرکاری', expectedVersion: first };

      await asActor(manager(org.a), () => assets.changeStatus(assetId, idle));
      // The identical form again, at once: refused.
      await expect(
        asActor(manager(org.a), () => assets.changeStatus(assetId, idle)),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      // Somebody returns the machine to service; now the old "mark idle" form,
      // whose status check alone (ACTIVE → IDLE is legal) would pass, is sent.
      await asActor(manager(org.a), async () =>
        assets.changeStatus(assetId, {
          status: 'ACTIVE',
          reason: 'بازگشت به سرویس',
          expectedVersion: await versionOf(assetId),
        }),
      );
      expect((await statusOf(assetId)).status).toBe('ACTIVE');
      await expect(
        asActor(manager(org.a), () => assets.changeStatus(assetId, idle)),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      expect((await statusOf(assetId)).status).toBe('ACTIVE');
      expect(await versionOf(assetId)).toBe(first + 2);
      const { outbox, timeline } = await history(assetId);
      expect(count(outbox, ASSET_EVENTS.ASSET_STATUS_CHANGED)).toBe(2);
      expect(count(timeline, ASSET_EVENTS.ASSET_STATUS_CHANGED)).toBe(2);
    });

    it('applies an activation once', async () => {
      const assetId = await machine(org.a);
      await withDossier(assetId);
      const expectedVersion = await versionOf(assetId);

      await asActor(manager(org.a), () => assets.activate(assetId, { expectedVersion }));
      await expect(
        asActor(manager(org.a), () => assets.activate(assetId, { expectedVersion })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      expect((await statusOf(assetId)).status).toBe('ACTIVE');
      const { outbox, timeline } = await history(assetId);
      expect(count(outbox, ASSET_EVENTS.ASSET_ACTIVATED)).toBe(1);
      expect(count(timeline, ASSET_EVENTS.ASSET_ACTIVATED)).toBe(1);
    });

    it('lets one of two identical commands that race win, and the other writes nothing', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const expectedVersion = await versionOf(assetId);

      const release = await holdRowLock(assetId);
      // Both read the same version, then queue behind the lock on the UPDATE.
      const send = () =>
        asActor(manager(org.a), () =>
          assets.changeStatus(assetId, { status: 'IDLE', reason: 'فصل غیرکاری', expectedVersion }),
        );
      const first = send();
      await waitForBlocked(1);
      const second = send();
      const settled = Promise.allSettled([first, second]); // before release(), as above
      await waitForBlocked(2);
      await release();

      const [won, lost] = await settled;
      expect(won.status).toBe('fulfilled');
      expect(lost).toMatchObject({
        status: 'rejected',
        reason: { code: 'OPTIMISTIC_LOCK_FAILED' },
      });
      expect(await versionOf(assetId)).toBe(expectedVersion + 1);
      const { outbox } = await history(assetId);
      expect(count(outbox, ASSET_EVENTS.ASSET_STATUS_CHANGED)).toBe(1);
    });

    it('refuses a stale version before it judges the transition, so a replayed decommission is not a 422', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const expectedVersion = await versionOf(assetId);
      await asActor(admin(org.a), () =>
        assets.decommission(assetId, { reason: 'فرسودگی کامل ماشین', expectedVersion }),
      );

      // A different command, same stale version, against a terminal asset.
      await expect(
        asActor(manager(org.a), () =>
          assets.changeStatus(assetId, { status: 'IDLE', reason: 'دیرهنگام', expectedVersion }),
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
    });

    it('does not let a plain status change commission a REGISTERED machine around the dossier check', async () => {
      const assetId = await machine(org.a);
      const expectedVersion = await versionOf(assetId);

      await expect(
        asActor(manager(org.a), () =>
          assets.changeStatus(assetId, { status: 'ACTIVE', reason: 'دور زدن', expectedVersion }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

      expect((await statusOf(assetId)).status).toBe('REGISTERED');
      expect(await versionOf(assetId)).toBe(expectedVersion);
      expect((await history(assetId)).outbox).not.toContain(ASSET_EVENTS.ASSET_STATUS_CHANGED);
    });

    it('still lets an event from another service move the status, with no version', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const before = await versionOf(assetId);

      await asActor(manager(org.a), () =>
        consumer.handle(envelope('ASSET_ASSIGNED', assetId, org.a)),
      );

      expect((await statusOf(assetId)).status).toBe('ASSIGNED');
      expect(await versionOf(assetId)).toBe(before + 1);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation of every changed write path
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it("answers NOT_FOUND to every changed write on another organization's asset", async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');
      const policy = await asActor(manager(org.a), () =>
        insurance.recordPolicy(assetId, {
          policyNumber: `POL-${ulid().slice(-8)}`,
          insurerName: 'بیمه نمونه',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - day).toISOString(),
          validTo: new Date(Date.now() + 300 * day).toISOString(),
        }),
      );

      const attempts: Array<[string, () => Promise<unknown>]> = [
        ['update', () => assets.update(assetId, { name: 'ربوده', expectedVersion: 1 })],
        [
          'changeStatus',
          () => assets.changeStatus(assetId, { status: 'IDLE', reason: 'x', expectedVersion: 1 }),
        ],
        [
          'decommission',
          () => assets.decommission(assetId, { reason: 'ربوده', expectedVersion: 1 }),
        ],
        ['activate', () => assets.activate(assetId, { expectedVersion: 1 })],
        [
          'transfer',
          () =>
            assets.transfer(assetId, {
              toOrganizationId: org.b,
              reason: 'تلاش برای انتقال دارایی دیگری',
            }),
        ],
        [
          'recordLocation',
          () => assets.recordLocation(assetId, { siteName: 'x', source: 'MANUAL' } as never),
        ],
        [
          'attachDocument',
          () =>
            assets.attachDocument(assetId, {
              documentId: id('DOC'),
              kind: 'OTHER',
              title: 'مدرک',
            }),
        ],
        [
          'submitClaim',
          () =>
            claims.submitClaim(assetId, {
              policyId: policy.id,
              description: 'ادعای جعلی از سازمان دیگر',
              incidentAt: new Date().toISOString(),
            }),
        ],
      ];

      const outcomes: Record<string, string | undefined> = {};
      for (const [name, attempt] of attempts) {
        outcomes[name] = await asActor(admin(org.b), attempt).then(
          () => 'succeeded',
          (error: { code?: string }) => error.code,
        );
      }
      expect(outcomes).toEqual(Object.fromEntries(attempts.map(([name]) => [name, 'NOT_FOUND'])));
      expect(await statusOf(assetId)).toEqual({ status: 'ACTIVE', organizationId: org.a });
      const leaked = (await outboxFor(assetId)).filter((e) =>
        [INSURANCE_EVENTS.INSURANCE_CLAIM_OPENED, ASSET_EVENTS.ASSET_TRANSFERRED].includes(
          e.eventName as never,
        ),
      );
      expect(leaked).toHaveLength(0);
    });
  });
});
