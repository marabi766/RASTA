import {
  RETURN_REQUEST_EVENTS,
  RETURN_REQUEST_EVENT_SCHEMAS,
  returnAuthorizedPayloadSchema,
  returnCancelledPayloadSchema,
  returnInTransitPayloadSchema,
  returnInspectedPayloadSchema,
  returnReceivedPayloadSchema,
  returnRejectedPayloadSchema,
  returnResolvedPayloadSchema,
  returnRequestedPayloadSchema,
} from './return-requests';

const ULID = '01JBQ0000000000000000000AB';

const facts = {
  returnRequestId: `RET_${ULID}`,
  orderId: `ORD_${ULID}`,
  buyerOrganizationId: 'ORG_01JBQ0000000000000000000CD',
  supplierOrganizationId: 'ORG-SUPPLIER',
  lines: [{ orderLineId: 'OLN_1', productId: 'PRD_1', quantity: 2 }],
};

const requested = {
  ...facts,
  returnVersion: 1,
  requestedBy: 'USR_1',
  requestedAt: '2026-10-16T08:00:00.000Z',
};

describe('return request event contracts (ADR-048)', () => {
  it('names eight events, each with its schema', () => {
    expect(Object.keys(RETURN_REQUEST_EVENTS)).toEqual([
      'RETURN_REQUESTED',
      'RETURN_AUTHORIZED',
      'RETURN_REJECTED',
      'RETURN_CANCELLED',
      'RETURN_IN_TRANSIT',
      'RETURN_RECEIVED',
      'RETURN_INSPECTED',
      'RETURN_RESOLVED',
    ]);
    expect(Object.keys(RETURN_REQUEST_EVENT_SCHEMAS)).toEqual(Object.keys(RETURN_REQUEST_EVENTS));
  });

  it('accepts what marketplace-service publishes', () => {
    expect(returnRequestedPayloadSchema.parse(requested)).toEqual(requested);
    expect(
      returnAuthorizedPayloadSchema.parse({
        ...facts,
        returnVersion: 2,
        authorizedBy: 'USR_2',
        authorizedAt: '2026-10-16T09:00:00.000Z',
      }),
    ).toBeTruthy();
    expect(
      returnRejectedPayloadSchema.parse({
        ...facts,
        returnVersion: 2,
        rejectedBy: 'USR_2',
        rejectedAt: '2026-10-16T09:00:00.000Z',
      }),
    ).toBeTruthy();
  });

  it('puts each event at its place in the request’s own history', () => {
    expect(returnRequestedPayloadSchema.safeParse({ ...requested, returnVersion: 2 }).success).toBe(
      false,
    );
    const cancelled = {
      ...facts,
      cancelledBy: 'USR_1',
      cancelledAt: '2026-10-16T09:00:00.000Z',
    };
    expect(
      returnCancelledPayloadSchema.safeParse({
        ...cancelled,
        returnVersion: 2,
        cancelledFrom: 'REQUESTED',
      }).success,
    ).toBe(true);
    expect(
      returnCancelledPayloadSchema.safeParse({
        ...cancelled,
        returnVersion: 3,
        cancelledFrom: 'AUTHORIZED',
      }).success,
    ).toBe(true);
    // A cancellation from REQUESTED is the second status; from AUTHORIZED, the third.
    expect(
      returnCancelledPayloadSchema.safeParse({
        ...cancelled,
        returnVersion: 3,
        cancelledFrom: 'REQUESTED',
      }).success,
    ).toBe(false);
  });

  it('carries identifiers, quantities and instants only — no free text, no money', () => {
    expect(
      returnRequestedPayloadSchema.safeParse({ ...requested, reason: 'it broke' }).success,
    ).toBe(false);
    expect(
      returnRequestedPayloadSchema.safeParse({ ...requested, refundAmountMinor: '5' }).success,
    ).toBe(false);
    const priced = [{ ...facts.lines[0], unitPriceMinor: '5' }];
    expect(returnRequestedPayloadSchema.safeParse({ ...requested, lines: priced }).success).toBe(
      false,
    );
  });

  it('needs a request id and an order id of the platform form, and at least one line', () => {
    expect(
      returnRequestedPayloadSchema.safeParse({ ...requested, returnRequestId: 'RET_1' }).success,
    ).toBe(false);
    expect(returnRequestedPayloadSchema.safeParse({ ...requested, orderId: 'x' }).success).toBe(
      false,
    );
    expect(returnRequestedPayloadSchema.safeParse({ ...requested, lines: [] }).success).toBe(false);
  });
});

