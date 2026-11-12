import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { MeterReconcile, type MeterUsageSource } from '../src/maintenance/meter-reconcile';
import { maintenanceMeterLegacyAssets } from '../src/observability/metrics';
import { insertUsageEntry } from '../src/maintenance/usage-meter';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, seedAsset, seedMeter, tenants, waitFor } from './helpers';

describe('maintenance-meter-reconcile dry run', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  beforeAll(() => {
    prisma = newPrisma();
    repository = new MaintenanceRepository(prisma);
  });
  afterAll(async () => {
    await prisma.client
      .$executeRaw`DELETE FROM asset_usage_entry WHERE organization_id IN (${org.a}, ${org.b})`;
    await cleanup(prisma, [org.a, org.b]);
    await prisma.stop();
  });
  const anchor = () => ({
    id: id('USG'),
    organizationId: org.a,
    periodStart: '2026-11-01T10:00:00Z',
    periodEnd: '2026-11-01T11:00:00Z',
    hours: '0',
    kilometres: '0',
    hourMeter: '100',
    odometer: null,
  });
  async function machine(organizationId = org.a) {
    const assetId = id('AST');
    await seedAsset(prisma, assetId, organizationId);
    await seedMeter(prisma, assetId, organizationId, '100');
    return assetId;
  }
  function command(source: MeterUsageSource) {
    return new MeterReconcile(prisma, source);
  }
  it('existing 100 plus covered 2 reports L=100, leaves every table unchanged, and repeats identically', async () => {
    const assetId = await machine();
    const records = [
      anchor(),
      {
        ...anchor(),
        id: id('USG'),
        hours: '2',
        hourMeter: null,
        periodStart: '2026-11-01T09:00:00Z',
        periodEnd: '2026-11-01T10:00:00Z',
      },
    ];
    const source: MeterUsageSource = {
      page: async () => ({ items: records, hasMore: false, nextCursor: null }),
    };
    const scheduleId = id('MSC');
    await asActor({ organizationId: org.a }, () =>
      prisma.client.maintenanceSchedule.create({
        data: {
          id: scheduleId,
          organizationId: org.a,
          assetId,
          title: 'preview',
          createdBy: 'USR_ITEST',
          updatedBy: 'USR_ITEST',
          intervalHours: '50',
          lastServicedHourMeter: '0',
          leadHours: '0',
        },
      }),
    );
    const run = () => command(source).reportAsset(org.a, assetId, new Date('2026-11-02T00:00:00Z'));
    const first = await run();
    expect(first).toMatchObject({
      organizationId: org.a,
      assetId,
      M: { hours: '100.00', kilometres: '0.00' },
      L: { hours: '100.00', kilometres: '0.00' },
      diff: { hours: '0.00', kilometres: '0.00' },
      pagesExhausted: true,
      sourceComplete: false,
      refusal: 'CUTOVER_PROOF_REQUIRED',
      schedulesWouldAnnounce: [scheduleId],
    });
    expect(await run()).toEqual(first);
    expect(
      (await asActor({ organizationId: org.a }, () =>
        prisma.client.maintenanceSchedule.findUnique({ where: { id: scheduleId } }),
      ))!.dueAnnouncedAt,
    ).toBeNull();
    expect(
      await prisma.client.outboxMessage.count({
        where: { organizationId: org.a, aggregateId: scheduleId },
      }),
    ).toBe(0);
    expect((await repository.findMeter(assetId))!.meterSource).toBe('LEGACY');
    expect(
      await asActor({ organizationId: org.a }, () =>
        prisma.client.assetUsageEntry.count({ where: { assetId } }),
      ),
    ).toBe(0);
  });
  it('follows a filtered-empty page and refuses a missing continuation without a partial L', async () => {
    const assetId = await machine();
    const page = jest
      .fn()
      .mockResolvedValueOnce({ items: [], hasMore: true, nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [anchor()], hasMore: false, nextCursor: null });
    expect(await command({ page }).reportAsset(org.a, assetId)).toMatchObject({
      pagesExhausted: true,
      recordsRead: 1,
    });
    expect(page.mock.calls[1][2]).toBe('next');
    expect(
      await command({
        page: async () => ({ items: [anchor()], hasMore: true, nextCursor: null }),
      }).reportAsset(org.a, assetId),
    ).toMatchObject({ L: null, refusal: 'SOURCE_READ_FAILED', sourceComplete: false });
    expect((await repository.findMeter(assetId))!.meterSource).toBe('LEGACY');
  });
  it('tail or backdated rows committed after their page never turn terminal pagination into completeness', async () => {
    const assetId = await machine();
    // Source first page was read, then a record commits behind its cursor. Neither
    // the second page nor even a second matching scan proves this record absent.
    const page = jest
      .fn()
      .mockResolvedValueOnce({ items: [anchor()], hasMore: true, nextCursor: 'tail' })
      .mockResolvedValueOnce({ items: [], hasMore: false, nextCursor: null });
    expect(await command({ page }).reportAsset(org.a, assetId)).toMatchObject({
      pagesExhausted: true,
      sourceComplete: false,
      refusal: 'CUTOVER_PROOF_REQUIRED',
    });
    expect((await repository.findMeter(assetId))!.meterSource).toBe('LEGACY');
  });
  it('refuses unresolved historical intervals instead of guessing and keeps the mode', async () => {
    const assetId = await machine();
    await asActor({ organizationId: org.a }, () =>
      prisma.client.assetUsageEntry.create({
        data: {
          usageRecordId: id('USG'),
          assetId,
          organizationId: org.a,
          hours: '2',
          kilometres: '0',
        },
      }),
    );
    expect(
      await command({
        page: async () => ({ items: [], hasMore: false, nextCursor: null }),
      }).reportAsset(org.a, assetId),
    ).toMatchObject({ L: null, refusal: 'INCOMPLETE_INTERVAL' });
    expect((await repository.findMeter(assetId))!.meterSource).toBe('LEGACY');
  });
  it('tenant enumeration and report do not return another tenant asset; direct guessed asset is refused before fleet', async () => {
    const a = await machine();
    const b = await machine(org.b);
    const source = {
      page: jest.fn().mockResolvedValue({ items: [], hasMore: false, nextCursor: null }),
    };
    const report = await command(source).report(org.a);
    expect(report.assets.some((r) => r.assetId === a)).toBe(true);
    expect(report.assets.some((r) => r.assetId === b)).toBe(false);
    const calls = source.page.mock.calls.length;
    expect(await command(source).reportAsset(org.a, b)).toMatchObject({
      M: null,
      L: null,
      refusal: 'ASSET_NOT_IN_TENANT',
    });
    expect(source.page).toHaveBeenCalledTimes(calls);
  });
  it('a live fact inserted before its meter lock cannot deadlock the preview', async () => {
    const assetId = await machine();
    const reading = anchor();
    const late = {
      ...anchor(),
      id: id('USG'),
      hours: '2',
      hourMeter: null,
      periodStart: '2026-11-01T11:00:00Z',
      periodEnd: '2026-11-01T12:00:00Z',
    };
    const input = {
      assetId,
      organizationId: org.a,
      usageRecordId: late.id,
      hoursDelta: '2',
      kilometresDelta: '0',
      reportedHourMeter: null,
      reportedOdometer: null,
      periodStart: new Date(late.periodStart),
      periodEnd: new Date(late.periodEnd),
      now: new Date(),
    };
    let inserted!: () => void;
    let release!: () => void;
    const atBarrier = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const live = asActor({ organizationId: org.a }, () =>
      prisma.transaction(
        async (tx) => {
          await insertUsageEntry(tx, input);
          inserted();
          await barrier;
          return repository.foldUsageIntoMeter(tx, input, id('EVT'), 'reconcile-live-test');
        },
        { timeoutMs: 10_000 },
      ),
    );
    // Attach rejection handling before allowing PostgreSQL to adjudicate a mutant's deadlock.
    const liveResult = live.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await atBarrier;
    const preview = command({
      page: async () => ({ items: [reading, late], hasMore: false, nextCursor: null }),
    }).reportAsset(org.a, assetId);
    try {
      await waitFor(
        'preview waiting on the live fact insert',
        async () => {
          const [row] = await prisma.client.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO asset_usage_entry%') AS waiting`;
          return row.waiting;
        },
        5000,
        10,
      );
    } finally {
      release();
    }
    expect(await liveResult).toEqual({ value: true });
    expect(await preview).toMatchObject({
      M: { hours: '102.00' },
      L: { hours: '102.00' },
      sourceComplete: false,
      refusal: 'CUTOVER_PROOF_REQUIRED',
    });
    expect((await repository.findMeter(assetId))!.hourMeter.toString()).toBe('102');
  });
  it('legacy gauge count includes known assets without a meter, excludes LEDGER, and uses the shared registry gauge', async () => {
    const before = await repository.countLegacyMeterAssetsAcrossTenants();
    const missing = id('AST');
    await seedAsset(prisma, missing, org.a);
    const legacy = await machine();
    const ledger = await machine();
    await prisma.client.assetUsageMeter.update({
      where: { assetId: ledger },
      data: { meterSource: 'LEDGER' },
    });
    const count = await repository.countLegacyMeterAssetsAcrossTenants();
    expect(count).toBe(before + 2);
    maintenanceMeterLegacyAssets.set(count);
    expect((await maintenanceMeterLegacyAssets.get()).values[0].value).toBe(count);
    expect((await repository.findMeter(legacy))!.meterSource).toBe('LEGACY');
  });
});
