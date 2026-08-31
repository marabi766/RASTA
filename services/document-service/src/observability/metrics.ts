import { Counter, Histogram, registry } from '@rasta/observability';

/**
 * Metrics owned by document-service.
 *
 * Only the ones answering a question an operator will actually ask. The
 * platform-wide series — outbox lag, HTTP latency, authorization denials — are
 * already defined in `@rasta/observability` and are not duplicated here.
 *
 * **No unbounded cardinality, and nothing that identifies a document.** No
 * label carries an `organizationId`, a `documentId`, a filename or an object
 * key. A per-tenant breakdown belongs in analytics-service, under
 * authorization — not in a scrape anyone on the monitoring network can read.
 * That matters more here than in most services: a metric labelled by filename
 * would leak the *names* of every contract and licence on the platform to
 * anybody who can reach `/metrics`, without leaking a single byte of content
 * (AGENTS.md S-09).
 *
 * `document_class` is safe to label by: it is a fixed, small enumeration and
 * says nothing about whose document it is.
 */

export const uploadUrlsIssuedTotal = new Counter({
  name: 'rasta_document_upload_urls_issued_total',
  help: 'Signed upload URLs issued',
  labelNames: ['service', 'document_class'] as const,
  registers: [registry],
});

export const documentsFinalizedTotal = new Counter({
  name: 'rasta_document_finalized_total',
  help: 'Documents whose object was confirmed and metadata registered',
  labelNames: ['service', 'document_class', 'scan_state'] as const,
  registers: [registry],
});

/**
 * Finalizations refused, by why.
 *
 * The most operationally interesting series in the file. A rise in
 * `content_mismatch` means clients are uploading something other than what
 * they declare — either a broken integration or somebody probing the
 * validation.
 */
export const finalizeRefusedTotal = new Counter({
  name: 'rasta_document_finalize_refused_total',
  help: 'Finalization attempts refused',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

export const documentsDeletedTotal = new Counter({
  name: 'rasta_document_deleted_total',
  help: 'Documents tombstoned',
  labelNames: ['service', 'document_class'] as const,
  registers: [registry],
});

export const downloadUrlsIssuedTotal = new Counter({
  name: 'rasta_document_download_urls_issued_total',
  help: 'Signed download URLs issued',
  labelNames: ['service', 'document_class'] as const,
  registers: [registry],
});

/**
 * Download refusals, by reason.
 *
 * Pairs with the counter above to answer "is the scanner blocking real
 * traffic" — which, while the MVP stub is bound and every document is
 * `NOT_SCANNED`, is the difference between a working platform and an inert one.
 */
export const downloadUrlsRefusedTotal = new Counter({
  name: 'rasta_document_download_urls_refused_total',
  help: 'Signed download URLs refused, by reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/**
 * How long object-storage calls take, per operation.
 *
 * Object storage is the one external system in this service's request path, so
 * when documents are slow this is where it shows. Buckets reach 10s because a
 * signed-URL call that takes that long means storage is unreachable rather
 * than slow, and a histogram that tops out at 1s would hide it.
 */
export const storageOperationSeconds = new Histogram({
  name: 'rasta_document_storage_operation_seconds',
  help: 'Object-storage call duration by operation',
  labelNames: ['service', 'operation'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
