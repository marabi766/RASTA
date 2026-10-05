import { execFile } from 'node:child_process';
import path from 'node:path';
import { ulid } from 'ulid';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { registry } from '@rasta/observability';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { INSURANCE_EVENTS } from '../src/asset/events';
import { ClaimService } from '../src/insurance/claim.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import { STORED_AMOUNT_INVALID_MESSAGE } from '../src/insurance/negative-amount';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma, ownerDatabaseUrl, tenants } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * A negative insurance amount stored before the constraints (#222 r1), against
 * a real PostgreSQL.
 *
 * A NOT VALID constraint is checked on every UPDATE of a row, whichever columns
 * the UPDATE sets. So a negative amount that predates the constraints makes
 * every later update of its row fail — and the answer must be a closed 422
 * that names no amount the caller did not send, or for the expiry sweep a
 * skipped row, never a 500 or an aborted batch.
 *
 * The state is made the only way it can arise: as the tables' owner, test-only,
 * a constraint is dropped, the amount written, and the constraint added back
 * NOT VALID — exactly what a negative row committed between the migration's
 * check and its ALTERs would have left. Every test restores the validated
 * constraints afterwards.
 *
 * Last, the gap itself: with the migration's lock, a negative row a writer is
 * committing cannot slip between the check and the ALTERs.
 */
