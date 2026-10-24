import type { Server } from 'node:http';
import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { ulid } from 'ulid';
import { DLQ_HEADERS, DLQ_REASONS, MAX_AMOUNT_MINOR, type EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  InternalTokenService,
  RastaError,
  runUnscoped,
  UnprocessableEventError,
  type ConsumerLogger,
} from '@rasta/nest-common';
import { StatementSettlementConsumer } from '../src/consumers/statement-settlement.consumer';
import { SourceFactsClient, type StatementFact } from '../src/provenance/source-facts.client';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { BusinessLine } from '../src/generated/prisma';
import {
  admin,
  apiTenant,
  internalToken,
  platformAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import { StubContractService } from './contract-service.stub';
import {
  asActor,
  cleanup,
  fundWallet,
  id,
  newPrisma,
  readBalances,
  tenants,
  wire,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 6b (ADR-068 § 6 (2), A-13): an approved contract statement
 * becomes exactly one settleable obligation, built from contract-service's
 * answer and never from the event.
 *
 * contract-service is a local HTTP stand-in that holds the real route's lock
 * (`StubContractService`). The client is the real `SourceFactsClient`, so the token, the
 * timeout and the three answers are the production path. Everything below the
 * handler — the transaction, `processed_event`, the unique key, the CHECK and
 * the trigger — is the real database.
 */

const SECRET = 'itest_internal_secret_at_least_32_characters';
const REQUEST_TIMEOUT_MS = 400;

describe('STATEMENT_APPROVED → one settleable obligation (CON-003 PR 6b)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let consumer: StatementSettlementConsumer;
  const org = tenants();
  const employer = org.a;
  const contractor = org.b;
  const stranger = org.c;
  const tokens = new InternalTokenService(SECRET, 'rasta-internal', 60);
  const contract = new StubContractService(tokens);

  const noBroker = (): EventConsumer =>
    ({ start: async () => undefined, stop: async () => undefined }) as unknown as EventConsumer;

  const consumerWith = (businessLine: BusinessLine | null, w: Wiring = wiring, p = prisma) =>
    new StatementSettlementConsumer(
      noBroker,
      p,
      w.transactions,
      new SourceFactsClient({
        maintenanceBaseUrl: 'http://127.0.0.1:9',
        fleetBaseUrl: 'http://127.0.0.1:9',
        contractBaseUrl: contract.url,
        timeoutMs: REQUEST_TIMEOUT_MS,
        tokens,
      }),
      businessLine,
    );

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    wiring = wire(prisma);
    await contract.start();
    consumer = consumerWith(null);
  });

  afterEach(() => {
    contract.mode = 'up';
  });

  afterAll(async () => {
    await contract.stop();
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  /** An approved statement as contract-service stores it, and the event that announces it. */
  function approved(overrides: Partial<StatementFact> = {}) {
    const fact = contract.record({
      statementId: `STM_${ulid()}`,
      contractId: `CTR_${ulid()}`,
      status: 'APPROVED',
      netMinor: '7350000',
      currency: 'IRR',
      payerOrganizationId: employer,
      beneficiaryOrganizationId: contractor,
      approvedAt: new Date().toISOString(),
      ...overrides,
    });
    const payload: Record<string, unknown> = {
      contractId: fact.contractId,
      statementId: fact.statementId,
      statementNumber: 1,
      organizationId: fact.payerOrganizationId,
      contractorOrganizationId: fact.beneficiaryOrganizationId,
      approvedAt: fact.approvedAt ?? new Date().toISOString(),
    };
    return { fact, payload };
  }

  /** Shaped as contract-service publishes it — by hand, not imported (A-02). */
  function envelope(
    payload: Record<string, unknown>,
    overrides: Partial<EventEnvelope> = {},
  ): EventEnvelope {
    return {
      eventId: ulid(),
      eventName: 'STATEMENT_APPROVED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'contract-service',
      producerVersion: '0.1.0',
      // contract-service keys every statement event by its contract (routing.ts).
      aggregateType: 'Contract',
      aggregateId: String(payload.contractId),
      tenantId: String(payload.organizationId),
      correlationId: `statement-itest-${ulid()}`,
      payload,
      ...overrides,
    } as EventEnvelope;
  }

  const obligationsOf = (statementId: string, client = prisma) =>
    runUnscoped('the suite counts a statement’s obligations across the whole table', () =>
      client.client.transaction.findMany({
        where: { sourceType: 'STATEMENT', sourceReference: statementId },
        include: { legs: true },
      }),
    );

  const processedCount = (eventId: string) =>
    runUnscoped('the suite reads the processed-event ledger', () =>
      prisma.client.processedEvent.count({
        where: { eventId, consumerName: StatementSettlementConsumer.CONSUMER_NAME },
      }),
    );

  const journalsOf = (organizationId: string) =>
    runUnscoped('the suite counts journals of one organization', () =>
      prisma.client.journal.count({ where: { organizationId } }),
    );

  async function refusal(promise: Promise<unknown>): Promise<UnprocessableEventError> {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnprocessableEventError);
    return error as UnprocessableEventError;
  }

  describe('the obligation, from the owner’s answer', () => {
    it('records one PENDING_SETTLEMENT obligation with the response’s net, payer, beneficiary and currency, and moves no money', async () => {
      const { walletId } = await fundWallet(wiring, employer, 1_000_000n);
      const before = await readBalances(prisma, walletId);
      const journalsBefore = await journalsOf(employer);
      const { fact, payload } = approved();
      // A forged or defective event cannot set the amount: none is read from it.
      const lying = envelope({ ...payload, netMinor: '1', amountMinor: '2', grossMinor: '3' });

      await expect(consumer.handle(lying)).resolves.toBeUndefined();

      const [row, ...more] = await obligationsOf(fact.statementId);
      expect(more).toHaveLength(0);
      expect(row).toMatchObject({
        organizationId: employer,
        counterpartyOrganizationId: contractor,
        transactionType: 'CONSTRUCTION_STATEMENT',
        businessLine: null,
        status: 'PENDING_SETTLEMENT',
        grossAmountMinor: 7_350_000n,
        currency: 'IRR',
        sourceType: 'STATEMENT',
        sourceReference: fact.statementId,
        causationId: lying.eventId,
        correlationId: lying.correlationId,
        createdBy: 'economic-service',
        idempotencyKey: null,
      });
      expect(row!.occurredAt.toISOString()).toBe(fact.approvedAt);
      expect(row!.legs.map((leg) => [leg.organizationId, leg.amountMinor]).sort()).toEqual(
        [
          [employer, 7_350_000n],
          [contractor, 7_350_000n],
        ].sort(),
      );
      // Asked once, of its employer, with a token signed for it.
      expect(contract.asked.filter((a) => a.statementId === fact.statementId)).toEqual([
        { statementId: fact.statementId, organizationId: employer },
      ]);
      expect(await processedCount(lying.eventId)).toBe(1);

      // No hold, no journal, no balance change (ADR-032).
      expect(await readBalances(prisma, walletId)).toEqual(before);
      expect(await journalsOf(employer)).toBe(journalsBefore);

      // The catalogue's record of it, in the same transaction (ADR-021).
      const outbox = await runUnscoped('the suite reads the outbox', () =>
        prisma.client.outboxMessage.findMany({ where: { aggregateId: row!.id } }),
      );
      expect(outbox.map((m) => m.eventName)).toEqual(['TRANSACTION_STATUS_CHANGED']);
      expect(outbox[0]!.payload).toMatchObject({
        eventName: 'TRANSACTION_STATUS_CHANGED',
        causationId: lying.eventId,
        correlationId: lying.correlationId,
        payload: {
          transactionId: row!.id,
          organizationId: employer,
          counterpartyOrganizationId: contractor,
          transactionType: 'CONSTRUCTION_STATEMENT',
          action: 'RECORD_AUTHORISED_OBLIGATION',
          fromStatus: null,
          toStatus: 'PENDING_SETTLEMENT',
          grossAmountMinor: '7350000',
          currency: 'IRR',
        },
      });
    });

    it('records exactly 2^63 - 1, the largest net any owner can store', async () => {
      const { fact, payload } = approved({ netMinor: MAX_AMOUNT_MINOR.toString() });

      await consumer.handle(envelope(payload));

      const [row] = await obligationsOf(fact.statementId);
      expect(row!.grossAmountMinor).toBe(MAX_AMOUNT_MINOR);
      expect(row!.legs.every((leg) => leg.amountMinor === MAX_AMOUNT_MINOR)).toBe(true);
    });

    it('records nothing for a net of zero, and marks the event processed', async () => {
      const { fact, payload } = approved({ netMinor: '0' });
      const event = envelope(payload);

      await expect(consumer.handle(event)).resolves.toBe('SKIPPED');

      expect(await obligationsOf(fact.statementId)).toHaveLength(0);
      expect(await processedCount(event.eventId)).toBe(1);
    });

    it('ignores every other contract event on the topic, writing nothing', async () => {
      const { fact, payload } = approved();
      const drafted = envelope(payload, { eventName: 'STATEMENT_SUBMITTED' });

      await expect(consumer.handle(drafted)).resolves.toBe('SKIPPED');
      expect(await obligationsOf(fact.statementId)).toHaveLength(0);
      expect(await processedCount(drafted.eventId)).toBe(0);
      expect(contract.asked.some((a) => a.statementId === fact.statementId)).toBe(false);
    });
  });

  describe('idempotency', () => {
    it('has no second effect for a redelivery, and does not ask the owner again', async () => {
      const { fact, payload } = approved();
      const event = envelope(payload);

      await consumer.handle(event);
      await expect(consumer.handle(event)).resolves.toBe('SKIPPED');

      expect(await obligationsOf(fact.statementId)).toHaveLength(1);
      expect(await processedCount(event.eventId)).toBe(1);
      expect(contract.asked.filter((a) => a.statementId === fact.statementId)).toHaveLength(1);
    });

    it('records one obligation for an approval re-emitted under a new event id', async () => {
      const { fact, payload } = approved();
      const first = envelope(payload);
      const again = envelope(payload);

      await consumer.handle(first);
      await consumer.handle(again);

      const rows = await obligationsOf(fact.statementId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.causationId).toBe(first.eventId);
      expect(await processedCount(again.eventId)).toBe(1);
    });

    it('records one obligation when duplicates arrive concurrently — new ids and the same id', async () => {
      const { fact, payload } = approved();
      const same = envelope(payload);
      const deliveries = [...Array.from({ length: 5 }, () => envelope(payload)), same, same, same];

      const outcomes = await Promise.allSettled(deliveries.map((e) => consumer.handle(e)));

      // A loser of the same-id race fails on the processed marker and is retried;
      // it is never a verdict, and its retry has no effect.
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).not.toBeInstanceOf(UnprocessableEventError);
          await expect(consumer.handle(deliveries[index]!)).resolves.toBe('SKIPPED');
        }
      }
      expect(await obligationsOf(fact.statementId)).toHaveLength(1);
      for (const delivery of new Set(deliveries)) {
        expect(await processedCount(delivery.eventId)).toBe(1);
      }
    });

    it('lets the unique key decide a race the fast path cannot see', async () => {
      // The first writer inserts and holds its commit open; the second is seen
      // blocked on that insert's lock before the first may commit.
      const { fact } = approved();
      const terms = {
        organizationId: employer,
        counterpartyOrganizationId: contractor,
        transactionType: 'CONSTRUCTION_STATEMENT' as const,
        businessLine: null,
        grossAmountMinor: BigInt(fact.netMinor),
        currency: 'IRR',
        occurredAt: new Date(fact.approvedAt!),
        sourceType: 'STATEMENT',
        sourceReference: fact.statementId,
        causationId: ulid(),
      };
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstInserted!: () => void;
      const insertedByFirst = new Promise<void>((resolve) => (firstInserted = resolve));

      const first = asActor({ organizationId: employer }, () =>
        prisma.transaction(async (tx) => {
          const result = await wiring.transactions.recordAuthorisedObligation(tx, terms);
          firstInserted();
          await firstMayCommit;
          return result;
        }),
      );
      await insertedByFirst;
      const second = asActor({ organizationId: employer }, () =>
        prisma.transaction((tx) => wiring.transactions.recordAuthorisedObligation(tx, terms)),
      );
      await untilAnInsertWaits(prisma);
      releaseFirst();

      const [a, b] = await Promise.all([first, second]);
      expect(a.created).toBe(true);
      expect(b).toEqual({ id: a.id, created: false });
      const rows = await obligationsOf(fact.statementId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.legs).toHaveLength(2);
    });
  });

  describe('refused before any effect (SOURCE_UNCONFIRMED)', () => {
    it.each(['DRAFT', 'SUBMITTED', 'TECHNICALLY_APPROVED', 'REJECTED'])(
      'a statement contract-service holds as %s',
      async (status) => {
        const { fact, payload } = approved({ status, approvedAt: null });
        const event = envelope({ ...payload, approvedAt: new Date().toISOString() });

        const error = await refusal(consumer.handle(event));

        expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
        expect(error.message).toBe(
          `contract-service does not confirm STATEMENT_APPROVED for ${fact.statementId}: status_mismatch`,
        );
        expect(await obligationsOf(fact.statementId)).toHaveLength(0);
        expect(await processedCount(event.eventId)).toBe(0);
      },
    );

    it.each([
      ['an unknown statement', 'not_found'],
      ['another contract', 'contract_mismatch'],
      ['another contractor', 'beneficiary_mismatch'],
      ['another approval instant', 'approval_mismatch'],
      ['a currency no wallet is kept in', 'currency_mismatch'],
    ])('a claim the owner does not confirm: %s', async (_case, mismatch) => {
      const { fact, payload } = approved(
        mismatch === 'currency_mismatch' ? { currency: 'USD' } : {},
      );
      const claim = { ...payload };
      if (mismatch === 'not_found') claim.statementId = `STM_${ulid()}`;
      if (mismatch === 'contract_mismatch') claim.contractId = `CTR_${ulid()}`;
      if (mismatch === 'beneficiary_mismatch') claim.contractorOrganizationId = stranger;
      if (mismatch === 'approval_mismatch') claim.approvedAt = '2026-01-01T00:00:00.000Z';
      const event = envelope(claim);

      const error = await refusal(consumer.handle(event));

      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(error.message).toMatch(new RegExp(`: ${mismatch}$`));
      expect(await obligationsOf(fact.statementId)).toHaveLength(0);
      expect(await obligationsOf(String(claim.statementId))).toHaveLength(0);
      expect(await processedCount(event.eventId)).toBe(0);
    });

    it('another employer’s claim on a real statement: the owner, asked for that employer, finds nothing', async () => {
      const { fact, payload } = approved();
      const event = envelope({ ...payload, organizationId: stranger }, { tenantId: stranger });

      const error = await refusal(consumer.handle(event));

      expect(error.message).toMatch(/: not_found$/);
      expect(contract.asked.filter((a) => a.statementId === fact.statementId)).toEqual([
        { statementId: fact.statementId, organizationId: stranger },
      ]);
      expect(await obligationsOf(fact.statementId)).toHaveLength(0);
    });

    it.each([
      ['for another tenant than the payload’s employer', stranger],
      ['with no tenant', undefined],
    ])('an envelope %s: refused before the owner is asked', async (_case, tenantId) => {
      const { fact, payload } = approved();
      const event = envelope(payload, { tenantId: tenantId as string });

      const error = await refusal(consumer.handle(event));

      expect(error.message).toMatch(/: tenant_mismatch$/);
      expect(contract.asked.some((a) => a.statementId === fact.statementId)).toBe(false);
      expect(await obligationsOf(fact.statementId)).toHaveLength(0);
    });

    it('a payload that is not the published contract: VALIDATION_FAILED, naming fields only', async () => {
      const { fact, payload } = approved();
      const event = envelope({ ...payload, contractorOrganizationId: undefined });

      const error = await refusal(consumer.handle(event));

      expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
      expect(error.message).toContain('contractorOrganizationId');
      expect(error.message).not.toContain(contractor);
      expect(await obligationsOf(fact.statementId)).toHaveLength(0);
    });
  });

  describe('contract-service unavailable: retried, then dead-lettered, funds untouched', () => {
    it('throws a retryable UPSTREAM_UNAVAILABLE when the owner answers 5xx, and records nothing', async () => {
      contract.mode = 'down';
      const { fact, payload } = approved();
      const event = envelope(payload);

      const error = await consumer.handle(event).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RastaError);
      expect(error).not.toBeInstanceOf(UnprocessableEventError);
      expect((error as RastaError).code).toBe('UPSTREAM_UNAVAILABLE');
      expect(await obligationsOf(fact.statementId)).toHaveLength(0);
      expect(await processedCount(event.eventId)).toBe(0);
    });

    it('gives up on a silent owner within the bounded timeout, holding no transaction', async () => {
      contract.mode = 'hang';
      const { fact, payload } = approved();
      const started = Date.now();

      const pending = consumer.handle(envelope(payload)).catch((e: unknown) => e);
      // While the owner is silent, the question is outside any transaction: no
      // session of this database sits idle in one, holding a connection or a lock.
      await new Promise((resolve) => setTimeout(resolve, REQUEST_TIMEOUT_MS / 2));
      const [row] = await prisma.client.$queryRaw<{ open: bigint }[]>`
        SELECT count(*) AS open FROM pg_stat_activity
         WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
      expect(contract.asked.some((a) => a.statementId === fact.statementId)).toBe(true);
      const error = await pending;

      expect(Number(row!.open)).toBe(0);
      expect((error as RastaError).code).toBe('UPSTREAM_TIMEOUT');
      expect(Date.now() - started).toBeLessThan(REQUEST_TIMEOUT_MS + 2_000);
      expect(await obligationsOf(fact.statementId)).toHaveLength(0);
    });

    it('through the real EventConsumer: three attempts, UPSTREAM_UNAVAILABLE in the DLQ, no money moved, then a replay records it', async () => {
      const { walletId } = await fundWallet(wiring, employer, 500_000n);
      const before = await readBalances(prisma, walletId);
      const journalsBefore = await journalsOf(employer);
      const { fact, payload } = approved();
      const event = envelope(payload);

      for (const mode of ['down', 'hang'] as const) {
        contract.mode = mode;
        const { deliver, dlq, lines } = realConsumerOver(consumer);
        await deliver(event);

        expect(lines.filter((line) => line.startsWith('warn Attempt'))).toHaveLength(2);
        expect(dlq.sent).toHaveLength(1);
        const headers = dlq.sent[0]!.messages[0]!.headers;
        expect(headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.UPSTREAM_UNAVAILABLE);
        expect(await obligationsOf(fact.statementId)).toHaveLength(0);
        expect(await processedCount(event.eventId)).toBe(0);
      }
      expect(await readBalances(prisma, walletId)).toEqual(before);
      expect(await journalsOf(employer)).toBe(journalsBefore);

      // The owner is back; the DLQ replay of the same event applies once.
      contract.mode = 'up';
      await consumer.handle(event);
      expect(await obligationsOf(fact.statementId)).toHaveLength(1);
      expect(await readBalances(prisma, walletId)).toEqual(before);
    });

    /**
     * Task 011: the net's bound refinement ran on a net the pattern had refused, and `BigInt`
     * threw a SyntaxError carrying the owner's text out of the client — retried, then
     * MAX_RETRIES_EXCEEDED with that text in x-dlq-error. A malformed net is a body that does
     * not parse: the client's UPSTREAM_UNAVAILABLE, the path every unparseable answer takes.
     */
    describe('an owner whose net is malformed', () => {
      const SENTINEL = 'private-invoice-reference-123';

      it.each([
        ['a fractional net', '12.5'],
        ['a net in letters', 'abc'],
        ['a net that is free text', SENTINEL],
      ])(
        'through the real EventConsumer: %s is UPSTREAM_UNAVAILABLE, the partition moves on, nothing is recorded, the text is nowhere',
        async (_label, netMinor) => {
          const { walletId } = await fundWallet(wiring, employer, 500_000n);
          const before = await readBalances(prisma, walletId);
          const { fact, payload } = approved({ netMinor });
          const event = envelope(payload);
          const nest = captureNestLogs();

          const broker = await brokerOver(consumer);
          try {
            await broker.deliver(event, '41');
          } finally {
            nest.restore();
            await broker.stop();
          }

          // Retried as an owner that could not be asked, never acted on, then dead-lettered.
          expect(broker.lines.filter((line) => line.startsWith('warn Attempt'))).toHaveLength(2);
          expect(broker.dlq.sent).toHaveLength(1);
          const headers = broker.dlq.sent[0]!.messages[0]!.headers;
          expect(headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.UPSTREAM_UNAVAILABLE);
          // The dead letter written, the offset is committed: the partition is not held.
          expect(broker.committed).toEqual(['41']);
          expect(broker.uncommitted).toEqual([]);
          // Every question was signed for the employer the event names (ADR-061 § 4).
          const asked = contract.asked.filter((a) => a.statementId === fact.statementId);
          expect(asked).toHaveLength(3);
          expect(asked.every((a) => a.organizationId === employer)).toBe(true);
          // No obligation, no marker, no money.
          expect(await obligationsOf(fact.statementId)).toHaveLength(0);
          expect(await processedCount(event.eventId)).toBe(0);
          expect(await readBalances(prisma, walletId)).toEqual(before);
          if (netMinor === SENTINEL) {
            const written = [
              ...broker.lines,
              ...nest.lines(),
              ...Object.values(headers).map((value) =>
                Buffer.isBuffer(value) ? value.toString('utf8') : String(value),
              ),
            ].join('\n');
            expect(written).not.toContain(SENTINEL);
          }

          // The owner corrects its answer; the replay of the same event records it once …
          contract.record({ ...fact, netMinor: '7350000' });
          await expect(consumer.handle(event)).resolves.toBeUndefined();
          expect(await obligationsOf(fact.statementId)).toHaveLength(1);
          expect(await processedCount(event.eventId)).toBe(1);
          // … and a duplicate delivery is no second effect.
          await expect(consumer.handle(event)).resolves.toBe('SKIPPED');
          expect(await obligationsOf(fact.statementId)).toHaveLength(1);
        },
      );

      it('leaves the offset uncommitted when the dead letter cannot be written', async () => {
        const { fact, payload } = approved({ netMinor: '12.5' });
        const event = envelope(payload);

        const broker = await brokerOver(consumer, { dlqFails: true });
        try {
          await broker.deliver(event, '42');
        } finally {
          await broker.stop();
        }

        expect(broker.committed).toEqual([]);
        expect(broker.uncommitted.map((entry) => entry.offset)).toEqual(['42']);
        // Held because the dead letter's send failed, and for no other reason.
        expect(String(broker.uncommitted[0]!.error)).toContain('The dead-letter broker is down');
        expect(await obligationsOf(fact.statementId)).toHaveLength(0);
        expect(await processedCount(event.eventId)).toBe(0);
      });
    });
  });

  describe('commission from economic-service’s own rules (ADR-045 § 4)', () => {
    const rule = (
      organizationId: string,
      rateBasisPoints: number,
      scope: {
        businessLine: BusinessLine | null;
        transactionType: 'CONSTRUCTION_STATEMENT' | null;
      },
    ) =>
      runUnscoped('the suite seeds a commission rule for one payee', () =>
        prisma.client.commissionRule.create({
          data: {
            id: id('CMR'),
            organizationId,
            ...scope,
            rateBasisPoints,
            validFrom: new Date(Date.now() - 60_000),
            status: 'ACTIVE',
            createdBy: 'itest',
            updatedBy: 'itest',
          },
        }),
      );

    it('prices the obligation with the payee’s type rule at approval, and the existing settle path charges it', async () => {
      const payee = `${contractor}-FEE`;
      const fee = await rule(payee, 300, {
        businessLine: null,
        transactionType: 'CONSTRUCTION_STATEMENT',
      });
      await fundWallet(wiring, employer, 20_000_000n);
      const { fact, payload } = approved({
        beneficiaryOrganizationId: payee,
        netMinor: '10000000',
      });

      await consumer.handle(envelope(payload));
      const [row] = await obligationsOf(fact.statementId);
      expect(row).toMatchObject({ pricingOutcome: 'RULE_APPLIED', pricingRuleId: fee.id });

      const settled = await asActor({ organizationId: employer }, () =>
        wiring.settlements.settle(row!.id, 'USR-ITEST'),
      );
      expect(settled).toMatchObject({
        grossAmountMinor: 10_000_000n,
        commissionAmountMinor: 300_000n,
        netAmountMinor: 9_700_000n,
        commissionOutcome: 'RULE_APPLIED',
      });
      // Debits equal credits in the settlement journal (AGENTS.md § 5).
      const entries = await runUnscoped('the suite reads one journal', () =>
        prisma.client.ledgerEntry.findMany({ where: { journalId: settled.journalId } }),
      );
      const sum = (direction: string) =>
        entries.filter((e) => e.direction === direction).reduce((t, e) => t + e.amountMinor, 0n);
      expect(sum('DEBIT')).toBe(10_000_000n);
      expect(sum('CREDIT')).toBe(10_000_000n);
      const [after] = await obligationsOf(fact.statementId);
      expect(after!.status).toBe('SETTLED');
    });

    it('prices 2^63 - 1 with a rule and computes its commission exactly', async () => {
      const payee = `${contractor}-MAXFEE`;
      const fee = await rule(payee, 250, {
        businessLine: null,
        transactionType: 'CONSTRUCTION_STATEMENT',
      });
      const { fact, payload } = approved({
        beneficiaryOrganizationId: payee,
        netMinor: MAX_AMOUNT_MINOR.toString(),
      });

      await consumer.handle(envelope(payload));
      const [row] = await obligationsOf(fact.statementId);
      expect(row).toMatchObject({ pricingOutcome: 'RULE_APPLIED', pricingRuleId: fee.id });

      const charge = await prisma.transaction((tx) =>
        wiring.commissions.chargeFor(tx, {
          organizationId: payee,
          transactionType: 'CONSTRUCTION_STATEMENT',
          businessLine: null,
          occurredAt: row!.occurredAt,
          grossAmountMinor: row!.grossAmountMinor,
          currency: 'IRR',
          pricingOutcome: row!.pricingOutcome,
          pricingRuleId: row!.pricingRuleId,
        }),
      );
      expect(charge.amountMinor).toBe((MAX_AMOUNT_MINOR * 250n) / 10_000n);
    });

    it('applies a line rule only when the line is configured (Q-130), never by inference', async () => {
      const payee = `${contractor}-LINE`;
      const lineRule = await rule(payee, 500, {
        businessLine: 'CONSTRUCTION',
        transactionType: null,
      });

      const unconfigured = approved({ beneficiaryOrganizationId: payee });
      await consumer.handle(envelope(unconfigured.payload));
      const [plain] = await obligationsOf(unconfigured.fact.statementId);
      expect(plain).toMatchObject({
        businessLine: null,
        pricingOutcome: 'NO_ACTIVE_RULE',
        pricingRuleId: null,
      });

      const configured = approved({ beneficiaryOrganizationId: payee });
      await consumerWith('CONSTRUCTION').handle(envelope(configured.payload));
      const [lined] = await obligationsOf(configured.fact.statementId);
      expect(lined).toMatchObject({
        businessLine: 'CONSTRUCTION',
        pricingOutcome: 'RULE_APPLIED',
        pricingRuleId: lineRule.id,
      });
    });
  });

  describe('immutable once created (ADR-068 § 6 (5))', () => {
    async function recorded(): Promise<string> {
      const { fact, payload } = approved();
      await consumer.handle(envelope(payload));
      return (await obligationsOf(fact.statementId))[0]!.id;
    }

    it.each([
      ['the amount', `gross_amount_minor = gross_amount_minor + 1`],
      ['the payee', `counterparty_organization_id = 'ORG-ELSEWHERE'`],
      ['the payer', `organization_id = 'ORG-ELSEWHERE'`],
      ['the statement', `source_reference = 'STM_OTHER'`],
      ['the source type', `source_type = 'APITEST'`],
      ['the currency', `currency = 'EUR'`],
      ['the instant', `occurred_at = occurred_at - interval '1 day'`],
    ])('refuses a change to %s', async (_what, assignment) => {
      const transactionId = await recorded();

      await expect(
        runUnscoped('the suite tries to edit a statement obligation', () =>
          prisma.client.$executeRawUnsafe(
            `UPDATE "transaction" SET ${assignment} WHERE id = $1`,
            transactionId,
          ),
        ),
      ).rejects.toThrow(/the terms of a statement obligation never change/);
    });

    it('refuses a delete, which would let a replay record a second one', async () => {
      const transactionId = await recorded();

      await expect(
        runUnscoped('the suite tries to delete a statement obligation', () =>
          prisma.client.$executeRawUnsafe(`DELETE FROM "transaction" WHERE id = $1`, transactionId),
        ),
      ).rejects.toThrow(/a statement obligation is never deleted/);
    });

    it('refuses a STATEMENT row nobody but the consumer could have written', async () => {
      await expect(
        runUnscoped('the suite writes a statement obligation by hand', () =>
          prisma.client.$executeRawUnsafe(
            `INSERT INTO "transaction" (id, organization_id, counterparty_organization_id,
               transaction_type, status, gross_amount_minor, currency, occurred_at, source_type,
               source_reference, idempotency_key, correlation_id, created_by, updated_at)
             VALUES ($1, $2, $3, 'CONSTRUCTION_STATEMENT', 'CREATED', 100, 'IRR', now(),
               'STATEMENT', $4, 'a-client-key-123', 'corr', 'USR-SOMEONE', now())`,
            id('TXN'),
            employer,
            contractor,
            `STM_${ulid()}`,
          ),
        ),
      ).rejects.toThrow(/ck_transaction_statement_obligation/);
    });
  });

  describe('Financial Consistency — I4: each APPROVED statement, at most one obligation', () => {
    it('holds over redeliveries, re-emits and concurrent copies of many approvals', async () => {
      const statements = Array.from({ length: 5 }, () => approved());

      await Promise.allSettled(
        statements.flatMap(({ payload }) => {
          const original = envelope(payload);
          return [original, original, envelope(payload), envelope(payload)].map((e) =>
            consumer.handle(e),
          );
        }),
      );
      // Whatever lost a race is redelivered, as the consumer would.
      for (const { payload } of statements) await consumer.handle(envelope(payload));

      const ids = statements.map(({ fact }) => fact.statementId);
      const groups = await runUnscoped('the suite counts obligations per statement', () =>
        prisma.client.transaction.groupBy({
          by: ['sourceReference'],
          where: { sourceType: 'STATEMENT', sourceReference: { in: ids } },
          _count: { _all: true },
        }),
      );
      expect(groups).toHaveLength(ids.length);
      expect(groups.every((group) => group._count._all === 1)).toBe(true);
      const anywhere = await runUnscoped(
        'the suite looks for any statement recorded twice',
        () =>
          prisma.client.$queryRaw<{ duplicates: bigint }[]>`
          SELECT count(*) AS duplicates FROM (
            SELECT source_reference FROM "transaction"
             WHERE source_type = 'STATEMENT'
             GROUP BY source_reference HAVING count(*) > 1) AS twice`,
      );
      expect(anywhere[0]!.duplicates).toBe(0n);
    });
  });

  describe('tenant isolation over the API', () => {
    let harness: ApiHarness;
    let api: Server;
    let apiConsumer: StatementSettlementConsumer;
    const payer = apiTenant('STM-EMPLOYER');
    const payee = apiTenant('STM-CONTRACTOR');
    const outsider = apiTenant('STM-OUTSIDER');

    beforeAll(async () => {
      harness = await startApi();
      api = harness.app.getHttpServer() as Server;
      apiConsumer = consumerWith(null, wire(harness.prisma), harness.prisma);
    });

    afterAll(async () => {
      await cleanup(harness.prisma, [payer, payee, outsider]);
      await harness.close();
    });

    it('shows the obligation to its payer and payee only; any other organization gets 404', async () => {
      const { fact, payload } = approved({
        payerOrganizationId: payer,
        beneficiaryOrganizationId: payee,
      });
      await apiConsumer.handle(envelope(payload));
      const [row] = await obligationsOf(fact.statementId, harness.prisma);

      for (const reader of [payer, payee]) {
        const read = await request(api)
          .get(`/v1/transactions/${row!.id}`)
          .set('authorization', `Bearer ${admin(reader)}`)
          .expect(200);
        expect(read.body).toMatchObject({
          sourceType: 'STATEMENT',
          sourceReference: fact.statementId,
          grossAmountMinor: '7350000',
        });
      }
      const refused = await request(api)
        .get(`/v1/transactions/${row!.id}`)
        .set('authorization', `Bearer ${admin(outsider)}`)
        .expect(404);
      expect(refused.body.code).toBe('NOT_FOUND');
      const listed = await request(api)
        .get(`/v1/transactions?sourceReference=${fact.statementId}&includeIncoming=true`)
        .set('authorization', `Bearer ${admin(outsider)}`)
        .expect(200);
      expect(listed.body.items).toHaveLength(0);
    });

    it.each([
      ['an outsider', () => outsider],
      ['the employer itself', () => payer],
    ])(
      'refuses %s recording a STATEMENT obligation over HTTP (400), so none pre-empts the consumer',
      async (_who, caller) => {
        const statementId = `STM_${ulid()}`;
        const response = await request(api)
          .post('/v1/transactions')
          .set('authorization', `Bearer ${admin(caller())}`)
          .set('idempotency-key', id('stm-create'))
          .send({
            transactionType: 'CONSTRUCTION_STATEMENT',
            counterpartyOrganizationId: payee,
            grossAmountMinor: '1',
            currency: 'IRR',
            sourceType: 'STATEMENT',
            sourceReference: statementId,
          })
          .expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect(await obligationsOf(statementId, harness.prisma)).toHaveLength(0);
      },
    );
  });

  /**
   * docs/24 Q-97 (temporary decision, 2026-10-17; review of #329 round 1,
   * finding 1): no hold stands behind a statement's obligation, so a refund or
   * a cancellation would move no money and only end it — a waiver of an
   * approved payable that no replay could undo. Both are refused to every
   * caller; a dispute only freezes it, and a platform decision lifts it.
   */
  describe('never refunded nor cancelled, by anyone; a dispute only freezes it (Q-97)', () => {
    let harness: ApiHarness;
    let api: Server;
    let apiConsumer: StatementSettlementConsumer;
    const payer = apiTenant('STM-W-EMPLOYER');
    const payee = apiTenant('STM-W-CONTRACTOR');
    const outsider = apiTenant('STM-W-OUTSIDER');
    const REFUSED =
      "An approved statement's obligation is not refunded or cancelled; the statement is corrected only by a compensating statement";

    type Caller = { header: string; value: () => Promise<string> };
    const person = (token: () => string): Caller => ({
      header: 'authorization',
      value: async () => `Bearer ${token()}`,
    });
    const saga = (organizationId: () => string): Caller => ({
      header: 'x-internal-token',
      value: () => internalToken('marketplace-service', { organizationId: organizationId() }),
    });

    // Every caller either route admits: both parties' financial administrators,
    // both platform roles acting from elsewhere, each platform role acting for
    // the payer itself, and the one service the routes allow, for either party.
    const callers: [string, Caller][] = [
      ['the payee’s ORGANIZATION_ADMIN', person(() => admin(payee))],
      ['the payer’s ORGANIZATION_ADMIN', person(() => admin(payer))],
      ['a SYSTEM_ADMIN acting from elsewhere', person(() => platformAdmin())],
      [
        // Refused before the hierarchy is asked: organization-service is not
        // stood up here, and asking it would answer 503, not this refusal.
        'a UNION_ADMIN acting from elsewhere',
        person(() => admin(apiTenant('STM-W-UNION'), ['UNION_ADMIN'], 'union')),
      ],
      ['the payer’s own SYSTEM_ADMIN', person(() => admin(payer, ['SYSTEM_ADMIN'], 'own-sys'))],
      ['the payer’s own UNION_ADMIN', person(() => admin(payer, ['UNION_ADMIN'], 'own-union'))],
      ['marketplace-service for the payer', saga(() => payer)],
      ['marketplace-service for the payee', saga(() => payee)],
    ];

    beforeAll(async () => {
      harness = await startApi();
      api = harness.app.getHttpServer() as Server;
      apiConsumer = consumerWith(null, wire(harness.prisma), harness.prisma);
      const wallet = await walletOf(payer);
      await request(api)
        .post(`/v1/wallets/${wallet.id}/top-up`)
        .set('authorization', `Bearer ${admin(payer)}`)
        .set('idempotency-key', id('stm-w-fund'))
        .send({ amountMinor: '100000000' })
        .expect(201);
      await walletOf(payee);
    });

    afterAll(async () => {
      await cleanup(harness.prisma, [payer, payee, outsider]);
      await harness.close();
    });

    async function walletOf(organizationId: string) {
      const wallet = await request(api)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(organizationId)}`)
        .expect(200);
      return {
        id: wallet.body.id as string,
        available: BigInt(wallet.body.availableBalanceMinor),
        pending: BigInt(wallet.body.pendingBalanceMinor),
        ledger: BigInt(wallet.body.ledgerBalanceMinor),
      };
    }

    /** One approval, consumed: its obligation's id, and the event that recorded it. */
    async function obligation(): Promise<{
      transactionId: string;
      payload: Record<string, unknown>;
    }> {
      const { fact, payload } = approved({
        payerOrganizationId: payer,
        beneficiaryOrganizationId: payee,
        netMinor: '4200000',
      });
      await apiConsumer.handle(envelope(payload));
      const [row] = await obligationsOf(fact.statementId, harness.prisma);
      return { transactionId: row!.id, payload };
    }

    async function command(
      transactionId: string,
      act: 'refund' | 'cancel' | 'dispute' | 'resolve-dispute',
      caller: Caller,
      status: number,
      key = id(`stm-w-${act}`),
    ) {
      const body =
        act === 'dispute'
          ? { reason: 'The measured quantities are contested.' }
          : act === 'resolve-dispute'
            ? { resolution: 'Measurements confirmed on site.' }
            : { reason: 'Asked for in the statement suite.' };
      return request(api)
        .post(`/v1/transactions/${transactionId}/${act}`)
        .set(caller.header, await caller.value())
        .set('idempotency-key', key)
        .send(body)
        .expect(status);
    }

    const statusOf = async (transactionId: string) =>
      (
        await request(api)
          .get(`/v1/transactions/${transactionId}`)
          .set('authorization', `Bearer ${admin(payer)}`)
          .expect(200)
      ).body.status as string;

    const recordedActions = (transactionId: string) =>
      runUnscoped('the suite reads one transaction’s outbox records', async () =>
        (
          await harness.prisma.client.outboxMessage.findMany({
            where: { aggregateId: transactionId, eventName: 'TRANSACTION_STATUS_CHANGED' },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        ).map((m) => (m.payload as { payload: { action: string } }).payload.action),
      );

    const settle = (transactionId: string) =>
      request(api)
        .post('/v1/settlements')
        .set('authorization', `Bearer ${admin(payer)}`)
        .set('idempotency-key', id('stm-w-settle'))
        .send({ transactionId });

    describe.each(['refund', 'cancel'] as const)('%s', (act) => {
      it.each(callers)(`refused to %s: 422, fixed words, nothing moved`, async (_who, caller) => {
        const { transactionId } = await obligation();
        const before = await walletOf(payer);

        const response = await command(transactionId, act, caller, 422);

        expect(response.body).toMatchObject({ code: 'BUSINESS_RULE_VIOLATION', message: REFUSED });
        expect(response.body.message).not.toContain(transactionId);
        expect(await statusOf(transactionId)).toBe('PENDING_SETTLEMENT');
        expect(await walletOf(payer)).toEqual(before);
        expect(await recordedActions(transactionId)).toEqual(['RECORD_AUTHORISED_OBLIGATION']);
      });

      it('a non-party still learns nothing: 404, before this refusal', async () => {
        const { transactionId } = await obligation();

        const response = await command(
          transactionId,
          act,
          person(() => admin(outsider)),
          404,
        );

        expect(response.body.code).toBe('NOT_FOUND');
        expect(await statusOf(transactionId)).toBe('PENDING_SETTLEMENT');
      });
    });

    it('a disputed obligation is not refunded either, even by a SYSTEM_ADMIN', async () => {
      const { transactionId } = await obligation();
      await command(
        transactionId,
        'dispute',
        person(() => admin(payer)),
        200,
      );

      for (const [, caller] of callers) {
        const response = await command(transactionId, 'refund', caller, 422);
        expect(response.body.message).toBe(REFUSED);
      }
      expect(await statusOf(transactionId)).toBe('DISPUTED');
    });

    it('a dispute freezes it and a platform decision lifts it; then it settles in full', async () => {
      const { transactionId } = await obligation();
      const before = await walletOf(payer);

      await command(
        transactionId,
        'dispute',
        person(() => admin(payer)),
        200,
      );
      const frozen = await settle(transactionId).expect(409);
      expect(frozen.body.code).toBe('INVALID_STATE_TRANSITION');

      const resolved = await command(
        transactionId,
        'resolve-dispute',
        person(() => platformAdmin()),
        200,
      );
      expect(resolved.body.status).toBe('PENDING_SETTLEMENT');

      expect(await recordedActions(transactionId)).toEqual([
        'RECORD_AUTHORISED_OBLIGATION',
        'DISPUTE',
        'RESOLVE_DISPUTE',
      ]);
      expect(await walletOf(payer)).toEqual(before);

      const settled = await settle(transactionId).expect(201);
      expect(BigInt(settled.body.grossAmountMinor)).toBe(4_200_000n);
      expect(await statusOf(transactionId)).toBe('SETTLED');
      expect((await walletOf(payer)).available).toBe(before.available - 4_200_000n);
    });

    it('after a refused refund: the same key is refused again, a replayed approval finds the same live obligation, and it settles', async () => {
      const { transactionId, payload } = await obligation();
      const payeeAdmin = person(() => admin(payee));
      const key = id('stm-w-replay');

      const first = await command(transactionId, 'refund', payeeAdmin, 422, key);
      const again = await command(transactionId, 'refund', payeeAdmin, 422, key);
      expect(again.body).toMatchObject({ code: first.body.code, message: REFUSED });
      await command(transactionId, 'cancel', payeeAdmin, 422);

      // The approval, re-emitted under a new event id and redelivered: still
      // the one obligation, still owed.
      await expect(apiConsumer.handle(envelope(payload))).resolves.toBeUndefined();
      const rows = await obligationsOf(String(payload.statementId), harness.prisma);
      expect(rows.map((row) => [row.id, row.status])).toEqual([
        [transactionId, 'PENDING_SETTLEMENT'],
      ]);

      await settle(transactionId).expect(201);
      expect(await statusOf(transactionId)).toBe('SETTLED');
    });
  });
});

