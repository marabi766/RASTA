import { z } from 'zod';
import { CANONICAL_VERSION } from './audit.canonical';

/**
 * What `GET /v1/audit-events/verify` answers.
 *
 * ## Four outcomes, because "valid: false" is four different situations
 *
 * A boolean would collapse "somebody changed a record" into the same answer as
 * "you asked about a week nothing happened in", and an operator woken at three
 * in the morning needs those to look different at a glance:
 *
 *   VALID                 every record in the window recomputed, and every link
 *                         between them held, seeded from a record outside the
 *                         window wherever one existed.
 *   DIVERGENT             a record did not recompute, or a link did not hold.
 *                         `firstDivergence` names where, and this is the only
 *                         outcome that touches
 *                         `rasta_audit_chain_verification_failures_total`.
 *   EMPTY                 the window holds no records at all. Not valid and not
 *                         broken: there is nothing to verify, and reporting
 *                         "valid" for it would let an empty answer stand in for
 *                         a proof.
 *   UNVERIFIABLE_LEGACY   the window contains at least one record written
 *                         before AUD-003, which carries no chain link. Nothing
 *                         backfills those, so nothing can recompute them. The
 *                         hashed part of the window is still checked and still
 *                         reported, but the window as a whole is **not** valid.
 *
 * That last one is narrow on purpose, and the narrowness is a security
 * property. A missing link only reads as legacy when the record sits *below*
 * the chain's recorded segment start (`audit_chain_head.first_sequence_no`,
 * written once and immutable thereafter). A missing link at or above that
 * position is `DIVERGENT` with reason `MISSING_CHAIN_LINK`. Without that
 * boundary the two would be one observation, and stripping a record's link
 * would be a way to have this endpoint describe integrity damage as history.
 *
 * `valid` is published as well, and is `true` for exactly one of the four. It
 * exists so a client cannot get the answer wrong by treating an unfamiliar
 * future status as success.
 *
 * ## What is deliberately not in this response
 *
 * No hashes. A digest tells a caller nothing they can act on — they cannot
 * recompute it without the canonical encoding and the row, and if they have
 * both they do not need this endpoint. What it *would* give is a stable
 * fingerprint of a record's exact contents to anyone allowed to call verify,
 * which is a wider disclosure than the record itself for no gain.
 *
 * No payloads either: a divergence names the record by id, month and chain
 * position, and a caller who is entitled to the record's contents can read it
 * through the endpoint that authorises for exactly that.
 */

/** The two scopes a verification may run in. */
export const VERIFICATION_SCOPES = ['ORGANIZATION', 'PLATFORM'] as const;

