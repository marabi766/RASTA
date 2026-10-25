import type { EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';
import type { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
import { computeRecordHash, hashesEqual } from '../src/audit/audit.chain';
import { cleanupRun, id, instantIn, newMigratorPrisma, newPrisma, runMonth } from './helpers';

/**
 * economic-service's `COMMISSION_RULE_CHANGED`, ingested into the hashed audit
 * store (docs/23 D-057; Codex round 1 on #307, F5).
 *
 * The envelopes below are what economic publishes: v2 (ADR-045) for a rule
 * created and then deactivated — which, a rule being in force, ends it now —
 * and v1 for a type-only rule's record from before. Their payloads are checked
 * against economic's own contract by the pinned copy
 * (`commission-rule-change-projection.spec.ts`), and economic's
 * `rule-change-audit.int-spec.ts` asserts it publishes exactly this shape. What
 * this file proves is the rest of the way: the delta lands in `changes`, the
 * record hash covers it, and a payload economic could not have published
 * writes nothing.
 */
describe('commission rule changes in the audit store (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let repository: AuditRepository;

  const ECONOMIC: EventDelivery = Object.freeze({ topic: 'rasta.economic.v1', partition: 0 });
  const ORG = id('ORG');
  const month = runMonth(41);

  const terms = (overrides: Record<string, unknown> = {}) => ({
    organizationId: ORG,
    businessLine: 'MAINTENANCE',
    transactionType: null,
    rateBasisPoints: 120,
    minAmountMinor: null,
    maxAmountMinor: null,
    validFrom: instantIn(month, 1).toISOString(),
    validTo: null,
    status: 'ACTIVE',
    label: null,
    ...overrides,
  });

  function envelope(
    ruleId: string,
    payload: Record<string, unknown>,
    minutes: number,
    eventVersion = 2,
  ): EventEnvelope {
    return {
      eventId: id('EVT'),
      eventName: 'COMMISSION_RULE_CHANGED',
      eventVersion,
      occurredAt: instantIn(month, minutes).toISOString(),
      producer: 'economic-service',
      producerVersion: '1.0.0',
      aggregateType: 'CommissionRule',
      aggregateId: ruleId,
      tenantId: ORG,
      correlationId: id('COR'),
      actor: { type: 'USER', id: id('USR') },
      payload,
    } as EventEnvelope;
  }

  const change = (
    ruleId: string,
    kind: 'CREATED' | 'UPDATED',
    before: unknown,
    after: unknown,
  ) => ({
    ruleId,
    change: kind,
    changedBy: 'USR_ADMIN',
    changedAt: instantIn(month, 1).toISOString(),
    before,
    after,
  });

  async function ingest(source: EventEnvelope) {
    expect(
      await repository.ingest(toAuditEventRecord(source, ECONOMIC), DOMAIN_PROJECTOR_CONSUMER),
    ).toBe('WRITTEN');
    return prisma.client.auditEvent.findFirstOrThrow({ where: { sourceEventId: source.eventId } });
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

  it('keeps a created rule and its end-by-deactivation as before/after terms, in the hash', async () => {
    const ruleId = id('CMR');
    const created = await ingest(envelope(ruleId, change(ruleId, 'CREATED', null, terms()), 2));
    const endedAt = instantIn(month, 30).toISOString();
    const ended = await ingest(
      envelope(ruleId, change(ruleId, 'UPDATED', terms(), terms({ validTo: endedAt })), 30),
    );

    expect(created.changes).toEqual(
      expect.arrayContaining([
        { field: 'businessLine', from: null, to: 'MAINTENANCE' },
        { field: 'rateBasisPoints', from: null, to: 120 },
        { field: 'status', from: null, to: 'ACTIVE' },
      ]),
    );
    expect(ended.changes).toEqual([{ field: 'validTo', from: null, to: endedAt }]);
    expect(ended.resourceType).toBe('CommissionRule');
    expect(ended.resourceId).toBe(ruleId);

    // The stored delta is part of what the chain hashes: the digest reproduces
    // from the row as stored, and not from the same row with the delta gone.
    expect(hashesEqual(computeRecordHash(ended, ended.previousHash), ended.recordHash)).toBe(true);
    expect(
      hashesEqual(
        computeRecordHash({ ...ended, changes: null }, ended.previousHash),
        ended.recordHash,
      ),
    ).toBe(false);

    // Nothing of the payload outside the allow-list: who changed it is the
    // envelope's actor, not a copy of `changedBy`.
    const asText = JSON.stringify(ended, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(asText).not.toContain('USR_ADMIN');
  });

  it('keeps a v1 record of a type-only rule from before business lines', async () => {
    const ruleId = id('CMR');
    const { businessLine: _line, ...v1Terms } = terms({ transactionType: 'MAINTENANCE_SERVICE' });
    const row = await ingest(
      envelope(ruleId, change(ruleId, 'UPDATED', v1Terms, { ...v1Terms, label: 'بسته' }), 40, 1),
    );
    expect(row.changes).toEqual([{ field: 'label', from: null, to: 'بسته' }]);
  });

  it('writes nothing for a payload economic could not have published', async () => {
    const ruleId = id('CMR');
    const malformed = envelope(
      ruleId,
      change(ruleId, 'CREATED', null, terms({ rateBasisPoints: 'two hundred' })),
      50,
    );
    expect(() => toAuditEventRecord(malformed, ECONOMIC)).toThrow(UnprocessableEventError);
    expect(
      await prisma.client.auditEvent.count({ where: { sourceEventId: malformed.eventId } }),
    ).toBe(0);
  });
});
