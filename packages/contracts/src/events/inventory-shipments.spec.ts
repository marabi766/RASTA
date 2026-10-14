import {
  INVENTORY_SHIPMENT_EVENTS,
  INVENTORY_SHIPMENT_EVENT_SCHEMAS,
  shipmentCreatedPayloadSchema,
  shipmentDeliveredPayloadSchema,
  shipmentDispatchedPayloadSchema,
} from './inventory-shipments';

const ULID = '01JBQ0000000000000000000AB';

const facts = {
  shipmentId: `SHP_${ULID}`,
  organizationId: `ORG_${ULID}`,
  originWarehouseId: `WHS_${ULID}`,
  consigneeOrganizationId: `ORG_01JBQ0000000000000000000CD`,
  orderReference: `ORD_${ULID}`,
  trackingEventId: `TRK_${ULID}`,
};

const created = {
  ...facts,
  shipmentVersion: 1,
  legCount: 2,
  createdBy: 'USR_01JBQ0000000000000000000EF',
  createdAt: '2026-10-14T08:00:00.000Z',
};

describe('inventory shipment event contracts', () => {
  it('names three events, each with its schema', () => {
    expect(Object.keys(INVENTORY_SHIPMENT_EVENTS)).toEqual([
      'SHIPMENT_CREATED',
      'SHIPMENT_DISPATCHED',
      'SHIPMENT_DELIVERED',
    ]);
    expect(Object.keys(INVENTORY_SHIPMENT_EVENT_SCHEMAS)).toEqual(
      Object.keys(INVENTORY_SHIPMENT_EVENTS),
    );
  });

  it('accepts what inventory-service publishes', () => {
    expect(shipmentCreatedPayloadSchema.parse(created)).toEqual(created);
    expect(shipmentCreatedPayloadSchema.parse({ ...created, orderReference: null })).toBeTruthy();
    expect(
      shipmentDispatchedPayloadSchema.parse({
        ...facts,
        shipmentVersion: 2,
        dispatchedBy: 'USR-SEED-1',
        dispatchedAt: '2026-10-14T09:00:00.000Z',
      }),
    ).toBeTruthy();
    expect(
      shipmentDeliveredPayloadSchema.parse({
        ...facts,
        consigneeOrganizationId: 'ORG-SEED-UNION',
        shipmentVersion: 3,
        deliveredBy: 'USR-SEED-1',
        deliveredAt: '2026-10-14T10:00:00.000Z',
      }),
    ).toBeTruthy();
  });

  it('refuses free text — no carrier, no address, no unknown field', () => {
    for (const extra of [{ carrier: 'Acme Freight' }, { address: 'somewhere' }, { note: 'x' }]) {
      expect(shipmentCreatedPayloadSchema.safeParse({ ...created, ...extra }).success).toBe(false);
    }
  });

  it('pins each event to its position in the shipment’s history', () => {
    expect(shipmentCreatedPayloadSchema.safeParse({ ...created, shipmentVersion: 2 }).success).toBe(
      false,
    );
    expect(
      shipmentDeliveredPayloadSchema.safeParse({
        ...facts,
        shipmentVersion: 2,
        deliveredBy: 'USR-SEED-1',
        deliveredAt: '2026-10-14T10:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('refuses malformed identifiers, references and instants', () => {
    for (const broken of [
      { shipmentId: `SRV_${ULID}` },
      { originWarehouseId: 'WHS_lowercase' },
      { consigneeOrganizationId: 'someone' },
      { orderReference: `ADJ_${ULID}` },
      { trackingEventId: `SHL_${ULID}` },
      { createdAt: '2026-10-14T08:00:00+03:30' },
      { legCount: 0 },
    ]) {
      expect(shipmentCreatedPayloadSchema.safeParse({ ...created, ...broken }).success).toBe(false);
    }
  });
});
