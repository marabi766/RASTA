import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { AuditVerificationService } from '../src/audit/audit.verification.service';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
import type { AuditVerifyQuery } from '../src/audit/audit.query.dto';
import type { AuditChainVerification } from '../src/audit/audit.verification.view';
import type { AuditEnv } from '../src/config/env';
import { CANONICAL_VERSION } from '../src/audit/audit.canonical';
import {
  cleanupRun,
  disabledProtectiveTriggers,
  id,
  instantIn,
  newMigratorPrisma,
  newPrisma,
  runMonth,
} from './helpers';

/**
 * The chain, its verification endpoint and the database controls under it —
 * all three against real PostgreSQL (ADR-053 § 6, acceptance matrix in
 * `docs/adr/ADR-053-implementation-plan.md`).
 *
 * ## Why the tampering here is done as the owner, on purpose
 *
 * The unit suite already proves the walk reports the right reason for a chain
 * assembled in memory. What it cannot prove is the thing the store actually
 * claims: that a **privileged** alteration — one made by somebody who already
 * holds the rights the design withholds — is still visible afterwards. So every
 * divergence below is written into the real table, by the owner, with the
 * append-only trigger suspended for exactly the statements that need it and
 * restored before the transaction commits.
 *
 * That is the honest boundary ADR-053 draws and `AGENTS.md` S-10 forbids
 * overstating: a hash chain is tamper-**evident**, not tamper-proof. These
 * tests are the evidence half.
 *
 * ## And the layers below it are exercised on the real objects
 *
 * A chain is only as good as the head that anchors it, and the head is the one
 * object in this service the runtime role may `UPDATE`. So the last block here
 * attacks it the way an application-level attacker would — rewind, re-key,
 * skip, move the segment start, delete, truncate — as `rasta_audit`, the role
 * the service actually runs as.
 */

/** Nothing under test reads a log line; this keeps the output quiet. */
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

/**
 * The verification ceiling, set high enough that nothing here is refused for
 * size. The ceiling itself has its own coverage in the unit suite.
 */
const ENV = { AUDIT_MAX_VERIFICATION_RECORDS: 100_000 } as AuditEnv;

/** A month with a real partition, so the walk uses the pruned path. */
const TENANT_MONTH = '2027-07-01';

const systemAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(
    {
      requestId: `req_${id('R')}`,
      correlationId: id('COR'),
      authType: 'USER',
      roles: ['SYSTEM_ADMIN'],
      // Spelled out rather than left off: `RequestContext` requires it, and a
      // platform administrator's token genuinely carries no membership — which
      // is the whole reason `scope=PLATFORM` cannot mean "every tenant".
      organizationIds: [],
      startedAt: Date.now(),
    } satisfies RequestContext,
    fn,
  );

interface SeededRecord {
  id: string;
  sequenceNo: bigint;
  occurredAt: Date;
  recordHash: Uint8Array | null;
  previousHash: Uint8Array | null;
}

const hex = (value: Uint8Array | null): string | null =>
  value === null ? null : Buffer.from(value).toString('hex');

