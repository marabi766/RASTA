import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@rasta/contracts';
import { MeterFullRun } from '../src/maintenance/meter-full-run';
import { lockUsageMeter } from '../src/maintenance/usage-meter';
import { MaintenanceRepository } from '../src/maintenance/maintenance.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, databaseUrl, id, seedAsset, seedMeter, tenants, waitFor } from './helpers';

// The global singleton must never affect another suite or its relay.
describe('full-run marker / first-meter serialization (real PostgreSQL)', () => {
  const schema = `meter_full_run_${randomUUID().replaceAll('-', '')}`;
  const org = tenants();
  const runtimeUrl = new URL(databaseUrl());
  const ownerUrl = process.env.DATABASE_URL_MAINTENANCE_MIGRATOR;
  if (!ownerUrl) throw new Error('DATABASE_URL_MAINTENANCE_MIGRATOR required');
  const owner = new PrismaService(ownerUrl);
  runtimeUrl.searchParams.set('schema', schema);
  runtimeUrl.searchParams.set('application_name', schema);
  const prisma = new PrismaService(runtimeUrl.toString());
  const repository = new MaintenanceRepository(prisma);
  const actor = 'USR_METER_OPERATOR';
  const runId = id('RUN');
  const inventory = (assets: { assetId: string; organizationId: string }[]) => ({
    complete: true,
    scope: 'ALL_PHYSICAL_ASSETS',
    boundary: 'TEST_OWNER_SEAL',
    assets,
  });
  const command = (value: unknown = inventory([])) =>
    new MeterFullRun(prisma, {
      withSealedInventory: async (fn) => fn(value),
    });
  function latch() {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ready, release };
  }
  const tables = [
    'asset_ref',
    'asset_usage_meter',
    'asset_usage_entry',
    'processed_event',
    'meter_full_run',
    'meter_full_run_asset',
    'outbox_message',
    'outbox_stream_sequence',
  ];
  beforeAll(async () => {
    await owner.client.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const table of tables)
      await owner.client.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    const role = decodeURIComponent(runtimeUrl.username).replaceAll('"', '""');
    await owner.client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await owner.client.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    );
  });
  beforeEach(async () => {
    for (const table of tables) await prisma.client.$executeRawUnsafe(`DELETE FROM "${table}"`);
    await prisma.client.$executeRaw`INSERT INTO meter_full_run(id) VALUES (true)`;
  });
  afterAll(async () => {
    await prisma.stop();
    await owner.client.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await owner.stop();
  });
  const bootstrap = (assetId: string, organizationId = org.a) =>
    prisma.transaction((tx) => lockUsageMeter(tx, { assetId, organizationId, now: new Date() }));
  const eventRows = () => prisma.client.outboxMessage.findMany({ where: { aggregateId: runId } });
  async function blocked(statement: 'FOR SHARE' | 'FOR UPDATE') {
    // Server-observed wait, not a delay-based guess that a JS promise is pending.
    await waitFor('PostgreSQL gate lock waiter', async () => {
      const [row] = await prisma.client.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND pid <> pg_backend_pid() AND application_name = ${schema} AND wait_event_type = 'Lock'
          AND query LIKE '%FROM meter_full_run WHERE id = true%'
          AND position(${statement} in query) > 0) AS waiting`;
      return row.waiting;
    });
  }
  it('first meter wins: activation waits, then refuses the committed LEGACY row', async () => {
    const assetId = id('AST');
    const locked = latch(),
      finish = latch();
    const first = prisma.transaction(
      async (tx) => {
        await lockUsageMeter(tx, { assetId, organizationId: org.b, now: new Date() });
        locked.release();
        await finish.ready;
      },
      { timeoutMs: 30_000 },
    );
    await Promise.race([locked.ready, first]);
    const activation = command(inventory([{ assetId, organizationId: org.b }])).activate(
      runId,
      actor,
      [],
    );
    const rejected = expect(activation).rejects.toThrow('FULL_RUN_INCOMPLETE');
    try {
      await blocked('FOR UPDATE');
    } finally {
      finish.release();
    }
    await first;
    await rejected;
    expect((await bootstrap(assetId, org.b)).meter_source).toBe('LEGACY');
    expect(await eventRows()).toHaveLength(0);
  });
  it('activation wins: production fold waits at the gate and starts LEDGER; refused unseen assets stay LEGACY across owners', async () => {
    const assetId = id('AST'),
      refusedId = id('AST');
    const locked = latch(),
      finish = latch();
    const enqueue = MaintenanceRepository.prototype.enqueueEvent;
    const hold = jest
      .spyOn(MaintenanceRepository.prototype, 'enqueueEvent')
      .mockImplementationOnce(async function (this: MaintenanceRepository, tx, input) {
        const result = await enqueue.call(this, tx, input);
        locked.release();
        await finish.ready;
        return result;
      });
    const activation = command(inventory([{ assetId: refusedId, organizationId: org.a }])).activate(
      runId,
      actor,
      [{ assetId: refusedId, reason: 'SOURCE_HISTORY_UNAVAILABLE' }],
    );
    let fold: Promise<boolean> | undefined;
    try {
      await Promise.race([locked.ready, activation]);
      fold = asActor({ organizationId: org.b }, () =>
        prisma.transaction((tx) =>
          repository.foldUsageIntoMeter(
            tx,
            {
              assetId,
              organizationId: org.b,
              usageRecordId: id('USG'),
              hoursDelta: '2',
              kilometresDelta: '0',
              reportedHourMeter: null,
              reportedOdometer: null,
              periodStart: new Date('2026-01-01Z'),
              periodEnd: new Date('2026-01-02Z'),
              now: new Date(),
            },
            id('EVT'),
            'marker-race',
          ),
        ),
      );
      await blocked('FOR SHARE');
    } finally {
      finish.release();
      hold.mockRestore();
    }
    await activation;
    expect(await fold).toBe(true);
    expect((await bootstrap(assetId, org.b)).meter_source).toBe('LEDGER');
    expect((await bootstrap(refusedId, org.b)).meter_source).toBe('LEGACY');
    const restarted = new PrismaService(runtimeUrl.toString());
    try {
      expect(
        (
          await restarted.transaction((tx) =>
            lockUsageMeter(tx, {
              assetId: id('AST'),
              organizationId: org.a,
              now: new Date(),
            }),
          )
        ).meter_source,
      ).toBe('LEDGER');
    } finally {
      await restarted.stop();
    }
    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload as unknown as EventEnvelope).toMatchObject({
      eventName: 'MAINTENANCE_METER_FULL_RUN_ACTIVATED',
      aggregateType: 'MeterFullRun',
      actor: { type: 'USER', id: actor },
      correlationId: runId,
      payload: {
        before: 'INACTIVE',
        after: 'ACTIVE',
        operatorId: actor,
        assetCount: 1,
        refusedCount: 1,
      },
    });
    expect(rows[0].organizationId).toBeNull();
  });
  it('requires authority even at gauge zero; refuses partial, duplicate and omitted local/orphan inventory', async () => {
    await expect(new MeterFullRun(prisma).activate(runId, actor, [])).rejects.toThrow(
      'AUTHORITATIVE_INVENTORY_REQUIRED',
    );
    await expect(
      command({ ...inventory([]), complete: false }).activate(runId, actor, []),
    ).rejects.toThrow();
    await expect(
      asActor({ organizationId: org.a }, () => command().activate(runId, actor, [])),
    ).rejects.toThrow('OPERATOR_CONTEXT_REQUIRED');
    const falseSuccess = new MeterFullRun(prisma, {
      withSealedInventory: async <T>() => runId as unknown as T,
    });
    await expect(falseSuccess.activate(runId, actor, [])).rejects.toThrow('FULL_RUN_UNCONFIRMED');
    const assetId = id('AST');
    await seedAsset(prisma, assetId, org.b);
    await expect(command().activate(runId, actor, [])).rejects.toThrow('FULL_RUN_INCOMPLETE');
    await prisma.client.assetRef.deleteMany({ where: { id: assetId } });
    await seedMeter(prisma, assetId, org.b, '0');
    await expect(command().activate(runId, actor, [])).rejects.toThrow('FULL_RUN_INCOMPLETE');
    const row = { assetId, organizationId: org.b };
    await expect(command(inventory([row, row])).activate(runId, actor, [])).rejects.toThrow(
      'INVENTORY_CONFLICT',
    );
    expect(await eventRows()).toHaveLength(0);
  });
  it('checks all LEDGER outcomes; replay binds actor/body, even after a lost commit response', async () => {
    const assetId = id('AST');
    const c = command(inventory([{ assetId, organizationId: org.a }]));
    await expect(c.activate(runId, actor, [])).rejects.toThrow('FULL_RUN_INCOMPLETE');
    await seedMeter(prisma, assetId, org.a, '0');
    await prisma.client.assetUsageMeter.update({
      where: { assetId },
      data: { meterSource: 'LEDGER' },
    });
    const transaction = prisma.transaction.bind(prisma);
    const lost = jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, options) => {
      await transaction(fn, options);
      throw new Error('lost commit');
    });
    try {
      await expect(c.activate(runId, actor, [])).rejects.toThrow('FULL_RUN_UNCONFIRMED');
    } finally {
      lost.mockRestore();
    }
    await Promise.all([c.activate(runId, actor, []), c.activate(runId, actor, [])]);
    await expect(c.activate(runId, 'OTHER_OPERATOR', [])).rejects.toThrow('FULL_RUN_CONFLICT');
    await expect(
      c.activate(runId, actor, [{ assetId, reason: 'HISTORY_UNKNOWN' }]),
    ).rejects.toThrow('FULL_RUN_CONFLICT');
    const releaseLost = new MeterFullRun(prisma, {
      withSealedInventory: async (fn) => {
        await fn(inventory([{ assetId, organizationId: org.a }]));
        throw new Error('owner release lost');
      },
    });
    await expect(releaseLost.activate(runId, actor, [])).rejects.toThrow('FULL_RUN_UNCONFIRMED');
    expect(await eventRows()).toHaveLength(1);
  });
  it('rollback after enqueue leaves no marker, inventory or audit event; missing fence never defaults', async () => {
    const transaction = prisma.transaction.bind(prisma);
    const fail = jest.spyOn(prisma, 'transaction').mockImplementationOnce((fn, options) =>
      transaction(async (tx) => {
        await fn(tx);
        throw new Error('rollback');
      }, options),
    );
    try {
      await expect(command().activate(runId, actor, [])).rejects.toThrow('FULL_RUN_UNCONFIRMED');
    } finally {
      fail.mockRestore();
    }
    expect(await eventRows()).toHaveLength(0);
    expect(await prisma.client.meterFullRunAsset.count()).toBe(0);
    expect((await bootstrap(id('AST'))).meter_source).toBe('LEGACY');
    await prisma.client.$executeRaw`DELETE FROM meter_full_run`;
    await expect(bootstrap(id('AST'))).rejects.toThrow('FULL_RUN_GATE_MISSING');
  });
});
