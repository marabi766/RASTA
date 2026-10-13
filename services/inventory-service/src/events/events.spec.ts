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
} as const;

describe('the published event contracts (ADR-056 § 6)', () => {
  it('names the catalogue’s stock events, STOCK_ADJUSTED and WAREHOUSE_CREATED — no shipment and no LOW_STOCK_DETECTED yet', () => {
    expect(Object.keys(INVENTORY_EVENTS).sort()).toEqual([
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
});

describe('the partition policy', () => {
  it('keys every stock event by its stock item — the STRICT stream — and the warehouse by itself', () => {
    for (const name of Object.keys(VALID) as (keyof typeof VALID)[]) {
      const decision = resolvePartitionKey(name, VALID[name] as never);
      if (name === 'WAREHOUSE_CREATED') {
        expect(decision).toEqual({ scope: 'WAREHOUSE', key: `WHS_${ULID}` });
        expect(AGGREGATE_OF[name]).toBe('Warehouse');
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
