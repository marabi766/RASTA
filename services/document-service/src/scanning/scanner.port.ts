import type { Readable } from 'node:stream';

/**
 * The malware-scanning boundary (ADR-014, ADR-049).
 *
 * Q-18 — "ClamAV self-hosted or a cloud service?" — is answered: ADR-049
 * selects self-hosted ClamAV for the MVP. The port stays, and stays the point:
 * the decision it records is which class is bound, not what the domain knows.
 * `DocumentService` and the scan worker know this interface and the verdicts
 * below, and nothing else about scanning — so replacing ClamAV with a cloud
 * engine later is another class, not another lifecycle.
 *
 * ## Why the caller supplies the bytes
 *
 * {@link ScanRequest.open} rather than an object key the scanner resolves
 * itself. Storage is the caller's concern: a scanner that knew how to fetch
 * from S3 would need credentials, a bucket name and an endpoint, and every
 * future scanner would need them again. What a scanner needs is a stream and a
 * ceiling, and that is all it is given.
 */

/**
 * What a scanner concluded.
 *
 * `NOT_SCANNED` is the honest verdict for the no-op stub and is a first-class
 * value rather than an absence, because "we did not look" and "we looked and
 * it was clean" must never be recorded the same way. A future reader — or an
 * auditor — has to be able to tell which documents were actually examined.
 * ClamAV never produces it.
 *
 * `FAILED` is every way of not reaching an answer: a timeout, a refused
 * connection, a response that did not parse, an object bigger than the scanner
 * will accept, a signature database too old to trust. They are one verdict
 * because they have one consequence — the document is not downloadable — and
 * they are distinguished by {@link ScanResult.failureReason} for the operator
 * who has to fix whichever it was.
 */
export type ScanVerdict = 'NOT_SCANNED' | 'CLEAN' | 'INFECTED' | 'FAILED';

/**
 * Why a scan did not reach a verdict.
 *
 * A closed set of codes, never engine text. Two reasons: an engine message can
 * echo the content it was looking at, and this value is stored on the row,
 * written to logs, exported as a metric label and returned by the API (S-09);
 * and a metric label drawn from free text is unbounded cardinality by
 * construction.
 *
 * Every one of them means **not clean**. That is the whole invariant this type
 * exists to make unmissable: there is no failure reason that authorizes a
 * download, and adding one would be adding a bypass.
 */
export const SCAN_FAILURE_REASONS = [
  /** The scan did not finish inside the configured deadline. */
  'TIMEOUT',
  /** The scanner could not be reached at all. */
  'CONNECTION_FAILED',
  /** The scanner answered, but not in the protocol it claims to speak. */
  'PROTOCOL_ERROR',
  /** A well-formed exchange whose reply this adapter cannot interpret. */
  'MALFORMED_RESPONSE',
  /** The engine reported its own error rather than a verdict. */
  'ENGINE_ERROR',
  /** The object is larger than this deployment will submit for scanning. */
  'SIZE_LIMIT_EXCEEDED',
  /**
   * The engine stopped early because a scan limit was reached — recursion
   * depth, member count, expanded size.
   *
   * Deliberately neither `CLEAN` nor `INFECTED`. The engine did not finish
   * looking, so it cannot say the object is safe; and it did not match a
   * signature, so calling it infected would be a fabricated finding somebody
   * would act on.
   */
  'SCAN_LIMITS_EXCEEDED',
  /** The signature database is older than this deployment will trust. */
  'STALE_SIGNATURES',
  /** The object could not be read out of storage. */
  'OBJECT_UNREADABLE',
  /**
   * A scanner that does not inspect content returned a clean verdict.
   *
   * Unreachable through any implementation in this repository, and checked
   * anyway: it is the one bug whose consequence is serving unexamined bytes
   * under a clean status, so it fails closed and names itself rather than
   * being caught by a reviewer.
   */
  'SCANNER_DOES_NOT_INSPECT',
] as const;

export type ScanFailureReason = (typeof SCAN_FAILURE_REASONS)[number];

export interface ScanResult {
  readonly verdict: ScanVerdict;
  /** The engine that produced it, recorded on the row so the claim is attributable. */
  readonly engine: string;
  /** Engine version, where one exists. */
  readonly engineVersion: string | null;
  /**
   * The signature database that answered.
   *
   * Kept apart from the engine version because they age independently: an
   * engine is upgraded on a release cadence and a signature database several
   * times a day. A `CLEAN` is only as good as this number, and a re-scan
   * campaign after a signature release can only be targeted if it was
   * recorded.
   */
  readonly signatureVersion: string | null;
  /** How old that database was when the verdict was reached. */
  readonly signatureAgeSeconds: number | null;
  /**
   * The signature name for an infection.
   *
   * Present only for `INFECTED`, and never a free-text engine message: a
   * message can echo file content, and this value is stored, logged and
   * published.
   */
  readonly signature: string | null;
  /** Set only for `FAILED`, and always set for it. */
  readonly failureReason: ScanFailureReason | null;
  /**
   * Whether trying again could plausibly succeed.
   *
   * A refused connection is retryable; an object too large for this
   * deployment's ceiling is not, and retrying it four more times only delays
   * the same answer while holding a queue slot. Advice to the worker, never a
   * licence: a retryable failure is still not a download.
   */
  readonly retryable: boolean;
  readonly scannedAt: Date;
}

/** What a scanner is asked to inspect. */
export interface ScanRequest {
  /**
   * Opens the bytes.
   *
   * A factory rather than a stream, so a retry inside one attempt re-opens
   * rather than replaying a stream that has already been consumed, and so
   * nothing is fetched for a request the scanner refuses on size alone.
   */
  readonly open: () => Promise<Readable>;
  /** Size as storage reports it — never as a client claimed. */
  readonly sizeBytes: number;
  /** The type established from the bytes at finalization. */
  readonly contentType: string;
  /**
   * Cancellation from the caller.
   *
   * The scanner has its own deadline; this is the worker's — shutdown, a lease
   * about to expire — and the two are different clocks.
   */
  readonly signal?: AbortSignal;
}

/**
 * What a scanner reports about itself.
 *
 * Separate from a scan because readiness has to answer before any document
 * exists, and because "the scanner is down" and "this document failed" are
 * different operational facts that a single call would conflate.
 */
export interface ScannerHealth {
  /** Reachable and able to answer. */
  readonly available: boolean;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly signatureVersion: string | null;
  readonly signatureAgeSeconds: number | null;
  /** Within the configured age this deployment will trust. */
  readonly signaturesFresh: boolean;
  /**
   * A short, safe description when something is wrong.
   *
   * Never an exception message: those carry host names, socket paths and
   * occasionally credentials, and this value reaches an unauthenticated
   * readiness probe.
   */
  readonly detail: string | null;
}

export interface MalwareScanner {
  /**
   * Whether this scanner actually inspects content.
   *
   * Part of the interface rather than a property of one implementation, for
   * the same reason `PaymentProvider.simulated` is (ADR-024): every caller,
   * every operator and every API response must be able to answer "was this
   * really scanned?" without knowing which implementation is bound.
   *
   * It is also enforced rather than merely reported. A `CLEAN` from a scanner
   * whose `inspectsContent` is `false` is refused by the worker and recorded
   * as `SCANNER_DOES_NOT_INSPECT`, because the alternative is a document that
   * is downloadable on the word of something that never opened it.
   */
  readonly inspectsContent: boolean;
  readonly name: string;

  scan(input: ScanRequest): Promise<ScanResult>;

  /** For the readiness probe and the signature-age metric. Never throws. */
  health(): Promise<ScannerHealth>;
}
