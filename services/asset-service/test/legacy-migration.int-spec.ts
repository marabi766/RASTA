import { execFile, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { ulid } from 'ulid';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { canonicalIdentifier } from '../src/asset/identifier';
import { InsuranceService } from '../src/insurance/insurance.service';
import { ClaimService } from '../src/insurance/claim.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, databaseUrl, newPrisma, tenants } from './helpers';

/**
 * Migration 20260925110000_asset_legacy_dossier_and_identifiers, against the
 * state a pre-release database is really in (PR #108 review round 1, items #2
 * and #5).
 *
 * The test database is already migrated, so the legacy state is built on top
 * of it by hand: a transfer made the way the old code made it, which moved the
 * asset row and nothing else, and identifiers stored before they were
 * canonicalised. Then the migration file itself is run, exactly as it ships,
 * through `prisma db execute`. It is written to be re-runnable for this.
 */
describe('legacy data migration (20260925110000)', () => {
  const org = tenants();
  const orgC = `ORG-ITEST-C-${ulid().slice(-10)}`;
  const day = 86_400_000;
  const migrationDir = path.resolve(
    __dirname,
    '../prisma/migrations/20260925110000_asset_legacy_dossier_and_identifiers',
  );
  const migrationFile = path.join(migrationDir, 'migration.sql');
  const downFile = path.join(migrationDir, 'down.sql');

  let prisma: PrismaService;
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

  /** Runs a shipped SQL file through `prisma db execute`. */
  function runFile(file: string): void {
    execFileSync(
      process.execPath,
      [
        require.resolve('prisma/build/index.js'),
        'db',
        'execute',
        '--file',
        file,
        '--url',
        databaseUrl(),
      ],
      { stdio: 'pipe' },
    );
  }

  /** Runs the shipped migration file, as a deploy would. */
  const runMigration = (): void => runFile(migrationFile);

  /**
   * `runFile` without blocking the event loop, so a writer on another
   * connection can act while the file runs. Resolves to the error output, or
   * to '' when the file succeeded.
   */
  function runFileConcurrently(file: string): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [
          require.resolve('prisma/build/index.js'),
          'db',
          'execute',
          '--file',
          file,
          '--url',
          databaseUrl(),
        ],
        (error, _stdout, stderr) => resolve(error ? String(stderr || error) : ''),
      );
    });
  }

  /**
   * Until another session is waiting on a lock: the file just started, which
   * is the only other client while this suite runs in band. `prisma db
   * execute` sends the file statement by statement, so the waiting query's
   * text is one statement, not the file.
   */
  async function fileWaitingOnLock(): Promise<void> {
    for (let tries = 0; tries < 400; tries += 1) {
      const rows = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
            AND datname = current_database()`,
      );
      if (rows[0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the file never waited on a lock');
  }

  /**
   * recordPolicy's lock order, split where it matters (PR #108 round 3 #1):
   * `FOR SHARE` on the asset row (InsuranceService.lockOwned), then a write
   * on insurance_policy. `between` runs after the first step; the second
   * starts only when it resolves.
   */
  function recordPolicyShaped(assetId: string, between: () => Promise<void>): Promise<void> {
    return prisma.client.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT id FROM asset WHERE id = $1 FOR SHARE`, assetId);
        await between();
        await tx.$executeRawUnsafe(
          `UPDATE insurance_policy SET updated_at = updated_at WHERE asset_id = $1`,
          assetId,
        );
      },
      { timeout: 120_000 },
    );
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
    for (const organizationId of [org.a, org.b, orgC]) {
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
    const orgs = [org.a, org.b, orgC];
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE organization_id = ANY($1::text[])`,
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

  it('computes the canonical form exactly as the application does', async () => {
    const samples = [
      'ماشين-۱۲', // Arabic yeh, Persian digits
      'ك-٣٤', // Arabic kaf, Arabic-Indic digits
      'تـــست', // tatweel
      'ﻙﻴﺎ ۵', // presentation forms
      '  AB   12\t\n', // assorted JavaScript whitespace
      'x﻿y z',
      'ABC-12',
      '　lead and trail ',
    ];
    for (const sample of samples) {
      const rows = await prisma.client.$queryRawUnsafe<{ value: string }[]>(
        `SELECT canonical_identifier($1) AS value`,
        sample,
      );
      expect({ sample, value: rows[0]!.value }).toEqual({
        sample,
        value: canonicalIdentifier(sample),
      });
    }
  });

  it('reunites a dossier an old transfer split, so its open claim can be decided and the asset moved on', async () => {
    // Registered and insured by A, with a claim still being processed.
    const created = await asActor(manager(org.a), () =>
      assets.create({ name: 'لودر قدیمی', type: 'LOADER', specifications: {} } as never),
    );
    const assetId = created.id;
    const policy = await asActor(manager(org.a), () =>
      insurance.recordPolicy(assetId, {
        policyNumber: `POL-${ulid().slice(-8)}`,
        insurerName: 'بیمه نمونه',
        coverage: 'THIRD_PARTY',
        validFrom: new Date(Date.now() - 100 * day).toISOString(),
        validTo: new Date(Date.now() + 200 * day).toISOString(),
      }),
    );
    const claim = await asActor(manager(org.a), () =>
      claims.submitClaim(assetId, {
        policyId: policy.id,
        description: 'برخورد در جاده روستایی',
        incidentAt: new Date(Date.now() - 5 * day).toISOString(),
      }),
    );

    // The old transfer: the asset row moved to B, nothing else did. And an
    // identifier stored before input was canonicalised.
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET organization_id = $2, status = 'REGISTERED', asset_tag = $3 WHERE id = $1`,
      assetId,
      org.b,
      'ماشين-۱۲',
    );

    // Stuck: B cannot see the claim, and nobody can move the asset on.
    expect(await asActor(manager(org.b), () => claims.listClaims(assetId))).toHaveLength(0);
    await expect(
      asActor(admin(org.b), () =>
        assets.transfer(assetId, { toOrganizationId: orgC, reason: 'واگذاری بعدی' }),
      ),
    ).rejects.toThrow(/claim that is still open/);

    runMigration();

    // The dossier is B's, whole: the claim is visible to its owner, and A
    // keeps no tenant-scoped row of it.
    expect(await asActor(manager(org.b), () => claims.listClaims(assetId))).toHaveLength(1);
    expect(await asActor(manager(org.b), () => insurance.listPolicies(assetId))).toHaveLength(1);
    for (const table of ['insurance_policy', 'insurance_claim', 'asset_timeline_entry']) {
      const left = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${table} WHERE asset_id = $1 AND organization_id = $2`,
        assetId,
        org.a,
      );
      expect({ table, n: left[0]!.n }).toEqual({ table, n: 0 });
    }

    // The identifier is canonical, and found by the spelling it was typed in.
    const tag = await prisma.client.$queryRawUnsafe<{ asset_tag: string }[]>(
      `SELECT asset_tag FROM asset WHERE id = $1`,
      assetId,
    );
    expect(tag[0]!.asset_tag).toBe('ماشین-12');
    const found = await asActor(manager(org.b), () =>
      assets.list({ q: 'ماشين-۱۲', limit: 20 } as never),
    );
    expect(found.items.map((item) => item.id)).toContain(assetId);

    // Every change is recorded for the rollback.
    const logged = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM asset_legacy_migration_log WHERE row_id = ANY($1::text[])`,
      [assetId, policy.id, claim.id],
    );
    expect(logged[0]!.n).toBeGreaterThanOrEqual(3);

    // The owner decides the claim, and the asset can move on.
    await asActor(admin(org.b), () => claims.startReview(assetId, claim.id, {}));
    await asActor(admin(org.b), () =>
      claims.decide(assetId, claim.id, { decision: 'REJECTED', notes: 'خارج از پوشش' }),
    );
    await asActor(admin(org.b), () =>
      assets.transfer(assetId, { toOrganizationId: orgC, reason: 'واگذاری بعدی' }),
    );
    const owner = await prisma.client.$queryRawUnsafe<{ organization_id: string }[]>(
      `SELECT organization_id FROM asset WHERE id = $1`,
      assetId,
    );
    expect(owner[0]!.organization_id).toBe(orgC);

    // Re-running changes nothing and keeps the first original value.
    runMigration();
    const original = await prisma.client.$queryRawUnsafe<{ old_value: string }[]>(
      `SELECT old_value FROM asset_legacy_migration_log
        WHERE table_name = 'asset' AND row_id = $1 AND column_name = 'asset_tag'`,
      assetId,
    );
    expect(original[0]!.old_value).toBe('ماشين-۱۲');

    // PR #108 round 2 #3: the asset changed hands after the migration, so its
    // dossier rows no longer hold what the migration wrote. Rolling back would
    // put them under A while the asset is C's. The rollback refuses, names
    // them, and changes nothing.
    let refusal = '';
    try {
      runFile(downFile);
    } catch (error) {
      refusal = String((error as { stderr?: Buffer }).stderr ?? error);
    }
    expect(refusal).toMatch(/changed after the migration; nothing was rolled back/);

    const after = await prisma.client.$queryRawUnsafe<{ organization_id: string }[]>(
      `SELECT organization_id FROM insurance_claim WHERE id = $1`,
      claim.id,
    );
    expect(after[0]!.organization_id).toBe(orgC);
    const kept = await prisma.client.$queryRawUnsafe<{ asset_tag: string }[]>(
      `SELECT asset_tag FROM asset WHERE id = $1`,
      assetId,
    );
    expect(kept[0]!.asset_tag).toBe('ماشین-12');
    const log = await prisma.client.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM asset_legacy_migration_log WHERE asset_id = $1`,
      assetId,
    );
    expect(log[0]!.n).toBeGreaterThan(0);
  });

  it('runs around no writer: a write in flight fails it on the lock, changing nothing (round 2 #2)', async () => {
    const created = await asActor(manager(org.a), () =>
      assets.create({ name: 'قفل', type: 'LOADER', specifications: {} } as never),
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET asset_tag = $2 WHERE id = $1`,
      created.id,
      'قفل-۳',
    );

    // A transfer in flight on another connection: its row write holds the
    // table in ROW EXCLUSIVE mode until it commits.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const writer = prisma.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE asset_timeline_entry SET organization_id = organization_id WHERE asset_id = $1`,
          created.id,
        );
        holding();
        await released;
      },
      { timeout: 120_000 },
    );
    await held;

    let failure = '';
    try {
      runMigration();
    } catch (error) {
      failure = String((error as { stderr?: Buffer }).stderr ?? error);
    }
    release();
    await writer;
    expect(failure).toMatch(/lock timeout/);

    // Nothing was canonicalised or moved while the writer held the table.
    const before = await prisma.client.$queryRawUnsafe<{ asset_tag: string }[]>(
      `SELECT asset_tag FROM asset WHERE id = $1`,
      created.id,
    );
    expect(before[0]!.asset_tag).toBe('قفل-۳');

    // Once it has committed, the migration goes through.
    runMigration();
    const after = await prisma.client.$queryRawUnsafe<{ asset_tag: string }[]>(
      `SELECT asset_tag FROM asset WHERE id = $1`,
      created.id,
    );
    expect(after[0]!.asset_tag).toBe('قفل-3');
  });

  it('refuses, changing nothing, when canonical spellings would collide', async () => {
    // Two live tags in one organization that only differ by keyboard.
    const first = await asActor(manager(org.a), () =>
      assets.create({ name: 'الف', type: 'LOADER', specifications: {} } as never),
    );
    const second = await asActor(manager(org.a), () =>
      assets.create({ name: 'ب', type: 'LOADER', specifications: {} } as never),
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET asset_tag = $2 WHERE id = $1`,
      first.id,
      'کد-۷',
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET asset_tag = $2 WHERE id = $1`,
      second.id,
      'كد-7',
    );

    expect(runMigration).toThrow(/asset tag\(s\) become duplicates/);

    const tags = await prisma.client.$queryRawUnsafe<{ asset_tag: string }[]>(
      `SELECT asset_tag FROM asset WHERE id = ANY($1::text[]) ORDER BY name`,
      [first.id, second.id],
    );
    expect(tags.map((row) => row.asset_tag).sort()).toEqual(['کد-۷', 'كد-7'].sort());

    // Resolved by a person; then the migration goes through.
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET asset_tag = NULL WHERE id = $1`,
      second.id,
    );
    runMigration();
  });

  // -------------------------------------------------------------------------
  // PR #108 round 3
  // -------------------------------------------------------------------------

  it('waits for a writer holding its asset FOR SHARE, and neither deadlocks (round 3 #1)', async () => {
    const created = await asActor(manager(org.a), () =>
      assets.create({ name: 'هم‌زمان', type: 'LOADER', specifications: {} } as never),
    );
    // A tag the migration rewrites, so it must write the row the writer holds.
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET asset_tag = $2 WHERE id = $1`,
      created.id,
      'هم‌زمان-۴',
    );

    // The writer holds the asset row; the migration starts and must wait for
    // it before locking anything else; the writer then writes
    // insurance_policy and commits. Under SHARE ROW EXCLUSIVE the migration
    // held insurance_policy by then, and this was a deadlock.
    let migration!: Promise<string>;
    const writer = recordPolicyShaped(created.id, async () => {
      migration = runFileConcurrently(migrationFile);
      await fileWaitingOnLock();
    });

    await expect(writer).resolves.toBeUndefined();
    expect(await migration).toBe('');
    const after = await prisma.client.$queryRawUnsafe<{ asset_tag: string }[]>(
      `SELECT asset_tag FROM asset WHERE id = $1`,
      created.id,
    );
    expect(after[0]!.asset_tag).toBe('هم‌زمان-4');
  });

  it('will not roll back a generation it cannot re-derive, and takes the asset first (round 3 #1, #2)', async () => {
    const ownershipDown = path.resolve(
      __dirname,
      '../prisma/migrations/20260926000000_asset_ownership_generation/down.sql',
    );
    const created = await asActor(manager(org.a), () =>
      assets.create({ name: 'هم‌لحظه', type: 'LOADER', specifications: {} } as never),
    );
    const policy = await asActor(manager(org.a), () =>
      insurance.recordPolicy(created.id, {
        policyNumber: `SAME-MS-${ulid().slice(-8)}`,
        insurerName: 'بیمه آزمون',
        coverage: 'THIRD_PARTY',
        validFrom: new Date(Date.now() - day).toISOString(),
        validTo: new Date(Date.now() + 300 * day).toISOString(),
      }),
    );
    await asActor(admin(org.a), () =>
      assets.transfer(created.id, { toOrganizationId: org.b, reason: 'هم‌لحظه' }),
    );
    // Recorded by A just before the transfer, in the same millisecond: stored
    // as generation 0, which timestamps alone would read as generation 1.
    await prisma.client.$executeRawUnsafe(
      `UPDATE insurance_policy p SET created_at = t.transferred_at
         FROM asset_transfer t WHERE t.asset_id = p.asset_id AND p.id = $1`,
      policy.id,
    );

    // The rollback is started while a recordPolicy-shaped writer holds the
    // asset row, and the writer then writes insurance_policy. Taking
    // insurance_policy first (the round 2 order) deadlocked here.
    let rollback!: Promise<string>;
    const writer = recordPolicyShaped(created.id, async () => {
      rollback = runFileConcurrently(ownershipDown);
      await fileWaitingOnLock();
    });
    await expect(writer).resolves.toBeUndefined();

    const refusal = await rollback;
    expect(refusal).toMatch(/cannot be re-derived from timestamps/);
    expect(refusal).toContain(`insurance_policy ${policy.id}: stored 0, derived 1`);
    expect(refusal).not.toMatch(/deadlock/);

    // Nothing was dropped: the stored generation is still there, and still 0.
    const kept = await prisma.client.$queryRawUnsafe<{ ownership_generation: number }[]>(
      `SELECT ownership_generation FROM insurance_policy WHERE id = $1`,
      policy.id,
    );
    expect(kept[0]!.ownership_generation).toBe(0);
  });
});
