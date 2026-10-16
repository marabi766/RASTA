import {
  INVENTORY_RETURN_EVENTS,
  INVENTORY_RETURN_EVENT_SCHEMAS,
  returnShipmentDispatchedPayloadSchema,
  returnShipmentReceivedPayloadSchema,
} from './inventory-returns';

const ULID = '01JBQ0000000000000000000AB';

const facts = {
  returnShipmentId: `RSP_${ULID}`,
  organizationId: `ORG_${ULID}`,
  returnRequestId: `RET_${ULID}`,
  orderId: `ORD_${ULID}`,
  buyerOrganizationId: 'ORG_01JBQ0000000000000000000CD',
  destinationWarehouseId: `WHS_${ULID}`,
  trackingEventId: `RTK_${ULID}`,
};

const dispatched = {
  ...facts,
  returnShipmentVersion: 1,
  lines: [{ orderLineId: 'OLN_1', productId: 'PRD_1', expectedQuantity: 3 }],
  dispatchedBy: 'USR-1',
  dispatchedAt: '2026-10-16T08:00:00.000Z',
};

const received = {
  ...facts,
  returnShipmentVersion: 2,
  lines: [{ orderLineId: 'OLN_1', productId: 'PRD_1', expectedQuantity: 3, receivedQuantity: 2 }],
  receivedBy: 'USR-1',
  receivedAt: '2026-10-16T09:00:00.000Z',
};

describe('inventory return-shipment event contracts', () => {
  it('names its events, each with a schema', () => {
    expect(Object.keys(INVENTORY_RETURN_EVENT_SCHEMAS)).toEqual(
      Object.keys(INVENTORY_RETURN_EVENTS),
    );
  });

  it('accepts what inventory-service publishes', () => {
    expect(returnShipmentDispatchedPayloadSchema.parse(dispatched)).toEqual(dispatched);
    expect(returnShipmentReceivedPayloadSchema.parse(received)).toEqual(received);
  });

  it('accepts a line that arrived short, or not at all', () => {
    for (const receivedQuantity of [0, 3]) {
      const lines = [{ ...received.lines[0], receivedQuantity }];
      expect(returnShipmentReceivedPayloadSchema.safeParse({ ...received, lines }).success).toBe(
        true,
      );
    }
  });

  it('refuses more received than expected', () => {
    const lines = [{ ...received.lines[0], receivedQuantity: 4 }];
    expect(returnShipmentReceivedPayloadSchema.safeParse({ ...received, lines }).success).toBe(
      false,
    );
  });

  it('refuses a version that is not the status’s place in the history', () => {
    expect(
      returnShipmentDispatchedPayloadSchema.safeParse({ ...dispatched, returnShipmentVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      returnShipmentReceivedPayloadSchema.safeParse({ ...received, returnShipmentVersion: 1 })
        .success,
    ).toBe(false);
  });

  it('refuses a line twice, no lines, and any field it does not name (no carrier, no note, no price)', () => {
    const twice = [dispatched.lines[0], dispatched.lines[0]];
    expect(
      returnShipmentDispatchedPayloadSchema.safeParse({ ...dispatched, lines: twice }).success,
    ).toBe(false);
    expect(
      returnShipmentDispatchedPayloadSchema.safeParse({ ...dispatched, lines: [] }).success,
    ).toBe(false);
    for (const extra of [{ carrierName: 'x' }, { note: 'x' }, { unitPriceMinor: '1' }]) {
      expect(
        returnShipmentDispatchedPayloadSchema.safeParse({ ...dispatched, ...extra }).success,
      ).toBe(false);
    }
  });

  it('refuses identifiers of the wrong kind', () => {
    expect(
      returnShipmentDispatchedPayloadSchema.safeParse({
        ...dispatched,
        returnRequestId: `ORD_${ULID}`,
      }).success,
    ).toBe(false);
    expect(
      returnShipmentDispatchedPayloadSchema.safeParse({
        ...dispatched,
        returnShipmentId: `SHP_${ULID}`,
      }).success,
    ).toBe(false);
  });
});
