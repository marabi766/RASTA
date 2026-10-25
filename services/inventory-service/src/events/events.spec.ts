import { INVENTORY_EVENTS, INVENTORY_EVENT_SCHEMAS, validateInventoryPayload } from './events';
import { AGGREGATE_OF, PARTITION_KEY_POLICY, resolvePartitionKey } from './routing';

const ULID = '01JBQ8ZZZZZZZZZZZZZZZZZZZZ';
const at = '2026-10-13T10:00:00.000Z';
const stock = {
  stockItemId: `SKI_${ULID}`,
  warehouseId: `WHS_${ULID}`,
  productId: `PRD_${ULID}`,
  organizationId: 'ORG_1',
  movementId: `SMV_${ULID}`,
  itemVersion: 3,
  onHandAfter: 10,
  reservedAfter: 2,
};
const reservation = {
  reservationId: `SRV_${ULID}`,
  holderOrganizationId: 'ORG_1',
  orderReference: null,
  quantity: 2,
};
const shipment = {
  shipmentId: `SHP_${ULID}`,
  organizationId: 'ORG_1',
  originWarehouseId: `WHS_${ULID}`,
  consigneeOrganizationId: `ORG_${ULID}`,
  orderReference: `ORD_${ULID}`,
  trackingEventId: `TRK_${ULID}`,
};

const returnShipment = {
  returnShipmentId: `RSP_${ULID}`,
  organizationId: 'ORG_1',
  returnRequestId: `RET_${ULID}`,
  orderId: `ORD_${ULID}`,
  buyerOrganizationId: `ORG_${ULID}`,
  destinationWarehouseId: `WHS_${ULID}`,
  trackingEventId: `RTK_${ULID}`,
};
const returnLine = { orderLineId: 'OLN_1', productId: `PRD_${ULID}`, expectedQuantity: 3 };

const VALID = {
  WAREHOUSE_CREATED: {
    warehouseId: `WHS_${ULID}`,
    organizationId: 'ORG_1',
    createdBy: 'USR_1',
    createdAt: at,
  },
  STOCK_RECEIVED: {
    ...stock,
    quantity: 4,
    sourceReference: null,
    receivedBy: 'USR_1',
    receivedAt: at,
  },
  STOCK_ADJUSTED: {
    ...stock,
    quantityDelta: -1,
    sourceReference: `ADJ_${ULID}`,
    adjustedBy: 'USR_1',
    adjustedAt: at,
  },
  STOCK_RESERVED: {
    ...stock,
    ...reservation,
    expiresAt: null,
    reservedBy: 'USR_1',
    reservedAt: at,
  },
  STOCK_RELEASED: {
    ...stock,
    ...reservation,
    reason: 'EXPIRED',
    releasedBy: null,
    releasedAt: at,
  },
  STOCK_ISSUED: { ...stock, ...reservation, issuedBy: 'USR_1', issuedAt: at },
  SHIPMENT_CREATED: {
    ...shipment,
    shipmentVersion: 1,
    legCount: 2,
    createdBy: 'USR_1',
    createdAt: at,
  },
  SHIPMENT_DISPATCHED: { ...shipment, shipmentVersion: 2, dispatchedBy: 'USR_1', dispatchedAt: at },
  SHIPMENT_DELIVERED: { ...shipment, shipmentVersion: 3, deliveredBy: 'USR_1', deliveredAt: at },
  RETURN_SHIPMENT_DISPATCHED: {
    ...returnShipment,
    returnShipmentVersion: 1,
    lines: [returnLine],
    dispatchedBy: 'USR_1',
    dispatchedAt: at,
  },
  RETURN_SHIPMENT_RECEIVED: {
    ...returnShipment,
    returnShipmentVersion: 2,
    lines: [{ ...returnLine, receivedQuantity: 2 }],
    receivedBy: 'USR_1',
    receivedAt: at,
  },
  RETURN_SHIPMENT_INSPECTED: {
    ...returnShipment,
    returnShipmentVersion: 3,
    reportDocumentId: null,
    inspectedBy: 'USR_1',
    inspectedAt: at,
  },
  RETURN_SHIPMENT_RESOLVED: {
    ...returnShipment,
    returnShipmentVersion: 4,
    dispositions: [{ orderLineId: 'OLN_1', disposition: 'SCRAP', quantity: 2 }],
    resolvedBy: 'USR_1',
    resolvedAt: at,
  },
  RETURN_DISPATCH_WITHDRAWN: {
    withdrawalId: `RDW_${ULID}`,
    organizationId: 'ORG_1',
    returnRequestId: `RET_${ULID}`,
    reservationId: `RDR_${ULID}`,
    withdrawnBy: 'marketplace-service',
    withdrawnAt: at,
  },
} as const;

const SHIPMENT_EVENTS = ['SHIPMENT_CREATED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_DELIVERED'];

