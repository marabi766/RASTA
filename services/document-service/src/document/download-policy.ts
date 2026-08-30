/**
 * Whether a document may be handed to anyone, as a pure function.
 *
 * Separated from `DocumentService` deliberately. This is the single decision
 * that stands between a private object and a URL that works for whoever holds
 * it, so it should be enumerable in a test without a database, a bucket or an
 * HTTP request — every input, every output, listed.
 *
 * ## The rules, and which are negotiable
 *
 * Two are absolute and take no configuration:
 *
 *   **PENDING** — no scan pass has reached this document. ADR-014: "تا اتمام
 *   اسکن بدافزار، فایل قابل دانلود نیست". Serving bytes nothing has looked at,
 *   while a status column implies otherwise, is the exact failure the rule
 *   exists to prevent.
 *
 *   **INFECTED** — an engine that inspects content said so. There is no
 *   configuration that should make this downloadable.
 *
 * One is configured, and only because Q-18 is open:
 *
 *   **NOT_SCANNED** — the MVP stub completed and inspected nothing. With no
 *   scanner in existence, refusing this too would mean no document on the
 *   platform is ever retrievable, which makes the capability inert rather than
 *   safe. `DOCUMENT_ALLOW_UNSCANNED_DOWNLOAD` governs it, defaults to allowing
 *   it, and every response says plainly that nothing was examined. The moment
 *   a real scanner exists this state stops occurring.
 *
 * And one is about existence rather than safety:
 *
 *   **DELETED** — the object is gone. Answered as "not found" rather than
 *   "refused", because a refusal confirms it once existed.
 */

export type RefusalReason = 'PENDING' | 'INFECTED' | 'FAILED' | 'NOT_SCANNED' | 'DELETED';

export type DownloadDecision =
  | { allowed: true }
  | { allowed: false; reason: RefusalReason; message: string; documentId: string };

export interface DownloadCandidate {
  readonly id: string;
  readonly status: string;
  readonly scanState: string;
}

export interface DownloadPolicy {
  /** Whether a completed-but-uninspected scan permits download (Q-18). */
  readonly allowUnscanned: boolean;
}

export function canDownload(document: DownloadCandidate, policy: DownloadPolicy): DownloadDecision {
  if (document.status === 'DELETED') {
    return {
      allowed: false,
      reason: 'DELETED',
      message: 'This document has been deleted',
      documentId: document.id,
    };
  }

  switch (document.scanState) {
    case 'CLEAN':
      return { allowed: true };

    case 'PENDING':
      return {
        allowed: false,
        reason: 'PENDING',
        message: 'This document cannot be downloaded until its security scan completes',
        documentId: document.id,
      };

    case 'INFECTED':
      return {
        allowed: false,
        reason: 'INFECTED',
        message: 'This document was found to be infected and cannot be downloaded',
        documentId: document.id,
      };

    case 'FAILED':
      return {
        allowed: false,
        reason: 'FAILED',
        // A scan that errored is not a scan that passed. Treating a failure as
        // permission would make every scanner outage a platform-wide bypass.
        message: 'The security scan for this document did not complete',
        documentId: document.id,
      };

    case 'NOT_SCANNED':
      if (policy.allowUnscanned) return { allowed: true };
      return {
        allowed: false,
        reason: 'NOT_SCANNED',
        message: 'This deployment does not serve documents that have not been scanned',
        documentId: document.id,
      };

    default:
      // An unrecognised state is refused rather than allowed. A state added to
      // the enum without a rule here must fail closed — the alternative is a
      // new state silently becoming downloadable.
      return {
        allowed: false,
        reason: 'PENDING',
        message: 'This document cannot be downloaded in its current state',
        documentId: document.id,
      };
  }
}