/** The four outcomes. Ordered from best to worst for a reader's benefit only. */
export const VERIFICATION_STATUSES = [
  'VALID',
  'EMPTY',
  'UNVERIFIABLE_LEGACY',
  'DIVERGENT',
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * How a chain broke — a closed set, and therefore safe as a metric label.
 *
 * Never an error message. A message can carry a row value, and a metric label
 * is the last place a value should reach (ADR-053 § 13).
 */
export const DIVERGENCE_REASONS = {
  /** The record's own contents no longer hash to the link stored beside it. */
  RECORD_HASH_MISMATCH: 'RECORD_HASH_MISMATCH',
  /** The record points at a predecessor that is not the record before it. */
  PREVIOUS_HASH_MISMATCH: 'PREVIOUS_HASH_MISMATCH',
  /**
   * A record at or after the chain's recorded segment start carries no link.
   *
   * Distinct from `UNVERIFIABLE_LEGACY`, and the distinction is the point. A
   * null hash *below* the segment start is a row written before the chain
   * existed. A null hash at or above it is a link that was removed from a
   * record the chain had already covered, which is integrity damage — and
   * without the recorded boundary the two would be the same observation
   * (`audit_chain_head.first_sequence_no`).
   */
  MISSING_CHAIN_LINK: 'MISSING_CHAIN_LINK',
  /**
   * The head names a position past the verified window, and no record stands
   * between the two — the chain's tail was removed.
   */
  CHAIN_TAIL_MISSING: 'CHAIN_TAIL_MISSING',
  /** The chain head is absent, behind the records, or names a record that
   * does not exist or does not match it. */
  CHAIN_HEAD_MISMATCH: 'CHAIN_HEAD_MISMATCH',
  /**
   * A walk that covered a whole chain segment verified a different number of
   * records than the head's `chain_length` counts.
   */
  CHAIN_LENGTH_MISMATCH: 'CHAIN_LENGTH_MISMATCH',
} as const;

export type DivergenceReason = (typeof DIVERGENCE_REASONS)[keyof typeof DIVERGENCE_REASONS];

/** Every reason, in one place, so the enum below cannot fall out of step. */
export const DIVERGENCE_REASON_VALUES = Object.values(DIVERGENCE_REASONS) as [
  DivergenceReason,
  ...DivergenceReason[],
];

const isoInstant = z.string().datetime({ offset: true });

const monthResultSchema = z
  .object({
    /** `YYYY-MM`, UTC. One chain per month, per ADR-053 § 6. */
    month: z.string().regex(/^\d{4}-\d{2}$/),
    status: z.enum(VERIFICATION_STATUSES),
    /** Records whose `occurredAt` fell inside the requested window. */
    recordsInRange: z.number().int().nonnegative(),
    /** Records whose link was actually recomputed and checked. */
    recordsVerified: z.number().int().nonnegative(),
    /** Records with no chain link — pre-AUD-003 rows. Never backfilled. */
    unchainedRecords: z.number().int().nonnegative(),
    /**
     * Whether the first checked record was seeded from a record outside the
     * window. False means the window starts at a chain segment's own first
     * record, which is a weaker statement and is published rather than hidden.
     */
    seededFromPredecessor: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A month cannot be `EMPTY` and have held records, and it cannot be
    // `VALID` while carrying a record nothing could recompute. Both are
    // enforced here rather than trusted to the service, because this schema is
    // the last thing the response passes through and a status that contradicts
    // its own counts is the one bug in this endpoint an operator would act on
    // and be wrong.
    if (value.status === 'EMPTY' && value.recordsInRange > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'EMPTY month reports records in range',
      });
    }
    if (value.status === 'VALID' && value.unchainedRecords > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'VALID month reports unchained records',
      });
    }
    if (value.status === 'UNVERIFIABLE_LEGACY' && value.unchainedRecords === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'UNVERIFIABLE_LEGACY month reports no unchained records',
      });
    }
  });

const divergenceSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/),
    /** The audit record's own id — enough to read it through the read API. */
    auditEventId: z.string(),
    occurredAt: isoInstant,
    /** 64-bit, so a string, like every other bigint this service publishes. */
    sequenceNo: z.string(),
    reason: z.enum(DIVERGENCE_REASON_VALUES),
  })
  .strict();

