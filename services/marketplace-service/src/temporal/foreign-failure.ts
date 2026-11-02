/**
 * What a Temporal failure is logged as: its class and, when it has one, its
 * status code — never its message, stack, `cause` or details, which may quote
 * the address it dialled or a server's answer (#385 r6, the configuration-
 * disclosure class). Only the log line is reduced: callers branch on the
 * error itself first (`WorkflowExecutionAlreadyStartedError` for a replayed
 * `REJECT_DUPLICATE` start, `WorkflowNotFoundError` for a signal), so no type
 * a decision depends on is wrapped or lost.
 */
export interface ForeignFailure {
  type: string;
  code?: number | string;
}

export function foreignFailure(error: unknown): ForeignFailure {
  // Closed sets, not identifier-shaped strings: credentials can have that shape too.
  const names = new Set([
    'Error',
    'TypeError',
    'TransportError',
    'ServiceError',
    'ConnectionError',
    'WorkflowExecutionAlreadyStartedError',
    'WorkflowNotFoundError',
    'ShutdownError',
    'ApplicationFailure',
    'CancelledFailure',
    'TimeoutFailure',
  ]);
  const codes = new Set([
    'CANCELLED',
    'UNKNOWN',
    'INVALID_ARGUMENT',
    'DEADLINE_EXCEEDED',
    'NOT_FOUND',
    'ALREADY_EXISTS',
    'PERMISSION_DENIED',
    'RESOURCE_EXHAUSTED',
    'FAILED_PRECONDITION',
    'ABORTED',
    'OUT_OF_RANGE',
    'UNIMPLEMENTED',
    'INTERNAL',
    'UNAVAILABLE',
    'DATA_LOSS',
    'UNAUTHENTICATED',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
  ]);
  try {
    const candidate = error as { name?: unknown; code?: unknown } | null;
    const name = candidate?.name;
    const type = typeof name === 'string' && names.has(name) ? name : 'unknown';
    const code = candidate?.code;
    if (typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 16) {
      return { type, code };
    }
    if (typeof code === 'string' && codes.has(code)) return { type, code };
    return { type };
  } catch {
    return { type: 'unknown' };
  }
}