describe('the audit hash chain (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let repository: AuditRepository;
  let verification: AuditVerificationService;

  const delivery: EventDelivery = Object.freeze({ topic: 'rasta.asset.v1', partition: 0 });

  function envelope(tenantId: string | undefined, occurredAt: Date): EventEnvelope {
    return {
      eventId: id('EVT'),
      eventName: 'ASSET_DECOMMISSIONED',
      eventVersion: 1,
      occurredAt: occurredAt.toISOString(),
      producer: 'asset-service',
      producerVersion: '1.0.0',
      aggregateType: 'Asset',
      aggregateId: id('AST'),
      tenantId,
      correlationId: id('COR'),
      payload: {},
    } as EventEnvelope;
  }

  /**
   * Writes `count` records into one chain through the production writer, and
   * reads back the link each one actually carries.
   *
   * Through `ingest` and never through a direct insert: a chain assembled by
   * the test would only prove that the test can build one.
   */
  async function seedChain(
    organizationId: string | undefined,
    chainMonth: string,
    count: number,
    spacingMinutes = 10,
  ): Promise<SeededRecord[]> {
    const written: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const source = envelope(organizationId, instantIn(chainMonth, index * spacingMinutes));
      const outcome = await repository.ingest(
        toAuditEventRecord(source, delivery),
        DOMAIN_PROJECTOR_CONSUMER,
      );
      expect(outcome).toBe('WRITTEN');
      written.push(source.eventId);
    }

    const rows = await prisma.client.auditEvent.findMany({
      where: {
        // Tenant-and-month scoped, always. `null` is Prisma's IS NULL, which is
        // the platform chain and never a tenant's.
        organizationId: organizationId ?? null,
        occurredAt: { gte: monthStart(chainMonth), lt: monthEnd(chainMonth) },
        sourceEventId: { in: written },
      },
      orderBy: { sequenceNo: 'asc' },
      select: {
        id: true,
        sequenceNo: true,
        occurredAt: true,
        recordHash: true,
        previousHash: true,
      },
    });

    expect(rows).toHaveLength(count);
    return rows;
  }

  const monthStart = (chainMonth: string): Date => new Date(`${chainMonth}T00:00:00.000Z`);
  const monthEnd = (chainMonth: string): Date => {
    const end = monthStart(chainMonth);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return end;
  };

  /**
   * The last instant a whole-month window may name.
   *
   * `to` is inclusive on this endpoint — `AuditRepository.chainSegment` filters
   * `lte: to` and `monthsBetween` enumerates the month `to` falls in — so a
   * window closed at `monthEnd` is closed at midnight on the *first* of the
   * next month and genuinely asks about two months, the second of them empty.
   * That is the endpoint answering the question it was asked; it is a
   * misleading way to say "this month", so the full-month windows below stop
   * one millisecond short of the boundary instead.
   */
  const monthEndInclusive = (chainMonth: string): Date =>
    new Date(monthEnd(chainMonth).getTime() - 1);

  /**
   * One privileged alteration, made as the owner with both row-level
   * protections suspended and restored before the transaction commits.
   *
   * The restore is the last statement of the happy path rather than a
   * `finally`: if `mutate` raises, PostgreSQL aborts the transaction and rolls
   * the catalogue change back with everything else, so there is no exit path
   * that leaves the store mutable — and a `finally` would only replace the real
   * error with a `25P02` from trying to run one more statement in an aborted
   * transaction.
   */
  async function tamper(mutate: (tx: PrismaService['client']) => Promise<void>): Promise<void> {
    await migrator.client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE audit_chain_head DISABLE TRIGGER audit_chain_head_forward_only',
        );

        await mutate(tx as unknown as PrismaService['client']);

        await tx.$executeRawUnsafe(
          'ALTER TABLE audit_chain_head ENABLE TRIGGER audit_chain_head_forward_only',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only',
        );
      },
      { maxWait: 10_000, timeout: 60_000 },
    );

    // Proven, not assumed. A suite that left a protection down would make every
    // assertion after it meaningless while still passing.
    expect(await disabledProtectiveTriggers(migrator)).toEqual([]);
  }

  function verifyQuery(overrides: Partial<AuditVerifyQuery> & { from: Date; to: Date }) {
    return { scope: 'ORGANIZATION' as const, ...overrides } satisfies AuditVerifyQuery;
  }

  const verify = (query: AuditVerifyQuery): Promise<AuditChainVerification> =>
    systemAdmin(() => verification.verify(query));

  beforeAll(async () => {
    prisma = newPrisma();
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    repository = new AuditRepository(prisma);
    verification = new AuditVerificationService(repository, silentLogger, ENV);
  }, 60_000);

  afterAll(async () => {
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 120_000);

  // -------------------------------------------------------------------------
  // A chain that is intact
  // -------------------------------------------------------------------------
  describe('a chain nobody has touched', () => {
    it('verifies a whole tenant month end to end', async () => {
      const organizationId = id('ORG-VALID');
      const records = await seedChain(organizationId, TENANT_MONTH, 5);

      const result = await verify(
        verifyQuery({
          from: monthStart(TENANT_MONTH),
          to: monthEndInclusive(TENANT_MONTH),
          organizationId,
        }),
      );

      expect(result.status).toBe('VALID');
      expect(result.valid).toBe(true);
      expect(result.firstDivergence).toBeNull();
      expect(result.recordsInRange).toBe(records.length);
      expect(result.recordsVerified).toBe(records.length);
      expect(result.unchainedRecords).toBe(0);
      expect(result.canonicalVersion).toBe(CANONICAL_VERSION);
      expect(result.months).toHaveLength(1);
      // The window starts at the chain's own first record, so nothing outside
      // it seeded the walk. Published rather than hidden, because it is the
      // weaker of the two statements this endpoint can make.
      expect(result.months[0]?.seededFromPredecessor).toBe(false);
      expect(result.months[0]?.status).toBe('VALID');
    });

    it('verifies the platform chain, which is nobody’s tenant', async () => {
      // In a month this run owns outright: the platform chain's key carries no
      // tenant and therefore nothing tag-shaped, so a fixed month would be
      // shared with every other run that ever wrote a platform-scoped row.
      const chainMonth = runMonth(1);
      const records = await seedChain(undefined, chainMonth, 4);

      const result = await verify(
        verifyQuery({
          from: monthStart(chainMonth),
          to: monthEndInclusive(chainMonth),
          scope: 'PLATFORM',
        }),
      );

      expect(result.status).toBe('VALID');
      expect(result.organizationId).toBeNull();
      expect(result.recordsVerified).toBe(records.length);
      expect(result.unchainedRecords).toBe(0);
    });

    it('verifies a mid-range window, seeded by a real predecessor and closed by a real successor', async () => {
      // The case that makes a partial verification mean anything. Without the
      // predecessor seed, a forger who rewrote a contiguous run of records —
      // links and all — would produce a run that agrees with itself; without
      // the successor check, deleting everything after the window would read as
      // "the head is simply ahead of you".
      const organizationId = id('ORG-MIDRANGE');
      const records = await seedChain(organizationId, TENANT_MONTH, 6);

      const result = await verify(
        verifyQuery({
          from: instantIn(TENANT_MONTH, 15),
          to: instantIn(TENANT_MONTH, 35),
          organizationId,
        }),
      );

      expect(result.status).toBe('VALID');
      expect(result.recordsInRange).toBe(2);
      expect(result.recordsVerified).toBe(2);
      expect(result.months[0]?.seededFromPredecessor).toBe(true);
      // And the window really did stop short of the tail, so the successor
      // check above was actually exercised.
      expect(records).toHaveLength(6);
    });
  });

  // -------------------------------------------------------------------------
  // A chain somebody privileged has touched
  // -------------------------------------------------------------------------
  describe('a privileged alteration is still visible', () => {
    it('reports RECORD_HASH_MISMATCH when a column changes under a stored digest', async () => {
      const organizationId = id('ORG-RECORD');
      const records = await seedChain(organizationId, TENANT_MONTH, 4);
      const target = records[2]!;

      await tamper(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE audit_event SET action = 'tampered.action' WHERE id = $1 AND organization_id = $2`,
          target.id,
          organizationId,
        );
      });

      const result = await verify(
        verifyQuery({
          from: monthStart(TENANT_MONTH),
          to: monthEndInclusive(TENANT_MONTH),
          organizationId,
        }),
      );

      expect(result.status).toBe('DIVERGENT');
      expect(result.valid).toBe(false);
      expect(result.firstDivergence?.reason).toBe('RECORD_HASH_MISMATCH');
      expect(result.firstDivergence?.auditEventId).toBe(target.id);
      expect(result.firstDivergence?.sequenceNo).toBe(target.sequenceNo.toString());
      // The two records before it verified, and the walk stopped there.
      expect(result.recordsVerified).toBe(2);
    });

    it('reports PREVIOUS_HASH_MISMATCH when a record is re-pointed at another predecessor', async () => {
      const organizationId = id('ORG-PREVIOUS');
      const records = await seedChain(organizationId, TENANT_MONTH, 4);
      const target = records[2]!;
      // Re-pointed at the chain's first record rather than at its real
      // predecessor: a full-length, genuinely-from-this-chain digest, which is
      // what an attacker splicing a segment out would write.
      const stolen = records[0]!.recordHash;

      await tamper(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE audit_event SET previous_hash = $3 WHERE id = $1 AND organization_id = $2`,
          target.id,
          organizationId,
          Buffer.from(stolen as Uint8Array),
        );
      });

      const result = await verify(
        verifyQuery({
          from: monthStart(TENANT_MONTH),
          to: monthEndInclusive(TENANT_MONTH),
          organizationId,
        }),
      );

      expect(result.status).toBe('DIVERGENT');
      expect(result.firstDivergence?.reason).toBe('PREVIOUS_HASH_MISMATCH');
      expect(result.firstDivergence?.auditEventId).toBe(target.id);
      expect(result.recordsVerified).toBe(2);
    });

    it('reports MISSING_CHAIN_LINK when a link is stripped from a chained record', async () => {
      // The reason `first_sequence_no` exists. A null `record_hash` below the
      // segment start is a pre-AUD-003 row; at or above it, it is a link that
      // was removed — and a verifier without the recorded boundary would have
      // to call both of them harmless legacy.
      const organizationId = id('ORG-STRIPPED');
      const records = await seedChain(organizationId, TENANT_MONTH, 4);
      const target = records[2]!;

      await tamper(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE audit_event SET record_hash = NULL, previous_hash = NULL
            WHERE id = $1 AND organization_id = $2`,
          target.id,
          organizationId,
        );
      });

      const result = await verify(
        verifyQuery({
          from: monthStart(TENANT_MONTH),
          to: monthEndInclusive(TENANT_MONTH),
          organizationId,
        }),
      );

      expect(result.status).toBe('DIVERGENT');
      expect(result.firstDivergence?.reason).toBe('MISSING_CHAIN_LINK');
      expect(result.firstDivergence?.auditEventId).toBe(target.id);
      // Never `UNVERIFIABLE_LEGACY`: the row sits at or above the recorded
      // segment start, so it was written into a chain that already existed.
      expect(result.status).not.toBe('UNVERIFIABLE_LEGACY');
    });

    it('reports CHAIN_HEAD_MISMATCH when the head names a record that is not the tail', async () => {
      const organizationId = id('ORG-HEADNAME');
      const records = await seedChain(organizationId, TENANT_MONTH, 3);
      const tail = records[2]!;

      await tamper(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE audit_chain_head SET head_event_id = $3
            WHERE chain_scope = 'ORGANIZATION'::audit_chain_scope
              AND organization_id = $1 AND chain_month = $2::date`,
          organizationId,
          TENANT_MONTH,
          `${tail.id}-NOT`,
        );
      });

      const result = await verify(
        verifyQuery({
          from: monthStart(TENANT_MONTH),
          to: monthEndInclusive(TENANT_MONTH),
          organizationId,
        }),
      );

      expect(result.status).toBe('DIVERGENT');
      expect(result.firstDivergence?.reason).toBe('CHAIN_HEAD_MISMATCH');
      // Reported at the window's last verified record, which is where the
      // disagreement was found.
      expect(result.firstDivergence?.auditEventId).toBe(tail.id);
    });

    it('reports CHAIN_TAIL_MISSING when a record after the window is deleted', async () => {
      // The failure a head-position check alone would wave through: the head
      // still names a real record further along, so "the chain continues past
      // your window" looks true — until the successor is asked to link back.
      const organizationId = id('ORG-TAIL');
      const records = await seedChain(organizationId, TENANT_MONTH, 5);
      const removed = records[3]!;

      await tamper(async (tx) => {
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_event WHERE id = $1 AND organization_id = $2`,
          removed.id,
          organizationId,
        );
      });

      const result = await verify(
        verifyQuery({
          // Stops before the deleted record, so the head is legitimately ahead.
          from: monthStart(TENANT_MONTH),
          to: instantIn(TENANT_MONTH, 25),
          organizationId,
        }),
      );

      expect(result.status).toBe('DIVERGENT');
      expect(result.firstDivergence?.reason).toBe('CHAIN_TAIL_MISSING');
      expect(result.firstDivergence?.auditEventId).toBe(records[2]!.id);
    });

    it('reports CHAIN_LENGTH_MISMATCH when the head counts a record the chain does not hold', async () => {
      const organizationId = id('ORG-LENGTH');
      await seedChain(organizationId, TENANT_MONTH, 4);

      await tamper(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE audit_chain_head SET chain_length = chain_length + 1
            WHERE chain_scope = 'ORGANIZATION'::audit_chain_scope
              AND organization_id = $1 AND chain_month = $2::date`,
          organizationId,
          TENANT_MONTH,
        );
      });

      const result = await verify(
        verifyQuery({
          from: monthStart(TENANT_MONTH),
          to: monthEndInclusive(TENANT_MONTH),
          organizationId,
        }),
      );

      expect(result.status).toBe('DIVERGENT');
      expect(result.firstDivergence?.reason).toBe('CHAIN_LENGTH_MISMATCH');
      expect(result.recordsVerified).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // The layers underneath — as the role the service actually runs as
  // -------------------------------------------------------------------------
  describe('the evidence table stays closed to the runtime role', () => {
    let organizationId: string;
    let chained: SeededRecord;

    beforeAll(async () => {
      organizationId = id('ORG-RUNTIME');
      chained = (await seedChain(organizationId, TENANT_MONTH, 1))[0]!;
      // The row genuinely carries a link, so what follows is an attempt to
      // rewrite chained evidence rather than a pre-AUD-003 row.
      expect(chained.recordHash).not.toBeNull();
    }, 60_000);

    it('refuses an ordinary UPDATE by privilege', async () => {
      await expect(
        prisma.client.$executeRawUnsafe(
          `UPDATE audit_event SET action = 'tampered' WHERE id = $1`,
          chained.id,
        ),
      ).rejects.toThrow(/42501|permission denied/i);
    });

    it('refuses the same UPDATE by trigger when the privilege is granted', async () => {
      // The second layer, measured with the first one removed. Granted and
      // revoked here rather than in a `beforeAll`, so the window in which the
      // runtime role can even attempt the statement is one assertion long.
      await migrator.client.$executeRawUnsafe('GRANT UPDATE ON audit_event TO rasta_audit');
      try {
        await expect(
          prisma.client.$executeRawUnsafe(
            `UPDATE audit_event SET action = 'tampered' WHERE id = $1`,
            chained.id,
          ),
        ).rejects.toThrow(/append-only/i);
      } finally {
        await migrator.client.$executeRawUnsafe('REVOKE UPDATE ON audit_event FROM rasta_audit');
      }

      const grants = await migrator.client.$queryRawUnsafe<{ privilege_type: string }[]>(
        `SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = current_schema() AND table_name = 'audit_event'
            AND grantee = 'rasta_audit'`,
      );
      expect(grants.map((grant) => grant.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
    });

    it('left the record exactly as the chain recorded it', async () => {
      const row = await prisma.client.auditEvent.findFirstOrThrow({
        where: { id: chained.id, organizationId },
        select: { action: true, recordHash: true, previousHash: true },
      });
      expect(row.action).not.toBe('tampered');
      expect(hex(row.recordHash)).toBe(hex(chained.recordHash));
      expect(row.previousHash).toBeNull();
    });
  });

  describe('the chain head refuses everything but a forward step', () => {
    let organizationId: string;
    let month: string;

    interface HeadRow {
      chain_length: bigint;
      head_event_id: string | null;
      head_sequence_no: bigint | null;
      first_sequence_no: bigint | null;
    }

    async function head(): Promise<HeadRow> {
      const rows = await prisma.client.$queryRawUnsafe<HeadRow[]>(
        `SELECT chain_length, head_event_id, head_sequence_no, first_sequence_no
           FROM audit_chain_head
          WHERE chain_scope = 'ORGANIZATION'::audit_chain_scope
            AND organization_id = $1 AND chain_month = $2::date`,
        organizationId,
        month,
      );
      const row = rows[0];
      if (!row) throw new Error(`no chain head for ${organizationId}/${month}`);
      return row;
    }

    /** An UPDATE the runtime role is fully privileged to attempt. */
    const attempt = (setClause: string, ...params: unknown[]): Promise<number> =>
      prisma.client.$executeRawUnsafe(
        `UPDATE audit_chain_head SET ${setClause}
          WHERE chain_scope = 'ORGANIZATION'::audit_chain_scope
            AND organization_id = $1 AND chain_month = $2::date`,
        organizationId,
        month,
        ...params,
      );

    beforeAll(async () => {
      organizationId = id('ORG-HEAD');
      month = TENANT_MONTH;
      await seedChain(organizationId, month, 2);
    }, 60_000);

    it('advances by exactly one when the writer writes', async () => {
      const before = await head();
      await seedChain(organizationId, month, 1, 60);
      const after = await head();

      expect(after.chain_length).toBe(before.chain_length + 1n);
      expect(after.head_sequence_no! > before.head_sequence_no!).toBe(true);
      expect(after.first_sequence_no).toBe(before.first_sequence_no);
    });

    it('refuses a rewind of the tip', async () => {
      const before = await head();
      await expect(
        attempt('chain_length = chain_length + 1, head_sequence_no = $3', before.first_sequence_no),
      ).rejects.toThrow(/must move forward/i);
    });

    it('refuses a re-key onto another tenant', async () => {
      // Moving a head from one chain to another hands one tenant's tip to
      // another tenant's writer.
      await expect(attempt('organization_id = $3', id('ORG-STOLEN'))).rejects.toThrow(
        /identity is immutable/i,
      );
    });

    it('refuses a re-key onto another month', async () => {
      await expect(attempt('chain_month = $3::date', '2027-08-01')).rejects.toThrow(
        /identity is immutable/i,
      );
    });

    it('refuses an advance of more than one record', async () => {
      await expect(attempt('chain_length = chain_length + 2')).rejects.toThrow(
        /exactly one record at a time/i,
      );
    });

    it('refuses moving the segment start', async () => {
      // The attack the column exists to stop: moving the boundary forward
      // reclassifies every record behind it as pre-chain legacy, which is how a
      // deleted link would be laundered past the verifier.
      const before = await head();
      await expect(
        attempt(
          'chain_length = chain_length + 1, head_sequence_no = $3, first_sequence_no = $4',
          (before.head_sequence_no as bigint) + 1000n,
          (before.first_sequence_no as bigint) + 1n,
        ),
      ).rejects.toThrow(/first_sequence_no is immutable/i);
    });

    it('refuses DELETE by privilege', async () => {
      await expect(
        prisma.client.$executeRawUnsafe(
          `DELETE FROM audit_chain_head WHERE organization_id = $1`,
          organizationId,
        ),
      ).rejects.toThrow(/42501|permission denied/i);
    });

    it('refuses TRUNCATE by privilege', async () => {
      await expect(prisma.client.$executeRawUnsafe('TRUNCATE audit_chain_head')).rejects.toThrow(
        /42501|permission denied/i,
      );
    });

    it('refuses DELETE and TRUNCATE by trigger even when the privileges are granted', async () => {
      // The layer that survives a later migration granting by mistake what this
      // one withholds. Granted for exactly these two assertions and revoked in
      // `finally`, with the restored grant list asserted below.
      await migrator.client.$executeRawUnsafe(
        'GRANT DELETE, TRUNCATE ON audit_chain_head TO rasta_audit',
      );
      try {
        await expect(
          prisma.client.$executeRawUnsafe(
            `DELETE FROM audit_chain_head WHERE organization_id = $1`,
            organizationId,
          ),
        ).rejects.toThrow(/forward-only/i);

        await expect(prisma.client.$executeRawUnsafe('TRUNCATE audit_chain_head')).rejects.toThrow(
          /forward-only/i,
        );
      } finally {
        await migrator.client.$executeRawUnsafe(
          'REVOKE DELETE, TRUNCATE ON audit_chain_head FROM rasta_audit',
        );
      }
    });

    it('restored the runtime grants and left every protection enabled', async () => {
      const grants = await migrator.client.$queryRawUnsafe<{ privilege_type: string }[]>(
        `SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = current_schema() AND table_name = 'audit_chain_head'
            AND grantee = 'rasta_audit'`,
      );
      // Exactly what the migration grants: the head advances, so UPDATE is
      // unavoidable — and it is why the head is a separate table from the
      // evidence, whose "no UPDATE at all" grant stays untouched.
      expect(grants.map((grant) => grant.privilege_type).sort()).toEqual([
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);

      expect(await disabledProtectiveTriggers(migrator)).toEqual([]);
    });

    it('still holds the chain it started with, unaltered', async () => {
      const after = await head();
      expect(after.chain_length).toBe(3n);
      expect(after.head_event_id).not.toBeNull();

      const result = await verify(
        verifyQuery({
          from: monthStart(month),
          to: monthEndInclusive(month),
          organizationId,
        }),
      );
      expect(result.status).toBe('VALID');
      expect(result.recordsVerified).toBe(3);
    });
  });
});
