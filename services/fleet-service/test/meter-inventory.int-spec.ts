import { eligibilityClockWrite } from '@rasta/testing';
import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@rasta/contracts';
import { FleetMeterInventorySeal } from '../src/fleet/meter-inventory';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { asActor, databaseUrl, id, ownerDatabaseUrl, tenants, waitFor } from './helpers';

describe('fleet durable source seal and future-creation fence (real PostgreSQL)', () => {
  const owner = new PrismaService(ownerDatabaseUrl());
  const org = tenants();
  const actor = 'USR_SOURCE_OPERATOR';
  const sources = [
    'asset_ref',
    'usage_record',
    'assignment',
    'availability_window',
    'asset_transfer_fence',
    'asset_transfer_release',
    'insurance_pending_verification',
  ];
  let schema: string, runtime: URL, prisma: PrismaService, command: FleetMeterInventorySeal;
  const runId = id('RUN');
  const latch = () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ready, release };
  };
  beforeEach(async () => {
    schema = `source_seal_${randomUUID().replaceAll('-', '')}`;
    runtime = new URL(databaseUrl());
    runtime.searchParams.set('schema', schema);
    runtime.searchParams.set('application_name', schema);
    runtime.searchParams.set('connection_limit', '8');
    await owner.client.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const table of [
      ...sources,
      'meter_inventory_seal',
      'meter_inventory_seal_asset',
      'outbox_message',
      'outbox_stream_sequence',
    ])
      await owner.client.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    for (const table of sources)
      await owner.client
        .$executeRawUnsafe(`CREATE TRIGGER meter_inventory_creation_fence BEFORE INSERT OR UPDATE
        ON "${schema}"."${table}" FOR EACH ROW EXECUTE FUNCTION public.meter_inventory_creation_fence('${table === 'asset_ref' ? 'id' : 'asset_id'}')`);
    await owner.client
      .$executeRawUnsafe(`CREATE TRIGGER meter_inventory_seal_fixed BEFORE UPDATE OR DELETE
      ON "${schema}".meter_inventory_seal FOR EACH ROW EXECUTE FUNCTION public.meter_inventory_seal_fixed()`);
    await owner.client
      .$executeRawUnsafe(`CREATE TRIGGER meter_inventory_seal_no_truncate BEFORE TRUNCATE
      ON "${schema}".meter_inventory_seal FOR EACH STATEMENT EXECUTE FUNCTION public.meter_inventory_seal_fixed()`);
    await owner.client.$executeRawUnsafe(`CREATE TRIGGER meter_inventory_seal_asset_fixed
      BEFORE INSERT OR UPDATE OR DELETE ON "${schema}".meter_inventory_seal_asset
      FOR EACH ROW EXECUTE FUNCTION public.meter_inventory_seal_asset_fixed()`);
    await owner.client.$executeRawUnsafe(`CREATE TRIGGER meter_inventory_seal_asset_no_truncate
      BEFORE TRUNCATE ON "${schema}".meter_inventory_seal_asset
      FOR EACH STATEMENT EXECUTE FUNCTION public.meter_inventory_seal_asset_fixed()`);
    const role = decodeURIComponent(runtime.username).replaceAll('"', '""');
    await owner.client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await owner.client.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    );
    prisma = new PrismaService(runtime.toString());
    command = new FleetMeterInventorySeal(prisma);
    await prisma.client.$executeRaw`INSERT INTO meter_inventory_seal(id) VALUES(true)`;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.stop();
    await owner.client.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
  afterAll(async () => {
    await owner.stop();
  });
  const asset = (assetId: string) => prisma.client.$executeRaw`
    INSERT INTO asset_ref(id, organization_id, status, synced_at, source_event)
    VALUES (${assetId}, ${org.a}, 'ACTIVE', ${new Date()}, 'TEST')`;
  async function waiter(fragment: string) {
    await waitFor('source PostgreSQL lock waiter', async () => {
      const [row] = await prisma.client.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ${schema}
          AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}) AS waiting`;
      return row.waiting;
    });
  }
  const events = () => prisma.client.outboxMessage.findMany({ where: { aggregateId: runId } });
  it('enumerates every source, fences INSERT/UPDATE in every sibling, and re-serves the immutable seal', async () => {
    const ids = sources.map(() => id('AST'));
    const currentId = ids[0];
    await asset(currentId);
    await prisma.client
      .$executeRaw`INSERT INTO usage_record(id, asset_id, organization_id, period_start, period_end,
      hours, recorded_by) VALUES (${id('USG')}, ${ids[1]}, ${org.b}, '2026-01-01', '2026-01-02', 1, 'TEST')`;
    await prisma.client
      .$executeRaw`INSERT INTO assignment(id, asset_id, organization_id, driver_id, started_at,
      assigned_by, updated_at) VALUES (${id('ASG')}, ${ids[2]}, ${org.a}, 'TEST_DRIVER', '2026-01-01', 'TEST', ${new Date()})`;
    await prisma.client
      .$executeRaw`INSERT INTO availability_window(id, asset_id, organization_id, available, from_at,
      reason, created_by) VALUES (${id('AVW')}, ${ids[3]}, ${org.b}, false, '2026-01-01', 'TEST', 'TEST')`;
    await eligibilityClockWrite(
      prisma.client,
    )`INSERT INTO asset_transfer_fence(asset_id, organization_id, fence_id, expires_at,
      created_at) VALUES (${ids[4]}, ${org.a}, 'TEST_FENCE', '2027-01-01Z', '2026-01-01Z')`;
    await eligibilityClockWrite(
      prisma.client,
    )`INSERT INTO asset_transfer_release(asset_id, organization_id, fence_id, expires_at,
      released_at) VALUES (${ids[5]}, ${org.b}, 'TEST_RELEASE', '2027-01-01Z', '2026-01-01Z')`;
    await prisma.client
      .$executeRaw`INSERT INTO insurance_pending_verification(event_id, asset_id, organization_id,
      envelope, source_topic, reason) VALUES (${id('EVT')}, ${ids[6]}, ${org.a}, '{}', 'TEST', 'TEST')`;
    // A historical owner must not duplicate a physical asset or override the replica owner.
    await prisma.client
      .$executeRaw`INSERT INTO usage_record(id, asset_id, organization_id, period_start, period_end,
      hours, recorded_by) VALUES (${id('USG')}, ${ids[0]}, ${org.b}, '2026-01-01', '2026-01-02', 1, 'TEST')`;
    const plantedId = id('AST');
    await prisma.client.$executeRaw`INSERT INTO meter_inventory_seal_asset
      VALUES (${plantedId}, ${org.a})`;
    const sealed = await command.seal(runId, actor);
    await expect(asset(plantedId)).rejects.toThrow('SOURCE_INVENTORY_SEALED');
    expect(sealed.assets).toHaveLength(7);
    expect(sealed.assets.map((a) => a.assetId).sort()).toEqual([...ids].sort());
    expect(sealed.assets).toContainEqual({ assetId: currentId, organizationId: org.a });
    for (const table of sources) {
      const key = table === 'asset_ref' ? 'id' : 'asset_id';
      await expect(
        prisma.client.$executeRawUnsafe(`UPDATE "${table}" SET "${key}" = $1`, id('AST')),
      ).rejects.toThrow('SOURCE_INVENTORY_SEALED');
      await expect(
        prisma.client.$executeRawUnsafe(
          `INSERT INTO "${table}" SELECT
        (jsonb_populate_record(NULL::"${table}", to_jsonb(t) || jsonb_build_object('${key}', $1::text))).*
        FROM "${table}" t LIMIT 1`,
          id('AST'),
        ),
      ).rejects.toThrow('SOURCE_INVENTORY_SEALED');
      await expect(
        prisma.client.$executeRawUnsafe(
          `UPDATE "${table}" SET organization_id = CASE WHEN organization_id = $1 THEN $2 ELSE $1 END`,
          org.a,
          org.b,
        ),
      ).rejects.toThrow('SOURCE_OWNER_DRIFT');
      await expect(
        prisma.client.$executeRawUnsafe(
          `INSERT INTO "${table}" SELECT
          (jsonb_populate_record(NULL::"${table}", to_jsonb(t) || jsonb_build_object('organization_id',
            CASE WHEN t.organization_id = $1 THEN $2 ELSE $1 END))).*
          FROM "${table}" t WHERE t."${key}" = $3 LIMIT 1`,
          org.a,
          org.b,
          ids[sources.indexOf(table)],
        ),
      ).rejects.toThrow('SOURCE_OWNER_DRIFT');
    }
    // A known orphan cannot acquire a different owner through the replica INSERT path.
    await expect(asset(ids[1])).rejects.toThrow('SOURCE_OWNER_DRIFT');
    await expect(prisma.client.$executeRaw`UPDATE meter_inventory_seal_asset
      SET organization_id = ${org.b}`).rejects.toThrow('SOURCE_SEAL_FIXED');
    await expect(prisma.client.$executeRaw`DELETE FROM meter_inventory_seal_asset`).rejects.toThrow(
      'SOURCE_SEAL_FIXED',
    );
    await expect(prisma.client.$executeRaw`INSERT INTO meter_inventory_seal_asset
      VALUES (${id('AST')}, ${org.b})`).rejects.toThrow('SOURCE_SEAL_FIXED');
    await expect(
      owner.client.$executeRawUnsafe(`TRUNCATE "${schema}".meter_inventory_seal_asset`),
    ).rejects.toThrow('SOURCE_SEAL_FIXED');
    const restarted = new PrismaService(runtime.toString());
    try {
      expect(await new FleetMeterInventorySeal(restarted).seal(runId, actor)).toEqual(sealed);
    } finally {
      await restarted.stop();
    }
    await expect(command.seal(id('RUN'), actor)).rejects.toThrow('SOURCE_SEAL_CONFLICT');
    await expect(command.seal(runId, 'OTHER_OPERATOR')).rejects.toThrow('SOURCE_SEAL_CONFLICT');
    await expect(
      asActor({ organizationId: org.b }, () => command.seal(runId, actor)),
    ).rejects.toThrow('OPERATOR_CONTEXT_REQUIRED');
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBeNull();
    expect(rows[0].partitionKey).toBe('meter-inventory-seal');
    expect(rows[0].payload as unknown as EventEnvelope).toMatchObject({
      actor: { type: 'USER', id: actor },
      correlationId: runId,
      payload: { runId, operatorId: actor, assetCount: 7, sourceBoundary: sealed.boundary },
    });
  });
  it('refuses a malformed stored seal boundary on same-run replay', async () => {
    await prisma.client.$executeRaw`UPDATE meter_inventory_seal SET run_id = ${runId},
      operator_id = ${actor}, inventory = '[]'::jsonb, boundary = 'BROKEN_SOURCE_SEAL'
      WHERE id = true`;
    await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_SEAL_INVALID');
    expect(await events()).toHaveLength(0);
  });
  it('refuses a stale-snapshot seal transaction before publishing inventory', async () => {
    jest.spyOn(prisma, 'transaction').mockImplementationOnce((fn) =>
      prisma.client.$transaction((tx) => fn(tx as ExtendedPrismaClient), {
        isolationLevel: 'RepeatableRead',
      }),
    );
    await expect(command.seal(runId, actor)).rejects.toThrow(
      'SOURCE_FENCE_REQUIRES_READ_COMMITTED',
    );
    expect(await events()).toHaveLength(0);
  });
  it('earlier writer wins: seal refuses immediately, then includes its committed identity', async () => {
    const assetId = id('AST'),
      locked = latch(),
      finish = latch();
    const writer = prisma.transaction(
      async (tx) => {
        await tx.$executeRaw`INSERT INTO asset_ref(id, organization_id, status, synced_at, source_event)
        VALUES (${assetId}, ${org.b}, 'ACTIVE', ${new Date()}, 'TEST')`;
        locked.release();
        await finish.ready;
      },
      { timeoutMs: 30_000 },
    );
    await Promise.race([locked.ready, writer]);
    try {
      await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_WRITERS_ACTIVE');
    } finally {
      finish.release();
    }
    await writer;
    expect((await command.seal(runId, actor)).assets).toEqual([{ assetId, organizationId: org.b }]);
  });
  it('refuses a reverse-order two-table writer without blocking its second write', async () => {
    const assetId = id('AST'),
      locked = latch(),
      finish = latch();
    const writer = prisma.transaction(
      async (tx) => {
        // Asset-sync's insurance-before-assignment order, opposite the seal's table order.
        await tx.$executeRaw`INSERT INTO insurance_pending_verification(event_id, asset_id,
        organization_id, envelope, source_topic, reason)
        VALUES (${id('EVT')}, ${assetId}, ${org.a}, '{}', 'TEST', 'TEST')`;
        locked.release();
        await finish.ready;
        await tx.$executeRaw`DELETE FROM assignment WHERE asset_id = ${assetId}`;
      },
      { timeoutMs: 5000 },
    );
    await Promise.race([locked.ready, writer]);
    try {
      await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_WRITERS_ACTIVE');
      expect(await events()).toHaveLength(0);
    } finally {
      finish.release();
    }
    await writer;
    expect((await command.seal(runId, actor)).assets).toEqual([{ assetId, organizationId: org.a }]);
  });
  it('replays the stored pair while a source writer is active, without taking table locks', async () => {
    const assetId = id('AST'),
      locked = latch(),
      finish = latch();
    await asset(assetId);
    const sealed = await command.seal(runId, actor);
    const writer = prisma.transaction(async (tx) => {
      await tx.$executeRaw`UPDATE asset_ref SET status = 'SUSPENDED' WHERE id = ${assetId}`;
      locked.release();
      await finish.ready;
    });
    await Promise.race([locked.ready, writer]);
    try {
      expect(await command.seal(runId, actor)).toEqual(sealed);
    } finally {
      finish.release();
    }
    await writer;
    expect(await events()).toHaveLength(1);
  });
  it('refuses a membership table writer before taking the gate lock', async () => {
    const locked = latch(),
      finish = latch();
    const writer = prisma.transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE meter_inventory_seal_asset IN ROW EXCLUSIVE MODE`;
      locked.release();
      await finish.ready;
    });
    await Promise.race([locked.ready, writer]);
    try {
      await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_WRITERS_ACTIVE');
    } finally {
      finish.release();
    }
    await writer;
    expect(await events()).toHaveLength(0);
  });
  it('seal wins: bypass writer waits, then refuses its unseen identity after commit', async () => {
    const locked = latch(),
      finish = latch();
    const enqueue = FleetRepository.prototype.enqueueEvent;
    jest.spyOn(FleetRepository.prototype, 'enqueueEvent').mockImplementationOnce(async function (
      this: FleetRepository,
      tx,
      input,
    ) {
      const result = await enqueue.call(this, tx, input);
      locked.release();
      await finish.ready;
      return result;
    });
    const sealing = command.seal(runId, actor);
    await Promise.race([locked.ready, sealing]);
    const writing = expect(asset(id('AST'))).rejects.toThrow('SOURCE_INVENTORY_SEALED');
    try {
      await waiter('INSERT INTO asset_ref');
    } finally {
      finish.release();
    }
    expect((await sealing).assets).toEqual([]);
    await writing;
    expect(await prisma.client.assetRef.count()).toBe(0);
  });
  it('ambiguous or oversized inventory refuses without sealing or audit; the gate never defaults', async () => {
    const assetId = id('AST');
    for (const tenant of [org.a, org.b])
      await prisma.client
        .$executeRaw`INSERT INTO usage_record(id, asset_id, organization_id, period_start, period_end,
        hours, recorded_by) VALUES (${id('USG')}, ${assetId}, ${tenant}, '2026-01-01', '2026-01-02', 1, 'TEST')`;
    await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_OWNER_UNCONFIRMED');
    await prisma.client.$executeRaw`DELETE FROM usage_record`;
    await prisma.client
      .$executeRaw`INSERT INTO asset_ref(id, organization_id, status, synced_at, source_event)
      SELECT 'AST_' || n, ${org.a}, 'ACTIVE', ${new Date()}, 'TEST' FROM generate_series(1, 20001) n`;
    await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_INVENTORY_TOO_LARGE');
    expect(await events()).toHaveLength(0);
    await expect(prisma.client.$executeRaw`DELETE FROM meter_inventory_seal`).rejects.toThrow(
      'SOURCE_SEAL_FIXED',
    );
    await owner.client.$executeRawUnsafe(`TRUNCATE "${schema}".asset_ref`);
    // Owner-only corruption probe: a missing singleton fails closed on both entry points.
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_inventory_seal DISABLE TRIGGER meter_inventory_seal_fixed`,
    );
    await owner.client.$executeRawUnsafe(`DELETE FROM "${schema}".meter_inventory_seal`);
    await expect(asset(id('AST'))).rejects.toThrow('SOURCE_FENCE_MISSING');
    await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_FENCE_MISSING');
  });
  it('rollback after enqueue retains neither seal nor audit and allows the next source write', async () => {
    const transaction = prisma.transaction.bind(prisma);
    const rollback = jest.spyOn(prisma, 'transaction').mockImplementationOnce((fn, options) =>
      transaction(async (tx) => {
        await fn(tx);
        expect(await tx.outboxMessage.count({ where: { aggregateId: runId } })).toBe(1);
        throw new Error('forced rollback');
      }, options),
    );
    try {
      await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_SEAL_UNCONFIRMED');
    } finally {
      rollback.mockRestore();
    }
    expect(await events()).toHaveLength(0);
    const [gate] = await prisma.client.$queryRaw<{ run_id: string | null }[]>`
      SELECT run_id FROM meter_inventory_seal WHERE id = true`;
    expect(gate.run_id).toBeNull();
    await asset(id('AST'));
  });
  it('never unseals: lost commit replays once; temp shadows, snapshot writes and gate mutation refuse', async () => {
    const transaction = prisma.transaction.bind(prisma);
    const lost = jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, options) => {
      await transaction(fn, options);
      throw new Error('lost commit');
    });
    await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_SEAL_UNCONFIRMED');
    lost.mockRestore();
    await Promise.all([command.seal(runId, actor), command.seal(runId, actor)]);
    expect(await events()).toHaveLength(1);
    await expect(prisma.client
      .$executeRaw`UPDATE meter_inventory_seal SET run_id = NULL, operator_id = NULL,
      inventory = NULL, boundary = NULL`).rejects.toThrow('SOURCE_SEAL_FIXED');
    await expect(
      owner.client.$executeRawUnsafe(`TRUNCATE "${schema}".meter_inventory_seal`),
    ).rejects.toThrow('SOURCE_SEAL_FIXED');
    await expect(
      owner.transaction(async (tx) => {
        await tx.$executeRaw`CREATE TEMP TABLE meter_inventory_seal(id boolean, inventory jsonb) ON COMMIT DROP`;
        await tx.$executeRaw`INSERT INTO pg_temp.meter_inventory_seal VALUES(true, NULL)`;
        await tx.$executeRaw`SELECT set_config('search_path', ${`pg_temp, "${schema}", public`}, true)`;
        await tx.$executeRaw`INSERT INTO asset_ref(id, organization_id, status, synced_at, source_event)
        VALUES (${id('AST')}, ${org.a}, 'ACTIVE', ${new Date()}, 'TEST')`;
      }),
    ).rejects.toThrow('SOURCE_INVENTORY_SEALED');
    await expect(
      prisma.client.$transaction(
        async (tx) => {
          await tx.$executeRaw`INSERT INTO asset_ref(id, organization_id, status, synced_at, source_event)
        VALUES (${id('AST')}, ${org.a}, 'ACTIVE', ${new Date()}, 'TEST')`;
        },
        { isolationLevel: 'RepeatableRead' },
      ),
    ).rejects.toThrow('SOURCE_FENCE_REQUIRES_READ_COMMITTED');
  });
});
