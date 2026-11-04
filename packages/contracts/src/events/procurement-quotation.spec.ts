import {
  PROCUREMENT_QUOTATION_EVENTS,
  PROCUREMENT_QUOTATION_EVENT_SCHEMAS,
  QUOTATION_RECEIPT_GENESIS_LABEL,
  quotationRevisedPayloadSchema,
  quotationSubmittedPayloadSchema,
  quotationWithdrawnPayloadSchema,
} from './procurement-quotation';

const ULID = '01JBQ0000000000000000000AB';

const receipt = {
  rfqId: `RFQ_${ULID}`,
  quotationId: `QOT_${ULID}`,
  organizationId: `ORG_${ULID}`,
  supplierOrganizationId: 'ORG_01JBQ0000000000000000000CD',
  revision: 1,
  receivedAt: '2026-11-02T09:59:00.000Z',
  contentCommitment: 'a'.repeat(64),
  ciphertextSha256: 'b'.repeat(64),
  previousReceipt: 'c'.repeat(64),
  receipt: 'd'.repeat(64),
  submittedBy: 'USR_01JBQ0000000000000000000EF',
};

describe('procurement quotation event contracts', () => {
  it('names three events, each with its schema', () => {
    expect(Object.keys(PROCUREMENT_QUOTATION_EVENTS)).toEqual([
      'QUOTATION_SUBMITTED',
      'QUOTATION_REVISED',
      'QUOTATION_WITHDRAWN',
    ]);
    expect(Object.keys(PROCUREMENT_QUOTATION_EVENT_SCHEMAS)).toEqual(
      Object.keys(PROCUREMENT_QUOTATION_EVENTS),
    );
  });

  it('pins the genesis label audit-service recomputes the chain with', () => {
    expect(QUOTATION_RECEIPT_GENESIS_LABEL).toBe('rasta.quotation.receipt.genesis.v1');
  });

  it('accepts what procurement-service publishes', () => {
    expect(quotationSubmittedPayloadSchema.safeParse(receipt).success).toBe(true);
    expect(quotationRevisedPayloadSchema.safeParse({ ...receipt, revision: 2 }).success).toBe(true);
    expect(
      quotationWithdrawnPayloadSchema.safeParse({
        rfqId: receipt.rfqId,
        quotationId: receipt.quotationId,
        organizationId: receipt.organizationId,
        supplierOrganizationId: receipt.supplierOrganizationId,
        revision: 3,
        withdrawnBy: receipt.submittedBy,
        withdrawnAt: '2026-11-02T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a price', { unitPriceMinor: '1000' }],
    ['the content', { content: { unitPriceMinor: '1000' } }],
    ['an amount', { amountMinor: '1000' }],
    ['a note', { note: 'x' }],
  ])('refuses %s: nothing sealed is ever on the topic', (_label, extra) => {
    expect(quotationSubmittedPayloadSchema.safeParse({ ...receipt, ...extra }).success).toBe(false);
  });

  it.each([
    ['a first revision other than 1', quotationSubmittedPayloadSchema, { revision: 2 }],
    ['a revision that is not after the first', quotationRevisedPayloadSchema, { revision: 1 }],
    ['an RFQ id not minted by the service', quotationSubmittedPayloadSchema, { rfqId: 'RFQ_01' }],
    [
      'a quotation id of another prefix',
      quotationSubmittedPayloadSchema,
      { quotationId: `BID_${ULID}` },
    ],
    ['an upper-case digest', quotationSubmittedPayloadSchema, { receipt: 'D'.repeat(64) }],
    ['its own predecessor', quotationSubmittedPayloadSchema, { previousReceipt: 'd'.repeat(64) }],
    [
      'an instant with an offset',
      quotationSubmittedPayloadSchema,
      { receivedAt: '2026-11-02T13:29:00+03:30' },
    ],
  ])('refuses %s', (_label, schema, overrides) => {
    expect(schema.safeParse({ ...receipt, ...overrides }).success).toBe(false);
  });
});
