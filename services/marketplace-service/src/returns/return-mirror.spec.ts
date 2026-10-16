import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError } from '@rasta/nest-common';
import { decideMirror, mirrorStepOf, type MirroredRequest, type MirrorStep } from './return-mirror';
import {
  RETURN_MIRROR_DISABLED,
  ReturnMirrorConsumer,
  returnMirrorConsumerFactory,
} from './return-mirror.consumer';

/**
 * The return mirror's pure half (RUN-005 PR 3): what an inventory return event is, and whether it
 * may move the request it names. The database half — locks, markers, the trigger — is
 * `test/return-mirror.int-spec.ts`.
 */

const ULID = '01JBQ0000000000000000000AB';
const SUPPLIER = 'ORG-SUP';
const BUYER = 'ORG-BUY';
const SHIPMENT = `RSP_${ULID}`;
const REQUEST = `RET_${ULID}`;
const ORDER = `ORD_${ULID}`;

const facts = {
  returnShipmentId: SHIPMENT,
  organizationId: SUPPLIER,
  returnRequestId: REQUEST,
  orderId: ORDER,
  buyerOrganizationId: BUYER,
  destinationWarehouseId: `WHS_${ULID}`,
  trackingEventId: `RTK_${ULID}`,
};
const line = { orderLineId: 'OLN_1', productId: 'PRD_1', expectedQuantity: 2 };

const PAYLOADS = {
  RETURN_SHIPMENT_DISPATCHED: {
    ...facts,
    returnShipmentVersion: 1,
    lines: [line],
    dispatchedBy: 'USR-W',
    dispatchedAt: '2026-10-16T10:00:00.000Z',
  },
  RETURN_SHIPMENT_RECEIVED: {
    ...facts,
    returnShipmentVersion: 2,
    lines: [{ ...line, receivedQuantity: 1 }],
    receivedBy: 'USR-W',
    receivedAt: '2026-10-16T11:00:00.000Z',
  },
  RETURN_SHIPMENT_INSPECTED: {
    ...facts,
    returnShipmentVersion: 3,
    reportDocumentId: null,
    inspectedBy: 'USR-W',
    inspectedAt: '2026-10-16T12:00:00.000Z',
  },
  RETURN_SHIPMENT_RESOLVED: {
    ...facts,
    returnShipmentVersion: 4,
    dispositions: [{ orderLineId: 'OLN_1', disposition: 'SCRAP', quantity: 1 }],
    resolvedBy: 'USR-W',
    resolvedAt: '2026-10-16T13:00:00.000Z',
  },
} as const;
type Name = keyof typeof PAYLOADS;

function envelope(
  eventName: Name | string,
  payload: Record<string, unknown> = {},
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  const base = (PAYLOADS as Record<string, Record<string, unknown>>)[eventName] ?? {};
  return {
    eventId: `EVT_${eventName}`,
    eventName,
    eventVersion: 1,
    occurredAt: '2026-10-16T10:00:00.000Z',
    producer: 'inventory-service',
    producerVersion: '1.0.0',
    aggregateType: 'ReturnShipment',
    aggregateId: SHIPMENT,
    tenantId: SUPPLIER,
    correlationId: 'COR-1',
    payload: { ...base, ...payload },
    ...overrides,
  };
}

function request(overrides: Partial<MirroredRequest> = {}): MirroredRequest {
  return {
    id: REQUEST,
    organizationId: BUYER,
    supplierOrganizationId: SUPPLIER,
    orderId: ORDER,
    status: 'AUTHORIZED',
    version: 2,
    returnShipmentId: null,
    lines: [{ orderLineId: 'OLN_1', productId: 'PRD_1', quantity: 2 }],
    ...overrides,
  };
}

const STRICT = { partialDispatchAllowed: false };

