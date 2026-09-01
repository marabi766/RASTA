import { z } from 'zod';
import { booleanEnv } from '@rasta/config';
import { DOCUMENT_CLASSES } from '../content/policy';

/**
 * The request shapes, validated at the boundary (AGENTS.md, `docs/06` § 6.4).
 *
 * Every one is `.strict()`. A misspelled field must be refused rather than
 * silently dropped — and here that matters more than usual, because the fields
 * a client is *not* allowed to send are the security-relevant ones. There is
 * no way to supply an object key, a scan state, a content type that overrides
 * the bytes, or an organization: each of those is decided by this service, and
 * `.strict()` is what makes "the client cannot set it" true rather than
 * merely intended.
 */

const identifier = z.string().min(1).max(64);

export const requestUploadUrlSchema = z
  .object({
    documentClass: z.enum(DOCUMENT_CLASSES),
    /**
     * What the client intends to upload.
     *
     * Checked against the class allowlist now and against the object's real
     * bytes at finalize. Both matter: refusing here avoids issuing a
     * credential for an upload that could never be accepted, and refusing
     * there is what actually enforces the rule.
     */
    contentType: z.string().min(3).max(255),
    /** Declared size, so an oversized upload is refused before it happens. */
    sizeBytes: z.number().int().positive(),
    /**
     * The client's filename, for display only.
     *
     * Sanitised on arrival and never used to build the object key (ADR-014).
     */
    filename: z.string().min(1).max(255),
  })
  .strict();

export type RequestUploadUrlDto = z.infer<typeof requestUploadUrlSchema>;

export const finalizeDocumentSchema = z
  .object({
    /**
     * The intent being redeemed.
     *
     * The client sends the intent id, **not** the object key. The key is read
     * from the intent row, which is what makes key substitution impossible
     * rather than merely detected: there is no field to substitute.
     */
    uploadIntentId: identifier,
    /**
     * What another service's resource this belongs to, if any.
     *
     * Recorded and never resolved: this service does not call asset-service to
     * check that the asset exists, because that would make document
     * registration fail when an unrelated service is down, and the reference
     * is meaningful to the caller either way (AGENTS.md A-01).
     */
    ownerResourceType: z.string().min(1).max(64).optional(),
    ownerResourceId: identifier.optional(),
  })
  .strict()
  .refine(
    (value) => (value.ownerResourceType === undefined) === (value.ownerResourceId === undefined),
    { message: 'An owner reference needs both a type and an id, or neither' },
  );

export type FinalizeDocumentDto = z.infer<typeof finalizeDocumentSchema>;

export const deleteDocumentSchema = z
  .object({
    /**
     * Why, in the actor's words.
     *
     * Required rather than optional: a tombstone without a reason answers
     * "who and when" but not "why", which is the question an auditor actually
     * asks. A minimum length stops "x" from satisfying it.
     */
    reason: z.string().min(8).max(500),
  })
  .strict();

export type DeleteDocumentDto = z.infer<typeof deleteDocumentSchema>;

/**
 * The document as a caller sees it, and the schema the OpenAPI document
 * publishes.
 *
 * One definition, not two. `DocumentView` is inferred from this rather than
 * declared beside it, so the shape the service returns and the shape the
 * contract advertises cannot drift — the failure that put a `201` in the
 * published document for an endpoint that answers `200` (commit cb8d435).
 *
 * ## What is missing, deliberately
 *
 * No object key, no bucket, no endpoint, no signed URL. A caller who could
 * read the key could try to reach the object with credentials obtained
 * elsewhere, bypassing every check this service makes, so the key never
 * crosses the API boundary at all (AGENTS.md S-09, ADR-014).
 *
 * ## What the scan fields mean
 *
 * `scanState` is the real lifecycle state (ADR-049) and a client must treat
 * everything but `CLEAN` as undownloadable — the download endpoint enforces
 * it, and a client that assumed otherwise would show a download button that
 * always fails. `PENDING` is what every document is registered in, because
 * scanning is asynchronous.
 */
export const documentViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  documentClass: z.string(),
  status: z.enum(['REGISTERED', 'DELETED']),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  filename: z.string(),

  /** The only value that permits a download is `CLEAN`. */
  scanState: z.enum(['PENDING', 'NOT_SCANNED', 'CLEAN', 'INFECTED', 'FAILED']),
  /** Whether an engine reached a conclusion about these bytes. */
  scanInspectedContent: z.boolean(),
  /** The engine that reached it — `clamav`, or `no-op-stub` for a historic row. */
  scanEngine: z.string().nullable(),
  /** The signature database that answered, so a clean verdict can be dated. */
  scanSignatureVersion: z.string().nullable(),
  /** The signature name, for an infection. A database entry name, not a message. */
  scanSignature: z.string().nullable(),
  /** A fixed reason code when scanning failed. Never engine text. */
  scanFailureReason: z.string().nullable(),
  /** When the quarantine policy was applied. Infections only. */
  quarantinedAt: z.string().nullable(),
  scannedAt: z.string().nullable(),

  ownerResourceType: z.string().nullable(),
  ownerResourceId: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string(),
  deletedAt: z.string().nullable(),
  deletionReason: z.string().nullable(),
});

export type DocumentView = z.infer<typeof documentViewSchema>;

export const listDocumentsQuerySchema = z
  .object({
    documentClass: z.enum(DOCUMENT_CLASSES).optional(),
    ownerResourceType: z.string().min(1).max(64).optional(),
    ownerResourceId: identifier.optional(),
    /**
     * Deleted documents are excluded unless explicitly asked for.
     *
     * `booleanEnv` rather than `z.coerce.boolean()`. The coercion applies
     * JavaScript's `Boolean()`, under which every non-empty string is true —
     * so `?includeDeleted=false` would have *included* them, which is the
     * opposite of what the caller asked for. The helper is named for where the
     * defect was first found; the parsing problem is the same wherever a
     * boolean arrives as a string. Every boolean *environment* flag on the
     * platform now reads through it too (D-020); the coercion survives only on
     * three query parameters in `asset-service` and `economic-service`, which
     * change an API response and so want their own atomic change.
     */
    includeDeleted: booleanEnv(false),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: identifier.optional(),
  })
  .strict();

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
