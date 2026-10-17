import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
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
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
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
 * contract-service is a local HTTP stand-in for `GET /v1/internal/statements/{id}`
 * that holds the real route's lock: an `X-Internal-Token` and no
 * `Authorization`, verified for `contract-service`, minted by
 * `economic-service` as a `SERVICE` token, signed for an organization — and
 * the statement answered only for that organization, its employer; every
 * other organization's token (the contractor's included) gets `404 Statement
 * not found`. The client is the real `SourceFactsClient`, so the token, the
 * timeout and the three answers are the production path. Everything below the
 * handler — the transaction, `processed_event`, the unique key, the CHECK and
 * the trigger — is the real database.
 */

const SECRET = 'itest_internal_secret_at_least_32_characters';
const REQUEST_TIMEOUT_MS = 400;

class StubContractService {
  readonly statements = new Map<string, StatementFact>();
  readonly asked: { statementId: string; organizationId: string }[] = [];
  mode: 'up' | 'down' | 'hang' = 'up';
  url = '';
  private server?: http.Server;
  private readonly held: http.ServerResponse[] = [];

  constructor(private readonly tokens: InternalTokenService) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.answer(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.held) res.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  record(fact: StatementFact): StatementFact {
    this.statements.set(fact.statementId, fact);
    return fact;
  }

  private async answer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const match = /^\/v1\/internal\/statements\/([^/?]+)$/.exec(req.url ?? '');
    if (!match) return send(404, { code: 'NOT_FOUND', message: `Cannot GET ${req.url}` });
    const token = req.headers['x-internal-token'];
    if (typeof token !== 'string' || req.headers.authorization !== undefined) {
      return send(401, { code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }
    let claims;
    try {
      claims = await this.tokens.verify(token, 'contract-service');
    } catch {
      return send(401, { code: 'UNAUTHENTICATED', message: 'Authentication required' });
    }
    if (claims.callerService !== 'economic-service' || claims.purpose !== 'SERVICE') {
      return send(403, { code: 'FORBIDDEN', message: 'Forbidden' });
    }
    if (!claims.organizationId) {
      return send(403, { code: 'SERVICE_TENANT_CONTEXT_INVALID', message: 'No tenant' });
    }
    const statementId = decodeURIComponent(match[1]!);
    this.asked.push({ statementId, organizationId: claims.organizationId });
    // Down or silent only once the question was asked, with a valid token.
    if (this.mode === 'hang') {
      this.held.push(res);
      return;
    }
    if (this.mode === 'down') return send(503, { code: 'INTERNAL_ERROR', message: 'down' });
    const fact = this.statements.get(statementId);
    if (!fact || fact.payerOrganizationId !== claims.organizationId) {
      return send(404, { code: 'NOT_FOUND', message: 'Statement not found' });
    }
    send(200, fact);
  }
}

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
