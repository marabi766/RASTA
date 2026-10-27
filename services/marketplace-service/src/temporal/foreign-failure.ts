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
  // A class name is the library's; its shape is checked all the same.
  const type =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : 'unknown';
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'number' && Number.isInteger(code)) return { type, code };
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return { type, code };
  return { type };
}
