import type { EventEnvelope } from '@rasta/contracts';
import { UsageConsumer, CONSUMER_NAME } from '../src/consumers/usage.consumer';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { DueAnnouncerService } from '../src/maintenance/due-announcer.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, cleanup, id, newPrisma, tenants } from './helpers';

// Real consumer -> transaction -> PostgreSQL. Errors here are the broker's DLQ signal.
describe('ADR-073 usage ledger', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: MaintenanceRepository;
  let consumer: UsageConsumer;
  const announced: string[] = [];
  beforeAll(() => {
    prisma = newPrisma();
    repository = new MaintenanceRepository(prisma);
    consumer = new UsageConsumer(null, repository, {
      async announceForAsset(assetId: string): Promise<number> {
        announced.push(assetId);
        return 0;
      },
    } as DueAnnouncerService);
  });
  afterAll(async () => {
    // Explicit tenant predicate also works before the ledger migration exists (red run).
    const [{ exists }] = await prisma.client.$queryRaw<{ exists: boolean }[]>`
      SELECT to_regclass('asset_usage_entry') IS NOT NULL AS exists`;
    if (exists)
      await prisma.client.$executeRaw`
      DELETE FROM asset_usage_entry WHERE organization_id IN (${org.a}, ${org.b})`;
    await cleanup(prisma, [org.a, org.b]);
    await prisma.stop();
  });
  function event(assetId: string, patch: Record<string, unknown> = {}): EventEnvelope {
    const usageRecordId = id('USG');
    return {
      eventId: id('EVT'),
      eventName: 'USAGE_RECORDED',
      eventVersion: 1,
      occurredAt: '2026-11-01T12:00:00.000Z',
      producer: 'fleet-service',
      aggregateType: 'UsageRecord',
      aggregateId: usageRecordId,
      tenantId: org.a,
      correlationId: id('COR'),
      payload: {
        usageRecordId,
        assetId,
        organizationId: org.a,
        periodStart: '2026-11-01T10:00:00.000Z',
        periodEnd: '2026-11-01T11:00:00.000Z',
        hours: '0',
        kilometres: '0',
        ...patch,
      },
    } as EventEnvelope;
  }
  async function machine(source: 'LEGACY' | 'LEDGER' = 'LEDGER', value = '0'): Promise<string> {
    const assetId = id('AST');
    // SQL intentionally makes the baseline fail on the absent column, not a generated TS type.
    await prisma.client.$executeRaw`
      INSERT INTO asset_usage_meter(asset_id, organization_id, meter_source, hour_meter, odometer, updated_at)
      VALUES (${assetId}, ${org.a}, ${source}, ${value}::numeric, ${value}::numeric, NOW())`;
    return assetId;
  }
  const apply = (e: EventEnvelope) =>
    asActor({ organizationId: e.tenantId! }, () => consumer.handle(e));
  const meter = (assetId: string) => repository.findMeter(assetId);

  it.each(['hours', 'kilometres'] as const)(
    '%s: both orders give 102 for later delta and 100 for covered delta',
    async (dimension) => {
      const reading = dimension === 'hours' ? 'hourMeter' : 'odometer';
      for (const covered of [false, true])
        for (const reverse of [false, true]) {
          const assetId = await machine();
          const r = event(assetId, { [reading]: '100' });
          const d = event(assetId, {
            [dimension]: '2',
            periodStart: covered ? '2026-11-01T09:00:00Z' : '2026-11-01T11:00:00Z',
            periodEnd: covered ? '2026-11-01T10:00:00Z' : '2026-11-01T12:00:00Z',
          });
          for (const e of reverse ? [d, r] : [r, d]) await apply(e);
          const m = await meter(assetId);
          expect(m![reading].toString()).toBe(covered ? '100' : '102');
          expect(m!.lastPeriodEnd!.toISOString()).toBe(
            covered ? '2026-11-01T11:00:00.000Z' : '2026-11-01T12:00:00.000Z',
          );
        }
    },
  );

  function permutations<T>(xs: T[]): T[][] {
    return xs.length
      ? xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((p) => [x, ...p]))
      : [[]];
  }
  it('all 24 permutations of two readings and two deltas match chronological folding in both dimensions', async () => {
    for (const order of permutations([0, 1, 2, 3])) {
      const assetId = await machine();
      const entries = [
        { hours: '2', kilometres: '3' },
        { hours: '1', kilometres: '1', hourMeter: '100', odometer: '200' },
        { hours: '5', kilometres: '7', hourMeter: '102', odometer: '203' },
        { hours: '0.01', kilometres: '0.02' },
      ].map((quantities, i) =>
        event(assetId, {
          ...quantities,
          periodStart: `2026-11-01T0${i + 1}:00:00Z`,
          periodEnd: `2026-11-01T0${i + 2}:00:00Z`,
        }),
      );
      for (const i of order) await apply(entries[i]);
      const m = await meter(assetId);
      expect(m!.hourMeter.toString()).toBe('105.01');
      expect(m!.odometer.toString()).toBe('207.02');
      expect(m!.recordCount).toBe(4);
    }
  });

  it.each(['LEGACY', 'LEDGER'] as const)(
    '%s: concurrent replay applies once, including marker and entry',
    async (source) => {
      const assetId = await machine(source);
      const e = event(assetId, { hours: '2', kilometres: '3' });
      const outcomes = await Promise.all([apply(e), apply(e)]);
      expect(outcomes.filter((x) => x === 'SKIPPED')).toHaveLength(1);
      expect((await meter(assetId))!.hourMeter.toString()).toBe('2');
      const rows = await prisma.client.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM asset_usage_entry WHERE asset_id = ${assetId} AND organization_id = ${org.a}`;
      expect(rows[0].n).toBe(1);
    },
  );

  it('keeps entries tenant scoped while the physical meter spans ownership transfers', async () => {
    const assetId = await machine();
    await apply(event(assetId, { hours: '2' }));
    const second = event(assetId, {
      organizationId: org.b,
      hours: '3',
      periodStart: '2026-11-01T11:00:00Z',
      periodEnd: '2026-11-01T12:00:00Z',
    });
    await apply({ ...second, tenantId: org.b });
    expect((await meter(assetId))!.hourMeter.toString()).toBe('5');
    // Generated model deliberately accessed through raw SQL here until schema generation.
    const rows = await prisma.client.$queryRaw<{ organization_id: string }[]>`
      SELECT organization_id FROM asset_usage_entry WHERE asset_id = ${assetId} AND organization_id = ${org.a}`;
    expect(rows).toEqual([{ organization_id: org.a }]);
    const forged = event(assetId, { organizationId: org.b, hours: '9' });
    await expect(apply(forged)).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' });
    expect((await meter(assetId))!.hourMeter.toString()).toBe('5');
  });

  const malformed = ['-2', '1e3', ' 5', '5.', '5\n', '100000000000', '0.001'];
  it.each(['LEGACY', 'LEDGER'] as const)(
    '%s: invalid quantities/intervals DLQ without marker, meter change or announcement',
    async (source) => {
      const assetId = await machine(source, '100');
      const patches = ['hours', 'kilometres', 'hourMeter', 'odometer'].flatMap((field) =>
        malformed.map((value) => ({ [field]: value })),
      );
      patches.push(
        { hours: '100000000' },
        { periodStart: 'invalid' },
        { periodEnd: 'invalid' },
        { periodEnd: '2026-11-01T09:00:00Z' },
        { periodEnd: '2026-11-01T10:00:00Z' },
      );
      for (const patch of patches) {
        const e = event(assetId, patch);
        await expect(apply(e)).rejects.toMatchObject({
          name: 'UnprocessableEventError',
          reason: 'VALIDATION_FAILED',
        });
        expect(
          await prisma.client.processedEvent.count({
            where: { eventId: e.eventId, consumerName: CONSUMER_NAME },
          }),
        ).toBe(0);
        expect((await meter(assetId))!.hourMeter.toString()).toBe('100');
      }
      expect(announced).not.toContain(assetId);
    },
  );

  it('LEDGER refuses missing intervals; LEGACY still accepts old events without them', async () => {
    for (const missing of ['periodStart', 'periodEnd', 'both']) {
      const assetId = await machine();
      const e = event(assetId, {
        ...(missing !== 'periodEnd' ? { periodStart: undefined } : {}),
        ...(missing !== 'periodStart' ? { periodEnd: undefined } : {}),
      });
      await expect(apply(e)).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' });
      expect(await prisma.client.processedEvent.count({ where: { eventId: e.eventId } })).toBe(0);
    }
    const legacy = await machine('LEGACY');
    await apply(event(legacy, { hours: '2', periodStart: undefined, periodEnd: undefined }));
    expect((await meter(legacy))!.hourMeter.toString()).toBe('2');
  });

  it.each(['LEGACY', 'LEDGER'] as const)('%s crosses old numeric max exactly', async (source) => {
    const assetId = await machine(source);
    await apply(event(assetId, { hourMeter: '9999999999.99', odometer: '9999999999.99' }));
    await apply(
      event(assetId, {
        hours: '1',
        kilometres: '1',
        periodStart: '2026-11-01T11:00:00Z',
        periodEnd: '2026-11-01T12:00:00Z',
      }),
    );
    const m = await meter(assetId);
    expect(m!.hourMeter.toString()).toBe('10000000000.99');
    expect(m!.odometer.toString()).toBe('10000000000.99');
  });

  it.each(['hours', 'kilometres'] as const)(
    'LEGACY refuses %s over NUMERIC(20,2) before marker, with no partial effect',
    async (dimension) => {
      const assetId = await machine('LEGACY', '999999999999999999.99');
      const e = event(assetId, { [dimension]: '0.01' });
      await expect(apply(e)).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' });
      expect((await meter(assetId))!.hourMeter.toString()).toBe('999999999999999999.99');
      expect((await meter(assetId))!.odometer.toString()).toBe('999999999999999999.99');
      expect(await prisma.client.processedEvent.count({ where: { eventId: e.eventId } })).toBe(0);
      expect(announced).not.toContain(assetId);
    },
  );

  it('table CHECKs refuse each negative dimension and inverted intervals', async () => {
    for (const field of ['hours', 'kilometres', 'hour_meter', 'odometer', 'interval']) {
      await expect(
        prisma.client.$executeRawUnsafe(
          `
        INSERT INTO asset_usage_entry(usage_record_id, asset_id, organization_id, period_start, period_end, hours, kilometres, hour_meter, odometer)
        VALUES ($1, $2, $3, '2026-11-01T10:00:00Z', $4::timestamp, $5, $6, $7, $8)`,
          id('USG'),
          id('AST'),
          org.a,
          field === 'interval' ? '2026-11-01T09:00:00Z' : '2026-11-01T11:00:00Z',
          field === 'hours' ? '-1' : '0',
          field === 'kilometres' ? '-1' : '0',
          field === 'hour_meter' ? '-1' : null,
          field === 'odometer' ? '-1' : null,
        ),
      ).rejects.toMatchObject({ meta: expect.objectContaining({ code: '23514' }) });
    }
  });
});
