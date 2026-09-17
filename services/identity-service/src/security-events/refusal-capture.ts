import { isIP } from 'node:net';
import type { RequestContext } from '@rasta/nest-common';
import {
  assertPublishableAuditTrailRow,
  toSecurityEventOutboxRow,
  type SecurityEventRecord,
} from './audit-trail-envelope';
import {
  refusalSiteOf,
  trustedAttributionOf,
  type GuardRefusalSite,
  type RefusalSite,
} from './refusal-sites';

/**
 * The decision the refusal filter makes, as a pure function (ADR-053 § 4).
 *
 * No I/O, no clock and no id generator of its own — all three are passed in —
 * so every branch below is a unit test rather than a database round trip.
 *
 * ## Where each value comes from
 *
 *   action, resourceType,   the refusal site (`refusal-sites.ts`) — code, never
 *   reason, errorCode       the URL or the body
 *   actor type, id, roles,  the verified token: through the frozen request
 *   organization            context the auth guard upgraded, or — for the
 *                           sites the guard itself decides, before there is
 *                           any such context — through the trusted attribution
 *                           that guard's seams supplied (Phases C10, C11)
 *   resource id             the actor's own id — user or calling service (the
 *                           site says which)
 *   ip, user agent,         the request-context middleware — bounded and
 *   correlation, trace      shape-checked here, or left out
 *
 * The request body, the query string, the `Authorization` header and the
 * exception message are not inputs to this function at all, so there is no path
 * by which one of them reaches a persisted row.
 */

/** `audit_event.actor_id VARCHAR(256)` and the contract bound. */
const ACTOR_ID_MAX_LENGTH = 256;
/** `audit_event.organization_id VARCHAR(128)` and the contract bound. */
const ORGANIZATION_ID_MAX_LENGTH = 128;
/** The contract's role-list bound; a longer list is not truncated into a different claim. */
const ACTOR_ROLES_MAX = 64;
/** A single role name. Roles are short platform constants; anything longer is not one. */
const ROLE_MAX_LENGTH = 128;
/** `audit_event.source_ip VARCHAR(64)`. */
const SOURCE_IP_MAX_LENGTH = 64;
/** `audit_event.source_user_agent VARCHAR(512)` and the contract bound. */
const USER_AGENT_MAX_LENGTH = 512;
/** `producer_version VARCHAR(64)`. */
const PRODUCER_VERSION_MAX_LENGTH = 64;
const FALLBACK_PRODUCER_VERSION = '0.0.0';

/** `audit_event.correlation_id VARCHAR(128)`, restricted to identifier characters. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/** The first printable code point, and DEL — the C0 controls sit below the one. */
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/**
 * The roles recorded for a service actor: exactly the ones the platform
 * `AuthGuard` grants every verified service caller (`roles: ['SERVICE']`).
 * Code-authored — a service token carries no role claim to copy.
 */
const SERVICE_ACTOR_ROLES: readonly string[] = Object.freeze(['SERVICE']);

/** Why a marked refusal was not captured. Closed, so it is safe in a log line. */
export const CAPTURE_SKIP_REASONS = {
  CLASSIFICATION_MISMATCH: 'classification_mismatch',
  ROUTE_MISMATCH: 'route_mismatch',
  NOT_AUTHENTICATED_USER: 'not_authenticated_user',
  UNATTRIBUTABLE: 'unattributable',
  CONTRACT_VIOLATION: 'contract_violation',
} as const;
export type CaptureSkipReason = (typeof CAPTURE_SKIP_REASONS)[keyof typeof CAPTURE_SKIP_REASONS];

/** What the filter observed about one exception, after the platform classified it. */
export interface RefusalObservation {
  exception: unknown;
  /** The status the platform exception filter chose. */
  status: number;
  /** The platform error code in the body the platform exception filter built. */
  code: string | undefined;
  method: string | undefined;
  /** The matched route template (`req.route.path`), never the concrete URL. */
  route: string | undefined;
  context: RequestContext | undefined;
}

export interface CaptureEnvironment {
  now: Date;
  newId: () => string;
  producerVersion: string;
}

export type SecurityEventDraft = SecurityEventRecord;

export type CaptureDecision =
  | { kind: 'NOT_A_REFUSAL_SITE' }
  | { kind: 'SKIP'; site: RefusalSite; reason: CaptureSkipReason }
  | { kind: 'CAPTURE'; site: RefusalSite; draft: SecurityEventDraft };

