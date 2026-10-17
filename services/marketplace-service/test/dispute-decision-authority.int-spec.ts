import request from 'supertest';
import { Logger } from '@nestjs/common';
import { createSystemContext, runUnscoped, runWithContext } from '@rasta/nest-common';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ulid } from 'ulid';
import {
  apiKey,
  apiTenant,
  buyer,
  platformAdmin,
  startApi,
  supplier,
  unionAdmin,
  verifyInternalToken,
  type ApiHarness,
} from './api-helpers';
import { cleanup, sagaStep } from './helpers';
import { OrderService } from '../src/order/order.service';

/**
 * A union administrator decides a dispute — `SETTLE` or `REFUND` — only for an
 * order whose **buyer** is within its union's subtree (docs/24 Q-136; Codex on
 * #314 round 3, F1), over the real HTTP stack and database, with
 * organization-service stood up as a server that answers as its provider test
 * proves it does (`organization-service/test/construction-hierarchy-contract.int-spec.ts`)
 * and verifies the token marketplace-service sends.
 *
 * The decision is the financial act: the saga then settles or refunds on the
 * buyer's books with the buyer's own service token, and economic-service never
 * sees the operator. So the rule economic-service applies to its own commands
 * is applied here, before the decision is accepted.
 *
 * U is a union with B beneath it; S is another union. B buys from C.
 *
 *   - a `UNION_ADMIN` acting for U decides (both outcomes) — one record line
 *     naming actor, U, B, the authority and the hierarchy version;
 *   - acting for S, or for C (the seller is not the payer): 403, nothing written;
 *   - organization-service down or answering out of contract: 503, nothing written;
 *   - a replay is authorised again — refused once B has left U, or while
 *     organization-service is down, and the stored decision is not shown;
 *   - `SYSTEM_ADMIN` (control): decides for any buyer, nothing asked;
 *   - the saga's compensation after a decision asks nothing and is not refused.
 *
 * "Nothing written" is the order (still `DISPUTED`), its dispute (still
 * `OPEN`), the outbox (no `ORDER_DISPUTE_RESOLVED`) and the idempotency key
 * (no completed answer).
 */
