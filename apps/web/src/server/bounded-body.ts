/**
 * Byte- and deadline-bounded reading of a peer's JSON body (PR #722 r1 F1/F2),
 * the portal's counterpart of `@rasta/nest-common`'s `readBoundedJson`, which
 * this app does not depend on.
 *
 * `response.json()` buffers whatever arrives — a chunked or highly compressed
 * body has no ceiling before collection — and the `AbortSignal.timeout` beside
 * it cannot fire while an always-ready body keeps the microtask queue busy.
 * Here the decoded bytes are copied into one owned buffer that grows
 * geometrically up to `limit`, and the monotonic deadline is checked between
 * chunks; past either, the stream is cancelled.
 */
export class BodyTooLargeError extends Error {
  constructor() {
    super('The response body exceeded its byte limit');
    this.name = 'BodyTooLargeError';
  }
}

/** Named like the platform's own timeout so `error.name` checks cover it. */
export class BodyDeadlineError extends Error {
  constructor() {
    super('The response body did not arrive within its deadline');
    this.name = 'TimeoutError';
  }
}

/**
 * The body parsed as JSON. Rejects with {@link BodyTooLargeError} past `limit`
 * decoded bytes, {@link BodyDeadlineError} once `performance.now()` reaches
 * `deadlineAt`, and — like `.json()` — a `SyntaxError` for a body that is not JSON.
 */
export async function readBoundedJson(
  response: Response,
  limit: number,
  deadlineAt: number,
): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError();
  }
  let owned = new Uint8Array(0);
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      if (performance.now() >= deadlineAt) {
        await reader.cancel().catch(() => undefined);
        throw new BodyDeadlineError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - size) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      if (size + value.byteLength > owned.byteLength) {
        const next = new Uint8Array(
          Math.min(limit, Math.max(size + value.byteLength, 256, owned.byteLength * 2)),
        );
        next.set(owned.subarray(0, size));
        owned = next;
      }
      owned.set(value, size);
      size += value.byteLength;
    }
    if (performance.now() >= deadlineAt) throw new BodyDeadlineError();
  }
  return JSON.parse(new TextDecoder().decode(owned.subarray(0, size))) as unknown;
}