/** Resolves once some session is blocked on a lock inside an INSERT into `transaction`. */
async function untilAnInsertWaits(prisma: PrismaService): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await prisma.client.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS waiting
        FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND query ILIKE '%INSERT INTO%"transaction"%'`;
    if (row && row.waiting > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The second writer never blocked on the first insert');
}

interface SentRecord {
  topic: string;
  messages: { value: Buffer | null; headers: Record<string, unknown> }[];
}

/**
 * The consumer's handler run by a real `EventConsumer` — its retries, its
 * reason for a dead letter — with the DLQ producer recorded instead of a
 * broker (`reward-trigger.dead-letter.spec.ts`).
 */
function realConsumerOver(statements: StatementSettlementConsumer) {
  const lines: string[] = [];
  const logger: ConsumerLogger = {
    log: (message) => lines.push(`log ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'statement-settlement-itest',
      groupId: 'economic-service.statement-settlement',
      topics: ['rasta.contract.v1'],
      deadLetterTopic: 'rasta.economic.v1.dlq',
      maxRetries: 3,
      retryBackoffMs: 0,
    },
    (envelope) => statements.handle(envelope),
    logger,
  );
  const dlq = {
    sent: [] as SentRecord[],
    send: async (record: SentRecord) => void dlq.sent.push(record),
  };
  const handle = consumer as unknown as {
    dlqProducer?: typeof dlq;
    handleMessage(t: string, p: number, v: Buffer, h: undefined, o?: string): Promise<void>;
  };
  handle.dlqProducer = dlq;
  return {
    deliver: (envelope: EventEnvelope) =>
      handle.handleMessage(
        'rasta.contract.v1',
        0,
        Buffer.from(JSON.stringify(envelope), 'utf8'),
        undefined,
        '7',
      ),
    dlq,
    lines,
  };
}

