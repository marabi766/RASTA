import { eventEnvelopeSchema } from '@rasta/contracts';
import { ulid } from 'ulid';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma';
import { validateInventoryPayload, type InventoryEventName } from '../src/events/events';
import { ReturnShipmentRepository } from '../src/return-shipment/return-shipment.repository';
import {
  actor,
  client,
  internalToken,
  key,
  orgAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import {
  cleanup,
  newOrderLineId,
  newOrganizationId,
  newOrderReference,
  newProductId,
  newReturnRequestId,
  runtimeClient,
} from './helpers';

/**
 * Return shipments — the physical half of a return (RUN-005 PR 2; ADR-048 § 2, § 3) against the
 * real application and PostgreSQL: the lifecycle IN_TRANSIT → RECEIVED and its refusals, the
 * tracking history, one effect per Idempotency-Key, concurrent moves, who may read and move one
 * (tenant isolation, object-level authorization), the database keeping the same rules, and the
 * STRICT `returnShipmentId` stream in the outbox.
 *
 * What it does NOT do, on purpose: read marketplace, move stock, or make a refund. A return
 * shipment is a fact about goods; nothing here may change a stock balance or ask for money.
 */
describe('return shipments', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** A destination owner with a warehouse, and the buyer the goods come from. */
  async function setup() {
    const owner = org();
    const buyer = org();
    const warehouseId = (await client(api, orgAdmin(owner)).createWarehouse()).body.id as string;
    return { owner, buyer, warehouseId, ops: client(api, orgAdmin(owner)) };
  }

  /** An IN_TRANSIT return shipment of one line of 3, with the line ids to receive against. */
  async function inTransit(quantity = 3) {
    const s = await setup();
    const orderLineId = newOrderLineId();
    const productId = newProductId();
    const created = await s.ops.dispatchReturn(s.warehouseId, s.buyer, {
      lines: [{ orderLineId, productId, quantity }],
    });
    expect(created.status).toBe(201);
    return { ...s, orderLineId, productId, id: created.body.id as string, created };
  }

  const outboxOf = (organizationId: string, aggregateId?: string) =>
    api.prisma.client.outboxMessage.findMany({
      where: {
        organizationId,
        aggregateType: 'ReturnShipment',
        ...(aggregateId ? { aggregateId } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { streamSeq: 'asc' }],
    });
  const stockRows = async (organizationId: string) =>
    raw.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM "stock_item" WHERE "organization_id" = ${organizationId})
           + (SELECT count(*) FROM "stock_movement" WHERE "organization_id" = ${organizationId}) AS "n"`;

  beforeAll(async () => {
    api = await startApi();
    raw = runtimeClient();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
  });

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  describe('dispatch (POST /v1/return-shipments)', () => {
    it('records an IN_TRANSIT return shipment with its lines and tracking — and shows no user id', async () => {
      const s = await setup();
      const requestId = newReturnRequestId();
      const orderId = newOrderReference();
      const orderLineId = newOrderLineId();
      const productId = newProductId();

      const created = await s.ops.dispatchReturn(s.warehouseId, s.buyer, {
        returnRequestId: requestId,
        orderId,
        lines: [{ orderLineId, productId, quantity: 3 }],
        carrierName: '  Road freight  ',
      });

      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: expect.stringMatching(/^RSP_[0-9A-HJKMNP-TV-Z]{26}$/),
        organizationId: s.owner,
        destinationWarehouseId: s.warehouseId,
        buyerOrganizationId: s.buyer,
        returnRequestId: requestId,
        orderId,
        status: 'IN_TRANSIT',
        lines: [{ orderLineId, productId, expectedQuantity: 3, receivedQuantity: null }],
        carrierName: 'Road freight',
        carrierReference: 'WB-2001',
        createdAt: expect.any(String),
        receivedAt: null,
        inspectedAt: null,
        inspectionNote: null,
        inspectionReportDocumentId: null,
        resolvedAt: null,
        dispositions: [],
        updatedAt: created.body.createdAt,
        version: 1,
      });
      expect((await s.ops.returnShipment(created.body.id)).body).toEqual(created.body);
      expect((await s.ops.returnTracking(created.body.id)).body).toEqual({
        returnShipmentId: created.body.id,
        status: 'IN_TRANSIT',
        destinationWarehouseId: s.warehouseId,
        buyerOrganizationId: s.buyer,
        events: [
          {
            id: expect.stringMatching(/^RTK_/),
            type: 'IN_TRANSIT',
            occurredAt: created.body.createdAt,
            recordedAt: created.body.createdAt,
          },
        ],
      });
      expect(JSON.stringify(created.body)).not.toMatch(/USR-APITEST/);
    });

    it('moves no stock and writes no movement: returned goods are not sellable (ADR-048 § 4)', async () => {
      const s = await setup();
      const before = await stockRows(s.owner);

      expect((await s.ops.dispatchReturn(s.warehouseId, s.buyer)).status).toBe(201);

      expect(await stockRows(s.owner)).toEqual(before);
      expect((await s.ops.get('/v1/stock')).body.items).toEqual([]);
    });

    it('refuses a warehouse of another organization, or none, with 404 — and records nothing', async () => {
      const a = org();
      const b = org();
      const theirs = (await client(api, orgAdmin(b)).createWarehouse()).body.id as string;
      const owner = client(api, orgAdmin(a));

      for (const warehouseId of [theirs, `WHS_${ulid()}`]) {
        const refused = await owner.dispatchReturn(warehouseId, b);
        expect(refused.status).toBe(404);
        expect(refused.body.code).toBe('NOT_FOUND');
      }
      expect((await owner.get('/v1/return-shipments')).body.items).toEqual([]);
      expect((await client(api, orgAdmin(b)).get('/v1/return-shipments')).body.items).toEqual([]);
    });

    it('refuses goods returned to the organization they come from', async () => {
      const s = await setup();
      const refused = await s.ops.dispatchReturn(s.warehouseId, s.owner);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
    });

    it.each([
      ['an unknown field (a price)', { unitPriceMinor: '1' }],
      ['a refund amount', { refundAmountMinor: '1' }],
      ['a status', { status: 'RECEIVED' }],
      ['no lines', { lines: [] }],
      ['a malformed return request id', { returnRequestId: 'RET_1' }],
      ['a malformed order id', { orderId: 'ORD_1' }],
      [
        'a carrier reference without a carrier',
        { carrierName: undefined, carrierReference: 'X-1' },
      ],
      [
        'a line twice',
        {
          lines: [
            {
              orderLineId: 'OLN_01JBQ0000000000000000000AB',
              productId: newProductId(),
              quantity: 1,
            },
            {
              orderLineId: 'OLN_01JBQ0000000000000000000AB',
              productId: newProductId(),
              quantity: 1,
            },
          ],
        },
      ],
      [
        'a quantity of zero',
        { lines: [{ orderLineId: newOrderLineId(), productId: newProductId(), quantity: 0 }] },
      ],
    ])('refuses %s with 400 and records nothing', async (_name, extra) => {
      const s = await setup();
      const refused = await s.ops.dispatchReturn(s.warehouseId, s.buyer, extra);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect((await s.ops.get('/v1/return-shipments')).body.items).toEqual([]);
    });

    it('is one consignment per return request: a second dispatch is 409 RETURN_ALREADY_DISPATCHED', async () => {
      const s = await setup();
      const returnRequestId = newReturnRequestId();
      expect((await s.ops.dispatchReturn(s.warehouseId, s.buyer, { returnRequestId })).status).toBe(
        201,
      );

      const again = await s.ops.dispatchReturn(s.warehouseId, s.buyer, { returnRequestId });

      expect(again.status).toBe(409);
      expect(again.body.details?.[0]?.code).toBe('RETURN_ALREADY_DISPATCHED');
      expect((await s.ops.get('/v1/return-shipments')).body.items).toHaveLength(1);
    });

    it('lets only one of ten concurrent dispatches of one return, under different keys, through', async () => {
      const s = await setup();
      const returnRequestId = newReturnRequestId();

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          s.ops.dispatchReturn(s.warehouseId, s.buyer, { returnRequestId }),
        ),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
      expect((await outboxOf(s.owner)).map((m) => m.eventName)).toEqual([
        'RETURN_SHIPMENT_DISPATCHED',
      ]);
    });

    it('requires an Idempotency-Key on every return-shipment command', async () => {
      const s = await setup();
      const shipment = await inTransit();
      const http = () => request(api.app.getHttpServer());

      const create = await http()
        .post('/v1/return-shipments')
        .set('authorization', `Bearer ${orgAdmin(s.owner)}`)
        .send({});
      const receive = await http()
        .post(`/v1/return-shipments/${shipment.id}/receive`)
        .set('authorization', `Bearer ${orgAdmin(shipment.owner)}`)
        .send({ lines: [] });

      expect(create.status).toBe(400);
      expect(receive.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // The lifecycle
  // -------------------------------------------------------------------------

  describe('the lifecycle IN_TRANSIT → RECEIVED', () => {
    it('receives once, recording what arrived per line, with a tracking event per status in order', async () => {
      const s = await inTransit(3);

      const received = await s.ops.receiveReturn(s.id, {
        lines: [{ orderLineId: s.orderLineId, receivedQuantity: 2 }],
      });

      expect(received.status).toBe(200);
      expect(received.body).toMatchObject({
        status: 'RECEIVED',
        version: 2,
        lines: [{ orderLineId: s.orderLineId, expectedQuantity: 3, receivedQuantity: 2 }],
      });
      expect(received.body.receivedAt).not.toBeNull();
      const tracking = await s.ops.returnTracking(s.id);
      expect(tracking.body.status).toBe('RECEIVED');
      expect(tracking.body.events.map((e: { type: string }) => e.type)).toEqual([
        'IN_TRANSIT',
        'RECEIVED',
      ]);
    });

    it('accepts a line that arrived in full, and one that did not arrive at all', async () => {
      const s = await setup();
      const one = newOrderLineId();
      const two = newOrderLineId();
      const created = await s.ops.dispatchReturn(s.warehouseId, s.buyer, {
        lines: [
          { orderLineId: one, productId: newProductId(), quantity: 2 },
          { orderLineId: two, productId: newProductId(), quantity: 5 },
        ],
      });

      const received = await s.ops.receiveReturn(created.body.id, {
        lines: [
          { orderLineId: one, receivedQuantity: 2 },
          { orderLineId: two, receivedQuantity: 0 },
        ],
      });

      expect(received.status).toBe(200);
      expect(
        received.body.lines.map((l: { receivedQuantity: number }) => l.receivedQuantity).sort(),
      ).toEqual([0, 2]);
    });

    it('moves no stock when the goods arrive either', async () => {
      const s = await inTransit();
      const before = await stockRows(s.owner);

      await s.ops.receiveReturn(s.id, {
        lines: [{ orderLineId: s.orderLineId, receivedQuantity: 3 }],
      });

      expect(await stockRows(s.owner)).toEqual(before);
    });

    it('refuses a second receipt with 409 RETURN_SHIPMENT_NOT_IN_TRANSIT, and changes nothing', async () => {
      const s = await inTransit();
      const body = { lines: [{ orderLineId: s.orderLineId, receivedQuantity: 3 }] };
      expect((await s.ops.receiveReturn(s.id, body)).status).toBe(200);

      const again = await s.ops.receiveReturn(s.id, {
        lines: [{ orderLineId: s.orderLineId, receivedQuantity: 1 }],
      });

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
      expect(again.body.details?.[0]?.code).toBe('RETURN_SHIPMENT_NOT_IN_TRANSIT');
      expect((await s.ops.returnShipment(s.id)).body.lines[0].receivedQuantity).toBe(3);
      expect((await outboxOf(s.owner, s.id)).map((m) => m.eventName)).toEqual([
        'RETURN_SHIPMENT_DISPATCHED',
        'RETURN_SHIPMENT_RECEIVED',
      ]);
    });

    it('refuses a receipt that is not exactly the dispatched lines, or exceeds them, with 422', async () => {
      const s = await inTransit(3);
      const stranger = newOrderLineId();
      const cases = [
        {
          lines: [{ orderLineId: stranger, receivedQuantity: 1 }],
          reason: 'RECEIPT_LINES_MISMATCH',
        },
        {
          lines: [
            { orderLineId: s.orderLineId, receivedQuantity: 1 },
            { orderLineId: stranger, receivedQuantity: 1 },
          ],
          reason: 'RECEIPT_LINES_MISMATCH',
        },
        {
          lines: [
            { orderLineId: s.orderLineId, receivedQuantity: 1 },
            { orderLineId: s.orderLineId, receivedQuantity: 1 },
          ],
          reason: 'RECEIPT_LINES_MISMATCH',
        },
        {
          lines: [{ orderLineId: s.orderLineId, receivedQuantity: 4 }],
          reason: 'RECEIVED_EXCEEDS_EXPECTED',
        },
      ];

      for (const { lines, reason } of cases) {
        const refused = await s.ops.receiveReturn(s.id, { lines });
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
        expect(refused.body.details?.[0]?.code).toBe(reason);
      }
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('IN_TRANSIT');
    });

    it('applies expectedVersion when given (409 OPTIMISTIC_LOCK_FAILED otherwise)', async () => {
      const s = await inTransit();
      const lines = [{ orderLineId: s.orderLineId, receivedQuantity: 3 }];

      const stale = await s.ops.receiveReturn(s.id, { expectedVersion: 7, lines });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');

      expect((await s.ops.receiveReturn(s.id, { expectedVersion: 1, lines })).status).toBe(200);
    });

    it('answers 404 for a return shipment that does not exist', async () => {
      const s = await setup();
      const missing = `RSP_${ulid()}`;
      expect((await s.ops.returnShipment(missing)).status).toBe(404);
      expect((await s.ops.returnTracking(missing)).status).toBe(404);
      expect(
        (
          await s.ops.receiveReturn(missing, {
            lines: [{ orderLineId: newOrderLineId(), receivedQuantity: 1 }],
          })
        ).status,
      ).toBe(404);
    });

    it.each(['detail', 'list'] as const)(
      'reads the %s from one snapshot, though a receipt commits between the shipment and its lines (Codex r1 on #311)',
      async (read) => {
        const s = await inTransit(3);
        const repository = api.app.get(ReturnShipmentRepository);
        const linesOf = repository.linesOf.bind(repository);
        let committedBetween = false;
        // The shipment row has been read; the receipt commits now, before its lines are.
        const between = jest
          .spyOn(repository, 'linesOf')
          .mockImplementationOnce(async (shipments, reader) => {
            const received = await s.ops.receiveReturn(s.id, {
              lines: [{ orderLineId: s.orderLineId, receivedQuantity: 3 }],
            });
            expect(received.status).toBe(200);
            committedBetween = true;
            return linesOf(shipments, reader);
          });
        try {
          const response =
            read === 'detail'
              ? await s.ops.returnShipment(s.id)
              : await s.ops.get('/v1/return-shipments');
          expect(response.status).toBe(200);
          const view = read === 'detail' ? response.body : response.body.items[0];

          // What the database held before the receipt — never IN_TRANSIT with what arrived.
          expect(view).toMatchObject({
            id: s.id,
            status: 'IN_TRANSIT',
            version: 1,
            receivedAt: null,
            lines: [{ orderLineId: s.orderLineId, expectedQuantity: 3, receivedQuantity: null }],
          });
          expect(committedBetween).toBe(true);
        } finally {
          between.mockRestore();
        }

        // And the next read is the state after it, whole.
        expect((await s.ops.returnShipment(s.id)).body).toMatchObject({
          status: 'RECEIVED',
          version: 2,
          lines: [{ receivedQuantity: 3 }],
        });
      },
    );

    it('lists the owner’s return shipments newest first, by status and by return request', async () => {
      const s = await setup();
      const requestIds = [newReturnRequestId(), newReturnRequestId(), newReturnRequestId()];
      const ids: string[] = [];
      for (const returnRequestId of requestIds) {
        ids.push((await s.ops.dispatchReturn(s.warehouseId, s.buyer, { returnRequestId })).body.id);
      }
      const line = (await s.ops.returnShipment(ids[0] as string)).body.lines[0];
      await s.ops.receiveReturn(ids[0] as string, {
        lines: [{ orderLineId: line.orderLineId, receivedQuantity: 1 }],
      });

      const all = await s.ops.get('/v1/return-shipments');
      expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([...ids].reverse());
      const received = await s.ops.get('/v1/return-shipments?status=RECEIVED');
      expect(received.body.items.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
      const one = await s.ops.get(`/v1/return-shipments?returnRequestId=${requestIds[1]}`);
      expect(one.body.items.map((i: { id: string }) => i.id)).toEqual([ids[1]]);
      const page = await s.ops.get('/v1/return-shipments?limit=2');
      expect(page.body.items).toHaveLength(2);
      expect(page.body.nextCursor).toEqual(expect.any(String));
    });
  });

  // -------------------------------------------------------------------------
  // One effect per key, and under concurrency
  // -------------------------------------------------------------------------

  describe('one effect per key, and under concurrency', () => {
    it('replays a dispatch and a receipt under the same key, and refuses the key for another request', async () => {
      const s = await setup();
      const dispatchKey = key();
      const orderLineId = newOrderLineId();
      const body = {
        returnRequestId: newReturnRequestId(),
        orderId: newOrderReference(),
        lines: [{ orderLineId, productId: newProductId(), quantity: 2 }],
      };
      const first = await s.ops.dispatchReturn(s.warehouseId, s.buyer, body, dispatchKey);
      const replay = await s.ops.dispatchReturn(s.warehouseId, s.buyer, body, dispatchKey);
      expect(replay.status).toBe(first.status);
      expect(replay.body).toEqual(first.body);

      const reuse = await s.ops.dispatchReturn(
        s.warehouseId,
        s.buyer,
        { ...body, returnRequestId: newReturnRequestId() },
        dispatchKey,
      );
      expect(reuse.status).toBe(409);
      expect(reuse.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      const receiptKey = key();
      const lines = [{ orderLineId, receivedQuantity: 2 }];
      const received = await s.ops.receiveReturn(first.body.id, { lines }, receiptKey);
      const receivedAgain = await s.ops.receiveReturn(first.body.id, { lines }, receiptKey);
      expect(receivedAgain.status).toBe(200);
      expect(receivedAgain.body).toEqual(received.body);
      expect((await outboxOf(s.owner)).map((m) => m.eventName)).toEqual([
        'RETURN_SHIPMENT_DISPATCHED',
        'RETURN_SHIPMENT_RECEIVED',
      ]);
    });

    it('never applies a key twice, even after its record expired (the domain backstop)', async () => {
      const s = await setup();
      const dispatchKey = key();
      const body = { returnRequestId: newReturnRequestId() };
      const first = await s.ops.dispatchReturn(s.warehouseId, s.buyer, body, dispatchKey);
      expect(first.status).toBe(201);
      // The key's own record is gone (24 hours on), the domain row is not.
      await raw.$executeRaw`DELETE FROM "idempotency_key" WHERE "organization_id" = ${s.owner}`;

      const again = await s.ops.dispatchReturn(
        s.warehouseId,
        s.buyer,
        { returnRequestId: newReturnRequestId() },
        dispatchKey,
      );

      expect(again.status).toBe(409);
      expect(again.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await s.ops.get('/v1/return-shipments')).body.items).toHaveLength(1);
    });

    it('receives once of ten concurrent receipts under different keys, with one RECEIVED event', async () => {
      const s = await inTransit();
      const lines = [{ orderLineId: s.orderLineId, receivedQuantity: 3 }];

      const results = await Promise.all(
        Array.from({ length: 10 }, () => s.ops.receiveReturn(s.id, { lines })),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
      const events = (await outboxOf(s.owner, s.id)).map((m) => m.eventName);
      expect(events).toEqual(['RETURN_SHIPMENT_DISPATCHED', 'RETURN_SHIPMENT_RECEIVED']);
    });
  });

  // -------------------------------------------------------------------------
  // Tenant isolation and object-level authorization
  // -------------------------------------------------------------------------

  describe('who may read and move a return shipment (BOLA)', () => {
    it('hides it from a third organization on every route: 404, never 403', async () => {
      const s = await inTransit();
      const stranger = client(api, orgAdmin(org()));

      expect((await stranger.returnShipment(s.id)).status).toBe(404);
      expect((await stranger.returnTracking(s.id)).status).toBe(404);
      expect(
        (
          await stranger.receiveReturn(s.id, {
            lines: [{ orderLineId: s.orderLineId, receivedQuantity: 1 }],
          })
        ).status,
      ).toBe(404);
      expect((await stranger.get('/v1/return-shipments')).body.items).toEqual([]);
      expect((await stranger.get('/v1/return-shipments?side=sender')).body.items).toEqual([]);
      expect((await stranger.get('/v1/return-shipments?side=destination')).body.items).toEqual([]);
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('IN_TRANSIT');
    });

    it('lets the sender read it and its tracking — and list it — but never move it (403)', async () => {
      const s = await inTransit();
      const sender = client(api, orgAdmin(s.buyer));

      expect((await sender.returnShipment(s.id)).status).toBe(200);
      expect((await sender.returnTracking(s.id)).body.events).toHaveLength(1);
      expect(
        (await sender.get('/v1/return-shipments?side=sender')).body.items.map(
          (i: { id: string }) => i.id,
        ),
      ).toEqual([s.id]);
      expect((await sender.get('/v1/return-shipments?side=destination')).body.items).toEqual([]);

      const refused = await sender.receiveReturn(s.id, {
        lines: [{ orderLineId: s.orderLineId, receivedQuantity: 3 }],
      });
      expect(refused.status).toBe(403);
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('IN_TRANSIT');
      expect((await outboxOf(s.owner, s.id)).map((m) => m.eventName)).toEqual([
        'RETURN_SHIPMENT_DISPATCHED',
      ]);
    });

    it('does not let the sender dispatch a return into its own warehouse as if it were the owner’s', async () => {
      const s = await setup();
      const sender = client(api, orgAdmin(s.buyer));
      // The sender names the OWNER's warehouse: another organization's, so 404.
      const refused = await sender.dispatchReturn(s.warehouseId, s.owner);
      expect(refused.status).toBe(404);
    });

    it('replays a stored response only to someone who may still see it', async () => {
      const s = await setup();
      const dispatchKey = key();
      const created = await s.ops.dispatchReturn(s.warehouseId, s.buyer, {}, dispatchKey);
      expect(created.status).toBe(201);

      // Same key, from a person of another organization: never the stored body.
      const other = client(api, orgAdmin(org()));
      const replay = await other.dispatchReturn(s.warehouseId, s.buyer, {}, dispatchKey);
      expect([403, 404, 409]).toContain(replay.status);
      expect(JSON.stringify(replay.body)).not.toContain(s.owner);
    });

    it('refuses AUDITOR, SYSTEM_ADMIN and a service token on every route (403), and no token (401)', async () => {
      const s = await inTransit();
      const http = () => request(api.app.getHttpServer());
      const routes = [
        ['get', '/v1/return-shipments'],
        ['get', `/v1/return-shipments/${s.id}`],
        ['get', `/v1/return-shipments/${s.id}/tracking`],
      ] as const;

      for (const [method, path] of routes) {
        expect((await http()[method](path)).status).toBe(401);
        for (const roles of [['AUDITOR'], ['SYSTEM_ADMIN']]) {
          const token = actor(s.owner, roles);
          expect((await http()[method](path).set('authorization', `Bearer ${token}`)).status).toBe(
            403,
          );
        }
        const service = await internalToken('marketplace-service', s.owner);
        expect((await http()[method](path).set('x-internal-token', service)).status).toBe(403);
      }
      const operator = actor(s.owner, ['SYSTEM_ADMIN']);
      const dispatch = await client(api, operator).dispatchReturn(s.warehouseId, s.buyer);
      expect(dispatch.status).toBe(403);
    });

    it('requires an operator role to move: a reader-only role is refused', async () => {
      const s = await inTransit();
      const lines = [{ orderLineId: s.orderLineId, receivedQuantity: 3 }];
      const noRole = client(api, actor(s.owner, ['PROCUREMENT_USER']));

      expect((await noRole.receiveReturn(s.id, { lines })).status).toBe(403);
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('IN_TRANSIT');
    });
  });

  // -------------------------------------------------------------------------
  // The database keeps the same rules
  // -------------------------------------------------------------------------

  describe('the database keeps the lifecycle, whatever a write path forgets', () => {
    it('refuses to skip or reverse a state, to rewrite what was dispatched, or to erase anything', async () => {
      const s = await inTransit();

      // A shipment cannot be made RECEIVED without its tracking event and its lines' receipts.
      await expect(
        raw.$executeRaw`UPDATE "return_shipment"
           SET "status" = 'RECEIVED', "version" = 2, "received_at" = now(), "received_by" = 'X', "updated_at" = now()
         WHERE "id" = ${s.id}`,
      ).rejects.toThrow(/ck_return_shipment_tracked|history/i);

      // Terms never change.
      await expect(
        raw.$executeRaw`UPDATE "return_shipment" SET "buyer_organization_id" = 'ORG-OTHER' WHERE "id" = ${s.id}`,
      ).rejects.toThrow(/ck_return_shipment_terms_immutable/);
      await expect(
        raw.$executeRaw`UPDATE "return_shipment_line" SET "expected_quantity" = 99 WHERE "return_shipment_id" = ${s.id}`,
      ).rejects.toThrow(/ck_return_shipment_line_received_once/);

      // Nothing is ever erased.
      for (const table of ['return_tracking_event', 'return_shipment_line']) {
        await expect(
          raw.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "return_shipment_id" = $1`, s.id),
        ).rejects.toThrow();
      }
      await expect(
        raw.$executeRaw`DELETE FROM "return_shipment" WHERE "id" = ${s.id}`,
      ).rejects.toThrow(/ck_return_shipment_not_erasable/);
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('IN_TRANSIT');
    });

    it('refuses to reverse RECEIVED, or to receive a line twice', async () => {
      const s = await inTransit();
      await s.ops.receiveReturn(s.id, {
        lines: [{ orderLineId: s.orderLineId, receivedQuantity: 3 }],
      });

      await expect(
        raw.$executeRaw`UPDATE "return_shipment" SET "status" = 'IN_TRANSIT', "version" = 1 WHERE "id" = ${s.id}`,
      ).rejects.toThrow(/ck_return_shipment_transition/);
      await expect(
        raw.$executeRaw`UPDATE "return_shipment_line" SET "received_quantity" = 1 WHERE "return_shipment_id" = ${s.id}`,
      ).rejects.toThrow(/ck_return_shipment_line_received_once/);
    });

    it('refuses a line added to a shipment after it was created with all of its lines', async () => {
      const s = await inTransit();
      await expect(
        raw.$executeRaw`INSERT INTO "return_shipment_line" ("id","organization_id","return_shipment_id","order_line_id","product_id","expected_quantity","created_at")
         VALUES (${`RSL_${ulid()}`}, ${s.owner}, ${s.id}, ${newOrderLineId()}, ${newProductId()}, 1, now())`,
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // The STRICT returnShipmentId stream
  // -------------------------------------------------------------------------

  describe('the STRICT returnShipmentId stream (ADR-048 § 4)', () => {
    it('writes RETURN_SHIPMENT_DISPATCHED then _RECEIVED in the shipment’s own stream, consecutive from 1', async () => {
      const s = await inTransit(3);
      await s.ops.receiveReturn(s.id, {
        lines: [{ orderLineId: s.orderLineId, receivedQuantity: 2 }],
      });

      const rows = await outboxOf(s.owner, s.id);

      expect(rows.map((r) => r.eventName)).toEqual([
        'RETURN_SHIPMENT_DISPATCHED',
        'RETURN_SHIPMENT_RECEIVED',
      ]);
      expect(rows.map((r) => r.partitionKey)).toEqual([s.id, s.id]);
      expect(rows.map((r) => Number(r.streamSeq))).toEqual([1, 2]);
      for (const [index, row] of rows.entries()) {
        // The row's payload is the whole envelope; the contract's payload is inside it.
        const envelope = eventEnvelopeSchema.parse(row.payload);
        expect(envelope).toMatchObject({
          producer: 'inventory-service',
          tenantId: s.owner,
          streamSeq: index + 1,
          streamKey: s.id,
        });
        // The published payload is the contract's, and its version is its place in the stream.
        const payload = validateInventoryPayload(
          row.eventName as InventoryEventName,
          envelope.payload,
        ) as { returnShipmentVersion: number };
        expect(payload.returnShipmentVersion).toBe(index + 1);
      }
      expect(eventEnvelopeSchema.parse(rows[1]?.payload).payload).toMatchObject({
        returnShipmentId: s.id,
        returnRequestId: expect.stringMatching(/^RET_/),
        buyerOrganizationId: s.buyer,
        lines: [{ orderLineId: s.orderLineId, expectedQuantity: 3, receivedQuantity: 2 }],
      });
    });

    it('carries no carrier, carrier reference or other free text', async () => {
      const s = await inTransit();
      const serialised = JSON.stringify((await outboxOf(s.owner, s.id)).map((r) => r.payload));
      expect(serialised).not.toMatch(/Road freight|WB-2001/);
      expect(serialised).not.toMatch(/unitPrice|refund|amount/i);
    });

    it('writes nothing when a command is refused', async () => {
      const s = await inTransit();
      const before = (await outboxOf(s.owner, s.id)).length;

      await s.ops.receiveReturn(s.id, {
        lines: [{ orderLineId: newOrderLineId(), receivedQuantity: 1 }],
      });
      await client(api, orgAdmin(s.buyer)).receiveReturn(s.id, {
        lines: [{ orderLineId: s.orderLineId, receivedQuantity: 1 }],
      });

      expect((await outboxOf(s.owner, s.id)).length).toBe(before);
    });
  });
});