describe('the physical half, as the request states it', () => {
  const shipment = { returnShipmentId: `RSP_${ULID}` };
  const inTransit = {
    ...facts,
    ...shipment,
    returnVersion: 3,
    inTransitAt: '2026-10-16T10:00:00.000Z',
  };
  const receivedEvent = {
    ...facts,
    ...shipment,
    returnVersion: 4,
    receivedLines: [{ orderLineId: 'OLN_1', receivedQuantity: 2 }],
    receivedAt: '2026-10-16T11:00:00.000Z',
  };
  const inspectedEvent = {
    ...facts,
    ...shipment,
    returnVersion: 5,
    reportDocumentId: null,
    inspectedAt: '2026-10-16T12:00:00.000Z',
  };
  const resolvedEvent = {
    ...facts,
    ...shipment,
    returnVersion: 6,
    outcomes: [{ orderLineId: 'OLN_1', disposition: 'SCRAP', quantity: 2 }],
    resolvedAt: '2026-10-16T13:00:00.000Z',
  };

  it('continues the request’s own history: 3, 4, 5, 6', () => {
    expect(returnInTransitPayloadSchema.parse(inTransit)).toEqual(inTransit);
    expect(returnReceivedPayloadSchema.parse(receivedEvent)).toEqual(receivedEvent);
    expect(returnInspectedPayloadSchema.parse(inspectedEvent)).toEqual(inspectedEvent);
    expect(returnResolvedPayloadSchema.parse(resolvedEvent)).toEqual(resolvedEvent);
    for (const [schema, event] of [
      [returnInTransitPayloadSchema, inTransit],
      [returnReceivedPayloadSchema, receivedEvent],
      [returnInspectedPayloadSchema, inspectedEvent],
      [returnResolvedPayloadSchema, resolvedEvent],
    ] as const) {
      expect(schema.safeParse({ ...event, returnVersion: event.returnVersion + 1 }).success).toBe(
        false,
      );
    }
  });

  it('links to the return shipment by id, and refuses a missing or foreign one', () => {
    expect(
      returnInTransitPayloadSchema.safeParse({ ...inTransit, returnShipmentId: undefined }).success,
    ).toBe(false);
    expect(
      returnInTransitPayloadSchema.safeParse({ ...inTransit, returnShipmentId: `SHP_${ULID}` })
        .success,
    ).toBe(false);
  });

  it('resolves with no outcome only as inventory does: nothing arrived (Q-133 (4))', () => {
    // RETURN_SHIPMENT_RESOLVED may carry `dispositions: []` for that one case (Codex r1 on #313);
    // a mirror that refused it would leave the request INSPECTED for ever.
    const nothing = { ...resolvedEvent, outcomes: [] };
    expect(returnResolvedPayloadSchema.parse(nothing)).toEqual(nothing);
  });

  it('names an order line once per received row, and once per line and outcome', () => {
    const line = { orderLineId: 'OLN_1', receivedQuantity: 1 };
    expect(
      returnReceivedPayloadSchema.safeParse({ ...receivedEvent, receivedLines: [line, line] })
        .success,
    ).toBe(false);
    const row = { orderLineId: 'OLN_1', disposition: 'SCRAP', quantity: 1 };
    expect(
      returnResolvedPayloadSchema.safeParse({ ...resolvedEvent, outcomes: [row, row] }).success,
    ).toBe(false);
    expect(
      returnResolvedPayloadSchema.safeParse({
        ...resolvedEvent,
        outcomes: [row, { ...row, disposition: 'RECYCLE' }],
      }).success,
    ).toBe(true);
  });

  it('carries no refund, amount or free text, and only the six outcomes', () => {
    expect(
      returnResolvedPayloadSchema.safeParse({ ...resolvedEvent, refundAmountMinor: '1' }).success,
    ).toBe(false);
    const outcomes = [{ orderLineId: 'OLN_1', disposition: 'REFUND', quantity: 1 }];
    expect(returnResolvedPayloadSchema.safeParse({ ...resolvedEvent, outcomes }).success).toBe(
      false,
    );
    expect(returnInspectedPayloadSchema.safeParse({ ...inspectedEvent, note: 'x' }).success).toBe(
      false,
    );
  });
});
