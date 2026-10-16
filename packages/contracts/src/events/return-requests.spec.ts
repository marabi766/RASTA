import {
  RETURN_REQUEST_EVENTS,
  RETURN_REQUEST_EVENT_SCHEMAS,
  returnAuthorizedPayloadSchema,
  returnCancelledPayloadSchema,
  returnRejectedPayloadSchema,
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
  it('names four events, each with its schema', () => {
    expect(Object.keys(RETURN_REQUEST_EVENTS)).toEqual([
      'RETURN_REQUESTED',
      'RETURN_AUTHORIZED',
      'RETURN_REJECTED',
      'RETURN_CANCELLED',
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
