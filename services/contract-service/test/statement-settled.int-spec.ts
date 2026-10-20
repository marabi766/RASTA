import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import {
  DLQ_HEADERS,
  DLQ_REASONS,
  eventEnvelopeSchema,
  type EventEnvelope,
} from '@rasta/contracts';
import {
  EventConsumer,
  InternalTokenService,
  RastaError,
  UnprocessableEventError,
  runUnscoped,
  type ConsumerLogger,
} from '@rasta/nest-common';
import { ContractRepository } from '../src/contract/contract.repository';
import { EventPublisher } from '../src/events/publisher';
import {
  SETTLEMENT_COMPLETED_CONSUMER,
  SettlementCompletedConsumer,
} from '../src/events/settlement-completed.consumer';
import type { ObligationFact } from '../src/settlement/obligation-confirm';
import { ObligationSourceClient } from '../src/settlement/obligation-source.client';
import { SettlementRepository } from '../src/settlement/settlement.repository';
import { SettlementReconciliationSweeper } from '../src/settlement/settlement-reconciliation.sweeper';
import { StatementSettler } from '../src/settlement/statement-settler';
import { http, idemKey, seedSigned, type SignedContract } from './amendment-helpers';
import { internalToken, person, startApi, type ApiHarness } from './api-helpers';
import { StubEconomicService } from './economic-service.stub';
import {
  activateStatementPolicies,
  cleanup,
  eventsOf,
  newOrganizationId,
  wire,
  type SuiteStep,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 6c (ADR-068 § 6 (3) and (5), docs/24 Q-97 (6)): `SETTLEMENT_COMPLETED` from economic-service
 * settles a statement only on economic's own confirmation, read before anything is written, and the
 * contract once it is COMPLETED, no statement is open and Σ settled = Σ approved net.
 *
 * Statements reach APPROVED the way production takes them — over the real `AppModule`'s API, through
 * both approval chains. economic-service is a local HTTP stand-in that holds #340's route lock (an
 * internal token for economic-service from contract-service, signed for the payer); the consumer's
 * handler is driven directly, and through a real `EventConsumer` for its retries and dead letter.
 */
