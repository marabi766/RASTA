import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { ASSET_EVENTS, INSURANCE_EVENTS } from '../src/asset/events';
import { createAssetSchema } from '../src/asset/dto';
import { InsuranceService } from '../src/insurance/insurance.service';
import { ClaimService } from '../src/insurance/claim.service';
import { TimelineConsumer } from '../src/consumers/timeline.consumer';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

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
      prisma.client.outboxMessage.findMany({ where: { aggregateId }, orderBy: { createdAt: 'asc' } }),
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
    assets = new AssetService(repository);
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

      const release = await holdRowLock(assetId);
      // Both requests read ACTIVE now and then block on the row lock.
      const decommission = asActor(manager(org.a), () =>
        assets.decommission(assetId, { reason: 'فرسودگی کامل' }),
      );
      await waitForBlocked(1);
      const idle = asActor(manager(org.a), () =>
        assets.changeStatus(assetId, { status: 'IDLE', reason: 'فصل غیرکاری' }),
      );
      await waitForBlocked(2);
      await release();

      const [won, lost] = await Promise.allSettled([decommission, idle]);
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

      const release = await holdRowLock(assetId);
      const decommission = asActor(manager(org.a), () =>
        assets.decommission(assetId, { reason: 'فرسودگی کامل' }),
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
      const entries = await asActor(manager(org.a), () => assets.timeline(assetId, { limit: 50 } as never));
      expect(entries.items.map((e) => e.eventName)).toContain('MAINTENANCE_STARTED');
    });

    it('refuses an edit that races a decommission', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');

      const release = await holdRowLock(assetId);
      const decommission = asActor(manager(org.a), () =>
        assets.decommission(assetId, { reason: 'فرسودگی کامل' }),
      );
      await waitForBlocked(1);
      const edit = asActor(manager(org.a), () => assets.update(assetId, { name: 'نام تازه' }));
      await waitForBlocked(2);
      await release();

      const [, edited] = await Promise.allSettled([decommission, edit]);
      expect(edited).toMatchObject({
        status: 'rejected',
        reason: { code: 'OPTIMISTIC_LOCK_FAILED' },
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

      // The previous owner's policy is history, not the new owner's cover.
      await expect(
        asActor(manager(org.b), () => assets.activate(assetId, {})),
      ).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: expect.objectContaining({
          rule: 'INCOMPLETE_DOSSIER',
          missing: ['an insurance policy currently in force'],
        }),
      });
      const dossier = await asActor(manager(org.b), () => assets.dossier(assetId));
      expect(dossier.compliance.activeInsurance).toBeNull();
      expect(dossier.transferCount).toBe(1);
      await expect(
        asActor(manager(org.b), () =>
          claims.submitClaim(assetId, {
            policyId: policy.id,
            description: 'خسارت پس از انتقال مالکیت',
            incidentAt: new Date(Date.now() - day).toISOString(),
          }),
        ),
      ).rejects.toThrow(/previous owner/);

      // With a policy of their own, the new owner commissions the asset.
      await asActor(manager(org.b), () =>
        insurance.recordPolicy(assetId, {
          policyNumber: `POL-${ulid().slice(-8)}`,
          insurerName: 'بیمه نمونه',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - day).toISOString(),
          validTo: new Date(Date.now() + 300 * day).toISOString(),
        }),
      );
      const activated = await asActor(manager(org.b), () => assets.activate(assetId, {}));
      expect(activated.status).toBe('ACTIVE');
    });

    it('fails the second of two concurrent transfers', async () => {
      const assetId = await machine(org.a);
      await setStatus(assetId, 'ACTIVE');

      const release = await holdRowLock(assetId);
      const first = transfer(assetId);
      await waitForBlocked(1);
      const second = transfer(assetId);
      await waitForBlocked(2);
      await release();

      const [won, lost] = await Promise.allSettled([first, second]);
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
        ['update', () => assets.update(assetId, { name: 'ربوده' })],
        ['changeStatus', () => assets.changeStatus(assetId, { status: 'IDLE', reason: 'x' })],
        ['decommission', () => assets.decommission(assetId, { reason: 'ربوده' })],
        ['activate', () => assets.activate(assetId, {})],
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
      expect(outcomes).toEqual(
        Object.fromEntries(attempts.map(([name]) => [name, 'NOT_FOUND'])),
      );
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