describe('a union administrator decides a dispute only within its union (docs/24 Q-136, HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;
  let organizationService: Server;
  let previousUrl: string | undefined;

  const union = apiTenant('DDA-U');
  const otherUnion = apiTenant('DDA-S');
  const buyerOrg = apiTenant('DDA-B');
  const supplierOrg = apiTenant('DDA-C');

  // ---- organization-service ------------------------------------------------

  /** Parent of each organization; B is under U. */
  const parent = new Map<string, string>();
  const BUYER_VERSION = 9;
  let mode: 'contract' | 'down' | 'wrong-body' = 'contract';
  const asked: { scope: string; caller: string; path: string }[] = [];

  function within(scope: string, organizationId: string): boolean {
    for (let at: string | undefined = organizationId; at; at = parent.get(at)) {
      if (at === scope) return true;
    }
    return false;
  }

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (mode === 'down') {
      res.writeHead(503).end();
      return;
    }
    const claims = await verifyInternalToken(
      String(req.headers['x-internal-token'] ?? ''),
      'organization-service',
    ).catch(() => null);
    if (!claims?.organizationId || claims.purpose !== 'SERVICE') {
      res.writeHead(403).end();
      return;
    }
    const path = req.url ?? '';
    asked.push({ scope: claims.organizationId, caller: claims.callerService ?? '', path });
    const organizationId = decodeURIComponent(path.replace('/v1/organizations/', ''));
    if (mode === 'wrong-body') {
      // 200 for another organization: out of contract, never a yes.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `${organizationId}-X`, hierarchyVersion: BUYER_VERSION }));
      return;
    }
    if (!within(claims.organizationId, organizationId)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Organization not found', path }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: organizationId, hierarchyVersion: BUYER_VERSION }));
  }

  // ---- callers -------------------------------------------------------------

  const asBuyer = () => `Bearer ${buyer(buyerOrg)}`;
  const asSupplier = () => `Bearer ${supplier(supplierOrg)}`;
  const asUnionAdmin = (organizationId = union) =>
    `Bearer ${unionAdmin(organizationId, 'USR-DDA-UNION')}`;
  const asSystemAdmin = () => `Bearer ${platformAdmin(otherUnion)}`;

  const SETTLE = {
    outcome: 'SETTLE',
    resolution: 'the supplier evidenced correct delivery',
    responsibility: 'BUYER',
  };
  const REFUND = {
    outcome: 'REFUND',
    resolution: 'the goods were never delivered to the buyer',
    responsibility: 'SUPPLIER',
  };

  const resolve = (orderId: string, token: string, key: string, body: object) =>
    request(http)
      .post(`/v1/orders/${orderId}/disputes/resolve`)
      .set('authorization', token)
      .set('idempotency-key', key)
      .send(body);

  /** A B→C order, disputed by B. */
  async function disputedOrder(): Promise<string> {
    const product = await request(http)
      .post('/v1/products')
      .set('idempotency-key', apiKey('dda-product'))
      .set('authorization', asSupplier())
      .send({
        sku: `DDA-SKU-${ulid()}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);
    const offer = await request(http)
      .post('/v1/offers')
      .set('idempotency-key', apiKey('dda-offer'))
      .set('authorization', asSupplier())
      .send({
        productId: product.body.id,
        unitPriceMinor: '250000',
        currency: 'IRR',
        availableQuantity: 20,
        leadTimeDays: 3,
        minimumQuantity: 1,
        publish: true,
      })
      .expect(201);
    const order = await request(http)
      .post('/v1/orders')
      .set('authorization', asBuyer())
      .set('idempotency-key', apiKey('dda-order'))
      .send({ lines: [{ offerId: offer.body.id, quantity: 1 }] })
      .expect(201);
    const orderId = order.body.id as string;

    await runUnscoped('the suite advances the order the saga would', () =>
      harness.prisma.client.$executeRawUnsafe(
        `UPDATE "order" SET status='FUNDS_HELD', economic_transaction_id=$2 WHERE id=$1`,
        orderId,
        `TXN_DDA_${orderId}`,
      ),
    );
    await request(http)
      .post(`/v1/orders/${orderId}/disputes`)
      .set('authorization', asBuyer())
      .set('idempotency-key', apiKey('dda-raise'))
      .send({ reason: 'the supplier has not delivered anything at all' })
      .expect(200);
    return orderId;
  }

  /** What a decision writes, for one order and one key of the acting organization. */
  async function written(orderId: string, actingOrganizationId: string, key: string) {
    return runUnscoped('the suite reads what the decision wrote', async () => {
      const client = harness.prisma.client;
      const order = await client.order.findUniqueOrThrow({ where: { id: orderId } });
      const disputes = await client.orderDispute.findMany({ where: { orderId } });
      const resolvedEvents = await client.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM outbox_message
          WHERE aggregate_id = $1 AND event_name = 'ORDER_DISPUTE_RESOLVED'`,
        orderId,
      );
      const keys = await client.idempotencyKey.findMany({
        where: { organizationId: actingOrganizationId, key, state: 'COMPLETED' },
      });
      return {
        status: order.status,
        disputes: disputes.map((dispute) => dispute.status),
        resolvedEvents: Number(resolvedEvents[0]?.n ?? 0),
        completedKeys: keys.length,
      };
    });
  }

  const untouched = { status: 'DISPUTED', disputes: ['OPEN'], resolvedEvents: 0, completedKeys: 0 };

  beforeAll(async () => {
    organizationService = createServer((req, res) => void answer(req, res));
    await new Promise<void>((resolve) => organizationService.listen(0, '127.0.0.1', resolve));
    previousUrl = process.env.ORGANIZATION_SERVICE_URL;
    process.env.ORGANIZATION_SERVICE_URL = `http://127.0.0.1:${(organizationService.address() as AddressInfo).port}`;

    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [union, otherUnion, buyerOrg, supplierOrg]);
    await harness.close();
    organizationService.closeAllConnections();
    await new Promise((resolve) => organizationService.close(resolve));
    if (previousUrl === undefined) delete process.env.ORGANIZATION_SERVICE_URL;
    else process.env.ORGANIZATION_SERVICE_URL = previousUrl;
  });

  beforeEach(() => {
    parent.clear();
    parent.set(buyerOrg, union);
    mode = 'contract';
    asked.length = 0;
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['SETTLE', SETTLE, 'RECEIPT_CONFIRMED', 'RESOLVED_SETTLE'],
    ['REFUND', REFUND, 'CANCELLING', 'RESOLVED_REFUND'],
  ] as const)(
    '%s: a UNION_ADMIN acting for U decides for a buyer of its subtree, asked about the buyer, and records it',
    async (outcome, body, status, disputeStatus) => {
      const orderId = await disputedOrder();
      asked.length = 0;
      const log = jest.spyOn(Logger.prototype, 'log');
      const key = apiKey(`dda-within-${outcome}`);

      const decided = await resolve(orderId, asUnionAdmin(), key, body).expect(200);

      expect(decided.body.status).toBe(status);
      expect(await written(orderId, union, key)).toEqual({
        status,
        disputes: [disputeStatus],
        resolvedEvents: 1,
        completedKeys: 1,
      });
      // One question, signed for U by marketplace-service, about B — never C.
      expect(asked).toEqual([
        {
          scope: union,
          caller: 'marketplace-service',
          path: `/v1/organizations/${encodeURIComponent(buyerOrg)}`,
        },
      ]);
      const records = log.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.startsWith('Dispute decision '));
      expect(records).toEqual([
        `Dispute decision ${outcome} on order ${orderId}: actor=USR-DDA-UNION ` +
          `actingOrganization=${union} buyerOrganization=${buyerOrg} ` +
          `authority=UNION_SUBTREE hierarchyVersion=${BUYER_VERSION}`,
      ]);
    },
  );

  it.each([
    ['SETTLE', SETTLE],
    ['REFUND', REFUND],
  ] as const)(
    '%s: a UNION_ADMIN whose union does not hold the buyer is refused 403 and nothing is written — acting for S, or for the seller C',
    async (outcome, body) => {
      const orderId = await disputedOrder();
      for (const acting of [otherUnion, supplierOrg]) {
        asked.length = 0;
        const warn = jest.spyOn(Logger.prototype, 'warn');
        const key = apiKey(`dda-outside-${outcome}`);

        const refused = await resolve(orderId, asUnionAdmin(acting), key, body).expect(403);

        expect(refused.body.code).toBe('FORBIDDEN');
        expect(await written(orderId, acting, key)).toEqual(untouched);
        expect(asked.map((question) => question.scope)).toEqual([acting]);
        expect(
          warn.mock.calls.some(([message]) =>
            String(message).includes(
              `actingOrganization=${acting} buyerOrganization=${buyerOrg} reason=OUTSIDE_UNION_SUBTREE`,
            ),
          ),
        ).toBe(true);
        warn.mockRestore();
      }
    },
  );

  it.each([['down'], ['wrong-body']] as const)(
    'fails closed when organization-service is %s: 503, nothing written',
    async (how) => {
      const orderId = await disputedOrder();
      mode = how;
      const key = apiKey(`dda-${how}`);

      const refused = await resolve(orderId, asUnionAdmin(), key, REFUND).expect(503);

      expect(refused.body.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(await written(orderId, union, key)).toEqual(untouched);
    },
  );

  it('a replay is authorised again: shown while B is within U, refused 403 once B has left, 503 while organization-service is down', async () => {
    const orderId = await disputedOrder();
    const key = apiKey('dda-replay');
    const first = await resolve(orderId, asUnionAdmin(), key, SETTLE).expect(200);

    asked.length = 0;
    const replayed = await resolve(orderId, asUnionAdmin(), key, SETTLE).expect(200);
    expect(replayed.body).toEqual(first.body);
    // The replay asked again; it was not waved through on the first answer.
    expect(asked.map((question) => question.scope)).toEqual([union]);

    mode = 'down';
    const unavailable = await resolve(orderId, asUnionAdmin(), key, SETTLE).expect(503);
    expect(unavailable.body.status).toBeUndefined();

    mode = 'contract';
    parent.set(buyerOrg, otherUnion);
    const refused = await resolve(orderId, asUnionAdmin(), key, SETTLE).expect(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    // The stored decision is not shown to a caller who could not make it now.
    expect(refused.body.status).toBeUndefined();
  });

  it('is asked under the order row lock: a decision waiting on it has asked nothing, and is judged by the answer after the wait', async () => {
    const orderId = await disputedOrder();
    const key = apiKey('dda-row-lock');
    // Another transaction on the order — the saga, say — holds its row.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (locked = resolve));
    const holder = runUnscoped('a competing transaction holding the order row', () =>
      harness.prisma.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "order" WHERE id = ${orderId} FOR UPDATE`;
          locked();
          await gate;
        },
        { timeout: 30_000 },
      ),
    );
    await held;
    asked.length = 0;

    const decision = resolve(orderId, asUnionAdmin(), key, SETTLE).then((response) => response);
    // `OrderRepository.lockOrder`'s read, waiting.
    const orderLockWaiters = async () => {
      const [row] = await runUnscoped(
        'the suite reads lock waits',
        () =>
          harness.prisma.client.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock'
               AND query LIKE '%cancellation_cause::text AS cancellation_cause%'`,
      );
      return row?.n ?? 0;
    };
    let waitedOnTheRow = false;
    let askedWhileWaiting: unknown[] = [];
    try {
      for (let waited = 0; waited <= 10_000 && !waitedOnTheRow; waited += 20) {
        waitedOnTheRow = (await orderLockWaiters()) > 0;
        if (!waitedOnTheRow) await new Promise((settle) => setTimeout(settle, 20));
      }
      askedWhileWaiting = [...asked];
      // B leaves U while the decision waits; the answer it gets is the one after.
      parent.set(buyerOrg, otherUnion);
    } finally {
      // Released whatever the assertions below find, so nothing is left locked.
      release();
      await holder;
    }
    const response = await decision;

    expect(waitedOnTheRow).toBe(true);
    expect(askedWhileWaiting).toEqual([]);
    expect(response.status).toBe(403);
    expect(asked.map((question) => question.scope)).toEqual([union]);
    expect(await written(orderId, union, key)).toEqual(untouched);
  });

  it('control: a SYSTEM_ADMIN decides for any buyer, and organization-service is not asked', async () => {
    const orderId = await disputedOrder();
    parent.clear();
    mode = 'down';
    asked.length = 0;
    const log = jest.spyOn(Logger.prototype, 'log');
    const key = apiKey('dda-system');

    await resolve(orderId, asSystemAdmin(), key, REFUND).expect(200);
    await resolve(orderId, asSystemAdmin(), key, REFUND).expect(200);

    expect(await written(orderId, otherUnion, key)).toMatchObject({
      status: 'CANCELLING',
      resolvedEvents: 1,
      completedKeys: 1,
    });
    expect(asked).toEqual([]);
    expect(
      log.mock.calls.some(([message]) =>
        String(message).endsWith(
          `actingOrganization=${otherUnion} buyerOrganization=${buyerOrg} authority=SYSTEM_ADMIN`,
        ),
      ),
    ).toBe(true);
  });

  it('a UNION_ADMIN acting for the buyer itself decides without asking', async () => {
    const orderId = await disputedOrder();
    mode = 'down';
    asked.length = 0;

    await resolve(orderId, asUnionAdmin(buyerOrg), apiKey('dda-own'), SETTLE).expect(200);
    expect(asked).toEqual([]);
  });

  it('the parties are refused as before, and nothing is asked', async () => {
    const orderId = await disputedOrder();
    asked.length = 0;

    await resolve(orderId, asBuyer(), apiKey('dda-buyer'), SETTLE).expect(403);
    await resolve(orderId, asSupplier(), apiKey('dda-supplier'), SETTLE).expect(403);
    expect(asked).toEqual([]);
  });

  it("the saga's compensation after a union administrator's REFUND asks nothing and is not refused, even once B has left U", async () => {
    const orderId = await disputedOrder();
    await resolve(orderId, asUnionAdmin(), apiKey('dda-compensate'), REFUND).expect(200);

    parent.set(buyerOrg, otherUnion);
    mode = 'down';
    asked.length = 0;
    const orders = harness.app.get(OrderService);
    // The context `activities.ts` establishes: the service, for the buyer.
    const status = await runWithContext(
      createSystemContext({
        correlationId: `COR-${ulid()}`,
        callerService: 'marketplace-service',
        roles: ['SERVICE'],
        organizationId: buyerOrg,
      }),
      () => orders.markCancelled(orderId, 'refunded after the dispute decision', sagaStep()),
    );

    expect(status).toBe('CANCELLED');
    expect(asked).toEqual([]);
  });
});
