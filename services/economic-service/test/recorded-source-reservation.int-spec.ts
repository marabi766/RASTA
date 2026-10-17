import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import type { EventEnvelope } from '@rasta/contracts';
import { runUnscoped, type EventConsumer } from '@rasta/nest-common';
import {
  admin,
  apiTenant,
  internalToken,
  platformAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import { asActor, cleanup, id } from './helpers';
import { FakeSourceFacts } from './source-facts.fake';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import { CONSUMED_EVENTS } from '../src/events/consumed';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import type { CaptureRequest, CaptureResult } from '../src/payment/provider';
import { TransactionService } from '../src/transaction/transaction.service';
import {
  ECONOMIC_RECORDED_SOURCE_TYPES,
  RECORDED_SOURCE_REFUSAL,
} from '../src/transaction/recorded-sources';

/**
 * Nobody pre-empts a source type economic-service records itself
 * (`src/transaction/recorded-sources.ts`, ADR-032, ADR-061 § 4).
 *
 * Before: `POST /v1/transactions` took any `sourceType`. A payer's
 * administrator — or any service allowed on the route — could record
 * `MAINTENANCE_REQUEST/<request id>` first, with an amount and a payee of its
 * own; the real `MAINTENANCE_APPROVED` then found that row under
 * `ux_transaction_source_fact` and recorded nothing, so the repair was "owed"
 * on the attacker's terms. `PAYMENT_INTENT/<intent id>` held first made the
 * capture's write fail on the same key, so money captured at the provider was
 * not credited. `STATEMENT` was the same hole, closed in CON-003 PR 6b.
 *
 * `ORDER/<order id>` held first by the buyer's administrator made the order
 * saga's own creation 409, and its recovery adopted the administrator's row —
 * 1 rial to an accomplice — and settled it (review of #334 round 1, F1).
 *
 * Each case drives the attack and then the owner's real fact through the real
 * writer — the consumer, the top-up, the saga's call — and asserts the owner's
 * terms won. The database half (`ck_transaction_recorded_source`,
 * `ck_transaction_order_source`) is driven past the API, as code that skipped
 * the rule, or an earlier release, would write.
 */
describe('source types economic-service records itself — no caller pre-empts one', () => {
  let harness: ApiHarness;
  let http: Server;
  let transactions: TransactionService;
  let settlementAuthority: SettlementAuthorityConsumer;
  const sources = new FakeSourceFacts();

  const payer = apiTenant('RSV-PAYER');
  const workshop = apiTenant('RSV-WORKSHOP');
  const accomplice = apiTenant('RSV-ACCOMPLICE');

  /** Runs once, between the provider's capture and the credit it leads to. */
  let beforeCaptureReturns: ((intentId: string) => Promise<void>) | null = null;
  class InterceptedProvider extends MockPaymentProvider {
    override async capture(captureRequest: CaptureRequest): Promise<CaptureResult> {
      const result = await super.capture(captureRequest);
      const hook = beforeCaptureReturns;
      beforeCaptureReturns = null;
      if (hook) await hook(captureRequest.paymentIntentId);
      return result;
    }
  }

  const noBroker = (): EventConsumer =>
    ({ start: async () => undefined, stop: async () => undefined }) as unknown as EventConsumer;

  beforeAll(async () => {
    harness = await startApi({ paymentProvider: new InterceptedProvider() });
    http = harness.app.getHttpServer() as Server;
    transactions = harness.app.get(TransactionService);
    // The real consumer over the API's own database and service: the one
    // writer of MAINTENANCE_REQUEST rows, as AppModule wires it.
    settlementAuthority = new SettlementAuthorityConsumer(
      noBroker,
      harness.prisma,
      transactions,
      sources,
    );
    for (const organization of [payer, workshop, accomplice]) {
      await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(organization)}`)
        .expect(200);
    }
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, workshop, accomplice]);
    await harness.close();
  });

  const rowsUnder = (sourceType: string, sourceReference: string) =>
    runUnscoped('the suite looks for the key in every tenant', () =>
      harness.prisma.client.transaction.findMany({ where: { sourceType, sourceReference } }),
    );

  /** Every caller `POST /v1/transactions` admits, each acting for the payer where it can. */
  const callers: [string, () => Promise<[header: string, value: string]>][] = [
    [
      'the payer’s organization administrator',
      async () => ['authorization', `Bearer ${admin(payer)}`],
    ],
    [
      'the payer’s SYSTEM_ADMIN',
      async () => ['authorization', `Bearer ${admin(payer, ['SYSTEM_ADMIN'])}`],
    ],
    ['a platform administrator', async () => ['authorization', `Bearer ${platformAdmin()}`]],
    [
      'another organization’s administrator',
      async () => ['authorization', `Bearer ${admin(accomplice)}`],
    ],
    ...(['marketplace-service', 'contract-service', 'procurement-service'] as const).map(
      (service): [string, () => Promise<[string, string]>] => [
        `${service}, signed for the payer`,
        async () => ['x-internal-token', await internalToken(service, { organizationId: payer })],
      ],
    ),
  ];

  const claim = (
    caller: [string, string],
    sourceType: string,
    sourceReference: string,
    overrides: Record<string, unknown> = {},
  ) =>
    request(http)
      .post('/v1/transactions')
      .set(caller[0], caller[1])
      .set('idempotency-key', id('rsv-claim'))
      .send({
        transactionType: 'MAINTENANCE_SERVICE',
        counterpartyOrganizationId: accomplice,
        grossAmountMinor: '1',
        currency: 'IRR',
        sourceType,
        sourceReference,
        ...overrides,
      });

  // -------------------------------------------------------------------------
  // The one rule, for every type and every caller
  // -------------------------------------------------------------------------

  const types = Object.values(ECONOMIC_RECORDED_SOURCE_TYPES);
  const matrix = types.flatMap((sourceType) =>
    callers.map(([who, caller]) => [sourceType, who, caller] as const),
  );

  it.each(matrix)(
    'refuses %s from %s: 400 VALIDATION_FAILED, nothing written',
    async (sourceType, _who, caller) => {
      const reference = `REF_${ulid()}`;
      const response = await claim(await caller(), sourceType, reference).expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      const details = response.body.details as { path: string }[];
      expect(details).toContainEqual({
        path: 'sourceType',
        code: 'custom',
        message: RECORDED_SOURCE_REFUSAL,
      });
      expect(details.every((detail) => detail.path === 'sourceType')).toBe(true);
      // A fixed text: the refusal never echoes what was sent.
      expect(JSON.stringify(response.body)).not.toContain(reference);
      expect(await rowsUnder(sourceType, reference)).toHaveLength(0);
    },
  );

  it.each(types)(
    'refuses %s padded with whitespace (the schema trims first)',
    async (sourceType) => {
      const reference = `REF_${ulid()}`;
      const response = await claim(
        ['authorization', `Bearer ${admin(payer)}`],
        `  ${sourceType}\t`,
        reference,
      ).expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(await rowsUnder(sourceType, reference)).toHaveLength(0);
    },
  );

  // -------------------------------------------------------------------------
  // MAINTENANCE_REQUEST — the approval is recorded on the owner's terms
  // -------------------------------------------------------------------------

  describe('MAINTENANCE_REQUEST', () => {
    function approvalOf(requestId: string) {
      return {
        requestId,
        assetId: `AST_${ulid()}`,
        organizationId: payer,
        approvedBy: 'USR-RSV-APPROVER',
        approvedAt: new Date().toISOString(),
        workshopOrganizationId: workshop,
        totalCostMinor: '640000',
        currency: 'IRR',
      };
    }

    function approvedEvent(payload: ReturnType<typeof approvalOf>): EventEnvelope {
      return {
        eventId: ulid(),
        eventName: CONSUMED_EVENTS.MAINTENANCE_APPROVED,
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'maintenance-service',
        producerVersion: '0.1.0',
        aggregateType: 'MaintenanceRequest',
        aggregateId: payload.requestId,
        tenantId: payload.organizationId,
        correlationId: `rsv-itest-${ulid()}`,
        payload,
      } as EventEnvelope;
    }

    async function expectOwnersObligation(requestId: string, eventId: string) {
      const rows = await rowsUnder('MAINTENANCE_REQUEST', requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: payer,
        counterpartyOrganizationId: workshop,
        transactionType: 'MAINTENANCE_SERVICE',
        status: 'PENDING_SETTLEMENT',
        grossAmountMinor: 640_000n,
        causationId: eventId,
        idempotencyKey: null,
        createdBy: 'economic-service',
      });
    }

    it.each(callers)(
      'after %s tried to claim the request first, the approval records the owner’s amount and workshop',
      async (_who, caller) => {
        const payload = approvalOf(`MNT_${ulid()}`);
        sources.approved(payload);

        const attempt = await claim(await caller(), 'MAINTENANCE_REQUEST', payload.requestId);

        // The consequence first: before, the payer's own administrator or a
        // service signed for it got 201 here, and the approval then found
        // that row and recorded nothing — the repair owed 1 rial to the
        // accomplice.
        const event = approvedEvent(payload);
        await expect(settlementAuthority.handle(event)).resolves.toBeUndefined();
        await expectOwnersObligation(payload.requestId, event.eventId);
        expect(attempt.status).toBe(400);
      },
    );

    it('a look-alike under another spelling takes a different key and blocks nothing', async () => {
      const payload = approvalOf(`MNT_${ulid()}`);
      sources.approved(payload);
      // Not the reserved value, so not refused — and not the consumer's key
      // either: the unique index compares exactly.
      await claim(
        ['authorization', `Bearer ${admin(payer)}`],
        'maintenance_request',
        payload.requestId,
      ).expect(201);

      const event = approvedEvent(payload);
      await settlementAuthority.handle(event);
      await expectOwnersObligation(payload.requestId, event.eventId);
    });

    it('the database refuses an HTTP-shaped row past the API, and the approval still records', async () => {
      const payload = approvalOf(`MNT_${ulid()}`);
      sources.approved(payload);

      // TransactionService.create is what the route calls after the schema: a
      // caller that skipped the rule writes exactly this.
      await expect(
        asActor({ organizationId: payer }, () =>
          transactions.create({
            transactionType: 'MAINTENANCE_SERVICE',
            counterpartyOrganizationId: accomplice,
            grossAmountMinor: '1',
            currency: 'IRR',
            sourceType: 'MAINTENANCE_REQUEST',
            sourceReference: payload.requestId,
            holdFunds: false,
            idempotencyKey: id('rsv-bypass'),
          }),
        ),
      ).rejects.toThrow(/ck_transaction_recorded_source/);

      // Every part of the writer's shape counts, not only the key.
      const insert = (overrides: Record<string, string | null>, reference = payload.requestId) => {
        const row = {
          transaction_type: 'MAINTENANCE_SERVICE',
          idempotency_key: null as string | null,
          causation_id: ulid() as string | null,
          created_by: 'economic-service',
          counterparty_organization_id: accomplice as string | null,
          ...overrides,
        };
        return runUnscoped('the suite writes as code that skipped the API would', () =>
          harness.prisma.client.$executeRawUnsafe(
            `INSERT INTO "transaction" (id, organization_id, counterparty_organization_id,
               transaction_type, status, gross_amount_minor, currency, occurred_at, source_type,
               source_reference, idempotency_key, causation_id, correlation_id, created_by, updated_at)
             VALUES ($1, $2, $3, $4::"TransactionType", 'PENDING_SETTLEMENT', 1, 'IRR', now(),
               'MAINTENANCE_REQUEST', $5, $6, $7, 'corr', $8, now())`,
            id('TXN'),
            payer,
            row.counterparty_organization_id,
            row.transaction_type,
            reference,
            row.idempotency_key,
            row.causation_id,
            row.created_by,
          ),
        );
      };
      const unlikeTheWriter: Record<string, string | null>[] = [
        { idempotency_key: 'a-client-key-123' },
        { causation_id: null },
        { created_by: 'USR-SOMEONE' },
        { transaction_type: 'MARKETPLACE_ORDER' },
        { counterparty_organization_id: null },
      ];
      for (const overrides of unlikeTheWriter) {
        await expect(insert(overrides)).rejects.toThrow(/ck_transaction_recorded_source/);
      }
      // The control: the writer's own shape, under another request, is
      // admitted — so each refusal above is this CHECK's, for that column.
      await expect(insert({}, `MNT_${ulid()}`)).resolves.toBe(1);
      expect(await rowsUnder('MAINTENANCE_REQUEST', payload.requestId)).toHaveLength(0);

      const event = approvedEvent(payload);
      await settlementAuthority.handle(event);
      await expectOwnersObligation(payload.requestId, event.eventId);
    });
  });

  // -------------------------------------------------------------------------
  // PAYMENT_INTENT — the capture credits the wallet
  // -------------------------------------------------------------------------

  describe('PAYMENT_INTENT', () => {
    async function walletOfPayer() {
      const wallet = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(payer)}`)
        .expect(200);
      return wallet.body as { id: string; ledgerBalanceMinor: string };
    }

    it.each(callers)(
      'a claim on the intent by %s while it is being captured does not stop the credit',
      async (_who, caller) => {
        const wallet = await walletOfPayer();
        const before = BigInt(wallet.ledgerBalanceMinor);
        let attempted: request.Response | undefined;
        // The window: the provider has captured, and the intent's id is
        // known (GET /v1/payment-intents lists it), but the top-up row is not
        // yet written.
        beforeCaptureReturns = async (intentId) => {
          attempted = await claim(await caller(), 'PAYMENT_INTENT', intentId, {
            transactionType: 'MARKETPLACE_ORDER',
          });
        };

        const topUp = await request(http)
          .post(`/v1/wallets/${wallet.id}/top-up`)
          .set('authorization', `Bearer ${admin(payer)}`)
          .set('idempotency-key', id('rsv-topup'))
          .send({ amountMinor: '70000' })
          .expect(201);

        expect(attempted?.status).toBe(400);
        expect(attempted?.body.code).toBe('VALIDATION_FAILED');
        expect(topUp.body.status).toBe('CAPTURED');
        expect(BigInt(topUp.body.balances.ledgerBalanceMinor)).toBe(before + 70_000n);
        const rows = await rowsUnder('PAYMENT_INTENT', topUp.body.paymentIntentId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: topUp.body.transactionId,
          organizationId: payer,
          transactionType: 'WALLET_TOP_UP',
          status: 'SETTLED',
          grossAmountMinor: 70_000n,
          counterpartyOrganizationId: null,
          idempotencyKey: null,
        });
      },
    );

    it('the database refuses an HTTP-shaped row past the API, and the capture still credits', async () => {
      const wallet = await walletOfPayer();
      const before = BigInt(wallet.ledgerBalanceMinor);
      const refusals: unknown[] = [];
      const topUpRow = (intentId: string, idempotencyKey: string | null) =>
        runUnscoped('the suite writes as code that skipped the API would', () =>
          harness.prisma.client.$executeRawUnsafe(
            `INSERT INTO "transaction" (id, organization_id, transaction_type, status,
               gross_amount_minor, net_amount_minor, currency, occurred_at, settled_at,
               source_type, source_reference, idempotency_key, correlation_id, created_by,
               updated_at)
             VALUES ($1, $2, 'WALLET_TOP_UP', 'SETTLED', 1, 1, 'IRR', now(), now(),
               'PAYMENT_INTENT', $3, $4, 'corr', 'USR-SOMEONE', now())`,
            id('TXN'),
            payer,
            intentId,
            idempotencyKey,
          ),
        );
      beforeCaptureReturns = async (intentId) => {
        refusals.push(
          await asActor({ organizationId: payer }, () =>
            transactions.create({
              transactionType: 'MARKETPLACE_ORDER',
              counterpartyOrganizationId: accomplice,
              grossAmountMinor: '1',
              currency: 'IRR',
              sourceType: 'PAYMENT_INTENT',
              sourceReference: intentId,
              holdFunds: false,
              idempotencyKey: id('rsv-bypass'),
            }),
          ).then(
            () => 'written',
            (error: unknown) => error,
          ),
        );
        // A top-up-typed row is still not the capture's: it carries a key.
        refusals.push(
          await topUpRow(intentId, 'a-client-key-123').then(
            () => 'written',
            (error: unknown) => error,
          ),
        );
      };

      const topUp = await request(http)
        .post(`/v1/wallets/${wallet.id}/top-up`)
        .set('authorization', `Bearer ${admin(payer)}`)
        .set('idempotency-key', id('rsv-topup-db'))
        .send({ amountMinor: '80000' })
        .expect(201);

      expect(refusals).toHaveLength(2);
      for (const refusal of refusals) {
        expect(String(refusal)).toMatch(/ck_transaction_recorded_source/);
      }
      expect(topUp.body.status).toBe('CAPTURED');
      expect(BigInt(topUp.body.balances.ledgerBalanceMinor)).toBe(before + 80_000n);
      expect(await rowsUnder('PAYMENT_INTENT', topUp.body.paymentIntentId)).toHaveLength(1);
      // The control: without the key, under another intent, the row is
      // admitted — so the refusal above is this CHECK's.
      await expect(topUpRow(`PAY_${ulid()}`, null)).resolves.toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // STATEMENT — reserved before its consumer exists
  // -------------------------------------------------------------------------

  describe('STATEMENT', () => {
    it.each(callers)(
      'no row under a statement’s key can be written by %s ahead of its consumer',
      async (_who, caller) => {
        const statementId = `STM_${ulid()}`;
        await claim(await caller(), 'STATEMENT', statementId, {
          transactionType: 'CONSTRUCTION_STATEMENT',
        }).expect(400);
        expect(await rowsUnder('STATEMENT', statementId)).toHaveLength(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // ORDER — marketplace-service's alone (review of #334 round 1, F1)
  // -------------------------------------------------------------------------

  describe('ORDER', () => {
    const ORDER_TOTAL = '250000';
    const asSaga = async (): Promise<[string, string]> => [
      'x-internal-token',
      await internalToken('marketplace-service', { organizationId: payer }),
    ];

    /** The saga's own call, as marketplace-service's `EconomicClient.createObligation` sends it. */
    const sagaCreates = async (orderId: string) =>
      request(http)
        .post('/v1/transactions')
        .set(...(await asSaga()))
        .set('idempotency-key', `order:${orderId}:hold`)
        .send({
          transactionType: 'MARKETPLACE_ORDER',
          counterpartyOrganizationId: workshop,
          grossAmountMinor: ORDER_TOTAL,
          currency: 'IRR',
          sourceType: 'ORDER',
          sourceReference: orderId,
          holdFunds: true,
        });

    /** The attack: 1 rial to the accomplice, held, under the pending order's key. */
    const preRecord = (caller: [string, string], orderId: string) =>
      claim(caller, 'ORDER', orderId, { transactionType: 'MARKETPLACE_ORDER', holdFunds: true });

    /** What the saga's recovery reads (`EconomicClient.findObligations`). */
    const sagaFinds = async (orderId: string) => {
      const query = new URLSearchParams({
        sourceReference: orderId,
        transactionType: 'MARKETPLACE_ORDER',
      });
      const page = await request(http)
        .get(`/v1/transactions?${query.toString()}`)
        .set(...(await asSaga()))
        .expect(200);
      return page.body.items as Record<string, unknown>[];
    };

    beforeAll(async () => {
      const wallet = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(payer)}`)
        .expect(200);
      await request(http)
        .post(`/v1/wallets/${wallet.body.id}/top-up`)
        .set('authorization', `Bearer ${admin(payer)}`)
        .set('idempotency-key', id('rsv-order-funds'))
        .send({ amountMinor: '5000000' })
        .expect(201);
    });

    const others = callers.filter(([who]) => !who.startsWith('marketplace-service'));

    it.each(others)(
      'refuses ORDER from %s: 400 VALIDATION_FAILED, nothing written, nothing held',
      async (_who, caller) => {
        const orderId = `ORD_${ulid()}`;
        const response = await preRecord(await caller(), orderId).expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect(response.body.details).toEqual([
          { path: 'sourceType', code: 'custom', message: RECORDED_SOURCE_REFUSAL },
        ]);
        expect(JSON.stringify(response.body)).not.toContain(orderId);
        expect(await rowsUnder('ORDER', orderId)).toHaveLength(0);
      },
    );

    it('refuses ORDER from marketplace-service as any other transaction type', async () => {
      const orderId = `ORD_${ulid()}`;
      const response = await claim(await asSaga(), 'ORDER', orderId, {
        transactionType: 'LOGISTICS',
      }).expect(400);
      expect(response.body.details).toEqual([
        { path: 'sourceType', code: 'custom', message: RECORDED_SOURCE_REFUSAL },
      ]);
      expect(await rowsUnder('ORDER', orderId)).toHaveLength(0);
    });

    it('the exact attack: the buyer’s administrator records a pending order’s obligation first — refused, and the saga records the order’s terms', async () => {
      const orderId = `ORD_${ulid()}`;

      const attack = await preRecord(['authorization', `Bearer ${admin(payer)}`], orderId);
      // Before: 201, and the saga's own creation below got 409; its recovery
      // then found this row and settled 1 rial to the accomplice.
      expect(attack.status).toBe(400);

      const created = await sagaCreates(orderId);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        status: 'HELD',
        organizationId: payer,
        counterpartyOrganizationId: workshop,
        grossAmountMinor: ORDER_TOTAL,
        sourceType: 'ORDER',
        sourceReference: orderId,
      });
      const found = await sagaFinds(orderId);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ id: created.body.id, grossAmountMinor: ORDER_TOTAL });
    });

    it('the database refuses a person’s ORDER row past the API, and the saga still records', async () => {
      const orderId = `ORD_${ulid()}`;

      // TransactionService.create is what the route calls after its checks: a
      // caller that skipped them writes exactly this — as a person.
      await expect(
        asActor({ organizationId: payer }, () =>
          transactions.create({
            transactionType: 'MARKETPLACE_ORDER',
            counterpartyOrganizationId: accomplice,
            grossAmountMinor: '1',
            currency: 'IRR',
            sourceType: 'ORDER',
            sourceReference: orderId,
            holdFunds: false,
            idempotencyKey: id('rsv-order-bypass'),
          }),
        ),
      ).rejects.toThrow(/ck_transaction_order_source/);

      const insert = (overrides: Record<string, string | null>, reference = orderId) => {
        const row = {
          transaction_type: 'MARKETPLACE_ORDER',
          idempotency_key: `order:${reference}:hold` as string | null,
          created_by: 'economic-service',
          counterparty_organization_id: accomplice as string | null,
          ...overrides,
        };
        return runUnscoped('the suite writes as code that skipped the API would', () =>
          harness.prisma.client.$executeRawUnsafe(
            `INSERT INTO "transaction" (id, organization_id, counterparty_organization_id,
               transaction_type, status, gross_amount_minor, currency, occurred_at, source_type,
               source_reference, idempotency_key, correlation_id, created_by, updated_at)
             VALUES ($1, $2, $3, $4::"TransactionType", 'CREATED', 1, 'IRR', now(),
               'ORDER', $5, $6, 'corr', $7, now())`,
            id('TXN'),
            payer,
            row.counterparty_organization_id,
            row.transaction_type,
            reference,
            row.idempotency_key,
            row.created_by,
          ),
        );
      };
      const unlikeAService: Record<string, string | null>[] = [
        { created_by: 'USR-SOMEONE' },
        { idempotency_key: null },
        { transaction_type: 'LOGISTICS' },
        { counterparty_organization_id: null },
      ];
      for (const overrides of unlikeAService) {
        await expect(insert(overrides)).rejects.toThrow(/ck_transaction_order_source/);
      }
      // The control: a service's shape, under another order, is admitted — so
      // each refusal above is this CHECK's, for that column.
      await expect(insert({}, `ORD_${ulid()}`)).resolves.toBe(1);
      expect(await rowsUnder('ORDER', orderId)).toHaveLength(0);

      expect((await sagaCreates(orderId)).status).toBe(201);
      expect(await sagaFinds(orderId)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Everything else is as it was
  // -------------------------------------------------------------------------

  describe('the source types callers own stay theirs', () => {
    it('marketplace-service records an order’s obligation under ORDER', async () => {
      const orderId = `ORD_${ulid()}`;
      const response = await claim(
        ['x-internal-token', await internalToken('marketplace-service', { organizationId: payer })],
        'ORDER',
        orderId,
        { transactionType: 'MARKETPLACE_ORDER', grossAmountMinor: '25000' },
      ).expect(201);
      expect(response.body).toMatchObject({ sourceType: 'ORDER', sourceReference: orderId });
      expect(await rowsUnder('ORDER', orderId)).toHaveLength(1);
    });

    it('an administrator records an obligation under a source type of their own', async () => {
      const reference = `E2E_${ulid()}`;
      const response = await claim(
        ['authorization', `Bearer ${admin(payer)}`],
        'E2E',
        reference,
      ).expect(201);
      expect(response.body).toMatchObject({ sourceType: 'E2E', sourceReference: reference });
    });

    it('an obligation with no source at all is recorded as before', async () => {
      await request(http)
        .post('/v1/transactions')
        .set('authorization', `Bearer ${admin(payer)}`)
        .set('idempotency-key', id('rsv-plain'))
        .send({
          transactionType: 'LOGISTICS',
          counterpartyOrganizationId: workshop,
          grossAmountMinor: '3000',
        })
        .expect(201);
    });
  });
});