export const auditChainVerificationSchema = z
  .object({
    scope: z.enum(VERIFICATION_SCOPES),
    /**
     * The organization whose chain was verified — null for the platform chain.
     *
     * Echoed because verification always targets exactly one chain and a caller
     * who omitted the parameter should be able to see which one they got. It is
     * never read as authority: the scope was resolved from the verified token
     * before this response existed.
     */
    organizationId: z.string().nullable(),
    from: isoInstant,
    to: isoInstant,

    status: z.enum(VERIFICATION_STATUSES),
    /** True for `VALID` and nothing else. */
    valid: z.boolean(),

    /**
     * The canonical encoding version the recomputation used.
     *
     * Published because a verification result is only meaningful against a
     * stated encoding: if the encoding ever changes, an old result and a new
     * one are answers to different questions, and the version is what makes
     * that visible instead of confusing.
     */
    canonicalVersion: z.number().int(),

    recordsInRange: z.number().int().nonnegative(),
    recordsVerified: z.number().int().nonnegative(),
    unchainedRecords: z.number().int().nonnegative(),

    /** One entry per UTC month the window touched, in ascending order. */
    months: z.array(monthResultSchema),

    /** The earliest divergence found, in chain order. Null unless DIVERGENT. */
    firstDivergence: divergenceSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // ## Why the invariants are enforced here and not only where the response
    // is built
    //
    // Every one of them is a statement a caller will act on without reading the
    // rest of the object: an alerting rule reads `valid`, a runbook reads
    // `firstDivergence`, a dashboard sums the counts. A response that says
    // `valid: true` beside a `DIVERGENT` status is not a cosmetic defect — it
    // is the endpoint reporting the opposite of what it found — and the only
    // way to be sure it cannot leave this service is to refuse it at the
    // boundary rather than to trust the construction that produced it. The
    // service parses its own result through this schema before returning, so a
    // future edit that breaks one of these fails loudly instead of publishing
    // a comfortable lie.

    // `valid` is true for exactly one status. Published as well as `status` so
    // an unfamiliar future status can never be read as success by a client.
    if (value.valid !== (value.status === 'VALID')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['valid'],
        message: '`valid` is true only for status VALID',
      });
    }

    // A location, if and only if there is something located.
    if ((value.firstDivergence !== null) !== (value.status === 'DIVERGENT')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['firstDivergence'],
        message: '`firstDivergence` is non-null for exactly the DIVERGENT status',
      });
    }

    if (Date.parse(value.to) < Date.parse(value.from)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '`to` precedes `from`' });
    }

    // The platform chain has no organization and a tenant chain always has one.
    if ((value.organizationId === null) !== (value.scope === 'PLATFORM')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['organizationId'],
        message: '`organizationId` is null for exactly the PLATFORM scope',
      });
    }

    // The totals are the months' totals. A summary that does not add up would
    // let a partial walk look like a complete one.
    const sum = (pick: (m: (typeof value.months)[number]) => number): number =>
      value.months.reduce((total, month) => total + pick(month), 0);

    if (value.recordsInRange !== sum((m) => m.recordsInRange)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recordsInRange'],
        message: 'total does not equal the sum of its months',
      });
    }
    if (value.recordsVerified !== sum((m) => m.recordsVerified)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recordsVerified'],
        message: 'total does not equal the sum of its months',
      });
    }
    if (value.unchainedRecords !== sum((m) => m.unchainedRecords)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unchainedRecords'],
        message: 'total does not equal the sum of its months',
      });
    }

    // The walk stops at the first divergence, so at most one month can carry
    // one, it must be the last month reported, and the window's status must
    // agree with it.
    const divergentMonths = value.months.filter((month) => month.status === 'DIVERGENT');
    if (divergentMonths.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['months'],
        message: 'more than one month reports a divergence',
      });
    }
    if (divergentMonths.length > 0 !== (value.status === 'DIVERGENT')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'window status disagrees with its months',
      });
    }
    if (divergentMonths.length === 1 && value.months.at(-1)?.status !== 'DIVERGENT') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['months'],
        message: 'the divergent month is not the last month walked',
      });
    }
    if (
      value.firstDivergence !== null &&
      value.months.at(-1)?.month !== value.firstDivergence.month
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['firstDivergence'],
        message: 'the divergence is not in the last month walked',
      });
    }

    // `UNVERIFIABLE_LEGACY` is the window's verdict when nothing diverged and
    // something could not be checked — never a status reachable with a clean,
    // fully chained window.
    if (value.status === 'UNVERIFIABLE_LEGACY' && value.unchainedRecords === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'UNVERIFIABLE_LEGACY window reports no unchained records',
      });
    }
    if (value.status === 'VALID' && value.unchainedRecords > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'VALID window reports unchained records',
      });
    }
    if (value.status === 'EMPTY' && value.recordsInRange > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'EMPTY window reports records in range',
      });
    }
  });

export type AuditChainVerification = z.infer<typeof auditChainVerificationSchema>;
export type AuditChainMonthResult = z.infer<typeof monthResultSchema>;

/** The version every response this build produces reports. */
export const RESPONSE_CANONICAL_VERSION = CANONICAL_VERSION;
