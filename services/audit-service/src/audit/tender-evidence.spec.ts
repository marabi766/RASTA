import { createHash } from 'node:crypto';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import {
  TENDER_EVIDENCE_PRODUCER,
  TenderEvidenceIdentityError,
  genesisReceipt,
  toTenderEvidenceEvent,
} from './tender-evidence';
import type { TenderEvidenceRepository } from './tender-evidence.repository';
import { TenderEvidenceConsumer } from '../consumers/tender-evidence.consumer';
import { auditIngestionFailuresTotal } from '../observability/metrics';

const digest = (seed: string): string => createHash('sha256').update(seed).digest('hex');

const TENDER = 'TND_01';
const OWNER = 'ORG_OWNER';

const RECEIPT = {
  bidId: 'BID_01',
  tenderId: TENDER,
  organizationId: OWNER,
  bidderOrganizationId: 'ORG_BIDDER',
  revision: 1,
  receivedAt: '2026-11-02T09:59:00.000Z',
  contentCommitment: digest('commitment'),
  ciphertextSha256: digest('ciphertext'),
  previousReceipt: genesisReceipt(TENDER),
  receipt: digest('receipt'),
};

const ACCESS = {
  bidId: null,
  tenderId: TENDER,
  organizationId: OWNER,
  accessorOrganizationId: 'ORG_BIDDER',
  accessedBy: 'USR_9',
  purpose: 'OWN_BID_RECEIPT',
  outcome: 'GRANTED',
  accessedAt: '2026-11-02T10:00:00.000Z',
};

const EVENTS: [string, object][] = [
  ['BID_SUBMITTED', RECEIPT],
  ['BID_REVISED', { ...RECEIPT, revision: 2 }],
  ['BID_ACCESSED', ACCESS],
];

const envelope = (eventName: string, payload: object, overrides: object = {}): EventEnvelope =>
  ({
    ...eventEnvelopeSchema.parse({
      eventId: '01JAAAAAAAAAAAAAAAAAAAAAAA',
      eventName,
      occurredAt: '2026-11-02T10:00:00.000Z',
      producer: 'construction-service',
      aggregateType: 'Tender',
      aggregateId: TENDER,
      tenantId: OWNER,
      correlationId: '01JBBBBBBBBBBBBBBBBBBBBBBB',
      payload,
    }),
    // After the schema: the projection must refuse what the shared consumer would not let by.
    ...overrides,
  }) as EventEnvelope;

/** The producer cases this projection refuses (FU-024): fail closed, an exact match only. */
const FOREIGN_PRODUCERS: [string, object][] = [
  ['a missing producer', { producer: undefined }],
  ['an empty producer', { producer: '' }],
  ['an unknown producer', { producer: 'sentinel-invented-service' }],
  ['another platform producer', { producer: 'procurement-service' }],
  ['the owner in another case', { producer: 'Construction-Service' }],
  ['the owner padded', { producer: 'construction-service ' }],
];

describe('toTenderEvidenceEvent: only the tender owner writes the evidence (FU-024)', () => {
  it('names construction-service as the one producer', () => {
    expect(TENDER_EVIDENCE_PRODUCER).toBe('construction-service');
  });

  it.each(EVENTS)('reads a %s from construction-service', (name, payload) => {
    expect(toTenderEvidenceEvent(envelope(name, payload))?.eventId).toBe(
      '01JAAAAAAAAAAAAAAAAAAAAAAA',
    );
  });

  describe.each(EVENTS)('%s', (name, payload) => {
    it.each(FOREIGN_PRODUCERS)('refuses %s, naming the field and not its value', (_case, o) => {
      expect.assertions(3);
      try {
        toTenderEvidenceEvent(envelope(name, payload, o));
      } catch (error) {
        expect(error).toBeInstanceOf(TenderEvidenceIdentityError);
        expect((error as TenderEvidenceIdentityError).field).toBe('producer');
        expect((error as Error).message).not.toContain('sentinel');
      }
    });
  });

  it('leaves events it does not read alone, whoever produced them', () => {
    expect(
      toTenderEvidenceEvent(envelope('TENDER_PUBLISHED', {}, { producer: 'procurement-service' })),
    ).toBeUndefined();
  });
});

describe('TenderEvidenceConsumer: a foreign producer is refused before anything is written', () => {
  const failures = (): Promise<number> =>
    auditIngestionFailuresTotal
      .get()
      .then(
        (metric) =>
          metric.values.find((v) => v.labels.reason === 'tender_evidence_mismatch')?.value ?? 0,
      );

  const build = () => {
    const repository = { appendLink: jest.fn(), recordAccess: jest.fn() };
    const logger = { error: jest.fn() };
    const consumer = new TenderEvidenceConsumer(
      jest.fn(),
      repository as unknown as TenderEvidenceRepository,
      logger as unknown as Logger,
    );
    return { consumer, repository, logger };
  };
  const delivery = { topic: 'rasta.construction.v1', partition: 0, offset: '0' } as EventDelivery;

  it.each(EVENTS)('%s: rethrows to the dead-letter path, counted, no row', async (name, p) => {
    const { consumer, repository, logger } = build();
    const before = await failures();
    await expect(
      consumer.handle(envelope(name, p, { producer: 'procurement-service' }), delivery),
    ).rejects.toBeInstanceOf(TenderEvidenceIdentityError);
    expect(repository.appendLink).not.toHaveBeenCalled();
    expect(repository.recordAccess).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(await failures()).toBe(before + 1);
  });

  it.each(EVENTS)('%s: from construction-service it is written', async (name, p) => {
    const { consumer, repository } = build();
    await consumer.handle(envelope(name, p), delivery);
    expect(
      repository.appendLink.mock.calls.length + repository.recordAccess.mock.calls.length,
    ).toBe(1);
  });
});