describe('a statement settled on economic-service’s confirmation (CON-003 PR 6c)', () => {
  jest.setTimeout(60_000);

  let api: ApiHarness;
  let w: Wiring;
  let economic: StubEconomicService;
  let consumer: SettlementCompletedConsumer;
  const organizations: string[] = [];
  const MAX = 9223372036854775807n; // 2^63 - 1
  const REQUEST_TIMEOUT_MS = 400;

  /** Minted per run, never written down (AGENTS.md S-01). */
  const tokens = new InternalTokenService(randomBytes(24).toString('hex'), 'rasta-internal', 300);
  const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

  const at = (organizationId: string, role = 'ORGANIZATION_ADMIN'): SuiteStep => ({
    authorityOrganizationId: organizationId,
    authorityRole: role,
  });

  /** A signed contract whose chains are one employer step each: technical, then financial. */
  const contract = async (
    amountMinor = '1000000000',
    overrides: { winnerOrganizationId?: string } = {},
  ): Promise<SignedContract> => {
    const c = await seedSigned(api, w, organizations, { amountMinor, ...overrides });
    await activateStatementPolicies(w, c.employer, {
      technical: [at(c.employer, 'FLEET_MANAGER')],
      financial: [at(c.employer)],
    });
    return c;
  };
  const drafted = async (c: SignedContract, amountMinor: string): Promise<string> =>
    (
      await http(api)
        .post(`/v1/contracts/${c.id}/statements`)
        .set('authorization', `Bearer ${c.contractorToken}`)
        .set('idempotency-key', idemKey('stm'))
        .send({ lines: [{ description: 'Piles and caps', amountMinor }] })
        .expect(201)
    ).body.id;
  const submit = (c: SignedContract, statementId: string) =>
    http(api)
      .post(`/v1/contracts/${c.id}/statements/${statementId}/submit`)
      .set('authorization', `Bearer ${c.contractorToken}`)
      .set('idempotency-key', idemKey('submit'))
      .send({})
      .expect(200);
  const decide = (
    c: SignedContract,
    statementId: string,
    chain: 'TECHNICAL' | 'FINANCIAL',
    decision: 'APPROVE' | 'REJECT' = 'APPROVE',
  ) =>
    http(api)
      .post(`/v1/contracts/${c.id}/statements/${statementId}/decisions`)
      .set(
        'authorization',
        `Bearer ${person(c.employer, [chain === 'TECHNICAL' ? 'FLEET_MANAGER' : 'ORGANIZATION_ADMIN'])}`,
      )
      .set('idempotency-key', idemKey('decide'))
      .send({ chain, stepOrder: 1, decision });
  /** A statement of `c` taken through both chains to APPROVED. */
  const approved = async (c: SignedContract, amountMinor: string): Promise<string> => {
    const id = await drafted(c, amountMinor);
    await submit(c, id);
    await decide(c, id, 'TECHNICAL').expect(200);
    await decide(c, id, 'FINANCIAL').expect(200);
    return id;
  };

  /** What economic holds once it settled the statement's whole net (#340's view). */
  const settledObligation = (
    c: SignedContract,
    statementId: string,
    netMinor: string,
    overrides: Partial<ObligationFact> = {},
  ): ObligationFact =>
    economic.record({
      obligationId: `TXN_${ulid()}`,
      statementId,
      status: 'SETTLED',
      amountMinor: netMinor,
      currency: 'IRR',
      payerOrganizationId: c.employer,
      beneficiaryOrganizationId: c.contractor,
      settlementId: `STL_${ulid()}`,
      settledAt: '2026-10-17T10:00:00.000Z',
      settledAmountMinor: netMinor,
      fullySettled: true,
      ...overrides,
    });

  /** `SETTLEMENT_COMPLETED` as economic-service publishes it (`settlement.service.ts`). */
  const settlementCompleted = (
    fact: Pick<
      ObligationFact,
      'obligationId' | 'settlementId' | 'payerOrganizationId' | 'beneficiaryOrganizationId'
    > & { amountMinor: string },
    overrides: { tenantId?: string | undefined; eventId?: string; payload?: object } = {},
  ): EventEnvelope => {
    const tenantId = 'tenantId' in overrides ? overrides.tenantId : fact.payerOrganizationId;
    return eventEnvelopeSchema.parse({
      eventId: overrides.eventId ?? ulid(),
      eventName: 'SETTLEMENT_COMPLETED',
      occurredAt: new Date().toISOString(),
      producer: 'economic-service',
      aggregateType: 'Settlement',
      aggregateId: fact.settlementId,
      ...(tenantId === undefined ? {} : { tenantId }),
      correlationId: ulid(),
      payload: {
        settlementId: fact.settlementId,
        transactionId: fact.obligationId,
        organizationId: fact.payerOrganizationId,
        payerOrganizationId: fact.payerOrganizationId,
        payeeOrganizationId: fact.beneficiaryOrganizationId,
        journalId: `JNL_${ulid()}`,
        grossAmountMinor: fact.amountMinor,
        commissionAmountMinor: '0',
        netAmountMinor: fact.amountMinor,
        currency: 'IRR',
        settledAt: '2026-10-17T10:00:00.000Z',
        ...overrides.payload,
      },
    }) as EventEnvelope;
  };
  /** The event economic publishes for the settlement of `fact`, as it holds it. */
  const eventOf = (
    fact: ObligationFact,
    overrides: Parameters<typeof settlementCompleted>[1] = {},
  ) =>
    settlementCompleted({ ...fact, settlementId: fact.settlementId ?? `STL_${ulid()}` }, overrides);

  const statementRow = (id: string) =>
    runUnscoped('the suite reads a statement', () =>
      w.prisma.client.statement.findFirst({ where: { id } }),
    );
  const contractRow = (id: string) =>
    runUnscoped('the suite reads a contract', () =>
      w.prisma.client.contract.findFirst({ where: { id } }),
    );
  const outboxCount = (organizationId: string) =>
    runUnscoped('the suite counts the outbox', () =>
      w.prisma.client.outboxMessage.count({ where: { organizationId } }),
    );
  /** The envelope of each outbox row of `eventName`, with its causation. */
  const envelopesOf = async (organizationId: string, eventName: string) =>
    (
      await runUnscoped('the suite reads the outbox', () =>
        w.prisma.client.outboxMessage.findMany({
          where: { organizationId, eventName },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      )
    ).map((row) => row.payload as { causationId?: string; payload: Record<string, unknown> });
  /** Stands in for the contract's `complete` command, which no PR has built yet (ADR-068 § 2). */
  const complete = (contractId: string) =>
    w.prisma.client.$executeRawUnsafe(
      `UPDATE contract SET status = 'COMPLETED', status_changed_at = now(), status_changed_by = 'suite', updated_at = now(), version = version + 1 WHERE id = '${contractId}'`,
    );
  /** The runtime role's error for a raw statement, or '' when it succeeded. */
  const refusal = async (sql: string): Promise<string> => {
    try {
      await w.prisma.client.$executeRawUnsafe(sql);
      return '';
    } catch (error) {
      return String((error as Error).message);
    }
  };
  /** Everything a refused or skipped delivery must leave as it was. */
  const snapshot = async (c: SignedContract, statementIds: string[]) => ({
    statements: await Promise.all(statementIds.map((id) => statementRow(id))),
    contract: await contractRow(c.id),
    outbox: await outboxCount(c.employer),
  });
  const unprocessable = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEventError);
    return error as UnprocessableEventError;
  };

  beforeAll(async () => {
    api = await startApi();
    w = wire();
    economic = new StubEconomicService(tokens);
    await economic.start();
    consumer = new SettlementCompletedConsumer(
      () => {
        throw new Error('these suites drive handle(); nothing subscribes');
      },
      w.prisma,
      new ContractRepository(w.prisma),
      new SettlementRepository(w.prisma),
      new EventPublisher(w.env),
      new ObligationSourceClient({ baseUrl: economic.url, timeoutMs: REQUEST_TIMEOUT_MS, tokens }),
      silent,
    );
  });

  beforeEach(() => {
    economic.mode = 'up';
  });

  afterAll(async () => {
    await economic.stop();
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  describe('economic confirms: APPROVED → SETTLED, in one transaction with its event', () => {
    it('settles the statement from economic’s answer — asked with a token signed for the employer — and records the obligation, the settlement and the amount; STATEMENT_SETTLED carries no amount', async () => {
      const c = await contract('2000000000');
      const id = await approved(c, '1500000001');
      const before = await statementRow(id);
      const fact = settledObligation(c, id, '1500000001');
      const event = eventOf(fact);

      expect(await consumer.handle(event)).toBeUndefined();

      expect(economic.asked).toContainEqual({ statementId: id, organizationId: c.employer });
      const row = await statementRow(id);
      expect(row).toMatchObject({
        status: 'SETTLED',
        version: before!.version + 1,
        settlementObligationId: fact.obligationId,
        settlementId: fact.settlementId,
        settledAmountMinor: 1_500_000_001n,
        settledAt: new Date('2026-10-17T10:00:00.000Z'),
        settlementEventId: event.eventId,
        // What it says never changes (I3).
        grossMinor: before!.grossMinor,
        netMinor: before!.netMinor,
      });

      const [settled] = await envelopesOf(c.employer, 'STATEMENT_SETTLED');
      expect(settled!.causationId).toBe(event.eventId);
      expect(settled!.payload).toEqual({
        contractId: c.id,
        statementId: id,
        statementNumber: 1,
        organizationId: c.employer,
        contractorOrganizationId: c.contractor,
        obligationId: fact.obligationId,
        settlementId: fact.settlementId,
        settledAt: '2026-10-17T10:00:00.000Z',
      });
      expect(Object.keys(settled!.payload)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/amount|minor|net|gross/i)]),
      );
      // The contract is SIGNED, not COMPLETED: it is not settled with its statement.
      expect((await contractRow(c.id))!.status).toBe('SIGNED');
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_SETTLED')).toEqual([]);
    });

    it('is exact at 2^63 - 1', async () => {
      const c = await contract(MAX.toString());
      const id = await approved(c, MAX.toString());
      await consumer.handle(eventOf(settledObligation(c, id, MAX.toString())));
      expect(await statementRow(id)).toMatchObject({ status: 'SETTLED', settledAmountMinor: MAX });
    });

    it('a party reads the statement SETTLED; a decision on it is refused as on any decided statement', async () => {
      const c = await contract();
      const id = await approved(c, '700');
      await consumer.handle(eventOf(settledObligation(c, id, '700')));

      const read = await http(api)
        .get(`/v1/contracts/${c.id}/statements/${id}`)
        .set('authorization', `Bearer ${c.contractorToken}`)
        .expect(200);
      expect(read.body.status).toBe('SETTLED');
      const res = await decide(c, id, 'FINANCIAL').expect(409);
      expect(res.body.code).toBeDefined();
    });
  });

  describe('idempotent: one statement, one settlement', () => {
    it('a redelivery — the same event, or another event id for the same settlement — is skipped without asking economic again, and writes nothing', async () => {
      const c = await contract();
      const id = await approved(c, '900');
      const fact = settledObligation(c, id, '900');
      const event = eventOf(fact);
      await consumer.handle(event);
      const after = await snapshot(c, [id]);
      const asked = economic.askedFor(id);

      expect(await consumer.handle(event)).toBe('SKIPPED');
      expect(await consumer.handle(eventOf(fact))).toBe('SKIPPED');

      expect(economic.askedFor(id)).toBe(asked);
      expect(await snapshot(c, [id])).toEqual(after);
      expect(await eventsOf(w.prisma, c.employer, 'STATEMENT_SETTLED')).toHaveLength(1);
    });

    it('two deliveries at once settle it once: the second, ordered by the contract’s lock, is a replay', async () => {
      const c = await contract();
      const id = await approved(c, '901');
      const fact = settledObligation(c, id, '901');

      const outcomes = await Promise.all([
        consumer.handle(eventOf(fact)),
        consumer.handle(eventOf(fact)),
      ]);

      expect(outcomes.sort()).toEqual(['SKIPPED', undefined].sort());
      expect(await statementRow(id)).toMatchObject({ status: 'SETTLED', version: 5 });
      expect(await eventsOf(w.prisma, c.employer, 'STATEMENT_SETTLED')).toHaveLength(1);
    });

    it('a redelivery naming another settlement of the same obligation contradicts what is recorded: VALIDATION_FAILED, nothing overwritten', async () => {
      const c = await contract();
      const id = await approved(c, '902');
      const fact = settledObligation(c, id, '902');
      await consumer.handle(eventOf(fact));
      const after = await snapshot(c, [id]);

      const error = await unprocessable(
        consumer.handle(eventOf({ ...fact, settlementId: `STL_${ulid()}` })),
      );
      expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
      expect(error.message).toContain('settlementId');
      expect(await snapshot(c, [id])).toEqual(after);
    });
  });

  describe('the event is a trigger only: what is not economic’s confirmed settlement of a statement changes nothing', () => {
    it('a settlement of no statement here (an order, a repair) is skipped without asking economic', async () => {
      const c = await contract();
      const id = await approved(c, '1000');
      const before = await snapshot(c, [id]);
      const asked = economic.asked.length;

      // The payee is not this employer's contractor.
      const other = {
        obligationId: `TXN_${ulid()}`,
        settlementId: `STL_${ulid()}`,
        payerOrganizationId: c.employer,
        beneficiaryOrganizationId: newOrganizationId(),
        amountMinor: '1000',
      };
      expect(await consumer.handle(settlementCompleted(other))).toBe('SKIPPED');
      expect(economic.asked.length).toBe(asked);
      expect(await snapshot(c, [id])).toEqual(before);
    });

    it('a settlement between the same two organizations of another transaction (the statement’s obligation is another) is skipped, after asking economic', async () => {
      const c = await contract();
      const id = await approved(c, '1001');
      settledObligation(c, id, '1001', {
        status: 'PENDING_SETTLEMENT',
        settlementId: null,
        settledAt: null,
        settledAmountMinor: null,
        fullySettled: false,
      });
      const before = await snapshot(c, [id]);

      const order = {
        obligationId: `TXN_${ulid()}`,
        settlementId: `STL_${ulid()}`,
        payerOrganizationId: c.employer,
        beneficiaryOrganizationId: c.contractor,
        amountMinor: '1001',
      };
      expect(await consumer.handle(settlementCompleted(order))).toBe('SKIPPED');
      expect(economic.askedFor(id)).toBeGreaterThan(0);
      expect(await snapshot(c, [id])).toEqual(before);
    });

    it('a statement economic holds no obligation for (its own 404) is not the one: skipped, nothing written', async () => {
      const c = await contract();
      const id = await approved(c, '1002');
      const before = await snapshot(c, [id]);
      const claimed = {
        obligationId: `TXN_${ulid()}`,
        settlementId: `STL_${ulid()}`,
        payerOrganizationId: c.employer,
        beneficiaryOrganizationId: c.contractor,
        amountMinor: '1002',
      };
      expect(await consumer.handle(settlementCompleted(claimed))).toBe('SKIPPED');
      expect(await snapshot(c, [id])).toEqual(before);
    });

    it.each([
      [
        'an obligation of another amount than the net',
        { amountMinor: '1003000' },
        'amount_mismatch',
      ],
      ['a settlement of less than the whole', { settledAmountMinor: '1002' }, 'amount_mismatch'],
      [
        'an obligation not settled yet',
        {
          status: 'PENDING_SETTLEMENT',
          settlementId: null,
          settledAt: null,
          settledAmountMinor: null,
          fullySettled: false,
        },
        'not_settled',
      ],
      [
        'a disputed obligation',
        {
          status: 'DISPUTED',
          settlementId: null,
          settledAt: null,
          settledAmountMinor: null,
          fullySettled: false,
        },
        'not_settled',
      ],
      // economic names a settlement but does not say it was paid in full: never taken as paid.
      ['a settlement named but fullySettled false', { fullySettled: false }, 'not_settled'],
      ['a settlement named under a status not SETTLED', { status: 'DISPUTED' }, 'not_settled'],
      [
        'another beneficiary',
        { beneficiaryOrganizationId: 'ORG_ELSEWHERE' },
        'beneficiary_mismatch',
      ],
      ['another currency', { currency: 'USD' }, 'currency_mismatch'],
    ] as const)(
      'economic’s answer with %s is refused: SOURCE_UNCONFIRMED at once, nothing written',
      async (_label, change, mismatch) => {
        const c = await contract();
        const id = await approved(c, '1003');
        const fact = settledObligation(c, id, '1003', change as Partial<ObligationFact>);
        const before = await snapshot(c, [id]);

        const error = await unprocessable(
          consumer.handle(
            settlementCompleted({
              ...fact,
              settlementId: fact.settlementId ?? `STL_${ulid()}`,
              beneficiaryOrganizationId: c.contractor,
              amountMinor: '1003',
            }),
          ),
        );
        expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
        expect(error.message).toContain(mismatch);
        expect(await snapshot(c, [id])).toEqual(before);
      },
    );

    it('an event naming another settlement than economic’s is refused (settlement_mismatch), nothing written', async () => {
      const c = await contract();
      const id = await approved(c, '1004');
      const fact = settledObligation(c, id, '1004');
      const before = await snapshot(c, [id]);
      const error = await unprocessable(
        consumer.handle(eventOf({ ...fact, settlementId: `STL_${ulid()}` })),
      );
      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
      expect(error.message).toContain('settlement_mismatch');
      expect(await snapshot(c, [id])).toEqual(before);
    });
  });

  describe('tenant isolation (ADR-061 § 5)', () => {
    it.each([
      ['no tenant', { tenantId: undefined }],
      ['the contractor as tenant', { tenantId: 'CONTRACTOR' }],
      ['a stranger as tenant', { tenantId: 'STRANGER' }],
    ] as const)(
      'an envelope with %s is refused before economic is asked, nothing written',
      async (_label, override) => {
        const c = await contract();
        const id = await approved(c, '1100');
        const fact = settledObligation(c, id, '1100');
        const before = await snapshot(c, [id]);
        const asked = economic.asked.length;
        const tenantId =
          override.tenantId === 'CONTRACTOR'
            ? c.contractor
            : override.tenantId === 'STRANGER'
              ? newOrganizationId()
              : undefined;

        const error = await unprocessable(consumer.handle(eventOf(fact, { tenantId })));
        expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
        expect(error.message).toContain('tenant_mismatch');
        expect(economic.asked.length).toBe(asked);
        expect(await snapshot(c, [id])).toEqual(before);
      },
    );

    it('another employer’s settlement to the same contractor never reaches this employer’s statements: economic is asked only within the event’s tenant', async () => {
      const contractor = newOrganizationId();
      organizations.push(contractor);
      const a = await contract('1000000000', { winnerOrganizationId: contractor });
      const b = await contract('1000000000', { winnerOrganizationId: contractor });
      const ofA = await approved(a, '1200');
      const ofB = await approved(b, '1200');
      const factA = settledObligation(a, ofA, '1200');
      const beforeA = await snapshot(a, [ofA]);

      // B's own settlement, published for B, of B's statement.
      const factB = settledObligation(b, ofB, '1200');
      await consumer.handle(eventOf(factB));
      expect((await statementRow(ofB))!.status).toBe('SETTLED');
      expect(await snapshot(a, [ofA])).toEqual(beforeA);

      // A's obligation claimed in B's tenant: A's statement is no candidate there, and economic is
      // never asked about it with B's organization.
      const forged = settlementCompleted(
        { ...factA, payerOrganizationId: b.employer, settlementId: factA.settlementId! },
        { tenantId: b.employer },
      );
      expect(await consumer.handle(forged)).toBe('SKIPPED');
      expect(economic.asked).not.toContainEqual({ statementId: ofA, organizationId: b.employer });
      expect(await snapshot(a, [ofA])).toEqual(beforeA);
    });
  });

  describe('economic-service cannot be asked: retried, then dead-lettered, nothing changed', () => {
    it.each([
      ['down (503)', 'down', 'UPSTREAM_UNAVAILABLE'],
      ['silent past the timeout', 'hang', 'UPSTREAM_TIMEOUT'],
      ['without the route (a 404 that is not its own)', 'route-missing', 'UPSTREAM_UNAVAILABLE'],
    ] as const)('%s: a retryable %s, nothing written', async (_label, mode, code) => {
      const c = await contract();
      const id = await approved(c, '1300');
      const event = eventOf(settledObligation(c, id, '1300'));
      const before = await snapshot(c, [id]);
      economic.mode = mode;

      const error = await consumer.handle(event).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).code).toBe(code);
      expect(await snapshot(c, [id])).toEqual(before);
    });

    it('through the real EventConsumer: three attempts, UPSTREAM_UNAVAILABLE in the DLQ, nothing written — then a replay settles it once', async () => {
      const c = await contract();
      const id = await approved(c, '1301');
      const event = eventOf(settledObligation(c, id, '1301'));
      const before = await snapshot(c, [id]);

      for (const mode of ['down', 'hang'] as const) {
        economic.mode = mode;
        const { deliver, dlq, lines } = realConsumerOver(consumer);
        await deliver(event);

        expect(lines.filter((line) => line.startsWith('warn Attempt'))).toHaveLength(2);
        expect(dlq.sent).toHaveLength(1);
        expect(dlq.sent[0]!.topic).toBe('rasta.contract.v1.dlq');
        const headers = dlq.sent[0]!.messages[0]!.headers;
        expect(headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.UPSTREAM_UNAVAILABLE);
        expect(await snapshot(c, [id])).toEqual(before);
      }

      // economic is back; the DLQ replay of the same event settles it, once.
      economic.mode = 'up';
      expect(await consumer.handle(event)).toBeUndefined();
      expect(await consumer.handle(event)).toBe('SKIPPED');
      expect((await statementRow(id))!.status).toBe('SETTLED');
      expect(await eventsOf(w.prisma, c.employer, 'STATEMENT_SETTLED')).toHaveLength(1);
    });

    it('through the real EventConsumer, a refusal is dead-lettered on the first attempt as SOURCE_UNCONFIRMED', async () => {
      const c = await contract();
      const id = await approved(c, '1302');
      const event = eventOf(settledObligation(c, id, '1302', { amountMinor: '1303' }));
      const { deliver, dlq, lines } = realConsumerOver(consumer);
      await deliver(event);
      expect(lines.filter((line) => line.startsWith('warn Attempt'))).toHaveLength(0);
      expect(dlq.sent[0]!.messages[0]!.headers[DLQ_HEADERS.reason]).toBe(
        DLQ_REASONS.SOURCE_UNCONFIRMED,
      );
      expect((await statementRow(id))!.status).toBe('APPROVED');
    });
  });

  describe('the contract’s settlement (ADR-068 § 6 (3)): COMPLETED, no statement open, Σ settled = Σ approved net', () => {
    it('a COMPLETED contract whose one approved statement settles is SETTLED in the same transaction, by the system, with CONTRACT_SETTLED', async () => {
      const c = await contract();
      const id = await approved(c, '1400');
      await complete(c.id);
      const event = eventOf(settledObligation(c, id, '1400'));

      await consumer.handle(event);

      const row = await contractRow(c.id);
      expect(row).toMatchObject({ status: 'SETTLED', statusChangedBy: 'service:contract-service' });
      const [settled] = await envelopesOf(c.employer, 'CONTRACT_SETTLED');
      expect(settled!.causationId).toBe(event.eventId);
      expect(settled!.payload).toEqual({
        contractId: c.id,
        projectId: c.award.projectId,
        organizationId: c.employer,
        contractorOrganizationId: c.contractor,
        settledAt: row!.statusChangedAt.toISOString(),
      });
    });

    it('out of order: the second statement settled first leaves the contract COMPLETED; the first one settles it — and a REJECTED statement is not open', async () => {
      const c = await contract();
      const first = await approved(c, '1500');
      const second = await approved(c, '1600');
      const rejected = await drafted(c, '1700');
      await submit(c, rejected);
      await decide(c, rejected, 'TECHNICAL', 'REJECT').expect(200);
      await complete(c.id);
      const one = settledObligation(c, first, '1500');
      const two = settledObligation(c, second, '1600');

      await consumer.handle(eventOf(two));
      expect((await contractRow(c.id))!.status).toBe('COMPLETED');
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_SETTLED')).toEqual([]);

      await consumer.handle(eventOf(one));
      expect((await contractRow(c.id))!.status).toBe('SETTLED');
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_SETTLED')).toHaveLength(1);
      // A redelivery of either changes nothing more.
      expect(await consumer.handle(eventOf(one))).toBe('SKIPPED');
      expect(await consumer.handle(eventOf(two))).toBe('SKIPPED');
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_SETTLED')).toHaveLength(1);
    });

    it('a statement still open (submitted, not decided) keeps a COMPLETED contract from settling', async () => {
      const c = await contract();
      const id = await approved(c, '1800');
      const open = await drafted(c, '1900');
      await submit(c, open);
      await complete(c.id);

      await consumer.handle(eventOf(settledObligation(c, id, '1800')));

      expect((await statementRow(id))!.status).toBe('SETTLED');
      expect((await contractRow(c.id))!.status).toBe('COMPLETED');
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_SETTLED')).toEqual([]);
    });
  });

  describe('Financial Consistency (AGENTS.md § 5; ADR-068 § 6 (5) I1–I5), held by the database', () => {
    it('I1/I4: a settled statement still counts in the approved total, so the next approval moves it exactly, within the cap', async () => {
      const c = await contract('5000');
      const first = await approved(c, '2000');
      await consumer.handle(eventOf(settledObligation(c, first, '2000')));

      const second = await approved(c, '3000');
      expect((await contractRow(c.id))!.approvedTotalMinor).toBe(5000n);
      expect((await statementRow(second))!.status).toBe('APPROVED');
      // The cap counts the settled statement: one more minor unit is refused.
      const third = await drafted(c, '1');
      await submit(c, third);
      await decide(c, third, 'TECHNICAL').expect(200);
      const over = await decide(c, third, 'FINANCIAL').expect(422);
      expect(JSON.stringify(over.body)).toContain('APPROVED_TOTAL_EXCEEDS_CAP');
    });

    it('I3: an APPROVED statement changes only to SETTLED; nothing about a SETTLED one changes', async () => {
      const c = await contract();
      const approvedId = await approved(c, '2100');
      const settledId = await approved(c, '2200');
      await consumer.handle(eventOf(settledObligation(c, settledId, '2200')));

      // Out of APPROVED: to anything but SETTLED, or no move at all, is refused.
      for (const change of [`status = 'REJECTED'`, `net_minor = net_minor - 1`]) {
        expect(
          await refusal(
            `UPDATE statement SET ${change}, version = version + 1, updated_at = now() WHERE id = '${approvedId}'`,
          ),
        ).toContain('ck_statement_final');
      }
      // To SETTLED, what it says still never changes.
      expect(
        await refusal(
          `UPDATE statement SET status = 'SETTLED', gross_minor = gross_minor + 1, net_minor = net_minor + 1, settled_at = now(), settlement_obligation_id = 'TXN_I3', settlement_id = 'STL_I3', settled_amount_minor = net_minor + 1, settlement_event_id = 'EVT_I3', version = version + 1, updated_at = now() WHERE id = '${approvedId}'`,
        ),
      ).toContain('ck_statement_terms_immutable');
      for (const change of [
        `status = 'APPROVED'`,
        `settlement_id = 'STL_OTHER'`,
        `settled_amount_minor = settled_amount_minor - 1`,
      ]) {
        expect(
          await refusal(
            `UPDATE statement SET ${change}, version = version + 1, updated_at = now() WHERE id = '${settledId}'`,
          ),
        ).toContain('ck_statement_final');
      }
    });

    it('I5: the database settles a statement only with a settlement of exactly its net, one obligation per statement', async () => {
      const c = await contract();
      const one = await approved(c, '2300');
      const two = await approved(c, '2400');
      const settle = (id: string, columns: string) =>
        refusal(
          `UPDATE statement SET status = 'SETTLED', ${columns}, version = version + 1, updated_at = now() WHERE id = '${id}'`,
        );
      const all = (obligation: string, amount: string) =>
        `settled_at = now(), settlement_obligation_id = '${obligation}', settlement_id = 'STL_X', settled_amount_minor = ${amount}, settlement_event_id = 'EVT_X'`;

      // SETTLED without the settlement, or with part of it.
      expect(await settle(one, `settlement_event_id = NULL`)).toContain('ck_statement_settlement');
      expect(await settle(one, `settled_at = now()`)).toContain('ck_statement_settlement');
      // Of another amount than the net.
      expect(await settle(one, all('TXN_DB_1', '2299'))).toContain('ck_statement_settlement');
      // One obligation, two statements.
      expect(await settle(one, all('TXN_DB_1', '2300'))).toBe('');
      // `ux_statement_settlement_obligation`: PostgreSQL's unique violation, on that key.
      expect(await settle(two, all('TXN_DB_1', '2400'))).toMatch(
        /23505[\s\S]*\(organization_id, settlement_obligation_id\)=\(\S+, TXN_DB_1\) already exists/,
      );
    });

    it('§ 6 (3): the database settles a COMPLETED contract only with no statement open', async () => {
      const c = await contract();
      await approved(c, '2500');
      await complete(c.id);
      const settle = `UPDATE contract SET status = 'SETTLED', status_changed_at = now(), status_changed_by = 'suite', updated_at = now(), version = version + 1 WHERE id = '${c.id}'`;
      expect(await refusal(settle)).toContain('ck_contract_settled_in_full');

      // A COMPLETED contract with nothing approved and nothing open owes nothing: it may settle.
      const empty = await contract();
      await complete(empty.id);
      expect(
        await refusal(
          `UPDATE contract SET status = 'SETTLED', status_changed_at = now(), status_changed_by = 'suite', updated_at = now(), version = version + 1 WHERE id = '${empty.id}'`,
        ),
      ).toBe('');
    });

    it('holds across a contract’s whole run: Σ gross(APPROVED ∪ SETTLED) = approved total ≤ price; every SETTLED statement settled at its net by its own obligation; SETTLED contract ⇒ nothing open, Σ settled = Σ approved net', async () => {
      const c = await contract('10000');
      const ids = [await approved(c, '1000'), await approved(c, '2500'), await approved(c, '3000')];
      const rejected = await drafted(c, '400');
      await submit(c, rejected);
      await decide(c, rejected, 'TECHNICAL', 'REJECT').expect(200);
      await complete(c.id);
      for (const [index, id] of ids.entries()) {
        await consumer.handle(eventOf(settledObligation(c, id, ['1000', '2500', '3000'][index]!)));
      }

      const statements = await runUnscoped('the suite reads the contract’s statements', () =>
        w.prisma.client.statement.findMany({ where: { contractId: c.id } }),
      );
      const contractNow = (await contractRow(c.id))!;
      const counted = statements.filter((s) => s.status === 'APPROVED' || s.status === 'SETTLED');
      const gross = counted.reduce((sum, s) => sum + s.grossMinor, 0n);
      expect(contractNow.approvedTotalMinor).toBe(gross);
      expect(gross).toBeLessThanOrEqual(contractNow.amountMinor + contractNow.amendmentsTotalMinor);
      for (const s of statements.filter((row) => row.status === 'SETTLED')) {
        expect(s.settledAmountMinor).toBe(s.netMinor);
      }
      const obligations = statements.map((s) => s.settlementObligationId).filter(Boolean);
      expect(new Set(obligations).size).toBe(ids.length);
      expect(contractNow.status).toBe('SETTLED');
      expect(
        statements.filter((s) =>
          ['DRAFT', 'SUBMITTED', 'TECHNICALLY_APPROVED', 'APPROVED'].includes(s.status),
        ),
      ).toEqual([]);
      expect(
        statements
          .filter((s) => s.status === 'SETTLED')
          .reduce((sum, s) => sum + (s.settledAmountMinor ?? 0n), 0n),
      ).toBe(counted.reduce((sum, s) => sum + s.netMinor, 0n));
    });
  });

  describe('the settlement read economic-service builds obligations from (PR 6a)', () => {
    it('answers a SETTLED statement with its status and no approval instant: economic refuses anything not APPROVED, and its obligation already exists (I4)', async () => {
      const c = await contract();
      const id = await approved(c, '2600');
      await consumer.handle(eventOf(settledObligation(c, id, '2600')));
      const res = await http(api)
        .get(`/v1/internal/statements/${id}`)
        .set(
          'x-internal-token',
          await internalToken('economic-service', { organizationId: c.employer }),
        )
        .expect(200);
      expect(res.body).toMatchObject({ status: 'SETTLED', approvedAt: null, netMinor: '2600' });
    });
  });
  describe('a long scan keeps the consumer in its group (review of #343 round 1, F2)', () => {
    it('heartbeats before and after every question to economic-service, however many candidates there are', async () => {
      const c = await contract();
      // Four APPROVED statements to the same contractor, the same net: every one is a candidate,
      // and the event's obligation is the last one's.
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) ids.push(await approved(c, '1400'));
      const last = [...ids].sort().at(-1)!;
      for (const id of ids) {
        if (id !== last)
          economic.record({
            ...settledObligation(c, id, '1400'),
            status: 'HELD',
            fullySettled: false,
            settlementId: null,
            settledAt: null,
            settledAmountMinor: null,
          });
      }
      const event = eventOf(settledObligation(c, last, '1400'));
      const heartbeat = jest.fn();

      expect(
        await consumer.handle(event, { topic: 'rasta.economic.v1', partition: 0, heartbeat }),
      ).toBeUndefined();

      const questions = ids.reduce((sum, id) => sum + economic.askedFor(id), 0);
      expect(questions).toBe(4);
      expect(heartbeat.mock.calls.length).toBe(2 * questions);
      expect((await statementRow(last))!.status).toBe('SETTLED');
    });
  });

  describe('the settlement reconciliation: what the consumer never heard of (review of #343 round 1, F1)', () => {
    const sweeper = () =>
      new SettlementReconciliationSweeper(
        new StatementSettler(
          w.prisma,
          new ContractRepository(w.prisma),
          new SettlementRepository(w.prisma),
          new EventPublisher(w.env),
        ),
        new SettlementRepository(w.prisma),
        new ObligationSourceClient({
          baseUrl: economic.url,
          timeoutMs: REQUEST_TIMEOUT_MS,
          tokens,
        }),
        { intervalMs: 60_000, batchSize: 7 },
      );
    /** Passes until every APPROVED statement of every organization was asked about once. */
    const fullCircle = async (s: SettlementReconciliationSweeper) => {
      const total = { asked: 0, settled: 0, already: 0, unpaid: 0, refused: 0, unavailable: 0 };
      for (let pass = 0; pass < 1000; pass += 1) {
        const outcome = await s.runOnce();
        for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += outcome[key];
        if (outcome.asked < 7) return total;
      }
      throw new Error('the reconciliation never came full circle');
    };

    it('settles a statement economic settled before the consumer existed — on economic’s answer, once, with its event and no event cited', async () => {
      const c = await contract();
      const id = await approved(c, '1500');
      const fact = settledObligation(c, id, '1500');

      const first = await fullCircle(sweeper());
      expect(first.settled).toBeGreaterThanOrEqual(1);
      const row = (await statementRow(id))!;
      expect(row).toMatchObject({
        status: 'SETTLED',
        settlementObligationId: fact.obligationId,
        settlementId: fact.settlementId,
        settledAmountMinor: 1500n,
      });
      expect(row.settlementEventId).toMatch(/^reconciliation:/);
      const settled = await envelopesOf(c.employer, 'STATEMENT_SETTLED');
      expect(settled).toHaveLength(1);
      // No event caused it: none is cited.
      expect(settled[0]!.causationId ?? null).toBeNull();

      // Another pass: nothing APPROVED of it is left to ask about, nothing written again.
      await fullCircle(sweeper());
      expect(await envelopesOf(c.employer, 'STATEMENT_SETTLED')).toHaveLength(1);
      // The event arriving after all is the same settlement: skipped.
      expect(await consumer.handle(eventOf(fact))).toBe('SKIPPED');
    });

    it('leaves alone what economic has not settled, what it cannot confirm, and everything while it cannot be asked', async () => {
      const c = await contract();
      const unpaid = await approved(c, '1501');
      const mismatched = await approved(c, '1502');
      const unknown = await approved(c, '1503');
      economic.record({
        ...settledObligation(c, unpaid, '1501'),
        status: 'HELD',
        fullySettled: false,
        settlementId: null,
        settledAt: null,
        settledAmountMinor: null,
      });
      settledObligation(c, mismatched, '1502', { amountMinor: '1599', settledAmountMinor: '1599' });
      const before = await snapshot(c, [unpaid, mismatched, unknown]);

      economic.mode = 'down';
      const down = await fullCircle(sweeper());
      expect(down.unavailable).toBeGreaterThanOrEqual(3);
      expect(await snapshot(c, [unpaid, mismatched, unknown])).toEqual(before);

      economic.mode = 'up';
      const up = await fullCircle(sweeper());
      expect(up.refused).toBeGreaterThanOrEqual(1);
      expect(await snapshot(c, [unpaid, mismatched, unknown])).toEqual(before);
    });

    it('the consumer first, then the reconciliation: settled once, the pass finds it already done', async () => {
      const c = await contract();
      const id = await approved(c, '1504');
      const fact = settledObligation(c, id, '1504');
      expect(await consumer.handle(eventOf(fact))).toBeUndefined();

      await fullCircle(sweeper());
      expect((await statementRow(id))!.settlementEventId).not.toMatch(/^reconciliation:/);
      expect(await envelopesOf(c.employer, 'STATEMENT_SETTLED')).toHaveLength(1);
    });
  });
});

interface SentRecord {
  topic: string;
  messages: { value: Buffer | null; headers: Record<string, unknown> }[];
}

/**
 * The consumer's handler run by a real `EventConsumer` — its retries, its reason for a dead letter —
 * with the DLQ producer recorded instead of a broker (economic's `statement-settlement.int-spec.ts`).
 */
function realConsumerOver(settlements: SettlementCompletedConsumer) {
  const lines: string[] = [];
  const logger: ConsumerLogger = {
    log: (message) => lines.push(`log ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'settlement-completed-itest',
      groupId: SETTLEMENT_COMPLETED_CONSUMER,
      topics: ['rasta.economic.v1'],
      deadLetterTopic: 'rasta.contract.v1.dlq',
      maxRetries: 3,
      retryBackoffMs: 0,
    },
    (envelope) => settlements.handle(envelope),
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
        'rasta.economic.v1',
        0,
        Buffer.from(JSON.stringify(envelope), 'utf8'),
        undefined,
        '7',
      ),
    dlq,
    lines,
  };
}
