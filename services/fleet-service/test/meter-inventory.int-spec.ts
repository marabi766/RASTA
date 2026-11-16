import { dlqMessagesTotal, driftEvidenceOwnerChangesTotal } from '@rasta/observability';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetSyncRebalanceTimeoutMs, loadFleetEnv } from '../src/config/env';
import { SOURCE_REFUSAL_HISTORY_TRANSACTION } from '../src/config/source-evidence-policy';
import {
  persistSourceDriftHold,
  SourceDriftRefusal,
  SourceEvidenceUnconfirmedError,
} from '../src/fleet/drift-quarantine';
import { Prisma } from '../src/generated/prisma';
import { eligibilityClockWrite } from '@rasta/testing';
import { createHash, randomUUID } from 'node:crypto';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  UnprocessableEventError,
  EventHandlingUnconfirmedError,
} from '@rasta/nest-common';
import type { ProducerRecord } from 'kafkajs';
import { AssetSyncConsumer, CONSUMER_NAME } from '../src/consumers/asset-sync.consumer';
import { FleetMeterInventoryRefusal, FleetMeterInventorySeal } from '../src/fleet/meter-inventory';
import { FleetRepository } from '../src/fleet/fleet.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import {
  asActor,
  databaseUrl,
  id,
  ownerDatabaseUrl,
  tenants,
  waitFor,
  producerShaped,
} from './helpers';

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
      'meter_drift_overflow',
      'meter_drift_quarantine',
      'meter_drift_capacity',
      'meter_refusal_history',
      'processed_event',
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
    await owner.client.$executeRawUnsafe(`CREATE TRIGGER meter_drift_quarantine_guard
      BEFORE INSERT OR UPDATE OR DELETE ON "${schema}".meter_drift_quarantine
      FOR EACH ROW EXECUTE FUNCTION public.meter_drift_quarantine_guard()`);
    await owner.client
      .$executeRawUnsafe(`CREATE TRIGGER meter_drift_quarantine_no_truncate BEFORE TRUNCATE
      ON "${schema}".meter_drift_quarantine FOR EACH STATEMENT EXECUTE FUNCTION public.meter_drift_quarantine_guard()`);
    await owner.client.$executeRawUnsafe(`CREATE TRIGGER meter_drift_overflow_guard
      BEFORE INSERT OR UPDATE OR DELETE ON "${schema}".meter_drift_overflow
      FOR EACH ROW EXECUTE FUNCTION public.meter_drift_quarantine_guard()`);
    await owner.client.$executeRawUnsafe(`CREATE TRIGGER meter_drift_capacity_guard
      BEFORE UPDATE OR DELETE ON "${schema}".meter_drift_capacity
      FOR EACH ROW EXECUTE FUNCTION public.meter_drift_evidence_guard()`);
    await owner.client.$executeRawUnsafe(`CREATE TRIGGER meter_drift_capacity_no_truncate
      BEFORE TRUNCATE ON "${schema}".meter_drift_capacity
      FOR EACH STATEMENT EXECUTE FUNCTION public.meter_drift_evidence_guard()`);
    await owner.client.$executeRawUnsafe(
      `CREATE TRIGGER meter_drift_evidence_identity BEFORE INSERT ON "${schema}".meter_drift_quarantine FOR EACH ROW EXECUTE FUNCTION public.meter_drift_evidence_guard()`,
    );
    await owner.client.$executeRawUnsafe(`CREATE TRIGGER meter_activation_holder_guard
      BEFORE UPDATE ON "${schema}".meter_drift_capacity
      FOR EACH ROW EXECUTE FUNCTION public.meter_activation_holder_guard()`);
    await owner.client.$executeRawUnsafe(`CREATE TRIGGER meter_refusal_history_fixed
      BEFORE UPDATE OR DELETE ON "${schema}".meter_refusal_history
      FOR EACH ROW EXECUTE FUNCTION public.meter_refusal_history_fixed()`);
    await owner.client.$executeRawUnsafe(`CREATE TRIGGER meter_refusal_history_no_truncate
      BEFORE TRUNCATE ON "${schema}".meter_refusal_history
      FOR EACH STATEMENT EXECUTE FUNCTION public.meter_refusal_history_fixed()`);
    const role = decodeURIComponent(runtime.username).replaceAll('"', '""');
    await owner.client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await owner.client.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
    );
    prisma = new PrismaService(runtime.toString());
    command = new FleetMeterInventorySeal(prisma);
    await prisma.client.$executeRaw`INSERT INTO meter_drift_capacity(id) VALUES(true)`;
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
  async function waiter(fragment: string, finished = () => false) {
    await waitFor('source PostgreSQL lock waiter', async () => {
      const [row] = await prisma.client.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ${schema}
          AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}) AS waiting`;
      return finished() || row.waiting;
    });
  }
  async function assertHoldDownRefuses() {
    const down = readFileSync(
      join(__dirname, '../prisma/migrations/20261114150000_meter_drift_hold/down.sql'),
      'utf8',
    );
    const guard = down.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/)?.[0];
    if (!guard) throw new Error('hold rollback guard missing');
    await expect(
      owner.transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
        await tx.$executeRawUnsafe(guard);
      }),
    ).rejects.toThrow('ACTIVE_DRIFT_HOLD_ROLLBACK_REFUSED');
  }
  // Fixture transitions use the same transaction-local holder protocol as the authority.
  const setToken = (token: string | null) =>
    prisma.transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('rasta.meter_activation_token',
      COALESCE(${token}::uuid, activation_token)::text, true) FROM meter_drift_capacity FOR UPDATE`;
      await tx.$executeRaw`UPDATE meter_drift_capacity SET activation_token = ${token}::uuid`;
    });
  it.each(['arm', 'clear', 'replace', 'wrong-holder', 'latch-change', 'upsert-clear'])(
    'runtime raw token UPDATE refuses %s',
    async (mode) => {
      const token = randomUUID(),
        nextToken = randomUUID();
      if (mode !== 'arm') await setToken(token);
      // A completed holder transaction must not authorize another pooled transaction.
      const update = () =>
        prisma.transaction(async (tx) => {
          if (mode === 'upsert-clear') {
            await tx.$executeRaw`INSERT INTO meter_drift_capacity(id) VALUES(true)
              ON CONFLICT(id) DO UPDATE SET activation_token = NULL`;
            return;
          }
          if (mode === 'wrong-holder' || mode === 'replace' || mode === 'latch-change')
            await tx.$queryRaw`SELECT set_config('rasta.meter_activation_token',
          ${mode === 'wrong-holder' ? randomUUID() : mode === 'replace' ? nextToken : token}, true)`;
          await tx.$executeRaw`UPDATE meter_drift_capacity SET
        activation_token = ${mode === 'arm' || mode === 'replace' ? nextToken : null}::uuid,
        overflow_count = overflow_count + ${mode === 'latch-change' ? 1 : 0}`;
        });
      await expect(update()).rejects.toThrow('SOURCE_ACTIVATION_HOLDER_REQUIRED');
      expect(
        await prisma.client
          .$queryRaw`SELECT activation_token, overflow_count FROM meter_drift_capacity`,
      ).toEqual([{ activation_token: mode === 'arm' ? null : token, overflow_count: 0n }]);
    },
  );
  it('ambiguous holder stays durable, transaction-local and blocks guard rollback', async () => {
    const sealed = await command.seal(runId, actor);
    const url = new URL(runtime);
    url.searchParams.set('connection_limit', '1');
    const single = new PrismaService(url.toString());
    try {
      await expect(
        new FleetMeterInventorySeal(single).withQuarantineClear(
          runId,
          sealed.boundary,
          async () => {
            throw new Error('UNCONFIRMED');
          },
        ),
      ).rejects.toThrow('UNCONFIRMED');
      expect(
        await single.client
          .$queryRaw`SELECT NULLIF(current_setting('rasta.meter_activation_token', true), '') AS holder`,
      ).toEqual([{ holder: null }]);
      await expect(
        single.client.$executeRaw`UPDATE meter_drift_capacity SET activation_token = NULL`,
      ).rejects.toThrow('SOURCE_ACTIVATION_HOLDER_REQUIRED');
    } finally {
      await single.stop();
    }
    const down = readFileSync(
      join(__dirname, '../prisma/migrations/20261114180000_meter_activation_holder_guard/down.sql'),
      'utf8',
    );
    const guard = down.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/)?.[0];
    if (!guard) throw new Error('holder rollback guard missing');
    await expect(
      owner.transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
        await tx.$executeRawUnsafe(guard);
      }),
    ).rejects.toThrow('ACTIVE_DRIFT_EVIDENCE_ROLLBACK_REFUSED');
  });
  it('refusal history rollback refuses active rows; unreadable history prevents DLQ', async () => {
    await prisma.client.$executeRaw`INSERT INTO meter_refusal_history VALUES (${'a'.repeat(64)})`;
    for (const statement of ['DELETE FROM', 'UPDATE', 'TRUNCATE'])
      await expect(
        prisma.client.$executeRawUnsafe(
          statement === 'UPDATE'
            ? "UPDATE meter_refusal_history SET event_hash = repeat('b',64)"
            : `${statement} meter_refusal_history`,
        ),
      ).rejects.toThrow('SOURCE_REFUSAL_HISTORY_FIXED');
    const down = readFileSync(
      join(__dirname, '../prisma/migrations/20261115100000_meter_refusal_history/down.sql'),
      'utf8',
    );
    const guard = down.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/)?.[0];
    if (!guard) throw new Error('history rollback guard missing');
    await expect(
      owner.transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
        await tx.$executeRawUnsafe(guard);
      }),
    ).rejects.toThrow('ACTIVE_REFUSAL_HISTORY_ROLLBACK_REFUSED');
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_refusal_history RENAME TO unavailable_history`,
    );
    await expect(
      new FleetRepository(prisma).holdRefusedExhaustion(id('EVT'), undefined),
    ).rejects.toThrow();
  });
  it('HOLD namespace isolates real cause-named runs and counts concurrent later causes', async () => {
    await expect(prisma.client.$executeRaw`UPDATE meter_inventory_seal SET run_id = 'HOLD:fake:0',
      operator_id = 'USR', inventory = '[]'::jsonb, boundary = 'invalid'`).rejects.toThrow(
      'meter_seal_run_namespace',
    );
    const cause = 'SOURCE_REFUSAL_UNCONFIRMED';
    const sealed = await command.seal(cause, actor);
    const eventId = id('EVT');
    const hold = (later = false) =>
      persistSourceDriftHold(
        prisma.transaction.bind(prisma),
        eventId,
        undefined,
        later ? 'SOURCE_INFRASTRUCTURE_DURING_REFUSAL' : cause,
      );
    await hold();
    await Promise.all([hold(true), hold(), hold(true)]);
    expect(await prisma.client.$queryRaw`SELECT run_id FROM meter_drift_overflow`).toEqual([
      { run_id: 'HOLD:SOURCE_REFUSAL_UNCONFIRMED:3' },
    ]);
    expect(
      await prisma.client.$queryRaw`SELECT EXISTS(SELECT 1 FROM meter_drift_overflow
      WHERE run_id = ${cause}) AS collision`,
    ).toEqual([{ collision: false }]);
    await expect(command.seal('HOLD:SOURCE_REFUSAL_UNCONFIRMED:3', actor)).rejects.toThrow();
    await expect(
      command.withQuarantineClear(cause, sealed.boundary, async () => 'unsafe'),
    ).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
    await expect(prisma.client.$executeRaw`INSERT INTO meter_drift_overflow
      (event_id,asset_id,named_owner,reason,run_id) VALUES ('HOLD:OLD','AST','PLATFORM',
      'SOURCE_DRIFT_HOLD',${cause})`).rejects.toThrow('SOURCE_HOLD_CAUSE_INVALID');
    await expect(prisma.client.$executeRaw`UPDATE meter_drift_overflow
      SET run_id = 'HOLD:SOURCE_REFUSAL_UNCONFIRMED:4'`).rejects.toThrow(
      'SOURCE_DRIFT_QUARANTINE_FIXED',
    );
    const down = readFileSync(
      join(__dirname, '../prisma/migrations/20261116100000_meter_hold_cause_namespace/down.sql'),
      'utf8',
    );
    const guard = down.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/)?.[0];
    if (!guard) throw new Error('namespace rollback guard missing');
    await expect(
      owner.transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
        await tx.$executeRawUnsafe(guard);
      }),
    ).rejects.toThrow('ACTIVE_HOLD_CAUSE_ROLLBACK_REFUSED');
    // Owner fixture sets the maximum; the next occurrence must refuse without changing it.
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_overflow DISABLE TRIGGER meter_drift_overflow_guard`,
    );
    await prisma.client
      .$executeRaw`UPDATE meter_drift_overflow SET run_id = 'HOLD:SOURCE_REFUSAL_UNCONFIRMED:9223372036854775807'`;
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_overflow ENABLE TRIGGER meter_drift_overflow_guard`,
    );
    await expect(hold(true)).rejects.toThrow();
    expect(await prisma.client.$queryRaw`SELECT run_id FROM meter_drift_overflow`).toEqual([
      { run_id: 'HOLD:SOURCE_REFUSAL_UNCONFIRMED:9223372036854775807' },
    ]);
  });
  const namespaceMigration = readFileSync(
    join(__dirname, '../prisma/migrations/20261116100000_meter_hold_cause_namespace/migration.sql'),
    'utf8',
  );
  const namespacePrefix = namespaceMigration.slice(
    0,
    namespaceMigration.indexOf('CREATE OR REPLACE'),
  );
  // Execute the shipped preflight/backfill/constraints, retaining the DO block as one statement.
  type MigrationTx = Pick<ExtendedPrismaClient, '$executeRaw' | '$executeRawUnsafe'>;
  const applyNamespacePrefix = async (tx: MigrationTx) => {
    for (const sql of namespacePrefix.match(
      /DO \$\$[\s\S]*?END \$\$;|ALTER TABLE[\s\S]*?;|UPDATE meter_drift_overflow[\s\S]*?;/g,
    ) ?? [])
      await tx.$executeRawUnsafe(sql);
  };
  const beforeNamespace = async (seed: (tx: MigrationTx) => Promise<void>) => {
    await owner.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
      await tx.$executeRawUnsafe(
        'ALTER TABLE meter_inventory_seal DROP CONSTRAINT meter_seal_run_namespace',
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE meter_drift_overflow DROP CONSTRAINT meter_hold_cause_namespace',
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE meter_drift_overflow DISABLE TRIGGER meter_drift_overflow_guard',
      );
      await seed(tx);
    });
    return owner.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
      await applyNamespacePrefix(tx);
    });
  };
  it('HOLD namespace migration backfills legacy causes and preserves rolling-deploy rows on repeat', async () => {
    await beforeNamespace(async (tx) => {
      await tx.$executeRaw`INSERT INTO meter_drift_overflow (event_id,asset_id,named_owner,reason,run_id)
        SELECT cause, 'hash', 'PLATFORM', 'SOURCE_DRIFT_HOLD', cause
        FROM unnest(ARRAY['SOURCE_REFUSAL_UNCONFIRMED','SOURCE_INFRASTRUCTURE_DURING_REFUSAL',
          'HOLD:SOURCE_REFUSAL_UNCONFIRMED:7']) cause`;
    });
    await beforeNamespace(async () => {});
    expect(
      await prisma.client.$queryRaw`SELECT run_id FROM meter_drift_overflow ORDER BY run_id`,
    ).toEqual([
      { run_id: 'HOLD:SOURCE_INFRASTRUCTURE_DURING_REFUSAL:0' },
      { run_id: 'HOLD:SOURCE_REFUSAL_UNCONFIRMED:0' },
      { run_id: 'HOLD:SOURCE_REFUSAL_UNCONFIRMED:7' },
    ]);
  });
  it.each([
    'UNCONFIRMED',
    'HOLD:SOURCE_REFUSAL_UNCONFIRMED:bad',
    'HOLD:SOURCE_REFUSAL_UNCONFIRMED:9223372036854775808',
  ])('HOLD namespace preflight diagnoses incompatible retained evidence: %s', async (run) => {
    await expect(
      beforeNamespace(async (tx) => {
        await tx.$executeRaw`INSERT INTO meter_drift_overflow (event_id,asset_id,named_owner,reason,run_id)
          VALUES ('HOLD:OFFENDING', 'hash', 'PLATFORM', 'SOURCE_DRIFT_HOLD', ${run}),
            ('HOLD:OFFENDING2', 'hash', 'PLATFORM', 'SOURCE_DRIFT_HOLD', ${run})`;
      }),
    ).rejects.toThrow(
      /METER_HOLD_NAMESPACE_PREFLIGHT_REFUSED[\s\S]*HOLD:OFFENDING, HOLD:OFFENDING2[\s\S]*reconcile against audited source evidence/,
    );
    expect(
      await prisma.client
        .$queryRaw`SELECT event_id, run_id FROM meter_drift_overflow ORDER BY event_id`,
    ).toEqual([
      { event_id: 'HOLD:OFFENDING', run_id: run },
      { event_id: 'HOLD:OFFENDING2', run_id: run },
    ]);
  });
  it('HOLD namespace preflight names the incompatible immutable seal and operator action', async () => {
    await expect(
      beforeNamespace(async (tx) => {
        await tx.$executeRaw`UPDATE meter_inventory_seal SET run_id = 'outside:grammar',
        operator_id = 'USR', inventory = '[]'::jsonb, boundary = 'invalid'`;
      }),
    ).rejects.toThrow(
      /METER_SEAL_NAMESPACE_PREFLIGHT_REFUSED[\s\S]*id=true[\s\S]*reconcile against audited source evidence/,
    );
    expect(await prisma.client.$queryRaw`SELECT run_id FROM meter_inventory_seal`).toEqual([
      { run_id: 'outside:grammar' },
    ]);
  });
  it.each([
    'garbage',
    'HOLD:SOURCE_REFUSAL_UNCONFIRMED:bad',
    'HOLD:SOURCE_REFUSAL_UNCONFIRMED:9223372036854775808',
  ])(
    'HOLD namespace malformed casts use the constraint and runtime guard errors: %s',
    async (run) => {
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".meter_drift_overflow DISABLE TRIGGER meter_drift_overflow_guard`,
      );
      await expect(prisma.client.$executeRaw`INSERT INTO meter_drift_overflow
        (event_id,asset_id,named_owner,reason,run_id) VALUES ('BAD', 'hash', 'PLATFORM', 'SOURCE_DRIFT_HOLD', ${run})`).rejects.toThrow(
        'meter_hold_cause_namespace',
      );
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".meter_drift_overflow ENABLE TRIGGER meter_drift_overflow_guard`,
      );
      await persistSourceDriftHold(
        prisma.transaction.bind(prisma),
        'EVT:CAST',
        undefined,
        'SOURCE_REFUSAL_UNCONFIRMED',
      );
      await expect(
        prisma.client.$executeRaw`UPDATE meter_drift_overflow SET run_id = ${run}`,
      ).rejects.toThrow('SOURCE_DRIFT_QUARANTINE_FIXED');
      // Force the depth-2 path with otherwise-identical row identity and cause.
      await owner.client.$executeRawUnsafe(`CREATE TABLE "${schema}".hold_cast_probe(run_id text)`);
      await owner.client
        .$executeRawUnsafe(`CREATE FUNCTION "${schema}".hold_cast_probe() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          UPDATE "${schema}".meter_drift_overflow SET run_id = NEW.run_id;
          RETURN NEW;
        END $$`);
      await owner.client
        .$executeRawUnsafe(`CREATE TRIGGER hold_cast_probe AFTER INSERT ON "${schema}".hold_cast_probe
        FOR EACH ROW EXECUTE FUNCTION "${schema}".hold_cast_probe()`);
      await expect(
        owner.client.$executeRawUnsafe(`INSERT INTO "${schema}".hold_cast_probe VALUES ($1)`, run),
      ).rejects.toThrow('SOURCE_DRIFT_QUARANTINE_FIXED');
      await expect(prisma.client.$executeRaw`INSERT INTO meter_drift_overflow
        (event_id,asset_id,named_owner,reason,run_id) VALUES ('BAD', 'hash', 'PLATFORM', 'SOURCE_DRIFT_HOLD', ${run})`).rejects.toThrow(
        'SOURCE_HOLD_CAUSE_INVALID',
      );
    },
  );
  it.each(['seal-lock', 'missing-gate', 'malformed', 'history-failed'])(
    'evidence HOLD preserves envelope identity and original cause: %s',
    async (mode) => {
      const repository = new FleetRepository(prisma),
        eventId = id('EVT');
      const held = latch(),
        release = latch();
      const holder =
        mode === 'seal-lock'
          ? prisma.transaction(async (tx) => {
              await tx.$queryRaw`SELECT id FROM meter_inventory_seal FOR UPDATE`;
              held.release();
              await release.ready;
            })
          : undefined;
      if (holder) await held.ready;
      else {
        await owner.client.$executeRawUnsafe(
          `ALTER TABLE "${schema}".meter_inventory_seal DISABLE TRIGGER meter_inventory_seal_fixed`,
        );
        await prisma.client.$executeRaw`DELETE FROM meter_inventory_seal`;
      }
      if (mode === 'history-failed')
        await owner.client.$executeRawUnsafe(
          `ALTER TABLE "${schema}".meter_refusal_history RENAME TO unavailable_history`,
        );
      const payload = mode === 'malformed' ? { assetId: 42 } : { assetId: 'AST_ENVELOPE' };
      try {
        const attempt =
          mode === 'malformed'
            ? repository.transaction(async () => undefined, undefined, eventId, undefined, payload)
            : new AssetSyncConsumer(null, repository).handle({
                eventId,
                eventName: 'ASSET_UPDATED',
                eventVersion: 1,
                producer: 'asset-service',
                producerVersion: 'test',
                tenantId: org.b,
                aggregateId: 'AST_OTHER',
                aggregateType: 'Asset',
                occurredAt: new Date().toISOString(),
                correlationId: id('COR'),
                payload,
              });
        const error = await attempt.catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(SourceEvidenceUnconfirmedError);
        const failure = error as SourceEvidenceUnconfirmedError;
        expect((failure.cause as Error).message).toBe(mode === 'seal-lock' ? 'P2010' : 'unknown');
        expect(failure.historyWriteFailure?.message).toBe(
          mode === 'history-failed' ? 'P2010' : undefined,
        );
        await failure.evidencePolicy!.persist(failure);
        if (mode !== 'history-failed')
          await repository.holdRefusedExhaustion(eventId, 'AST_ENVELOPE');
        expect(await prisma.client.$queryRaw`SELECT asset_id FROM meter_drift_overflow`).toEqual([
          {
            asset_id: createHash('sha256')
              .update(mode === 'malformed' ? eventId : 'AST_ENVELOPE')
              .digest('hex'),
          },
        ]);
      } finally {
        release.release();
        await holder;
      }
    },
  );
  const events = () => prisma.client.outboxMessage.findMany({ where: { aggregateId: runId } });
  it.each([
    'token',
    'spent-budget',
    'token-clears',
    'seal-lock',
    'oversized',
    'missing-gate',
    'evidence-failed',
    'redelivery',
  ])('transport keeps fleet evidence before DLQ after activation backoff: %s', async (mode) => {
    const sealed = await command.seal(runId, actor),
      repository = new FleetRepository(prisma);
    const eventId = mode === 'oversized' ? 'E'.repeat(300) : id('EVT');
    const event: EventEnvelope = {
      eventId,
      eventName: 'ASSET_CREATED',
      eventVersion: 1,
      tenantId: org.b,
      producer: 'asset-service',
      producerVersion: 'test',
      occurredAt: new Date().toISOString(),
      aggregateId: 'AST_NEW',
      aggregateType: 'Asset',
      correlationId: id('COR'),
      payload: { assetId: 'AST_NEW' },
    };
    const entered = latch(),
      finish = latch();
    let activation: Promise<string> | undefined;
    if (mode === 'seal-lock') {
      activation = command.withQuarantineClear(runId, sealed.boundary, async () => {
        entered.release();
        await finish.ready;
        return 'active';
      });
      await entered.ready;
    }
    if (['token', 'spent-budget', 'token-clears', 'evidence-failed', 'redelivery'].includes(mode))
      await setToken(randomUUID());
    if (mode === 'missing-gate') {
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".meter_inventory_seal DISABLE TRIGGER meter_inventory_seal_fixed`,
      );
      await prisma.client.$executeRaw`DELETE FROM meter_inventory_seal`;
    }
    if (mode === 'evidence-failed')
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".meter_drift_overflow ADD CHECK(reason <> 'SOURCE_DRIFT_HOLD')`,
      );
    const beat = jest.fn().mockResolvedValue(undefined);
    let calls = 0;
    let redelivered = false;
    const transport = new EventConsumer(
      {
        brokers: ['localhost:9092'],
        clientId: 'hold-test',
        rebalanceTimeoutMs: assetSyncRebalanceTimeoutMs(
          loadFleetEnv({
            NODE_ENV: 'test',
            DATABASE_URL: runtime.toString(),
            KAFKA_BROKERS: 'localhost:9092',
            REDIS_URL: 'redis://localhost:6379',
            OIDC_ISSUER_URL: 'http://localhost:8080',
            OIDC_JWKS_URI: 'http://localhost:8080/certs',
            OIDC_AUDIENCE: 'test',
            INTERNAL_TOKEN_SECRET: 'x'.repeat(48),
            ASSET_SERVICE_URL: 'http://localhost:3103',
            MAINTENANCE_SERVICE_URL: 'http://localhost:3105',
            IDENTITY_SERVICE_URL: 'http://localhost:3101',
          }),
        ),
        groupId: 'hold-test',
        topics: ['rasta.asset.v1'],
        deadLetterTopic: 'rasta.fleet.v1.dlq',
        maxRetries: 3,
        retryBackoffMs: 0,
        beforeExhaustion: (event) =>
          repository.holdRefusedExhaustion(
            event.eventId,
            mode === 'redelivery' ? event.aggregateId : undefined,
          ),
      },
      () => {
        if (redelivered) throw new Error('ordinary infrastructure');
        if (mode === 'spent-budget' && ++calls <= 2) throw new Error('TEST_PRE_GATE');
        return repository.transaction(
          async (tx) => {
            await repository.markEventProcessed(tx, eventId, 'hold-test');
            await repository.upsertAssetRef(tx, {
              id: event.aggregateId,
              organizationId: org.b,
              sourceEvent: 'TEST',
            });
          },
          undefined,
          eventId,
          undefined,
          event.payload,
        );
      },
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );
    expect(
      (transport as unknown as { options: { rebalanceTimeoutMs: number } }).options
        .rebalanceTimeoutMs,
    ).toBe(300_000);
    const dispatch = transport as unknown as {
      dlqProducer: { send: jest.Mock };
      pause(run: unknown, ms: number): Promise<void>;
      handleMessage(
        topic: string,
        partition: number,
        value: Buffer,
        headers: undefined,
        offset: undefined,
        key: null,
        heartbeat: () => Promise<void>,
      ): Promise<void>;
    };
    const send = jest.fn().mockResolvedValue(undefined);
    dispatch.dlqProducer = { send };
    const pause = jest.spyOn(dispatch, 'pause').mockImplementation(async () => {
      if (mode === 'redelivery' && !redelivered) throw new Error('rebalance');
      if (mode === 'token-clears' && pause.mock.calls.length === 7) await setToken(null);
      if (activation) {
        finish.release();
        await activation;
      }
    });
    const deliver = () =>
      dispatch.handleMessage(
        'rasta.asset.v1',
        0,
        Buffer.from(JSON.stringify(event)),
        undefined,
        undefined,
        null,
        beat,
      );
    try {
      if (mode === 'redelivery') {
        await expect(deliver()).rejects.toThrow('rebalance');
        expect(send).not.toHaveBeenCalled();
        expect(
          await prisma.client.$queryRaw`SELECT count(*)::int AS n FROM meter_refusal_history`,
        ).toEqual([{ n: 1 }]);
        await setToken(null);
        redelivered = true; // handleMessage starts with a fresh in-memory policy.
      }
      if (mode === 'evidence-failed') {
        await expect(deliver()).rejects.toThrow();
        expect(send).not.toHaveBeenCalled();
      } else {
        send.mockImplementationOnce(async () => {
          if (mode === 'missing-gate') expect(beat).toHaveBeenCalledTimes(18);
          if (mode === 'spent-budget')
            expect(pause.mock.calls.filter((call) => call[1] >= 10_000)).toHaveLength(7);
          const rows = await prisma.client.$queryRaw<{ n: number }[]>`
              SELECT ((SELECT count(*) FROM meter_drift_quarantine) + (SELECT count(*) FROM meter_drift_overflow))::int AS n`;
          expect(rows).toEqual([{ n: 1 }]);
          throw new Error('lost DLQ publish');
        });
        await expect(deliver()).rejects.toThrow('lost DLQ publish');
        await Promise.all([deliver(), deliver()]);
        expect(send).toHaveBeenCalledTimes(3);
        expect(
          await prisma.client.$queryRaw`SELECT overflow_count FROM meter_drift_capacity`,
        ).toEqual([{ overflow_count: ['seal-lock', 'token-clears'].includes(mode) ? 0n : 1n }]);
        if (['token', 'redelivery', 'missing-gate'].includes(mode)) {
          expect(await prisma.client.$queryRaw`SELECT asset_id FROM meter_drift_overflow`).toEqual([
            {
              asset_id: createHash('sha256').update(event.aggregateId).digest('hex'),
            },
          ]);
        }
        if (mode === 'token') {
          await assertHoldDownRefuses();
        }
      }
      expect(await prisma.client.$queryRaw`SELECT * FROM processed_event`).toEqual([]);
      expect(await prisma.client.$queryRaw`SELECT * FROM asset_ref`).toEqual([]);
      if (mode === 'seal-lock') expect(pause.mock.calls[0][1]).toBeGreaterThanOrEqual(10_000);
      else if (mode !== 'redelivery')
        expect(
          pause.mock.calls.slice(0, 7).reduce((sum, call) => sum + call[1], 0),
        ).toBeGreaterThan(35_000);
    } finally {
      finish.release();
      await activation;
    }
  });
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
      // Includes the historical (ids[0], B) usage row.
      await expect(
        prisma.client.$executeRawUnsafe(`UPDATE "${table}" SET organization_id = organization_id`),
      ).resolves.toBeGreaterThan(0);
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
    await expect(prisma.client.$executeRaw`UPDATE usage_record SET hours = 2
      WHERE asset_id = ${currentId} AND organization_id = ${org.b}`).resolves.toBe(1);
    // Keep the owner fixed but change the asset to an inventoried asset owned by A.
    await expect(prisma.client.$executeRaw`UPDATE usage_record SET asset_id = ${ids[2]}
      WHERE asset_id = ${currentId} AND organization_id = ${org.b}`).rejects.toThrow(
      'SOURCE_OWNER_DRIFT',
    );
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
  describe('terminal consumer refusals', () => {
    it.each(
      ['transfer', 'creation', 'creation-refresh', 'refresh', 'insurance-park']
        .flatMap((path) => [false, true].map((known) => ({ path, known })))
        .concat([{ path: 'insurance-park-current', known: true }]),
    )(
      '$path known=$known refuses once per delivery with its exact DLQ reason',
      async ({ path, known }) => {
        const assetId = id('AST');
        const orphan = path === 'creation' || path === 'insurance-park';
        if (known) {
          if (orphan)
            await prisma.client.$executeRaw`INSERT INTO usage_record(id, asset_id,
          organization_id, period_start, period_end, hours, recorded_by)
          VALUES (${id('USG')}, ${assetId}, ${org.a}, '2026-01-01', '2026-01-02', 1, 'TEST')`;
          else await asset(assetId);
        }
        await command.seal(runId, actor);
        const repository = new FleetRepository(prisma);
        const consumer = new AssetSyncConsumer(
          null,
          repository,
          {
            snapshot: async () => ({
              assetId,
              organizationId: org.b,
              status: 'ACTIVE',
              name: 'TEST',
              type: 'GRADER',
              assetTag: null,
              transferGeneration: 1,
              viaTransfer: true,
            }),
          },
          undefined,
          undefined,
          { verify: async () => ({ counts: false, reason: 'NOT_CURRENT_OWNER' }) },
        );
        const eventName = path.startsWith('insurance-park')
          ? 'INSURANCE_RECORDED'
          : path === 'transfer'
            ? 'ASSET_TRANSFERRED'
            : path === 'refresh'
              ? 'ASSET_UPDATED'
              : 'ASSET_CREATED';
        // Refresh always uses .retry; creation-refresh also refreshes an existing row on the original.
        const topic = path === 'refresh' ? 'rasta.asset.v1.retry' : 'rasta.asset.v1';
        const envelope: EventEnvelope = {
          eventId: id('EVT'),
          eventName,
          eventVersion: 1,
          occurredAt: new Date().toISOString(),
          producer: 'asset-service',
          producerVersion: '0.1.0',
          aggregateType: 'Asset',
          aggregateId: assetId,
          tenantId: org.b,
          correlationId: id('COR'),
          payload: producerShaped(eventName, {
            assetId,
            organizationId: org.b,
            ...(eventName === 'INSURANCE_RECORDED'
              ? {
                  policyId: id('INS'),
                  insurerName: 'TEST',
                  coverage: 'COMPREHENSIVE',
                  validFrom: '2026-01-01T00:00:00.000Z',
                  validTo: '2027-01-01T00:00:00.000Z',
                  ownershipGeneration: 1,
                }
              : {}),
            ...(eventName === 'ASSET_UPDATED' ? { updatedFields: ['status'] } : {}),
            ...(eventName === 'ASSET_CREATED' ? { status: 'REGISTERED' } : {}),
            ...(eventName === 'ASSET_TRANSFERRED'
              ? {
                  fromOrganizationId: org.a,
                  toOrganizationId: org.b,
                  reason: 'TEST',
                  referenceNo: null,
                  transferredAt: new Date().toISOString(),
                  ownershipGeneration: 1,
                }
              : {}),
          }),
        };
        const reason = known ? DLQ_REASONS.SOURCE_OWNER_DRIFT : DLQ_REASONS.SOURCE_INVENTORY_SEALED;
        const sent: ProducerRecord[] = [],
          refused: unknown[] = [];
        const transaction = jest.spyOn(repository, 'transaction');
        // Real transport dispatch/retry/DLQ logic; only the broker send is captured locally.
        const transport = new EventConsumer(
          {
            brokers: ['localhost:9092'],
            clientId: 'fleet-drift-test',
            groupId: 'fleet-drift-test',
            topics: ['rasta.asset.v1'],
            deadLetterTopic: 'rasta.fleet.v1.dlq',
            maxRetries: 3,
            retryBackoffMs: 0,
          },
          async (event, delivery) => {
            try {
              await consumer.handle(event, delivery);
            } catch (error) {
              refused.push(error);
              throw error;
            }
          },
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        );
        jest
          .spyOn(
            transport as unknown as { pause(run: unknown, ms: number): Promise<void> },
            'pause',
          )
          .mockResolvedValue(undefined);
        const dispatch = transport as unknown as {
          dlqProducer: { send(record: ProducerRecord): Promise<void> };
          handleMessage(
            topic: string,
            partition: number,
            value: Buffer,
            headers: undefined,
          ): Promise<void>;
        };
        dispatch.dlqProducer = {
          send: async (record) => {
            sent.push(record);
          },
        };
        const snapshot = () =>
          Promise.all(
            sources.map((table) =>
              prisma.client.$queryRawUnsafe(
                `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
              ),
            ),
          );
        const before = await snapshot();
        await owner.client.$executeRawUnsafe(
          `ALTER TABLE "${schema}".meter_drift_quarantine RENAME TO unavailable_quarantine`,
        );
        try {
          await dispatch.handleMessage(topic, 0, Buffer.from(JSON.stringify(envelope)), undefined);
          expect(sent).toHaveLength(1);
          expect(sent[0].messages[0].headers).toMatchObject({
            'x-dlq-reason': 'MAX_RETRIES_EXCEEDED',
            'x-dlq-attempts': '8',
          });
          sent.length = 0;
          expect(await snapshot()).toEqual(before);
        } finally {
          await owner.client.$executeRawUnsafe(
            `ALTER TABLE "${schema}".unavailable_quarantine RENAME TO meter_drift_quarantine`,
          );
        }
        transaction.mockClear();
        refused.length = 0;
        await dispatch.handleMessage(topic, 0, Buffer.from(JSON.stringify(envelope)), undefined);
        expect(transaction).toHaveBeenCalledTimes(1);
        expect(refused[0]).toMatchObject({ reason, message: reason });
        expect(refused[0]).toBeInstanceOf(UnprocessableEventError);
        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('rasta.fleet.v1.dlq');
        expect(sent[0].messages[0].headers).toMatchObject({
          'x-dlq-reason': reason,
          'x-dlq-attempts': '1',
        });
        expect(sent[0].messages[0].value).toEqual(Buffer.from(JSON.stringify(envelope)));
        expect(String(sent[0].messages[0].headers?.['x-dlq-error'])).not.toContain(org.a);
        // Concurrent redelivery and explicit .retry refresh both meet the immutable fence again.
        await Promise.all(
          [topic, 'rasta.asset.v1.retry'].map((replayTopic) =>
            dispatch.handleMessage(
              replayTopic,
              0,
              Buffer.from(JSON.stringify(envelope)),
              undefined,
            ),
          ),
        );
        expect(transaction).toHaveBeenCalledTimes(3);
        expect(refused).toHaveLength(3);
        expect(sent).toHaveLength(3);
        for (const record of sent)
          expect(record.messages[0].headers).toMatchObject({
            'x-dlq-reason': reason,
            'x-dlq-attempts': '1',
          });
        expect(await snapshot()).toEqual(before);
        const evidence = await prisma.client.$queryRaw`SELECT * FROM meter_drift_quarantine`;
        expect(evidence).toEqual([
          expect.objectContaining({
            event_id: envelope.eventId,
            asset_id: assetId,
            sealed_owner: known ? org.a : null,
            named_owner: org.b,
            reason,
            run_id: runId,
            first_seen_at: expect.any(Date),
          }),
        ]);
        await expect(
          command.withQuarantineClear(
            runId,
            (await command.seal(runId, actor)).boundary,
            async () => 'activated',
          ),
        ).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
        expect(await prisma.client.$queryRaw`SELECT * FROM processed_event`).toEqual([]);
        expect(await prisma.client.outboxMessage.count()).toBe(1); // only the pre-existing seal audit
        expect(
          await asActor({ organizationId: org.b }, () => repository.findAssetRef(org.b, assetId)),
        ).toBeNull();
      },
    );
  });
  it('refuses missing, wrong-run, stale, unreadable and stale-snapshot clearance', async () => {
    const sealed = await command.seal(runId, actor),
      commit = jest.fn(async () => 'active');
    const stale = await command.withQuarantineClear(runId, sealed.boundary, async (proof) => proof);
    await expect(stale.assertHeld()).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
    await expect(
      command.withQuarantineClear('OTHER', sealed.boundary, commit),
    ).rejects.toMatchObject({
      code: 'SOURCE_DRIFT_QUARANTINED',
    });
    await expect(command.withQuarantineClear(runId, 'STALE', commit)).rejects.toThrow(
      'SOURCE_DRIFT_QUARANTINED',
    );
    await expect(
      asActor({ organizationId: org.b }, () =>
        command.withQuarantineClear(runId, sealed.boundary, commit),
      ),
    ).rejects.toThrow('OPERATOR_CONTEXT_REQUIRED');
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_capacity DISABLE TRIGGER meter_drift_capacity_guard`,
    );
    await owner.client.$executeRawUnsafe(`DELETE FROM "${schema}".meter_drift_capacity`);
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_capacity ENABLE TRIGGER meter_drift_capacity_guard`,
    );
    await expect(command.withQuarantineClear(runId, sealed.boundary, commit)).rejects.toThrow(
      'SOURCE_DRIFT_QUARANTINED',
    );
    await expect(prisma.client
      .$executeRaw`INSERT INTO meter_drift_quarantine(event_id, asset_id, named_owner, reason, run_id)
      VALUES ('MISSING_CAP', 'AST', ${org.b}, 'SOURCE_INVENTORY_SEALED', ${runId})`).rejects.toThrow(
      'SOURCE_DRIFT_CAPACITY_MISSING',
    );
    await prisma.client.$executeRaw`INSERT INTO meter_drift_capacity(id) VALUES(true)`;
    await expect(prisma.client
      .$executeRaw`INSERT INTO meter_drift_quarantine(event_id, asset_id, named_owner, reason, run_id)
      VALUES ('OVERSIZE', 'AST', ${'x'.repeat(257)}, 'SOURCE_INVENTORY_SEALED', ${runId})`).rejects.toThrow(
      'source_drift_evidence_size',
    );
    await expect(prisma.client
      .$executeRaw`INSERT INTO meter_drift_quarantine(event_id, asset_id, named_owner, reason, run_id)
      VALUES ('WRONG_RUN', 'AST', ${org.b}, 'SOURCE_INVENTORY_SEALED', 'OTHER')`).rejects.toThrow(
      'SOURCE_DRIFT_RUN_INVALID',
    );
    await expect(
      prisma.client.$transaction(
        (
          tx,
        ) => tx.$executeRaw`INSERT INTO meter_drift_quarantine(event_id, asset_id, named_owner, reason, run_id)
      VALUES ('STALE', 'AST', ${org.b}, 'SOURCE_INVENTORY_SEALED', ${runId})`,
        { isolationLevel: 'RepeatableRead' },
      ),
    ).rejects.toThrow('SOURCE_DRIFT_REQUIRES_READ_COMMITTED');
    const snapshot = jest.spyOn(prisma, 'transaction').mockImplementationOnce((fn) =>
      prisma.client.$transaction((tx) => fn(tx as ExtendedPrismaClient), {
        isolationLevel: 'RepeatableRead',
      }),
    );
    try {
      await expect(command.withQuarantineClear(runId, sealed.boundary, commit)).rejects.toThrow(
        'SOURCE_DRIFT_QUARANTINED',
      );
    } finally {
      snapshot.mockRestore();
    }
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_quarantine RENAME TO unavailable_quarantine`,
    );
    try {
      await expect(command.withQuarantineClear(runId, sealed.boundary, commit)).rejects.toThrow();
    } finally {
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".unavailable_quarantine RENAME TO meter_drift_quarantine`,
      );
    }
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_inventory_seal DISABLE TRIGGER meter_inventory_seal_fixed`,
    );
    await owner.client.$executeRawUnsafe(`DELETE FROM "${schema}".meter_inventory_seal`);
    await expect(command.withQuarantineClear(runId, sealed.boundary, commit)).rejects.toThrow(
      'SOURCE_DRIFT_QUARANTINED',
    );
    expect(commit).not.toHaveBeenCalled();
  });
  it.each(['event-first', 'activation-first'])(
    'serializes quarantine and activation: %s',
    async (order) => {
      const assetId = id('AST'),
        eventId = id('EVT');
      await asset(assetId);
      const sealed = await command.seal(runId, actor);
      const repository = new FleetRepository(prisma);
      const entered = latch(),
        finish = latch();
      let activated = false;
      const event = () =>
        repository.transaction(
          async (tx) => {
            if (order === 'event-first') {
              entered.release();
              await finish.ready;
            }
            await repository.markEventProcessed(tx, eventId, 'quarantine-race');
            await repository.upsertAssetRef(tx, {
              id: assetId,
              organizationId: org.b,
              sourceEvent: 'TEST',
            });
          },
          { timeoutMs: 30_000 },
          eventId,
        );
      const activate = () =>
        command.withQuarantineClear(runId, sealed.boundary, async (proof) => {
          expect(proof).toEqual({
            runId,
            boundary: sealed.boundary,
            clear: true,
            assertHeld: expect.any(Function),
          });
          entered.release();
          await finish.ready;
          activated = true;
          return 'active';
        });
      const first = order === 'event-first' ? event() : activate();
      // Attach rejection handling immediately, before waiting for the contender.
      const firstResult = first.then(
        () => 'ok',
        (error: unknown) => error,
      );
      await entered.ready;
      const secondResult = (order === 'event-first' ? activate() : event()).then(
        () => 'ok',
        (error: unknown) => error,
      );
      try {
        if (order === 'event-first') await waiter('FOR UPDATE');
        else expect(await secondResult).toBeInstanceOf(EventHandlingUnconfirmedError);
      } finally {
        finish.release();
        await Promise.allSettled([firstResult, secondResult]);
      }
      const results = await Promise.all([firstResult, secondResult]);
      if (order === 'activation-first') results[1] = await event().catch((error: unknown) => error);
      expect(results[order === 'event-first' ? 0 : 1]).toBeInstanceOf(UnprocessableEventError);
      if (order === 'event-first')
        expect(results[1]).toEqual(new FleetMeterInventoryRefusal('SOURCE_DRIFT_QUARANTINED'));
      expect(activated).toBe(order === 'activation-first');
      expect(await prisma.client.$queryRaw`SELECT * FROM processed_event`).toEqual([]);
      expect(await prisma.client.$queryRaw`SELECT event_id FROM meter_drift_quarantine`).toEqual([
        { event_id: eventId },
      ]);
    },
  );
  it.each(['before-callback', 'definite-refusal', 'sync-refusal', 'uncertain'])(
    'releases only proven-unused activation tokens: %s',
    async (mode) => {
      const sealed = await command.seal(runId, actor);
      const transaction = prisma.transaction.bind(prisma);
      const refusal = new Error('DEFINITE_REFUSAL');
      const callback = jest.fn(() => {
        if (mode === 'sync-refusal') throw refusal;
        return Promise.reject(refusal);
      });
      let calls = 0;
      const spy = jest.spyOn(prisma, 'transaction').mockImplementation((fn, options) => {
        if (++calls === 2 && mode === 'before-callback')
          return Promise.reject(new Error('pool wait'));
        return transaction(fn, options);
      });
      try {
        await expect(
          command.withQuarantineClear(
            runId,
            sealed.boundary,
            callback,
            (error) => ['definite-refusal', 'sync-refusal'].includes(mode) && error === refusal,
          ),
        ).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
      expect(callback).toHaveBeenCalledTimes(mode === 'before-callback' ? 0 : 1);
      const [row] = await prisma.client.$queryRaw<{ activation_token: string | null }[]>`
        SELECT activation_token FROM meter_drift_capacity`;
      if (mode === 'uncertain') expect(row.activation_token).not.toBeNull();
      else {
        expect(row.activation_token).toBeNull();
        expect(await command.withQuarantineClear(runId, sealed.boundary, async () => 'ok')).toBe(
          'ok',
        );
      }
    },
  );
  it('advances 50 failing decisions and decides another tenant, then exhausts them', async () => {
    const repository = new FleetRepository(prisma);
    const healthy = id('AST');
    const events = Array.from({ length: 51 }, (_, n) => ({
      eventId: `EVT_LIVENESS_${String(n).padStart(3, '0')}`,
      assetId: n === 50 ? healthy : id('AST'),
      organizationId: n === 50 ? org.b : org.a,
    }));
    for (const row of events) {
      const envelope: EventEnvelope = {
        eventId: row.eventId,
        eventName: 'INSURANCE_RECORDED',
        eventVersion: 1,
        tenantId: row.organizationId,
        producer: 'asset-service',
        producerVersion: '0.1.0',
        occurredAt: '2026-01-01T00:00:00.000Z',
        correlationId: id('COR'),
        aggregateType: 'Asset',
        aggregateId: row.assetId,
        payload: producerShaped('INSURANCE_RECORDED', {
          assetId: row.assetId,
          organizationId: row.organizationId,
          policyId: id('INS'),
          insurerName: 'TEST',
          coverage: 'COMPREHENSIVE',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: '2027-01-01T00:00:00.000Z',
          ownershipGeneration: 1,
        }),
      };
      await eligibilityClockWrite(prisma.client)`INSERT INTO insurance_pending_verification
        (event_id, asset_id, organization_id, envelope, source_topic, reason, next_attempt_at)
        VALUES (${row.eventId}, ${row.assetId}, ${row.organizationId}, ${JSON.stringify(envelope)}::jsonb, 'TEST', 'NO_ANSWER', now() - interval '1 second')`;
    }
    const verify = jest.fn(async (organizationId: string) => ({
      counts: true as const,
      organizationId,
      coverage: 'COMPREHENSIVE',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z',
      ownershipGeneration: 1,
    }));
    const consumer = new AssetSyncConsumer(
      null,
      repository,
      undefined,
      undefined,
      undefined,
      { verify },
      { minAgeSeconds: 300, maxAttempts: 2, batchSize: 50, sweepIntervalMs: 60000 },
    );
    const upsert = repository.upsertAssetRef.bind(repository);
    const fail = jest.spyOn(repository, 'upsertAssetRef').mockImplementation((tx, data) =>
      data.id === healthy
        ? upsert(tx, data)
        : tx.$executeRaw`SELECT 1/0`.then(() => {
            throw new Error('unreachable');
          }),
    );
    try {
      await consumer.sweepParked();
      expect(
        await prisma.client
          .$queryRaw`SELECT count(*)::int AS n FROM insurance_pending_verification WHERE attempts = 1`,
      ).toEqual([{ n: 50 }]);
      // Transfers can keep failing rows explicitly due: ordering must still admit the untouched tenant.
      await eligibilityClockWrite(prisma.client)`UPDATE insurance_pending_verification
        SET next_attempt_at = now() - interval '1 second'
        WHERE event_id = ANY(${events.map((row) => row.eventId)}::text[])`;
      expect(await consumer.sweepParked()).toMatchObject({ APPLIED: 1, DEAD_LETTERED: 49 });
      expect(await consumer.sweepParked()).toMatchObject({ DEAD_LETTERED: 1 });
      expect(await prisma.client.$queryRaw`SELECT * FROM insurance_pending_verification`).toEqual(
        [],
      );
      expect(await prisma.client.assetRef.findUnique({ where: { id: healthy } })).toMatchObject({
        organizationId: org.b,
      });
      expect(
        await prisma.client
          .$queryRaw`SELECT count(*)::int AS n FROM outbox_message WHERE headers->>'x-dlq-reason' = 'PARKED_VERIFICATION_EXHAUSTED'`,
      ).toEqual([{ n: 50 }]);
    } finally {
      fail.mockRestore();
    }
  });
  it('keeps the activation barrier durable after its live transaction expires', async () => {
    const sealed = await command.seal(runId, actor),
      entered = latch(),
      finish = latch();
    const transaction = prisma.transaction.bind(prisma);
    let calls = 0;
    const expire = jest
      .spyOn(prisma, 'transaction')
      .mockImplementation((fn, options) =>
        transaction(fn, ++calls === 2 ? { ...options, timeoutMs: 100 } : options),
      );
    const proof = command.withQuarantineClear(runId, sealed.boundary, async () => {
      entered.release();
      await finish.ready;
      return 'active';
    });
    const result = proof.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.ready;
      const repository = new FleetRepository(prisma);
      await expect(
        repository.transaction(
          (tx) =>
            repository.upsertAssetRef(tx, {
              id: 'AST_UNKNOWN',
              organizationId: org.b,
              sourceEvent: 'TEST',
            }),
          undefined,
          id('EVT'),
        ),
      ).rejects.toBeInstanceOf(EventHandlingUnconfirmedError);
      expect(await prisma.client.$queryRaw`SELECT * FROM meter_drift_quarantine`).toEqual([]);
      await expect(prisma.client
        .$executeRaw`INSERT INTO meter_drift_quarantine(event_id, asset_id, named_owner, reason, run_id)
        VALUES ('HELD', 'AST', ${org.b}, 'SOURCE_INVENTORY_SEALED', ${runId})`).rejects.toThrow(
        'SOURCE_ACTIVATION_HELD',
      );
      const [capacity] = await prisma.client.$queryRaw<
        { activation_token: string | null }[]
      >`SELECT activation_token FROM meter_drift_capacity`;
      expect(capacity.activation_token).not.toBeNull();
    } finally {
      finish.release();
      await result;
      expire.mockRestore();
    }
    expect(await result).toBeInstanceOf(Error);
    await expect(
      command.withQuarantineClear(runId, sealed.boundary, async () => 'active'),
    ).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
  });
  it('non-fence park constraint failure retries to DLQ and the next tenant safety event runs', async () => {
    const repository = new FleetRepository(prisma),
      eventId = id('EVT');
    const envelope: EventEnvelope = {
      eventId,
      eventName: 'INSURANCE_RECORDED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'asset-service',
      producerVersion: 'test',
      aggregateType: 'Asset',
      aggregateId: id('AST'),
      tenantId: org.a,
      correlationId: id('COR'),
      payload: {},
    };
    await owner.client.$executeRawUnsafe(`ALTER TABLE "${schema}".insurance_pending_verification
      ADD CONSTRAINT park_refused CHECK (reason <> 'DETERMINISTIC_FAILURE')`);
    const safety = new AssetSyncConsumer(null, repository);
    const handler = jest.fn(async (event: EventEnvelope) => {
      if (event.eventId !== eventId) return safety.handle(event);
      return repository.transaction(
        async (tx) => {
          await repository.markEventProcessed(tx, event.eventId, 'constraint-test');
          if (event.eventId === eventId)
            await repository.parkInsuranceEvent(tx, {
              eventId,
              assetId: event.aggregateId,
              organizationId: org.a,
              envelope: event,
              sourceTopic: 'rasta.asset.v1',
              reason: 'DETERMINISTIC_FAILURE',
              messageKey: null,
              sourcePartition: 0,
              sourceOffset: '0',
              correlationId: event.correlationId,
            });
        },
        undefined,
        event.eventId,
      );
    });
    const transport = new EventConsumer(
      {
        brokers: ['localhost:9092'],
        clientId: 'fleet-constraint',
        groupId: 'fleet-constraint',
        topics: ['rasta.asset.v1'],
        deadLetterTopic: 'rasta.fleet.v1.dlq',
        maxRetries: 3,
        retryBackoffMs: 0,
      },
      handler,
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );
    const sent: ProducerRecord[] = [];
    const dispatch = transport as unknown as {
      dlqProducer: { send(record: ProducerRecord): Promise<void> };
      handleMessage(
        topic: string,
        partition: number,
        value: Buffer,
        headers: undefined,
      ): Promise<void>;
    };
    dispatch.dlqProducer = {
      send: async (record) => {
        sent.push(record);
      },
    };
    await dispatch.handleMessage(
      'rasta.asset.v1',
      0,
      Buffer.from(JSON.stringify(envelope)),
      undefined,
    );
    expect(handler).toHaveBeenCalledTimes(3);
    await expect(handler.mock.results[0].value).rejects.toMatchObject({
      message: 'SOURCE_WRITE_FAILED',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].messages[0].headers).toMatchObject({
      'x-dlq-reason': 'MAX_RETRIES_EXCEEDED',
      'x-dlq-attempts': '3',
    });
    expect(await prisma.client.$queryRaw`SELECT * FROM processed_event`).toEqual([]);
    expect(await prisma.client.$queryRaw`SELECT * FROM insurance_pending_verification`).toEqual([]);
    const next = {
      ...envelope,
      eventId: id('EVT'),
      eventName: 'INSPECTION_FAILED',
      tenantId: org.b,
      payload: producerShaped('INSPECTION_FAILED', {
        assetId: envelope.aggregateId,
        organizationId: org.b,
        inspectionId: id('INP'),
        notes: 'TEST',
      }),
    };
    await dispatch.handleMessage('rasta.asset.v1', 0, Buffer.from(JSON.stringify(next)), undefined);
    expect(handler).toHaveBeenCalledTimes(4);
    expect(
      await asActor({ organizationId: org.b }, () =>
        repository.findAssetRef(org.b, envelope.aggregateId),
      ),
    ).toMatchObject({
      inspectionBlockedReason: 'The most recent technical inspection failed',
    });
    expect(
      await asActor({ organizationId: org.a }, () =>
        repository.findAssetRef(org.a, envelope.aggregateId),
      ),
    ).toBeNull();
    expect(await prisma.client.$queryRaw`SELECT event_id FROM processed_event`).toEqual([
      { event_id: next.eventId },
    ]);
  });
  it('refuses runtime overflow latch decrease, deletion and truncation; active down still refuses', async () => {
    await prisma.client.$executeRaw`UPDATE meter_drift_capacity SET overflow_count = 1`;
    for (const sql of [
      'UPDATE meter_drift_capacity SET overflow_count = 0',
      'DELETE FROM meter_drift_capacity',
      'TRUNCATE meter_drift_capacity',
    ])
      await expect(prisma.client.$executeRawUnsafe(sql)).rejects.toThrow(
        'SOURCE_DRIFT_CAPACITY_FIXED',
      );
    const down = readFileSync(
      join(__dirname, '../prisma/migrations/20261114170000_meter_drift_evidence_guards/down.sql'),
      'utf8',
    );
    const guard = down.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/)?.[0];
    if (!guard) throw new Error('overflow down guard missing');
    await expect(prisma.transaction((tx) => tx.$executeRawUnsafe(guard))).rejects.toThrow(
      'ACTIVE_DRIFT_EVIDENCE_ROLLBACK_REFUSED',
    );
  });
  it('committed overflow history survives owner eviction and ordinary redelivery exhaustion', async () => {
    await command.seal(runId, actor);
    const eventId = id('EVT'),
      assetId = id('AST'),
      repository = new FleetRepository(prisma);
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_quarantine DISABLE TRIGGER meter_drift_quarantine_guard`,
    );
    await prisma.client
      .$executeRaw`INSERT INTO meter_drift_quarantine(event_id, asset_id, named_owner, reason, run_id)
      SELECT 'FILL_' || n, 'AST_FILL', ${org.a}, 'SOURCE_INVENTORY_SEALED', ${runId} FROM generate_series(1,10000) n`;
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_quarantine ENABLE TRIGGER meter_drift_quarantine_guard`,
    );
    await expect(
      repository.transaction(
        async () => {
          throw new SourceDriftRefusal(DLQ_REASONS.SOURCE_INVENTORY_SEALED, assetId, org.b);
        },
        undefined,
        eventId,
      ),
    ).rejects.toMatchObject({ reason: 'SOURCE_DRIFT_QUARANTINE_FULL' });
    expect(await prisma.client.$queryRaw`SELECT event_id FROM meter_drift_overflow`).toEqual([
      { event_id: eventId },
    ]);
    const hash = createHash('sha256').update(eventId).digest('hex');
    expect(await prisma.client.$queryRaw`SELECT event_hash FROM meter_refusal_history`).toEqual([
      { event_hash: hash },
    ]);
    // Owner simulates bounded retention eviction; runtime cannot delete evidence directly.
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_overflow DISABLE TRIGGER meter_drift_overflow_guard`,
    );
    await owner.client.$executeRawUnsafe(`DELETE FROM "${schema}".meter_drift_overflow`);
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_overflow ENABLE TRIGGER meter_drift_overflow_guard`,
    );
    const transport = new EventConsumer(
      {
        brokers: ['localhost:9092'],
        clientId: 'evicted-test',
        groupId: 'evicted-test',
        topics: ['rasta.asset.v1'],
        deadLetterTopic: 'rasta.fleet.v1.dlq',
        maxRetries: 1,
        beforeExhaustion: (event) => repository.holdRefusedExhaustion(event.eventId, assetId),
      },
      async () => {
        throw new Error('ordinary infrastructure');
      },
      { log: () => undefined, warn: () => undefined, error: () => undefined },
    );
    const dispatch = transport as unknown as {
      dlqProducer: { send: jest.Mock };
      handleMessage(
        topic: string,
        partition: number,
        value: Buffer,
        headers: undefined,
      ): Promise<void>;
    };
    const send = jest.fn(async () => {
      expect(
        await prisma.client.$queryRaw`SELECT event_id, asset_id, reason FROM meter_drift_overflow`,
      ).toEqual([
        {
          event_id: `HOLD:${hash}`,
          asset_id: createHash('sha256').update(assetId).digest('hex'),
          reason: 'SOURCE_DRIFT_HOLD',
        },
      ]);
    });
    dispatch.dlqProducer = { send };
    await dispatch.handleMessage(
      'rasta.asset.v1',
      0,
      Buffer.from(
        JSON.stringify({
          eventId,
          eventName: 'ASSET_CREATED',
          eventVersion: 1,
          tenantId: org.b,
          producer: 'asset-service',
          producerVersion: 'test',
          occurredAt: new Date().toISOString(),
          aggregateId: assetId,
          aggregateType: 'Asset',
          correlationId: id('COR'),
          payload: { assetId },
        }),
      ),
      undefined,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['callback', 'policy', 'history'])(
    'evidence statement deadline cancels a held lock: %s',
    async (mode) => {
      const repository = new FleetRepository(prisma),
        eventId = id('EVT');
      await prisma.client
        .$executeRaw`INSERT INTO meter_refusal_history VALUES (${createHash('sha256').update(eventId).digest('hex')})`;
      const held = latch(),
        release = latch();
      const holder = prisma.transaction(async (tx) => {
        if (mode === 'history')
          await tx.$executeRaw`LOCK TABLE meter_refusal_history IN ACCESS EXCLUSIVE MODE`;
        else await tx.$queryRaw`SELECT id FROM meter_drift_capacity FOR UPDATE`;
        held.release();
        await release.ready;
      });
      await held.ready;
      const started = performance.now();
      const timer = setTimeout(release.release, 4 * SOURCE_REFUSAL_HISTORY_TRANSACTION.timeoutMs);
      try {
        if (mode === 'policy') {
          await owner.client.$executeRawUnsafe(
            `ALTER TABLE "${schema}".meter_inventory_seal DISABLE TRIGGER meter_inventory_seal_fixed`,
          );
          await prisma.client.$executeRaw`DELETE FROM meter_inventory_seal`;
          const error = await repository
            .transaction(async () => undefined, undefined, eventId)
            .catch((e: unknown) => e);
          await expect(
            (error as SourceEvidenceUnconfirmedError).evidencePolicy!.persist(error),
          ).rejects.toThrow();
        } else await expect(repository.holdRefusedExhaustion(eventId, undefined)).rejects.toThrow();
        expect(performance.now() - started).toBeLessThan(1000);
        expect(await prisma.client.$queryRaw`SELECT * FROM meter_drift_overflow`).toEqual([]);
      } finally {
        clearTimeout(timer);
        release.release();
        await holder;
      }
    },
  );

  it.each([false, true])(
    'acknowledges owner-change redelivery after lost DLQ publish, overflow=%s',
    async (overflow) => {
      await command.seal(runId, actor);
      if (overflow) {
        await owner.client.$executeRawUnsafe(
          `ALTER TABLE "${schema}".meter_drift_quarantine DISABLE TRIGGER meter_drift_quarantine_guard`,
        );
        await prisma.client
          .$executeRaw`INSERT INTO meter_drift_quarantine(event_id, asset_id, named_owner, reason, run_id)
        SELECT 'FILL_' || n, 'AST_FILL', ${org.a}, 'SOURCE_INVENTORY_SEALED', ${runId} FROM generate_series(1,10000) n`;
        await owner.client.$executeRawUnsafe(
          `ALTER TABLE "${schema}".meter_drift_quarantine ENABLE TRIGGER meter_drift_quarantine_guard`,
        );
      }
      const repository = new FleetRepository(prisma),
        eventId = id('EVT');
      let liveOwner = org.a;
      const metric = jest.spyOn(driftEvidenceOwnerChangesTotal, 'inc');
      const transport = new EventConsumer(
        {
          brokers: ['localhost:9092'],
          clientId: 'owner-replay',
          groupId: 'owner-replay',
          topics: ['rasta.asset.v1'],
          deadLetterTopic: 'rasta.fleet.v1.dlq',
        },
        async () => {
          await repository.transaction(
            (tx) =>
              repository.upsertAssetRef(tx, {
                id: 'AST_NEW',
                organizationId: liveOwner,
                sourceEvent: 'TEST',
              }),
            undefined,
            eventId,
          );
        },
        { log: () => undefined, warn: () => undefined, error: () => undefined },
      );
      jest
        .spyOn(transport as unknown as { pause(run: unknown, ms: number): Promise<void> }, 'pause')
        .mockResolvedValue(undefined);
      const dispatch = transport as unknown as {
        dlqProducer: { send(): Promise<void> };
        handleMessage(...args: [string, number, Buffer, undefined]): Promise<void>;
      };
      const send = jest
        .fn()
        .mockRejectedValueOnce(new Error('lost DLQ publish'))
        .mockResolvedValue(undefined);
      dispatch.dlqProducer = { send };
      const envelope: EventEnvelope = {
        eventId,
        eventName: 'ASSET_CREATED',
        eventVersion: 1,
        tenantId: org.a,
        producer: 'asset-service',
        producerVersion: 'test',
        occurredAt: new Date().toISOString(),
        correlationId: id('COR'),
        aggregateType: 'Asset',
        aggregateId: 'AST_NEW',
        payload: {},
      };
      const body = Buffer.from(JSON.stringify(envelope));
      const deliver = () => dispatch.handleMessage('rasta.asset.v1', 0, body, undefined);
      await expect(deliver()).rejects.toThrow('lost DLQ publish');
      const before = await prisma.client
        .$queryRaw`SELECT * FROM (SELECT * FROM meter_drift_quarantine UNION ALL SELECT * FROM meter_drift_overflow) q WHERE event_id = ${eventId}`;
      expect(before).toEqual([expect.objectContaining({ named_owner: org.a })]);
      liveOwner = org.b;
      await expect(deliver()).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(2);
      expect(metric).toHaveBeenCalledTimes(1);
      expect(metric).toHaveBeenCalledWith(); // No owner values or tenant labels.
      expect(
        await prisma.client
          .$queryRaw`SELECT * FROM (SELECT * FROM meter_drift_quarantine UNION ALL SELECT * FROM meter_drift_overflow) q WHERE event_id = ${eventId}`,
      ).toEqual(before);
      expect(await prisma.client.assetRef.count()).toBe(0);
    },
  );
  it.each(['rollback-kept', 'lost-kept', 'rollback-gone'])(
    'does not report unconfirmed exhaustion: %s',
    async (mode) => {
      const repository = new FleetRepository(prisma),
        eventId = id('EVT'),
        assetId = id('AST');
      const envelope: EventEnvelope = {
        eventId,
        eventName: 'INSURANCE_RECORDED',
        eventVersion: 1,
        tenantId: org.a,
        producer: 'asset-service',
        producerVersion: 'test',
        occurredAt: '2026-01-01T00:00:00.000Z',
        correlationId: id('COR'),
        aggregateType: 'Asset',
        aggregateId: assetId,
        payload: producerShaped('INSURANCE_RECORDED', {
          assetId,
          organizationId: org.a,
          policyId: id('INS'),
          insurerName: 'TEST',
          coverage: 'COMPREHENSIVE',
          validFrom: '2026-01-01T00:00:00.000Z',
          validTo: '2027-01-01T00:00:00.000Z',
          ownershipGeneration: 1,
        }),
      };
      await prisma.client
        .$executeRaw`INSERT INTO insurance_pending_verification(event_id, asset_id, organization_id, envelope, source_topic, reason)
      VALUES (${eventId}, ${assetId}, ${org.a}, ${JSON.stringify(envelope)}::jsonb, 'TEST', 'NO_ANSWER')`;
      const consumer = new AssetSyncConsumer(
        null,
        repository,
        undefined,
        undefined,
        undefined,
        {
          verify: async () => {
            throw new Error('no answer');
          },
        },
        { minAgeSeconds: 0, maxAttempts: 1, batchSize: 1, sweepIntervalMs: 60000 },
      );
      const logger = (consumer as unknown as { logger: { error(message: string): void } }).logger;
      jest.spyOn(logger, 'error');
      const metric = jest.spyOn(dlqMessagesTotal, 'inc'),
        transaction = prisma.transaction.bind(prisma);
      let calls = 0;
      jest.spyOn(prisma, 'transaction').mockImplementation(async (fn, opts) => {
        const call = ++calls;
        if (call === 2) {
          if (mode === 'lost-kept') await transaction(fn, opts);
          else {
            await transaction(async (tx) => {
              await fn(tx);
              throw new Error('rollback');
            }, opts).catch(() => undefined);
            if (mode === 'rollback-kept')
              await prisma.client
                .$executeRaw`UPDATE insurance_pending_verification SET attempts = 1 WHERE event_id = ${eventId}`;
          }
          throw new Error('decision response unavailable');
        }
        if (call === 4)
          await prisma.client
            .$executeRaw`DELETE FROM insurance_pending_verification WHERE event_id = ${eventId}`;
        return transaction(fn, opts);
      });
      const decide = consumer as unknown as {
        reverifyParked(eventId: string, assetId: string): Promise<string>;
      };
      expect(await decide.reverifyParked(eventId, assetId)).toBe(
        mode === 'rollback-gone' ? 'GONE' : 'KEPT',
      );
      expect(metric).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(await prisma.client.outboxMessage.count()).toBe(mode === 'lost-kept' ? 1 : 0);
    },
  );
  it('replays identical evidence before checking a retained activation token', async () => {
    await command.seal(runId, actor);
    const insert = () => prisma.client.$executeRaw`INSERT INTO meter_drift_quarantine
      (event_id, asset_id, named_owner, reason, run_id) VALUES ('REPLAY', 'AST', ${org.a}, 'SOURCE_INVENTORY_SEALED', ${runId})`;
    await insert();
    await setToken(randomUUID());
    expect(await insert()).toBe(0);
    await expect(prisma.client.$executeRaw`INSERT INTO meter_drift_quarantine
      (event_id, asset_id, named_owner, reason, run_id) VALUES ('NEW', 'AST', ${org.a}, 'SOURCE_INVENTORY_SEALED', ${runId})`).rejects.toThrow(
      'SOURCE_ACTIVATION_HELD',
    );
  });
  it('marks a lost ordinary source commit response unconfirmed with a sanitized cause', async () => {
    const repository = new FleetRepository(prisma),
      eventId = id('EVT');
    const transaction = prisma.transaction.bind(prisma);
    jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, options) => {
      await transaction(fn, options);
      throw Object.assign(new Error(`SELECT private_query ${org.a}`), { code: 'P1017' });
    });
    const write = () =>
      repository.transaction(
        async (tx) => {
          if (!(await repository.markEventProcessed(tx, eventId, 'lost-source-commit'))) return;
          await repository.upsertAssetRef(tx, {
            id: 'AST_COMMIT',
            organizationId: org.a,
            sourceEvent: 'TEST',
          });
        },
        undefined,
        eventId,
      );
    await expect(write()).rejects.toMatchObject({
      message: 'SOURCE_WRITE_UNCONFIRMED',
      cause: { message: 'P1017' },
    });
    await write();
    expect(await prisma.client.$queryRaw`SELECT event_id FROM processed_event`).toEqual([
      { event_id: eventId },
    ]);
    expect(await prisma.client.assetRef.count()).toBe(1);
  });
  it('retains evidence after a lost commit response; an unenclosed statement without an event id keeps its retryable refusal', async () => {
    const sealed = await command.seal(runId, actor),
      repository = new FleetRepository(prisma),
      eventId = id('EVT');
    const write = (tx: ExtendedPrismaClient) =>
      repository.upsertAssetRef(tx, {
        id: 'AST_UNKNOWN',
        organizationId: org.b,
        sourceEvent: 'TEST',
      });
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".asset_ref RENAME TO unavailable_asset_ref`,
    );
    try {
      await expect(repository.transaction(write)).rejects.toMatchObject({
        message: 'SOURCE_WRITE_FAILED',
        cause: { message: 'P2021' },
      });
    } finally {
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".unavailable_asset_ref RENAME TO asset_ref`,
      );
    }
    await expect(repository.transaction(write)).rejects.toBeInstanceOf(
      EventHandlingUnconfirmedError,
    );
    const transaction = prisma.transaction.bind(prisma);
    const lost = jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, opts) => {
      await transaction(fn, opts);
      throw new Error('lost commit response');
    });
    try {
      await expect(repository.transaction(write, undefined, eventId)).rejects.toThrow(
        'SOURCE_DRIFT_QUARANTINE_UNCONFIRMED',
      );
    } finally {
      lost.mockRestore();
    }
    const before = await prisma.client.$queryRaw`SELECT * FROM meter_drift_quarantine`;
    expect(before).toHaveLength(1);
    await expect(repository.transaction(write, undefined, eventId)).rejects.toBeInstanceOf(
      UnprocessableEventError,
    );
    expect(await prisma.client.$queryRaw`SELECT * FROM meter_drift_quarantine`).toEqual(before);
    await expect(
      command.withQuarantineClear(runId, sealed.boundary, async () => 'active'),
    ).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
  });
  it('refuses active quarantine down before dropping evidence', async () => {
    await command.seal(runId, actor);
    const down = readFileSync(
      join(__dirname, '../prisma/migrations/20261114120000_meter_drift_quarantine/down.sql'),
      'utf8',
    );
    const guard = down.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/)?.[0];
    if (!guard) throw new Error('migration down guard missing');
    await expect(
      owner.transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
        await tx.$executeRawUnsafe(guard);
      }),
    ).rejects.toThrow('ACTIVE_DRIFT_QUARANTINE_ROLLBACK_REFUSED');
    await expect(
      owner.client.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema}", pg_catalog, pg_temp`}, true)`;
          await tx.$executeRawUnsafe(guard);
        },
        { isolationLevel: 'RepeatableRead' },
      ),
    ).rejects.toThrow('SOURCE_DRIFT_REQUIRES_READ_COMMITTED');
  });
  it('bounds concurrent primary and overflow entries and permits replay at cap', async () => {
    await command.seal(runId, actor);
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_quarantine DISABLE TRIGGER meter_drift_quarantine_guard`,
    );
    await prisma.client
      .$executeRaw`INSERT INTO meter_drift_quarantine(event_id, asset_id, named_owner, reason, run_id)
      SELECT 'CAP_' || n, 'AST_CAP', ${org.b}, 'SOURCE_INVENTORY_SEALED', ${runId} FROM generate_series(1,9999) n`;
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_quarantine ENABLE TRIGGER meter_drift_quarantine_guard`,
    );
    const insert = (eventId: string) => prisma.client.$executeRaw`INSERT INTO meter_drift_quarantine
      (event_id, asset_id, named_owner, reason, run_id) VALUES (${eventId}, 'AST_CAP', ${org.b}, 'SOURCE_INVENTORY_SEALED', ${runId})`;
    const results = await Promise.allSettled([insert('LAST_A'), insert('LAST_B')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(
      await prisma.client.$queryRaw`SELECT count(*)::int AS n FROM meter_drift_overflow`,
    ).toEqual([{ n: 1 }]);
    await expect(insert('CAP_1')).resolves.toBe(0);
    const repository = new FleetRepository(prisma);
    await expect(
      repository.transaction(
        async () => {
          throw new SourceDriftRefusal(DLQ_REASONS.SOURCE_INVENTORY_SEALED, 'AST_CAP', org.b);
        },
        undefined,
        'OVER_CAP',
      ),
    ).rejects.toMatchObject({ reason: 'SOURCE_DRIFT_QUARANTINE_FULL' });
    expect(
      await prisma.client
        .$queryRaw`SELECT event_id FROM meter_drift_overflow WHERE event_id = 'OVER_CAP'`,
    ).toEqual([{ event_id: 'OVER_CAP' }]);
    expect(
      await prisma.client.$queryRaw`SELECT count(*)::int AS n FROM meter_drift_quarantine`,
    ).toEqual([{ n: 10000 }]);
    const transaction = prisma.transaction.bind(prisma);
    const lost = jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, options) => {
      await transaction(fn, options);
      throw new Error('overflow commit response lost');
    });
    const refuse = () =>
      repository.transaction(
        async () => {
          throw new SourceDriftRefusal(DLQ_REASONS.SOURCE_INVENTORY_SEALED, 'AST_CAP', org.b);
        },
        undefined,
        'LOST_OVERFLOW',
      );
    try {
      await expect(refuse()).rejects.toThrow('SOURCE_DRIFT_QUARANTINE_UNCONFIRMED');
    } finally {
      lost.mockRestore();
    }
    expect(
      await prisma.client
        .$queryRaw`SELECT event_id FROM meter_drift_overflow WHERE event_id = 'LOST_OVERFLOW'`,
    ).toEqual([{ event_id: 'LOST_OVERFLOW' }]);
    await expect(refuse()).rejects.toMatchObject({ reason: 'SOURCE_DRIFT_QUARANTINE_FULL' });
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_overflow DISABLE TRIGGER meter_drift_overflow_guard`,
    );
    await prisma.client
      .$executeRaw`INSERT INTO meter_drift_overflow(event_id, asset_id, named_owner, reason, run_id)
      SELECT 'OLD_' || n, 'AST_CAP', ${org.b}, 'SOURCE_INVENTORY_SEALED', ${runId} FROM generate_series(1,10000) n`;
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_overflow ENABLE TRIGGER meter_drift_overflow_guard`,
    );
    await insert('BOUNDED');
    expect(
      await prisma.client.$queryRaw`SELECT count(*)::int AS n FROM meter_drift_overflow`,
    ).toEqual([{ n: 10000 }]);
    expect(await prisma.client.$queryRaw`SELECT overflow_count FROM meter_drift_capacity`).toEqual([
      { overflow_count: 4n },
    ]);
    await prisma.client.$executeRaw`INSERT INTO meter_drift_overflow
      (event_id, asset_id, named_owner, reason, run_id)
      VALUES ('HOLD:BOUNDED', 'AST', 'PLATFORM', 'SOURCE_DRIFT_HOLD', 'HOLD:SOURCE_REFUSAL_UNCONFIRMED:0')`;
    expect(
      await prisma.client.$queryRaw`SELECT count(*)::int AS n FROM meter_drift_overflow`,
    ).toEqual([{ n: 10000 }]);
    expect(await prisma.client.$queryRaw`SELECT overflow_count FROM meter_drift_capacity`).toEqual([
      { overflow_count: 5n },
    ]);
    await setToken(randomUUID());
    expect(await insert('BOUNDED')).toBe(0);
    await setToken(null);
    await expect(
      command.withQuarantineClear(
        runId,
        (await command.seal(runId, actor)).boundary,
        async () => 'unsafe',
      ),
    ).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
    await expect(
      prisma.client.$executeRaw`DELETE FROM meter_drift_quarantine WHERE event_id = 'CAP_1'`,
    ).rejects.toThrow('SOURCE_DRIFT_QUARANTINE_FIXED');
    await expect(
      prisma.client
        .$executeRaw`UPDATE meter_drift_quarantine SET named_owner = ${org.a} WHERE event_id = 'CAP_1'`,
    ).rejects.toThrow('SOURCE_DRIFT_QUARANTINE_FIXED');
    await expect(
      owner.client.$executeRawUnsafe(`TRUNCATE "${schema}".meter_drift_quarantine`),
    ).rejects.toThrow('SOURCE_DRIFT_QUARANTINE_FIXED');
    await expect(
      insert('CAP_1').then(
        () => prisma.client.$executeRaw`INSERT INTO meter_drift_quarantine
      (event_id, asset_id, named_owner, reason, run_id) VALUES ('CAP_1', 'OTHER', ${org.b}, 'SOURCE_INVENTORY_SEALED', ${runId})`,
      ),
    ).rejects.toThrow('SOURCE_DRIFT_EVENT_CONFLICT');
    await prisma.client
      .$executeRaw`UPDATE meter_drift_capacity SET overflow_count = 9223372036854775807`;
    await insert('SATURATED');
    expect(await prisma.client.$queryRaw`SELECT overflow_count FROM meter_drift_capacity`).toEqual([
      { overflow_count: 9223372036854775807n },
    ]);
    // Even after a future operator clears the primary set, eviction must never reopen activation.
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_drift_quarantine DISABLE TRIGGER meter_drift_quarantine_guard`,
    );
    await prisma.client.$executeRaw`DELETE FROM meter_drift_quarantine`;
    await expect(
      command.withQuarantineClear(
        runId,
        (await command.seal(runId, actor)).boundary,
        async () => 'unsafe',
      ),
    ).rejects.toThrow('SOURCE_DRIFT_QUARANTINED');
  });
  const sweepFailures = [
    'confirmed',
    'inventory-sealed',
    'cleanup-failed',
    'quarantine-failed',
    'commit-lost',
    'unknown-write',
    'held-exhausted',
    'missing-gate-exhausted',
    'oversized-exhausted',
    'refused-then-ambiguous-exhausted',
    'refused-then-park-exhausted',
    'refused-then-held-seal-exhausted',
    'refused-then-version-exhausted',
  ];
  it.each(sweepFailures)('sweep drift %s', async (mode) => {
    const assetId = id('AST'),
      eventId = mode === 'oversized-exhausted' ? 'E'.repeat(300) : id('EVT');
    const holdMode = mode.endsWith('-exhausted');
    const envelope: EventEnvelope = {
      eventId,
      eventName: 'INSURANCE_RECORDED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'asset-service',
      producerVersion: '0.1.0',
      aggregateType: 'Asset',
      aggregateId: assetId,
      tenantId: org.b,
      correlationId: id('COR'),
      payload: producerShaped('INSURANCE_RECORDED', {
        assetId,
        organizationId: org.b,
        policyId: id('INS'),
        insurerName: 'TEST',
        coverage: 'COMPREHENSIVE',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
        ownershipGeneration: 1,
      }),
    };
    if (mode === 'inventory-sealed') {
      await command.seal(runId, actor);
      // Model a legacy parked row inconsistent with the immutable inventory.
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".insurance_pending_verification DISABLE TRIGGER meter_inventory_creation_fence`,
      );
    } else {
      await asset(assetId);
      await prisma.client
        .$executeRaw`INSERT INTO usage_record(id, asset_id, organization_id, period_start, period_end, hours, recorded_by)
      VALUES (${id('USG')}, ${assetId}, ${org.a}, '2026-01-01', '2026-01-02', 1, 'TEST')`;
    }
    await prisma.client
      .$executeRaw`INSERT INTO insurance_pending_verification(event_id, asset_id, organization_id, envelope, source_topic, reason)
      VALUES (${eventId}, ${assetId}, ${org.b}, ${JSON.stringify(envelope)}::jsonb, 'TEST', 'TEST')`;
    const repository = new FleetRepository(prisma);
    await prisma.transaction((tx) => repository.markEventProcessed(tx, eventId, CONSUMER_NAME));
    if (mode === 'inventory-sealed')
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".insurance_pending_verification ENABLE TRIGGER meter_inventory_creation_fence`,
      );
    else await command.seal(runId, actor);
    await prisma.client.$executeRaw`DELETE FROM asset_ref WHERE id = ${assetId}`;
    await prisma.transaction((tx) => repository.markParkedInsuranceDue(tx, assetId));
    const verify = jest.fn(async () => ({
      counts: true as const,
      organizationId: org.b,
      coverage: 'COMPREHENSIVE',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2027-01-01T00:00:00.000Z',
      ownershipGeneration: 1,
    }));
    if (mode === 'held-exhausted' || mode.startsWith('refused-then-')) await setToken(randomUUID());
    if (mode === 'missing-gate-exhausted') {
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".meter_inventory_seal DISABLE TRIGGER meter_inventory_seal_fixed`,
      );
      await prisma.client.$executeRaw`DELETE FROM meter_inventory_seal`;
    }
    const consumer = new AssetSyncConsumer(
      null,
      repository,
      undefined,
      undefined,
      undefined,
      { verify },
      holdMode
        ? {
            minAgeSeconds: 300,
            maxAttempts: mode.startsWith('refused-then-') ? 2 : 1,
            batchSize: 50,
            sweepIntervalMs: 60000,
          }
        : undefined,
    );

    const transaction = prisma.transaction.bind(prisma);
    const held = latch(),
      release = latch();
    let holder: Promise<unknown> | undefined;
    if (mode === 'refused-then-held-seal-exhausted') {
      // Retained-image fence: current main exempts metadata-only updates. Prove history
      // survives even when the legacy fenced latch still waits on the held seal.
      await owner.client
        .$executeRawUnsafe(`CREATE FUNCTION "${schema}".legacy_latch() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM "${schema}".meter_inventory_seal FOR SHARE;
        RETURN NEW; END $$`);
      await owner.client.$executeRawUnsafe(`CREATE TRIGGER legacy_latch BEFORE UPDATE ON
        "${schema}".insurance_pending_verification FOR EACH ROW EXECUTE FUNCTION "${schema}".legacy_latch()`);
      const record = repository.recordParkedAttempt.bind(repository);
      jest.spyOn(repository, 'recordParkedAttempt').mockImplementationOnce(async (tx, ...args) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
        return record(tx, ...args);
      });
      const answer = await verify();
      verify.mockClear();
      verify.mockImplementationOnce(async () => {
        holder = prisma.transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM meter_inventory_seal FOR UPDATE`;
            held.release();
            await release.ready;
          },
          { timeoutMs: 30_000 },
        );
        await held.ready;
        return answer;
      });
    }
    if (mode === 'refused-then-version-exhausted') {
      const answer = await verify(),
        decision = repository.transaction.bind(repository);
      verify.mockClear();
      verify.mockImplementationOnce(async () => {
        jest.spyOn(repository, 'transaction').mockImplementationOnce(async (...args) => {
          try {
            return await decision(...args);
          } catch (error) {
            // Another worker commits after decision rollback, before the fallback gets its lock.
            await new FleetRepository(prisma).transaction(async (tx) => {
              await repository.lockAssetRef(tx, assetId);
              await repository.recordParkedAttempt(tx, eventId, 'NO_ANSWER');
            });
            throw error;
          }
        });
        return answer;
      });
    }
    if (mode === 'cleanup-failed')
      jest
        .spyOn(repository, 'deleteParkedInsurance')
        .mockRejectedValueOnce(new Error('delete failed'));
    if (mode === 'unknown-write')
      jest
        .spyOn(repository, 'upsertAssetRef')
        .mockRejectedValueOnce(new Error('SOURCE_OWNER_DRIFT'));
    if (mode === 'commit-lost') {
      const answer = await verify();
      verify.mockClear();
      verify.mockImplementationOnce(async () => {
        jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, options) => {
          await transaction(fn, options);
          throw new Error('commit response lost');
        });
        return answer;
      });
    }
    if (mode === 'quarantine-failed')
      await owner.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}".meter_drift_quarantine RENAME TO unavailable_quarantine`,
      );
    try {
      if (mode.startsWith('refused-then-')) {
        const first = await consumer.sweepParked();
        release.release();
        await holder;
        expect(first.DEAD_LETTERED).toBe(0);
        if (['refused-then-held-seal-exhausted', 'refused-then-version-exhausted'].includes(mode))
          expect(
            await prisma.client
              .$queryRaw`SELECT reason, attempts FROM insurance_pending_verification`,
          ).toEqual([
            {
              reason: mode.includes('version') ? 'NO_ANSWER' : 'TEST',
              attempts: mode.includes('version') ? 1 : 0,
            },
          ]);
        expect(
          await prisma.client.$queryRaw`SELECT count(*)::int AS n FROM meter_refusal_history`,
        ).toEqual([{ n: 1 }]);
        if (!['refused-then-held-seal-exhausted', 'refused-then-version-exhausted'].includes(mode))
          expect(
            await prisma.client
              .$queryRaw`SELECT reason = 'SOURCE_REFUSAL_SEEN' AS refusal_seen FROM insurance_pending_verification`,
          ).toEqual([{ refusal_seen: true }]);
        if (!['refused-then-held-seal-exhausted', 'refused-then-version-exhausted'].includes(mode))
          await assertHoldDownRefuses();
        await setToken(null);
        await prisma.transaction((tx) => repository.markParkedInsuranceDue(tx, assetId));
        if (['refused-then-ambiguous-exhausted', 'refused-then-version-exhausted'].includes(mode))
          verify.mockImplementationOnce(async () => {
            jest.spyOn(prisma, 'transaction').mockImplementationOnce((fn, options) =>
              transaction(async (tx) => {
                await fn(tx); // callback returned; model a lost/failed commit result, with rollback.
                throw new Error('ambiguous commit result');
              }, options),
            );
            throw new Error('upstream unavailable');
          });
        else verify.mockRejectedValue(new Error('upstream unavailable'));
        if (mode === 'refused-then-held-seal-exhausted') {
          expect(await consumer.sweepParked()).toMatchObject({ KEPT: 1 });
          await prisma.transaction((tx) => repository.markParkedInsuranceDue(tx, assetId));
        }
      }
      expect(await consumer.sweepParked()).toMatchObject({
        QUARANTINED: ['confirmed', 'inventory-sealed'].includes(mode) ? 1 : 0,
      });
      if (holdMode) {
        expect(
          await prisma.client.$queryRaw`SELECT reason, run_id, asset_id FROM meter_drift_overflow`,
        ).toEqual([
          {
            reason: 'SOURCE_DRIFT_HOLD',
            asset_id: createHash('sha256').update(assetId).digest('hex'),
            run_id: mode.startsWith('refused-then-')
              ? `HOLD:SOURCE_INFRASTRUCTURE_DURING_REFUSAL:${mode === 'refused-then-ambiguous-exhausted' ? 1 : 0}`
              : 'HOLD:SOURCE_REFUSAL_UNCONFIRMED:1',
          },
        ]);
        expect(
          await prisma.client.$queryRaw`SELECT overflow_count FROM meter_drift_capacity`,
        ).toEqual([{ overflow_count: 1n }]);
        expect(await prisma.client.$queryRaw`SELECT * FROM insurance_pending_verification`).toEqual(
          [],
        );
        expect(await prisma.client.$queryRaw`SELECT * FROM asset_ref`).toEqual([]);
        expect(await prisma.client.$queryRaw`SELECT * FROM meter_drift_quarantine`).toEqual([]);
        return;
      }
      if (['cleanup-failed', 'quarantine-failed', 'unknown-write'].includes(mode)) {
        expect(
          await prisma.client.$queryRaw`SELECT event_id FROM insurance_pending_verification`,
        ).toEqual([{ event_id: eventId }]);
        if (mode !== 'quarantine-failed')
          expect(await prisma.client.$queryRaw`SELECT * FROM meter_drift_quarantine`).toEqual([]);
      }
    } finally {
      jest.restoreAllMocks();
      if (mode === 'quarantine-failed')
        await owner.client.$executeRawUnsafe(
          `ALTER TABLE "${schema}".unavailable_quarantine RENAME TO meter_drift_quarantine`,
        );
    }
    if (['cleanup-failed', 'quarantine-failed', 'unknown-write'].includes(mode)) {
      await prisma.transaction((tx) => repository.markParkedInsuranceDue(tx, assetId));
      const answer = await verify();
      const both = latch();
      let waiting = 0;
      verify.mockImplementation(async () => {
        if (++waiting === 2) both.release();
        await both.ready;
        return answer;
      });
      const outcomes = await Promise.all([consumer.sweepParked(), consumer.sweepParked()]);
      expect(outcomes.reduce((n, c) => n + c.QUARANTINED, 0)).toBe(1);
    }
    const calls = verify.mock.calls.length;
    expect(await consumer.sweepParked()).toMatchObject({ QUARANTINED: 0 });
    expect(verify).toHaveBeenCalledTimes(calls);
    expect(
      await prisma.client.$queryRaw`SELECT event_id, reason FROM meter_drift_quarantine`,
    ).toEqual([
      {
        event_id: eventId,
        reason: mode === 'inventory-sealed' ? 'SOURCE_INVENTORY_SEALED' : 'SOURCE_OWNER_DRIFT',
      },
    ]);
    expect(
      await prisma.client
        .$queryRaw`SELECT attempts FROM insurance_pending_verification WHERE event_id = ${eventId}`,
    ).toEqual([]);
    expect(await prisma.client.$queryRaw`SELECT * FROM asset_ref`).toEqual([]);
    expect(await prisma.client.$queryRaw`SELECT event_id FROM processed_event`).toEqual([
      { event_id: eventId },
    ]);
  });
  it('allows parked retries and due marking under a historical foreign owner after sealing', async () => {
    const currentId = id('AST'),
      parkedId = id('EVT');
    await asset(currentId);
    await prisma.client
      .$executeRaw`INSERT INTO insurance_pending_verification(event_id, asset_id, organization_id,
      envelope, source_topic, reason) VALUES (${parkedId}, ${currentId}, ${org.b}, '{}', 'TEST', 'TEST')`;
    const sealed = await command.seal(runId, actor);
    const repository = new FleetRepository(prisma);
    await prisma.transaction(async (tx) => {
      expect(await repository.markParkedInsuranceDue(tx, currentId)).toBe(1);
      expect(await repository.recordParkedAttempt(tx, parkedId, 'NO_ANSWER')).toBe(1);
    });
    const [parked] = await prisma.client.$queryRaw<{ attempts: number; organization_id: string }[]>`
      SELECT attempts, organization_id FROM insurance_pending_verification WHERE event_id = ${parkedId}`;
    expect(parked).toEqual({ attempts: 1, organization_id: org.b });
    expect(await command.seal(runId, actor)).toEqual(sealed);
    await expect(
      prisma.client.$transaction(
        (tx) => tx.$executeRaw`UPDATE insurance_pending_verification SET attempts = attempts + 1`,
        { isolationLevel: 'RepeatableRead' },
      ),
    ).rejects.toThrow('SOURCE_FENCE_REQUIRES_READ_COMMITTED');
    await owner.client.$executeRawUnsafe(
      `ALTER TABLE "${schema}".meter_inventory_seal DISABLE TRIGGER meter_inventory_seal_fixed`,
    );
    await owner.client.$executeRawUnsafe(`DELETE FROM "${schema}".meter_inventory_seal`);
    await prisma.transaction(async (tx) => {
      expect(await repository.recordParkedAttempt(tx, parkedId, 'DECISION_FAILED')).toBe(2);
    });
    await expect(prisma.client.$executeRaw`UPDATE insurance_pending_verification
      SET organization_id = 'OTHER'`).rejects.toThrow('SOURCE_FENCE_MISSING');
  });
  it('refuses a malformed stored seal boundary on same-run replay', async () => {
    await prisma.client.$executeRaw`UPDATE meter_inventory_seal SET run_id = ${runId},
      operator_id = ${actor}, inventory = '[]'::jsonb, boundary = 'BROKEN_SOURCE_SEAL'
      WHERE id = true`;
    await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_SEAL_INVALID');
    expect(await events()).toHaveLength(0);
  });
  it.each(['assetId', 'organizationId'])(
    'refuses malformed source %s without a seal or event',
    async (field) => {
      await prisma.client
        .$executeRaw`INSERT INTO asset_ref(id, organization_id, status, synced_at, source_event)
      VALUES (${field === 'assetId' ? 'BAD.ID' : id('AST')}, ${field === 'organizationId' ? 'BAD.ORG' : org.a},
      'ACTIVE', ${new Date()}, 'TEST')`;
      await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_INVENTORY_MALFORMED');
      expect(await events()).toHaveLength(0);
      const [gate] = await prisma.client.$queryRaw<{ run_id: string | null }[]>`
      SELECT run_id FROM meter_inventory_seal WHERE id = true`;
      expect(gate.run_id).toBeNull();
    },
  );
  it.each([
    { inventory: [{ assetId: 'AST', organizationId: 'ORG', extra: 'invalid' }] },
    { inventory: [{ assetId: 'BAD.ID', organizationId: 'ORG' }] },
  ])('refuses malformed stored inventory $inventory', async ({ inventory }) => {
    const boundary = `fleet:${runId}:${createHash('sha256').update(JSON.stringify(inventory)).digest('hex')}`;
    await prisma.client.$executeRaw`UPDATE meter_inventory_seal SET run_id = ${runId},
      operator_id = ${actor}, inventory = ${JSON.stringify(inventory)}::jsonb, boundary = ${boundary}
      WHERE id = true`;
    await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_SEAL_INVALID');
    expect(await events()).toHaveLength(0);
  });
  it.each(['pool', 'statement', 'expiration'])(
    'reports definite %s failure as a precommit refusal',
    async (failure) => {
      const transaction = prisma.transaction.bind(prisma);
      let expired: unknown;
      if (failure === 'pool')
        jest.spyOn(prisma, 'transaction').mockRejectedValueOnce(new Error('pool wait'));
      else {
        if (failure === 'expiration')
          jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn) => {
            try {
              return await transaction(fn, { timeoutMs: 100 });
            } catch (error) {
              expired = error;
              throw error;
            }
          });
        jest.spyOn(FleetRepository.prototype, 'enqueueEvent').mockImplementationOnce(async (tx) => {
          if (failure === 'statement') await tx.$executeRaw`SELECT 1/0`;
          else {
            await tx.$executeRaw`SELECT pg_sleep(0.4)`;
            await tx.$executeRaw`SELECT 1`;
          }
          throw new Error('unreachable');
        });
      }
      await expect(command.seal(runId, actor)).rejects.toEqual(
        new FleetMeterInventoryRefusal('SOURCE_SEAL_PRECOMMIT_FAILED'),
      );
      if (failure === 'expiration') expect(expired).toMatchObject({ code: 'P2028' });
      expect(await events()).toHaveLength(0);
      const [gate] = await prisma.client.$queryRaw<{ run_id: string | null }[]>`
      SELECT run_id FROM meter_inventory_seal WHERE id = true`;
      expect(gate.run_id).toBeNull();
    },
  );
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
    const deadlocks = async () => {
      const [row] = await owner.client.$queryRaw<{ deadlocks: bigint }[]>`
        SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`;
      return row.deadlocks;
    };
    const before = await deadlocks();
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
    let sealing: ReturnType<FleetMeterInventorySeal['seal']> | undefined;
    try {
      sealing = command.seal(runId, actor);
      let settled = false;
      void sealing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // NOWAIT must settle without entering a Lock wait; assert before releasing the writer.
      await waiter('LOCK TABLE', () => settled);
      expect(settled).toBe(true);
      finish.release();
      await expect(sealing).rejects.toThrow('SOURCE_WRITERS_ACTIVE');
      expect(await events()).toHaveLength(0);
    } finally {
      finish.release();
      await Promise.allSettled([writer, sealing]);
    }
    await writer;
    expect((await command.seal(runId, actor)).assets).toEqual([{ assetId, organizationId: org.a }]);
    // Disconnect flushes the seal backend's statistics; a deadlock victim is not NOWAIT proof.
    await prisma.stop();
    expect(await deadlocks()).toBe(before);
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
  it.each(['write', 'replay'])(
    'keeps post-callback %s errors unconfirmed, including known refusal shapes',
    async (phase) => {
      if (phase === 'replay') await command.seal(runId, actor);
      const transaction = prisma.transaction.bind(prisma);
      for (const error of [
        new FleetMeterInventoryRefusal('SOURCE_SEAL_CONFLICT'),
        new Prisma.PrismaClientKnownRequestError('lost response', {
          code: 'P2034',
          clientVersion: 'test',
        }),
      ]) {
        jest.spyOn(prisma, 'transaction').mockImplementationOnce(async (fn, options) => {
          await transaction(fn, options);
          throw error;
        });
        await expect(command.seal(runId, actor)).rejects.toThrow('SOURCE_SEAL_UNCONFIRMED');
      }
      expect(await events()).toHaveLength(1);
      expect((await command.seal(runId, actor)).complete).toBe(true);
    },
  );
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
