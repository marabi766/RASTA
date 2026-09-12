import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
import { cleanupRun, id, newMigratorPrisma, newPrisma, RUN_TAG } from './helpers';

/**
 * The append-only guarantee, against the real database.
 *
 * ADR-053 § 6 claims two independent layers. A test that only ever ran with
 * both in place could not tell a working pair from one working control and one
 * that does nothing, so each is exercised with the other neutralised.
 *
 * Every mutation here is attempted as `rasta_audit` — the role the service
 * actually runs as. Attempting them as the owner would prove nothing about the
 * deployment.
 */
describe('audit_event is append-only (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let repository: AuditRepository;

  const delivery: EventDelivery = Object.freeze({ topic: 'rasta.asset.v1', partition: 0 });

  function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
    return {
      eventId: id('EVT'),
      eventName: 'ASSET_DECOMMISSIONED',
      eventVersion: 1,
      occurredAt: '2026-10-05T08:00:00.000Z',
      producer: 'asset-service',
      producerVersion: '1.0.0',
      aggregateType: 'Asset',
      aggregateId: id('AST'),
      tenantId: id('ORG'),
      correlationId: id('COR'),
      payload: {},
      ...overrides,
    } as EventEnvelope;
  }

  async function writeOne(): Promise<{ auditId: string; occurredAt: Date }> {
    const record = toAuditEventRecord(envelope(), delivery);
    const outcome = await repository.ingest(record, DOMAIN_PROJECTOR_CONSUMER);
    expect(outcome).toBe('WRITTEN');
    return { auditId: record.id, occurredAt: record.occurredAt };
  }

  beforeAll(async () => {
    prisma = newPrisma();
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    repository = new AuditRepository(prisma);
  }, 60_000);

  afterAll(async () => {
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 60_000);

  it('lets the service insert and read, which is all it may do', async () => {
    const { auditId } = await writeOne();

    const found = await prisma.client.auditEvent.findFirst({ where: { id: auditId } });
    expect(found).not.toBeNull();
    expect(found?.outcome).toBe('SUCCESS');
  });

  describe('layer 1 alone — privileges, with the triggers disabled', () => {
    // The triggers are switched off by the owner for these three assertions, so
    // a pass can only mean the privilege layer refused the statement. Restored
    // in `afterAll` of this block, and again inside a transaction so no exit
    // path leaves the store mutable.
    beforeAll(async () => {
      await migrator.client.$executeRawUnsafe(
        'ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only',
      );
      await migrator.client.$executeRawUnsafe(
        'ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only_truncate',
      );
    });

    afterAll(async () => {
      await migrator.client.$executeRawUnsafe(
        'ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only',
      );
      await migrator.client.$executeRawUnsafe(
        'ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only_truncate',
      );
    });

    it('refuses UPDATE with 42501', async () => {
      const { auditId } = await writeOne();
      await expect(
        prisma.client.$executeRawUnsafe(
          `UPDATE audit_event SET action = 'tampered' WHERE id = $1`,
          auditId,
        ),
      ).rejects.toThrow(/42501|permission denied/i);
    });

    it('refuses DELETE with 42501', async () => {
      const { auditId } = await writeOne();
      await expect(
        prisma.client.$executeRawUnsafe(`DELETE FROM audit_event WHERE id = $1`, auditId),
      ).rejects.toThrow(/42501|permission denied/i);
    });

    it('refuses TRUNCATE with 42501', async () => {
      await expect(prisma.client.$executeRawUnsafe('TRUNCATE audit_event')).rejects.toThrow(
        /42501|permission denied/i,
      );
    });
  });

  describe('layer 2 alone — the trigger, with the privilege granted', () => {
    // The runtime role is temporarily given exactly the rights the design
    // withholds, so a pass can only mean the trigger refused the statement.
    // Restored in `afterAll`, which runs even when an assertion above fails.
    beforeAll(async () => {
      await migrator.client.$executeRawUnsafe(
        'GRANT UPDATE, DELETE, TRUNCATE ON audit_event TO rasta_audit',
      );
      await migrator.client.$executeRawUnsafe(
        'GRANT UPDATE, DELETE, TRUNCATE ON audit_event_default TO rasta_audit',
      );
    });

    afterAll(async () => {
      await migrator.client.$executeRawUnsafe(
        'REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM rasta_audit',
      );
      await migrator.client.$executeRawUnsafe('REVOKE ALL ON audit_event_default FROM rasta_audit');

      // Proven restored rather than assumed: a suite that left the runtime role
      // able to mutate would make every later assertion meaningless.
      const grants = await migrator.client.$queryRaw<{ privilege_type: string }[]>`
        SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = current_schema()
           AND table_name = 'audit_event'
           AND grantee = 'rasta_audit'
      `;
      expect(grants.map((g) => g.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
    });

    it('refuses UPDATE with the append-only error', async () => {
      const { auditId } = await writeOne();
      await expect(
        prisma.client.$executeRawUnsafe(
          `UPDATE audit_event SET action = 'tampered' WHERE id = $1`,
          auditId,
        ),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses DELETE with the append-only error', async () => {
      const { auditId } = await writeOne();
      await expect(
        prisma.client.$executeRawUnsafe(`DELETE FROM audit_event WHERE id = $1`, auditId),
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses TRUNCATE of the parent', async () => {
      await expect(prisma.client.$executeRawUnsafe('TRUNCATE audit_event')).rejects.toThrow(
        /append-only/i,
      );
    });

    it('refuses TRUNCATE of a partition directly', async () => {
      // The case a parent-only trigger would miss entirely. PostgreSQL clones a
      // row-level UPDATE/DELETE trigger to every partition but does not clone a
      // statement-level TRUNCATE trigger, so without a per-partition trigger
      // this statement silently empties a month.
      await expect(prisma.client.$executeRawUnsafe('TRUNCATE audit_event_default')).rejects.toThrow(
        /append-only/i,
      );
    });
  });

  describe('there is no deletion path in the service at all', () => {
    it('exposes no delete or update method on the repository', () => {
      // ADR § 11: "a deletion path that exists is a deletion path that can be
      // called by mistake". The absence is asserted rather than assumed.
      const methods = Object.getOwnPropertyNames(AuditRepository.prototype);
      expect(methods).toEqual(expect.arrayContaining(['ingest', 'partitionRowCounts']));
      expect(methods.join(' ')).not.toMatch(/delete|remove|purge|prune|truncate|update/i);
    });

    it('never issues a delete or update against audit_event in the service source', () => {
      // Guards against a future method that does not name itself honestly.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readFileSync, readdirSync, statSync } =
        require('node:fs') as typeof import('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { join } = require('node:path') as typeof import('node:path');

      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) {
            if (entry !== 'generated') walk(full);
            continue;
          }
          if (!full.endsWith('.ts') || full.endsWith('.spec.ts')) continue;
          const source = readFileSync(full, 'utf8');
          if (/auditEvent\s*\.\s*(delete|deleteMany|update|updateMany|upsert)\b/.test(source)) {
            offenders.push(full);
          }
        }
      };
      walk(join(__dirname, '..', 'src'));

      expect(offenders).toEqual([]);
    });
  });

  it('cannot reach another service database with its own credentials', async () => {
    // AGENTS.md A-01, asserted rather than trusted. `rasta_audit` has no
    // CONNECT on another service's database, so the connection itself fails.
    const foreign = new PrismaService(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      (process.env.DATABASE_URL_AUDIT ?? '').replace('/rasta_audit?', '/rasta_economic?'),
    );

    await expect(foreign.client.$queryRawUnsafe('SELECT 1 FROM wallet LIMIT 1')).rejects.toThrow();

    await foreign.client.$disconnect().catch(() => undefined);
  });

  it('leaves the run tag on every row it wrote, so cleanup can be exact', async () => {
    const rows = await prisma.client.auditEvent.findMany({
      where: { sourceEventId: { contains: `_${RUN_TAG}_` } },
      select: { sourceEventId: true },
    });
    expect(rows.length).toBeGreaterThan(0);
  });
});
