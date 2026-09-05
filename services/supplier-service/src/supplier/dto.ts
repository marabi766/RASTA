import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { SUPPLIER_CAPABILITIES } from './capabilities';
import { QUALIFICATION_STATES } from './qualification.state-machine';
import { SUPPLIER_STATUSES } from './suspension.state-machine';

/**
 * The request shapes, validated at the boundary (AGENTS.md § 3, `docs/06` § 6.4).
 *
 * Every one is `.strict()`, and here that is a security control rather than
 * tidiness. The fields a client is **not** allowed to send are exactly the
 * security-relevant ones:
 *
 *   organizationId    decided by the verified token, never by the body. A body
 *                     field would let a supplier register a profile for
 *                     somebody else's organization.
 *   status            decided by SuspendSupplier and ReinstateSupplier, which
 *                     are platform-operator commands. A supplier that could set
 *                     it would lift its own suspension.
 *   state             a qualification's state is decided by a reviewer. A
 *                     submitter that could set it would approve itself.
 *   decidedBy         taken from the request context, so an approval always
 *                     names the human who actually made it.
 *   score / rating    there is no such field anywhere, and `.strict()` is what
 *                     makes a client sending one get a 400 instead of having it
 *                     quietly ignored.
 *
 * `.strict()` is what makes each of those "the client cannot set it" rather
 * than merely "the service happens not to read it today".
 */

const identifier = z.string().trim().min(1).max(64);
const capability = z.enum(SUPPLIER_CAPABILITIES);

/**
 * A reason somebody will read months later.
 *
 * The eight-character floor is the same one document-service uses on a deletion
 * reason, and for the same reason: a required field that "x" satisfies answers
 * who and when but not why, which is the question an audit actually asks.
 */
const statedReason = z.string().trim().min(8).max(500);

// ---------------------------------------------------------------------------
// RegisterSupplier
// ---------------------------------------------------------------------------

export const registerSupplierSchema = z
  .object({
    displayName: z.string().trim().min(2).max(200),
    /**
     * What this organization claims it does. Claiming is not qualification —
     * nothing here grants anything, and `SUPPLIER_REGISTERED` names the field
     * `capabilities` rather than `qualifiedFor` for that reason.
     */
    capabilities: z.array(capability).min(1).max(SUPPLIER_CAPABILITIES.length),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Also a unique index in PostgreSQL. Both, because the index makes the
    // invariant true for every write path and this makes the refusal a 400 that
    // names the field instead of a constraint violation surfacing as a 500.
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities'],
        message: 'A capability may be claimed only once',
      });
    }
  });

export type RegisterSupplierDto = z.infer<typeof registerSupplierSchema>;

// ---------------------------------------------------------------------------
// SubmitQualification
// ---------------------------------------------------------------------------

/**
 * One reference to a document held by document-service.
 *
 * `documentId` is opaque and is stored, never resolved. This service does not
 * call document-service in this phase — there is no service-to-service metadata
 * endpoint suitable for it — so nothing here checks that the id names a real
 * document, that the caller may read it, or that it is what the label says.
 *
 * `.trim().min(1)` is the DTO half of "evidence references cannot be empty
 * strings"; `ck_evidence_document_id_not_blank` is the half that holds for
 * every future write path.
 */
export const qualificationEvidenceInputSchema = z
  .object({
    documentId: identifier,
    /** What the submitter says this document is. Their words, not a verdict. */
    label: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const submitQualificationSchema = z
  .object({
    capability,
    /** What the supplier says about itself. Optional, and never a decision. */
    statement: z.string().trim().min(1).max(2000).optional(),
    /**
     * Evidence is optional.
     *
     * No accepted document says a submission must carry documents, or which
     * documents, or how many. Requiring some number would be inventing an
     * admissions rule (AGENTS.md § 9); the reviewer decides what is enough, and
     * a submission with nothing attached is one a reviewer can reject.
     */
    evidence: z.array(qualificationEvidenceInputSchema).max(20).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.evidence.map((item) => item.documentId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'The same document may be attached only once',
      });
    }
  });

export type SubmitQualificationDto = z.infer<typeof submitQualificationSchema>;

// ---------------------------------------------------------------------------
// ApproveQualification / RejectQualification
// ---------------------------------------------------------------------------

