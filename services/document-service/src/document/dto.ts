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
     * boolean arrives as a string. The same coercion is still used for the
     * five platform environment flags listed in `PROJECT_MEMORY.md`, which are
     * deliberately left for their own atomic change.
     */
    includeDeleted: booleanEnv(false),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: identifier.optional(),
  })
  .strict();

export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
