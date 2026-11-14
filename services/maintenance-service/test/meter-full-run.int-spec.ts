import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '../src/generated/prisma';
import type { EventEnvelope } from '@rasta/contracts';
import { MeterFullRun, MeterFullRunRefusal } from '../src/maintenance/meter-full-run';
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
  runtimeUrl.searchParams.set('connection_limit', '12');
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
      withQuarantineClear: async (runId, boundary, fn) =>
        fn({ runId, boundary, clear: true, assertHeld: async () => undefined }),
      withSealedInventory: async (_runId, fn) => fn(value),
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
    // LIKE does not copy triggers. Exercise the actual migrated PostgreSQL function.
    await owner.client.$executeRawUnsafe(
      `CREATE TRIGGER usage_meter_insert_fence BEFORE INSERT ON "${schema}".asset_usage_meter
       FOR EACH ROW EXECUTE FUNCTION public.set_usage_meter_source()`,
    );
    await owner.client.$executeRawUnsafe(
      `CREATE TRIGGER usage_meter_mode_fixed BEFORE UPDATE OF meter_source ON "${schema}".asset_usage_meter
       FOR EACH ROW EXECUTE FUNCTION public.usage_meter_mode_fixed()`,
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
          AND CASE WHEN ${statement} = 'FOR SHARE' THEN query LIKE '%INSERT INTO asset_usage_meter%'
            ELSE query LIKE '%FROM meter_full_run WHERE id = true FOR UPDATE%' END) AS waiting`;
      return row.waiting;
    });
  }
  it('first meter wins: activation waits, then refuses the committed LEGACY row', async () => {
    const assetId = id('AST');
    const locked = latch(),
      finish = latch();
    const first = prisma.transaction(
      async (tx) => {
        // Simulate an old image or future writer, bypassing lockUsageMeter.
        await tx.$executeRaw`INSERT INTO asset_usage_meter(asset_id, organization_id, updated_at)
          VALUES (${assetId}, ${org.b}, ${new Date()})`;
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
  it.each([
    undefined,
    {},
    { runId, boundary: 'STALE', clear: true, assertHeld: async () => undefined },
    { runId, boundary: 'TEST_OWNER_SEAL', clear: false, assertHeld: async () => undefined },
    { runId, boundary: 'TEST_OWNER_SEAL', clear: true },
    {
      runId,
      boundary: 'TEST_OWNER_SEAL',
      clear: true,
      assertHeld: async () => {
        throw new Error('expired source lock');
      },
    },
  ])('refuses missing, stale or unresolved quarantine proof: %j', async (proof) => {
    const c = new MeterFullRun(prisma, {
      withSealedInventory: async (_runId, fn) => fn(inventory([])),
      withQuarantineClear: async (_runId, _boundary, fn) => fn(proof),
    });
    await expect(c.activate(runId, actor, [])).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
    expect(await c.status(runId, actor)).toBeNull();
    expect(await eventRows()).toHaveLength(0);
  });
  it('refuses an old authority without the required clearance capability and an unreadable channel', async () => {
    const authority = {
      withSealedInventory: async <T>(_runId: string, fn: (value: unknown) => Promise<T>) =>
        fn(inventory([])),
    };
    // Deliberately model an older deployed adapter at the runtime boundary.
    const old = new MeterFullRun(
      prisma,
      authority as import('../src/maintenance/meter-full-run').MeterInventoryAuthority,
    );
    await expect(old.activate(runId, actor, [])).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
    const unreadable = new MeterFullRun(prisma, {
      ...authority,
      withQuarantineClear: async () => {
        throw new Error('unreadable');
      },
    });
    await expect(unreadable.activate(runId, actor, [])).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
    expect(await eventRows()).toHaveLength(0);
  });
  it.each(['inventory', 'quarantine'])(
    'keeps %s authority abandonment unconfirmed while maintenance is still running',
    async (layer) => {
      const entered = latch(),
        finish = latch();
      const enqueue = MaintenanceRepository.prototype.enqueueEvent;
      const pause = jest
        .spyOn(MaintenanceRepository.prototype, 'enqueueEvent')
        .mockImplementationOnce(async function (this: MaintenanceRepository, tx, input) {
          const result = await enqueue.call(this, tx, input);
          entered.release();
          await finish.ready;
          return result;
        });
      let pending: Promise<unknown> | undefined;
      const abandon = async (action: Promise<unknown>): Promise<never> => {
        pending = action;
        await Promise.race([entered.ready, action]);
        throw new MeterFullRunRefusal('SOURCE_DRIFT_QUARANTINED');
      };
      const c = new MeterFullRun(prisma, {
        withSealedInventory: (_runId, fn) => {
          const action = fn(inventory([]));
          return layer === 'inventory' ? abandon(action) : action;
        },
        withQuarantineClear: (key, boundary, fn) => {
          const action = fn({
            runId: key,
            boundary,
            clear: true,
            assertHeld: async () => undefined,
          });
          return layer === 'quarantine' ? abandon(action) : action;
        },
      });
      try {
        await expect(c.activate(runId, actor, [])).rejects.toThrow('FULL_RUN_UNCONFIRMED');
      } finally {
        finish.release();
        await Promise.allSettled(pending ? [pending] : []);
        pause.mockRestore();
      }
      expect(await c.status(runId, actor)).toMatchObject({ runId });
      expect(await eventRows()).toHaveLength(1);
    },
  );
  it('requires authority even at gauge zero; refuses partial, duplicate and omitted local/orphan inventory', async () => {
    await expect(new MeterFullRun(prisma).activate(runId, actor, [])).rejects.toThrow(
      'AUTHORITATIVE_INVENTORY_REQUIRED',
    );
    await expect(
      command({ ...inventory([]), complete: false }).activate(runId, actor, []),
    ).rejects.toThrow('SOURCE_INVENTORY_MALFORMED');
    await expect(
      asActor({ organizationId: org.a }, () => command().activate(runId, actor, [])),
    ).rejects.toThrow('OPERATOR_CONTEXT_REQUIRED');
    const falseSuccess = new MeterFullRun(prisma, {
      withQuarantineClear: async (runId, boundary, fn) =>
        fn({ runId, boundary, clear: true, assertHeld: async () => undefined }),
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
    ).rejects.toThrow('ALREADY_ACTIVE_INVENTORY_DRIFT');
    const releaseLost = new MeterFullRun(prisma, {
      withQuarantineClear: async (runId, boundary, fn) =>
        fn({ runId, boundary, clear: true, assertHeld: async () => undefined }),
      withSealedInventory: async (_runId, fn) => {
        await fn(inventory([{ assetId, organizationId: org.a }]));
        throw new Error('owner release lost');
      },
    });
    await expect(releaseLost.activate(runId, actor, [])).rejects.toThrow('FULL_RUN_UNCONFIRMED');
    expect(await eventRows()).toHaveLength(1);
  });
  it.each(['write', 'replay'])(
    'keeps post-callback %s errors unconfirmed, including known refusal shapes',
    async (phase) => {
      if (phase === 'replay') await command().activate(runId, actor, []);
      const transaction = prisma.transaction.bind(prisma);
      for (const error of [
        new MeterFullRunRefusal('FULL_RUN_CONFLICT'),
        new Prisma.PrismaClientKnownRequestError('lost response', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      ]) {
        jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, options) => {
          await transaction(fn, options);
          throw error;
        });
        await expect(command().activate(runId, actor, [])).rejects.toThrow('FULL_RUN_UNCONFIRMED');
      }
      expect(await eventRows()).toHaveLength(1);
      expect(await command().activate(runId, actor, [])).toBe(runId);
    },
  );
  it.each([null, { ...inventory([]), extra: true }])(
    'names malformed source inventory before any transaction: %j',
    async (value) => {
      const transaction = jest.spyOn(prisma, 'transaction');
      try {
        await expect(command(value).activate(runId, actor, [])).rejects.toEqual(
          new MeterFullRunRefusal('SOURCE_INVENTORY_MALFORMED'),
        );
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        transaction.mockRestore();
      }
      expect(await eventRows()).toHaveLength(0);
    },
  );
  it('measures the hot gate under eight concurrent folds and an exclusive activation waiter', async () => {
    const assets = Array.from({ length: 8 }, () => ({ assetId: id('AST'), organizationId: org.a }));
    const finish = latch();
    const started = performance.now();
    const ready = assets.map(() => latch());
    const folds = assets.map(({ assetId }, index) =>
      asActor({ organizationId: org.a }, () =>
        prisma.transaction(
          async (tx) => {
            await repository.foldUsageIntoMeter(
              tx,
              {
                assetId,
                organizationId: org.a,
                usageRecordId: id('USG'),
                hoursDelta: '1',
                kilometresDelta: '0',
                reportedHourMeter: null,
                reportedOdometer: null,
                periodStart: new Date('2026-01-01Z'),
                periodEnd: new Date('2026-01-02Z'),
                now: new Date(),
              },
              id('EVT'),
              'hot-gate-measurement',
            );
            ready[index].release();
            await finish.ready;
          },
          { timeoutMs: 30_000 },
        ),
      ),
    );
    const completed = Promise.all(folds);
    let activation: Promise<string> | undefined;
    let foldsReadyMs = 0,
      waiterObservedMs = 0;
    try {
      await Promise.race([Promise.all(ready.map((r) => r.ready)), completed]);
      foldsReadyMs = performance.now() - started;
      activation = command(inventory(assets)).activate(
        runId,
        actor,
        assets.map(({ assetId }) => ({ assetId, reason: 'LEGACY_HISTORY' })),
      );
      await blocked('FOR UPDATE');
      waiterObservedMs = performance.now() - started;
    } finally {
      finish.release();
    }
    await completed;
    expect(await activation).toBe(runId);
    // Measurements are diagnostics, not timing assertions or production SLO claims.
    process.stdout.write(
      JSON.stringify({
        hotGateFolds: assets.length,
        foldsReadyMs,
        waiterObservedMs,
        totalMs: performance.now() - started,
      }) + '\n',
    );
    expect(await command().status(runId, actor)).toMatchObject({ assetCount: 8, refusedCount: 8 });
  });
  it('re-serves the run seal after response loss and source drift; status remains readable without authority', async () => {
    const seals = new Map<string, unknown>();
    let source = inventory([]);
    const requestedRuns: string[] = [];
    const authority = {
      withQuarantineClear: async <T>(
        runId: string,
        boundary: string,
        fn: (proof: unknown) => Promise<T>,
      ): Promise<T> => fn({ runId, boundary, clear: true, assertHeld: async () => undefined }),
      withSealedInventory: async <T>(
        key: string,
        fn: (value: unknown) => Promise<T>,
      ): Promise<T> => {
        requestedRuns.push(key);
        if (!seals.has(key)) seals.set(key, source);
        const result = await fn(seals.get(key));
        if (seals.size === 1 && source.assets.length === 0) throw new Error('lost release');
        return result;
      },
    };
    const c = new MeterFullRun(prisma, authority);
    const reader = new MeterFullRun(prisma);
    expect(await reader.status(runId, actor)).toBeNull();
    await expect(c.activate(runId, actor, [])).rejects.toThrow('FULL_RUN_UNCONFIRMED');
    const stored = await reader.status(runId, actor);
    expect(stored).toEqual({
      runId,
      inventoryDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceBoundary: 'TEST_OWNER_SEAL',
      assetCount: 0,
      refusedCount: 0,
    });
    source = {
      ...inventory([{ assetId: id('AST'), organizationId: org.b }]),
      boundary: 'NEW_BOUNDARY',
    };
    expect(await c.activate(runId, actor, [])).toBe(runId);
    expect(requestedRuns).toEqual([runId, runId]);
    await expect(command(source).activate(runId, actor, [])).rejects.toThrow(
      'ALREADY_ACTIVE_INVENTORY_DRIFT',
    );
    await expect(reader.status(runId, 'OTHER_OPERATOR')).rejects.toThrow('FULL_RUN_CONFLICT');
    await expect(reader.status(id('RUN'), actor)).rejects.toThrow('FULL_RUN_CONFLICT');
    await expect(
      asActor({ organizationId: org.b }, () => reader.status(runId, actor)),
    ).rejects.toThrow('OPERATOR_CONTEXT_REQUIRED');
    expect(await reader.status(runId, actor)).toEqual(stored);
    expect(await eventRows()).toHaveLength(1);
  });
  it('database overrides omitted and explicit modes, including seed/model writes and a missing gate', async () => {
    const refusedId = id('AST');
    await command(inventory([{ assetId: refusedId, organizationId: org.a }])).activate(
      runId,
      actor,
      [{ assetId: refusedId, reason: 'HISTORY_UNKNOWN' }],
    );
    for (const mode of [null, 'LEGACY', 'LEDGER']) {
      const assetId = id('AST');
      await prisma.client
        .$executeRaw`INSERT INTO asset_usage_meter(asset_id, organization_id, updated_at, meter_source)
        VALUES (${assetId}, ${org.b}, ${new Date()}, ${mode})`;
      expect((await bootstrap(assetId)).meter_source).toBe('LEDGER');
    }
    await seedMeter(prisma, id('AST'), org.b, '0');
    await seedMeter(prisma, refusedId, org.b, '0');
    expect((await bootstrap(refusedId, org.b)).meter_source).toBe('LEGACY');
    expect(await command().status(runId, actor)).toMatchObject({ assetCount: 1, refusedCount: 1 });
    await prisma.client.$executeRaw`DELETE FROM meter_full_run`;
    await expect(prisma.client
      .$executeRaw`INSERT INTO asset_usage_meter(asset_id, organization_id, updated_at)
      VALUES (${id('AST')}, ${org.b}, ${new Date()})`).rejects.toThrow('FULL_RUN_GATE_MISSING');
    await expect(command().status(runId, actor)).rejects.toThrow('FULL_RUN_GATE_MISSING');
  });
  it('pins gate/refusal lookup against a hostile caller search_path and temp shadows', async () => {
    await owner.transaction(async (tx) => {
      await tx.$executeRaw`CREATE TEMP TABLE meter_full_run(id boolean, run_id text) ON COMMIT DROP`;
      await tx.$executeRaw`INSERT INTO pg_temp.meter_full_run VALUES(true, 'FAKE_ACTIVE')`;
      await tx.$executeRaw`SELECT set_config('search_path', ${`pg_temp, "${schema}", public`}, true)`;
      const [row] = await tx.$queryRaw<{ meter_source: string }[]>`
        INSERT INTO asset_usage_meter(asset_id, organization_id, updated_at)
        VALUES (${id('AST')}, ${org.a}, ${new Date()}) RETURNING meter_source`;
      expect(row.meter_source).toBe('LEGACY');
    });
  });
  it('allows idempotent modes and LEGACY to LEDGER, refuses regression by direct SQL', async () => {
    const assetId = id('AST');
    await bootstrap(assetId);
    for (const mode of ['LEGACY', 'LEDGER', 'LEDGER'])
      await prisma.client
        .$executeRaw`UPDATE asset_usage_meter SET meter_source = ${mode} WHERE asset_id = ${assetId}`;
    await expect(prisma.client.$executeRaw`UPDATE asset_usage_meter SET meter_source = 'LEGACY'
      WHERE asset_id = ${assetId}`).rejects.toThrow('USAGE_METER_MODE_REGRESSION');
    expect((await bootstrap(assetId)).meter_source).toBe('LEDGER');
  });
  it('pins mode operators against a hostile scratch-schema search_path', async () => {
    const assetId = id('AST');
    await bootstrap(assetId);
    await prisma.client
      .$executeRaw`UPDATE asset_usage_meter SET meter_source = 'LEDGER' WHERE asset_id = ${assetId}`;
    await expect(
      owner.transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE FUNCTION "${schema}".mode_equal(text, text) RETURNS boolean
        LANGUAGE sql AS 'SELECT true'`);
        await tx.$executeRawUnsafe(`CREATE OPERATOR "${schema}".= (LEFTARG = text, RIGHTARG = text,
        FUNCTION = "${schema}".mode_equal)`);
        await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
        // Prove the caller operator is hostile before exercising the migrated function.
        const [probe] = await tx.$queryRaw<
          { equal: boolean }[]
        >`SELECT 'LEDGER'::text = 'LEGACY'::text AS equal`;
        expect(probe.equal).toBe(true);
        await tx.$executeRaw`UPDATE asset_usage_meter SET meter_source = 'LEGACY' WHERE asset_id = ${assetId}`;
      }),
    ).rejects.toThrow('USAGE_METER_MODE_REGRESSION');
    expect((await bootstrap(assetId)).meter_source).toBe('LEDGER');
  });
  it.each(['marker', 'meter'])(
    'refuses mode-path down with an active %s in the scratch schema',
    async (active) => {
      if (active === 'marker') await command().activate(runId, actor, []);
      else {
        const assetId = id('AST');
        await bootstrap(assetId);
        await prisma.client
          .$executeRaw`UPDATE asset_usage_meter SET meter_source = 'LEDGER' WHERE asset_id = ${assetId}`;
      }
      const down = readFileSync(
        join(
          __dirname,
          '../prisma/migrations/20261114090000_usage_meter_mode_search_path/down.sql',
        ),
        'utf8',
      );
      const guard = down.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/)?.[0];
      expect(guard).toBeDefined();
      await expect(
        owner.transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
          await tx.$executeRawUnsafe(guard!);
        }),
      ).rejects.toThrow('ACTIVE_METER_MODE_ROLLBACK_REFUSED');
    },
  );
  it('reports real Prisma callback expiration as a precommit refusal', async () => {
    const transaction = prisma.transaction.bind(prisma);
    let expired: unknown;
    const timeout = jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn) => {
      try {
        return await transaction(fn, { timeoutMs: 100 });
      } catch (error) {
        expired = error;
        throw error;
      }
    });
    const enqueue = jest
      .spyOn(MaintenanceRepository.prototype, 'enqueueEvent')
      .mockImplementationOnce(async (tx) => {
        await tx.$executeRaw`SELECT pg_sleep(0.4)`;
        // The callback has not returned when Prisma expires its transaction.
        await tx.$executeRaw`SELECT 1`;
        return 'unreachable';
      });
    try {
      await expect(command().activate(runId, actor, [])).rejects.toThrow(
        'FULL_RUN_PRECOMMIT_FAILED',
      );
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(expired).toMatchObject({ code: 'P2028' });
    } finally {
      timeout.mockRestore();
      enqueue.mockRestore();
    }
    expect(await command().status(runId, actor)).toBeNull();
    expect(await eventRows()).toHaveLength(0);
  });
  it('reports definite pool and statement failures as named precommit refusals', async () => {
    const pool = jest.spyOn(prisma, 'transaction').mockRejectedValueOnce(new Error('pool wait'));
    await expect(command().activate(runId, actor, [])).rejects.toBeInstanceOf(MeterFullRunRefusal);
    pool.mockRestore();
    for (const failure of ['statement', 'timeout']) {
      const fail = jest
        .spyOn(MaintenanceRepository.prototype, 'enqueueEvent')
        .mockImplementationOnce(async (tx) => {
          if (failure === 'statement') await tx.$executeRaw`SELECT 1/0`;
          else {
            await tx.$executeRaw`SET LOCAL statement_timeout = '10ms'`;
            await tx.$executeRaw`SELECT pg_sleep(1)`;
          }
          throw new Error('unreachable');
        });
      try {
        await expect(command().activate(runId, actor, [])).rejects.toThrow(
          'FULL_RUN_PRECOMMIT_FAILED',
        );
      } finally {
        fail.mockRestore();
      }
      expect(await command().status(runId, actor)).toBeNull();
      expect(await eventRows()).toHaveLength(0);
    }
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
