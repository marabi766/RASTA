import { z } from 'zod';
import type { AdapterDescriptor } from '../adapter';
import type { GatewayClient } from '../client';

/**
 * The audit evidence store's read surface (AUD-001 through AUD-003).
 *
 * Three endpoints, mirrored from `services/audit-service/src/audit/*.ts` on
 * `main`: `GET /v1/audit-events`, `GET /v1/audit-events/{id}` and
 * `GET /v1/audit-events/verify`. There is no write route — `docs/04` § 4.15
 * is explicit that writing is from Kafka only — so this adapter exposes no
 * write method, and nothing in this module ever builds a request with a
 * method other than `GET`.
 *
 * `@rasta/contracts` carries no shared audit schema, so the shapes below are
 * written from the service's own DTOs (`audit.query.dto.ts`, `audit.view.ts`,
 * `audit.verification.view.ts`) rather than from a second, looser guess —
 * the same discipline every other adapter in this directory follows.
 *
 * Both list endpoints require `from`/`to`: `audit_event` is partitioned by
 * `occurredAt`, and the service refuses an unbounded window before running
 * any query. This adapter does not re-implement that ceiling — it sends
 * whatever window the caller asks for and lets the service's own
 * `400 VALIDATION_FAILED` (naming the configured limit) come back through the
 * normal error path.
 */

export const AUDIT_ADAPTER = {
  id: 'audit.events',
  service: 'audit-service',
  routes: ['GET /v1/audit-events', 'GET /v1/audit-events/{id}', 'GET /v1/audit-events/verify'],
} as const satisfies AdapterDescriptor;

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const AUDIT_ACTOR_TYPES = ['USER', 'SERVICE', 'SYSTEM', 'ANONYMOUS'] as const;
export const AUDIT_OUTCOMES = ['SUCCESS', 'FAILURE', 'REFUSED'] as const;
export const AUDIT_VERIFY_SCOPES = ['ORGANIZATION', 'PLATFORM'] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
export type AuditVerifyScope = (typeof AUDIT_VERIFY_SCOPES)[number];

export const AUDIT_ACTOR_TYPE_LABELS: Record<AuditActorType, string> = {
  USER: 'کاربر',
  SERVICE: 'سرویس',
  SYSTEM: 'سامانه',
  ANONYMOUS: 'ناشناس',
};

export const AUDIT_OUTCOME_LABELS: Record<AuditOutcome, string> = {
  SUCCESS: 'موفق',
  FAILURE: 'ناموفق',
  REFUSED: 'ردشده',
};

// ---------------------------------------------------------------------------
// The record — GET /v1/audit-events and GET /v1/audit-events/{id}
// ---------------------------------------------------------------------------

/**
 * Mirrors `auditEventViewSchema` (`audit.view.ts`).
 *
 * `changes` is `z.unknown().nullable()` here because the contract is: "always
 * null in path A, and a client must learn the true thing when it is not" —
 * not because this screen renders it. `AuditDetailView` never dumps this
 * field as raw JSON; see the component for why.
 */
export const auditEventViewSchema = z
  .object({
    id: z.string(),
    occurredAt: z.string(),
    recordedAt: z.string(),

    actorType: z.enum(AUDIT_ACTOR_TYPES),
    actorId: z.string().nullable(),
    actorRoles: z.array(z.string()),

    organizationId: z.string().nullable(),

    action: z.string(),
    resourceType: z.string(),
    resourceId: z.string().nullable(),

    outcome: z.enum(AUDIT_OUTCOMES),
    errorCode: z.string().nullable(),
    reason: z.string().nullable(),

    changes: z.unknown().nullable(),

    occurrenceCount: z.number().int(),

    sourceService: z.string(),
    sourceServiceVersion: z.string().nullable(),
    sourceEventId: z.string(),
    sourceEventName: z.string(),
    sourceTopic: z.string(),

    sourceIp: z.string().nullable(),
    sourceUserAgent: z.string().nullable(),

    correlationId: z.string(),
    causationId: z.string().nullable(),
    traceparent: z.string().nullable(),

    sourceStreamSeq: z.string().nullable(),
    sequenceNo: z.string(),

    integrity: z.enum(['CHAINED', 'UNCHAINED']),
  })
  .strict();

export type AuditEventView = z.infer<typeof auditEventViewSchema>;