/**
 * The consumer's handler run by a real, started `EventConsumer` over a fake kafkajs: the
 * runner's `eachMessage` is driven the way kafkajs 2.2.4 drives it — an offset is committed
 * when `eachMessage` returns and stays uncommitted when it throws (nest-common's
 * `consumer/__tests__/fake-kafka.ts`, which a service cannot import). The dead-letter producer
 * records what it was given, or refuses every send (`dlqFails`), a broker that is down.
 */
async function brokerOver(
  statements: StatementSettlementConsumer,
  options: { dlqFails?: boolean } = {},
) {
  const lines: string[] = [];
  const logger: ConsumerLogger = {
    log: (message) => lines.push(`log ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
  type EachMessage = (payload: {
    topic: string;
    partition: number;
    message: { value: Buffer; headers: Record<string, never>; offset: string; key: null };
    heartbeat: () => Promise<void>;
    pause: () => () => void;
  }) => Promise<void>;
  let eachMessage: EachMessage | undefined;
  const committed: string[] = [];
  const uncommitted: { offset: string; error: unknown }[] = [];
  const dlq = {
    sent: [] as SentRecord[],
    connect: async () => undefined,
    disconnect: async () => undefined,
    send: async (record: SentRecord) => {
      if (options.dlqFails) throw new Error('The dead-letter broker is down');
      dlq.sent.push(record);
    },
  };
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'statement-settlement-itest',
      groupId: 'economic-service.statement-settlement',
      topics: ['rasta.contract.v1'],
      deadLetterTopic: 'rasta.economic.v1.dlq',
      maxRetries: 3,
      retryBackoffMs: 0,
    },
    (envelope) => statements.handle(envelope),
    logger,
  );
  (consumer as unknown as { kafka: unknown }).kafka = {
    consumer: () => ({
      connect: async () => undefined,
      subscribe: async () => undefined,
      disconnect: async () => undefined,
      run: async (config: { eachMessage: EachMessage }) => {
        eachMessage = config.eachMessage;
      },
    }),
    producer: () => dlq,
  };
  await consumer.start();
  return {
    deliver: (envelope: EventEnvelope, offset: string) =>
      eachMessage!({
        topic: 'rasta.contract.v1',
        partition: 0,
        message: {
          value: Buffer.from(JSON.stringify(envelope), 'utf8'),
          headers: {},
          offset,
          key: null,
        },
        heartbeat: async () => undefined,
        pause: () => () => undefined,
      }).then(
        () => void committed.push(offset),
        (error: unknown) => void uncommitted.push({ offset, error }),
      ),
    stop: () => consumer.stop(),
    committed,
    uncommitted,
    dlq,
    lines,
  };
}

/** What Nest's `Logger` writes while a test runs — the consumers' own log lines. */
function captureNestLogs(): { lines: () => string[]; restore: () => void } {
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level),
  );
  return {
    lines: () => spies.flatMap((spy) => spy.mock.calls.map((call) => inspect(call))),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}
