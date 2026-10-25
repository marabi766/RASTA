import { Kafka, type Consumer, type Producer } from 'kafkajs';
import { DLQ_HEADERS, DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  UnprocessableEventError,
  createSystemContext,
  kafkaClientConfig,
  kafkaConnectionFor,
  runUnscoped,
  runWithContext,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ReturnRepository } from '../src/returns/return.repository';
import {
  MARKETPLACE_DEAD_LETTER_TOPIC,
  RETURN_MIRROR_CONSUMED_TOPICS,
  RETURN_MIRROR_CONSUMER,
  ReturnMirrorConsumer,
  ReturnStepAheadError,
} from '../src/returns/return-mirror.consumer';
import {
  asActor,
  brokers,
  cleanup,
  key,
  newPrisma,
  outboxFor,
  publishOffer,
  tenants,
  waitFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * RUN-005 PR 3 — the return mirror against a real PostgreSQL, then over a real broker.
 *
 * The database half drives `handle()` directly, in the context `EventConsumer` builds from the
 * envelope (the supplier's tenant), with envelopes shaped exactly as inventory-service publishes
 * them: which request moves, how far, what it publishes, and what is refused — with nothing
 * written for a refusal, a duplicate, a stale step or an early one. The broker half proves the
 * refusals land on `rasta.marketplace.v1.dlq` with their reasons.
 */

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

/** The event's own payload: an outbox row stores the whole envelope. */
function body(row: { payload: unknown }): Record<string, unknown> & { returnVersion?: number } {
  return (row.payload as { payload: Record<string, unknown> & { returnVersion?: number } }).payload;
}

const STRICT = { partialDispatchAllowed: false };

interface Fixture {
  buyer: string;
  supplier: string;
  orderId: string;
  lineId: string;
  productId: string;
  requestId: string;
  shipmentId: string;
}

type Step = 'DISPATCHED' | 'RECEIVED' | 'INSPECTED' | 'RESOLVED';
const SEQ: Record<Step, number> = { DISPATCHED: 1, RECEIVED: 2, INSPECTED: 3, RESOLVED: 4 };

/** One inventory-service return event about the fixture, as inventory's outbox writes it. */
function event(
  f: Fixture,
  step: Step,
  payload: Record<string, unknown> = {},
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  const line = { orderLineId: f.lineId, productId: f.productId, expectedQuantity: 2 };
  const own: Record<Step, Record<string, unknown>> = {
    DISPATCHED: {
      lines: [line],
      dispatchedBy: 'USR-WH-1',
      dispatchedAt: '2026-10-16T10:00:00.000Z',
    },
    RECEIVED: {
      lines: [{ ...line, receivedQuantity: 2 }],
      receivedBy: 'USR-WH-2',
      receivedAt: '2026-10-16T11:00:00.000Z',
    },
    INSPECTED: {
      reportDocumentId: `DOC_${ulid()}`,
      inspectedBy: 'USR-WH-3',
      inspectedAt: '2026-10-16T12:00:00.000Z',
    },
    RESOLVED: {
      dispositions: [
        { orderLineId: f.lineId, disposition: 'RESTOCK', quantity: 1 },
        { orderLineId: f.lineId, disposition: 'SCRAP', quantity: 1 },
      ],
      resolvedBy: 'USR-WH-4',
      resolvedAt: '2026-10-16T13:00:00.000Z',
    },
  };
  return {
    eventId: ulid(),
    eventName: `RETURN_SHIPMENT_${step}`,
    eventVersion: 1,
    occurredAt: '2026-10-16T10:00:00.000Z',
    producer: 'inventory-service',
    producerVersion: '1.0.0',
    aggregateType: 'ReturnShipment',
    aggregateId: f.shipmentId,
    tenantId: f.supplier,
    correlationId: `COR_${ulid()}`,
    streamKey: f.shipmentId,
    streamSeq: SEQ[step],
    payload: {
      returnShipmentId: f.shipmentId,
      organizationId: f.supplier,
      returnRequestId: f.requestId,
      orderId: f.orderId,
      buyerOrganizationId: f.buyer,
      destinationWarehouseId: `WHS_${ulid()}`,
      trackingEventId: `RTK_${ulid()}`,
      returnShipmentVersion: SEQ[step],
      ...own[step],
      ...payload,
    },
    ...overrides,
  };
}

describe('return mirror (RUN-005 PR 3)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let mirror: ReturnMirrorConsumer;
  const orgs: string[] = [];

  beforeAll(() => {
    prisma = newPrisma();
    // The window is a business fact nobody has decided (Q-132); the suite opts in.
    wiring = wire(prisma, { MARKETPLACE_RETURN_WINDOW_DAYS: 30 });
    mirror = mirrorWith(STRICT);
  });

  afterAll(async () => {
    await cleanup(prisma, orgs);
    await prisma.onModuleDestroy();
  });

  function mirrorWith(rules: { partialDispatchAllowed: boolean }) {
    return new ReturnMirrorConsumer(
      null,
      prisma,
      new ReturnRepository(prisma),
      wiring.events,
      rules,
      silent,
    );
  }

  /** As `EventConsumer` runs a handler: in the envelope's tenant, with its correlation id. */
  function deliver(source: EventEnvelope, consumer = mirror) {
    return runWithContext(
      createSystemContext({
        correlationId: source.correlationId,
        ...(source.tenantId ? { organizationId: source.tenantId } : {}),
        callerService: source.producer,
      }),
      () => consumer.handle(source),
    );
  }

  /** A COMPLETED order of two units, and a return of both, AUTHORIZED unless told otherwise. */
  async function authorizedReturn(
    options: {
      authorize?: boolean;
      quantity?: number;
      parties?: { buyer: string; supplier: string };
    } = {},
  ): Promise<Fixture> {
    const parties = options.parties ?? tenants();
    orgs.push(parties.buyer, parties.supplier);
    const { offerId } = await publishOffer(wiring, parties.supplier);
    const asBuyer = <T>(fn: () => Promise<T>) =>
      asActor({ organizationId: parties.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-B' }, fn);
    const asSupplier = <T>(fn: () => Promise<T>) =>
      asActor({ organizationId: parties.supplier, roles: ['SUPPLIER'], userId: 'USR-S' }, fn);

    const order = await asBuyer(() =>
      wiring.orders.place(
        { lines: [{ offerId, quantity: options.quantity ?? 2 }] },
        key('mir-ord'),
      ),
    );
    await runUnscoped('the suite completes the order the saga would', () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE "order"
            SET status='COMPLETED', economic_transaction_id=$2, economic_settlement_id=$3,
                receipt_confirmed_at=now() - interval '1 day', receipt_confirmed_by='USR-B',
                completed_at=now() - interval '1 day'
          WHERE id=$1`,
        order.id,
        `TXN_MIRROR_${order.id}`,
        `STL_MIRROR_${order.id}`,
      ),
    );
    const line = order.lines[0]!;
    const requested = await asBuyer(() =>
      wiring.returns.request(
        order.id,
        {
          reason: 'قطعه با مشخصات سفارش مطابقت ندارد',
          lines: [{ orderLineId: line.id, quantity: 2 }],
        },
        key('mir-ret'),
      ),
    );
    if (options.authorize !== false) {
      await asSupplier(() => wiring.returns.authorize(requested.id, key('mir-auth')));
    }
    return {
      ...parties,
      orderId: order.id,
      lineId: line.id,
      productId: line.productId,
      requestId: requested.id,
      shipmentId: `RSP_${ulid()}`,
    };
  }

  function stored(f: Fixture) {
    return runUnscoped('the suite reads the request it drove', () =>
      prisma.client.returnRequest.findUniqueOrThrow({ where: { id: f.requestId } }),
    );
  }

  function history(f: Fixture) {
    return runUnscoped('the suite reads the request history it drove', () =>
      prisma.client.returnStatusHistory.findMany({
        where: { returnRequestId: f.requestId },
        orderBy: { version: 'asc' },
      }),
    );
  }

  async function published(f: Fixture) {
    return (await outboxFor(prisma, f.buyer)).filter((row) => row.aggregateId === f.requestId);
  }

  async function marked(eventId: string): Promise<boolean> {
    const row = await prisma.client.processedEvent.findUnique({
      where: { eventId_consumerName: { eventId, consumerName: RETURN_MIRROR_CONSUMER } },
    });
    return row !== null;
  }

  async function expectRefused(source: EventEnvelope, reason: string): Promise<void> {
    let error: unknown;
    try {
      await deliver(source);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnprocessableEventError);
    expect((error as UnprocessableEventError).reason).toBe(reason);
    expect(await marked(source.eventId)).toBe(false);
  }

  describe('the four steps, in order', () => {
    it('answers a cancellation the buyer made from AUTHORIZED, once its goods moved it IN_TRANSIT, 409 — stale, not illegal (Codex r2 on #339, finding 2)', async () => {
      const f = await authorizedReturn();
      await expect(deliver(event(f, 'DISPATCHED'))).resolves.toBeUndefined();

      await expect(
        asActor({ organizationId: f.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-B' }, () =>
          wiring.returns.cancel(f.requestId, { expectedStatus: 'AUTHORIZED' }, key('mir-cancel')),
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(await stored(f)).toMatchObject({ status: 'IN_TRANSIT', version: 3 });
    });

    it('moves an AUTHORIZED request IN_TRANSIT → RECEIVED → INSPECTED → RESOLVED, each with its history and event', async () => {
      const f = await authorizedReturn();
      const inspected = event(f, 'INSPECTED');
      const steps = [event(f, 'DISPATCHED'), event(f, 'RECEIVED'), inspected, event(f, 'RESOLVED')];
      for (const source of steps) await expect(deliver(source)).resolves.toBeUndefined();

      const row = await stored(f);
      expect(row).toMatchObject({
        status: 'RESOLVED',
        version: 6,
        returnShipmentId: f.shipmentId,
        inspectionReportDocumentId: (inspected.payload as { reportDocumentId: string })
          .reportDocumentId,
      });
      // inventory's instants, as reported — not this service's clock.
      expect(row.inTransitAt?.toISOString()).toBe('2026-10-16T10:00:00.000Z');
      expect(row.receivedAt?.toISOString()).toBe('2026-10-16T11:00:00.000Z');
      expect(row.inspectedAt?.toISOString()).toBe('2026-10-16T12:00:00.000Z');
      expect(row.resolvedAt?.toISOString()).toBe('2026-10-16T13:00:00.000Z');

      expect(
        (await history(f)).map((h) => [h.version, h.fromStatus, h.toStatus, h.actorId]),
      ).toEqual([
        [1, null, 'REQUESTED', 'USR-B'],
        [2, 'REQUESTED', 'AUTHORIZED', 'USR-S'],
        [3, 'AUTHORIZED', 'IN_TRANSIT', 'USR-WH-1'],
        [4, 'IN_TRANSIT', 'RECEIVED', 'USR-WH-2'],
        [5, 'RECEIVED', 'INSPECTED', 'USR-WH-3'],
        [6, 'INSPECTED', 'RESOLVED', 'USR-WH-4'],
      ]);
      const correlations = (await history(f)).slice(2).map((h) => h.correlationId);
      expect(correlations).toEqual(steps.map((s) => s.correlationId));

      const events = (await published(f)).slice(2);
      expect(events.map((e) => [e.eventName, body(e).returnVersion])).toEqual([
        ['RETURN_IN_TRANSIT', 3],
        ['RETURN_RECEIVED', 4],
        ['RETURN_INSPECTED', 5],
        ['RETURN_RESOLVED', 6],
      ]);
      // Published in the buyer's tenant, keyed by the request, caused by inventory's event.
      for (const [index, row] of events.entries()) {
        expect(row.organizationId).toBe(f.buyer);
        expect(row.partitionKey).toBe(f.requestId);
        expect((row.headers as Record<string, string>)['x-causation-id'] ?? '').toBe(
          steps[index]!.eventId,
        );
      }
      expect(body(events[1]!)).toMatchObject({
        returnShipmentId: f.shipmentId,
        receivedLines: [{ orderLineId: f.lineId, receivedQuantity: 2 }],
      });
      expect(body(events[3]!)).toMatchObject({
        outcomes: [
          { orderLineId: f.lineId, disposition: 'RESTOCK', quantity: 1 },
          { orderLineId: f.lineId, disposition: 'SCRAP', quantity: 1 },
        ],
      });
      for (const source of steps) expect(await marked(source.eventId)).toBe(true);
    });

    it('resolves a return of which nothing arrived with no outcome (Q-133 (4))', async () => {
      const f = await authorizedReturn();
      await deliver(event(f, 'DISPATCHED'));
      await deliver(
        event(f, 'RECEIVED', {
          lines: [
            {
              orderLineId: f.lineId,
              productId: f.productId,
              expectedQuantity: 2,
              receivedQuantity: 0,
            },
          ],
        }),
      );
      await deliver(event(f, 'INSPECTED', { reportDocumentId: null }));
      await deliver(event(f, 'RESOLVED', { dispositions: [] }));
      expect((await stored(f)).status).toBe('RESOLVED');
      const [resolved] = (await published(f)).filter((e) => e.eventName === 'RETURN_RESOLVED');
      expect(body(resolved!).outcomes).toEqual([]);
    });

    it('shows the physical half to both parties and to nobody else', async () => {
      const f = await authorizedReturn();
      await deliver(event(f, 'DISPATCHED'));
      for (const [organizationId, roles] of [
        [f.buyer, ['PROCUREMENT_USER']],
        [f.supplier, ['SUPPLIER']],
      ] as const) {
        const view = await asActor({ organizationId, roles: [...roles] }, () =>
          wiring.returns.get(f.requestId),
        );
        expect(view).toMatchObject({
          status: 'IN_TRANSIT',
          returnShipmentId: f.shipmentId,
          inTransitAt: '2026-10-16T10:00:00.000Z',
          receivedAt: null,
        });
      }
      const stranger = tenants().other;
      await expect(
        asActor({ organizationId: stranger, roles: ['PROCUREMENT_USER'] }, () =>
          wiring.returns.get(f.requestId),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const listed = await asActor({ organizationId: stranger }, () =>
        wiring.returns.list({ role: 'SUPPLIER', limit: 100, status: 'IN_TRANSIT' }),
      );
      expect(listed.items.map((item) => item.id)).not.toContain(f.requestId);
    });
  });

  describe('duplicates and order', () => {
    it('applies a redelivered event once: one history row, one event, one marker', async () => {
      const f = await authorizedReturn();
      const dispatched = event(f, 'DISPATCHED');
      await expect(deliver(dispatched)).resolves.toBeUndefined();
      await expect(deliver(dispatched)).resolves.toBe('SKIPPED');
      expect((await stored(f)).version).toBe(3);
      expect((await history(f)).filter((h) => h.toStatus === 'IN_TRANSIT')).toHaveLength(1);
      expect((await published(f)).filter((e) => e.eventName === 'RETURN_IN_TRANSIT')).toHaveLength(
        1,
      );
    });

    it('two identical deliveries at once: one applies, the other finds it done', async () => {
      const f = await authorizedReturn();
      const dispatched = event(f, 'DISPATCHED');
      const outcomes = await Promise.all([deliver(dispatched), deliver(dispatched)]);
      expect([...outcomes].sort()).toEqual(['SKIPPED', undefined].sort());
      expect((await published(f)).filter((e) => e.eventName === 'RETURN_IN_TRANSIT')).toHaveLength(
        1,
      );
    });

    it('ignores a stale step under another event id, and marks nothing', async () => {
      const f = await authorizedReturn();
      await deliver(event(f, 'DISPATCHED'));
      await deliver(event(f, 'RECEIVED'));
      const late = event(f, 'DISPATCHED');
      await expect(deliver(late)).resolves.toBe('SKIPPED');
      expect(await marked(late.eventId)).toBe(false);
      expect((await stored(f)).status).toBe('RECEIVED');
      expect(await published(f)).toHaveLength(4);
    });

    it('never applies a step before the one it follows; applies it once replayed after it', async () => {
      const f = await authorizedReturn();
      const received = event(f, 'RECEIVED');
      await expect(deliver(received)).rejects.toBeInstanceOf(ReturnStepAheadError);
      expect(await marked(received.eventId)).toBe(false);
      expect((await stored(f)).status).toBe('AUTHORIZED');
      expect(await published(f)).toHaveLength(2);

      // Its predecessor arrives; the replayed event (same id) now applies.
      await deliver(event(f, 'DISPATCHED'));
      await expect(deliver(received)).resolves.toBeUndefined();
      expect((await stored(f)).status).toBe('RECEIVED');
    });

    it('refuses a marker for a step that was never applied, and rolls back', async () => {
      const f = await authorizedReturn();
      const dispatched = event(f, 'DISPATCHED');
      await prisma.client.processedEvent.create({
        data: { eventId: dispatched.eventId, consumerName: RETURN_MIRROR_CONSUMER },
      });
      await expect(deliver(dispatched)).rejects.toMatchObject({
        reason: DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      });
      expect((await stored(f)).status).toBe('AUTHORIZED');
    });
  });

  describe('tenant: from the event, verified against the stored request — never a cross-tenant write', () => {
    it('refuses an envelope whose tenant is not the payload’s organization', async () => {
      const f = await authorizedReturn();
      await expectRefused(
        event(f, 'DISPATCHED', {}, { tenantId: f.buyer }),
        DLQ_REASONS.SOURCE_UNCONFIRMED,
      );
      await expectRefused(
        event(f, 'DISPATCHED', {}, { tenantId: undefined }),
        DLQ_REASONS.SOURCE_UNCONFIRMED,
      );
      expect((await stored(f)).status).toBe('AUTHORIZED');
    });

    it('refuses another supplier moving this buyer’s request, consistent envelope or not', async () => {
      const f = await authorizedReturn();
      const intruder = tenants().other;
      orgs.push(intruder);
      await expectRefused(
        event(f, 'DISPATCHED', { organizationId: intruder }, { tenantId: intruder }),
        DLQ_REASONS.SOURCE_UNCONFIRMED,
      );
      expect((await stored(f)).status).toBe('AUTHORIZED');
      expect(await published(f)).toHaveLength(2);
      expect(await outboxFor(prisma, intruder)).toEqual([]);
    });

    it('refuses an event naming another buyer or another order for the request', async () => {
      const f = await authorizedReturn();
      await expectRefused(
        event(f, 'DISPATCHED', { buyerOrganizationId: tenants().other }),
        DLQ_REASONS.SOURCE_UNCONFIRMED,
      );
      await expectRefused(
        event(f, 'DISPATCHED', { orderId: `ORD_${ulid()}` }),
        DLQ_REASONS.SOURCE_UNCONFIRMED,
      );
      expect((await stored(f)).version).toBe(2);
    });

    it('a supplier cannot move another tenant pair’s request by naming it', async () => {
      const mine = await authorizedReturn();
      const theirs = await authorizedReturn();
      // Mine's supplier, consistent envelope, naming theirs' request id.
      await expectRefused(
        event(mine, 'DISPATCHED', { returnRequestId: theirs.requestId }),
        DLQ_REASONS.SOURCE_UNCONFIRMED,
      );
      expect((await stored(theirs)).status).toBe('AUTHORIZED');
    });

    it('refuses a request it does not know', async () => {
      const f = await authorizedReturn();
      await expectRefused(
        event(f, 'DISPATCHED', { returnRequestId: `RET_${ulid()}` }),
        DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      );
    });
  });

  describe('the request’s own rules', () => {
    it('refuses goods for a request not yet authorized, and applies the replay once it is', async () => {
      const f = await authorizedReturn({ authorize: false });
      const dispatched = event(f, 'DISPATCHED');
      await expectRefused(dispatched, DLQ_REASONS.BUSINESS_RULE_VIOLATION);
      await asActor({ organizationId: f.supplier, roles: ['SUPPLIER'] }, () =>
        wiring.returns.authorize(f.requestId, key('mir-auth-late')),
      );
      await expect(deliver(dispatched)).resolves.toBeUndefined();
    });

    it('refuses goods for a request the buyer cancelled (Q-133 (5))', async () => {
      const f = await authorizedReturn();
      await asActor({ organizationId: f.buyer, roles: ['PROCUREMENT_USER'] }, () =>
        wiring.returns.cancel(f.requestId, { expectedStatus: 'AUTHORIZED' }, key('mir-cancel')),
      );
      await expectRefused(event(f, 'DISPATCHED'), DLQ_REASONS.BUSINESS_RULE_VIOLATION);
      expect((await stored(f)).status).toBe('CANCELLED');
    });

    it('once goods are on the road, the buyer cannot cancel and the units are not returnable again', async () => {
      const f = await authorizedReturn({ quantity: 2 });
      await deliver(event(f, 'DISPATCHED'));
      await expect(
        asActor({ organizationId: f.buyer, roles: ['PROCUREMENT_USER'] }, () =>
          wiring.returns.cancel(
            f.requestId,
            { expectedStatus: 'AUTHORIZED' },
            key('mir-cancel-late'),
          ),
        ),
        // Seen AUTHORIZED, now IN_TRANSIT: a stale command, 409 (Codex r2 on #339, finding 2).
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      await expect(
        asActor({ organizationId: f.buyer, roles: ['PROCUREMENT_USER'] }, () =>
          wiring.returns.request(
            f.orderId,
            {
              reason: 'همان قطعه دوباره برگردانده می‌شود',
              lines: [{ orderLineId: f.lineId, quantity: 1 }],
            },
            key('mir-again'),
          ),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('refuses a second shipment for a request, and one shipment for two requests', async () => {
      const f = await authorizedReturn();
      await deliver(event(f, 'DISPATCHED'));
      await expectRefused(
        event({ ...f, shipmentId: `RSP_${ulid()}` }, 'RECEIVED'),
        DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      );

      const sibling = await authorizedReturn({ parties: { buyer: f.buyer, supplier: f.supplier } });
      await expectRefused(
        event({ ...sibling, shipmentId: f.shipmentId }, 'DISPATCHED'),
        DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      );
      expect((await stored(sibling)).status).toBe('AUTHORIZED');
    });

    it('refuses a shipment of fewer units by default, and takes it when configured (Q-133 (8))', async () => {
      const f = await authorizedReturn();
      const partial = event(f, 'DISPATCHED', {
        lines: [{ orderLineId: f.lineId, productId: f.productId, expectedQuantity: 1 }],
      });
      await expectRefused(partial, DLQ_REASONS.BUSINESS_RULE_VIOLATION);
      await expect(
        deliver(partial, mirrorWith({ partialDispatchAllowed: true })),
      ).resolves.toBeUndefined();
      expect((await stored(f)).status).toBe('IN_TRANSIT');
    });

    it('refuses lines the request does not return', async () => {
      const f = await authorizedReturn();
      await expectRefused(
        event(f, 'DISPATCHED', {
          lines: [{ orderLineId: `OLN_${ulid()}`, productId: f.productId, expectedQuantity: 2 }],
        }),
        DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      );
    });
  });

  describe('the database keeps the lifecycle, whatever a write path forgets', () => {
    async function rawUpdate(sql: string, ...values: unknown[]) {
      return runUnscoped('the suite tries a write the code never makes', () =>
        prisma.client.$executeRawUnsafe(sql, ...values),
      );
    }

    it('refuses skipping a step, and a step without its shipment', async () => {
      const f = await authorizedReturn();
      await expect(
        rawUpdate(
          `UPDATE return_request SET status='RECEIVED', version=3, return_shipment_id=$2,
             in_transit_at=now(), received_at=now() WHERE id=$1`,
          f.requestId,
          f.shipmentId,
        ),
      ).rejects.toThrow(
        /ck_return_request_transition|ck_return_request_status_coherent|ck_return_request_version/,
      );
      await expect(
        rawUpdate(
          `UPDATE return_request SET status='IN_TRANSIT', version=3, in_transit_at=now() WHERE id=$1`,
          f.requestId,
        ),
      ).rejects.toThrow(/ck_return_request_status_coherent/);
    });

    it('refuses changing the shipment or a step’s instant once recorded', async () => {
      const f = await authorizedReturn();
      await deliver(event(f, 'DISPATCHED'));
      await expect(
        rawUpdate(
          `UPDATE return_request SET return_shipment_id=$2 WHERE id=$1`,
          f.requestId,
          `RSP_${ulid()}`,
        ),
      ).rejects.toThrow(/ck_return_request_terms_immutable/);
      await expect(
        rawUpdate(`UPDATE return_request SET in_transit_at=now() WHERE id=$1`, f.requestId),
      ).rejects.toThrow(/ck_return_request_terms_immutable/);
    });
  });
});

// ---------------------------------------------------------------------------
// Over a real broker: the dead-letter topic
// ---------------------------------------------------------------------------

const brokerList = brokers();
const describeWithKafka = brokerList ? describe : describe.skip;
if (!brokerList) {
  console.warn('[return-mirror] KAFKA_BROKERS is not set — skipping the broker tests');
}

describeWithKafka('return mirror over Kafka', () => {
  const INVENTORY_TOPIC = RETURN_MIRROR_CONSUMED_TOPICS[0];
  const groupId = `marketplace-service.itest-mirror-${ulid().slice(-12)}`;

  let prisma: PrismaService;
  let wiring: Wiring;
  let consumer: ReturnMirrorConsumer;
  let producer: Producer;
  let dlqReader: Consumer;
  const orgs: string[] = [];
  const deadLetters: { reason?: string; originalTopic?: string; body: string }[] = [];

  async function publish(source: EventEnvelope): Promise<void> {
    await producer.send({
      topic: INVENTORY_TOPIC,
      messages: [{ key: source.aggregateId, value: JSON.stringify(source) }],
    });
  }

  function deadLetterFor(eventId: string) {
    return waitFor(
      `${eventId} on ${MARKETPLACE_DEAD_LETTER_TOPIC}`,
      async () => deadLetters.find((message) => message.body.includes(eventId)),
      90_000,
    );
  }

  /** A request in the database for the broker tests: an AUTHORIZED one, made directly. */
  async function authorized(): Promise<Fixture> {
    const parties = tenants();
    orgs.push(parties.buyer, parties.supplier);
    const { offerId } = await publishOffer(wiring, parties.supplier);
    const order = await asActor(
      { organizationId: parties.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-B' },
      () => wiring.orders.place({ lines: [{ offerId, quantity: 2 }] }, key('mirk-ord')),
    );
    await runUnscoped('the suite completes the order the saga would', () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE "order" SET status='COMPLETED', economic_transaction_id=$2, economic_settlement_id=$3,
             receipt_confirmed_at=now() - interval '1 day', receipt_confirmed_by='USR-B',
             completed_at=now() - interval '1 day' WHERE id=$1`,
        order.id,
        `TXN_MIRK_${order.id}`,
        `STL_MIRK_${order.id}`,
      ),
    );
    const line = order.lines[0]!;
    const requested = await asActor(
      { organizationId: parties.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-B' },
      () =>
        wiring.returns.request(
          order.id,
          {
            reason: 'قطعه با مشخصات سفارش مطابقت ندارد',
            lines: [{ orderLineId: line.id, quantity: 2 }],
          },
          key('mirk-ret'),
        ),
    );
    await asActor({ organizationId: parties.supplier, roles: ['SUPPLIER'], userId: 'USR-S' }, () =>
      wiring.returns.authorize(requested.id, key('mirk-auth')),
    );
    return {
      ...parties,
      orderId: order.id,
      lineId: line.id,
      productId: line.productId,
      requestId: requested.id,
      shipmentId: `RSP_${ulid()}`,
    };
  }

  function statusOf(f: Fixture) {
    return runUnscoped(
      'the suite reads the request it drove',
      async () =>
        (await prisma.client.returnRequest.findUniqueOrThrow({ where: { id: f.requestId } }))
          .status,
    );
  }

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma, { MARKETPLACE_RETURN_WINDOW_DAYS: 30 });
    // RUN-006: the producer is inventory-service, the topic's only declared writer; the
    // dead-letter reader is the development observer.
    const inventory = new Kafka({
      ...kafkaClientConfig(kafkaConnectionFor('inventory-service', 'mkt-mirror-itest')),
      logLevel: 1,
    });
    const observer = new Kafka({
      ...kafkaClientConfig(kafkaConnectionFor('itest-observer', 'mkt-mirror-itest-dlq')),
      logLevel: 1,
    });
    producer = inventory.producer({ idempotent: true, maxInFlightRequests: 1 });
    await producer.connect();

    dlqReader = observer.consumer({
      groupId: `itest-observer.mkt-mirror-dlq-${ulid().slice(-12)}`,
    });
    await dlqReader.connect();
    await dlqReader.subscribe({ topic: MARKETPLACE_DEAD_LETTER_TOPIC, fromBeginning: true });
    await dlqReader.run({
      eachMessage: async ({ message }) => {
        deadLetters.push({
          reason: message.headers?.[DLQ_HEADERS.reason]?.toString(),
          originalTopic: message.headers?.[DLQ_HEADERS.originalTopic]?.toString(),
          body: message.value?.toString('utf8') ?? '',
        });
      },
    });

    consumer = new ReturnMirrorConsumer(
      (handler) =>
        new EventConsumer(
          {
            ...kafkaConnectionFor('marketplace-service', 'mkt-mirror-itest-consumer'),
            groupId,
            topics: [...RETURN_MIRROR_CONSUMED_TOPICS],
            deadLetterTopic: MARKETPLACE_DEAD_LETTER_TOPIC,
            // Not from the beginning: a shared broker's inventory history is other runs'
            // traffic. The warm-up below waits for the join instead.
            fromBeginning: false,
            retryBackoffMs: 50,
          },
          handler,
          { log: () => undefined, warn: () => undefined, error: () => undefined },
        ),
      prisma,
      new ReturnRepository(prisma),
      wiring.events,
      STRICT,
      silent,
    );
    await consumer.start();

    // A fresh group reads only what is published after it has joined: a warm-up step is
    // published until it lands (re-publishing is harmless — a duplicate is a no-op).
    const warmUp = await authorized();
    const warmUpEvent = event(warmUp, 'DISPATCHED');
    await waitFor(
      'the consumer to join and mirror a warm-up step',
      async () => {
        await publish(warmUpEvent);
        return (await statusOf(warmUp)) === 'IN_TRANSIT' || undefined;
      },
      120_000,
      1_000,
    );
  }, 180_000);

  afterAll(async () => {
    await consumer?.stop();
    await dlqReader?.disconnect();
    await producer?.disconnect();
    await cleanup(prisma, orgs);
    await prisma?.onModuleDestroy();
  }, 60_000);

  it('mirrors a step inventory published', async () => {
    const f = await authorized();
    await publish(event(f, 'DISPATCHED'));
    await waitFor(
      'the request in transit',
      async () => (await statusOf(f)) === 'IN_TRANSIT' || undefined,
      90_000,
    );
  }, 120_000);

  it('dead-letters a step in another supplier’s name: SOURCE_UNCONFIRMED, nothing written', async () => {
    const f = await authorized();
    const intruder = tenants().other;
    const forged = event(f, 'DISPATCHED', { organizationId: intruder }, { tenantId: intruder });
    await publish(forged);
    const dead = await deadLetterFor(forged.eventId);
    expect(dead.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
    expect(dead.originalTopic).toBe(INVENTORY_TOPIC);
    expect(await statusOf(f)).toBe('AUTHORIZED');
  }, 120_000);

  it('dead-letters a step in another service’s name: PRODUCER_NOT_ALLOWED (ADR-061 § 2)', async () => {
    const f = await authorized();
    const forged = event(f, 'DISPATCHED', {}, { producer: 'marketplace-service' });
    await publish(forged);
    const dead = await deadLetterFor(forged.eventId);
    expect(dead.reason).toBe(DLQ_REASONS.PRODUCER_NOT_ALLOWED);
    expect(await statusOf(f)).toBe('AUTHORIZED');
  }, 120_000);

  it('dead-letters a step that stays ahead of its predecessor, for replay: MAX_RETRIES_EXCEEDED', async () => {
    const f = await authorized();
    const early = event(f, 'RECEIVED');
    await publish(early);
    const dead = await deadLetterFor(early.eventId);
    expect(dead.reason).toBe(DLQ_REASONS.MAX_RETRIES_EXCEEDED);
    expect(await statusOf(f)).toBe('AUTHORIZED');
  }, 120_000);
});
