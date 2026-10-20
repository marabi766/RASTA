import type { Server } from 'node:http';
import request from 'supertest';
import { ulid } from 'ulid';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { EventEnvelope } from '@rasta/contracts';
import { EventConsumer, InternalTokenService, runUnscoped } from '@rasta/nest-common';
import { StatementSettlementConsumer } from '../src/consumers/statement-settlement.consumer';
import { SourceFactsClient } from '../src/provenance/source-facts.client';
import { TransactionRepository } from '../src/transaction/transaction.repository';
import { enrichOpenApiDocument, INTERNAL_TOKEN_SCHEME } from '../src/openapi/document';
import {
  admin,
  apiTenant,
  auditor,
  internalToken,
  platformAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import { StubContractService } from './contract-service.stub';
import { cleanup, id, wire } from './helpers';

/**
 * CON-003 PR 6c prerequisite (ADR-068 § 6 (3), A-13): contract-service marks a
 * statement SETTLED only on economic-service's confirmation that its
 * obligation was paid in full, and asks for it here —
 * `GET /v1/internal/obligations/by-source/STATEMENT/{statementId}`.
 *
 * Booted from the real `AppModule` (guards, filter, versioning, tenant
 * guard). The obligations are recorded by the real `STATEMENT_APPROVED`
 * consumer from a local contract-service stand-in, and settled, disputed and
 * read over HTTP, so every row the read answers from is one the production
 * paths wrote.
 */

const SECRET = 'itest_internal_secret_at_least_32_characters';
const ROUTE = (statementId: string) =>
  `/v1/internal/obligations/by-source/STATEMENT/${encodeURIComponent(statementId)}`;

describe('GET /v1/internal/obligations/by-source/STATEMENT/{statementId} (ADR-068 § 6 (3))', () => {
  let harness: ApiHarness;
  let api: Server;
  let consumer: StatementSettlementConsumer;
  const tokens = new InternalTokenService(SECRET, 'rasta-internal', 60);
  const contract = new StubContractService(tokens);

  const employer = apiTenant('OBR-EMPLOYER');
  const contractor = apiTenant('OBR-CONTRACTOR');
  const otherEmployer = apiTenant('OBR-EMPLOYER-2');
  const stranger = apiTenant('OBR-STRANGER');

  /** contract-service's token, signed for one organization — the way PR 6c will mint it. */
  const asContract = (organizationId?: string) =>
    internalToken('contract-service', organizationId ? { organizationId } : {});

  /** contract-service asking, signed for `organizationId` (`null`: for none); the status expected. */
  const read = async (
    statementId: string,
    organizationId: string | null = employer,
    status = 200,
  ) =>
    request(api)
      .get(ROUTE(statementId))
      .set('x-internal-token', await asContract(organizationId ?? undefined))
      .expect(status);

  beforeAll(async () => {
    await contract.start();
    harness = await startApi();
    api = harness.app.getHttpServer() as Server;
    consumer = new StatementSettlementConsumer(
      () =>
        ({
          start: async () => undefined,
          stop: async () => undefined,
        }) as unknown as EventConsumer,
      harness.prisma,
      wire(harness.prisma).transactions,
      new SourceFactsClient({
        maintenanceBaseUrl: 'http://127.0.0.1:9',
        fleetBaseUrl: 'http://127.0.0.1:9',
        contractBaseUrl: contract.url,
        timeoutMs: 2_000,
        tokens,
      }),
      null,
    );

    for (const payer of [employer, otherEmployer]) {
      const wallet = await walletOf(payer);
      await request(api)
        .post(`/v1/wallets/${wallet}/top-up`)
        .set('authorization', `Bearer ${admin(payer)}`)
        .set('idempotency-key', id('obr-fund'))
        .send({ amountMinor: '500000000' })
        .expect(201);
    }
    await walletOf(contractor);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [employer, contractor, otherEmployer, stranger]);
    await harness.close();
    await contract.stop();
  });

  async function walletOf(organizationId: string): Promise<string> {
    const wallet = await request(api)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(organizationId)}`)
      .expect(200);
    return wallet.body.id as string;
  }

  /** One approved statement, consumed into its obligation; returns the statement and obligation ids. */
  async function approvedStatement(
    netMinor = '7350000',
    payer = employer,
    statementId = `STM_${ulid()}`,
  ): Promise<{ statementId: string; obligationId: string }> {
    const fact = contract.record({
      statementId,
      contractId: `CTR_${ulid()}`,
      status: 'APPROVED',
      netMinor,
      currency: 'IRR',
      payerOrganizationId: payer,
      beneficiaryOrganizationId: contractor,
      approvedAt: new Date().toISOString(),
    });
    await consumer.handle({
      eventId: ulid(),
      eventName: 'STATEMENT_APPROVED',
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'contract-service',
      producerVersion: '0.1.0',
      aggregateType: 'Contract',
      aggregateId: fact.contractId,
      tenantId: payer,
      correlationId: `obr-${ulid()}`,
      payload: {
        contractId: fact.contractId,
        statementId: fact.statementId,
        statementNumber: 1,
        organizationId: payer,
        contractorOrganizationId: contractor,
        approvedAt: fact.approvedAt,
      },
    } as EventEnvelope);
    const row = await runUnscoped('the suite finds the obligation the consumer recorded', () =>
      harness.prisma.client.transaction.findFirstOrThrow({
        where: { organizationId: payer, sourceType: 'STATEMENT', sourceReference: statementId },
      }),
    );
    return { statementId, obligationId: row.id };
  }

  const settle = (transactionId: string, payer = employer) =>
    request(api)
      .post('/v1/settlements')
      .set('authorization', `Bearer ${admin(payer)}`)
      .set('idempotency-key', id('obr-settle'))
      .send({ transactionId })
      .expect(201);

  describe('the answer, from economic-service’s own rows', () => {
    it('states an obligation not yet settled: its id, the statement, status, amount, currency, parties; not settled', async () => {
      const { statementId, obligationId } = await approvedStatement('9223372036854775807');
      const outboxBefore = await outboxOf(obligationId);

      const response = await read(statementId);

      expect(response.body).toEqual({
        obligationId,
        statementId,
        status: 'PENDING_SETTLEMENT',
        amountMinor: '9223372036854775807',
        currency: 'IRR',
        payerOrganizationId: employer,
        beneficiaryOrganizationId: contractor,
        settlementId: null,
        settledAt: null,
        settledAmountMinor: null,
        fullySettled: false,
      });
      // A read: nothing written, nothing announced.
      expect(await outboxOf(obligationId)).toEqual(outboxBefore);
    });

    it('states a settled one in full, with the settlement SETTLEMENT_COMPLETED announced', async () => {
      const { statementId, obligationId } = await approvedStatement('4200000');
      const settled = await settle(obligationId);

      const response = await read(statementId);

      const settlement = await runUnscoped('the suite reads the settlement it made', () =>
        harness.prisma.client.settlement.findUniqueOrThrow({
          where: { id: settled.body.settlementId },
        }),
      );
      expect(response.body).toMatchObject({
        obligationId,
        statementId,
        status: 'SETTLED',
        amountMinor: '4200000',
        settlementId: settlement.id,
        settledAt: settlement.settledAt.toISOString(),
        settledAmountMinor: '4200000',
        fullySettled: true,
      });

      // The event PR 6c reacts to names this obligation and this settlement —
      // and not the statement, which is why the reader asks here.
      const completed = (await outboxOf(settlement.id)).filter(
        (message) => message.eventName === 'SETTLEMENT_COMPLETED',
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({
        settlementId: settlement.id,
        transactionId: obligationId,
        payerOrganizationId: employer,
        settledAt: settlement.settledAt.toISOString(),
      });
      expect(JSON.stringify(completed[0]?.payload)).not.toContain(statementId);
    });

    it('reads the obligation and its settlement from one snapshot when a settlement commits between the two reads (#340 r1)', async () => {
      const { statementId, obligationId } = await approvedStatement('3100000');

      // The read's second query is held until a real settlement of this very
      // obligation — over HTTP, through SettlementService — has committed. Under
      // READ COMMITTED that query would see the new settlement beside the
      // PENDING_SETTLEMENT the first one read, and the answer would be a 500.
      const repository = harness.app.get(TransactionRepository);
      let settledBetween: request.Response | undefined;
      const hooked = harness.prisma.client.$extends({
        query: {
          settlement: {
            async findFirst({ args, query }) {
              if (!settledBetween && args.where?.transactionId === obligationId) {
                settledBetween = await settle(obligationId);
              }
              return query(args);
            },
          },
        },
      });
      Object.defineProperty(repository, 'client', { configurable: true, get: () => hooked });
      let during: request.Response;
      try {
        during = await read(statementId);
      } finally {
        delete (repository as unknown as Record<string, unknown>).client;
      }

      // The settlement did commit between the reads …
      expect(settledBetween?.status).toBe(201);
      // … and the answer is the moment before it, whole: not settled, no settlement.
      expect(during.body).toMatchObject({
        obligationId,
        status: 'PENDING_SETTLEMENT',
        settlementId: null,
        settledAt: null,
        settledAmountMinor: null,
        fullySettled: false,
      });
      // The next read is the moment after it, whole.
      const after = await read(statementId);
      expect(after.body).toMatchObject({
        status: 'SETTLED',
        settlementId: settledBetween?.body.settlementId,
        settledAmountMinor: '3100000',
        fullySettled: true,
      });
    });

    it('states a disputed one as not settled', async () => {
      const { statementId, obligationId } = await approvedStatement();
      await request(api)
        .post(`/v1/transactions/${obligationId}/dispute`)
        .set('authorization', `Bearer ${admin(employer)}`)
        .set('idempotency-key', id('obr-dispute'))
        .send({ reason: 'The measured quantities are contested.' })
        .expect(200);

      const response = await read(statementId);

      expect(response.body).toMatchObject({ status: 'DISPUTED', fullySettled: false });
      expect(response.body.settledAt).toBeNull();
    });
  });

  describe('tenant isolation: the payer signed into the token, and nobody else', () => {
    /** What every "not here" answers: the same code and words, whatever the cause. */
    const notFound = async (statementId: string, organizationId: string) => {
      const response = await read(statementId, organizationId, 404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND', message: 'Obligation not found' });
      return { code: response.body.code, message: response.body.message };
    };

    it('answers the beneficiary, another employer and a stranger exactly as a statement with no obligation', async () => {
      const { statementId, obligationId } = await approvedStatement();
      const missing = await notFound(`STM_${ulid()}`, employer);

      for (const organizationId of [contractor, otherEmployer, stranger]) {
        const refused = await read(statementId, organizationId, 404);
        expect({ code: refused.body.code, message: refused.body.message }).toEqual(missing);
        // Nothing about the obligation comes back.
        expect(JSON.stringify(refused.body)).not.toContain(obligationId);
        expect(JSON.stringify(refused.body)).not.toContain(employer);
      }
    });

    it('gives each payer its own obligation when two record the same statement id', async () => {
      // Statement ids are unique in contract-service; the unique key here is
      // per payer (`ux_transaction_source_fact`). Two payers under one id is
      // the case where a read without the payer's predicate answers the
      // wrong organization's money.
      const statementId = `STM_${ulid()}`;
      const first = await approvedStatement('1111', employer, statementId);
      const second = await approvedStatement('2222', otherEmployer, statementId);

      const mine = await read(statementId, employer);
      const theirs = await read(statementId, otherEmployer);

      expect(mine.body).toMatchObject({
        obligationId: first.obligationId,
        payerOrganizationId: employer,
        amountMinor: '1111',
      });
      expect(theirs.body).toMatchObject({
        obligationId: second.obligationId,
        payerOrganizationId: otherEmployer,
        amountMinor: '2222',
      });
    });

    it('answers only a STATEMENT obligation: another source type under the same reference is not one', async () => {
      const reference = `STM_${ulid()}`;
      await request(api)
        .post('/v1/transactions')
        .set('authorization', `Bearer ${admin(employer)}`)
        .set('idempotency-key', id('obr-other-source'))
        .send({
          transactionType: 'LOGISTICS',
          counterpartyOrganizationId: contractor,
          grossAmountMinor: '5000',
          currency: 'IRR',
          sourceType: 'ORDER',
          sourceReference: reference,
          holdFunds: false,
        })
        .expect(201);

      await notFound(reference, employer);
    });
  });

  describe('who may ask (ADR-061 § 4)', () => {
    let statementId: string;
    beforeAll(async () => {
      ({ statementId } = await approvedStatement());
    });

    it('refuses no credentials with 401', async () => {
      await request(api).get(ROUTE(statementId)).expect(401);
    });

    it.each([
      ['the payer’s ORGANIZATION_ADMIN', () => admin(employer), 'FORBIDDEN'],
      [
        'the payer’s own SYSTEM_ADMIN',
        () => admin(employer, ['SYSTEM_ADMIN'], 'own-sys'),
        'FORBIDDEN',
      ],
      ['a SYSTEM_ADMIN acting from elsewhere', () => platformAdmin(), 'FORBIDDEN'],
      ['the beneficiary’s ORGANIZATION_ADMIN', () => admin(contractor), 'FORBIDDEN'],
      // The oversight role is refused, wherever a handler does not name it, by
      // RolesGuard (@rasta/nest-common), before this route's own check.
      ['an AUDITOR of the payer', () => auditor(employer), 'INSUFFICIENT_ROLE'],
    ])('refuses %s (a user token) with 403', async (_who, token, code) => {
      const response = await request(api)
        .get(ROUTE(statementId))
        .set('authorization', `Bearer ${token()}`)
        .expect(403);
      expect(response.body.code).toBe(code);
      expect(JSON.stringify(response.body)).not.toContain('amountMinor');
    });

    it('judges a user token sent beside contract-service’s token as the user: 403', async () => {
      const response = await request(api)
        .get(ROUTE(statementId))
        .set('authorization', `Bearer ${admin(employer)}`)
        .set('x-internal-token', await asContract(employer))
        .expect(403);
      expect(response.body.code).toBe('FORBIDDEN');
    });

    it.each([
      'marketplace-service',
      'procurement-service',
      'economic-service',
      'notification-service',
    ])('refuses %s, signed for the payer, with 403', async (caller) => {
      const response = await request(api)
        .get(ROUTE(statementId))
        .set('x-internal-token', await internalToken(caller, { organizationId: employer }))
        .expect(403);
      expect(response.body.code).toBe('FORBIDDEN');
      expect(JSON.stringify(response.body)).not.toContain('amountMinor');
    });

    it('refuses contract-service’s token signed for no organization with 403, before any read', async () => {
      const response = await read(statementId, null, 403);
      expect(response.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
      expect(JSON.stringify(response.body)).not.toContain('contract-service');
    });

    it('refuses an X-Organization-Id that disagrees with the signed one with 403', async () => {
      const response = await request(api)
        .get(ROUTE(statementId))
        .set('x-internal-token', await asContract(contractor))
        .set('x-organization-id', employer)
        .expect(403);
      expect(response.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
    });

    it('refuses a relay token, a token for another service and an expired one with 401', async () => {
      for (const token of [
        await internalToken('api-gateway', { purpose: 'RELAY', organizationId: employer }),
        await internalToken('contract-service', {
          organizationId: employer,
          targetService: 'contract-service',
        }),
      ]) {
        await request(api).get(ROUTE(statementId)).set('x-internal-token', token).expect(401);
      }
      const expiring = await internalToken('contract-service', {
        organizationId: employer,
        ttlSeconds: 30,
      });
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(Date.now() + 120_000);
      try {
        await request(api).get(ROUTE(statementId)).set('x-internal-token', expiring).expect(401);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('is published with the internal token as its only scheme, and the statuses it answers', () => {
    const document = enrichOpenApiDocument(
      SwaggerModule.createDocument(
        harness.app,
        new DocumentBuilder().setTitle('t').setVersion('0.0.0').addBearerAuth().build(),
      ),
    );
    const operation = document.paths?.['/v1/internal/obligations/by-source/STATEMENT/{statementId}']
      ?.get as unknown as { security: unknown; responses: Record<string, unknown> };

    expect(operation.security).toEqual([{ [INTERNAL_TOKEN_SCHEME]: [] }]);
    expect(Object.keys(operation.responses).sort()).toEqual(['200', '401', '403', '404', '500']);
    expect(document.components?.securitySchemes?.[INTERNAL_TOKEN_SCHEME]).toMatchObject({
      type: 'apiKey',
      name: 'X-Internal-Token',
    });
  });

  function outboxOf(aggregateId: string) {
    return runUnscoped('the suite reads one aggregate’s outbox records', async () =>
      (
        await harness.prisma.client.outboxMessage.findMany({
          where: { aggregateId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      ).map((message) => ({
        eventName: message.eventName,
        payload: (message.payload as { payload: Record<string, unknown> }).payload,
      })),
    );
  }
});
