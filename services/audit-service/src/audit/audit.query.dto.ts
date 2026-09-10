import { z } from 'zod';
import { decodeAuditCursor, InvalidCursorError, type AuditCursor } from './audit.cursor';

/**
 * The query contract for `GET /v1/audit-events` and
 * `GET /v1/audit-events/{id}`.
 *
 * ## Everything here runs before the repository is reached
 *
 * ADR-053 § 10 requires a rejected window to cost **no query at all**: "more
 * than the ceiling → `400 VALIDATION_FAILED` naming the limit, not a silent
 * truncation". An unbounded range over a table partitioned across years scans
 * every partition, so a validation that ran after the query would have already
 * paid for the denial of service it exists to prevent.
 *
 * The mechanism is a pipe (`audit.query.pipes.ts`) rather than a check inside
 * the service, so the failure is structural: a handler receives a parsed value
 * or it is never entered. `audit.query.service.spec.ts` asserts it from the
 * other side, with a repository that throws if it is touched.
 *
 * ## Why the window ceiling is a factory parameter
 *
 * `AUDIT_MAX_QUERY_WINDOW_DAYS` is configuration with a default of 90, and the
 * error message names the configured value rather than the default. A schema
 * built at module load could only ever name the default, and an operator who
 * lowered the ceiling would get a 400 quoting a number their deployment does
 * not use.
 *
 * ## Which filters exist, and why not more
 *
 * `audit_event` carries five indexes: `(organizationId, occurredAt DESC)`,
 * `(occurredAt DESC)`, `(resourceType, resourceId, occurredAt DESC)`,
 * `(correlationId)` and `(sourceTopic, occurredAt DESC)`. Every filter below
 * is either one of those access paths or a residual predicate applied inside a
 * range already bounded by the mandatory window and, for a `UNION_ADMIN`, by a
 * single organization.
 *
 * `actorId`, `actorType`, `action` and `outcome` are residual: ADR-053 § 10
 * names actor and action as search fields, and they are answerable within a
 * bounded window without an index that does not exist. `resourceId` **requires**
 * `resourceType`, because the resource index is composite and a bare
 * `resourceId` would be the one filter here that reads as indexed and is not.
 *
 * There is no free-text search and no ordering parameter. Order is
 * `occurredAt DESC, id DESC`, always: a caller-chosen sort would need indexes
 * that do not exist, and a cursor is only stable under one ordering.
 */

/** Page size defaults, from ADR-053 § 3 — shared by every audit listing. */
export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 200;

/** The default ceiling for `AUDIT_MAX_QUERY_WINDOW_DAYS`. */
export const DEFAULT_MAX_QUERY_WINDOW_DAYS = 90;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** Bounds mirrored from the migration's column widths. */
const FILTER_LIMITS = {
  organizationId: 128,
  actorId: 256,
  action: 256,
  resourceType: 128,
  resourceId: 256,
  correlationId: 128,
} as const;

const filterString = (max: number): z.ZodString => z.string().trim().min(1).max(max);

const actorTypeValues = ['USER', 'SERVICE', 'SYSTEM', 'ANONYMOUS'] as const;
const outcomeValues = ['SUCCESS', 'FAILURE', 'REFUSED'] as const;

/**
 * An ISO 8601 instant with an explicit offset.
 *
 * The offset is required rather than assumed. `2026-09-01T00:00:00` is a
 * different instant in Tehran than in UTC, and a window boundary that shifts
 * with the reader's assumption is a window whose size cannot be checked. The
 * platform stores UTC and converts only in the presentation layer, so the
 * boundary a client sends must say which instant it means.
 */
const instant = z.string().datetime({ offset: true });

/**
 * `from` and `to`, the two parameters no audit query may omit.
 *
 * Shared by the list and the detail endpoint. The detail endpoint needs them
 * for a different reason and the reason is worth stating where it is enforced:
 * `audit_event`'s identity is `(occurred_at, id)` because PostgreSQL requires
 * the partition key in every unique index on a partitioned table. A lookup by
 * `id` alone is therefore a scan of every partition — nineteen today, more
 * every year — and would be the one endpoint in this service that ignores the
 * mandatory window the ADR introduced to make partition pruning work.
 */
const windowShape = {
  from: instant,
  to: instant,
};

const commonFilterShape = {
  organizationId: filterString(FILTER_LIMITS.organizationId).optional(),
};

/** What a validated list query looks like once the pipe has run. */
export interface AuditEventQuery {
  readonly from: Date;
  readonly to: Date;
  readonly organizationId?: string;
  readonly actorId?: string;
  readonly actorType?: (typeof actorTypeValues)[number];
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly correlationId?: string;
  readonly outcome?: (typeof outcomeValues)[number];
  readonly limit: number;
  readonly cursor?: AuditCursor;
}