export const approveQualificationSchema = z
  .object({
    /**
     * The reviewer's own account of the decision. **Private**: it is stored,
     * shown to the supplier's own organization and to platform operators, and
     * never published on an event or through the directory.
     */
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export type ApproveQualificationDto = z.infer<typeof approveQualificationSchema>;

export const rejectQualificationSchema = z
  .object({
    /**
     * Why, stated for the supplier. Required, and published on
     * `SUPPLIER_REJECTED` — a rejection the supplier cannot see the reason for
     * is a decision they can never act on.
     */
    reason: statedReason,
    /** The reviewer's private note. Never published. */
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export type RejectQualificationDto = z.infer<typeof rejectQualificationSchema>;

// ---------------------------------------------------------------------------
// SuspendSupplier / ReinstateSupplier
// ---------------------------------------------------------------------------

export const suspendSupplierSchema = z
  .object({
    reason: statedReason,
  })
  .strict();

export type SuspendSupplierDto = z.infer<typeof suspendSupplierSchema>;

export const reinstateSupplierSchema = z
  .object({
    /**
     * Why the suspension is being lifted. Required for the same reason the
     * suspension reason is: a lifting nobody explained is a gap in the record
     * precisely where somebody will later ask what happened.
     *
     * Stored in `suspension.reinstatement_note`, on the episode it closes.
     */
    reason: statedReason,
  })
  .strict();

export type ReinstateSupplierDto = z.infer<typeof reinstateSupplierSchema>;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * SearchSuppliers — the public directory.
 *
 * Deliberately narrow. There is no free-text name search and no sort parameter:
 * `docs/04` § 4.10 names OpenSearch as a dependency of the eventual service and
 * this phase has none, so an unindexed `ILIKE '%...%'` over a growing table
 * would be the denial-of-service vector `packages/contracts` pagination warns
 * about. Filtering is by the indexed enum columns only.
 *
 * `sort=RATING` is likewise absent rather than accepted-and-ignored, which is
 * the choice ADR-042 already made on the marketplace side.
 */
export const searchSuppliersQuerySchema = cursorPaginationSchema
  .extend({
    /** Suppliers that *claim* this capability. Claiming is not qualification. */
    capability: capability.optional(),
    /** Suppliers with a **current** approval for this capability. */
    qualifiedFor: capability.optional(),
    status: z.enum(SUPPLIER_STATUSES).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // `qualifiedFor` implies ACTIVE: a suspended supplier is never currently
    // qualified. Asking for both is a contradiction, and the honest answer is a
    // 400 that says so rather than an empty page the caller has to interpret —
    // or, worse, one filter silently overwriting the other.
    if (value.qualifiedFor && value.status === 'SUSPENDED') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message:
          'qualifiedFor already implies an active supplier; a suspended supplier is never ' +
          'currently qualified, so the two filters cannot be combined',
      });
    }
  });

export type SearchSuppliersQuery = z.infer<typeof searchSuppliersQuerySchema>;

/**
 * ListQualifiedFor — the question another service will eventually ask.
 *
 * `capability` is required rather than optional: "list everyone qualified" is a
 * different query with a different cost, and a caller that forgot the filter
 * should get a 400 rather than the whole directory.
 */
export const listQualifiedForQuerySchema = cursorPaginationSchema
  .extend({
    capability,
  })
  .strict();

export type ListQualifiedForQuery = z.infer<typeof listQualifiedForQuerySchema>;

/** The reviewer's queue. Platform operators only — see `access.ts`. */
export const reviewQueueQuerySchema = cursorPaginationSchema
  .extend({
    state: z.enum(QUALIFICATION_STATES).default('SUBMITTED'),
    capability: capability.optional(),
  })
  .strict();

export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;

// ---------------------------------------------------------------------------
// Response shapes
//
// One definition, not two: the service's return types are inferred from these
// and the OpenAPI document is generated from them, so the shape the service
// sends and the shape the contract advertises cannot drift.
// ---------------------------------------------------------------------------

/**
 * What a stranger may see. The catalogue-safe projection.
 *
 * Built and tested in `views.ts`. Everything absent from it is absent
 * deliberately: no evidence document ids, no decision notes, no actor ids, no
 * suspension reason, no submitted-but-undecided qualifications.
 */
export const supplierDirectoryViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    displayName: z.string(),
    status: z.enum(SUPPLIER_STATUSES),
    /** Claimed. */
    capabilities: z.array(capability),
    /**
     * Approved **and** not suspended. Empty for a suspended supplier, because
     * "a suspended supplier cannot be returned as currently qualified".
     */
    qualifiedFor: z.array(capability),
    registeredAt: z.string(),
  })
  .strict();

export const qualificationViewSchema = z
  .object({
    id: z.string(),
    capability,
    state: z.enum(QUALIFICATION_STATES),
    statement: z.string().nullable(),
    submittedBy: z.string(),
    submittedAt: z.string(),
    decidedBy: z.string().nullable(),
    decidedAt: z.string().nullable(),
    /** Private. Present only in the detail view. */
    decisionNote: z.string().nullable(),
    evidence: z.array(z.object({ documentId: z.string(), label: z.string().nullable() }).strict()),
    /**
     * Whether this approval counts right now.
     *
     * Derived, never stored: a stored flag would have to be maintained on both
     * suspension and reinstatement, and the first missed update would leave a
     * suspended supplier answering ListQualifiedFor.
     */
    current: z.boolean(),
  })
  .strict();

export const suspensionViewSchema = z
  .object({
    id: z.string(),
    reason: z.string(),
    suspendedBy: z.string(),
    suspendedAt: z.string(),
    reinstatedBy: z.string().nullable(),
    reinstatedAt: z.string().nullable(),
    reinstatementNote: z.string().nullable(),
    open: z.boolean(),
  })
  .strict();

/** The private view: the caller's own organization, or a platform operator. */
export const supplierDetailViewSchema = supplierDirectoryViewSchema
  .extend({
    registeredBy: z.string(),
    qualifications: z.array(qualificationViewSchema),
    suspensions: z.array(suspensionViewSchema),
  })
  .strict();

export type SupplierDirectoryView = z.infer<typeof supplierDirectoryViewSchema>;
export type QualificationView = z.infer<typeof qualificationViewSchema>;
export type SuspensionView = z.infer<typeof suspensionViewSchema>;
export type SupplierDetailView = z.infer<typeof supplierDetailViewSchema>;