describe('a negative insurance amount stored before the constraints', () => {
  const org = tenants();
  const day = 86_400_000;
  const CLOSED_422 = {
    code: 'BUSINESS_RULE_VIOLATION',
    status: 422,
    message: STORED_AMOUNT_INVALID_MESSAGE,
  };

  const CONSTRAINTS = {
    premium_minor: ['insurance_policy', 'ck_policy_premium_non_negative'],
    insured_value_minor: ['insurance_policy', 'ck_policy_insured_value_non_negative'],
    claimed_amount_minor: ['insurance_claim', 'ck_claim_claimed_amount_non_negative'],
    approved_amount_minor: ['insurance_claim', 'ck_claim_approved_amount_non_negative'],
  } as const;
  type MoneyColumn = keyof typeof CONSTRAINTS;

  let prisma: PrismaService;
  let owner: PrismaService;
  let repository: AssetRepository;
  let assets: AssetService;
  let insurance: InsuranceService;
  let claims: ClaimService;

  const manager = (organizationId: string) => ({ organizationId, roles: ['FLEET_MANAGER'] });
  const admin = (organizationId: string) => ({
    organizationId,
    roles: ['ORGANIZATION_ADMIN'],
    userId: `USR-ADMIN-${organizationId.slice(-4)}`,
  });

  async function machine(): Promise<string> {
    const created = await asActor(manager(org.a), () =>
      assets.create({ name: 'لودر پول', type: 'LOADER', specifications: {} } as never),
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET status = 'ACTIVE'::"OperationalStatus" WHERE id = $1`,
      created.id,
    );
    return created.id;
  }

  const policyOn = async (assetId: string) =>
    (
      await asActor(manager(org.a), () =>
        insurance.recordPolicy(assetId, {
          policyNumber: `POL-${ulid().slice(-8)}`,
          insurerName: 'بیمه نمونه',
          coverage: 'COMPREHENSIVE',
          premiumMinor: '5000',
          insuredValueMinor: '900000',
          validFrom: new Date(Date.now() - 100 * day).toISOString(),
          validTo: new Date(Date.now() + 200 * day).toISOString(),
        }),
      )
    ).id;

  const claimOn = async (assetId: string, policyId: string) =>
    (
      await asActor(manager(org.a), () =>
        claims.submitClaim(assetId, {
          policyId,
          description: 'برخورد با مانع در جاده روستایی، آسیب به بدنه',
          incidentAt: new Date(Date.now() - 5 * day).toISOString(),
          claimedAmountMinor: '100',
        }),
      )
    ).id;

  /** Writes a negative amount under its constraint added back NOT VALID, as the owner. */
  async function storeNegative(column: MoneyColumn, rowId: string): Promise<void> {
    const [table, constraint] = CONSTRAINTS[column];
    await owner.client.$transaction([
      owner.client.$executeRawUnsafe(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`),
      owner.client.$executeRawUnsafe(`UPDATE ${table} SET ${column} = -5 WHERE id = $1`, rowId),
      owner.client.$executeRawUnsafe(
        `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${column} >= 0) NOT VALID`,
      ),
    ]);
  }

  /** Corrects every negative amount this suite stored and validates the four again. */
  async function restore(): Promise<void> {
    for (const [column, [table]] of Object.entries(CONSTRAINTS)) {
      await owner.client.$executeRawUnsafe(
        `UPDATE ${table} SET ${column} = 1 WHERE ${column} < 0 AND organization_id = ANY($1::text[])`,
        [org.a, org.b],
      );
    }
    for (const [column, [table, constraint]] of Object.entries(CONSTRAINTS)) {
      const present = await owner.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = $1`,
        constraint,
      );
      if (present[0]!.n === 0) {
        await owner.client.$executeRawUnsafe(
          `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${column} >= 0) NOT VALID`,
        );
      }
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`,
      );
    }
  }

  const row = async (table: string, rowId: string) =>
    (
      await owner.client.$queryRawUnsafe<{ status: string; organization_id: string }[]>(
        `SELECT status::text AS status, organization_id FROM ${table} WHERE id = $1`,
        rowId,
      )
    )[0]!;

  const outboxFor = (aggregateId: string) =>
    runUnscoped('test inspection', () =>
      prisma.client.outboxMessage.findMany({ where: { aggregateId } }),
    );

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    owner = new PrismaService(ownerDatabaseUrl());

    repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners());
    insurance = new InsuranceService(repository, assets, 30);
    claims = new ClaimService(repository, assets, {
      decisionRoles: ['ORGANIZATION_ADMIN'],
      approvalCeilingMinor: null,
    });

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

  afterEach(async () => {
    await restore();
  });

  afterAll(async () => {
    const orgs = [org.a, org.b];
    await owner.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id = ANY($1::text[])`,
      orgs,
    );
    for (const table of [
      'asset_timeline_entry',
      'insurance_claim',
      'insurance_policy',
      'asset_transfer',
      'asset',
    ]) {
      await owner.client.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id = ANY($1::text[])`,
        orgs,
      );
    }
    await owner.client.$executeRawUnsafe(
      `DELETE FROM organization_ref WHERE id = ANY($1::text[])`,
      orgs,
    );
    // Whatever happened above, the four constraints are validated again.
    const validated = await owner.client.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname = ANY($1::text[]) AND convalidated`,
      Object.values(CONSTRAINTS).map(([, constraint]) => constraint),
    );
    await owner.onModuleDestroy();
    await prisma.onModuleDestroy();
    expect(validated[0]!.n).toBe(4);
  });

  /**
   * What reaches the client names no amount, no field and no constraint; the
   * rule and the constraint go to the server log only (`internalContext`).
   */
  function expectClosed(error: unknown): void {
    const { code, message, details, internalContext } = error as RastaError;
    expect(JSON.stringify({ code, message, details })).not.toMatch(
      /-5|_minor|Minor|ck_|Failing row/,
    );
    expect(details).toBeUndefined();
    expect(internalContext).toMatchObject({ rule: 'STORED_INSURANCE_AMOUNT_INVALID' });
    expect(JSON.stringify(internalContext)).not.toMatch(/-5|Failing row/);
  }

  describe('the transfer moves the history, and an UPDATE of the stored row is refused', () => {
    const transfer = (assetId: string) =>
      asActor(admin(org.a), () =>
        assets.transfer(assetId, { toOrganizationId: org.b, reason: 'واگذاری آزمون' }),
      );

    it.each(['premium_minor', 'insured_value_minor'] as const)(
      'a policy with a negative %s: a closed 422, and nothing moves',
      async (column) => {
        const assetId = await machine();
        const policyId = await policyOn(assetId);
        await storeNegative(column, policyId);

        const refused = await transfer(assetId).catch((error: unknown) => error);

        expect(refused).toMatchObject(CLOSED_422);
        expectClosed(refused);
        expect(await row('asset', assetId)).toMatchObject({ organization_id: org.a });
        expect(await row('insurance_policy', policyId)).toMatchObject({ organization_id: org.a });
        const transfers = await owner.client.$queryRawUnsafe<unknown[]>(
          `SELECT 1 FROM asset_transfer WHERE asset_id = $1`,
          assetId,
        );
        expect(transfers).toHaveLength(0);
      },
    );

    it.each(['claimed_amount_minor', 'approved_amount_minor'] as const)(
      'a decided claim with a negative %s: a closed 422, and nothing moves',
      async (column) => {
        const assetId = await machine();
        const policyId = await policyOn(assetId);
        const claimId = await claimOn(assetId, policyId);
        await asActor(manager(org.a), () => claims.startReview(assetId, claimId, {}));
        await asActor(admin(org.a), () =>
          claims.decide(assetId, claimId, {
            decision: 'APPROVED',
            approvedAmountMinor: '80',
            notes: 'مطابق ارزیابی کارشناس',
          }),
        );
        await asActor(admin(org.a), () =>
          claims.recordSettlement(assetId, claimId, { settlementReference: 'STL-1' }),
        );
        await storeNegative(column, claimId);

        const refused = await transfer(assetId).catch((error: unknown) => error);

        expect(refused).toMatchObject(CLOSED_422);
        expectClosed(refused);
        expect(await row('asset', assetId)).toMatchObject({ organization_id: org.a });
        expect(await row('insurance_claim', claimId)).toMatchObject({ organization_id: org.a });
      },
    );
  });

  describe('a claim transition on a row holding a negative amount', () => {
    it('start review over a negative claimed amount: a closed 422, the claim unchanged', async () => {
      const assetId = await machine();
      const claimId = await claimOn(assetId, await policyOn(assetId));
      await storeNegative('claimed_amount_minor', claimId);
      const events = (await outboxFor(claimId)).length;

      const refused = await asActor(manager(org.a), () =>
        claims.startReview(assetId, claimId, {}),
      ).catch((error: unknown) => error);

      expect(refused).toMatchObject(CLOSED_422);
      expectClosed(refused);
      expect(await row('insurance_claim', claimId)).toMatchObject({ status: 'SUBMITTED' });
      expect(await outboxFor(claimId)).toHaveLength(events);
    });

    it('a valid decision over a negative claimed amount: the 422, not a 400 naming approvedAmountMinor', async () => {
      const assetId = await machine();
      const claimId = await claimOn(assetId, await policyOn(assetId));
      await asActor(manager(org.a), () => claims.startReview(assetId, claimId, {}));
      await storeNegative('claimed_amount_minor', claimId);

      const refused = await asActor(admin(org.a), () =>
        claims.decide(assetId, claimId, {
          decision: 'APPROVED',
          approvedAmountMinor: '80',
          notes: 'مطابق ارزیابی کارشناس',
        }),
      ).catch((error: unknown) => error);

      expect(refused).toMatchObject(CLOSED_422);
      expectClosed(refused);
      expect(await row('insurance_claim', claimId)).toMatchObject({ status: 'UNDER_REVIEW' });
    });

    it('settlement over a negative approved amount the claim already held: the 422', async () => {
      const assetId = await machine();
      const claimId = await claimOn(assetId, await policyOn(assetId));
      await asActor(manager(org.a), () => claims.startReview(assetId, claimId, {}));
      await asActor(admin(org.a), () =>
        claims.decide(assetId, claimId, {
          decision: 'APPROVED',
          approvedAmountMinor: '80',
          notes: 'مطابق ارزیابی کارشناس',
        }),
      );
      await storeNegative('approved_amount_minor', claimId);

      // The same constraint a negative approved amount in a decision trips —
      // but this update writes none, so it is the stored row's, not the caller's.
      const refused = await asActor(admin(org.a), () =>
        claims.recordSettlement(assetId, claimId, { settlementReference: 'STL-2' }),
      ).catch((error: unknown) => error);

      expect(refused).toMatchObject(CLOSED_422);
      expectClosed(refused);
      expect(await row('insurance_claim', claimId)).toMatchObject({ status: 'APPROVED' });
    });
  });

  describe('the expiry sweep', () => {
    const lapse = (policyId: string) =>
      prisma.client.$executeRawUnsafe(
        `UPDATE insurance_policy SET valid_to = now() - interval '1 day' WHERE id = $1`,
        policyId,
      );

    const heldGauge = async () =>
      (await registry.getSingleMetric('rasta_asset_policies_expiry_held')!.get()).values[0]?.value;

    it('skips the policy it cannot update, reports it, and expires the rest of the batch', async () => {
      const held = await policyOn(await machine());
      const fine = await policyOn(await machine());
      await lapse(held);
      await lapse(fine);
      await storeNegative('premium_minor', held);

      const result = await insurance.runExpirySweep();

      expect(await row('insurance_policy', fine)).toMatchObject({ status: 'EXPIRED' });
      expect(
        (await outboxFor(fine)).filter((e) => e.eventName === INSURANCE_EVENTS.INSURANCE_EXPIRED),
      ).toHaveLength(1);
      expect(await row('insurance_policy', held)).toMatchObject({ status: 'ACTIVE' });
      expect(
        (await outboxFor(held)).filter((e) => e.eventName === INSURANCE_EVENTS.INSURANCE_EXPIRED),
      ).toHaveLength(0);
      expect(result.held).toBeGreaterThanOrEqual(1);
      expect(await heldGauge()).toBe(result.held);

      // Corrected, the next sweep expires it like any other.
      await restore();
      const after = await insurance.runExpirySweep();
      expect(await row('insurance_policy', held)).toMatchObject({ status: 'EXPIRED' });
      expect(after.held).toBe(result.held - 1);
    });
  });

  describe('the migration checks and adds under one lock', () => {
    const migrationFile = path.join(
      __dirname,
      '..',
      'prisma',
      'migrations',
      '20261005120000_insurance_money_non_negative',
      'migration.sql',
    );

    /** The shipped file through `prisma db execute`: one implicit transaction, as a deploy runs it. */
    function runSql(file: string): Promise<string> {
      return new Promise((resolve) => {
        execFile(
          process.execPath,
          [
            require.resolve('prisma/build/index.js'),
            'db',
            'execute',
            '--file',
            file,
            '--schema',
            path.join(__dirname, '..', 'prisma', 'schema.prisma'),
          ],
          { env: { ...process.env, DATABASE_URL: ownerDatabaseUrl() } },
          (error, _stdout, stderr) => resolve(error ? String(stderr || error) : ''),
        );
      });
    }

    async function waitingOnLock(): Promise<void> {
      for (let tries = 0; tries < 400; tries += 1) {
        const rows = await owner.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
              AND datname = current_database()`,
        );
        if (rows[0]!.n > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the migration never waited on a lock');
    }

    const constraintsPresent = async () =>
      (
        await owner.client.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = ANY($1::text[])`,
          Object.values(CONSTRAINTS).map(([, constraint]) => constraint),
        )
      )[0]!.n;

    /**
     * Before the migration: the four constraints gone. A writer then stores a
     * negative premium and holds its transaction open while the migration
     * starts; it commits only once the migration waits on a lock.
     */
    async function raceAgainst(file: string): Promise<{ output: string; premium: string }> {
      const policyId = await policyOn(await machine());
      await owner.client.$transaction(
        Object.values(CONSTRAINTS).map(([table, constraint]) =>
          owner.client.$executeRawUnsafe(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`),
        ),
      );

      let migration: Promise<string> | undefined;
      await prisma.client.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE insurance_policy SET premium_minor = -5 WHERE id = $1`,
            policyId,
          );
          migration = runSql(file);
          await waitingOnLock();
        },
        { timeout: 60_000 },
      );
      const output = await migration!;
      const premium = (
        await owner.client.$queryRawUnsafe<{ premium: string }[]>(
          `SELECT premium_minor::text AS premium FROM insurance_policy WHERE id = $1`,
          policyId,
        )
      )[0]!.premium;
      return { output, premium };
    }

    it('a negative row committed while the migration runs is seen by its check: refused, nothing added', async () => {
      const { output, premium } = await raceAgainst(migrationFile);

      expect(output).toMatch(/negative amounts stored \(premium_minor 1, .*refusing to add/);
      expect(await constraintsPresent()).toBe(0);
      expect(premium).toBe('-5');
    });

    it('without the lock, the same race leaves a NOT VALID constraint over the row (the gap, #222 r1)', async () => {
      // The shipped file with only its LOCK statement removed: the check runs
      // before the writer commits, and the ALTERs after.
      const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const unlocked = path.join(mkdtempSync(path.join(tmpdir(), 'money-')), 'unlocked.sql');
      const shipped = readFileSync(migrationFile, 'utf8');
      const withoutLock = shipped.replace(/^LOCK TABLE .*$/m, '');
      expect(withoutLock).not.toBe(shipped);
      writeFileSync(unlocked, withoutLock);

      const { output, premium } = await raceAgainst(unlocked);

      expect(output).toBe('');
      expect(await constraintsPresent()).toBe(4);
      expect(premium).toBe('-5');
    });
  });
});
