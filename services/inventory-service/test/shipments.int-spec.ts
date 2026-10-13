import { eventEnvelopeSchema, shipmentCreatedPayloadSchema } from '@rasta/contracts';
import { ulid } from 'ulid';
import type { PrismaClient } from '../src/generated/prisma';
import { PrismaClient as Owner } from '../src/generated/prisma';
import { validateInventoryPayload, type InventoryEventName } from '../src/events/events';
import request from 'supertest';
import {
  actor,
  client,
  internalToken,
  key,
  orgAdmin,
  seedShipment,
  startApi,
  type ApiHarness,
} from './api-helpers';
import {
  cleanup,
  newOrganizationId,
  newOrderReference,
  ownerDatabaseUrl,
  runtimeClient,
} from './helpers';

/**
 * Shipments and their tracking (COM-006 PR 2; ADR-056 § 2, § 6; plan steps 8–10) against the real
 * application and PostgreSQL: the lifecycle CREATED → DISPATCHED → DELIVERED and its refusals, the
 * tracking history, one effect per Idempotency-Key, concurrent moves, and the STRICT `shipmentId`
 * stream in the outbox. Who may read and move a shipment is `tenancy.int-spec.ts`.
 */
describe('shipments', () => {
  let api: ApiHarness;
  let raw: PrismaClient;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const trackingRows = async (shipmentId: string) =>
    raw.$queryRaw<{ type: string }[]>`
      SELECT "type" FROM "tracking_event" WHERE "shipment_id" = ${shipmentId}
       ORDER BY "occurred_at", "id"`;
  const outboxOf = (organizationId: string) =>
    api.prisma.client.outboxMessage.findMany({
      where: { organizationId, aggregateType: 'Shipment' },
      orderBy: [{ createdAt: 'asc' }, { streamSeq: 'asc' }],
    });

  beforeAll(async () => {
    api = await startApi();
    raw = runtimeClient();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
  });

  describe('create', () => {
    it('creates a CREATED shipment with its legs, out of the owner’s warehouse — and shows no user id', async () => {
      const a = org();
      const consignee = org();
      const owner = client(api, orgAdmin(a));
      const warehouseId = (await owner.createWarehouse()).body.id as string;
      const order = newOrderReference();

      const created = await owner.createShipment(warehouseId, consignee, {
        orderReference: order,
        legs: [
          { carrierName: '  Road freight  ', carrierReference: 'WB-1' },
          { carrierName: 'Rail' },
        ],
      });
      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: expect.stringMatching(/^SHP_[0-9A-HJKMNP-TV-Z]{26}$/),
        organizationId: a,
        originWarehouseId: warehouseId,
        consigneeOrganizationId: consignee,
        orderReference: order,
        status: 'CREATED',
        legs: [
          { sequence: 1, carrierName: 'Road freight', carrierReference: 'WB-1' },
          { sequence: 2, carrierName: 'Rail', carrierReference: null },
        ],
        createdAt: expect.any(String),
        dispatchedAt: null,
        deliveredAt: null,
        updatedAt: created.body.createdAt,
        version: 1,
      });
      expect((await owner.shipment(created.body.id)).body).toEqual(created.body);

      const tracking = await owner.tracking(created.body.id);
      expect(tracking.status).toBe(200);
      expect(tracking.body).toEqual({
        shipmentId: created.body.id,
        status: 'CREATED',
        originWarehouseId: warehouseId,
        consigneeOrganizationId: consignee,
        events: [
          {
            id: expect.stringMatching(/^TRK_/),
            type: 'CREATED',
            occurredAt: created.body.createdAt,
            recordedAt: created.body.createdAt,
          },
        ],
      });
      expect(JSON.stringify(created.body)).not.toMatch(/USR-APITEST/);
    });

    it('lets an organization ship to itself', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const warehouseId = (await owner.createWarehouse()).body.id as string;
      expect((await owner.createShipment(warehouseId, a)).status).toBe(201);
    });

    it('refuses a warehouse of another organization, or none, with 404 — and creates nothing', async () => {
      const a = org();
      const b = org();
      const theirs = (await client(api, orgAdmin(b)).createWarehouse()).body.id as string;
      const owner = client(api, orgAdmin(a));

      for (const warehouseId of [theirs, `WHS_${ulid()}`]) {
        const refused = await owner.createShipment(warehouseId, b);
        expect(refused.status).toBe(404);
        expect(refused.body.code).toBe('NOT_FOUND');
      }
      expect((await owner.get('/v1/shipments')).body.items).toEqual([]);
      expect((await client(api, orgAdmin(b)).get('/v1/shipments')).body.items).toEqual([]);
    });

    it.each([
      ['no legs', { legs: [] }],
      ['eleven legs', { legs: Array.from({ length: 11 }, () => ({ carrierName: 'X' })) }],
      ['a blank carrier', { legs: [{ carrierName: '   ' }] }],
      ['a carrier with a bidirectional control', { legs: [{ carrierName: 'A‮B' }] }],
      ['a carrier past 200 characters', { legs: [{ carrierName: 'x'.repeat(201) }] }],
      ['an unknown leg field', { legs: [{ carrierName: 'X', note: 'free text' }] }],
      ['a consignee that is not an organization id', { consigneeOrganizationId: 'acme' }],
      ['an order reference of another kind', { orderReference: `ADJ_${ulid()}` }],
      ['an unknown field', { destination: 'somewhere' }],
    ])('refuses %s with 400', async (_label, change) => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const warehouseId = (await owner.createWarehouse()).body.id as string;
      const refused = await owner.post('/v1/shipments', {
        originWarehouseId: warehouseId,
        consigneeOrganizationId: newOrganizationId(),
        legs: [{ carrierName: 'Road' }],
        ...change,
      });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
    });

    it('requires an Idempotency-Key on every shipment command', async () => {
      const a = org();
      const { shipmentId, warehouseId } = await seedShipment(api, a, org());
      for (const [path, body] of [
        [
          '/v1/shipments',
          {
            originWarehouseId: warehouseId,
            consigneeOrganizationId: a,
            legs: [{ carrierName: 'X' }],
          },
        ],
        [`/v1/shipments/${shipmentId}/dispatch`, {}],
        [`/v1/shipments/${shipmentId}/deliver`, {}],
      ] as const) {
        const response = await client(api, orgAdmin(a)).post(path, body, '');
        expect([path, response.status, response.body.code]).toEqual([
          path,
          400,
          'VALIDATION_FAILED',
        ]);
      }
    });
  });

  describe('the lifecycle CREATED → DISPATCHED → DELIVERED (plan step 8)', () => {
    it('dispatches, then delivers, each once — with a tracking event per status, in order', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const { shipmentId } = await seedShipment(api, a, org());

      const dispatched = await owner.dispatch(shipmentId);
      expect(dispatched.status).toBe(200);
      expect(dispatched.body).toMatchObject({
        status: 'DISPATCHED',
        version: 2,
        deliveredAt: null,
      });
      expect(dispatched.body.dispatchedAt).toEqual(expect.any(String));
      expect(dispatched.body.legs).toHaveLength(1);

      const delivered = await owner.deliver(shipmentId, { expectedVersion: 2 });
      expect(delivered.status).toBe(200);
      expect(delivered.body).toMatchObject({ status: 'DELIVERED', version: 3 });
      expect(delivered.body.dispatchedAt).toBe(dispatched.body.dispatchedAt);

      const tracking = (await owner.tracking(shipmentId)).body;
      expect(tracking.status).toBe('DELIVERED');
      expect(tracking.events.map((event: { type: string }) => event.type)).toEqual([
        'CREATED',
        'DISPATCHED',
        'DELIVERED',
      ]);
      const times = tracking.events.map((event: { occurredAt: string }) => event.occurredAt);
      expect([...times].sort()).toEqual(times);
      expect(times[1]).toBe(dispatched.body.dispatchedAt);
      expect(times[2]).toBe(delivered.body.deliveredAt);
    });

    it('refuses DELIVERED before DISPATCHED with 409 SHIPMENT_NOT_DISPATCHED (the step 8 gate)', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const { shipmentId } = await seedShipment(api, a, org());

      const early = await owner.deliver(shipmentId);
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('INVALID_STATE_TRANSITION');
      expect(early.body.details).toEqual([
        { path: 'shipment', code: 'SHIPMENT_NOT_DISPATCHED', message: expect.any(String) },
      ]);
      expect((await owner.shipment(shipmentId)).body).toMatchObject({
        status: 'CREATED',
        version: 1,
      });
      expect(await trackingRows(shipmentId)).toEqual([{ type: 'CREATED' }]);
    });

    it('refuses a second dispatch and a second delivery with 409', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const { shipmentId } = await seedShipment(api, a, org());
      expect((await owner.dispatch(shipmentId)).status).toBe(200);

      const again = await owner.dispatch(shipmentId);
      expect([again.status, again.body.details?.[0]?.code]).toEqual([409, 'SHIPMENT_NOT_CREATED']);
      expect((await owner.deliver(shipmentId)).status).toBe(200);
      const twice = await owner.deliver(shipmentId);
      expect([twice.status, twice.body.details?.[0]?.code]).toEqual([
        409,
        'SHIPMENT_NOT_DISPATCHED',
      ]);
      const late = await owner.dispatch(shipmentId);
      expect([late.status, late.body.details?.[0]?.code]).toEqual([409, 'SHIPMENT_NOT_CREATED']);
      expect(await trackingRows(shipmentId)).toHaveLength(3);
    });

    it('applies expectedVersion when given (409 OPTIMISTIC_LOCK_FAILED otherwise)', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const { shipmentId } = await seedShipment(api, a, org());
      const stale = await owner.dispatch(shipmentId, { expectedVersion: 2 });
      expect([stale.status, stale.body.code]).toEqual([409, 'OPTIMISTIC_LOCK_FAILED']);
      expect((await owner.dispatch(shipmentId, { expectedVersion: 1 })).status).toBe(200);
    });

    it('answers 404 for a shipment that does not exist', async () => {
      const owner = client(api, orgAdmin(org()));
      const missing = `SHP_${ulid()}`;
      for (const response of [
        await owner.shipment(missing),
        await owner.tracking(missing),
        await owner.dispatch(missing),
        await owner.deliver(missing),
      ]) {
        expect([response.status, response.body.code]).toEqual([404, 'NOT_FOUND']);
      }
    });

    it('lists the owner’s shipments newest first, by status, a page at a time', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const consignee = org();
      const first = await seedShipment(api, a, consignee);
      const second = await seedShipment(api, a, consignee);
      await owner.dispatch(second.shipmentId);

      const all = (await owner.get('/v1/shipments?side=origin')).body;
      expect(all.items.map((s: { id: string }) => s.id)).toEqual([
        second.shipmentId,
        first.shipmentId,
      ]);
      expect(all.items[0].legs).toHaveLength(1);
      const created = (await owner.get('/v1/shipments?status=CREATED')).body.items;
      expect(created.map((s: { id: string }) => s.id)).toEqual([first.shipmentId]);
      const page = (await owner.get('/v1/shipments?limit=1')).body;
      expect(page).toMatchObject({ hasMore: true, nextCursor: second.shipmentId });
      const next = (await owner.get(`/v1/shipments?limit=1&cursor=${page.nextCursor}`)).body;
      expect(next.items.map((s: { id: string }) => s.id)).toEqual([first.shipmentId]);
      expect((await owner.get('/v1/shipments?side=elsewhere')).status).toBe(400);
    });
  });

  describe('one effect per key, and under concurrency', () => {
    it('replays a create and a dispatch under the same key, and refuses the key for another request', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const warehouseId = (await owner.createWarehouse()).body.id as string;
      const consignee = org();
      const k = key();

      const first = await owner.createShipment(warehouseId, consignee, {}, k);
      const again = await owner.createShipment(warehouseId, consignee, {}, k);
      expect([first.status, again.status]).toEqual([201, 201]);
      expect(again.body).toEqual(first.body);
      expect((await owner.get('/v1/shipments')).body.items).toHaveLength(1);

      const other = await owner.createShipment(warehouseId, org(), {}, k);
      expect([other.status, other.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);

      const d = key();
      const dispatched = await owner.dispatch(first.body.id, {}, d);
      expect((await owner.dispatch(first.body.id, {}, d)).body).toEqual(dispatched.body);
      expect(await trackingRows(first.body.id)).toHaveLength(2);
    });

    it('never applies a key twice, even after its record expired (the domain backstop)', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const warehouseId = (await owner.createWarehouse()).body.id as string;
      const createKey = key();
      const created = await owner.createShipment(warehouseId, a, {}, createKey);
      const dispatchKey = key();
      expect((await owner.dispatch(created.body.id, {}, dispatchKey)).status).toBe(200);

      const store = new Owner({ datasources: { db: { url: ownerDatabaseUrl() } } });
      try {
        await store.idempotencyKey.deleteMany({ where: { organizationId: a } });
      } finally {
        await store.$disconnect();
      }

      const lateCreate = await owner.createShipment(warehouseId, a, {}, createKey);
      expect([lateCreate.status, lateCreate.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
      // A second dispatch under its key is refused by the backstop or the state, never applied.
      const second = (await seedShipment(api, a, a)).shipmentId;
      const reused = await owner.dispatch(second, {}, dispatchKey);
      expect([reused.status, reused.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
      expect((await owner.shipment(second)).body.status).toBe('CREATED');
      expect((await owner.get('/v1/shipments')).body.items).toHaveLength(2);
    });

    it('dispatches once of ten concurrent dispatches under different keys', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const { shipmentId } = await seedShipment(api, a, org());

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => owner.dispatch(shipmentId)),
      );
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, ...Array(9).fill(409)]);
      for (const response of responses.filter((r) => r.status === 409)) {
        expect(response.body.details?.[0]?.code).toBe('SHIPMENT_NOT_CREATED');
      }
      expect(await trackingRows(shipmentId)).toEqual([{ type: 'CREATED' }, { type: 'DISPATCHED' }]);
      expect(await outboxOf(a)).toHaveLength(2);
    });

    it('records a delivery after the dispatch it waited on, even when its transaction began first', async () => {
      // A deliver whose transaction began before a dispatch committed, and then waited on the
      // shipment's row, must not stamp an instant before that dispatch: the database's
      // `delivered_at >= dispatched_at` and the history's order would refuse it as a 500.
      const a = org();
      const owner = client(api, orgAdmin(a));
      const { shipmentId } = await seedShipment(api, a, org());
      const holder = runtimeClient();
      try {
        let delivering: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
        await holder.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1 FROM "shipment" WHERE "id" = ${shipmentId} FOR UPDATE`;
            delivering = owner
              .deliver(shipmentId)
              .then((r) => ({ status: r.status, body: r.body }));
            await new Promise((resolve) => setTimeout(resolve, 700));
            // The dispatch commits later than the deliver began, stamped after it.
            await tx.$executeRaw`
              UPDATE "shipment"
                 SET "status" = 'DISPATCHED', "dispatched_at" = now() + interval '2 seconds',
                     "dispatched_by" = 'USR-HOLDER', "updated_at" = now() + interval '2 seconds',
                     "version" = 2
               WHERE "id" = ${shipmentId}`;
            await tx.$executeRaw`
              INSERT INTO "tracking_event" ("id", "organization_id", "shipment_id", "type",
                                            "occurred_at", "recorded_at", "recorded_by",
                                            "correlation_id", "command_key_hash")
              VALUES (${`TRK_${ulid()}`}, ${a}, ${shipmentId}, 'DISPATCHED',
                      now() + interval '2 seconds', now() + interval '2 seconds', 'USR-HOLDER',
                      'corr-holder', ${'b'.repeat(64)})`;
          },
          { timeout: 10_000 },
        );
        const delivered = await (delivering as Promise<{
          status: number;
          body: Record<string, unknown>;
        }>);
        expect(delivered.status).toBe(200);
        expect(delivered.body.status).toBe('DELIVERED');
        expect(Date.parse(delivered.body.deliveredAt as string)).toBeGreaterThanOrEqual(
          Date.parse(delivered.body.dispatchedAt as string),
        );
      } finally {
        await holder.$disconnect();
      }
    });
  });

  describe('the STRICT shipmentId stream (ADR-056 § 6)', () => {
    it('writes SHIPMENT_CREATED, _DISPATCHED and _DELIVERED in the shipment’s own stream, consecutive from 1', async () => {
      const a = org();
      const consignee = org();
      const owner = client(api, orgAdmin(a));
      const { shipmentId, warehouseId } = await seedShipment(api, a, consignee);
      await owner.dispatch(shipmentId);
      await owner.deliver(shipmentId);

      const rows = await outboxOf(a);
      expect(rows.map((row) => row.eventName)).toEqual([
        'SHIPMENT_CREATED',
        'SHIPMENT_DISPATCHED',
        'SHIPMENT_DELIVERED',
      ]);
      expect(rows.map((row) => row.partitionKey)).toEqual(Array(3).fill(shipmentId));
      expect(rows.map((row) => row.streamSeq)).toEqual([1n, 2n, 3n]);
      const tracked = (await owner.tracking(shipmentId)).body.events as { id: string }[];
      rows.forEach((row, index) => {
        const envelope = eventEnvelopeSchema.parse(row.payload);
        expect(envelope).toMatchObject({ producer: 'inventory-service', tenantId: a });
        expect(row).toMatchObject({ topic: 'rasta.inventory.v1', aggregateId: shipmentId });
        const payload = validateInventoryPayload(
          row.eventName as InventoryEventName,
          envelope.payload,
        ) as Record<string, unknown>;
        expect(payload).toMatchObject({
          shipmentId,
          organizationId: a,
          originWarehouseId: warehouseId,
          consigneeOrganizationId: consignee,
          shipmentVersion: index + 1,
          trackingEventId: tracked[index]?.id,
        });
      });
      expect(
        shipmentCreatedPayloadSchema.parse(eventEnvelopeSchema.parse(rows[0]?.payload).payload),
      ).toMatchObject({ legCount: 1, orderReference: null });
    });

    it('carries no carrier, carrier reference or other free text', async () => {
      const a = org();
      const owner = client(api, orgAdmin(a));
      const warehouseId = (await owner.createWarehouse()).body.id as string;
      await owner.createShipment(warehouseId, a, {
        legs: [{ carrierName: 'Very identifiable carrier', carrierReference: 'WAYBILL-778899' }],
      });
      const text = JSON.stringify((await outboxOf(a)).map((row) => row.payload));
      expect(text).not.toContain('Very identifiable carrier');
      expect(text).not.toContain('WAYBILL-778899');
    });

    it('writes nothing when a move is refused', async () => {
      const a = org();
      const { shipmentId } = await seedShipment(api, a, org());
      expect((await client(api, orgAdmin(a)).deliver(shipmentId)).status).toBe(409);
      expect(await outboxOf(a)).toHaveLength(1);
    });
  });

  describe('closed by default (S-02)', () => {
    it('refuses every shipment route without a token (401)', async () => {
      const id = `SHP_${ulid()}`;
      const http = () => request(api.app.getHttpServer());
      for (const response of [
        await http().get('/v1/shipments'),
        await http().get(`/v1/shipments/${id}`),
        await http().get(`/v1/shipments/${id}/tracking`),
        await http().post('/v1/shipments').set('idempotency-key', key()).send({}),
        await http().post(`/v1/shipments/${id}/dispatch`).set('idempotency-key', key()).send({}),
        await http().post(`/v1/shipments/${id}/deliver`).set('idempotency-key', key()).send({}),
      ]) {
        expect(response.status).toBe(401);
      }
    });

    it('requires an operator role to move and a reader role to read; refuses AUDITOR, SYSTEM_ADMIN and a service token (403)', async () => {
      const a = org();
      const { shipmentId } = await seedShipment(api, a, org());
      const stranger = client(api, actor(a, ['SUPPLIER']));
      expect((await stranger.tracking(shipmentId)).body.code).toBe('INSUFFICIENT_ROLE');
      expect((await stranger.dispatch(shipmentId)).body.code).toBe('INSUFFICIENT_ROLE');
      for (const role of ['AUDITOR', 'SYSTEM_ADMIN']) {
        const refused = client(api, actor(a, ['ORGANIZATION_ADMIN', role]));
        expect([role, (await refused.tracking(shipmentId)).status]).toEqual([role, 403]);
        expect([role, (await refused.dispatch(shipmentId)).status]).toEqual([role, 403]);
      }
      const token = await internalToken('marketplace-service', a);
      const read = await request(api.app.getHttpServer())
        .get(`/v1/shipments/${shipmentId}/tracking`)
        .set('x-internal-token', token);
      expect(read.status).toBe(403);
      expect((await client(api, orgAdmin(a)).shipment(shipmentId)).body.status).toBe('CREATED');
    });
  });
});