function refusal(fn: () => unknown): UnprocessableEventError {
  try {
    fn();
  } catch (error) {
    if (error instanceof UnprocessableEventError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function step(name: Name, payload: Record<string, unknown> = {}): [EventEnvelope, MirrorStep] {
  const source = envelope(name, payload);
  return [source, mirrorStepOf(source)!];
}

describe('mirrorStepOf — what an inventory event is to the mirror', () => {
  it('maps each return shipment event to its step and the status it reaches', () => {
    expect(
      (Object.keys(PAYLOADS) as Name[]).map((name) => {
        const found = mirrorStepOf(envelope(name))!;
        return [found.eventName, found.seq, found.to];
      }),
    ).toEqual([
      ['RETURN_SHIPMENT_DISPATCHED', 1, 'IN_TRANSIT'],
      ['RETURN_SHIPMENT_RECEIVED', 2, 'RECEIVED'],
      ['RETURN_SHIPMENT_INSPECTED', 3, 'INSPECTED'],
      ['RETURN_SHIPMENT_RESOLVED', 4, 'RESOLVED'],
    ]);
  });

  it('skips every other event on the topic, without reading it', () => {
    expect(mirrorStepOf(envelope('STOCK_RESERVED', { anything: true }))).toBeNull();
    expect(mirrorStepOf(envelope('SHIPMENT_DISPATCHED'))).toBeNull();
    expect(mirrorStepOf(envelope('toString'))).toBeNull();
  });

  it('refuses a version it does not read', () => {
    const error = refusal(() =>
      mirrorStepOf(envelope('RETURN_SHIPMENT_DISPATCHED', {}, { eventVersion: 2 })),
    );
    expect(error.reason).toBe(DLQ_REASONS.SCHEMA_VERSION_UNSUPPORTED);
  });

  it('refuses a payload its contract refuses, naming the field and never its value', () => {
    const error = refusal(() =>
      mirrorStepOf(envelope('RETURN_SHIPMENT_DISPATCHED', { dispatchedBy: '', note: 'secret' })),
    );
    expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(error.message).toMatch(/dispatchedBy/);
    expect(error.message).not.toMatch(/secret/);
  });

  it('accepts a resolution with no disposition: nothing arrived (Q-133 (4))', () => {
    expect(mirrorStepOf(envelope('RETURN_SHIPMENT_RESOLVED', { dispositions: [] }))?.seq).toBe(4);
  });

  it('refuses an envelope whose tenant is not the payload organization (ADR-061 § 5)', () => {
    for (const tenantId of [undefined, BUYER, 'ORG-ELSE']) {
      const error = refusal(() =>
        mirrorStepOf(envelope('RETURN_SHIPMENT_DISPATCHED', {}, { tenantId })),
      );
      expect(error.reason).toBe(DLQ_REASONS.SOURCE_UNCONFIRMED);
    }
  });

  it('refuses a stream position that is not the payload’s', () => {
    expect(mirrorStepOf(envelope('RETURN_SHIPMENT_RECEIVED', {}, { streamSeq: 2 }))?.seq).toBe(2);
    const error = refusal(() =>
      mirrorStepOf(envelope('RETURN_SHIPMENT_RECEIVED', {}, { streamSeq: 3 })),
    );
    expect(error.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
  });
});

describe('decideMirror — whether a step may move the request it names', () => {
  it('applies the next step, and only the next', () => {
    const [dispatched, first] = step('RETURN_SHIPMENT_DISPATCHED');
    expect(decideMirror(dispatched, first, request(), STRICT)).toBe('APPLY');

    const [received, second] = step('RETURN_SHIPMENT_RECEIVED');
    const inTransit = request({ status: 'IN_TRANSIT', version: 3, returnShipmentId: SHIPMENT });
    expect(decideMirror(received, second, inTransit, STRICT)).toBe('APPLY');

    const [resolved, fourth] = step('RETURN_SHIPMENT_RESOLVED');
    const inspected = request({ status: 'INSPECTED', version: 5, returnShipmentId: SHIPMENT });
    expect(decideMirror(resolved, fourth, inspected, STRICT)).toBe('APPLY');
  });

  it('calls a step at or below the one reached stale, and one beyond the next ahead', () => {
    const received = request({ status: 'RECEIVED', version: 4, returnShipmentId: SHIPMENT });
    const [d, dispatched] = step('RETURN_SHIPMENT_DISPATCHED');
    const [r, again] = step('RETURN_SHIPMENT_RECEIVED');
    const [x, resolved] = step('RETURN_SHIPMENT_RESOLVED');
    expect(decideMirror(d, dispatched, received, STRICT)).toBe('STALE');
    expect(decideMirror(r, again, received, STRICT)).toBe('STALE');
    expect(decideMirror(x, resolved, received, STRICT)).toBe('AHEAD');

    const [r2, early] = step('RETURN_SHIPMENT_RECEIVED');
    expect(decideMirror(r2, early, request(), STRICT)).toBe('AHEAD');
    const done = request({ status: 'RESOLVED', version: 6, returnShipmentId: SHIPMENT });
    expect(decideMirror(x, resolved, done, STRICT)).toBe('STALE');
  });

  it('refuses a request it does not know', () => {
    const [source, first] = step('RETURN_SHIPMENT_DISPATCHED');
    const error = refusal(() => decideMirror(source, first, null, STRICT));
    expect(error.reason).toBe(DLQ_REASONS.BUSINESS_RULE_VIOLATION);
  });

  it('refuses, before telling anything apart, a request of other organizations or order', () => {
    const [source, first] = step('RETURN_SHIPMENT_DISPATCHED');
    for (const other of [
      request({ supplierOrganizationId: 'ORG-OTHER-SUPPLIER' }),
      request({ organizationId: 'ORG-OTHER-BUYER' }),
      request({ orderId: `ORD_${'1'.repeat(26)}` }),
      // Even a request that is over: the parties are compared first.
      request({ supplierOrganizationId: 'ORG-OTHER-SUPPLIER', status: 'CANCELLED', version: 3 }),
    ]) {
      expect(refusal(() => decideMirror(source, first, other, STRICT)).reason).toBe(
        DLQ_REASONS.SOURCE_UNCONFIRMED,
      );
    }
  });

  it('refuses goods for a request not authorized, or withdrawn, or refused (Q-133 (5))', () => {
    const [source, first] = step('RETURN_SHIPMENT_DISPATCHED');
    for (const [status, version] of [
      ['REQUESTED', 1],
      ['REJECTED', 2],
      ['CANCELLED', 3],
    ] as const) {
      const error = refusal(() =>
        decideMirror(source, first, request({ status, version }), STRICT),
      );
      expect(error.reason).toBe(DLQ_REASONS.BUSINESS_RULE_VIOLATION);
      expect(error.message).toMatch(new RegExp(status));
    }
  });

  it('refuses a second shipment for a request — even a stale step of it', () => {
    const elsewhere = request({
      status: 'IN_TRANSIT',
      version: 3,
      returnShipmentId: `RSP_${'2'.repeat(26)}`,
    });
    for (const name of ['RETURN_SHIPMENT_DISPATCHED', 'RETURN_SHIPMENT_RECEIVED'] as const) {
      const [source, found] = step(name);
      expect(refusal(() => decideMirror(source, found, elsewhere, STRICT)).reason).toBe(
        DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      );
    }
  });

  describe('the lines are the request’s', () => {
    it('refuses a line the request does not return, or another product', () => {
      for (const lines of [
        [{ ...line, orderLineId: 'OLN_9' }],
        [{ ...line, productId: 'PRD_9' }],
      ]) {
        const [source, first] = step('RETURN_SHIPMENT_DISPATCHED', { lines });
        expect(refusal(() => decideMirror(source, first, request(), STRICT)).message).toMatch(
          /is not returned by/,
        );
      }
    });

    it('refuses more than was authorized, whatever the configuration', () => {
      const [source, first] = step('RETURN_SHIPMENT_DISPATCHED', {
        lines: [{ ...line, expectedQuantity: 3 }],
      });
      for (const rules of [STRICT, { partialDispatchAllowed: true }]) {
        expect(refusal(() => decideMirror(source, first, request(), rules)).message).toMatch(
          /exceeds/,
        );
      }
    });

    it('by default, refuses a shipment of fewer units or fewer lines than authorized (Q-133 (8))', () => {
      const two = request({
        lines: [
          { orderLineId: 'OLN_1', productId: 'PRD_1', quantity: 2 },
          { orderLineId: 'OLN_2', productId: 'PRD_2', quantity: 1 },
        ],
      });
      const [fewerUnits, a] = step('RETURN_SHIPMENT_DISPATCHED', {
        lines: [
          { ...line, expectedQuantity: 1 },
          { orderLineId: 'OLN_2', productId: 'PRD_2', expectedQuantity: 1 },
        ],
      });
      const [fewerLines, b] = step('RETURN_SHIPMENT_DISPATCHED', { lines: [line] });
      expect(refusal(() => decideMirror(fewerUnits, a, two, STRICT)).message).toMatch(
        /Q-133 \(8\)/,
      );
      expect(refusal(() => decideMirror(fewerLines, b, two, STRICT)).message).toMatch(
        /Q-133 \(8\)/,
      );

      const partial = { partialDispatchAllowed: true };
      expect(decideMirror(fewerUnits, a, two, partial)).toBe('APPLY');
      expect(decideMirror(fewerLines, b, two, partial)).toBe('APPLY');
    });

    it('refuses a receipt or a resolution about a line the request does not return', () => {
      const inTransit = request({ status: 'IN_TRANSIT', version: 3, returnShipmentId: SHIPMENT });
      const [received, r] = step('RETURN_SHIPMENT_RECEIVED', {
        lines: [{ ...line, orderLineId: 'OLN_9', receivedQuantity: 1 }],
      });
      expect(refusal(() => decideMirror(received, r, inTransit, STRICT)).reason).toBe(
        DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      );

      const inspected = request({ status: 'INSPECTED', version: 5, returnShipmentId: SHIPMENT });
      const [foreign, f] = step('RETURN_SHIPMENT_RESOLVED', {
        dispositions: [{ orderLineId: 'OLN_9', disposition: 'SCRAP', quantity: 1 }],
      });
      expect(refusal(() => decideMirror(foreign, f, inspected, STRICT)).message).toMatch(
        /is not returned by/,
      );
      const [tooMany, t] = step('RETURN_SHIPMENT_RESOLVED', {
        dispositions: [
          { orderLineId: 'OLN_1', disposition: 'SCRAP', quantity: 2 },
          { orderLineId: 'OLN_1', disposition: 'RECYCLE', quantity: 1 },
        ],
      });
      expect(refusal(() => decideMirror(tooMany, t, inspected, STRICT)).message).toMatch(/exceeds/);

      const [nothing, n] = step('RETURN_SHIPMENT_RESOLVED', { dispositions: [] });
      expect(decideMirror(nothing, n, inspected, STRICT)).toBe('APPLY');
    });
  });
});

describe('ReturnMirrorConsumer without a database', () => {
  const silent = () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn() });
  const untouchable = new Proxy(
    {},
    {
      get: () => {
        throw new Error('the database must not be touched');
      },
    },
  );

  it('does not subscribe unless enabled, and says so', async () => {
    expect(
      returnMirrorConsumerFactory({ MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED: false }, jest.fn()),
    ).toBeNull();
    const logger = silent();
    const consumer = new ReturnMirrorConsumer(
      null,
      untouchable as never,
      untouchable as never,
      untouchable as never,
      STRICT,
      logger,
    );
    await consumer.start();
    await consumer.stop();
    expect(logger.warn).toHaveBeenCalledWith(RETURN_MIRROR_DISABLED);
  });

  it('skips another event, and refuses a forged tenant, before any transaction', async () => {
    const consumer = new ReturnMirrorConsumer(
      null,
      untouchable as never,
      untouchable as never,
      untouchable as never,
      STRICT,
      silent(),
    );
    await expect(consumer.handle(envelope('STOCK_RESERVED'))).resolves.toBe('SKIPPED');
    await expect(
      consumer.handle(envelope('RETURN_SHIPMENT_DISPATCHED', {}, { tenantId: BUYER })),
    ).rejects.toMatchObject({ reason: DLQ_REASONS.SOURCE_UNCONFIRMED });
  });
});
