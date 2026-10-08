import { ulid } from 'ulid';
import { INSURANCE_TOPIC } from '../src/config/env';
import { AssetRepository } from '../src/asset/asset.repository';
import { AssetService } from '../src/asset/asset.service';
import { InsuranceService } from '../src/insurance/insurance.service';
import { INSURANCE_COVERAGES } from '../src/insurance/ownership';
import { reprojectEventId, reprojectInsurance } from '../src/insurance/reproject.command';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma, ownerDatabaseUrl, tenants } from './helpers';
import { clearingOwners } from './transfer-clearance.fake';

/**
 * `insurance:reproject` against a real PostgreSQL (docs/24 Q-101, runbook
 * insurance-reprojection.md): which policies it announces, to whom, how often,
 * and that it does so only through the outbox.
 *
 * Every run is limited to this suite's organizations — the database is shared
 * with other suites and with development data, and a test must not queue events
 * for rows it did not create.
 */
describe('insurance re-projection command (Q-101)', () => {
  const org = tenants();
  const day = 86_400_000;
  const rule = { coveragesFollowingVehicle: INSURANCE_COVERAGES };
  interface Envelope {
    eventName: string;
    producer: string;
    tenantId: string;
    payload: { policyId: string; assetId: string; organizationId: string };
  }

  let prisma: PrismaService;
  let owner: PrismaService;
  let repository: AssetRepository;
  let assets: AssetService;
  let insurance: InsuranceService;

  const manager = (organizationId: string) => ({ organizationId, roles: ['FLEET_MANAGER'] });

  async function machine(organizationId: string): Promise<string> {
    const created = await asActor(manager(organizationId), () =>
      assets.create({ name: 'گریدر بیمه', type: 'GRADER', specifications: {} } as never),
    );
    await prisma.client.$executeRawUnsafe(
      `UPDATE asset SET status = 'ACTIVE'::"OperationalStatus" WHERE id = $1`,
      created.id,
    );
    return created.id;
  }

  const record = async (
    organizationId: string,
    assetId: string,
    coverage: string,
    fromDays: number,
    toDays: number,
  ) =>
    (
      await asActor(manager(organizationId), () =>
        insurance.recordPolicy(assetId, {
          policyNumber: `POL-${ulid().slice(-8)}`,
          insurerName: 'بیمه نمونه',
          coverage: coverage as never,
          validFrom: new Date(Date.now() + fromDays * day).toISOString(),
          validTo: new Date(Date.now() + toDays * day).toISOString(),
        }),
      )
    ).id;

  const run = (options: { dryRun?: boolean; organizationId?: string; pageSize?: number } = {}) =>
    reprojectInsurance(repository, {
      dryRun: options.dryRun ?? false,
      organizationId: options.organizationId ?? org.a,
      pageSize: options.pageSize ?? 200,
      transferRule: rule,
    });

  /** The re-emitted events in the outbox, newest policy first not guaranteed. */
  const queued = (organizationId: string) =>
    owner.client.$queryRawUnsafe<
      {
        id: string;
        event_name: string;
        organization_id: string;
        stream_seq: string;
        payload: Envelope;
      }[]
    >(
      `SELECT id, event_name, organization_id, stream_seq::text AS stream_seq, payload
         FROM outbox_message
        WHERE organization_id = $1 AND event_name = 'INSURANCE_RECORDED' AND topic = $2
          AND id = ANY($3::text[])
        ORDER BY id`,
      organizationId,
      INSURANCE_TOPIC,
      known,
    );

  /** Ids this suite expects the command to have produced, filled in as policies are made. */
  const known: string[] = [];
  const expectId = async (policyId: string) => {
    const [row] = await owner.client.$queryRawUnsafe<{ updated_at: Date }[]>(
      `SELECT updated_at FROM insurance_policy WHERE id = $1`,
      policyId,
    );
    const eventId = reprojectEventId(policyId, row!.updated_at);
    known.push(eventId);
    return eventId;
  };

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    owner = new PrismaService(ownerDatabaseUrl());
    repository = new AssetRepository(prisma);
    assets = new AssetService(repository, undefined, clearingOwners());
    insurance = new InsuranceService(repository, assets, 30);
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

  it('announces every policy in force or not yet started, once, and nothing else', async () => {
    const assetId = await machine(org.a);
    const inForce = await record(org.a, assetId, 'THIRD_PARTY', -10, 200);
    const upcoming = await record(org.a, assetId, 'LIABILITY', 30, 400);
    const cancelled = await record(org.a, assetId, 'COMPREHENSIVE', -10, 200);
    await owner.client.$executeRawUnsafe(
      `UPDATE insurance_policy SET status = 'CANCELLED' WHERE id = $1`,
      cancelled,
    );
    // Another organization's machine, outside the run's scope.
    const foreign = await machine(org.b);
    await record(org.b, foreign, 'THIRD_PARTY', -10, 200);

    // Policies made by the service queued their own INSURANCE_RECORDED; the
    // command's events are told apart by their deterministic ids.
    const idInForce = await expectId(inForce);
    const idUpcoming = await expectId(upcoming);
    await owner.client.$executeRawUnsafe(
      `DELETE FROM outbox_message WHERE id <> ALL($1::text[]) AND organization_id = ANY($2::text[])`,
      known,
      [org.a, org.b],
    );

    const dry = await run({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, scanned: 2, emitted: 2, alreadyEmitted: 0 });
    expect(await queued(org.a)).toEqual([]);

    const report = await run({ pageSize: 1 });
    expect(report).toMatchObject({ scanned: 2, emitted: 2, alreadyEmitted: 0, notCounting: 0 });
    expect(report.byOrganization).toEqual({ [org.a]: { emitted: 2, alreadyEmitted: 0 } });

    const rows = await queued(org.a);
    expect(rows.map((r) => r.id).sort()).toEqual([idInForce, idUpcoming].sort());
    for (const row of rows) {
      expect(row.organization_id).toBe(org.a);
      expect(row.payload.eventName).toBe('INSURANCE_RECORDED');
      expect(row.payload.producer).toBe('asset-service');
      expect(row.payload.tenantId).toBe(org.a);
      expect(row.payload.payload).toMatchObject({ assetId, organizationId: org.a });
    }
    expect(rows.map((r) => r.payload.payload.policyId).sort()).toEqual([inForce, upcoming].sort());
    // Nothing for the other organization, the cancelled policy, or anyone else.
    expect(await queued(org.b)).toEqual([]);
    expect(rows.every((r) => r.id.match(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/))).toBe(true);
  });

  it('is a no-op the second time: same ids found, nothing written, no sequence gap', async () => {
    const before = await queued(org.a);
    const sequence = () =>
      owner.client.$queryRawUnsafe<{ next: string }[]>(
        `SELECT coalesce(max(stream_seq), 0)::text AS next FROM outbox_message WHERE organization_id = $1`,
        org.a,
      );
    const seqBefore = await sequence();

    const again = await run();
    expect(again).toMatchObject({ emitted: 0, alreadyEmitted: 2, scanned: 2 });
    expect(await queued(org.a)).toEqual(before);
    expect(await sequence()).toEqual(seqBefore);
  });

  it('announces an edited policy again under a new id: the version is part of the id', async () => {
    const rows = await owner.client.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM insurance_policy WHERE organization_id = $1 AND coverage = 'THIRD_PARTY' AND status = 'ACTIVE'`,
      org.a,
    );
    const policyId = rows[0]!.id;
    await owner.client.$executeRawUnsafe(
      `UPDATE insurance_policy SET updated_at = updated_at + interval '1 second' WHERE id = $1`,
      policyId,
    );
    await expectId(policyId);

    expect(await run()).toMatchObject({ emitted: 1, alreadyEmitted: 1 });
  });

  it('derives the same ULID-shaped id from the same policy version, and a different one otherwise', () => {
    const at = new Date('2026-10-08T12:00:00.000Z');
    expect(reprojectEventId('INS_1', at)).toBe(reprojectEventId('INS_1', new Date(at)));
    expect(reprojectEventId('INS_1', at)).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(reprojectEventId('INS_2', at)).not.toBe(reprojectEventId('INS_1', at));
    expect(reprojectEventId('INS_1', new Date(at.getTime() + 1))).not.toBe(
      reprojectEventId('INS_1', at),
    );
  });

  it('refuses a page size outside its bounds', async () => {
    await expect(run({ pageSize: 0 })).rejects.toThrow('pageSize');
    await expect(run({ pageSize: 1001 })).rejects.toThrow('pageSize');
  });
});
