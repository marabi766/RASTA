import type { EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditRepository } from '../src/audit/audit.repository';
import { DomainProjectorConsumer } from '../src/consumers/domain-projector.consumer';
import { cleanupRun, id, newMigratorPrisma, newPrisma } from './helpers';

/**
 * D-046 against the real database, through the real projector.
 *
 * Every event goes in by `DomainProjectorConsumer.handle` — the function the
 * shared Kafka consumer calls — so what is asserted is the whole path a
 * delivery takes after the broker: mapping, the contract, the one ingest
 * transaction and the table's own constraints. The broker leg itself is
 * `kafka-projector.int-spec.ts`.
 */
describe('payment-reconciliation evidence (real PostgreSQL)', () => {
  let prisma: PrismaService;
  let migrator: PrismaService;
  let projector: DomainProjectorConsumer;

  const delivery: EventDelivery = Object.freeze({ topic: 'rasta.economic.v1', partition: 0 });
  const silent = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;

  /** Every column the table has. A new one has to be added here on purpose. */
  const COLUMNS = [
    'actor',
    'approved_by',
    'audit_event_id',
    'event_name',
    'evidence_reference',
    'four_eyes',
    'kind',
    'occurred_at',
    'operator_action',
    'organization_id',
    'payment_intent_id',
    'projection_version',
    'proposed_by',
    'provider_outcome',
    'recorded_at',
    'requeue_id',
    'resolution',
    'resolution_id',
    'resolved_by',
    'source_event_id',
  ];

  interface Scenario {
    readonly org: string;
    readonly intent: string;
  }

  function scenario(): Scenario {
    return { org: id('ORG'), intent: id('PI') };
  }

  function envelope(
    at: Scenario,
    eventName: string,
    payload: Record<string, unknown>,
    overrides: Partial<EventEnvelope> = {},
  ): EventEnvelope {
    return {
      eventId: id('EVT'),
      eventName,
      eventVersion: 1,
      occurredAt: '2026-10-03T10:00:00.000Z',
      producer: 'economic-service',
      producerVersion: '1.0.0',
      aggregateType: 'PaymentIntent',
      aggregateId: at.intent,
      tenantId: at.org,
      correlationId: id('COR'),
      payload,
      ...overrides,
    } as EventEnvelope;
  }

  /** Shaped as `PaymentReconciler.apply` publishes an approved operator resolution. */
  function approved(at: Scenario, overrides: Record<string, unknown> = {}) {
    return envelope(at, 'PAYMENT_RECONCILIATION_RESOLVED', {
      paymentIntentId: at.intent,
      organizationId: at.org,
      walletId: 'wal_1',
      kind: 'REFUND',
      marker: 'REFUND_UNKNOWN',
      providerRefund: null,
      resolution: 'REFUNDED',
      resolvedBy: 'usr_approver',
      attempts: 3,
      amountMinor: '250000',
      currency: 'IRR',
      provider: 'mock',
      simulated: true,
      resolvedAt: '2026-10-03T10:00:00.000Z',
      resolutionId: 'res_approved_1',
      proposedBy: 'usr_proposer',
      approvedBy: 'usr_approver',
      evidenceReference: 'TICKET-9001',
      fourEyes: true,
      ...overrides,
    });
  }

  /** Shaped as `PaymentReconciliationOperator.enqueueAction` publishes. */
  function operatorAction(at: Scenario, overrides: Record<string, unknown> = {}) {
    return envelope(at, 'PAYMENT_RECONCILIATION_OPERATOR_ACTION', {
      paymentIntentId: at.intent,
      organizationId: at.org,
      walletId: 'wal_1',
      kind: 'UNCREDITED_REFUND',
      action: 'PROPOSED',
      actor: 'usr_proposer',
      requeueId: null,
      resolutionId: 'res_proposed_1',
      providerOutcome: 'NOT_REACHED',
      evidenceReference: 'doc:2026/10/03-77',
      proposedBy: 'usr_proposer',
      fourEyes: true,
      amountMinor: '250000',
      currency: 'IRR',
      provider: 'mock',
      simulated: true,
      occurredAt: '2026-10-03T10:00:00.000Z',
      ...overrides,
    });
  }

  async function evidenceOf(sourceEventId: string): Promise<Record<string, unknown>[]> {
    return prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
      'SELECT * FROM payment_reconciliation_evidence WHERE source_event_id = $1',
      sourceEventId,
    );
  }

  async function nothingWrittenFor(eventId: string): Promise<void> {
    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: eventId } })).toBe(0);
    expect(await prisma.client.processedEvent.count({ where: { eventId } })).toBe(0);
    expect(await evidenceOf(eventId)).toHaveLength(0);
  }

  beforeAll(async () => {
    prisma = newPrisma();
    migrator = newMigratorPrisma();
    await prisma.onModuleInit();
    await migrator.onModuleInit();
    projector = new DomainProjectorConsumer(
      () => {
        throw new Error('not started in this suite');
      },
      new AuditRepository(prisma),
      silent,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanupRun(migrator);
    await prisma.onModuleDestroy();
    await migrator.onModuleDestroy();
  }, 120_000);

  it('keeps proposer, approver, evidence reference and four-eyes of an approved resolution', async () => {
    const at = scenario();
    const event = approved(at);
    await projector.handle(event, delivery);

    const audit = await prisma.client.auditEvent.findFirstOrThrow({
      where: { sourceEventId: event.eventId },
    });
    const [row] = await evidenceOf(event.eventId);
    expect(row).toMatchObject({
      source_event_id: event.eventId,
      audit_event_id: audit.id,
      projection_version: 1,
      organization_id: at.org,
      event_name: 'PAYMENT_RECONCILIATION_RESOLVED',
      payment_intent_id: at.intent,
      kind: 'REFUND',
      resolution: 'REFUNDED',
      resolved_by: 'usr_approver',
      resolution_id: 'res_approved_1',
      proposed_by: 'usr_proposer',
      approved_by: 'usr_approver',
      evidence_reference: 'TICKET-9001',
      four_eyes: true,
      operator_action: null,
      actor: null,
      requeue_id: null,
      provider_outcome: null,
    });
    // The same instant as the audit row it belongs to, from the same record.
    expect((row?.occurred_at as Date).toISOString()).toBe(audit.occurredAt.toISOString());
    expect(audit.organizationId).toBe(at.org);
  });

  it("keeps the reconciler's own resolution with no operator fields", async () => {
    const at = scenario();
    const event = approved(at, {
      resolvedBy: 'PAYMENT_RECONCILER',
      resolutionId: undefined,
      proposedBy: undefined,
      approvedBy: undefined,
      evidenceReference: undefined,
      fourEyes: undefined,
    });
    await projector.handle(event, delivery);
    expect(await evidenceOf(event.eventId)).toEqual([
      expect.objectContaining({
        resolved_by: 'PAYMENT_RECONCILER',
        resolution_id: null,
        proposed_by: null,
        approved_by: null,
        evidence_reference: null,
        four_eyes: null,
      }),
    ]);
  });

  it('keeps an operator action by its action code and ids', async () => {
    const at = scenario();
    const proposal = operatorAction(at);
    const requeue = operatorAction(at, {
      action: 'REQUEUED',
      actor: 'usr_requeuer',
      requeueId: 'rq_1',
      resolutionId: null,
      providerOutcome: null,
      evidenceReference: null,
      proposedBy: null,
    });
    const rejection = operatorAction(at, { action: 'REJECTED', actor: 'usr_second' });
    for (const event of [proposal, requeue, rejection]) await projector.handle(event, delivery);

    expect(await evidenceOf(proposal.eventId)).toEqual([
      expect.objectContaining({
        event_name: 'PAYMENT_RECONCILIATION_OPERATOR_ACTION',
        operator_action: 'PROPOSED',
        actor: 'usr_proposer',
        resolution_id: 'res_proposed_1',
        provider_outcome: 'NOT_REACHED',
        evidence_reference: 'doc:2026/10/03-77',
        proposed_by: 'usr_proposer',
        four_eyes: true,
        requeue_id: null,
        resolution: null,
        resolved_by: null,
        approved_by: null,
      }),
    ]);
    expect(await evidenceOf(requeue.eventId)).toEqual([
      expect.objectContaining({
        operator_action: 'REQUEUED',
        actor: 'usr_requeuer',
        requeue_id: 'rq_1',
        resolution_id: null,
        evidence_reference: null,
      }),
    ]);
    expect(await evidenceOf(rejection.eventId)).toEqual([
      expect.objectContaining({
        operator_action: 'REJECTED',
        actor: 'usr_second',
        proposed_by: 'usr_proposer',
        resolution_id: 'res_proposed_1',
      }),
    ]);

    // The intent's history inside its tenant, in the order it happened.
    const history = await prisma.client.paymentReconciliationEvidence.findMany({
      where: { organizationId: at.org, paymentIntentId: at.intent },
    });
    expect(history.map((entry) => entry.operatorAction).sort()).toEqual([
      'PROPOSED',
      'REJECTED',
      'REQUEUED',
    ]);
  });

  it('stores no unknown or extra field, anywhere', async () => {
    const at = scenario();
    const smuggled = {
      reason: `SMUGGLED-REASON the payer phoned ${at.org}`,
      note: 'SMUGGLED-NOTE free text',
      issuer: 'https://SMUGGLED-ISSUER.example',
    };
    const event = approved(at, smuggled);
    await projector.handle(event, delivery);

    const [row] = await evidenceOf(event.eventId);
    expect(Object.keys(row ?? {}).sort()).toEqual(COLUMNS);
    const text = JSON.stringify(row);
    for (const marker of ['SMUGGLED', '250000', 'IRR', 'mock', 'wal_1']) {
      expect(text).not.toContain(marker);
    }
    // And the audit row stays as path A has always written it: no payload.
    const audit = await prisma.client.auditEvent.findFirstOrThrow({
      where: { sourceEventId: event.eventId },
    });
    expect(audit.changes).toBeNull();
    expect(audit.reason).toBeNull();
    expect(
      JSON.stringify(audit, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain('SMUGGLED');
  });

  it('writes nothing for a malformed known event, and refuses it to the dead-letter topic', async () => {
    const at = scenario();
    const cases = [
      approved(at, { evidenceReference: 'not a reference, a sentence' }),
      approved(at, { evidenceReference: undefined }),
      operatorAction(at, { action: 'APPROVED' }),
      operatorAction(at, { organizationId: id('ORG') }),
    ];
    for (const event of cases) {
      await expect(projector.handle(event, delivery)).rejects.toBeInstanceOf(
        UnprocessableEventError,
      );
      await nothingWrittenFor(event.eventId);
    }
    // Neither tenant got evidence from the mismatched one.
    expect(
      await prisma.client.paymentReconciliationEvidence.count({
        where: { organizationId: at.org },
      }),
    ).toBe(0);
  });

  it('writes one row for a delivery seen twice', async () => {
    const at = scenario();
    const event = approved(at);
    await projector.handle(event, delivery);
    await projector.handle(event, delivery);
    expect(await evidenceOf(event.eventId)).toHaveLength(1);
    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: event.eventId } })).toBe(
      1,
    );
  });

  it('projects nothing for the same names on another topic', async () => {
    const at = scenario();
    const event = envelope(
      at,
      'PAYMENT_RECONCILIATION_RESOLVED',
      {},
      {
        producer: 'marketplace-service',
      },
    );
    await projector.handle(event, { topic: 'rasta.marketplace.v1', partition: 0 });
    expect(await prisma.client.auditEvent.count({ where: { sourceEventId: event.eventId } })).toBe(
      1,
    );
    expect(await evidenceOf(event.eventId)).toHaveLength(0);
  });

  describe('the table itself', () => {
    async function oneRow(): Promise<string> {
      const event = approved(scenario());
      await projector.handle(event, delivery);
      return event.eventId;
    }

    it('refuses UPDATE, DELETE and TRUNCATE to the runtime role (no grant)', async () => {
      const eventId = await oneRow();
      for (const statement of [
        `UPDATE payment_reconciliation_evidence SET approved_by = 'someone_else' WHERE source_event_id = $1`,
        `DELETE FROM payment_reconciliation_evidence WHERE source_event_id = $1`,
      ]) {
        await expect(prisma.client.$executeRawUnsafe(statement, eventId)).rejects.toThrow(
          /permission denied/,
        );
      }
      await expect(
        prisma.client.$executeRawUnsafe('TRUNCATE payment_reconciliation_evidence'),
      ).rejects.toThrow(/permission denied/);
    });

    it('refuses UPDATE, DELETE and TRUNCATE to the owner too (trigger)', async () => {
      const eventId = await oneRow();
      for (const statement of [
        `UPDATE payment_reconciliation_evidence SET approved_by = 'someone_else' WHERE source_event_id = $1`,
        `DELETE FROM payment_reconciliation_evidence WHERE source_event_id = $1`,
      ]) {
        await expect(migrator.client.$executeRawUnsafe(statement, eventId)).rejects.toThrow(
          /ck_payment_reconciliation_evidence_append_only/,
        );
      }
      await expect(
        migrator.client.$executeRawUnsafe('TRUNCATE payment_reconciliation_evidence'),
      ).rejects.toThrow(/ck_payment_reconciliation_evidence_append_only/);
      expect(await evidenceOf(eventId)).toEqual([
        expect.objectContaining({ approved_by: 'usr_approver' }),
      ]);
    });

    /** A direct INSERT as the runtime role, bypassing the mapper. */
    async function insert(overrides: Record<string, unknown>): Promise<number> {
      const row: Record<string, unknown> = {
        source_event_id: id('EVT'),
        audit_event_id: id('AUD'),
        projection_version: 1,
        organization_id: id('ORG'),
        event_name: 'PAYMENT_RECONCILIATION_RESOLVED',
        payment_intent_id: id('PI'),
        kind: 'REFUND',
        resolution: 'REFUNDED',
        resolved_by: 'usr_b',
        resolution_id: 'res_1',
        proposed_by: 'usr_a',
        approved_by: 'usr_b',
        evidence_reference: 'TICKET-1',
        four_eyes: true,
        occurred_at: new Date('2026-10-03T10:00:00.000Z'),
        ...overrides,
      };
      const columns = Object.keys(row);
      const values = columns.map((_, index) => `$${index + 1}`).join(', ');
      return prisma.client.$executeRawUnsafe(
        `INSERT INTO payment_reconciliation_evidence (${columns.join(', ')}) VALUES (${values})`,
        ...Object.values(row),
      );
    }

    it('accepts the row the mapper would write', async () => {
      await expect(insert({})).resolves.toBe(1);
    });

    it.each([
      ['a version it does not know', { projection_version: 2 }, 'version'],
      ['an evidence reference that is prose', { evidence_reference: 'two words' }, 'values'],
      ['an actor with whitespace', { approved_by: 'usr a' }, 'values'],
      ['an unknown resolution code', { resolution: 'MAYBE' }, 'values'],
      ['an approver without evidence', { evidence_reference: null }, 'shape'],
      ['an operator action on a resolution', { operator_action: 'PROPOSED' }, 'shape'],
      [
        'a requeue that names a resolution',
        {
          event_name: 'PAYMENT_RECONCILIATION_OPERATOR_ACTION',
          operator_action: 'REQUEUED',
          actor: 'usr_a',
          resolution: null,
          resolved_by: null,
          approved_by: null,
          requeue_id: 'rq_1',
        },
        'shape',
      ],
    ])('refuses %s', async (_label, overrides, constraint) => {
      await expect(insert(overrides)).rejects.toThrow(
        new RegExp(`ck_payment_reconciliation_evidence_${constraint}`),
      );
    });
  });
});
