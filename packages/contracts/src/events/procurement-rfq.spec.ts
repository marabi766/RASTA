import {
  DEFAULT_RFQ_CANCELLATION_CODES,
  PROCUREMENT_RFQ_EVENTS,
  PROCUREMENT_RFQ_EVENT_SCHEMAS,
  RFQ_CANCELLATION_CODE_PATTERN,
  RFQ_MAX_INVITEES_LIMIT,
  rfqCancelledPayloadSchema,
  rfqClosedPayloadSchema,
  rfqIssuedPayloadSchema,
} from './procurement-rfq';

const ULID = '01JBQ0000000000000000000AB';

const facts = {
  rfqId: `RFQ_${ULID}`,
  organizationId: `ORG_${ULID}`,
  aggregationId: `AGG_${ULID}`,
};

const issued = {
  ...facts,
  rfqVersion: 1,
  productId: `PRD_${ULID}`,
  totalQuantity: 12,
  procurementNature: 'INQUIRY',
  quotationClosingAt: '2026-11-01T08:00:00.000Z',
  invitedSupplierOrganizationIds: ['ORG_01JBQ0000000000000000000CD', 'ORG-SEED-SUPPLIER'],
  criteriaCount: 2,
  criteriaDigest: 'a'.repeat(64),
  keyId: `RFK_${ULID}`,
  issuedBy: 'USR_01JBQ0000000000000000000EF',
  issuedAt: '2026-10-22T08:00:00.000Z',
};

describe('procurement RFQ event contracts', () => {
  it('names three events, each with its schema', () => {
    expect(Object.keys(PROCUREMENT_RFQ_EVENTS)).toEqual([
      'RFQ_ISSUED',
      'RFQ_CLOSED',
      'RFQ_CANCELLED',
    ]);
    expect(Object.keys(PROCUREMENT_RFQ_EVENT_SCHEMAS)).toEqual(Object.keys(PROCUREMENT_RFQ_EVENTS));
  });

  it('accepts what procurement-service publishes', () => {
    expect(rfqIssuedPayloadSchema.safeParse(issued).success).toBe(true);
    expect(
      rfqClosedPayloadSchema.safeParse({
        ...facts,
        rfqVersion: 2,
        quotationClosingAt: issued.quotationClosingAt,
        trigger: 'SWEEPER',
        closedBy: null,
        closedAt: '2026-11-01T08:00:01.000Z',
        quotationCount: 0,
      }).success,
    ).toBe(true);
    expect(
      rfqCancelledPayloadSchema.safeParse({
        ...facts,
        rfqVersion: 2,
        previousStatus: 'PUBLISHED',
        reasonCode: 'BUYER_REQUEST',
        cancelledBy: issued.issuedBy,
        cancelledAt: '2026-10-23T08:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('refuses free text, an amount or anything the contract does not name', () => {
    expect(rfqIssuedPayloadSchema.safeParse({ ...issued, criteria: [] }).success).toBe(false);
    expect(rfqIssuedPayloadSchema.safeParse({ ...issued, amountMinor: '1' }).success).toBe(false);
    expect(
      rfqCancelledPayloadSchema.safeParse({
        ...facts,
        rfqVersion: 2,
        previousStatus: 'PUBLISHED',
        reasonCode: 'BUYER_REQUEST',
        reason: 'the budget was withdrawn',
        cancelledBy: issued.issuedBy,
        cancelledAt: '2026-10-23T08:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('bounds the invitees: at least one, distinct, at most the limit, organizations only', () => {
    const invitees = (ids: string[]) =>
      rfqIssuedPayloadSchema.safeParse({ ...issued, invitedSupplierOrganizationIds: ids }).success;
    expect(invitees([])).toBe(false);
    expect(
      invitees([
        issued.invitedSupplierOrganizationIds[0]!,
        issued.invitedSupplierOrganizationIds[0]!,
      ]),
    ).toBe(false);
    expect(invitees(['USR_01JBQ0000000000000000000EF'])).toBe(false);
    const many = Array.from(
      { length: RFQ_MAX_INVITEES_LIMIT + 1 },
      (_, n) => `ORG-SEED-${String(n).padStart(4, '0')}`,
    );
    expect(invitees(many.slice(0, RFQ_MAX_INVITEES_LIMIT))).toBe(true);
    expect(invitees(many)).toBe(false);
  });

  it('a close names its person exactly when a person closed it; an issue is version 1', () => {
    const closed = {
      ...facts,
      rfqVersion: 2,
      quotationClosingAt: issued.quotationClosingAt,
      closedAt: '2026-11-01T08:00:01.000Z',
      quotationCount: 0,
    };
    expect(
      rfqClosedPayloadSchema.safeParse({ ...closed, trigger: 'SWEEPER', closedBy: 'USR-X' })
        .success,
    ).toBe(false);
    expect(
      rfqClosedPayloadSchema.safeParse({ ...closed, trigger: 'MANUAL', closedBy: null }).success,
    ).toBe(false);
    expect(
      rfqClosedPayloadSchema.safeParse({ ...closed, trigger: 'MANUAL', closedBy: 'USR-X' }).success,
    ).toBe(true);
    expect(rfqIssuedPayloadSchema.safeParse({ ...issued, rfqVersion: 2 }).success).toBe(false);
  });

  it('a close counts its quotations (ADR-070 § 9): a whole number, never absent', () => {
    const closed = {
      ...facts,
      rfqVersion: 2,
      quotationClosingAt: issued.quotationClosingAt,
      trigger: 'SWEEPER',
      closedBy: null,
      closedAt: '2026-11-01T08:00:01.000Z',
    };
    expect(rfqClosedPayloadSchema.safeParse({ ...closed, quotationCount: 3 }).success).toBe(true);
    expect(rfqClosedPayloadSchema.safeParse(closed).success).toBe(false);
    expect(rfqClosedPayloadSchema.safeParse({ ...closed, quotationCount: -1 }).success).toBe(false);
    expect(rfqClosedPayloadSchema.safeParse({ ...closed, quotationCount: 1.5 }).success).toBe(
      false,
    );
  });

  it('a cancellation carries a code of the configured form, never a free text', () => {
    const cancelled = (reasonCode: string) =>
      rfqCancelledPayloadSchema.safeParse({
        ...facts,
        rfqVersion: 2,
        previousStatus: 'CLOSED',
        reasonCode,
        cancelledBy: issued.issuedBy,
        cancelledAt: '2026-10-23T08:00:00.000Z',
      }).success;
    expect(cancelled('BUYER_REQUEST')).toBe(true);
    expect(cancelled('BUDGET_WITHDRAWN')).toBe(true);
    expect(cancelled('buyer_request')).toBe(false);
    expect(cancelled('the budget was withdrawn')).toBe(false);
    expect(cancelled('B')).toBe(false);
    expect(cancelled(`B${'X'.repeat(64)}`)).toBe(false);
    expect(
      DEFAULT_RFQ_CANCELLATION_CODES.every((code) => RFQ_CANCELLATION_CODE_PATTERN.test(code)),
    ).toBe(true);
  });
});
