import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { DocumentRemovalConsumer } from './document-removal.consumer';
import type { AssetRepository } from '../asset/asset.repository';
import type { AssetService } from '../asset/asset.service';
import type { DocumentLookup, ResolvedDocument } from '../asset/document-lookup';

/**
 * document-service deleted a file: the claim's reference to it is marked
 * `DOCUMENT_REMOVED` (docs/24 Q-128), never deleted, once document-service
 * itself confirms the deletion (A-13). Driven directly with hand-built
 * envelopes, no broker.
 */

const DEH1 = 'ORG-DEH-0001';
const DOC = 'DOC_01JDOCUMENT00000000000001';
const DELETED_AT = '2026-10-16T08:00:00.000Z';

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: 'EVT_DEL_1',
    eventName: 'DOCUMENT_DELETED',
    eventVersion: 1,
    occurredAt: DELETED_AT,
    producer: 'document-service',
    producerVersion: '0.1.0',
    aggregateType: 'Document',
    aggregateId: DOC,
    tenantId: DEH1,
    correlationId: 'CORR_1',
    payload: {
      documentId: DOC,
      organizationId: DEH1,
      documentClass: 'INSURANCE',
      reason: 'uploaded by mistake',
      deletedBy: 'USR_1',
      deletedAt: DELETED_AT,
    },
    ...overrides,
  };
}

interface Ref {
  id: string;
  claimId: string;
  assetId: string;
  organizationId: string;
  documentId: string;
  documentRemovedAt: Date | null;
}

function harness(
  options: {
    refs?: Ref[];
    alreadyProcessed?: boolean;
    /** What document-service answers; `undefined` throws as an outage. */
    answer?: ResolvedDocument | null | undefined;
  } = {},
) {
  const refs: Ref[] = options.refs ?? [
    {
      id: 'CLD_1',
      claimId: 'CLM_1',
      assetId: 'AST_1',
      organizationId: DEH1,
      documentId: DOC,
      documentRemovedAt: null,
    },
  ];
  const appended: Array<Record<string, unknown>> = [];

  const table = {
    findMany: jest.fn(async (args: { where: { documentId: string } }) =>
      refs.filter((r) => r.documentId === args.where.documentId && r.documentRemovedAt === null),
    ),
    updateMany: jest.fn(
      async (args: { where: { id: string }; data: { documentRemovedAt: Date } }) => {
        const ref = refs.find((r) => r.id === args.where.id && r.documentRemovedAt === null);
        if (!ref) return { count: 0 };
        ref.documentRemovedAt = args.data.documentRemovedAt;
        return { count: 1 };
      },
    ),
  };
  const client = { insuranceClaimDocument: table };
  const repository = {
    client,
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    markEventProcessed: jest.fn(async () => !options.alreadyProcessed),
  } as unknown as AssetRepository;
  const assets = {
    appendTimeline: jest.fn(async (_tx: unknown, entry: Record<string, unknown>) => {
      appended.push(entry);
    }),
  } as unknown as AssetService;
  const lookup: DocumentLookup = {
    find: jest.fn(async () => {
      if ('answer' in options && options.answer === undefined) {
        throw RastaError.upstreamUnavailable('document-service');
      }
      return options.answer === undefined ? null : options.answer;
    }),
  };
  return {
    consumer: new DocumentRemovalConsumer(null, repository, assets, lookup),
    refs,
    appended,
    lookup,
    table,
    repository,
  };
}

const resolved = (status: 'REGISTERED' | 'DELETED'): ResolvedDocument => ({
  id: DOC,
  organizationId: DEH1,
  status,
  ownerResourceType: null,
  ownerResourceId: null,
});

