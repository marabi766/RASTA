import { runUnscoped } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import { ClaimService } from '../src/insurance/claim.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * The insurance money columns refuse a negative amount (audit L7-36), against a
 * real PostgreSQL, connected as the service's runtime role.
 *
 * The API refuses a negative amount before any service runs (`amountMinorSchema`;
 * `negative-amount-http.spec.ts`). Two things only the database can show:
 *
 *   1. **The constraints themselves.** A statement written directly — no DTO, no
 *      service — is refused by the constraint for its column; NULL ("not
 *      stated") and zero are not.
 *   2. **Every write path's answer.** A service called in-process, past the
 *      DTO, with a negative amount reaches the database and is refused there.
 *      What the caller gets is the API's own 400 for a bad amount, never a 500,
 *      and the transaction leaves nothing: no row, no event, no dossier line.
 */
describe('insurance money is never negative', () => {
  const org = tenants();
  const day = 86_400_000;
  const NEGATIVE_AMOUNT = {
    code: 'VALIDATION_FAILED',
    status: 400,
  };
  const issueOn = (path: string) => [
    {
      path,
      code: 'invalid_string',
      message: 'Amount must be a non-negative integer string in minor units',
    },
  ];

  let prisma: PrismaService;
  let assets: AssetService;
  let insurance: InsuranceService;
  let claims: ClaimService;
  let assetId: string;
  let policyId: string;

  const fleetManager = { organizationId: org.a, roles: ['FLEET_MANAGER'] };
  const admin = {
    organizationId: org.a,
    roles: ['ORGANIZATION_ADMIN'],
    userId: `USR-ADMIN-${org.a.slice(-4)}`,
  };

  const policyInput = (amounts: { premiumMinor?: string; insuredValueMinor?: string }) => ({
    policyNumber: `POL-${id('P').slice(-8)}`,
    insurerName: 'بیمه نمونه',
    coverage: 'COMPREHENSIVE' as const,
    validFrom: new Date(Date.now() - 100 * day).toISOString(),
    validTo: new Date(Date.now() + 200 * day).toISOString(),
    ...amounts,
  });

  const submit = (claimedAmountMinor?: string) =>
    asActor(fleetManager, () =>
      claims.submitClaim(assetId, {
        policyId,
        description: 'برخورد با مانع در جاده روستایی، آسیب به بدنه',
        incidentAt: new Date(Date.now() - 5 * day).toISOString(),
        ...(claimedAmountMinor === undefined ? {} : { claimedAmountMinor }),
      }),
    );

  /** Everything a refused write could have left behind on this asset. */
  const footprint = () =>
    runUnscoped('test inspection', async () => ({
      policies: await prisma.client.insurancePolicy.count({ where: { assetId } }),
      claims: await prisma.client.insuranceClaim.count({ where: { assetId } }),
      timeline: await prisma.client.assetTimelineEntry.count({ where: { assetId } }),
      outbox: await prisma.client.outboxMessage.count({ where: { organizationId: org.a } }),
    }));

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();

    const repository = new AssetRepository(prisma);
    assets = new AssetService(repository);
    insurance = new InsuranceService(repository, assets, 30);
    claims = new ClaimService(repository, assets, {
      decisionRoles: ['ORGANIZATION_ADMIN'],
      approvalCeilingMinor: null,
    });

    assetId = (
      await asActor(fleetManager, () =>
        assets.create({ name: 'لودر پول', type: 'LOADER', specifications: {} } as never),
      )
    ).id;
    policyId = (
      await asActor(fleetManager, () =>
        insurance.recordPolicy(assetId, policyInput({ premiumMinor: '5000' })),
      )
    ).id;
  });

  afterAll(async () => {
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id = $1`,
      org.a,
    );
    for (const table of ['asset_timeline_entry', 'insurance_claim', 'insurance_policy', 'asset']) {
      await prisma.client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id = $1`,
        org.a,
      );
    }
    await prisma.onModuleDestroy();
  });

  describe('written directly as the runtime role', () => {
    let claimId: string;

    beforeAll(async () => {
      claimId = (await submit('100')).id;
    });

    it('is connected as the runtime role: no superuser, not the tables’ owner', async () => {
      const [row] = await prisma.client.$queryRawUnsafe<{ superuser: boolean; owns: boolean }[]>(
        `SELECT r.rolsuper AS superuser,
                EXISTS (SELECT 1 FROM pg_tables
                         WHERE tablename IN ('insurance_policy', 'insurance_claim')
                           AND tableowner = current_user) AS owns
           FROM pg_roles r WHERE r.rolname = current_user`,
      );
      expect(row).toEqual({ superuser: false, owns: false });
    });

    const STATEMENTS = [
      ['ck_policy_premium_non_negative', 'insurance_policy', 'premium_minor'],
      ['ck_policy_insured_value_non_negative', 'insurance_policy', 'insured_value_minor'],
      ['ck_claim_claimed_amount_non_negative', 'insurance_claim', 'claimed_amount_minor'],
      ['ck_claim_approved_amount_non_negative', 'insurance_claim', 'approved_amount_minor'],
    ] as const;

    it.each(STATEMENTS)('%s refuses a negative %s.%s', async (constraint, table, column) => {
      const rowId = table === 'insurance_policy' ? policyId : claimId;
      const refused = prisma.client.$executeRawUnsafe(
        `UPDATE ${table} SET ${column} = -1 WHERE id = $1`,
        rowId,
      );
      await expect(refused).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
      await expect(
        prisma.client.$executeRawUnsafe(`UPDATE ${table} SET ${column} = -1 WHERE id = $1`, rowId),
      ).rejects.toThrow(new RegExp(`violates check constraint "${constraint}"`));
    });

    it.each(STATEMENTS)('%s accepts NULL and zero in %s.%s', async (_constraint, table, column) => {
      const rowId = table === 'insurance_policy' ? policyId : claimId;
      for (const value of ['NULL', '0']) {
        await expect(
          prisma.client.$executeRawUnsafe(
            `UPDATE ${table} SET ${column} = ${value} WHERE id = $1`,
            rowId,
          ),
        ).resolves.toBe(1);
      }
    });

    it('refuses a new policy row carrying a negative premium', async () => {
      await expect(
        prisma.client.$executeRawUnsafe(
          `INSERT INTO insurance_policy (id, asset_id, organization_id, policy_number, insurer_name,
                                         coverage, premium_minor, valid_from, valid_to,
                                         updated_at, created_by, updated_by)
           VALUES ($1, $2, $3, 'POL-NEG', 'بیمه نمونه', 'THIRD_PARTY', -1, now(),
                   now() + interval '1 year', now(), 'itest', 'itest')`,
          id('INS'),
          assetId,
          org.a,
        ),
      ).rejects.toThrow(/violates check constraint "ck_policy_premium_non_negative"/);
    });
  });

  describe('every write path answers the API’s 400, writes nothing', () => {
    it.each([['premiumMinor'], ['insuredValueMinor']] as const)(
      'recordPolicy with a negative %s',
      async (field) => {
        const before = await footprint();
        await expect(
          asActor(fleetManager, () =>
            insurance.recordPolicy(assetId, policyInput({ [field]: '-1' })),
          ),
        ).rejects.toMatchObject({ ...NEGATIVE_AMOUNT, details: issueOn(field) });
        expect(await footprint()).toEqual(before);
      },
    );

    it('submitClaim with a negative claimedAmountMinor', async () => {
      const before = await footprint();
      await expect(submit('-1')).rejects.toMatchObject({
        ...NEGATIVE_AMOUNT,
        details: issueOn('claimedAmountMinor'),
      });
      expect(await footprint()).toEqual(before);
    });

    it('decide with a negative approvedAmountMinor leaves the claim undecided', async () => {
      const filed = await submit('100');
      await asActor(fleetManager, () => claims.startReview(assetId, filed.id, {}));
      const before = await footprint();

      await expect(
        asActor(admin, () =>
          claims.decide(assetId, filed.id, {
            decision: 'APPROVED',
            approvedAmountMinor: '-1',
            notes: 'مطابق ارزیابی کارشناس',
          }),
        ),
      ).rejects.toMatchObject({ ...NEGATIVE_AMOUNT, details: issueOn('approvedAmountMinor') });

      expect(await footprint()).toEqual(before);
      const row = await asActor(fleetManager, () => claims.getClaim(assetId, filed.id));
      expect(row).toMatchObject({
        status: 'UNDER_REVIEW',
        approvedAmountMinor: null,
        decidedAt: null,
      });
    });
  });
});
