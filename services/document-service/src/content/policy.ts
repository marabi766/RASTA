import { RastaError } from '@rasta/nest-common';
import type { DetectedMime } from './magic-number';

/**
 * What may be uploaded, per class of document.
 *
 * ## These classes are not invented business rules
 *
 * Each one names a document the product document and `docs/04` already say the
 * platform holds — a contract, an insurance policy, a tender pack, a statement,
 * a supplier's licence, a photograph of damage, a progress report. The class
 * decides only **what a file may technically be**: which formats and how large.
 *
 * It deliberately does not encode retention, legal effect, approval authority
 * or who may see it. Those are product decisions this service has not been
 * given (AGENTS.md § 9), and inventing them here would be inventing business
 * facts. Object-level access is decided by grants and ownership, not by class.
 *
 * ## Why per-class limits at all
 *
 * A single global limit has to be as large as the largest legitimate document,
 * which makes it useless for the rest: a licence photograph is not allowed to
 * be twenty megabytes just because a tender pack may be. ADR-014 asks for a
 * size limit "به‌ازای نوع سند" — per document type — and this is that.
 */

export const DOCUMENT_CLASSES = [
  'CONTRACT',
  'INSURANCE_POLICY',
  'TENDER_DOCUMENT',
  'STATEMENT',
  'SUPPLIER_CREDENTIAL',
  'INSPECTION_REPORT',
  'DAMAGE_PHOTO',
  'PROGRESS_REPORT',
  'OTHER',
] as const;

export type DocumentClass = (typeof DOCUMENT_CLASSES)[number];

const PDF = 'application/pdf' as const;
const JPEG = 'image/jpeg' as const;
const PNG = 'image/png' as const;
const WEBP = 'image/webp' as const;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;

const MB = 1024 * 1024;

export interface ClassPolicy {
  readonly allowed: readonly DetectedMime[];
  readonly maxBytes: number;
}

/**
 * The allowlist and ceiling for each class.
 *
 * A photograph class does not accept a spreadsheet, and a contract class does
 * not accept a photograph — not because either is dangerous, but because a
 * document filed under the wrong class is a document nobody finds later, and
 * the narrower the allowlist the less there is to validate and render.
 */
export const CLASS_POLICY: Readonly<Record<DocumentClass, ClassPolicy>> = {
  CONTRACT: { allowed: [PDF, DOCX], maxBytes: 20 * MB },
  INSURANCE_POLICY: { allowed: [PDF, JPEG, PNG], maxBytes: 10 * MB },
  TENDER_DOCUMENT: { allowed: [PDF, DOCX, XLSX], maxBytes: 25 * MB },
  STATEMENT: { allowed: [PDF, XLSX], maxBytes: 15 * MB },
  SUPPLIER_CREDENTIAL: { allowed: [PDF, JPEG, PNG], maxBytes: 10 * MB },
  INSPECTION_REPORT: { allowed: [PDF, JPEG, PNG], maxBytes: 15 * MB },
  DAMAGE_PHOTO: { allowed: [JPEG, PNG, WEBP], maxBytes: 10 * MB },
  PROGRESS_REPORT: { allowed: [PDF, DOCX, JPEG, PNG], maxBytes: 20 * MB },
  OTHER: { allowed: [PDF, JPEG, PNG], maxBytes: 5 * MB },
};

export function policyFor(documentClass: DocumentClass): ClassPolicy {
  return CLASS_POLICY[documentClass];
}

/**
 * Checks a declared upload against its class, before any URL is issued.
 *
 * Runs at intent time on the client's *claims*, which is worth being precise
 * about: passing here means the request is plausible, not that the file is
 * what it says. The bytes are checked at finalize, against storage. Both are
 * necessary — refusing early avoids issuing a credential for an upload that
 * could never be accepted, and refusing late is what actually enforces it.
 */
export function assertDeclarationAllowed(
  documentClass: DocumentClass,
  declaredMime: string,
  declaredBytes: number,
  serviceMaxBytes: number,
): void {
  const policy = policyFor(documentClass);
  const declared = declaredMime.trim().toLowerCase();

  if (!(policy.allowed as readonly string[]).includes(declared)) {
    // Not the declared type itself: one that is not on the list is whatever
    // the client typed, and is not logged (S-09).
    throw RastaError.businessRule('This content type is not accepted for this document class', {
      documentClass,
      allowed: policy.allowed,
    });
  }

  if (declaredBytes <= 0) {
    throw RastaError.businessRule('An empty file cannot be uploaded', { documentClass });
  }

  const ceiling = Math.min(policy.maxBytes, serviceMaxBytes);
  if (declaredBytes > ceiling) {
    throw RastaError.businessRule('The declared size exceeds the limit for this document class', {
      documentClass,
      declaredBytes,
      maxBytes: ceiling,
    });
  }
}

/**
 * Checks what storage actually holds, at finalize.
 *
 * The declared values were a claim; these come from the object itself — the
 * size from its metadata and the type from its first bytes. A mismatch here is
 * the interesting case: it means the client uploaded something other than what
 * it asked permission for.
 */
export function assertObjectAllowed(
  documentClass: DocumentClass,
  detectedMime: DetectedMime,
  actualBytes: number,
  serviceMaxBytes: number,
): void {
  const policy = policyFor(documentClass);

  if (actualBytes <= 0) {
    throw RastaError.businessRule('The uploaded object is empty', { documentClass });
  }

  if (!(policy.allowed as readonly string[]).includes(detectedMime)) {
    throw RastaError.businessRule('The uploaded content type is not accepted for this class', {
      documentClass,
      detectedMime,
      allowed: policy.allowed,
    });
  }

  const ceiling = Math.min(policy.maxBytes, serviceMaxBytes);
  if (actualBytes > ceiling) {
    throw RastaError.businessRule('The uploaded object exceeds the limit for this class', {
      documentClass,
      actualBytes,
      maxBytes: ceiling,
    });
  }
}

/**
 * Reduces a client filename to something safe to store and display.
 *
 * **Display metadata only.** The object key is generated server-side and never
 * derived from this (ADR-014), so this is not a path-traversal defence —
 * traversal is impossible by construction because the name never reaches a
 * path. What this prevents is the second-order problem: a filename echoed into
 * a UI, a log line or a `Content-Disposition` header, carrying separators,
 * control characters or a right-to-left override that makes `evil.exe` render
 * as `evilexe.pdf`.
 */
export function sanitizeFilename(raw: string): string {
  const withoutPath = raw.replace(/^.*[\\/]/, '');
  const cleaned = withoutPath
    // Control characters, and every bidirectional control (`\p{Bidi_Control}`)
    // that lets a name lie about its own extension: the overrides and isolates,
    // and LRM, RLM and U+061C ARABIC LETTER MARK, which the list missed.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f\p{Bidi_Control}]/gu, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim();

  const safe = cleaned.length > 0 ? cleaned : 'document';
  return safe.slice(0, 200);
}
