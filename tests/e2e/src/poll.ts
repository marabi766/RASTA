import { beforeDeadline, DEADLINE_PASSED, failureMessage } from './http.ts';

/**
 * The boolean poll global setup and the event taps wait with (`until`, in `actor.ts`, is the
 * one scenarios wait with). Separate from `events.ts` so that `node --test` loads it without
 * Kafka (`actor.test.ts`): no extensionless imports.
 */

/** How often a boolean poll asks again. */
export const WAIT_FOR_INTERVAL_MS = 200;

/** What a timeout adds when the deadline overtook a check that was still running. */
export const CHECK_STILL_RUNNING = 'its last check had not answered';

/**
 * Polls `check` until it is true. No fixed sleeps anywhere in this suite — docs/14 § 14.7
 * forbids them, and a sleep long enough to be reliable is always long enough to be slow.
 *
 * The deadline holds around each check too (Codex r6 on #241): a check that does not answer —
 * a request whose token grant stalled — is overtaken at the deadline, and the wait fails with
 * the timeout it declared rather than whenever the check gives up.
 */
export async function waitFor(
  description: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  detail?: () => string,
  intervalMs = WAIT_FOR_INTERVAL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let overtaken = false;

  while (Date.now() < deadline) {
    try {
      const done = await beforeDeadline(Promise.resolve().then(check), deadline);
      if (done === DEADLINE_PASSED) {
        overtaken = true;
        break;
      }
      if (done) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))),
    );
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
      (detail ? `; ${detail()}` : '') +
      // A check may call through an `Actor`: only the sanitized message, never the error itself.
      (lastError ? `; last error: ${failureMessage(lastError)}` : '') +
      (overtaken ? `; ${CHECK_STILL_RUNNING}` : ''),
  );
}
