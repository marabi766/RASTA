import request from 'supertest';
import type { Server } from 'node:http';
import type { EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import { AuditRepository } from '../src/audit/audit.repository';
import { DOMAIN_PROJECTOR_CONSUMER, toAuditEventRecord } from '../src/audit/audit.mapper';
import { cleanupRun, id, newMigratorPrisma } from './helpers';
import { startApi, systemAdmin, type ApiHarness } from './api-helpers';
import { at, orgId, queryWindow } from './fixtures';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * A contract-service refusal is stored as a refusal, and a search for refusals finds it
 * (real PostgreSQL, real guards): the closed action and reason, `outcome = REFUSED`, nothing of
 * the payload besides.
 */
describe('contract refusals in the audit store (real PostgreSQL)', () => {
  let api: ApiHarness;
  let migrator: PrismaService;
  let repository: AuditRepository;
  let server: Server;

  const ORG = orgId('CONTRACT-REFUSAL');
  const delivery: EventDelivery = Object.freeze({ topic: 'rasta.contract.v1', partition: 0 });
  const window = queryWindow();
  const contractId = id('CTR');
  const policyId = id('POL');

  function envelope(
    eventName: string,
    payload: Record<string, unknown>,
    occurredAt: Date,
  ): EventEnvelope {
    return {
      eventId: id('EVT'),
      eventName,
      eventVersion: 1,
      occurredAt: occurredAt.toISOString(),
      producer: 'contract-service',
      producerVersion: '1.0.0',
      aggregateType: 'Contract',
      aggregateId: contractId,
      tenantId: ORG,
      correlationId: id('COR'),
      payload,
    } as EventEnvelope;
  }

  const authorityRefused = (
    action: string,
    reason: string,
    occurredAt: Date,
  ): { source: EventEnvelope } => ({
    source: envelope(
      'CONTRACT_AUTHORITY_REFUSED',
      {
        contractId,
        organizationId: ORG,
        action,
        side: 'EMPLOYER',
        subjectId: null,
        reason,
        policyId,
        refusedBy: id('USR'),
        refusedAt: occurredAt.toISOString(),
      },
      occurredAt,
    ),
  });

  beforeAll(async () => {
    migrator = newMigratorPrisma();
    await migrator.onModuleInit();
    api = await startApi();
    server = api.app.getHttpServer() as Server;
    repository = new AuditRepository(api.prisma);

    const records = [
      authorityRefused('SIGN_AMENDMENT', 'MEMBER_OF_BOTH_PARTIES', at(10)).source,
      authorityRefused('PLAN_MILESTONE', 'NOT_EMPLOYER', at(11)).source,
      envelope(
        'CONTRACT_SIGNATURE_REFUSED',
        {
          contractId,
          organizationId: ORG,
          side: 'EMPLOYER',
          reason: 'SIGNATURE_POLICY_REQUIRED',
          policyId: null,
          refusedBy: id('USR'),
          refusedAt: at(12).toISOString(),
        },
        at(12),
      ),
      envelope('CONTRACT_SIGNED', { contractId }, at(13)),
      authorityRefused('CANCEL_CONTRACT', 'PLATFORM_ADMINISTRATOR', at(14)).source,
      authorityRefused('DRAFT_STATEMENT', 'NOT_CONTRACTOR', at(16)).source,
      {
        ...envelope(
          'APPROVAL_POLICY_APPROVAL_REFUSED',
          {
            policyId,
            organizationId: ORG,
            workflowKey: 'contract.signature',
            policyVersion: 1,
            reason: 'SELF_APPROVAL',
            refusedBy: id('USR'),
            refusedAt: at(15).toISOString(),
          },
          at(15),
        ),
        aggregateType: 'ApprovalPolicy',
        aggregateId: policyId,
      },
    ];
    for (const source of records) {
      await repository.ingest(toAuditEventRecord(source, delivery), DOMAIN_PROJECTOR_CONSUMER);
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

  it('finds every contract refusal with outcome=REFUSED, under its closed action and reason', async () => {
    const response = await search({ outcome: 'REFUSED' });

    expect(response.status).toBe(200);
    const items = response.body.items as { action: string; reason: string; outcome: string }[];
    expect(items.map((item) => [item.action, item.reason, item.outcome]).sort()).toEqual([
      ['APPROVE_POLICY', 'SELF_APPROVAL', 'REFUSED'],
      ['CANCEL_CONTRACT', 'PLATFORM_ADMINISTRATOR', 'REFUSED'],
      ['DRAFT_STATEMENT', 'NOT_CONTRACTOR', 'REFUSED'],
      ['PLAN_MILESTONE', 'NOT_EMPLOYER', 'REFUSED'],
      ['SIGN_AMENDMENT', 'MEMBER_OF_BOTH_PARTIES', 'REFUSED'],
      ['SIGN_CONTRACT', 'SIGNATURE_POLICY_REQUIRED', 'REFUSED'],
    ]);
  });

  it('narrows by the closed action, and leaves a success a success', async () => {
    const refused = await search({ outcome: 'REFUSED', action: 'SIGN_AMENDMENT' });
    expect(refused.body.items).toHaveLength(1);
    const drafts = await search({ outcome: 'REFUSED', action: 'DRAFT_STATEMENT' });
    expect(drafts.body.items.map((item: { reason: string }) => item.reason)).toEqual([
      'NOT_CONTRACTOR',
    ]);

    const succeeded = await search({ outcome: 'SUCCESS' });
    expect(succeeded.body.items).toHaveLength(1);
    expect(succeeded.body.items[0].action).toBe('CONTRACT_SIGNED');
    expect(succeeded.body.items[0].reason).toBeNull();
  });

  it('stores nothing of the payload: no policy, subject or actor id outside the row’s own fields', async () => {
    const row = await api.prisma.client.auditEvent.findFirstOrThrow({
      where: { organizationId: ORG, action: 'SIGN_AMENDMENT' },
    });
    expect(row.changes).toBeNull();
    const text = JSON.stringify(row, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(text).not.toContain(policyId);
  });

  it('finds a refused policy approval by its action, on the policy it names', async () => {
    const refused = await search({ outcome: 'REFUSED', action: 'APPROVE_POLICY' });
    expect(refused.status).toBe(200);
    expect(refused.body.items).toHaveLength(1);
    expect(refused.body.items[0]).toMatchObject({
      reason: 'SELF_APPROVAL',
      resourceType: 'ApprovalPolicy',
      resourceId: policyId,
    });
  });
});
