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
  /** Never serialised to the client — for server-side logs only. */
  readonly internalContext?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      details?: ErrorDetail[];
      internalContext?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RastaError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options?.details;
    this.internalContext = options?.internalContext;
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

  static idempotencyKeyReused(key: string): RastaError {
    return new RastaError(
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      'This Idempotency-Key was already used with a different request body',
      { internalContext: { key } },
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

  static notImplemented(what: string): RastaError {
    return new RastaError(ERROR_CODES.NOT_IMPLEMENTED, `${what} is not implemented`);
  }
}

export function isRastaError(error: unknown): error is RastaError {
  return error instanceof RastaError;
}
