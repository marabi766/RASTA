import request from 'supertest';
import type { Server } from 'node:http';
import type { EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';
import { AuditRepository } from '../src/audit/audit.repository';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
import { computeRecordHash, hashesEqual } from '../src/audit/audit.chain';
import { cleanupRun, id, newMigratorPrisma } from './helpers';
import { startApi, systemAdmin, type ApiHarness } from './api-helpers';
import { at, orgId, queryWindow } from './fixtures';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * economic-service's `SETTLEMENT_REFUSED` is stored as a refusal, and the search the runbook
 * prescribes finds it (docs/24 Q-29; docs/runbooks/settlement-no-active-rule.md; review of #364
 * round 1, F3) — real PostgreSQL, real guards, the real mapper: `outcome = REFUSED`, the closed
 * reason, the business line and transaction type in `changes`, all of it in the record hash, and
 * nothing else of the payload. economic's `settlement-no-active-rule.int-spec.ts` asserts it
 * publishes exactly this payload; the pinned copy (`settlement-refusal-projection.spec.ts`) holds
 * the two contracts equal.
 */
describe('refused settlements in the audit store (real PostgreSQL)', () => {
  let api: ApiHarness;
  let migrator: PrismaService;
  let repository: AuditRepository;
  let server: Server;

  const ORG = orgId('SETTLEMENT-REFUSAL');
  const PAYEE = orgId('SETTLEMENT-REFUSAL-PAYEE');
  const REFUSED_BY = id('USR');
  const ECONOMIC: EventDelivery = Object.freeze({ topic: 'rasta.economic.v1', partition: 0 });
  const window = queryWindow();
  const logistics = id('TXN');
  const maintenance = id('TXN');
  const settled = id('TXN');

  function envelope(
    eventName: string,
    transactionId: string,
    payload: Record<string, unknown>,
    occurredAt: Date,
  ): EventEnvelope {
    return {
      eventId: id('EVT'),
      eventName,
      eventVersion: 1,
      occurredAt: occurredAt.toISOString(),
      producer: 'economic-service',
      producerVersion: '1.0.0',
      aggregateType: 'Transaction',
      aggregateId: transactionId,
      tenantId: ORG,
      correlationId: id('COR'),
      actor: { type: 'USER', id: REFUSED_BY },
      payload,
    } as EventEnvelope;
  }

  /** What economic's `SettlementService.recordRefusal` publishes. */
  const refused = (
    transactionId: string,
    transactionType: string,
    businessLine: string,
    occurredAt: Date,
    overrides: Record<string, unknown> = {},
  ) =>
    envelope(
      'SETTLEMENT_REFUSED',
      transactionId,
      {
        transactionId,
        organizationId: ORG,
        payerOrganizationId: ORG,
        payeeOrganizationId: PAYEE,
        transactionType,
        businessLine,
        reason: 'NO_ACTIVE_RULE',
        refusedBy: REFUSED_BY,
        refusedAt: occurredAt.toISOString(),
        ...overrides,
      },
      occurredAt,
    );

  const sources = {
    logistics: refused(logistics, 'LOGISTICS', 'LOGISTICS', at(20)),
    maintenance: refused(maintenance, 'MAINTENANCE_SERVICE', 'MAINTENANCE', at(21)),
    settled: envelope('SETTLEMENT_COMPLETED', settled, { transactionId: settled }, at(22)),
  };

  beforeAll(async () => {
    migrator = newMigratorPrisma();
    await migrator.onModuleInit();
    api = await startApi();
    server = api.app.getHttpServer() as Server;
    repository = new AuditRepository(api.prisma);
    for (const source of Object.values(sources)) {
      expect(
        await repository.ingest(toAuditEventRecord(source, ECONOMIC), DOMAIN_PROJECTOR_CONSUMER),
      ).toBe('WRITTEN');
    }
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await cleanupRun(migrator);
    await migrator.onModuleDestroy();
  }, 120_000);

  const search = async (query: Record<string, string>) =>
    request(server)
      .get('/v1/audit-events')
      .query({ ...window, organizationId: ORG, limit: 50, ...query })
      .set('Authorization', `Bearer ${systemAdmin()}`);

  type Item = {
    action: string;
    outcome: string;
    reason: string | null;
    resourceType: string;
    resourceId: string;
    changes: unknown;
  };

  it('finds every refused settlement with the runbook’s search: outcome=REFUSED, its line and type', async () => {
    const response = await search({ outcome: 'REFUSED', action: 'SETTLEMENT_REFUSED' });
    expect(response.status).toBe(200);
    const items = (response.body.items as Item[]).sort((a, b) =>
      a.resourceId.localeCompare(b.resourceId),
    );
    const expected = [
      [logistics, 'LOGISTICS', 'LOGISTICS'],
      [maintenance, 'MAINTENANCE', 'MAINTENANCE_SERVICE'],
    ].sort(([a], [b]) => a!.localeCompare(b!));
    expect(items).toEqual(
      expected.map(([transactionId, line, type]) =>
        expect.objectContaining({
          action: 'SETTLEMENT_REFUSED',
          outcome: 'REFUSED',
          reason: 'NO_ACTIVE_RULE',
          resourceType: 'Transaction',
          resourceId: transactionId,
          changes: [
            { field: 'businessLine', from: line, to: line },
            { field: 'transactionType', from: type, to: type },
          ],
        }),
      ),
    );

    // One transaction's history, as the runbook's second search reads it.
    const one = await search({ resourceType: 'Transaction', resourceId: logistics });
    expect((one.body.items as Item[]).map((item) => [item.outcome, item.reason])).toEqual([
      ['REFUSED', 'NO_ACTIVE_RULE'],
    ]);

    // A settlement that went through is still a success, with nothing projected.
    const succeeded = await search({ outcome: 'SUCCESS', action: 'SETTLEMENT_COMPLETED' });
    expect(succeeded.body.items).toEqual([
      expect.objectContaining({ resourceId: settled, reason: null, changes: null }),
    ]);
  });

  it('hashes the reason and the line and type, and keeps nothing else of the payload', async () => {
    const row = await api.prisma.client.auditEvent.findFirstOrThrow({
      where: { sourceEventId: sources.logistics.eventId },
    });
    expect(hashesEqual(computeRecordHash(row, row.previousHash), row.recordHash)).toBe(true);
    expect(
      hashesEqual(computeRecordHash({ ...row, changes: null }, row.previousHash), row.recordHash),
    ).toBe(false);
    expect(
      hashesEqual(computeRecordHash({ ...row, reason: null }, row.previousHash), row.recordHash),
    ).toBe(false);

    // The payee and `refusedBy` are not copied out of the payload: who acted is the envelope's
    // actor, and the payee is not audit-row material.
    const asText = JSON.stringify(row, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(asText).not.toContain(PAYEE);
    expect(row.actorId).toBe(REFUSED_BY);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an amount, which the contract does not carry', { grossAmountMinor: '2000000' }],
    ['a reason outside the closed list', { reason: 'MISCONFIGURED' }],
    ['a line outside the contract', { businessLine: 'TAXI' }],
    ['no line', { businessLine: null }],
    ['another transaction than the envelope’s', { transactionId: id('TXN') }],
  ])('writes nothing for a payload economic could not have published: %s', async (_label, bad) => {
    const malformed = refused(id('TXN'), 'LOGISTICS', 'LOGISTICS', at(30), bad);
    expect(() => toAuditEventRecord(malformed, ECONOMIC)).toThrow(UnprocessableEventError);
    expect(
      await api.prisma.client.auditEvent.count({ where: { sourceEventId: malformed.eventId } }),
    ).toBe(0);
  });
});
