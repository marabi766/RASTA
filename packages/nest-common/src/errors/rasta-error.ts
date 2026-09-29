import { ERROR_CODES, ERROR_STATUS, type ErrorCode, type ErrorDetail } from '@rasta/contracts';

/**
 * The one error type domain code throws.
 *
 * Services never throw raw NestJS HTTP exceptions from domain logic: the
 * domain should say "this violates a business rule", not "this is a 422".
 * The mapping from code to status lives in one table (`ERROR_STATUS`), so a
 * client's handling of `INSUFFICIENT_BALANCE` cannot drift between services.
 */
export class RastaError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];
  /**
   * Never serialised to the client — for server-side logs only, where
   * operators diagnose from it. What it may carry (S-09, docs/06 § 6.7):
   * **identifiers and amounts** — record and tenant ids, an endpoint, a
   * wallet's requested and available balance, a state transition. What it
   * must never carry: **credentials or keys** (tokens, passwords, an
   * Idempotency-Key or anything derived from one), **personal data** (names,
   * emails, phone numbers, national ids, addresses) or **client free text**
   * (a reason, a note, a raw body). Nothing sanitises it: it is logged as
   * written, so what goes in is the author's call.
   */
  readonly internalContext?: Record<string, unknown>;
  /**
   * A 5xx whose message the client may see (S-09). Off by default: the
   * exception filter answers every 5xx with a generic message, because a
   * server-side message is written for operators and names records. Set only
   * through {@link RastaError.internalClientSafe} (or the constructor option),
   * for a message that is **author-written, fixed and input-free** and tells
   * the client something it needs — that retrying is safe, say. Never derived
   * from the message's content. No effect below 500: 4xx messages already
   * reach the client.
   */
  readonly clientSafe: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      details?: ErrorDetail[];
      internalContext?: Record<string, unknown>;
      cause?: unknown;
      /** See {@link RastaError.clientSafe}. */
      clientSafe?: boolean;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RastaError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options?.details;
    this.internalContext = options?.internalContext;
    this.clientSafe = options?.clientSafe === true;
    Error.captureStackTrace?.(this, RastaError);
  }

  // ---- 404 / tenancy -------------------------------------------------------

  /**
   * A resource that does not exist, or exists under another tenant.
   *
   * Both cases return 404 on purpose. A 403 confirms the resource exists, so
   * an attacker enumerating identifiers could map another organization's
   * assets. See docs/09-security-architecture.md.
   */
  static notFound(resourceType: string, id?: string): RastaError {
    return new RastaError(ERROR_CODES.NOT_FOUND, `${resourceType} not found`, {
      internalContext: id ? { resourceType, id } : { resourceType },
    });
  }

  // ---- 409 conflicts -------------------------------------------------------

  static alreadyExists(resourceType: string, identifier?: string): RastaError {
    return new RastaError(ERROR_CODES.ALREADY_EXISTS, `${resourceType} already exists`, {
      internalContext: { resourceType, identifier },
    });
  }

  static invalidStateTransition(
    aggregate: string,
    from: string,
    to: string,
    reason?: string,
  ): RastaError {
    return new RastaError(
      ERROR_CODES.INVALID_STATE_TRANSITION,
      reason ?? `Cannot move ${aggregate} from ${from} to ${to}`,
      { internalContext: { aggregate, from, to } },
    );
  }

  static optimisticLockFailed(aggregate: string, id: string): RastaError {
    return new RastaError(
      ERROR_CODES.OPTIMISTIC_LOCK_FAILED,
      `${aggregate} was modified by another request; reload and retry`,
      { internalContext: { aggregate, id } },
    );
  }

  /**
   * The key is not a parameter, on purpose (S-09). It used to be carried in
   * `internalContext`, which the exception filter logs — so every refusal
   * wrote a client's raw Idempotency-Key into the log. Nothing derived from it
   * is carried either: an unkeyed digest of a client-chosen key can be
   * reversed by guessing, a keyed one needs a secret this package does not
   * hold, and the request's correlation id already ties the refusal to its
   * request. A service that wants more context records it itself, in its own
   * terms (construction's endpoint, for one).
   */
  static idempotencyKeyReused(): RastaError {
    return new RastaError(
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      'This Idempotency-Key was already used with a different request body',
    );
  }

  // ---- 422 business rules --------------------------------------------------

  static businessRule(message: string, context?: Record<string, unknown>): RastaError {
    return new RastaError(ERROR_CODES.BUSINESS_RULE_VIOLATION, message, {
      internalContext: context,
    });
  }

  static insufficientBalance(walletId: string, requested: string, available: string): RastaError {
    return new RastaError(ERROR_CODES.INSUFFICIENT_BALANCE, 'Insufficient available balance', {
      internalContext: { walletId, requested, available },
    });
  }

  static ledgerUnbalanced(journalId: string, delta: string): RastaError {
    return new RastaError(
      ERROR_CODES.LEDGER_UNBALANCED,
      'Journal entries do not balance; refusing to post',
      { internalContext: { journalId, delta } },
    );
  }

  // ---- 400 validation ------------------------------------------------------

  static validation(details: ErrorDetail[], message = 'Request validation failed'): RastaError {
    return new RastaError(ERROR_CODES.VALIDATION_FAILED, message, { details });
  }

  // ---- 401 / 403 -----------------------------------------------------------

  static unauthenticated(message = 'Authentication required'): RastaError {
    return new RastaError(ERROR_CODES.UNAUTHENTICATED, message);
  }

  static forbidden(message = 'You do not have permission to perform this action'): RastaError {
    return new RastaError(ERROR_CODES.FORBIDDEN, message);
  }

  static insufficientRole(required: readonly string[], actual: readonly string[]): RastaError {
    return new RastaError(
      ERROR_CODES.INSUFFICIENT_ROLE,
      'You do not have permission to perform this action',
      { internalContext: { required, actual } },
    );
  }

  /**
   * The caller authenticated, but asked to act for an organization they are
   * not a member of. Distinct from `forbidden` because it is the signal worth
   * alerting on — repeated occurrences suggest tenant-boundary probing.
   */
  static tenantMismatch(requested: string, allowed: readonly string[]): RastaError {
    return new RastaError(
      ERROR_CODES.TENANT_MISMATCH,
      'You are not a member of the requested organization',
      { internalContext: { requested, allowed } },
    );
  }

  /**
   * A service-to-service call whose tenant context cannot be trusted.
   *
   * Raised when an internal token carries no signed `org_id` and the operation
   * is tenant-scoped, or when an `X-Organization-Id` header disagrees with the
   * signed claim (ADR-035).
   *
   * `403` rather than `500`: refusing a call whose authority cannot be
   * established is a decision, not a fault, and reporting it as a fault sends
   * an operator hunting for a bug that is not there.
   *
   * `reason` reaches the log through `internalContext` and never the response
   * body — telling a caller *which* check failed lets them probe for the
   * shape of a token that would pass (S-09).
   */
  static serviceTenantContextInvalid(
    reason: 'MISSING_CLAIM' | 'HEADER_CLAIM_MISMATCH',
    context?: Record<string, unknown>,
  ): RastaError {
    return new RastaError(
      ERROR_CODES.SERVICE_TENANT_CONTEXT_INVALID,
      'This service call carries no usable organization context',
      { internalContext: { reason, ...context } },
    );
  }

  // ---- 5xx -----------------------------------------------------------------

  static upstreamUnavailable(service: string, cause?: unknown): RastaError {
    return new RastaError(
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
      `A required service is temporarily unavailable`,
      { internalContext: { service }, cause },
    );
  }

  static upstreamTimeout(service: string, timeoutMs: number): RastaError {
    return new RastaError(ERROR_CODES.UPSTREAM_TIMEOUT, `A required service did not respond`, {
      internalContext: { service, timeoutMs },
    });
  }

  static internal(message: string, cause?: unknown): RastaError {
    return new RastaError(ERROR_CODES.INTERNAL_ERROR, message, { cause });
  }

  /**
   * A 500 whose `message` reaches the client as written — the one exception to
   * the generic 5xx answer (S-09). `message` must be a fixed string literal the
   * author wrote for the client, with nothing interpolated: no id, no value,
   * no input. Use it when the client needs to know something to act — "nothing
   * was changed and it is safe to retry". Anything else is {@link internal}.
   */
  static internalClientSafe(message: string, cause?: unknown): RastaError {
    return new RastaError(ERROR_CODES.INTERNAL_ERROR, message, { cause, clientSafe: true });
  }

  static notImplemented(what: string): RastaError {
    return new RastaError(ERROR_CODES.NOT_IMPLEMENTED, `${what} is not implemented`);
  }
}

export function isRastaError(error: unknown): error is RastaError {
  return error instanceof RastaError;
}
