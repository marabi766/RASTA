import { eventEnvelopeSchema } from '@rasta/contracts';
import { ulid } from 'ulid';
import type { PrismaClient } from '../src/generated/prisma';
import { validateInventoryPayload, type InventoryEventName } from '../src/events/events';
import { ReturnShipmentRepository } from '../src/return-shipment/return-shipment.repository';
import { ENV } from '../src/tokens';
import type { InventoryEnv } from '../src/config/env';
import { actor, client, key, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import {
  cleanup,
  newOrderLineId,
  newOrderReference,
  newOrganizationId,
  newProductId,
  newReturnRequestId,
  runtimeClient,
} from './helpers';

/**
 * Return inspection and disposition (RUN-005 PR 2b; ADR-048 § 1, § 3, § 4) against the real
 * application and PostgreSQL: RECEIVED → INSPECTED → RESOLVED and its refusals, the arithmetic of
 * a disposition, the configuration that allows none by default (Q-133), who may move a return
 * shipment, one effect per key, the database keeping the same rules, and the stream.
 *
 * What it proves is *not* there: no stock row, no movement and no refund — a disposition is a
 * record of an outcome, nothing more.
 */
describe('return inspection and resolution', () => {
  let api: ApiHarness;
  let closed: ApiHarness;
  /** Resolves a return of which nothing arrived (Q-133 (4)) — with two dispositions allowed. */
  let nothing: ApiHarness;
  /** Would resolve one of which nothing arrived — but allows no disposition at all. */
  let nothingClosed: ApiHarness;
  let raw: PrismaClient;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  beforeAll(async () => {
    // One application that allows none (the default) and one that allows two dispositions. The
    // default is built first: the harness applies its overrides to `process.env` until it closes.
    // Every later one names both settings, so none inherits another's.
    closed = await startApi();
    nothingClosed = await startApi({
      INVENTORY_RETURN_DISPOSITIONS_ALLOWED: '',
      INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED: 'true',
    });
    nothing = await startApi({
      INVENTORY_RETURN_DISPOSITIONS_ALLOWED: 'RESTOCK, SCRAP',
      INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED: 'true',
    });
    api = await startApi({
      INVENTORY_RETURN_DISPOSITIONS_ALLOWED: 'RESTOCK, SCRAP',
      INVENTORY_RETURN_RESOLVE_NOTHING_RECEIVED: 'false',
    });
    raw = runtimeClient();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await raw.$disconnect();
    await api.close();
    await nothing.close();
    await nothingClosed.close();
    await closed.close();
  });

  /**
   * A RECEIVED return shipment of two lines (3 and 5 expected; `arrived` received), and what the
   * suite chose for it — the person, the request, the order, the products — and the correlation id
   * each request was answered under: the values its events must carry, known without reading them.
   */
  async function received(harness: ApiHarness = api, arrived: [number, number] = [3, 5]) {
    const owner = org();
    const buyer = org();
    const userId = `USR-APITEST-${ulid().slice(-8)}`;
    const ops = client(harness, actor(owner, ['ORGANIZATION_ADMIN'], { rastaUserId: userId }));
    const warehouseId = (await ops.createWarehouse()).body.id as string;
    const lineA = newOrderLineId();
    const lineB = newOrderLineId();
    const productA = newProductId();
    const productB = newProductId();
    const returnRequestId = newReturnRequestId();
    const orderId = newOrderReference();
    const created = await ops.dispatchReturn(warehouseId, buyer, {
      returnRequestId,
      orderId,
      lines: [
        { orderLineId: lineA, productId: productA, quantity: 3 },
        { orderLineId: lineB, productId: productB, quantity: 5 },
      ],
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const receipt = await ops.receiveReturn(id, {
      lines: [
        { orderLineId: lineA, receivedQuantity: arrived[0] },
        { orderLineId: lineB, receivedQuantity: arrived[1] },
      ],
    });
    expect(receipt.status).toBe(200);
    const correlations = [created, receipt].map((r) => r.headers['x-correlation-id'] as string);
    return {
      owner,
      buyer,
      userId,
      ops,
      warehouseId,
      lineA,
      lineB,
      productA,
      productB,
      returnRequestId,
      orderId,
      correlations,
      id,
      harness,
    };
  }

  async function inspected(harness: ApiHarness = api, arrived: [number, number] = [3, 5]) {
    const s = await received(harness, arrived);
    expect((await s.ops.inspectReturn(s.id)).status).toBe(200);
    return s;
  }

  const outboxOf = (harness: ApiHarness, organizationId: string, aggregateId: string) =>
    harness.prisma.client.outboxMessage.findMany({
      where: { organizationId, aggregateType: 'ReturnShipment', aggregateId },
      orderBy: [{ createdAt: 'asc' }, { streamSeq: 'asc' }],
    });
  /** PostgreSQL's clock, which stamps every row and event of this service. */
  const databaseNow = async (): Promise<Date> =>
    (await raw.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`)[0]!.now;
  const stockRows = async (organizationId: string) =>
    raw.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM "stock_item" WHERE "organization_id" = ${organizationId})
           + (SELECT count(*) FROM "stock_movement" WHERE "organization_id" = ${organizationId}) AS "n"`;

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  describe('inspection (POST /v1/return-shipments/{id}/inspection)', () => {
    it('records who and when, the note and the report — and the note never leaves on an event', async () => {
      const s = await received();
      const report = `DOC_${ulid()}`;

      const response = await s.ops.inspectReturn(s.id, {
        note: '  One housing cracked  ',
        reportDocumentId: report,
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'INSPECTED',
        version: 3,
        inspectionNote: 'One housing cracked',
        inspectionReportDocumentId: report,
        dispositions: [],
        resolvedAt: null,
      });
      expect(response.body.inspectedAt).not.toBeNull();
      expect(
        (await s.ops.returnTracking(s.id)).body.events.map((e: { type: string }) => e.type),
      ).toEqual(['IN_TRANSIT', 'RECEIVED', 'INSPECTED']);
      const rows = await outboxOf(api, s.owner, s.id);
      const event = eventEnvelopeSchema.parse(rows[2]?.payload).payload as Record<string, unknown>;
      expect(event).toMatchObject({ returnShipmentVersion: 3, reportDocumentId: report });
      expect(JSON.stringify(rows.map((r) => r.payload))).not.toMatch(/cracked/);
    });

    it('needs neither a note nor a report, and moves no stock', async () => {
      const s = await received();
      const before = await stockRows(s.owner);

      const response = await s.ops.inspectReturn(s.id);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        inspectionNote: null,
        inspectionReportDocumentId: null,
      });
      expect(await stockRows(s.owner)).toEqual(before);
    });

    it('refuses a shipment still in transit, and a second inspection, with 409', async () => {
      const owner = org();
      const ops = client(api, orgAdmin(owner));
      const warehouseId = (await ops.createWarehouse()).body.id as string;
      const early = await ops.dispatchReturn(warehouseId, org());

      const tooEarly = await ops.inspectReturn(early.body.id);
      expect(tooEarly.status).toBe(409);
      expect(tooEarly.body.code).toBe('INVALID_STATE_TRANSITION');
      expect(tooEarly.body.details?.[0]?.code).toBe('RETURN_SHIPMENT_NOT_RECEIVED');

      const s = await received();
      expect((await s.ops.inspectReturn(s.id)).status).toBe(200);
      const again = await s.ops.inspectReturn(s.id, { note: 'again' });
      expect(again.status).toBe(409);
      expect(again.body.details?.[0]?.code).toBe('RETURN_SHIPMENT_NOT_RECEIVED');
      expect((await s.ops.returnShipment(s.id)).body.inspectionNote).toBeNull();
    });

    it.each([
      ['an unknown field', { verdict: 'GOOD' }],
      ['a refund amount', { refundAmountMinor: '1' }],
      ['a report that is not a document id', { reportDocumentId: `ORD_${ulid()}` }],
      ['an empty note', { note: '' }],
      ['a note past 1000 characters', { note: 'x'.repeat(1001) }],
    ])('refuses %s with 400', async (_name, body) => {
      const s = await received();
      const refused = await s.ops.inspectReturn(s.id, body);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('RECEIVED');
    });

    it('applies expectedVersion when given (409 OPTIMISTIC_LOCK_FAILED otherwise)', async () => {
      const s = await received();
      const stale = await s.ops.inspectReturn(s.id, { expectedVersion: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect((await s.ops.inspectReturn(s.id, { expectedVersion: 2 })).status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  describe('resolution (POST /v1/return-shipments/{id}/resolution)', () => {
    it('gives every received unit an outcome, and records exactly that — no stock, no money', async () => {
      const s = await inspected(api, [3, 4]);
      const before = await stockRows(s.owner);

      const response = await s.ops.resolveReturn(s.id, {
        dispositions: [
          { orderLineId: s.lineA, disposition: 'RESTOCK', quantity: 2 },
          { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 1 },
          { orderLineId: s.lineB, disposition: 'SCRAP', quantity: 4 },
        ],
      });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'RESOLVED', version: 4 });
      expect(response.body.resolvedAt).not.toBeNull();
      const sorted = [...response.body.dispositions].sort(
        (a: { orderLineId: string; disposition: string }, b) =>
          `${a.orderLineId}${a.disposition}`.localeCompare(`${b.orderLineId}${b.disposition}`),
      );
      expect(sorted).toHaveLength(3);
      expect((await s.ops.returnShipment(s.id)).body.dispositions).toHaveLength(3);
      // A RESTOCK is a record: nothing was received into a balance.
      expect(await stockRows(s.owner)).toEqual(before);
      expect((await s.ops.get('/v1/stock')).body.items).toEqual([]);
      expect(
        (await s.ops.returnTracking(s.id)).body.events.map((e: { type: string }) => e.type),
      ).toEqual(['IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED']);
    });

    it('needs no row for a line that received nothing', async () => {
      const s = await inspected(api, [3, 0]);

      const response = await s.ops.resolveReturn(s.id, {
        dispositions: [{ orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 }],
      });

      expect(response.status).toBe(200);
    });

    it('refuses every disposition while none is configured (Q-133): the default allows none', async () => {
      const s = await inspected(closed);

      const refused = await s.ops.resolveReturn(s.id, {
        dispositions: [
          { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 },
          { orderLineId: s.lineB, disposition: 'SCRAP', quantity: 5 },
        ],
      });

      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(refused.body.details?.[0]?.code).toBe('DISPOSITION_NOT_ALLOWED');
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('INSPECTED');
    });

    it('refuses a disposition the deployment did not name, with the rest unwritten', async () => {
      const s = await inspected();

      const refused = await s.ops.resolveReturn(s.id, {
        dispositions: [
          { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 },
          { orderLineId: s.lineB, disposition: 'REPAIR', quantity: 5 },
        ],
      });

      expect(refused.status).toBe(422);
      expect(refused.body.details?.[0]?.code).toBe('DISPOSITION_NOT_ALLOWED');
      expect((await s.ops.returnShipment(s.id)).body.dispositions).toEqual([]);
      expect((await outboxOf(api, s.owner, s.id)).map((r) => r.eventName)).not.toContain(
        'RETURN_SHIPMENT_RESOLVED',
      );
    });

    it.each([
      ['too few units', [3, 4]],
      ['too many units', [3, 6]],
      ['a line left out', [3, 0]],
      // Empty is a shape, never a shortcut: it balances only a return of which nothing arrived.
      ['no rows for units that arrived', [0, 0]],
    ])('refuses %s with 422 DISPOSITIONS_DO_NOT_BALANCE', async (_name, [a, b]) => {
      const s = await inspected();
      const dispositions = [
        ...(a === 0 ? [] : [{ orderLineId: s.lineA, disposition: 'SCRAP', quantity: a }]),
        ...(b === 0 ? [] : [{ orderLineId: s.lineB, disposition: 'SCRAP', quantity: b }]),
      ];

      const refused = await s.ops.resolveReturn(s.id, { dispositions });

      expect(refused.status).toBe(422);
      expect(refused.body.details?.[0]?.code).toBe('DISPOSITIONS_DO_NOT_BALANCE');
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('INSPECTED');
    });

    it('refuses a row for a line the shipment does not have, or for a unit that never arrived', async () => {
      const s = await inspected(api, [3, 0]);
      const stranger = await s.ops.resolveReturn(s.id, {
        dispositions: [
          { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 },
          { orderLineId: newOrderLineId(), disposition: 'SCRAP', quantity: 1 },
        ],
      });
      const phantom = await s.ops.resolveReturn(s.id, {
        dispositions: [
          { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 },
          { orderLineId: s.lineB, disposition: 'SCRAP', quantity: 1 },
        ],
      });

      for (const refused of [stranger, phantom]) {
        expect(refused.status).toBe(422);
        expect(refused.body.details?.[0]?.code).toBe('DISPOSITIONS_DO_NOT_BALANCE');
      }
    });

    it.each(['detail', 'list'] as const)(
      'reads the %s from one snapshot, though a resolution commits before its dispositions are read (Codex r1 on #313)',
      async (read) => {
        const s = await inspected(api, [3, 5]);
        const repository = api.app.get(ReturnShipmentRepository);
        const dispositionsOf = repository.dispositionsOf.bind(repository);
        let committedBetween = false;
        // The shipment and its lines have been read; the resolution commits now, before the
        // dispositions are.
        const between = jest
          .spyOn(repository, 'dispositionsOf')
          .mockImplementationOnce(async (shipments, reader) => {
            const resolved = await s.ops.resolveReturn(s.id, {
              dispositions: [
                { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 },
                { orderLineId: s.lineB, disposition: 'RESTOCK', quantity: 5 },
              ],
            });
            expect(resolved.status).toBe(200);
            committedBetween = true;
            return dispositionsOf(shipments, reader);
          });
        try {
          const response =
            read === 'detail'
              ? await s.ops.returnShipment(s.id)
              : await s.ops.get('/v1/return-shipments');
          expect(response.status).toBe(200);
          const view = read === 'detail' ? response.body : response.body.items[0];

          // What the database held before the resolution: never INSPECTED with its outcome.
          expect(view).toMatchObject({
            id: s.id,
            status: 'INSPECTED',
            version: 3,
            resolvedAt: null,
            dispositions: [],
          });
          expect(committedBetween).toBe(true);
        } finally {
          between.mockRestore();
        }

        expect((await s.ops.returnShipment(s.id)).body).toMatchObject({
          status: 'RESOLVED',
          version: 4,
        });
        expect((await s.ops.returnShipment(s.id)).body.dispositions).toHaveLength(2);
      },
    );

    it('refuses a shipment not yet inspected, and a second resolution, with 409', async () => {
      const s = await received();
      const dispositions = [
        { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 },
        { orderLineId: s.lineB, disposition: 'SCRAP', quantity: 5 },
      ];
      const early = await s.ops.resolveReturn(s.id, { dispositions });
      expect(early.status).toBe(409);
      expect(early.body.details?.[0]?.code).toBe('RETURN_SHIPMENT_NOT_INSPECTED');

      await s.ops.inspectReturn(s.id);
      expect((await s.ops.resolveReturn(s.id, { dispositions })).status).toBe(200);
      const again = await s.ops.resolveReturn(s.id, { dispositions });
      expect(again.status).toBe(409);
      expect(again.body.details?.[0]?.code).toBe('RETURN_SHIPMENT_NOT_INSPECTED');
      expect((await s.ops.returnShipment(s.id)).body.dispositions).toHaveLength(2);
    });

    it.each([
      ['no dispositions field', {}],
      [
        'a refund disposition',
        { dispositions: [{ orderLineId: `OLN_${ulid()}`, disposition: 'REFUND', quantity: 1 }] },
      ],
      [
        'a zero quantity',
        { dispositions: [{ orderLineId: `OLN_${ulid()}`, disposition: 'SCRAP', quantity: 0 }] },
      ],
      [
        'a refund amount',
        {
          dispositions: [
            {
              orderLineId: `OLN_${ulid()}`,
              disposition: 'SCRAP',
              quantity: 1,
              refundAmountMinor: '5',
            },
          ],
        },
      ],
      [
        'a line sent one way twice',
        {
          dispositions: [
            { orderLineId: 'OLN_01JBQ0000000000000000000AB', disposition: 'SCRAP', quantity: 1 },
            { orderLineId: 'OLN_01JBQ0000000000000000000AB', disposition: 'SCRAP', quantity: 1 },
          ],
        },
      ],
    ])('refuses %s with 400', async (_name, body) => {
      const s = await inspected();
      const refused = await s.ops.resolveReturn(s.id, body);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // Nothing arrived (Q-133 (4); Codex r1 on #313, finding 1)
  // -------------------------------------------------------------------------

  describe('a return of which nothing arrived', () => {
    const resolvedEvents = async (harness: ApiHarness, owner: string, id: string) =>
      (await outboxOf(harness, owner, id)).filter(
        (r) => r.eventName === 'RETURN_SHIPMENT_RESOLVED',
      );

    it('is refused by name while the deployment has not said what it resolves to (the default)', async () => {
      const s = await inspected(api, [0, 0]);

      // Neither the empty set nor any row resolves it: the outcome is undecided (Q-133 (4)).
      for (const dispositions of [
        [],
        [{ orderLineId: s.lineA, disposition: 'SCRAP', quantity: 1 }],
      ]) {
        const refused = await s.ops.resolveReturn(s.id, { dispositions });
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
        expect(refused.body.details?.[0]?.code).toBe('NOTHING_RECEIVED_TO_RESOLVE');
      }
      expect((await s.ops.returnShipment(s.id)).body).toMatchObject({
        status: 'INSPECTED',
        dispositions: [],
      });
      expect(await resolvedEvents(api, s.owner, s.id)).toEqual([]);
    });

    it('resolves with no disposition where the deployment allows it — in the API, the event and the database', async () => {
      const s = await inspected(nothing, [0, 0]);
      const before = await stockRows(s.owner);

      const response = await s.ops.resolveReturn(s.id, { dispositions: [] });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'RESOLVED', version: 4, dispositions: [] });
      expect((await s.ops.returnShipment(s.id)).body).toMatchObject({
        status: 'RESOLVED',
        version: 4,
        dispositions: [],
        lines: [{ receivedQuantity: 0 }, { receivedQuantity: 0 }],
      });
      expect(
        (await s.ops.returnTracking(s.id)).body.events.map((e: { type: string }) => e.type),
      ).toEqual(['IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESOLVED']);
      // The event carries the same empty set, and its contract accepts it.
      const [event] = await resolvedEvents(nothing, s.owner, s.id);
      const envelope = eventEnvelopeSchema.parse(event?.payload);
      expect(validateInventoryPayload('RETURN_SHIPMENT_RESOLVED', envelope.payload)).toMatchObject({
        returnShipmentVersion: 4,
        dispositions: [],
      });
      expect(await stockRows(s.owner)).toEqual(before);
    });

    it('still refuses a row for a unit that never arrived', async () => {
      const s = await inspected(nothing, [0, 0]);

      const refused = await s.ops.resolveReturn(s.id, {
        dispositions: [{ orderLineId: s.lineA, disposition: 'SCRAP', quantity: 1 }],
      });

      expect(refused.status).toBe(422);
      expect(refused.body.details?.[0]?.code).toBe('DISPOSITIONS_DO_NOT_BALANCE');
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('INSPECTED');
    });

    it.each([
      ['no disposition is configured, whatever else is', () => nothingClosed],
      ['nothing is configured (the default)', () => closed],
    ])(
      'is never resolved by an empty set while %s: 422 DISPOSITION_NOT_ALLOWED',
      async (_, harness) => {
        const s = await inspected(harness(), [0, 0]);

        const refused = await s.ops.resolveReturn(s.id, { dispositions: [] });

        expect(refused.status).toBe(422);
        expect(refused.body.details?.[0]?.code).toBe('DISPOSITION_NOT_ALLOWED');
        expect((await s.ops.returnShipment(s.id)).body.status).toBe('INSPECTED');
        expect(await resolvedEvents(harness(), s.owner, s.id)).toEqual([]);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Who may move it
  // -------------------------------------------------------------------------

  describe('who may inspect and resolve (BOLA)', () => {
    it('lets the sender read the outcome but never inspect or resolve (403); a stranger gets 404', async () => {
      const s = await inspected();
      const sender = client(api, orgAdmin(s.buyer));
      const stranger = client(api, orgAdmin(org()));
      const dispositions = [
        { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 },
        { orderLineId: s.lineB, disposition: 'SCRAP', quantity: 5 },
      ];

      expect((await sender.resolveReturn(s.id, { dispositions })).status).toBe(403);
      expect((await sender.inspectReturn(s.id)).status).toBe(403);
      expect((await stranger.resolveReturn(s.id, { dispositions })).status).toBe(404);
      expect((await stranger.inspectReturn(s.id)).status).toBe(404);
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('INSPECTED');

      expect((await s.ops.resolveReturn(s.id, { dispositions })).status).toBe(200);
      const read = await sender.returnShipment(s.id);
      expect(read.status).toBe(200);
      expect(read.body.dispositions).toHaveLength(2);
      expect((await stranger.returnShipment(s.id)).status).toBe(404);
    });

    it('refuses AUDITOR, SYSTEM_ADMIN and a role without an operator right', async () => {
      const s = await inspected();
      for (const roles of [['AUDITOR'], ['SYSTEM_ADMIN'], ['PROCUREMENT_USER']]) {
        const as = client(api, actor(s.owner, roles));
        expect((await as.inspectReturn(s.id)).status).toBe(403);
        expect(
          (
            await as.resolveReturn(s.id, {
              dispositions: [{ orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 }],
            })
          ).status,
        ).toBe(403);
      }
    });
  });

  // -------------------------------------------------------------------------
  // One effect per key, and under concurrency
  // -------------------------------------------------------------------------

  describe('one effect per key, and under concurrency', () => {
    it('replays an inspection and a resolution under the same key, and refuses the key elsewhere', async () => {
      const s = await received();
      const inspectKey = key();
      const first = await s.ops.inspectReturn(s.id, { note: 'checked' }, inspectKey);
      const replay = await s.ops.inspectReturn(s.id, { note: 'checked' }, inspectKey);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect((await s.ops.inspectReturn(s.id, { note: 'other' }, inspectKey)).status).toBe(409);

      const resolveKey = key();
      const dispositions = [
        { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 },
        { orderLineId: s.lineB, disposition: 'RESTOCK', quantity: 5 },
      ];
      const resolved = await s.ops.resolveReturn(s.id, { dispositions }, resolveKey);
      const again = await s.ops.resolveReturn(s.id, { dispositions }, resolveKey);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(resolved.body);
      expect((await outboxOf(api, s.owner, s.id)).map((r) => r.eventName)).toEqual([
        'RETURN_SHIPMENT_DISPATCHED',
        'RETURN_SHIPMENT_RECEIVED',
        'RETURN_SHIPMENT_INSPECTED',
        'RETURN_SHIPMENT_RESOLVED',
      ]);
    });

    it('resolves once of ten concurrent resolutions under different keys, with one event and one set of rows', async () => {
      const s = await inspected();
      const dispositions = [
        { orderLineId: s.lineA, disposition: 'SCRAP', quantity: 3 },
        { orderLineId: s.lineB, disposition: 'SCRAP', quantity: 5 },
      ];

      const results = await Promise.all(
        Array.from({ length: 10 }, () => s.ops.resolveReturn(s.id, { dispositions })),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
      expect((await s.ops.returnShipment(s.id)).body.dispositions).toHaveLength(2);
      expect(
        (await outboxOf(api, s.owner, s.id)).filter(
          (r) => r.eventName === 'RETURN_SHIPMENT_RESOLVED',
        ),
      ).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The database keeps the same rules
  // -------------------------------------------------------------------------

  describe('the database keeps the arithmetic and the order, whatever a write path forgets', () => {
    it('refuses to commit a resolution whose dispositions do not add up', async () => {
      const s = await inspected();
      const trackingId = `RTK_${ulid()}`;

      await expect(
        raw.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE "return_shipment"
             SET "status" = 'RESOLVED', "version" = 4, "resolved_at" = now(), "resolved_by" = 'X', "updated_at" = now()
           WHERE "id" = ${s.id}`;
          await tx.$executeRaw`INSERT INTO "return_tracking_event"
             ("id","organization_id","return_shipment_id","type","shipment_version","occurred_at","recorded_at","recorded_by","correlation_id","command_key_hash")
             VALUES (${trackingId}, ${s.owner}, ${s.id}, 'RESOLVED', 4, now(), now(), 'X', 'c', ${'a'.repeat(64)})`;
          await tx.$executeRaw`INSERT INTO "return_disposition"
             ("id","organization_id","return_shipment_id","order_line_id","disposition","quantity","created_at")
             VALUES (${`RDP_${ulid()}`}, ${s.owner}, ${s.id}, ${s.lineA}, 'SCRAP', 1, now())`;
        }),
      ).rejects.toThrow(/ck_return_shipment_dispositions_balance|balance/i);
      expect((await s.ops.returnShipment(s.id)).body.status).toBe('INSPECTED');
    });

    it('refuses a disposition outside a resolution, a changed or erased one, and a skipped state', async () => {
      const s = await inspected();
      await expect(
        raw.$executeRaw`INSERT INTO "return_disposition"
           ("id","organization_id","return_shipment_id","order_line_id","disposition","quantity","created_at")
           VALUES (${`RDP_${ulid()}`}, ${s.owner}, ${s.id}, ${s.lineA}, 'SCRAP', 1, now())`,
      ).rejects.toThrow(/ck_return_disposition_with_resolution/);
      await expect(
        raw.$executeRaw`UPDATE "return_shipment" SET "status" = 'RESOLVED', "version" = 4 WHERE "id" = ${s.id}`,
      ).rejects.toThrow();

      const r = await received();
      await expect(
        raw.$executeRaw`UPDATE "return_shipment" SET "status" = 'RESOLVED', "version" = 4 WHERE "id" = ${r.id}`,
      ).rejects.toThrow(/ck_return_shipment_transition/);

      const done = await inspected();
      await done.ops.resolveReturn(done.id, {
        dispositions: [
          { orderLineId: done.lineA, disposition: 'SCRAP', quantity: 3 },
          { orderLineId: done.lineB, disposition: 'SCRAP', quantity: 5 },
        ],
      });
      await expect(
        raw.$executeRaw`UPDATE "return_disposition" SET "quantity" = 99 WHERE "return_shipment_id" = ${done.id}`,
      ).rejects.toThrow(/ck_return_disposition_immutable/);
      await expect(
        raw.$executeRaw`DELETE FROM "return_disposition" WHERE "return_shipment_id" = ${done.id}`,
      ).rejects.toThrow(/ck_return_disposition_immutable/);
      await expect(
        raw.$executeRaw`UPDATE "return_shipment" SET "status" = 'INSPECTED', "version" = 3 WHERE "id" = ${done.id}`,
      ).rejects.toThrow(/ck_return_shipment_transition/);
    });

    it('refuses to rewrite what the inspector recorded', async () => {
      const s = await received();
      await s.ops.inspectReturn(s.id, { note: 'original' });
      await expect(
        raw.$executeRaw`UPDATE "return_shipment" SET "inspection_note" = 'forged' WHERE "id" = ${s.id}`,
      ).rejects.toThrow();
      expect((await s.ops.returnShipment(s.id)).body.inspectionNote).toBe('original');
    });
  });

  // -------------------------------------------------------------------------
  // The stream
  // -------------------------------------------------------------------------

  describe('the STRICT returnShipmentId stream, to its end', () => {
    it('writes four events in one stream, consecutive from 1, every one valid against its contract', async () => {
      // The window the events must be stamped in, read from the clock that stamps them
      // (PostgreSQL, `src/shared/clock.ts`), not from this process's.
      const from = await databaseNow();
      const s = await received();
      const inspection = await s.ops.inspectReturn(s.id, { note: 'cracked housing' });
      const resolution = await s.ops.resolveReturn(s.id, {
        dispositions: [
          { orderLineId: s.lineA, disposition: 'RESTOCK', quantity: 3 },
          { orderLineId: s.lineB, disposition: 'SCRAP', quantity: 5 },
        ],
      });
      expect([inspection.status, resolution.status]).toEqual([200, 200]);
      const to = await databaseNow();

      const rows = await outboxOf(api, s.owner, s.id);

      expect(rows.map((r) => r.eventName)).toEqual([
        'RETURN_SHIPMENT_DISPATCHED',
        'RETURN_SHIPMENT_RECEIVED',
        'RETURN_SHIPMENT_INSPECTED',
        'RETURN_SHIPMENT_RESOLVED',
      ]);
      expect(rows.map((r) => Number(r.streamSeq))).toEqual([1, 2, 3, 4]);
      for (const [index, row] of rows.entries()) {
        const envelope = eventEnvelopeSchema.parse(row.payload);
        expect(envelope).toMatchObject({
          streamSeq: index + 1,
          streamKey: s.id,
          tenantId: s.owner,
        });
        const payload = validateInventoryPayload(
          row.eventName as InventoryEventName,
          envelope.payload,
        ) as { returnShipmentVersion: number };
        expect(payload.returnShipmentVersion).toBe(index + 1);
      }

      // Every event whole, every field against what is known without reading the events: the
      // suite's own choices, the tracking events and the shipment as the API reports them, the
      // correlation id each request was answered under. An identifier, an actor or an instant is
      // therefore exactly the one expected — none of them can carry anything else, a note included.
      const tracking = (await s.ops.returnTracking(s.id)).body.events as {
        id: string;
        type: string;
        occurredAt: string;
      }[];
      expect(tracking.map((t) => t.type)).toEqual([
        'IN_TRANSIT',
        'RECEIVED',
        'INSPECTED',
        'RESOLVED',
      ]);
      const shipment = (await s.ops.returnShipment(s.id)).body as Record<string, unknown>;
      const at = tracking.map((t) => t.occurredAt);
      expect([shipment.receivedAt, shipment.inspectedAt, shipment.resolvedAt]).toEqual(at.slice(1));
      for (const instant of at) {
        expect(new Date(instant).toISOString()).toBe(instant);
        expect(Date.parse(instant)).toBeGreaterThanOrEqual(from.getTime());
        expect(Date.parse(instant)).toBeLessThanOrEqual(to.getTime());
      }
      const correlations = [
        ...s.correlations,
        inspection.headers['x-correlation-id'] as string,
        resolution.headers['x-correlation-id'] as string,
      ];
      const facts = (index: number) => ({
        returnShipmentId: s.id,
        organizationId: s.owner,
        returnRequestId: s.returnRequestId,
        orderId: s.orderId,
        buyerOrganizationId: s.buyer,
        destinationWarehouseId: s.warehouseId,
        trackingEventId: tracking[index]!.id,
        returnShipmentVersion: index + 1,
      });
      const lines = [
        { orderLineId: s.lineA, productId: s.productA, expectedQuantity: 3 },
        { orderLineId: s.lineB, productId: s.productB, expectedQuantity: 5 },
      ];
      const payloads = [
        { ...facts(0), lines, dispatchedBy: s.userId, dispatchedAt: at[0] },
        {
          ...facts(1),
          lines: lines.map((line) => ({ ...line, receivedQuantity: line.expectedQuantity })),
          receivedBy: s.userId,
          receivedAt: at[1],
        },
        { ...facts(2), reportDocumentId: null, inspectedBy: s.userId, inspectedAt: at[2] },
        {
          ...facts(3),
          dispositions: [
            { orderLineId: s.lineA, disposition: 'RESTOCK', quantity: 3 },
            { orderLineId: s.lineB, disposition: 'SCRAP', quantity: 5 },
          ],
          resolvedBy: s.userId,
          resolvedAt: at[3],
        },
      ];
      const producerVersion = api.app.get<InventoryEnv>(ENV).SERVICE_VERSION;
      // The contract orders neither the lines nor the dispositions: compared by order line.
      const byLine = (payload: Record<string, unknown>) => {
        const sorted = (rows: unknown) =>
          [...(rows as { orderLineId: string }[])].sort((a, b) =>
            a.orderLineId.localeCompare(b.orderLineId),
          );
        return {
          ...payload,
          ...('lines' in payload ? { lines: sorted(payload.lines) } : {}),
          ...('dispositions' in payload ? { dispositions: sorted(payload.dispositions) } : {}),
        };
      };
      rows.forEach((row, index) => {
        const { traceparent, payload, ...envelope } = row.payload as Record<string, unknown>;
        // Present only when the request was traced; never anything but the W3C form.
        if (traceparent !== undefined) {
          expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        }
        expect(envelope).toEqual({
          eventId: row.id,
          eventName: row.eventName,
          eventVersion: 1,
          occurredAt: at[index],
          producer: 'inventory-service',
          producerVersion,
          aggregateType: 'ReturnShipment',
          aggregateId: s.id,
          tenantId: s.owner,
          correlationId: correlations[index],
          actor: { type: 'USER', id: s.userId },
          streamSeq: index + 1,
          streamKey: s.id,
        });
        expect(byLine(payload as Record<string, unknown>)).toEqual(byLine(payloads[index]!));
      });
      expect(rows.map((row) => row.id)).toEqual(
        rows.map(() => expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/)),
      );

      // And by key and by value, the pinned ids, actors and instants left out: shipment ids
      // (`RSH_<ulid>`) can contain any short word by chance.
      const forbidden = /cracked|Road freight|WB-2001|refund|amount/i;
      const walk = (key: string, value: unknown): void => {
        if (Array.isArray(value)) return value.forEach((item) => walk(key, item));
        if (value !== null && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            expect(k).not.toMatch(forbidden);
            walk(k, v);
          }
          return;
        }
        if (/^id$|(Id|Key|By|At)$/.test(key)) return;
        if (typeof value === 'string') expect(value).not.toMatch(forbidden);
      };
      rows.forEach((r) => walk('', r.payload));
    });

    it('writes nothing when a command is refused', async () => {
      const s = await inspected();
      const before = (await outboxOf(api, s.owner, s.id)).length;

      await s.ops.resolveReturn(s.id, {
        dispositions: [{ orderLineId: s.lineA, disposition: 'SCRAP', quantity: 1 }],
      });
      await client(api, orgAdmin(s.buyer)).inspectReturn(s.id);

      expect((await outboxOf(api, s.owner, s.id)).length).toBe(before);
    });
  });
});
