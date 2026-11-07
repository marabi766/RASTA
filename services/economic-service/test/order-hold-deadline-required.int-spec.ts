import request from 'supertest';
import type { Server } from 'node:http';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { runUnscoped, type JsonSchema } from '@rasta/nest-common';
import { enrichOpenApiDocument } from '../src/openapi/document';
import { schemaMismatches } from '../src/openapi/schema-mismatches';
import { TransactionService } from '../src/transaction/transaction.service';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id, ORDER_HOLD_DEADLINE } from './helpers';

/**
 * An order's hold without the order's deadline (D-150; review of #812 r3, F1).
 *
 * marketplace-service counts each hold it sends on the order and gives every one the
 * order's `holdNotAfter`. An older or rolled-back marketplace build sends the same
 * request with neither, so the order's row cannot know of it, and an upgraded saga that
 * reads "no send began" would close the order while that hold lands. So this service
 * refuses every such request, whoever sends it: nothing held, nothing recorded, the key
 * left free.
 *
 * On data an earlier economic build left: an answer it stored under the key is still
 * replayed (the hold it names already exists, and is the saga's to find), its obligations
 * in flight still move, and a purged or expired record of it is judged anew, so refused.
 */
describe('an order hold without its deadline (HTTP, real database)', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('FENCE-PAYER');
  const payee = apiTenant('FENCE-PAYEE');
  const walletless = apiTenant('FENCE-NO-WALLET');
  const ENDPOINT = 'POST /v1/transactions';
  const AMOUNT = '7000';
  const asSaga = () => internalToken('marketplace-service', { organizationId: payer });

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    const w = await wallet();
    await request(http)
      .post(`/v1/wallets/${w.id}/top-up`)
      .set('authorization', `Bearer ${admin(payer)}`)
      .set('idempotency-key', id('fence-topup'))
      .send({ amountMinor: '500000' })
      .expect(201);
    await request(http)
      .get('/v1/wallets/me')
      .set('authorization', `Bearer ${admin(payee)}`)
      .expect(200);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, walletless]);
    await harness.close();
  });

  async function wallet() {
    return (
      await request(http)
        .get('/v1/wallets/me')
        .set('authorization', `Bearer ${admin(payer)}`)
        .expect(200)
    ).body as { id: string; availableBalanceMinor: string };
  }

  /**
   * The saga's hold, as `EconomicClient.createObligation` sends it. Without `holdNotAfter`
   * it is byte for byte what origin/main's build sends: that build has no deadline at all.
   */
  const hold = async (orderId: string, holdNotAfter?: string) =>
    request(http)
      .post('/v1/transactions')
      .set('x-internal-token', await asSaga())
      .set('idempotency-key', `order:${orderId}:hold`)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: AMOUNT,
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: orderId,
        holdFunds: true,
        ...(holdNotAfter === undefined ? {} : { holdNotAfter }),
      });

  /**
   * The earlier economic build, which held without asking for a deadline: the key's record
   * is of the deadline-less request, as that build wrote it, and only the rule is not asked.
   */
  const asEarlierBuild = () => {
    const transactions = harness.app.get(TransactionService);
    const { create } = TransactionService.prototype;
    return jest
      .spyOn(transactions, 'create')
      .mockImplementation((dto, answer) =>
        create.call(
          transactions,
          { ...dto, holdNotAfter: dto.holdNotAfter ?? ORDER_HOLD_DEADLINE },
          answer,
        ),
      );
  };

  const record = (orderId: string) =>
    runUnscoped('the suite reads the idempotency record', () =>
      harness.prisma.client.idempotencyKey.findFirst({
        where: { organizationId: payer, endpoint: ENDPOINT, key: `order:${orderId}:hold` },
      }),
    );
  const obligations = (orderId: string) =>
    runUnscoped('the suite reads what the requests recorded', () =>
      harness.prisma.client.transaction.findMany({
        where: { sourceType: 'ORDER', sourceReference: orderId },
        select: { id: true, status: true },
      }),
    );
  const refused = (response: request.Response) =>
    expect({ status: response.status, code: (response.body as { code?: string }).code }).toEqual({
      status: 422,
      code: 'HOLD_DEADLINE_REQUIRED',
    });

  it('the older build’s send is refused: nothing held, nothing recorded, the key free', async () => {
    const orderId = id('ORD');
    const before = (await wallet()).availableBalanceMinor;

    refused(await hold(orderId));

    expect(await obligations(orderId)).toEqual([]);
    expect(await record(orderId)).toBeNull();
    expect((await wallet()).availableBalanceMinor).toBe(before);
  });

  it('the capability the saga reads says so, from the same release that refuses (FU-233)', async () => {
    const asked = await request(http)
      .get('/v1/transactions/capabilities')
      .set('x-internal-token', await internalToken('marketplace-service'));
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ orderHoldDeadlineRequired: true });
    const orderId = id('ORD');
    refused(await hold(orderId));
    expect(await obligations(orderId)).toEqual([]);
  });

  // Review of #948 r1, L5: the answer is the documented one, both ways (API-first).
  it('the capability answers what the OpenAPI document says, both ways', async () => {
    const document = enrichOpenApiDocument(
      SwaggerModule.createDocument(
        harness.app,
        new DocumentBuilder().setTitle('t').setVersion('0.0.0').build(),
      ),
    );
    const responses = document.paths['/v1/transactions/capabilities']?.get?.responses ?? {};
    const schema = (
      responses['200'] as unknown as { content: Record<string, { schema: JsonSchema }> }
    ).content['application/json']!.schema;
    expect(schema).toEqual({ $ref: '#/components/schemas/TransactionCapabilities' });

    const asked = await request(http)
      .get('/v1/transactions/capabilities')
      .set('x-internal-token', await internalToken('marketplace-service'))
      .expect(200);
    const components = (document.components?.schemas ?? {}) as Record<string, JsonSchema>;
    const path = 'GET /v1/transactions/capabilities';
    expect(schemaMismatches(schema, asked.body, path, components)).toEqual([]);
    // Not vacuous: a field the document does not carry, or a word for a boolean, is refused.
    expect(schemaMismatches(schema, { ...asked.body, extra: true }, 'x', components)).not.toEqual(
      [],
    );
    expect(
      schemaMismatches(
        schema,
        { ...asked.body, orderHoldDeadlineRequired: 'true' },
        'x',
        components,
      ),
    ).not.toEqual([]);
  });

  it('refused before anything is opened: a payer with no wallet still has none', async () => {
    const orderId = id('ORD');
    const wallets = () =>
      runUnscoped('the suite counts the payer’s wallets', () =>
        harness.prisma.client.wallet.count({ where: { organizationId: walletless } }),
      );
    const response = await request(http)
      .post('/v1/transactions')
      .set(
        'x-internal-token',
        await internalToken('marketplace-service', { organizationId: walletless }),
      )
      .set('idempotency-key', `order:${orderId}:hold`)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: AMOUNT,
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: orderId,
        holdFunds: true,
      });
    refused(response);
    expect(await wallets()).toBe(0);
  });

  it('every retry of it, and concurrent ones, the same: no hold ever lands from it', async () => {
    const orderId = id('ORD');
    const before = (await wallet()).availableBalanceMinor;
    refused(await hold(orderId));
    refused(await hold(orderId));
    // Concurrent: each is refused, or meets another's claim in flight (409). None holds.
    for (const answer of await Promise.all(Array.from({ length: 6 }, () => hold(orderId)))) {
      expect([422, 409]).toContain(answer.status);
      if (answer.status === 422) refused(answer);
    }
    expect(await obligations(orderId)).toEqual([]);
    expect((await wallet()).availableBalanceMinor).toBe(before);
  });

  it('then this build’s counted send under the same key holds, once', async () => {
    const orderId = id('ORD');
    refused(await hold(orderId));

    const placed = await hold(orderId, ORDER_HOLD_DEADLINE);
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({ status: 'HELD', sourceReference: orderId });
    // The older build's retry after it: answered by the key, never a second hold.
    const older = await hold(orderId);
    expect({ status: older.status, code: older.body.code }).toEqual({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await obligations(orderId)).toEqual([{ id: placed.body.id, status: 'HELD' }]);
  });

  it('racing the two builds under one key: exactly the counted send holds', async () => {
    const orderId = id('ORD');
    const answers = await Promise.all([
      hold(orderId),
      hold(orderId, ORDER_HOLD_DEADLINE),
      hold(orderId),
      hold(orderId),
    ]);
    for (const answer of [answers[0], answers[2], answers[3]]) {
      expect(answer.status).not.toBe(201);
    }
    const held = await obligations(orderId);
    expect(held.length).toBeLessThanOrEqual(1);
    if (answers[1]!.status === 201)
      expect(held).toEqual([{ id: answers[1]!.body.id, status: 'HELD' }]);
    // Whatever the race left, the counted send still holds once when retried.
    const retried = await hold(orderId, ORDER_HOLD_DEADLINE);
    expect(retried.status).toBe(201);
    expect(await obligations(orderId)).toEqual([{ id: retried.body.id, status: 'HELD' }]);
  });

  describe('data an earlier economic build left', () => {
    /** A hold that build placed for the older saga's send, its answer stored under the key. */
    async function legacyHold(orderId: string) {
      const spy = asEarlierBuild();
      const placed = await hold(orderId);
      spy.mockRestore();
      expect(placed.status).toBe(201);
      expect(await record(orderId)).toMatchObject({ state: 'COMPLETED', responseStatus: 201 });
      return placed.body as { id: string };
    }

    it('its stored answer is replayed to the older build’s retry: no second hold', async () => {
      const orderId = id('ORD');
      const legacy = await legacyHold(orderId);
      const before = (await wallet()).availableBalanceMinor;

      const replayed = await hold(orderId);
      expect(replayed.status).toBe(201);
      expect(replayed.body.id).toBe(legacy.id);
      expect(await obligations(orderId)).toEqual([{ id: legacy.id, status: 'HELD' }]);
      expect((await wallet()).availableBalanceMinor).toBe(before);
    });

    it.each([
      [
        'purged',
        (orderId: string) =>
          runUnscoped('the suite purges the record', () =>
            harness.prisma.client.idempotencyKey.deleteMany({
              where: { organizationId: payer, endpoint: ENDPOINT, key: `order:${orderId}:hold` },
            }),
          ),
      ],
      [
        'expired',
        (orderId: string) =>
          runUnscoped('the suite expires the record', () =>
            harness.prisma.client.$executeRawUnsafe(
              `UPDATE idempotency_key
                  SET created_at = now() - interval '48 hours',
                      expires_at = now() - interval '24 hours'
                WHERE organization_id = $1 AND endpoint = $2 AND key = $3`,
              payer,
              ENDPOINT,
              `order:${orderId}:hold`,
            ),
          ),
      ],
    ] as const)(
      'its record %s: judged anew, so refused, and the hold it placed is still the only one',
      async (_name, age) => {
        const orderId = id('ORD');
        const legacy = await legacyHold(orderId);
        await age(orderId);
        const before = (await wallet()).availableBalanceMinor;

        refused(await hold(orderId));

        expect(await obligations(orderId)).toEqual([{ id: legacy.id, status: 'HELD' }]);
        expect((await wallet()).availableBalanceMinor).toBe(before);
      },
    );

    it('an obligation it held, in flight: authorised and refunded as ever', async () => {
      const authorised = await legacyHold(id('ORD'));
      await request(http)
        .post(`/v1/transactions/${authorised.id}/authorise-settlement`)
        .set('x-internal-token', await asSaga())
        .set('idempotency-key', id('fence-auth'))
        .expect(200);

      const refunded = await legacyHold(id('ORD'));
      const before = BigInt((await wallet()).availableBalanceMinor);
      const response = await request(http)
        .post(`/v1/transactions/${refunded.id}/refund`)
        .set('x-internal-token', await asSaga())
        .set('idempotency-key', id('fence-refund'))
        .send({ reason: 'A hold arrived after the saga gave up on it' })
        .expect(200);
      expect(response.body.status).toBe('REFUNDED');
      expect(BigInt((await wallet()).availableBalanceMinor)).toBe(before + BigInt(AMOUNT));
    });
  });

  it('anything else holds without a deadline as ever: another source, or an order not held', async () => {
    const freight = await request(http)
      .post('/v1/transactions')
      .set('authorization', `Bearer ${admin(payer)}`)
      .set('idempotency-key', id('fence-freight'))
      .send({
        transactionType: 'LOGISTICS',
        counterpartyOrganizationId: payee,
        grossAmountMinor: AMOUNT,
        currency: 'IRR',
        holdFunds: true,
        sourceType: 'FREIGHT',
        sourceReference: id('REF'),
      });
    expect(freight.status).toBe(201);
    expect(freight.body.status).toBe('HELD');

    const orderId = id('ORD');
    const unheld = await request(http)
      .post('/v1/transactions')
      .set('x-internal-token', await asSaga())
      .set('idempotency-key', `order:${orderId}:hold`)
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: AMOUNT,
        currency: 'IRR',
        sourceType: 'ORDER',
        sourceReference: orderId,
        holdFunds: false,
      });
    expect(unheld.status).toBe(201);
    expect(unheld.body.status).toBe('CREATED');
  });
});