describe('the published event contracts (ADR-056 § 6)', () => {
  it('names the catalogue’s stock and shipment events, the return-shipment events, STOCK_ADJUSTED and WAREHOUSE_CREATED — no LOW_STOCK_DETECTED yet', () => {
    expect(Object.keys(INVENTORY_EVENTS).sort()).toEqual([
      'RETURN_DISPATCH_WITHDRAWN',
      'RETURN_SHIPMENT_DISPATCHED',
      'RETURN_SHIPMENT_INSPECTED',
      'RETURN_SHIPMENT_RECEIVED',
      'RETURN_SHIPMENT_RESOLVED',
      'SHIPMENT_CREATED',
      'SHIPMENT_DELIVERED',
      'SHIPMENT_DISPATCHED',
      'STOCK_ADJUSTED',
      'STOCK_ISSUED',
      'STOCK_RECEIVED',
      'STOCK_RELEASED',
      'STOCK_RESERVED',
      'WAREHOUSE_CREATED',
    ]);
  });

  it.each(Object.keys(VALID) as (keyof typeof VALID)[])('accepts a valid %s', (name) => {
    expect(validateInventoryPayload(name, VALID[name])).toEqual(VALID[name]);
  });

  it('refuses an unknown field, so nothing unpublished — a name, a note — rides along', () => {
    expect(() =>
      validateInventoryPayload('WAREHOUSE_CREATED', { ...VALID.WAREHOUSE_CREATED, name: 'x' }),
    ).toThrow(/does not match its published contract/);
  });

  it('carries the opaque productId, never a sku', () => {
    expect(() =>
      validateInventoryPayload('STOCK_RECEIVED', { ...VALID.STOCK_RECEIVED, sku: 'X' }),
    ).toThrow();
    expect(Object.keys(INVENTORY_EVENT_SCHEMAS.STOCK_RECEIVED.shape)).toContain('productId');
  });

  it('refuses a zero adjustment, a fractional quantity and a free-text reference', () => {
    expect(() =>
      validateInventoryPayload('STOCK_ADJUSTED', { ...VALID.STOCK_ADJUSTED, quantityDelta: 0 }),
    ).toThrow();
    expect(() =>
      validateInventoryPayload('STOCK_RECEIVED', { ...VALID.STOCK_RECEIVED, quantity: 1.5 }),
    ).toThrow();
    expect(() =>
      validateInventoryPayload('STOCK_RECEIVED', {
        ...VALID.STOCK_RECEIVED,
        sourceReference: 'see the email',
      }),
    ).toThrow();
  });

  it('validates shipment events against the contracts of @rasta/contracts: no carrier, no free text', () => {
    expect(() =>
      validateInventoryPayload('SHIPMENT_CREATED', {
        ...VALID.SHIPMENT_CREATED,
        carrier: 'Acme Freight',
      }),
    ).toThrow(/does not match its published contract/);
    expect(() =>
      validateInventoryPayload('SHIPMENT_DELIVERED', {
        ...VALID.SHIPMENT_DELIVERED,
        shipmentVersion: 2,
      }),
    ).toThrow();
  });
});

describe('the partition policy', () => {
  it('keys every stock event by its stock item and every shipment event by its shipment — the STRICT streams — and the warehouse by itself', () => {
    for (const name of Object.keys(VALID) as (keyof typeof VALID)[]) {
      const decision = resolvePartitionKey(name, VALID[name] as never);
      if (name === 'WAREHOUSE_CREATED') {
        expect(decision).toEqual({ scope: 'WAREHOUSE', key: `WHS_${ULID}` });
        expect(AGGREGATE_OF[name]).toBe('Warehouse');
      } else if (name === 'RETURN_DISPATCH_WITHDRAWN') {
        // No shipment exists for it: ordered by the request it fences.
        expect(decision).toEqual({ scope: 'RETURN_REQUEST', key: `RET_${ULID}` });
        expect(AGGREGATE_OF[name]).toBe('ReturnDispatchWithdrawal');
      } else if (name.startsWith('RETURN_SHIPMENT_')) {
        expect([name, decision]).toEqual([name, { scope: 'RETURN_SHIPMENT', key: `RSP_${ULID}` }]);
        expect(AGGREGATE_OF[name]).toBe('ReturnShipment');
      } else if (SHIPMENT_EVENTS.includes(name)) {
        expect([name, decision]).toEqual([name, { scope: 'SHIPMENT', key: `SHP_${ULID}` }]);
        expect(AGGREGATE_OF[name]).toBe('Shipment');
      } else {
        expect([name, decision]).toEqual([name, { scope: 'STOCK_ITEM', key: `SKI_${ULID}` }]);
        expect(AGGREGATE_OF[name]).toBe('StockItem');
      }
    }
    expect(Object.keys(PARTITION_KEY_POLICY).sort()).toEqual(Object.keys(INVENTORY_EVENTS).sort());
  });

  it('refuses an empty key rather than let Kafka round-robin the event', () => {
    expect(() =>
      resolvePartitionKey('STOCK_ISSUED', { ...VALID.STOCK_ISSUED, stockItemId: '' } as never),
    ).toThrow(/empty STOCK_ITEM partition key/);
  });
});
