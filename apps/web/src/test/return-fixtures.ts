import type { Order } from '@/server/orders';
import type { ReturnRequest, ReturnShipment } from '@/server/returns';

/**
 * An order and its return requests as marketplace-service sends them, and the
 * people of the return specs — one fixture for the server, action and screen
 * specs, so they read the same records.
 *
 * The buyer is ORG-DEH-0001, the supplier ORG-DEH-0002, a third organization
 * ORG-DEH-0003.
 */

export const BUYER = 'ORG-DEH-0001';
export const SUPPLIER = 'ORG-DEH-0002';
export const STRANGER = 'ORG-DEH-0003';
export const ORDER_ID = 'ORD_01JORDERAAAAAAAAAAAAAAAAA';
export const RETURN_ID = 'RET_01JRETURNAAAAAAAAAAAAAAAA';
export const LINE_A = 'OLN_01JLINEAAAAAAAAAAAAAAAAA';
export const LINE_B = 'OLN_01JLINEBBBBBBBBBBBBBBBBB';

/** A completed order of two lines: 10 of aggregate, 20 of cement. */
export const COMPLETED_ORDER: Order = {
  id: ORDER_ID,
  status: 'COMPLETED',
  buyerOrganizationId: BUYER,
  supplierOrganizationId: SUPPLIER,
  totalAmountMinor: '146000000',
  currency: 'IRR',
  lines: [
    {
      id: LINE_A,
      offerId: 'OFR_A',
      productId: 'PRD_A',
      productName: 'شن و ماسه',
      quantity: 10,
      unitPriceMinor: '8900000',
      lineTotalMinor: '89000000',
      currency: 'IRR',
    },
    {
      id: LINE_B,
      offerId: 'OFR_B',
      productId: 'PRD_B',
      productName: 'سیمان',
      quantity: 20,
      unitPriceMinor: '2850000',
      lineTotalMinor: '57000000',
      currency: 'IRR',
    },
  ],
  confirmedAt: '2026-10-01T08:00:00.000Z',
  fulfilledAt: '2026-10-02T08:00:00.000Z',
  receiptConfirmedAt: '2026-10-03T08:00:00.000Z',
  completedAt: '2026-10-03T09:00:00.000Z',
  cancelledAt: null,
  cancellationReason: null,
  failureReason: null,
  createdAt: '2026-09-30T08:00:00.000Z',
  availableActions: [],
};

/** A request for 3 of line A, waiting on the supplier. */
export const REQUESTED: ReturnRequest = {
  id: RETURN_ID,
  orderId: ORDER_ID,
  status: 'REQUESTED',
  version: 1,
  buyerOrganizationId: BUYER,
  supplierOrganizationId: SUPPLIER,
  reason: 'سه کیسه از شن رسیده خیس و کلوخه بود.',
  lines: [{ orderLineId: LINE_A, productId: 'PRD_A', quantity: 3 }],
  requestedAt: '2026-10-05T08:00:00.000Z',
  authorizedAt: null,
  rejectedAt: null,
  cancelledAt: null,
  cancelledFrom: null,
  // The mirror is off by default: nothing physical is on the request itself.
  returnShipmentId: null,
  inTransitAt: null,
  receivedAt: null,
  inspectedAt: null,
  resolvedAt: null,
};

export const AUTHORIZED: ReturnRequest = {
  ...REQUESTED,
  status: 'AUTHORIZED',
  version: 2,
  authorizedAt: '2026-10-06T08:00:00.000Z',
};

export const REJECTED: ReturnRequest = {
  ...REQUESTED,
  status: 'REJECTED',
  version: 2,
  rejectedAt: '2026-10-06T08:00:00.000Z',
};

export const CANCELLED: ReturnRequest = {
  ...AUTHORIZED,
  status: 'CANCELLED',
  version: 3,
  cancelledAt: '2026-10-07T08:00:00.000Z',
  cancelledFrom: 'AUTHORIZED',
};

/** The goods of {@link AUTHORIZED} — every line, as authorized — received and inspected. */
export const INSPECTED_SHIPMENT: ReturnShipment = {
  id: 'RSP_01JSHIPMENTAAAAAAAAAAAAAA',
  status: 'INSPECTED',
  // Recorded by the request's supplier, from its buyer, for its order.
  organizationId: SUPPLIER,
  buyerOrganizationId: BUYER,
  returnRequestId: RETURN_ID,
  orderId: ORDER_ID,
  lines: [{ orderLineId: LINE_A, productId: 'PRD_A', expectedQuantity: 3, receivedQuantity: 3 }],
  carrierName: 'باربری یزد',
  carrierReference: 'YZD-123',
  createdAt: '2026-10-08T08:00:00.000Z',
  receivedAt: '2026-10-09T08:00:00.000Z',
  inspectedAt: '2026-10-10T08:00:00.000Z',
  inspectionNote: 'هر سه کیسه نم کشیده بود.',
  resolvedAt: null,
  dispositions: [],
};

/**
 * An unsigned access token with these claims, the shape `tokenAuthority`
 * reads (it never verifies; the gateway and the service do).
 */
export function accessToken(organizationId: string | null, roles: readonly string[]): string {
  const claims: Record<string, unknown> =
    organizationId === null
      ? { realm_access: { roles } }
      : {
          org_id: organizationId,
          org_ids: [organizationId],
          org_roles: roles.map((role) => `${organizationId}:${role}`),
        };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}
