import { createHash } from 'node:crypto';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import {
  RFQ_RECEIPT_GENESIS_LABEL,
  RfqEvidenceIdentityError,
  RfqEvidenceUnmappableError,
  genesisReceipt,
  toRfqEvidenceEvent,
} from './rfq-evidence';

const digest = (seed: string): string => createHash('sha256').update(seed).digest('hex');

const RFQ = 'RFQ_01';
const BUYER = 'ORG_BUYER';

const envelope = (eventName: string, payload: object, overrides: object = {}): EventEnvelope =>
  eventEnvelopeSchema.parse({
    eventId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
    eventName,
    occurredAt: '2026-11-02T10:00:00.000Z',
    producer: 'procurement-service',
    aggregateType: 'Rfq',
    aggregateId: RFQ,
    tenantId: BUYER,
    correlationId: '01JBBBBBBBBBBBBBBBBBBBBBBB',
    payload,
    ...overrides,
  }) as EventEnvelope;

/** A `QUOTATION_SUBMITTED` payload as ADR-070 § 9 fixes it (and the producer's `.strict()` shape adds only `submittedBy`). */
const payload = (overrides: object = {}): object => ({
  rfqId: RFQ,
  quotationId: 'QUO_01',
  organizationId: BUYER,
  supplierOrganizationId: 'ORG_SUPPLIER',
  revision: 1,
  receivedAt: '2026-11-02T09:59:00.000Z',
  contentCommitment: digest('commitment'),
  ciphertextSha256: digest('ciphertext'),
  previousReceipt: genesisReceipt(RFQ),
  receipt: digest('receipt'),
  submittedBy: 'USR_1',
  ...overrides,
});

describe('the RFQ genesis receipt', () => {
  it('is SHA-256 over the length-prefixed label and the RFQ id — the bytes procurement-service must reproduce', () => {
    // Pinned: the label is part of the bytes. A change here orphans every chain ever held, and
    // procurement-service's SealingLabels.receiptGenesis (plan PR 8) must equal it.
    expect(RFQ_RECEIPT_GENESIS_LABEL).toBe('rasta.quotation.receipt.genesis.v1');
    expect(genesisReceipt('RFQ_01')).toBe(
      '583badc22111e9a83b733c34ebda5090b6781b4d205eb66046ce3b1edc59abf0',
    );
    expect(genesisReceipt('RFQ_01')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs per RFQ and from the tender genesis of the same id', () => {
    expect(genesisReceipt('RFQ_01')).not.toBe(genesisReceipt('RFQ_02'));
    // The tender construction, same id, other label: two chains can never be spliced.
    const tender = createHash('sha256')
      .update(
        Buffer.concat(
          ['rasta.bid.receipt.genesis.v1', 'RFQ_01'].flatMap((part) => {
            const bytes = Buffer.from(part, 'utf8');
            const length = Buffer.alloc(4);
            length.writeUInt32BE(bytes.length);
            return [length, bytes];
          }),
        ),
      )
      .digest('hex');
    expect(genesisReceipt('RFQ_01')).not.toBe(tender);
  });
});

describe('toRfqEvidenceEvent', () => {
  it.each(['QUOTATION_SUBMITTED', 'QUOTATION_REVISED'])('reads the receipt of a %s', (name) => {
    const event = toRfqEvidenceEvent(envelope(name, payload()));
    expect(event?.eventId).toBe('01JAAAAAAAAAAAAAAAAAAAAAAA');
    expect(event?.payload).toMatchObject({ rfqId: RFQ, quotationId: 'QUO_01', revision: 1 });
  });

  it('keeps only what it reads: a field a later producer adds is not refused, and is not kept', () => {
    const event = toRfqEvidenceEvent(
      envelope('QUOTATION_SUBMITTED', payload({ priceMinor: '1', futureField: true })),
    );
    expect(event?.payload).not.toHaveProperty('priceMinor');
    expect(event?.payload).not.toHaveProperty('futureField');
    expect(event?.payload).not.toHaveProperty('submittedBy');
  });

  it.each([
    'QUOTATION_WITHDRAWN',
    'QUOTATION_ACCESSED',
    'QUOTATIONS_OPENED',
    'RFQ_ISSUED',
    'RFQ_CLOSED',
    'BID_SUBMITTED',
  ])('skips %s: not a receipt-chain event', (name) => {
    expect(toRfqEvidenceEvent(envelope(name, { rfqId: RFQ }))).toBeUndefined();
  });

  it.each([
    ['a receipt that is not a digest', { receipt: 'not-a-digest' }],
    ['an upper-case digest', { receipt: digest('x').toUpperCase() }],
    ['a revision of zero', { revision: 0 }],
    ['a fractional revision', { revision: 1.5 }],
    ['an empty RFQ id', { rfqId: '' }],
    ['a receipt that is its own predecessor', { previousReceipt: digest('receipt') }],
    ['a receivedAt that is not an instant', { receivedAt: 'yesterday' }],
    ['a missing commitment', { contentCommitment: undefined }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => toRfqEvidenceEvent(envelope('QUOTATION_SUBMITTED', payload(overrides)))).toThrow(
      RfqEvidenceUnmappableError,
    );
  });

  it.each([
    ['another tenant on the envelope', { tenantId: 'ORG_OTHER' }, 'tenantId'],
    ['no tenant on the envelope', { tenantId: undefined }, 'tenantId'],
    ['another RFQ as the aggregate', { aggregateId: 'RFQ_OTHER' }, 'rfqId'],
    ['another producer', { producer: 'construction-service' }, 'producer'],
  ])('refuses %s', (_label, overrides, field) => {
    expect.assertions(2);
    try {
      toRfqEvidenceEvent(envelope('QUOTATION_SUBMITTED', payload(), overrides));
    } catch (error) {
      expect(error).toBeInstanceOf(RfqEvidenceIdentityError);
      expect((error as RfqEvidenceIdentityError).field).toBe(field);
    }
  });

  it('names the field and never its value in the refusal', () => {
    try {
      toRfqEvidenceEvent(envelope('QUOTATION_SUBMITTED', payload(), { tenantId: 'ORG_SECRET' }));
    } catch (error) {
      expect((error as Error).message).not.toContain('ORG_SECRET');
      expect((error as Error).message).not.toContain(BUYER);
    }
  });
});
