import { runUnscoped } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import { ClaimService } from '../src/insurance/claim.service';
import { INSURANCE_EVENTS } from '../src/asset/events';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * Insurance claims against a real PostgreSQL.
 *
 * Four things only the database can show:
 *
 *   1. **Tenant isolation.** Every read and every transition goes through the
 *      scoped client; a mock returns what it is told. Only rows that actually
 *      belong to a neighbouring organization can prove they stay invisible —
 *      and that "invisible" is a 404, not a 403 that confirms the row exists.
 *   2. **The CHECK constraints.** They live in the migration, not in Prisma's
 *      schema, so nothing but the database can prove they refuse the shapes
 *      they were written to refuse.
 *   3. **The race.** Two decisions on the same claim at once. The guard is the
 *      status predicate in the UPDATE, and whether it holds under real
 *      concurrent transactions is a property of PostgreSQL's row locking, not
 *      of any TypeScript.
 *   4. **The outbox.** Four transitions, one stream keyed by the claim id,
 *      sequence dense from 1 (ADR-051 B3).
 */
describe('insurance claims', () => {
  const org = tenants();
  const day = 86_400_000;

  let prisma: PrismaService;
  let assets: AssetService;
  let insurance: InsuranceService;
  let claims: ClaimService;

  let assetA: string;
  let assetA2: string;
  let assetB: string;
  let policyA: string;
  let policyA2: string;
  let policyB: string;

  const fleetManager = (organizationId: string) => ({ organizationId, roles: ['FLEET_MANAGER'] });
  const admin = (organizationId: string) => ({
    organizationId,
    roles: ['ORGANIZATION_ADMIN'],
    userId: `USR-ADMIN-${organizationId.slice(-4)}`,
  });

  const incidentAt = new Date(Date.now() - 5 * day).toISOString();

  async function machine(organizationId: string, name: string): Promise<string> {
    const created = await asActor(fleetManager(organizationId), () =>
      assets.create({ name, type: 'LOADER', specifications: {} } as never),
    );
    return created.id;
  }

  async function policy(organizationId: string, assetId: string): Promise<string> {
    const created = await asActor(fleetManager(organizationId), () =>
      insurance.recordPolicy(assetId, {
        policyNumber: `POL-${id('P').slice(-8)}`,
        insurerName: 'بیمه نمونه',
        coverage: 'COMPREHENSIVE',
        validFrom: new Date(Date.now() - 100 * day).toISOString(),
        validTo: new Date(Date.now() + 200 * day).toISOString(),
      }),
    );
    return created.id;
  }

  const submit = (organizationId: string, assetId: string, policyId: string) =>
    asActor(fleetManager(organizationId), () =>
      claims.submitClaim(assetId, {
        policyId,
        description: 'برخورد با مانع در جاده روستایی، آسیب به بدنه',
        incidentAt,
        claimedAmountMinor: '120000000',
      }),
    );

  const outboxFor = (aggregateId: string) =>
    runUnscoped('the outbox audit reads platform plumbing', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    await prisma.client.$queryRawUnsafe('SELECT 1');

    const repository = new AssetRepository(prisma);
    assets = new AssetService(repository);
    insurance = new InsuranceService(repository, assets, 30);
    claims = new ClaimService(repository, assets, {
      decisionRoles: ['ORGANIZATION_ADMIN'],
      approvalCeilingMinor: null,
    });

    assetA = await machine(org.a, 'لودر الف');
    assetA2 = await machine(org.a, 'لودر الف-۲');
    assetB = await machine(org.b, 'لودر ب');
    policyA = await policy(org.a, assetA);
    policyA2 = await policy(org.a, assetA2);
    policyB = await policy(org.b, assetB);
  });

  afterAll(async () => {
    const orgs = [org.a, org.b];
    const claimIds = await runUnscoped('test cleanup', () =>
      prisma.client.insuranceClaim.findMany({
        where: { organizationId: { in: orgs } },
        select: { id: true },
      }),
    );
    const assetIds = [assetA, assetA2, assetB];

    await prisma.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE aggregate_id = ANY($1::text[])`,
      [...claimIds.map((c) => c.id), policyA, policyA2, policyB, ...assetIds],
    );
    for (const table of [
      'asset_timeline_entry',
      'insurance_claim',
      'insurance_policy',
      'asset_location',
      'asset',
    ]) {
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id = ANY($1::text[])`,
        orgs,
      );
    }
    await prisma.onModuleDestroy();
  });

  it('walks a claim from filed to settled, writing one row, four events and four dossier lines', async () => {
    const filed = await submit(org.a, assetA, policyA);
    expect(filed.status).toBe('SUBMITTED');
    expect(filed.claimedAmountMinor).toBe('120000000');

    const reviewed = await asActor(fleetManager(org.a), () =>
      claims.startReview(assetA, filed.id, { notes: 'در دست بررسی' }),
    );
    expect(reviewed.status).toBe('UNDER_REVIEW');

    const decided = await asActor(admin(org.a), () =>
      claims.decide(assetA, filed.id, {
        decision: 'APPROVED',
        approvedAmountMinor: '100000000',
        notes: 'مطابق ارزیابی کارشناس',
      }),
    );
    expect(decided.status).toBe('APPROVED');
    expect(decided.approvedAmountMinor).toBe('100000000');
    expect(decided.decidedBy).toBe(admin(org.a).userId);

    const settled = await asActor(admin(org.a), () =>
      claims.recordSettlement(assetA, filed.id, { settlementReference: 'INSURER-PAY-42' }),
    );
    expect(settled.status).toBe('SETTLED');
    expect(settled.settlementReference).toBe('INSURER-PAY-42');

    // The row, as the database holds it: bigint, not a float, not a string.
    const row = await asActor(fleetManager(org.a), () =>
      prisma.client.insuranceClaim.findFirst({ where: { id: filed.id } }),
    );
    expect(row?.approvedAmountMinor).toBe(100_000_000n);
    expect(row?.decidedAt).not.toBeNull();
    expect(row?.settledAt).not.toBeNull();

    // One stream per claim, dense from 1, in the order the transitions happened.
    const events = await outboxFor(filed.id);
    expect(events.map((e) => e.eventName)).toEqual([
      INSURANCE_EVENTS.INSURANCE_CLAIM_OPENED,
      INSURANCE_EVENTS.INSURANCE_CLAIM_REVIEW_STARTED,
      INSURANCE_EVENTS.INSURANCE_CLAIM_DECIDED,
      INSURANCE_EVENTS.INSURANCE_CLAIM_SETTLEMENT_RECORDED,
    ]);
    for (const event of events) {
      expect(event.topic).toBe('rasta.insurance.v1');
      expect(event.partitionKey).toBe(filed.id);
      expect(event.organizationId).toBe(org.a);
    }
    expect(events.map((e) => Number(e.streamSeq))).toEqual([1, 2, 3, 4]);

    // The decision event carries what economic-service will need, as strings.
    const decision = events[2]?.payload as { payload?: Record<string, unknown> };
    expect(decision.payload).toMatchObject({
      decision: 'APPROVED',
      approvedAmountMinor: '100000000',
      decidedBy: admin(org.a).userId,
    });

    // And the dossier tells the same story, oldest first.
    const detail = await asActor(fleetManager(org.a), () => claims.getClaim(assetA, filed.id));
    expect(detail.history.map((h) => h.status)).toEqual([
      'SUBMITTED',
      'UNDER_REVIEW',
      'APPROVED',
      'SETTLED',
    ]);
    expect(detail.history[2]).toMatchObject({
      actor: admin(org.a).userId,
      notes: 'مطابق ارزیابی کارشناس',
    });
  });

  describe('tenant isolation', () => {
    let claimA: string;

    beforeAll(async () => {
      claimA = (await submit(org.a, assetA2, policyA2)).id;
    });

    it('does not list, read or transition a neighbouring organization’s claim', async () => {
      // The asset itself is invisible, so every route under it answers 404.
      await expect(
        asActor(fleetManager(org.b), () => claims.listClaims(assetA2)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        asActor(fleetManager(org.b), () => claims.getClaim(assetA2, claimA)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        asActor(admin(org.b), () => claims.startReview(assetA2, claimA, {})),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // And the claim id alone, under the neighbour's own asset, is 404 too —
      // a 403 here would confirm the claim exists.
      await expect(
        asActor(fleetManager(org.b), () => claims.getClaim(assetB, claimA)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // At the row level: the scoped client returns nothing for the id.
      const seenByB = await asActor(fleetManager(org.b), () =>
        prisma.client.insuranceClaim.findFirst({ where: { id: claimA } }),
      );
      expect(seenByB).toBeNull();

      // Nothing moved.
      const row = await asActor(fleetManager(org.a), () =>
        prisma.client.insuranceClaim.findFirst({ where: { id: claimA } }),
      );
      expect(row?.status).toBe('SUBMITTED');
    });

    it('keeps each organization’s list to its own claims', async () => {
      const claimB = (await submit(org.b, assetB, policyB)).id;

      const listA = await asActor(fleetManager(org.a), () => claims.listClaims(assetA2));
      const listB = await asActor(fleetManager(org.b), () => claims.listClaims(assetB));

      expect(listA.map((c) => c.id)).toEqual([claimA]);
      expect(listB.map((c) => c.id)).toEqual([claimB]);
    });

    it('refuses a policy that belongs to another machine in the same organization, as 404', async () => {
      await expect(
        asActor(fleetManager(org.a), () =>
          claims.submitClaim(assetA, {
            policyId: policyA2,
            description: 'خسارت با بیمه‌نامهٔ دستگاه دیگر',
            incidentAt,
          }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('the database refuses the shapes the state machine forbids', () => {
    let claimId: string;

    beforeAll(async () => {
      claimId = (await submit(org.a, assetA2, policyA2)).id;
    });

    it('a decided status without a decision record', async () => {
      await expect(
        prisma.client.$executeRawUnsafe(
          `UPDATE insurance_claim SET status = 'APPROVED'::"ClaimStatus" WHERE id = $1`,
          claimId,
        ),
      ).rejects.toThrow(/ck_claim_decided_iff_decision_recorded/);
    });

    it('a rejection carrying an approved amount', async () => {
      await expect(
        prisma.client.$executeRawUnsafe(
          `UPDATE insurance_claim
              SET status = 'REJECTED'::"ClaimStatus", decided_at = now(), decided_by = 'x',
                  approved_amount_minor = 1
            WHERE id = $1`,
          claimId,
        ),
      ).rejects.toThrow(/ck_claim_rejected_has_no_approved_amount/);
    });

    it('a settled status without a settlement record', async () => {
      await expect(
        prisma.client.$executeRawUnsafe(
          `UPDATE insurance_claim
              SET status = 'SETTLED'::"ClaimStatus", decided_at = now(), decided_by = 'x'
            WHERE id = $1`,
          claimId,
        ),
      ).rejects.toThrow(/ck_claim_settled_iff_settlement_recorded/);
    });
  });

  it('lets exactly one of two simultaneous decisions win', async () => {
    const filed = await submit(org.a, assetA2, policyA2);
    await asActor(fleetManager(org.a), () => claims.startReview(assetA2, filed.id, {}));

    const first = admin(org.a);
    const second = { ...admin(org.a), userId: 'USR-ADMIN-SECOND' };

    const outcomes = await Promise.allSettled([
      asActor(first, () =>
        claims.decide(assetA2, filed.id, {
          decision: 'APPROVED',
          approvedAmountMinor: '90000000',
          notes: 'تأیید اول',
        }),
      ),
      asActor(second, () =>
        claims.decide(assetA2, filed.id, { decision: 'REJECTED', notes: 'رد دوم' }),
      ),
    ]);

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });

    // The row holds one decision, the outbox one DECIDED event, the dossier
    // one decision line — the loser left no trace.
    const row = await asActor(fleetManager(org.a), () =>
      prisma.client.insuranceClaim.findFirst({ where: { id: filed.id } }),
    );
    const winner = (won[0] as PromiseFulfilledResult<{ status: string; decidedBy: string | null }>)
      .value;
    expect(row?.status).toBe(winner.status);
    expect(row?.decidedBy).toBe(winner.decidedBy);

    const decided = (await outboxFor(filed.id)).filter(
      (e) => e.eventName === INSURANCE_EVENTS.INSURANCE_CLAIM_DECIDED,
    );
    expect(decided).toHaveLength(1);

    const lines = await asActor(fleetManager(org.a), () =>
      prisma.client.assetTimelineEntry.findMany({
        where: { sourceEventId: { in: [`${filed.id}:APPROVED`, `${filed.id}:REJECTED`] } },
      }),
    );
    expect(lines).toHaveLength(1);
  });
});