describe('DocumentRemovalConsumer', () => {
  it('marks the reference removed, keeps it, and writes one dossier line', async () => {
    const h = harness({ answer: null });
    await h.consumer.handle(envelope());

    expect(h.refs[0]?.documentRemovedAt).toEqual(new Date(DELETED_AT));
    expect(h.refs).toHaveLength(1);
    expect(h.appended).toEqual([
      expect.objectContaining({
        assetId: 'AST_1',
        organizationId: DEH1,
        category: 'DOCUMENT',
        sourceEventId: 'CLD_1:removed',
        sourceService: 'document-service',
        detail: { claimId: 'CLM_1', documentId: DOC, state: 'DOCUMENT_REMOVED' },
      }),
    ]);
    // Not a status line: the claim's history is read back by the `<claimId>:` prefix.
    expect(String(h.appended[0]?.sourceEventId)).not.toMatch(/^CLM_1:/);
  });

  it('asks document-service as the event’s organization, and accepts DELETED as well as 404', async () => {
    const h = harness({ answer: resolved('DELETED') });
    await h.consumer.handle(envelope());
    expect(h.lookup.find).toHaveBeenCalledWith(DOC, DEH1);
    expect(h.refs[0]?.documentRemovedAt).not.toBeNull();
  });

  it('refuses, and marks nothing, when document-service still holds the document (A-13)', async () => {
    const h = harness({ answer: resolved('REGISTERED') });
    await expect(h.consumer.handle(envelope())).rejects.toMatchObject({
      reason: DLQ_REASONS.SOURCE_UNCONFIRMED,
    });
    expect(h.refs[0]?.documentRemovedAt).toBeNull();
    expect(h.appended).toHaveLength(0);
  });

  it('throws on an outage so the delivery retries, marking nothing', async () => {
    const h = harness({ answer: undefined });
    await expect(h.consumer.handle(envelope())).rejects.toBeInstanceOf(RastaError);
    expect(h.refs[0]?.documentRemovedAt).toBeNull();
  });

  it('skips, without asking document-service, when no claim holds the document', async () => {
    const h = harness({ refs: [], answer: null });
    await expect(h.consumer.handle(envelope())).resolves.toBe('SKIPPED');
    expect(h.lookup.find).not.toHaveBeenCalled();
  });

  it('is idempotent: a processed event, or an already-marked reference, changes nothing', async () => {
    const seen = harness({ answer: null, alreadyProcessed: true });
    await expect(seen.consumer.handle(envelope())).resolves.toBe('SKIPPED');
    expect(seen.refs[0]?.documentRemovedAt).toBeNull();
    expect(seen.appended).toHaveLength(0);

    const done = harness({ answer: null });
    await done.consumer.handle(envelope());
    await expect(done.consumer.handle(envelope())).resolves.toBe('SKIPPED');
    expect(done.appended).toHaveLength(1);
  });

  it('dead-letters an event whose organization is not its tenant', async () => {
    const h = harness({ answer: null });
    const forged = envelope({ tenantId: 'ORG-OTHER' });
    await expect(h.consumer.handle(forged)).rejects.toMatchObject({
      reason: DLQ_REASONS.SOURCE_UNCONFIRMED,
    });
    expect(h.lookup.find).not.toHaveBeenCalled();
    expect(h.refs[0]?.documentRemovedAt).toBeNull();
  });

  it('dead-letters a deletion with no tenant or a malformed payload, before any read', async () => {
    const h = harness({ answer: null });
    await expect(h.consumer.handle(envelope({ tenantId: undefined }))).rejects.toBeDefined();
    await expect(h.consumer.handle(envelope({ payload: { documentId: 7 } }))).rejects.toBeDefined();
    expect(h.table.findMany).not.toHaveBeenCalled();
  });

  it('ignores every other document event', async () => {
    const h = harness({ answer: null });
    for (const eventName of ['DOCUMENT_UPLOADED', 'DOCUMENT_SCANNED', 'VIRUS_DETECTED']) {
      await expect(h.consumer.handle(envelope({ eventName }))).resolves.toBe('SKIPPED');
    }
    expect(h.table.findMany).not.toHaveBeenCalled();
  });
});
