import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import { INSURANCE_COVERAGES, type TransferInsurancePolicy } from '../src/insurance/ownership';
import { InsurancePolicyStandingService } from '../src/insurance/policy-standing';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma, ownerDatabaseUrl, tenants } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * The internal read fleet-service verifies every `INSURANCE_RECORDED` against
 * (ADR-061 § 4, #240 r6), against PostgreSQL: whether a policy counts for the
 * asset's CURRENT owner under the CURRENT following rule, and the window and
 * generation it holds now. Tenant from the signed token only.
 *
 * The bodies asserted here are the wire shape fleet-service's
 * `InsurancePolicyClient` parses (its spec asserts the same shapes).
 */
describe('insurance policy standing (internal)', () => {
  const org = tenants();
  const third = `ORG-ITEST-C-${ulid().slice(-10)}`;
  const day = 86_400_000;
  const everything: TransferInsurancePolicy = { coveragesFollowingVehicle: INSURANCE_COVERAGES };
  const onlyThirdParty: TransferInsurancePolicy = { coveragesFollowingVehicle: ['THIRD_PARTY'] };

  let prisma: PrismaService;
  let owner: PrismaService;
  let repository: AssetRepository;
  let assets: AssetService;
  let insurance: InsuranceService;
  let standing: InsurancePolicyStandingService;
  let narrowed: InsurancePolicyStandingService;

  function asService<T>(
    fn: () => Promise<T>,
    overrides: Partial<RequestContext> & { organizationId?: string | undefined } = {},
  ): Promise<T> {
    const context: RequestContext = {
      correlationId: `itest-${ulid()}`,
      requestId: `itest-${ulid()}`,
      organizationId: org.a,
      roles: [],
      organizationIds: [],
      authType: 'SERVICE',
      callerService: 'fleet-service',
      startedAt: Date.now(),
      ...overrides,
    };
    return runWithContext(context, async () => fn());
  }

  const admin = (organizationId: string) => ({
    organizationId,
    roles: ['ORGANIZATION_ADMIN'],
    userId: `USR-ADMIN-${organizationId.slice(-4)}`,
  });
  const manager = (organizationId: string) => ({ organizationId, roles: ['FLEET_MANAGER'] });

  async function machine(organizationId: string): Promise<string> {
    const created = await asActor(manager(organizationId), () =>
      assets.create({
        name: 'لودر بیمه',
        type: 'LOADER',
        assetTag: `TAG-${ulid().slice(-6)}`,
        specifications: {},
      } as never),
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET status = 'ACTIVE'::"OperationalStatus" WHERE id = $1`,
      created.id,
    );
    return created.id;
  }

  const record = async (organizationId: string, assetId: string, coverage: string) => {
    const created = await asActor(manager(organizationId), () =>
      insurance.recordPolicy(assetId, {
        policyNumber: `POL-${ulid().slice(-8)}`,
        insurerName: 'بیمه نمونه',
        coverage: coverage as never,
        validFrom: new Date(Date.now() - day).toISOString(),
        validTo: new Date(Date.now() + 100 * day).toISOString(),
      }),
    );
    const [row] = await owner.client.$queryRawUnsafe<{ valid_from: Date; valid_to: Date }[]>(
      `SELECT valid_from, valid_to FROM insurance_policy WHERE id = $1`,
      created.id,
    );
    return { id: created.id, validFrom: row!.valid_from, validTo: row!.valid_to };
  };

  const transfer = (assetId: string, from: string, to: string) =>
    asActor(admin(from), () => assets.transfer(assetId, { toOrganizationId: to, reason: 'آزمون' }));

  const generationOf = async (assetId: string) =>
    (
      await owner.client.$queryRawUnsafe<{ ownership_generation: number }[]>(
        `SELECT ownership_generation FROM asset WHERE id = $1`,
        assetId,
      )
    )[0]!.ownership_generation;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    owner = new PrismaService(ownerDatabaseUrl());
    repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners());
    insurance = new InsuranceService(repository, assets, 30);
    standing = new InsurancePolicyStandingService(repository, everything);
    narrowed = new InsurancePolicyStandingService(repository, onlyThirdParty);

    for (const organizationId of [org.a, org.b, third]) {
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
    const orgs = [org.a, org.b, third];
    await owner.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    for (const table of ['asset_timeline_entry', 'insurance_policy', 'asset_transfer', 'asset']) {
      await owner.client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id = ANY($1::text[])`,
        orgs,
      );
    }
    await owner.client.$executeRawUnsafe(
      `DELETE FROM organization_ref WHERE id = ANY($1::text[])`,
      orgs,
    );
    await owner.onModuleDestroy();
    await prisma.onModuleDestroy();
  });

  it('tells the current owner a counting policy’s window and the current generation', async () => {
    const assetId = await machine(org.a);
    const policy = await record(org.a, assetId, 'COMPREHENSIVE');

    const answer = await asService(() => standing.standing(assetId, policy.id));

    expect(answer).toEqual({
      transferred: false,
      assetId,
      policyId: policy.id,
      organizationId: org.a,
      counts: true,
      coverage: 'COMPREHENSIVE',
      validFrom: policy.validFrom.toISOString(),
      validUntil: policy.validTo.toISOString(),
      ownershipGeneration: await generationOf(assetId),
    });
  });

  it('says a cancelled policy does not count', async () => {
    const assetId = await machine(org.a);
    const policy = await record(org.a, assetId, 'THIRD_PARTY');
    await owner.client.$executeRawUnsafe(
      `UPDATE insurance_policy SET status = 'CANCELLED'::"PolicyStatus" WHERE id = $1`,
      policy.id,
    );

    await expect(asService(() => standing.standing(assetId, policy.id))).resolves.toEqual({
      transferred: false,
      assetId,
      policyId: policy.id,
      organizationId: org.a,
      counts: false,
      reason: 'NOT_ACTIVE',
    });
  });

  it('applies the CURRENT following rule: a list narrowed since the event takes a coverage out', async () => {
    const assetId = await machine(org.a);
    const comprehensive = await record(org.a, assetId, 'COMPREHENSIVE');
    const thirdParty = await record(org.a, assetId, 'THIRD_PARTY');
    await transfer(assetId, org.a, org.b);

    // Under the rule in force when the policy was recorded, both follow.
    await expect(
      asService(() => standing.standing(assetId, comprehensive.id), { organizationId: org.b }),
    ).resolves.toMatchObject({ counts: true });

    // Under the narrowed rule only the third-party policy still counts for the new owner.
    await expect(
      asService(() => narrowed.standing(assetId, comprehensive.id), { organizationId: org.b }),
    ).resolves.toMatchObject({ counts: false, reason: 'NOT_FOLLOWING_VEHICLE' });
    await expect(
      asService(() => narrowed.standing(assetId, thirdParty.id), { organizationId: org.b }),
    ).resolves.toMatchObject({ counts: true, ownershipGeneration: await generationOf(assetId) });
  });

  it('A→B→A: a policy of A’s first tenure does not count for A’s second; one recorded in it does', async () => {
    const assetId = await machine(org.a);
    const firstTenure = await record(org.a, assetId, 'COMPREHENSIVE');
    await transfer(assetId, org.a, org.b);
    await asActor(admin(org.b), () =>
      assets.transfer(assetId, { toOrganizationId: org.a, reason: 'بازگشت' }),
    );
    const secondTenure = await record(org.a, assetId, 'COMPREHENSIVE');

    await expect(
      asService(() => narrowed.standing(assetId, firstTenure.id)),
    ).resolves.toMatchObject({ counts: false, reason: 'NOT_FOLLOWING_VEHICLE' });
    await expect(
      asService(() => narrowed.standing(assetId, secondTenure.id)),
    ).resolves.toMatchObject({ counts: true, ownershipGeneration: await generationOf(assetId) });
  });

  it('tells a previous owner only that the machine moved, and to whom', async () => {
    const assetId = await machine(org.a);
    const policy = await record(org.a, assetId, 'COMPREHENSIVE');
    await transfer(assetId, org.a, org.b);

    const seen = await asService(() => standing.standing(assetId, policy.id));

    expect(seen).toEqual({ transferred: true, assetId, organizationId: org.b });
  });

  it('gives everyone else, an unknown asset and another asset’s policy the same 404', async () => {
    const assetId = await machine(org.a);
    const policy = await record(org.a, assetId, 'THIRD_PARTY');
    const other = await machine(org.a);

    const refusals = await Promise.all(
      [
        asService(() => standing.standing(assetId, policy.id), { organizationId: third }),
        asService(() => standing.standing(assetId, policy.id), { organizationId: org.b }),
        asService(() => standing.standing(`AST_${ulid()}`, policy.id)),
        asService(() => standing.standing(other, policy.id)),
        asService(() => standing.standing(assetId, `INS_${ulid()}`)),
      ].map((call) => call.catch((error: unknown) => error)),
    );

    for (const refusal of refusals) {
      expect(refusal).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('is closed to user tokens, to other services, and to a token with no organization', async () => {
    const assetId = await machine(org.a);
    const policy = await record(org.a, assetId, 'THIRD_PARTY');

    await expect(
      asService(() => standing.standing(assetId, policy.id), { authType: 'USER' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const callerService of ['maintenance-service', 'economic-service', undefined]) {
      await expect(
        asService(() => standing.standing(assetId, policy.id), { callerService }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(
      asService(() => standing.standing(assetId, policy.id), { organizationId: undefined }),
    ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
  });
});
