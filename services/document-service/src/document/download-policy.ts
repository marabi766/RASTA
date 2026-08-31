/**
 * Whether a document may be handed to anyone, as a pure function.
 *
 * Separated from `DocumentService` deliberately. This is the single decision
 * that stands between a private object and a URL that works for whoever holds
 * it, so it should be enumerable in a test without a database, a bucket or an
 * HTTP request — every input, every output, listed.
 *
 * ## One rule, and it takes no configuration
 *
 * **Only `CLEAN` authorizes a download.** ADR-014 states it without
 * qualification — «تا اتمام اسکن بدافزار، فایل قابل دانلود نیست» — and a scan
 * that has not completed is not a scan that passed. Every other state is
 * refused, and no environment variable, deployment profile or demo flag can
 * change that:
 *
 *   **PENDING** — no scan pass has reached this document.
 *
 *   **NOT_SCANNED** — a scanner ran and inspected nothing. This is what the
 *   MVP stub records while Q-18 is open (`docs/24`), and it is the state that
 *   most invites a bypass, because refusing it means an MVP deployment can
 *   register documents and hand none of them back. That consequence is real
 *   and it is accepted: "nothing looked at these bytes" and "these bytes are
 *   safe" are different claims, and serving the first as if it were the second
 *   is the exact failure ADR-014 exists to prevent. Uploads and metadata
 *   registration work in MVP; downloads wait for a scanner.
 *
 *   **INFECTED** — an engine that inspects content said so.
 *
 *   **FAILED** — the scan errored. Treating a failure as permission would make
 *   every scanner outage a platform-wide bypass.
 *
 *   **QUARANTINED** — held pending review. Not in the current `ScanState`
 *   enum; named here because the refusal is a stated requirement and should
 *   answer with its own reason rather than fall through to the default.
 *
 * And one refusal is about existence rather than safety:
 *
 *   **DELETED** — the object is gone. Answered as "not found" rather than
 *   "refused", because a refusal confirms it once existed.
 *
 * ## Why there is no policy argument
 *
 * There was one. `DOCUMENT_ALLOW_UNSCANNED_DOWNLOAD` defaulted to `true` and
 * turned `NOT_SCANNED` into a download, which contradicted the accepted ADR
 * and made the platform's default posture permissive. It has been removed
 * rather than merely re-defaulted to `false`: a setting whose only purpose is
 * to switch off an invariant is a runtime bypass, and its presence invites the
 * production deployment that flips it. If the business wants downloadable
 * files before a real scanner exists, that is a product and security decision
 * recorded as an ADR amendment — not an environment default.
 *
 * A test that needs a successful download injects a test-only
 * {@link MalwareScanner} returning `CLEAN`, which exercises this function's
 * allow branch through the same door a real engine will use.
 */

export type RefusalReason =
  'PENDING' | 'NOT_SCANNED' | 'INFECTED' | 'FAILED' | 'QUARANTINED' | 'DELETED';

export type DownloadDecision =
  | { allowed: true }
  | { allowed: false; reason: RefusalReason; message: string; documentId: string };

export interface DownloadCandidate {
  readonly id: string;
  readonly status: string;
  readonly scanState: string;
}

export function canDownload(document: DownloadCandidate): DownloadDecision {
  if (document.status === 'DELETED') {
    return refuse(document, 'DELETED', 'This document has been deleted');
  }

  switch (document.scanState) {
    // The only branch that returns `allowed: true`, anywhere.
    case 'CLEAN':
      return { allowed: true };

    case 'PENDING':
      return refuse(
        document,
        'PENDING',
        'This document cannot be downloaded until its security scan completes',
      );

    case 'NOT_SCANNED':
      return refuse(
        document,
        'NOT_SCANNED',
        'This document has not been scanned for malware and cannot be downloaded',
      );

    case 'INFECTED':
      return refuse(
        document,
        'INFECTED',
        'This document was found to be infected and cannot be downloaded',
      );

    case 'FAILED':
      return refuse(document, 'FAILED', 'The security scan for this document did not complete');

    case 'QUARANTINED':
      return refuse(
        document,
        'QUARANTINED',
        'This document is quarantined and cannot be downloaded',
      );

    default:
      // An unrecognised state is refused rather than allowed. A state added to
      // the enum without a rule here must fail closed — the alternative is a
      // new state silently becoming downloadable.
      return refuse(document, 'PENDING', 'This document cannot be downloaded in its current state');
  }
}

function refuse(
  document: DownloadCandidate,
  reason: RefusalReason,
  message: string,
): DownloadDecision {
  return { allowed: false, reason, message, documentId: document.id };
}