export const auditEventPageSchema = z
  .object({
    items: z.array(auditEventViewSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export type AuditEventPage = z.infer<typeof auditEventPageSchema>;

export interface AuditEventSearchOptions {
  readonly organizationId?: string;
  readonly actorId?: string;
  readonly actorType?: AuditActorType;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly correlationId?: string;
  readonly outcome?: AuditOutcome;
  readonly limit?: number;
  /** Opaque. Pass back exactly what `nextCursor` returned — never decoded here. */
  readonly cursor?: string;
}

export async function searchAuditEvents(
  client: GatewayClient,
  window: { from: string; to: string },
  options: AuditEventSearchOptions = {},
  signal?: AbortSignal,
): Promise<AuditEventPage> {
  const result = await client.request({
    path: '/v1/audit-events',
    schema: auditEventPageSchema,
    signal,
    query: {
      from: window.from,
      to: window.to,
      organizationId: options.organizationId,
      actorId: options.actorId,
      actorType: options.actorType,
      action: options.action,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      correlationId: options.correlationId,
      outcome: options.outcome,
      limit: options.limit,
      cursor: options.cursor,
    },
  });

  return result.data;
}

export async function fetchAuditEvent(
  client: GatewayClient,
  id: string,
  window: { from: string; to: string },
  options: { organizationId?: string } = {},
  signal?: AbortSignal,
): Promise<AuditEventView> {
  const result = await client.request({
    path: `/v1/audit-events/${encodeURIComponent(id)}` as `/v1/${string}`,
    schema: auditEventViewSchema,
    signal,
    query: {
      from: window.from,
      to: window.to,
      organizationId: options.organizationId,
    },
  });

  return result.data;
}

// ---------------------------------------------------------------------------
// Chain verification — GET /v1/audit-events/verify
// ---------------------------------------------------------------------------

export const AUDIT_VERIFICATION_STATUSES = [
  'VALID',
  'EMPTY',
  'UNVERIFIABLE_LEGACY',
  'DIVERGENT',
] as const;

export type AuditVerificationStatus = (typeof AUDIT_VERIFICATION_STATUSES)[number];

/** Mirrors `DIVERGENCE_REASONS` (`audit.verification.view.ts`). A closed set. */
export const AUDIT_DIVERGENCE_REASONS = [
  'RECORD_HASH_MISMATCH',
  'PREVIOUS_HASH_MISMATCH',
  'MISSING_CHAIN_LINK',
  'CHAIN_TAIL_MISSING',
  'CHAIN_HEAD_MISMATCH',
  'CHAIN_LENGTH_MISMATCH',
] as const;

export type AuditDivergenceReason = (typeof AUDIT_DIVERGENCE_REASONS)[number];

const auditChainMonthResultSchema = z
  .object({
    month: z.string(),
    status: z.enum(AUDIT_VERIFICATION_STATUSES),
    recordsInRange: z.number().int().nonnegative(),
    recordsVerified: z.number().int().nonnegative(),
    unchainedRecords: z.number().int().nonnegative(),
    seededFromPredecessor: z.boolean(),
  })
  .strict();

const auditDivergenceSchema = z
  .object({
    month: z.string(),
    auditEventId: z.string(),
    occurredAt: z.string(),
    sequenceNo: z.string(),
    reason: z.enum(AUDIT_DIVERGENCE_REASONS),
  })
  .strict();

/**
 * Mirrors `auditChainVerificationSchema` (`audit.verification.view.ts`).
 *
 * The backend's copy additionally enforces a dozen cross-field invariants
 * (`valid` agrees with `status`, the month totals sum to the header, …) with
 * `superRefine` — that is the service proving its own response to itself
 * before it leaves the process. This client trusts the already-proven
 * response and only checks the shape, the same way every other adapter in
 * this directory does.
 */
export const auditChainVerificationSchema = z
  .object({
    scope: z.enum(AUDIT_VERIFY_SCOPES),
    organizationId: z.string().nullable(),
    from: z.string(),
    to: z.string(),

    status: z.enum(AUDIT_VERIFICATION_STATUSES),
    valid: z.boolean(),

    canonicalVersion: z.number().int(),

    recordsInRange: z.number().int().nonnegative(),
    recordsVerified: z.number().int().nonnegative(),
    unchainedRecords: z.number().int().nonnegative(),

    months: z.array(auditChainMonthResultSchema),

    firstDivergence: auditDivergenceSchema.nullable(),
  })
  .strict();

export type AuditChainVerification = z.infer<typeof auditChainVerificationSchema>;

export interface AuditVerifyOptions {
  readonly scope?: AuditVerifyScope;
  /** Refused by the service when combined with `scope: 'PLATFORM'`. */
  readonly organizationId?: string;
}

export async function verifyAuditChain(
  client: GatewayClient,
  window: { from: string; to: string },
  options: AuditVerifyOptions = {},
  signal?: AbortSignal,
): Promise<AuditChainVerification> {
  const result = await client.request({
    path: '/v1/audit-events/verify',
    schema: auditChainVerificationSchema,
    signal,
    query: {
      from: window.from,
      to: window.to,
      scope: options.scope,
      organizationId: options.organizationId,
    },
  });

  return result.data;
}