/** What a validated detail query looks like. */
export interface AuditEventDetailQuery {
  readonly from: Date;
  readonly to: Date;
  readonly organizationId?: string;
}

/**
 * Applies the two rules that need both boundaries at once.
 *
 * Reported as issues on `to` rather than thrown, so a client gets one 400
 * listing every problem with the request instead of one problem per round trip.
 */
function refineWindow(
  value: { from: string; to: string },
  ctx: z.RefinementCtx,
  maxWindowDays: number,
): void {
  const from = new Date(value.from);
  const to = new Date(value.to);

  if (to.getTime() < from.getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: '`to` must not be earlier than `from`',
    });
    // Returning here keeps the width check from also reporting a negative
    // window as "too wide", which would be true and unhelpful.
    return;
  }

  const days = (to.getTime() - from.getTime()) / MILLISECONDS_PER_DAY;
  if (days > maxWindowDays) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      // Names the configured ceiling, as ADR-053 § 10 requires. A message that
      // said only "window too large" would leave a client guessing at the
      // number, and guessing means retrying — which is the load the ceiling
      // exists to prevent.
      message:
        `The query window must not exceed ${maxWindowDays} days ` +
        `(AUDIT_MAX_QUERY_WINDOW_DAYS); this request covers ${days.toFixed(2)} days`,
    });
  }
}

/**
 * Builds the list query schema for a configured window ceiling.
 *
 * `.strict()` matters here beyond tidiness: an unrecognised parameter is a
 * client believing in a filter that does not exist, and silently dropping it
 * would answer a narrower question than the one that was asked while looking
 * like it had answered the right one. On an audit search that is a wrong
 * answer, not a cosmetic one.
 */
export function buildAuditEventQuerySchema(
  maxWindowDays: number = DEFAULT_MAX_QUERY_WINDOW_DAYS,
): z.ZodType<AuditEventQuery, z.ZodTypeDef, unknown> {
  return z
    .object({
      ...windowShape,
      ...commonFilterShape,
      actorId: filterString(FILTER_LIMITS.actorId).optional(),
      actorType: z.enum(actorTypeValues).optional(),
      action: filterString(FILTER_LIMITS.action).optional(),
      resourceType: filterString(FILTER_LIMITS.resourceType).optional(),
      resourceId: filterString(FILTER_LIMITS.resourceId).optional(),
      correlationId: filterString(FILTER_LIMITS.correlationId).optional(),
      outcome: z.enum(outcomeValues).optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_LIMIT)
        .default(DEFAULT_PAGE_LIMIT)
        .describe(`Page size. Defaults to ${DEFAULT_PAGE_LIMIT}, capped at ${MAX_PAGE_LIMIT}.`),
      cursor: z.string().min(1).max(512).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      refineWindow(value, ctx, maxWindowDays);

      if (value.resourceId !== undefined && value.resourceType === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resourceType'],
          message: '`resourceId` may only be used together with `resourceType`',
        });
      }

      if (value.cursor !== undefined) {
        try {
          decodeAuditCursor(value.cursor);
        } catch (error) {
          if (!(error instanceof InvalidCursorError)) throw error;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['cursor'],
            message: 'The cursor is not valid',
          });
        }
      }
    })
    .transform((value): AuditEventQuery => ({
      from: new Date(value.from),
      to: new Date(value.to),
      organizationId: value.organizationId,
      actorId: value.actorId,
      actorType: value.actorType,
      action: value.action,
      resourceType: value.resourceType,
      resourceId: value.resourceId,
      correlationId: value.correlationId,
      outcome: value.outcome,
      limit: value.limit,
      cursor: value.cursor === undefined ? undefined : decodeAuditCursor(value.cursor),
    }));
}

/** Builds the detail query schema for a configured window ceiling. */
export function buildAuditEventDetailQuerySchema(
  maxWindowDays: number = DEFAULT_MAX_QUERY_WINDOW_DAYS,
): z.ZodType<AuditEventDetailQuery, z.ZodTypeDef, unknown> {
  return z
    .object({ ...windowShape, ...commonFilterShape })
    .strict()
    .superRefine((value, ctx) => refineWindow(value, ctx, maxWindowDays))
    .transform((value): AuditEventDetailQuery => ({
      from: new Date(value.from),
      to: new Date(value.to),
      organizationId: value.organizationId,
    }));
}

/**
 * The path parameter.
 *
 * Bounded to the column width and to the identifier alphabet so a probe cannot
 * put an arbitrary string into a parameter binding, and so an obviously
 * impossible id costs a 400 rather than an index lookup.
 */
export const auditEventIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z_-]+$/, 'Not a valid audit event id');

/** The schemas the OpenAPI document publishes, at the configured ceiling. */
export const auditEventQuerySchema = buildAuditEventQuerySchema();
export const auditEventDetailQuerySchema = buildAuditEventDetailQuerySchema();
