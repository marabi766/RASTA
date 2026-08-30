import { z } from 'zod';

/**
 * Events published by document-service, on `rasta.document.v1`.
 *
 * The three names come from the platform catalogue (`docs/04` § document
 * service and `docs/events/README.md`). The payloads are defined here because
 * this service owns them; filling in another service's contract is inventing a
 * fact you do not own (ADR-032).
 *
 * ## What these payloads never carry
 *
 * **No signed URL, no object key, no file content, no checksum a caller could
 * use to fetch bytes elsewhere.** An event lives seven days in a log every
 * service can read (`docs/07` § 7.3). A signed URL on that log would be a
 * bearer credential for a private object, readable by every consumer for its
 * whole lifetime; an object key would let anyone with bucket credentials skip
 * this service's authorization entirely. A consumer that needs the file asks
 * this service for a download URL and is authorised at that moment.
 *
 * The filename is included because it is display metadata a consumer needs to
 * render a reference, and it has already been sanitised.
 *
 * ## What `DOCUMENT_UPLOADED` means, exactly
 *
 * That an object was confirmed to exist, its real content type was established
 * from its bytes, and metadata was registered. **It does not mean the document
 * was scanned, approved, or is safe to open.** The scan state is carried on
 * the event precisely so no consumer has to guess, and so a consumer cannot
 * read the event's existence as a clean bill of health.
 *
 * ## Version
 *
 * `eventVersion` is 1 for all three: new contracts, nothing to be compatible
 * with yet.
 */

export const DOCUMENT_EVENTS = {
  DOCUMENT_UPLOADED: 'DOCUMENT_UPLOADED',
  DOCUMENT_DELETED: 'DOCUMENT_DELETED',
  VIRUS_DETECTED: 'VIRUS_DETECTED',
} as const;

export type DocumentEventName = (typeof DOCUMENT_EVENTS)[keyof typeof DOCUMENT_EVENTS];

const isoTimestamp = z.string();
const identifier = z.string().min(1).max(64);

/**
 * The scan state as published.
 *
 * `NOT_SCANNED` is on the wire for the same reason it is in the database: a
 * consumer must be able to distinguish "examined and clean" from "never
 * examined", and an MVP that published `CLEAN` for unexamined content would
 * make that impossible after the fact.
 */
const scanState = z.enum(['PENDING', 'NOT_SCANNED', 'CLEAN', 'INFECTED', 'FAILED']);

export const documentUploadedPayload = z
  .object({
    documentId: identifier,
    organizationId: identifier,
    documentClass: z.string().min(1).max(64),
    /** The type established from the bytes, not the one the client declared. */
    contentType: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive(),
    /** Sanitised. Display only. */
    filename: z.string().min(1).max(255),
    /** What this service knows about scanning at publish time. */
    scanState,
    /** The resource another service says this belongs to, when one was named. */
    ownerResourceType: z.string().min(1).max(64).nullable(),
    ownerResourceId: identifier.nullable(),
    uploadedBy: z.string().min(1).max(64),
    uploadedAt: isoTimestamp,
  })
  .strict();

export const documentDeletedPayload = z
  .object({
    documentId: identifier,
    organizationId: identifier,
    documentClass: z.string().min(1).max(64),
    /**
     * Why it was deleted, as the actor stated it.
     *
     * Carried because a consumer holding a reference needs to know whether to
     * treat it as withdrawn or as superseded, and the alternative is every
     * consumer asking a human.
     */
    reason: z.string().min(1).max(500),
    deletedBy: z.string().min(1).max(64),
    deletedAt: isoTimestamp,
  })
  .strict();

/**
 * Published **only** for a real infected verdict from an engine that inspected
 * content.
 *
 * Never from the MVP stub, which inspects nothing and can therefore never
 * conclude that anything is infected. A `VIRUS_DETECTED` from a no-op scanner
 * would be a fabricated security finding — worse than silence, because
 * somebody would act on it.
 */
export const virusDetectedPayload = z
  .object({
    documentId: identifier,
    organizationId: identifier,
    /** The engine that found it. Never `no-op-stub`. */
    engine: z.string().min(1).max(64),
    engineVersion: z.string().min(1).max(64).nullable(),
    /** The signature name. Never a free-text engine message. */
    signature: z.string().min(1).max(255),
    detectedAt: isoTimestamp,
  })
  .strict();

export const DOCUMENT_EVENT_SCHEMAS = {
  DOCUMENT_UPLOADED: documentUploadedPayload,
  DOCUMENT_DELETED: documentDeletedPayload,
  VIRUS_DETECTED: virusDetectedPayload,
} as const satisfies Record<DocumentEventName, z.ZodTypeAny>;

/**
 * Validates a payload at publish time, not only in a test.
 *
 * `docs/07` § 7.8 requires runtime validation: a contract checked only by a
 * test is a contract that holds until somebody adds a field in a hurry.
 */
export function validateDocumentPayload<N extends DocumentEventName>(
  eventName: N,
  payload: unknown,
): z.infer<(typeof DOCUMENT_EVENT_SCHEMAS)[N]> {
  const schema = DOCUMENT_EVENT_SCHEMAS[eventName];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `${eventName} payload does not match its published contract: ${parsed.error.message}`,
    );
  }
  return parsed.data as z.infer<(typeof DOCUMENT_EVENT_SCHEMAS)[N]>;
}
