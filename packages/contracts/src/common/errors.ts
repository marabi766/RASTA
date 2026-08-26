import { z } from 'zod';

/**
 * Platform-wide error model.
 *
 * Every HTTP error returned by any Rasta service has this shape. Clients
 * branch on `code`, never on the human-readable `message` (which is localized
 * and may change), and never on the HTTP status alone (which is too coarse).
 */

export const ERROR_CODES = {
  // 400 — the request itself is malformed
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',

  // 401 / 403 — who you are, and what you may do
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  /** The caller authenticated, but the target belongs to another tenant. */
  TENANT_MISMATCH: 'TENANT_MISMATCH',

  // 404 / 409 — resource state
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  CONFLICT: 'CONFLICT',
  /** Same idempotency key, different request body. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** The aggregate is not in a state that permits this transition. */
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  OPTIMISTIC_LOCK_FAILED: 'OPTIMISTIC_LOCK_FAILED',

  // 422 — the request is well-formed but the domain refuses it
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  LEDGER_UNBALANCED: 'LEDGER_UNBALANCED',

  // 429
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // 5xx
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const errorDetailSchema = z.object({
  /** Dot/bracket path into the request body, e.g. `items[0].quantity`. */
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Field-level problems; present for VALIDATION_FAILED. */
  details: z.array(errorDetailSchema).optional(),
  /** Echoed from the request so a user can quote it to support. */
  correlationId: z.string(),
  /** W3C trace id, for jumping straight to the trace. */
  traceId: z.string().optional(),
  timestamp: z.string().datetime(),
  path: z.string().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/** Default HTTP status for each code, used by the shared exception filter. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  MALFORMED_REQUEST: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  INSUFFICIENT_ROLE: 403,
  TENANT_MISMATCH: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  INVALID_STATE_TRANSITION: 409,
  OPTIMISTIC_LOCK_FAILED: 409,
  BUSINESS_RULE_VIOLATION: 422,
  INSUFFICIENT_BALANCE: 422,
  LEDGER_UNBALANCED: 422,
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
  NOT_IMPLEMENTED: 501,
};