const isNonBlank = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Removes C0 control characters and DEL. PostgreSQL refuses NUL in text, and
 * nothing that belongs in a user agent is a control character.
 */
function withoutControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= FIRST_PRINTABLE_CODE && code !== DELETE_CODE) result += character;
  }
  return result;
}

function sourceIpOf(ip: string | undefined): string | null {
  if (!ip || ip.length > SOURCE_IP_MAX_LENGTH) return null;
  return isIP(ip) === 0 ? null : ip;
}

function userAgentOf(userAgent: string | undefined): string | null {
  if (typeof userAgent !== 'string') return null;
  // Truncated rather than refused: a user agent is descriptive metadata, and a
  // long one is still worth its first 512 characters as evidence.
  const cleaned = withoutControlCharacters(userAgent).trim().slice(0, USER_AGENT_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The correlation id, if it is identifier-shaped. A caller controls
 * `x-correlation-id`, so anything else falls back to the request id this
 * service minted — a ULID — and failing that, the event id.
 */
function correlationIdOf(context: RequestContext, eventId: string): string {
  if (SAFE_CORRELATION_ID.test(context.correlationId)) return context.correlationId;
  if (SAFE_CORRELATION_ID.test(context.requestId)) return context.requestId;
  return eventId;
}

function traceparentOf(context: RequestContext): string | null {
  const { traceId, spanId } = context;
  if (!traceId || !spanId || !TRACE_ID.test(traceId) || !SPAN_ID.test(spanId)) return null;
  return `00-${traceId}-${spanId}-01`;
}

/** Deduplicated, order-preserving, and refused rather than truncated when out of bounds. */
function rolesOf(roles: readonly string[]): string[] | null {
  const unique = [...new Set(roles)];
  if (unique.length > ACTOR_ROLES_MAX) return null;
  if (unique.some((role) => !isNonBlank(role) || role.length > ROLE_MAX_LENGTH)) return null;
  return unique;
}

function producerVersionOf(version: string): string {
  return isNonBlank(version) && version.length <= PRODUCER_VERSION_MAX_LENGTH
    ? version
    : FALLBACK_PRODUCER_VERSION;
}

/** Who a capture is attributed to, and the tenant it is filed under. */
interface Attribution {
  actorType: 'USER' | 'SERVICE';
  actorId: string;
  roles: readonly string[];
  /** `undefined` is a platform row. */
  organizationId: string | undefined;
}

/**
 * The attribution of an auth-guard site, from the trusted values that guard's
 * seam supplied — or `undefined` when there is none that matches the site
 * exactly.
 *
 * The site decides which kind of actor it records (`resource`) and what an
 * untenanted attribution means (`withoutTenant`); an attribution of the other
 * kind is never re-read as this one.
 */
function guardAttributionOf(site: GuardRefusalSite, exception: unknown): Attribution | undefined {
  const trusted = trustedAttributionOf(exception);
  if (trusted === undefined) return undefined;

  if (trusted.actorType === 'USER') {
    if (site.resource !== 'ACTOR_USER') return undefined;
    // The tenant the caller legitimately acts for, never the one they asked
    // for and were refused.
    if (!isNonBlank(trusted.userId) || !isNonBlank(trusted.organizationId)) return undefined;
    return {
      actorType: 'USER',
      actorId: trusted.userId,
      roles: trusted.roles,
      organizationId: trusted.organizationId,
    };
  }

  if (site.resource !== 'ACTOR_SERVICE' || !isNonBlank(trusted.callerService)) return undefined;
  // The token's signed tenant, or none. A blank one is not "none": it is a
  // claim this capture cannot interpret, so it is not recorded at all.
  let organizationId: string | undefined;
  if (trusted.organizationId === null) {
    if (site.withoutTenant !== 'PLATFORM') return undefined;
  } else if (isNonBlank(trusted.organizationId)) {
    organizationId = trusted.organizationId;
  } else {
    return undefined;
  }
  return {
    actorType: 'SERVICE',
    actorId: trusted.callerService,
    roles: SERVICE_ACTOR_ROLES,
    organizationId,
  };
}

/**
 * Decides whether one exception becomes one `security_event_outbox` row, and
 * builds that row if so.
 *
 * Fail-closed in the audit sense: anything that cannot be attributed exactly
 * is **not recorded** rather than recorded approximately. That never loosens
 * the refusal — the caller is refused either way; this only decides whether
 * evidence of it is kept.
 */
export function decideCapture(
  observation: RefusalObservation,
  environment: CaptureEnvironment,
): CaptureDecision {
  const site = refusalSiteOf(observation.exception);
  if (site === undefined) return { kind: 'NOT_A_REFUSAL_SITE' };

  const skip = (reason: CaptureSkipReason): CaptureDecision => ({ kind: 'SKIP', site, reason });

  // The platform filter's final classification must be the one the site
  // declares. A marked error that somehow left with any other status or code
  // is not the refusal this site describes.
  if (observation.status !== site.status || observation.code !== site.errorCode) {
    return skip(CAPTURE_SKIP_REASONS.CLASSIFICATION_MISMATCH);
  }
  // The request context carries the correlation id, trace and source of every
  // record, whichever site this is, so nothing is recorded without it.
  const context = observation.context;
  if (!context) {
    return skip(
      site.decidedBy === 'AUTH_GUARD'
        ? CAPTURE_SKIP_REASONS.UNATTRIBUTABLE
        : CAPTURE_SKIP_REASONS.NOT_AUTHENTICATED_USER,
    );
  }

  let attribution: Attribution;

  if (site.decidedBy === 'AUTH_GUARD') {
    // Route-agnostic, and only here: this refusal precedes controller
    // authorization, so the route it happened to be aimed at identifies
    // nothing (`refusal-sites.ts`). The attribution comes from the shared
    // guard's own verified token, because at this point the request context
    // has not been upgraded and still says ANONYMOUS. A marked error without
    // a matching one is not this refusal and is not recorded.
    const trusted = guardAttributionOf(site, observation.exception);
    if (trusted === undefined) return skip(CAPTURE_SKIP_REASONS.UNATTRIBUTABLE);
    attribution = trusted;
  } else {
    if (observation.method !== site.method || observation.route !== site.route) {
      return skip(CAPTURE_SKIP_REASONS.ROUTE_MISMATCH);
    }

    // Authenticated users only. ADR-053 § 4 excludes the unauthenticated case,
    // and a service caller has no place in these sites.
    if (context.authType !== 'USER' || !isNonBlank(context.userId)) {
      return skip(CAPTURE_SKIP_REASONS.NOT_AUTHENTICATED_USER);
    }
    attribution = {
      actorType: 'USER',
      actorId: context.userId,
      roles: context.roles,
      organizationId: context.organizationId,
    };
  }

  const { actorType, actorId, organizationId } = attribution;
  const roles = rolesOf(attribution.roles);
  if (
    actorId.length > ACTOR_ID_MAX_LENGTH ||
    roles === null ||
    (organizationId !== undefined &&
      (!isNonBlank(organizationId) || organizationId.length > ORGANIZATION_ID_MAX_LENGTH))
  ) {
    return skip(CAPTURE_SKIP_REASONS.UNATTRIBUTABLE);
  }

  const id = environment.newId();
  const draft: SecurityEventDraft = {
    id,
    organizationId: organizationId ?? null,
    actorType,
    actorId,
    actorRoles: roles,
    action: site.action,
    resourceType: site.resourceType,
    // Every site's resource is its own actor — the user, or the calling
    // service — never anything the request names.
    resourceId: actorId,
    errorCode: site.errorCode,
    reason: site.reason,
    sourceIp: sourceIpOf(context.ip),
    sourceUserAgent: userAgentOf(context.userAgent),
    correlationId: correlationIdOf(context, id),
    traceparent: traceparentOf(context),
    producerVersion: producerVersionOf(environment.producerVersion),
    // The application instant and a single occurrence: enough to prove the row
    // publishable below. The store persists the database's instant instead,
    // and counts the occurrence into whichever window row it belongs to
    // (Phase C2) — the application clock decides nothing about aggregation.
    occurredAt: environment.now,
    occurrenceCount: 1,
  };

  // The exact check the flusher makes before publishing, made now — so a row
  // the audit contract would refuse never enters the queue to be retried
  // forever.
  try {
    assertPublishableAuditTrailRow(
      toSecurityEventOutboxRow({
        ...draft,
        createdAt: environment.now,
        publishedAt: null,
        attempts: 0,
        lastError: null,
      }),
    );
  } catch {
    return skip(CAPTURE_SKIP_REASONS.CONTRACT_VIOLATION);
  }

  return { kind: 'CAPTURE', site, draft };
}
