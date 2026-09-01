import { Counter, Gauge, Histogram, registry } from '@rasta/observability';

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

// ---------------------------------------------------------------------------
// Malware scanning (ADR-049)
//
// The same cardinality rule as everything above, and it bites harder here.
// A scan metric labelled by document id, object key or filename would publish
// the *name of every infected contract on the platform* to anybody who can
// reach `/metrics` — a leak that needs no file content at all. So the labels
// are: a fixed verdict enum, a fixed failure-reason enum, and the service
// name. Nothing else.
// ---------------------------------------------------------------------------

/**
 * How long a scan takes end to end, by verdict.
 *
 * Split by verdict because the distributions are genuinely different and
 * averaging them hides both: a `CLEAN` is bounded by how fast the object
 * streams, and a `FAILED` is usually bounded by the timeout, so a single
 * histogram would show a bimodal shape nobody can act on.
 *
 * Buckets reach the scan deadline's order of magnitude. One that topped out
 * at a second would put every real scan of a large document in `+Inf`.
 */
export const scanDurationSeconds = new Histogram({
  name: 'rasta_document_scan_duration_seconds',
  help: 'Malware scan duration, from claim to recorded verdict',
  labelNames: ['service', 'verdict'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [registry],
});

/** Verdicts recorded, by kind. `INFECTED` rising is an incident, not a trend. */
export const scanVerdictsTotal = new Counter({
  name: 'rasta_document_scan_verdicts_total',
  help: 'Scan verdicts recorded',
  labelNames: ['service', 'verdict'] as const,
  registers: [registry],
});

/**
 * Scans that reached no verdict, by reason.
 *
 * The most operationally useful series in this file. `CONNECTION_FAILED`
 * climbing means the sidecar is gone; `STALE_SIGNATURES` means freshclam has
 * been failing quietly; `SCAN_LIMITS_EXCEEDED` means real documents are
 * hitting the archive limits and somebody has to decide whether to raise them
 * or refuse those files. Each needs a different person, which is why one
 * counter would be useless.
 */
export const scanFailuresTotal = new Counter({
  name: 'rasta_document_scan_failures_total',
  help: 'Scans that did not reach a verdict, by reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/** Retries scheduled. Rising with no failure reason changing means flapping. */
export const scanRetriesTotal = new Counter({
  name: 'rasta_document_scan_retries_total',
  help: 'Scan attempts rescheduled after a retryable failure',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/** Documents waiting to be scanned. */
export const scanPendingTotal = new Gauge({
  name: 'rasta_document_scan_pending_total',
  help: 'Documents in the scan queue',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * How long the oldest waiting document has waited.
 *
 * The one to alert on. Queue depth alone cannot distinguish a healthy burst
 * from a stalled worker; this can, and it is also the number that says how
 * long a user has been unable to download something they uploaded.
 */
export const scanPendingOldestAgeSeconds = new Gauge({
  name: 'rasta_document_scan_pending_oldest_age_seconds',
  help: 'Age of the oldest document still waiting to be scanned',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Age of the signature database the scanner is running.
 *
 * Monitored rather than merely configured, because freshclam failing is silent
 * by nature: scanning keeps working and keeps answering `OK`, and the only
 * visible symptom is this number climbing. Past
 * `DOCUMENT_SCAN_SIGNATURE_MAX_AGE_HOURS` the adapter stops issuing clean
 * verdicts altogether — but an operator should have seen it long before that.
 */
export const scanSignatureAgeSeconds = new Gauge({
  name: 'rasta_document_scan_signature_age_seconds',
  help: 'Age of the malware signature database in use',
  labelNames: ['service', 'engine'] as const,
  registers: [registry],
});

/** 1 when the scanner answered its last health check, 0 when it did not. */
export const scannerUp = new Gauge({
  name: 'rasta_document_scanner_up',
  help: 'Whether the malware scanner is reachable and answering',
  labelNames: ['service', 'engine'] as const,
  registers: [registry],
});
